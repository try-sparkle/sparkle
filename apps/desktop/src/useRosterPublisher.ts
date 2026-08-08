// Publishes the desktop's live agent roster (projects → agents → status) to the phone via the
// relay and to the Rust tray aggregator, re-pushing whenever projects, statuses, the open set, or
// interaction times change. Mounted once in App.tsx.
//
// Only OPEN projects are published — the phone and the menu bar mirror what you actually have open
// on the desktop, not every project that has ever been in Recent. In the single-window shell
// (CM-U7) "open" can no longer mean "a window is showing it" (one window shows them all), so it
// means: the project has at least one agent in the runtime's open set, OR its tab has been selected
// at least once this session (services/sessionProjects).
//
// The distinction is not cosmetic. `useProjectStore.projects` is the FULL persisted list, and each
// agent carries up to 4 recent prompt snippets: publishing all of it sent real prompt text from
// projects the user hasn't touched in months to the relay, on every status tick, in a payload that
// grew without bound (roborev 46258-M1).
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { AGENT_STATUS, type AgentTabStatus } from "@sparkle/ui";
import { pushRoster, type RosterPayload } from "./services/relayClient";
import { publishWindowRoster } from "./services/attention";
import { useProjectStore } from "./stores/projectStore";
import { useRuntimeStore } from "./stores/runtimeStore";
import { useInteractionStore } from "./stores/interactionStore";
import { useCurrentWindowLabel } from "./windowContext";
import {
  onVisitedProjectsChange,
  visitedProjectsVersion,
  wasProjectVisited,
} from "./services/sessionProjects";
import { agentDisplayName } from "./engine/agentDisplayName";
import { rollupDotAccessor } from "./engine/workerRollup";
import { goalStateOf } from "./engine/agentGoal";
import { calmNewAgent } from "./engine/newAgentAttention";
import { useNewAgentGraceTick } from "./hooks/useNewAgentCalm";
import { composerPrompts } from "./components/promptHistory";
import { safeTruncate, sanitizeJsonStrings, stripLoneSurrogates } from "./services/safeText";
import type { AgentTab, Project } from "./types";

const DEFAULT_STATUS: AgentTabStatus = "stopped";

/** The name we show — Claude Code's title if known, else the auto-name, else the fallback.
 *  Sanitized because titles routinely carry emoji and are truncated by whoever produced them
 *  (Claude Code, the auto-namer); a half surrogate pair here fails the whole roster invoke. */
function displayName(a: AgentTab): string {
  return stripLoneSurrogates(agentDisplayName(a));
}

/** The user's last touch of this agent (composer Send or terminal keystroke), or undefined. Mirrors
 *  the sidebar's elapsed-timer anchor so the phone's timer matches the desktop's exactly. */
function lastActivityAt(a: AgentTab, interaction: Record<string, number>): number | null {
  const lastPromptAt = a.promptHistory[a.promptHistory.length - 1]?.at;
  const touch = Math.max(lastPromptAt ?? 0, interaction[a.id] ?? 0);
  return touch > 0 ? touch : null;
}

// How many recent prompts to carry (the tray shows a breadcrumb of the most recent few) and the
// per-prompt character cap so the relayed payload stays small — the tray applies its own
// word-level truncation on top for display.
const RECENT_PROMPTS_MAX = 4;
const RECENT_PROMPT_CHARS = 80;

/** The most recent (~4) user prompts, oldest→newest, whitespace-collapsed and length-capped. Each
 *  keeps its promptHistory id so a reveal can scroll the terminal to that exact turn. Picker
 *  answers are excluded (composerPrompts) — the breadcrumb, like the desktop one, is for real
 *  messages, and a picker row's id has no scroll marker to jump to.
 *
 *  The cap goes through `safeTruncate`, NOT a bare `slice`: prompts contain emoji, and a UTF-16
 *  slice landing between a surrogate pair leaves a lone leading surrogate that serde_json rejects
 *  when Tauri deserializes the `publish_window_roster` args ("unexpected end of hex escape"). See
 *  services/safeText.ts — that one-character bug rejected every republish for the affected agent. */
function recentPrompts(a: AgentTab): { id: string; text: string }[] {
  return composerPrompts(a.promptHistory ?? []).slice(-RECENT_PROMPTS_MAX).map((e) => ({
    id: e.id,
    text: safeTruncate(e.text.replace(/\s+/g, " ").trim(), RECENT_PROMPT_CHARS),
  }));
}

/**
 * The OPEN projects (see the file header): those with a live agent, plus those whose tab the user
 * has selected this session. Pure — `visited` is passed in — so the predicate is testable without
 * module state.
 */
export function openProjects(
  projects: Project[],
  openAgentIds: readonly string[],
  visited: (projectId: string) => boolean,
): Project[] {
  const open = new Set(openAgentIds);
  return projects.filter((p) => visited(p.id) || p.agents.some((a) => open.has(a.id)));
}

/** Build the roster payload published to BOTH the Rust roster aggregator and the phone relay.
 *
 *  The result is swept by `sanitizeJsonStrings` before it leaves: both consumers cross a JSON
 *  boundary where a single lone surrogate in ANY string rejects the whole payload (see
 *  services/safeText.ts). `displayName`/`recentPrompts` still sanitize at the source — the sweep is
 *  the backstop for the fields nobody thought to guard (project name, ids, workflow stage).
 *
 *  TWO STATUS FACTS PER ROW, deliberately. `status`/`status_color`/`status_label` stay the agent's
 *  OWN PTY state — every existing consumer (mobile's STATUS_RANK, the tray island, roster.rs) reads
 *  them that way and redefining them here would silently change all three at once. `rollup_dot` is
 *  the ADDED fact: what engine/workerRollup says the row's disc should be once the workers folded
 *  under it are taken into account. Without it an orchestrator that is `idle` between delegations
 *  publishes grey while nine workers grind, and publishes grey while a worker sits blocked on a
 *  question — indistinguishable, on the wire, from a dead row. */
export function buildRoster(
  projects: Project[],
  status: Record<string, AgentTabStatus>,
  workflowStage: Record<string, string>,
  interaction: Record<string, number>,
  /** Injected clock for the spawn-age backstop in `calmNewAgent`. Defaults to now; tests pass it
   *  explicitly rather than faking timers (house style — stores/conciergeApprovals.ts). */
  now: number = Date.now(),
): RosterPayload {
  // ONE accessor over EVERY published agent, so a head is rolled up against its own children no
  // matter which project row we happen to be emitting. `rollupDotAccessor` buckets by `parentId`
  // itself — the flat list is all it needs.
  //
  // `ownStatusOf` is deliberately left at its default (== `statusOf`). That parameter exists for
  // callers whose status map has already had `withRedWorkerAttention` composited into it, where
  // feeding the bubbled red back in as the head's "own" status makes own-red-wins swallow every
  // orange. This map has NOT: `useRosterPublisher` reads `runtimeStore.status` raw.
  //
  // CALM FIRST, THEN ROLL UP (roborev 55028, High) — the same ordering `composeRollup` uses, where
  // `withNewAgentCalm` is applied to the raw map BEFORE anything is bucketed. This map is built
  // once, over the flat list, and feeds BOTH the accessor and each row's `status` below, so the dot
  // and the own-status still cannot disagree. Reading raw `status` here instead was a real defect:
  // a briefless freshly-spawned agent publishes `status: "new"` (grey) while `rollupDot` was
  // computed from statusEngine's 25s stall-timer `blocked`, and `rollupDot` returns "red" the
  // instant `ownBand === "needs_you"`. The same raw map feeds `workersByParent`, so an uncalmed
  // worker's red bubbled into its parent's dot too — reviving, on the phone and tray-island
  // surfaces that band on `rollup_dot`, exactly the false "needs you" red that
  // engine/newAgentAttention.ts exists to remove.
  const allAgents = projects.flatMap((p) => p.agents);
  const calmedStatus = new Map<string, AgentTabStatus>(
    allAgents.map((a) => [a.id, calmNewAgent(status[a.id], a, now, interaction[a.id]) ?? DEFAULT_STATUS]),
  );
  const dotOf = rollupDotAccessor(allAgents, (id) => calmedStatus.get(id) ?? DEFAULT_STATUS);
  return sanitizeJsonStrings<RosterPayload>({
    projects: projects.map((p) => ({
      id: p.id,
      name: p.name,
      agents: p.agents.map((a) => {
        // Corrected for "spawned but never briefed" before the colour token is read, so the phone
        // and the helper island paint the same dot the desktop sidebar does. Without it a briefless
        // agent relays as red `blocked` — statusEngine's 25s stall timer — to a surface whose whole
        // job is a glanceable "what needs me". See engine/newAgentAttention.ts.
        // `interaction` is already a parameter here (it feeds lastActivityAt), so route 4 —
        // "the user has typed into this agent's terminal" — costs nothing to honour.
        // Read from the SAME pre-calmed map the rollup accessor was built over, so the row's own
        // status and its `rollup_dot` can never be derived from different inputs (roborev 55028).
        const st = calmedStatus.get(a.id) ?? DEFAULT_STATUS;
        const tok = AGENT_STATUS[st] ?? AGENT_STATUS[DEFAULT_STATUS];
        return {
          id: a.id,
          name: displayName(a),
          kind: a.kind,
          status: st,
          status_color: tok.color,
          status_label: tok.label,
          // A childless row and a worker row roll up to their own tier (an empty worker list), so
          // every row in the payload carries the field and no consumer needs a special case.
          rollup_dot: dotOf(a.id),
          // For the Rust nudger. It cannot see this store, and without it the sparkle-nudge ladder
          // re-pings agents that have already reported their goal met — the founder's 2026-08-07
          // screenshot caught fourteen consecutive pings on one such agent, each a full agent turn.
          // Derived here rather than read off `a.goal.met` so an EXPIRED or ESCALATED goal (both of
          // which have `met` unset but are not "done") can never be published as met.
          goal_state: goalStateOf(a.goal, now),
          parent_id: a.parentId,
          workflow_stage: workflowStage[a.id] ?? null,
          last_activity_at: lastActivityAt(a, interaction),
          recent_prompts: recentPrompts(a),
        };
      }),
    })),
  });
}

export function useRosterPublisher(): void {
  const projects = useProjectStore((s) => s.projects);
  const status = useRuntimeStore((s) => s.status);
  const workflowStage = useRuntimeStore((s) => s.workflowStage);
  const openAgentIds = useRuntimeStore((s) => s.openAgentIds);
  const interaction = useInteractionStore((s) => s.lastAt);
  const label = useCurrentWindowLabel();

  // The visited set is module state, not a store, so subscribe to its version to re-push when the
  // user opens a tab that has no live agent yet (its project becomes publishable at that moment).
  const visitedVersion = useSyncExternalStore(onVisitedProjectsChange, visitedProjectsVersion, () => 0);

  // The spawn-age backstop inside `calmNewAgent` is a DEADLINE, and this effect only re-runs when
  // its inputs change — which, for the `errored` agent the backstop exists to eventually surface,
  // never happens again. Without this the phone/menu-bar roster would keep publishing `new` forever
  // while `get_agent_status` (which samples the clock per call) said `errored` (roborev 54743,
  // finding 1). One timer, aimed at the soonest pending expiry.
  const graceTick = useNewAgentGraceTick(
    useMemo(() => projects.flatMap((p) => p.agents), [projects]),
    status,
    interaction,
  );

  useEffect(() => {
    // Coalesce rapid changes into one push.
    const t = setTimeout(() => {
      // SINGLE-WINDOW SHELL (CM-U7): this window hosts every project as a tab, so it is the only
      // publisher — there is no other window to under-report, and the old per-window registry
      // slicing (which existed because a window only held live status for the agents IT ran) would
      // now hide every project except the selected tab. What it must NOT do is publish the whole
      // store; see openProjects and the file header.
      const full = buildRoster(
        openProjects(projects, openAgentIds, wasProjectVisited),
        status,
        workflowStage,
        interaction,
      );
      pushRoster(full);
      publishWindowRoster(label, full.projects);
    }, 250);
    return () => clearTimeout(t);
  }, [
    projects,
    status,
    workflowStage,
    openAgentIds,
    interaction,
    visitedVersion,
    label,
    graceTick,
  ]);
}
