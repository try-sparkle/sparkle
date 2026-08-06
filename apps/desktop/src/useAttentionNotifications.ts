// Drives the dock badge + Notification Center banners off live agent status, and routes a
// notification click back to the exact worker that asked. Mounted once per window (inside the
// CurrentProjectProvider) by <AttentionController/>.
//
// Each window owns ONE project, so it only knows/reports the status of that project's agents:
//  - badge: report this window's red count; the backend sums across windows (the macOS dock
//    badge is app-global) — see attention.rs.
//  - notification: fire once when an agent crosses INTO a status the user has enabled for
//    notifications (Settings ⋯ → Notifications; newlyEntered), not on every tick. Switching the
//    window to a different project re-baselines silently so the switch itself doesn't ping you
//    for agents that were already in a notifiable status.
//  - click: the backend broadcasts attention://focus-agent to every window; the window that
//    owns that project brings itself forward and selects the agent (main adopts an orphaned
//    project no window is currently showing).
import { useEffect, useMemo, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  countAttention,
  needsAttention,
  newlyEntered,
  notificationFor,
  suppressNotification,
  type StatusMap,
} from "./engine/attention";
import { useRuntimeStore } from "./stores/runtimeStore";
import { useSettingsStore } from "./stores/settingsStore";
import { useScrollIntentStore } from "./stores/scrollIntentStore";
import { useProjectStore } from "./stores/projectStore";
import {
  useCurrentProjectId,
  useCurrentWindowLabel,
  useIsMainWindow,
  useReplaceCurrentProject,
} from "./windowContext";
import {
  reportAttentionCount,
  notifyAttention,
  summarizeAttention,
  onFocusAgent,
  onSelectProject,
  onFocusTier,
  type FocusAgentPayload,
  type SelectProjectPayload,
  type FocusTierPayload,
} from "./services/attention";
import { agentExists, selectAndOpen } from "./services/agentReveal";
import { openProjectTab } from "./services/openProjectTab";
import { useUiStore } from "./stores/uiStore";
import { emitAttention, emitResolved } from "./services/relayClient";
import { reportAttentionSource } from "./services/selfReportObservability";
import type { AttentionSource } from "./stores/selfReportMetrics";
import { getAgentScrollback } from "./services/terminalScrollback";
import { suggestedRepliesFor } from "./services/suggestions/attentionReplies";
import { safeUnlisten } from "./services/safeUnlisten";
import { withDismissedAlerts, alertControlKind } from "./engine/alertDismissal";
import { isInMotion } from "./engine/inMotion";
import {
  rollupDotAccessor,
  withWorkerRollupGreen,
  type RollupDot,
} from "./engine/workerRollup";
import { withUnmergedWork } from "./engine/unmergedAttention";
import { withNewAgentCalm } from "./engine/newAgentAttention";
import { useNewAgentCalm } from "./hooks/useNewAgentCalm";
import { useInteractionStore } from "./stores/interactionStore";
import {
  withRedWorkerAttention,
  withUnstartedWorkerAttention,
  type LastObservedMap,
} from "./engine/workerAttention";
import { resolveStage } from "./engine/workflowStage";
import type { AgentTab, AgentTabStatus } from "./types";
import { projectNameForAgent } from "./services/creditProject";

// `isRelayRed` USED TO LIVE HERE and was deleted, not renamed. Once `questions` joined the set it
// was character-for-character `engine/attention.needsAttention` — two seams answering one question,
// which is the drift this file's own header warns about. Call `needsAttention` directly; the phone
// payload already distinguishes the kinds (`kind: "question"` for anything that is not an approval).

/** The PUBLISHED status map — the same chain AgentSidebar's `effectiveStatus` applies to color its
 *  own rows, kept here as one exported function so the two can be compared (and tested) instead of
 *  drifting as two hand-copied call stacks. Read today by the concierge feed (services/
 *  conciergeFeed) for its P0/P1/P2 banding. Order is the contract:
 *
 *   0. `withNewAgentCalm` — a spawned-but-never-briefed agent reads `new` (GRAY) instead of the red
 *      `blocked` statusEngine's 25s stall timer gives it for being quiet. FIRST, and on the RAW map,
 *      so a briefless agent's false red is corrected before steps 1–2 can bubble it to an
 *      orchestrator, where it would be indistinguishable from the parent's own.
 *   1. `withUnstartedWorkerAttention` — a worker whose worktree was cut but which never went live has
 *      NO status entry, so nothing downstream would call it red. Invents the red and bubbles it.
 *   2. `withRedWorkerAttention` — a worker that started and then went red paints its orchestrator.
 *      After (1) so a strand's synthetic red bubbles too.
 *      Steps 1–2 are load-bearing, not cosmetic: consumers list orchestrators, not workers, so
 *      without these bubbles a build whose worker is stuck would surface nothing at all — the
 *      orchestrator carries it, which is the row the user can act on anyway.
 *   3. `withUnmergedWork` — a finished agent with un-landed committed work goes `unmerged`. That is
 *      a GRAY status (packages/ui/tokens.ts), so it never reaches this file's red paths; it is
 *      composed here only so the published map matches the sidebar's exactly.
 *   4. `withDismissedAlerts` — a dismissed red alarm de-escalates, so a row that reads calm in its own
 *      project is not broadcast as red elsewhere (the original cross-project bug). Strictly after (3):
 *      dismissal last, or it would re-redden a just-calmed row (see withUnmergedWork's header).
 *
 *  `blocked` is red purely by its token color, so `isRedStatus` picks it up with no overlay. */
export function publishedStatusFor(
  agents: readonly AgentTab[],
  status: StatusMap,
  openIds: ReadonlySet<string>,
  /** runtimeStore.lastObserved — lets the unstarted-worker overlay tell a closed pane (ran, then
   *  stopped) from a never-started strand, so a closed worker no longer synthesizes red (sparkle-w340). */
  lastObserved: LastObservedMap,
  stageOf: (id: string) => ReturnType<typeof resolveStage>,
  /** Optional out-param: receives the ids step (5) promoted from calm to `working`. Only the
   *  away-recap needs it — see withWorkerRollupGreen. Everything else ignores it. */
  promoted?: Set<string>,
  /** Injected clock — see composeRollup. */
  now?: number,
  /** agentId → last terminal keystroke. Injected — see composeRollup. Defaults to the live store at
   *  this OUTERMOST boundary, so ordinary callers keep working and the pure core stays pure. */
  interaction: Record<string, number> = useInteractionStore.getState().lastAt,
): StatusMap {
  const { published, dotOf } = composeRollup(
    agents,
    status,
    openIds,
    lastObserved,
    stageOf,
    now,
    interaction,
  );
  return withWorkerRollupGreen(agents, published, dotOf, promoted);
}

/** The Build column's view of the same composition: the rolled-up dot per row, plus the un-bubbled
 *  `own` map the column needs to decide whether that dot overrides the row's own status.
 *
 *  EXPORTED SO THE COLUMN DOES NOT ASSEMBLE ITS OWN. AgentSidebar used to build `own`, the dismissed
 *  set and the in-motion predicate inline — a second copy of `composeRollup`, and therefore a second
 *  thing to keep in step with this file. Any slip in that copy (passing `effectiveStatus` where
 *  `bubbled` is required, say, which silently returns null for every dismissed agent) would make the
 *  column band differently from every other surface with nothing failing. That is the exact class of
 *  drift this rollup has already shipped twice, so there is one composition and three consumers. */
export function rollupViewFor(
  agents: readonly AgentTab[],
  status: StatusMap,
  openIds: ReadonlySet<string>,
  lastObserved: LastObservedMap,
  stageOf: (id: string) => ReturnType<typeof resolveStage>,
  /** Injected clock — see composeRollup. */
  now?: number,
  /** agentId → last terminal keystroke. Injected — see composeRollup. Defaults to the live store at
   *  this OUTERMOST boundary, so ordinary callers keep working and the pure core stays pure. */
  interaction: Record<string, number> = useInteractionStore.getState().lastAt,
): { own: StatusMap; dotOf: (id: string) => RollupDot } {
  const { own, dotOf } = composeRollup(
    agents,
    status,
    openIds,
    lastObserved,
    stageOf,
    now,
    interaction,
  );
  return { own, dotOf };
}

/** Steps 1–4 plus the rollup accessor they feed. The single place the chain is spelled out. */
function composeRollup(
  agents: readonly AgentTab[],
  status: StatusMap,
  openIds: ReadonlySet<string>,
  lastObserved: LastObservedMap,
  stageOf: (id: string) => ReturnType<typeof resolveStage>,
  /** Injected clock for step (0)'s spawn-age backstop. Defaults to now; passed explicitly by tests
   *  so the time-dependent rule needs no fake timers (house style — stores/conciergeApprovals.ts). */
  now: number = Date.now(),
  /** agentId → when the user last typed into that agent's terminal. INJECTED, alongside `now`, for
   *  the same reason: this composition is consumed by `buildConciergeFeed`, which documents itself
   *  as pure and ALREADY receives this map as a parameter. Reading the global store in here made the
   *  two independently sourced, so the feed could emit `since` from the caller's map and `status:
   *  "new"` from an empty singleton — a self-contradictory payload for one agent — and made route 4
   *  untestable through the feed except by mutating a module singleton (roborev 54771). Defaults to
   *  empty, i.e. "never touched", which is the pre-route-4 behaviour rather than a crash. */
  interaction: Record<string, number> = {},
): { published: StatusMap; own: StatusMap; dotOf: (id: string) => RollupDot } {
  // (0): a spawned-but-never-briefed agent is `new`, not red. FIRST, on the RAW map, so the two
  // bubbles below never carry a briefless agent's false red up to its orchestrator — a bubbled red
  // is indistinguishable from the parent's own once it lands, so this has to be corrected before it
  // can spread. It cannot interfere with step (1): withUnstartedWorkerAttention invents a red for a
  // STRANDED WORKER, and a worker carries its orchestrator's `task` as its brief, so it is never
  // briefless. See engine/newAgentAttention.ts.
  const calm = withNewAgentCalm(agents, status, now, interaction);
  // (1)+(2): the two worker-attention bubbles. Kept as its own binding because the rollup below
  // needs exactly this map — pre-unmerged, pre-dismissal — to answer "is this parent in motion?" and
  // "which reds has the user dismissed?".
  const bubbled = withRedWorkerAttention(
    agents,
    withUnstartedWorkerAttention(agents, calm, openIds, lastObserved),
  );
  // (3)+(4) over the bubbled map: the published chain as it has always been.
  const published = withDismissedAlerts(agents, withUnmergedWork(agents, bubbled, stageOf));
  // The same chain with the worker bubbles left OUT. Without it the rollup reads a bubbled red as
  // the head's OWN red and returns early, which makes every mixed subtree unreachable (the trap
  // documented on rollupDotAccessor's `ownStatusOf`). Built from `calm`, not `status`: this is the
  // same chain minus steps (1)+(2), so feeding it the uncorrected map would make a row's OWN status
  // disagree with its published one for exactly the briefless agents this change is about.
  const own = withDismissedAlerts(agents, withUnmergedWork(agents, calm, stageOf));
  const dismissed = new Set(
    agents.filter((a) => alertControlKind(a.alert, bubbled[a.id]) === "reenable").map((a) => a.id),
  );
  const dotOf = rollupDotAccessor(
    agents,
    (id) => published[id] ?? "stopped",
    (id) => own[id] ?? "stopped",
    {
      isDismissed: (id) => dismissed.has(id),
      isInMotion: (parentId) => isInMotion(parentId, agents, bubbled),
    },
  );
  return { published, own, dotOf };
}

/** Cap the raw terminal `detail` we relay to the phone. The trigger sits at the BOTTOM of the
 *  screen/scrollback, so keep the tail (a runaway scrollback would otherwise bloat the payload).
 *  Trailing blank lines a terminal snapshot pads with are stripped so the card doesn't render a
 *  wall of empty space. */
export const DETAIL_MAX = 4000;
export const truncateDetail = (raw: string): string => {
  const trimmed = raw.replace(/[ \t]*\n(?:[ \t]*\n)+$/g, "\n").trimEnd();
  if (trimmed.length <= DETAIL_MAX) return trimmed;
  return `…\n${trimmed.slice(trimmed.length - DETAIL_MAX)}`;
};

// --- Phase-2b: prefer a FRESH self-reported activity over the paid Haiku ask-summary ----------
// An agent narrates "what I'm building now" via the sparkle-control `set_agent_activity` MCP op
// (AgentTab.activity). When that narration was updated within a short window of the agent crossing
// into a needs-you (waiting/approval) state, it almost certainly describes the current ask — so we
// use it as the notification body and SKIP the credit-metered summarize_attention screen-scrape.
//
// `activity` carries NO timestamp today (adding one would touch projectStore/types, outside this
// file's ownership — see PRD/feat__claude-code-drives-.md), so we derive its age purely
// from state visible HERE: this effect re-runs whenever the owned `agents` array changes, and
// `setAgentActivity` produces a new array, so we can observe activity CHANGES across runs and stamp
// when each one first appeared (stampActivity). First sighting of an id is stamped `at = 0` —
// "unknown age" — so an activity restored from a previous session's persisted state is treated as
// stale (conservative: we keep calling Haiku) until the agent actually re-narrates in this session.
//
// WHY 2 MINUTES AND NOT 10 SECONDS (roborev 53476, 2026-07-27). This window has to match the
// narration cadence the persona actually asks for, and that cadence changed. The 10s original was
// tuned when `sparkleControlProtocol()` told agents to narrate at every sub-task, so a narration
// was almost always seconds old. It now says narrate at PHASE boundaries and skip narration with
// nothing to batch it against — which is a cost fix, but it aims squarely at the moment this gate
// depends on: the turn where an agent hands back to the human contains no other tool call, so the
// narration rides in the LAST tool-using turn and then has to survive however long the agent takes
// to finish that turn and write its hand-back message. At 10s this gate went near-dead and every
// `waiting` notification fell through to the credit-metered summarize_attention scrape — trading a
// token saving for a paid call, which is not a saving at all.
// The cost of widening is bounded: only `waiting` is eligible (approval is excluded above, where
// the body MUST describe the action), the text is a phase description, and the ask lies inside that
// phase — so a 90s-old "Wiring the control listener" is still a fair answer to "what does it want?",
// and strictly better than the generic fallback it would otherwise get. Two minutes covers "narrated
// in my last tool-using turn, then finished and asked" while still rejecting a line from an earlier
// phase. The shift is observable without new telemetry: selfReportMetrics.attentionSources counts
// self_report vs paid_haiku vs generic_fallback, so a regression here shows up as paid_haiku rising.
export const ACTIVITY_FRESH_MS = 120_000;

interface ActivityStamp {
  value: string; // the last-observed trimmed activity text
  at: number; // epoch ms we first observed THIS value ( 0 = first sighting / unknown age )
}

/** Fold this tick's owned agents into the activity-change stamp map. For each agent: first sighting
 *  → `at = 0` (unknown age); value changed vs last seen → `at = now` (just narrated); unchanged →
 *  keep the prior stamp. The returned map is pruned to exactly the current agents (an agent that
 *  left the set and returns gets a fresh first-sighting). Pure. */
export function stampActivity(
  prev: Record<string, ActivityStamp>,
  agents: ReadonlyArray<{ id: string; activity?: string }>,
  now: number,
): Record<string, ActivityStamp> {
  const next: Record<string, ActivityStamp> = {};
  for (const a of agents) {
    const value = (a.activity ?? "").trim();
    const seen = prev[a.id];
    const at = seen === undefined ? 0 : seen.value !== value ? now : seen.at;
    next[a.id] = { value, at };
  }
  return next;
}

/** The notification body to use FROM a self-report, or null to fall back to the Haiku summary. Only
 *  the two "ask" statuses (waiting/approval) are eligible — the exact scope summarize_attention
 *  covers — so errored/other statuses keep their existing generic copy unchanged. Returns the
 *  activity text only when it is present AND fresh: stamped in-session (`at > 0`) and updated within
 *  ACTIVITY_FRESH_MS of `now` (≈ the needs-you transition, which fires this same tick). Pure. */
export function selfReportBody(
  activity: string | undefined,
  stamp: ActivityStamp | undefined,
  now: number,
  status: AgentTabStatus | undefined,
): string | null {
  // Only substitute the activity narration for a WAITING body, where "what I'm doing now" is a
  // reasonable proxy for the question. For APPROVAL we must NOT — the body has to describe the
  // action being approved (e.g. "Approve `rm -rf build/`?"), which the narration ("Refactoring
  // auth") does not capture and could dangerously misrepresent; approval always uses the Haiku
  // ask-summary. (roborev sparkle-jze5 review.)
  if (status !== "waiting") return null;
  const text = (activity ?? "").trim();
  if (!text) return null;
  if (!stamp || stamp.at <= 0) return null; // unknown age → treat as stale
  if (now - stamp.at > ACTIVITY_FRESH_MS) return null; // stale narration → Haiku fallback
  return text;
}

/** Classify what actually supplied a needs-you notification body (Phase-2c gate, sparkle-rl84):
 *  a fresh self-report wins; else the paid Haiku ask-summary if it produced a body; else the generic
 *  reason copy. `selfReported` is selfReportBody's result; `haikuBody` is the trimmed
 *  summarize_attention output (null if not called / empty / failed). Pure — no identifying data. */
export function attentionBodySource(
  selfReported: string | null,
  haikuBody: string | null,
): AttentionSource {
  if (selfReported != null) return "self_report";
  if (haikuBody != null) return "paid_haiku";
  return "generic_fallback";
}

/** Bring this window to the foreground (notification click landed here). */
async function bringToFront(): Promise<void> {
  try {
    const w = getCurrentWindow();
    await w.unminimize();
    await w.show();
    await w.setFocus();
  } catch (e) {
    console.debug("bringToFront failed", e);
  }
}

/** The shared reveal, now in services/agentReveal (it had to leave this module so openProjectTab
 *  could use it without the two importing each other). Re-exported: every existing caller — the
 *  sidebar, the concierge feed, openProjectTab — keeps its import path. */
export { selectAndOpen } from "./services/agentReveal";

export function useAttentionNotifications(): void {
  const rawStatus = useRuntimeStore((s) => s.status);
  // NOTE (roborev 46897): branchStatus / workflowStage / openAgentIds are deliberately NOT
  // subscribed here any more. Their only consumer was the cross-window publish's overlay chain,
  // deleted with that channel — and `branchStatus` takes a fresh object identity on every poll, so
  // keeping the subscription re-rendered this hook's host and re-ran the notification effect on
  // every branch poll to service a dependency nothing read. `publishedStatusFor` still takes them
  // as PARAMETERS for the concierge feed, which is now their only caller.
  const projectId = useCurrentProjectId();
  const label = useCurrentWindowLabel();
  const isMain = useIsMainWindow();
  const replace = useReplaceCurrentProject();
  const agents = useProjectStore(
    (s) => s.projects.find((p) => p.id === projectId)?.agents ?? EMPTY_AGENTS,
  );
  // The badge count and the banner edge-detector BOTH read this map, and both were firing for
  // agents nobody had briefed: `errored` inside the spawn window inflates countAttention, and `idle`
  // — which notifies by DEFAULT as "Finished — your turn" — is simply false about an agent that was
  // never given a turn. withNewAgentCalm resolves those to `new`, which is in neither set. Same
  // step (0) publishedStatusFor applies, so the banner and the row cannot describe an agent
  // differently. Returns the SAME reference when nothing is corrected, so the effect below does not
  // re-run on unrelated renders.
  // Terminal keystrokes are recorded ONLY here (Terminal.onData → touch), so this is the only
  // evidence a hand-driven agent has been briefed — see newAgentAttention route 4.
  const interactionAt = useInteractionStore((s) => s.lastAt);
  // Via the hook, not a bare memo: the backstop is a deadline, and an `errored` agent emits no
  // further status writes to recompute one. See hooks/useNewAgentCalm (roborev 54743, finding 1).
  const status = useNewAgentCalm(agents, rawStatus, interactionAt);
  const projectName = useProjectStore(
    (s) => s.projects.find((p) => p.id === projectId)?.name ?? "",
  );
  // Which statuses the user wants notifications for (⋯ → Notifications). Built into a Set so the
  // edge detector is a cheap membership test. Recomputed only when the prefs object changes.
  const notifyStatuses = useSettingsStore((s) => s.notifyStatuses);
  const enabled = useMemo(
    () =>
      new Set(
        (Object.keys(notifyStatuses) as Array<keyof typeof notifyStatuses>).filter(
          (k) => notifyStatuses[k],
        ),
      ),
    [notifyStatuses],
  );

  // Previous status snapshot + which project it was for, so a project switch re-baselines
  // instead of firing a notification for every already-notifiable agent in the new project.
  const prevStatus = useRef<StatusMap>({});
  const prevProject = useRef<string | null>(null);
  // agentId -> the attention_id we sent the phone, so we can resolve it when it clears.
  const attentionIds = useRef<Record<string, string>>({});
  // agentId -> {value, at}: the last activity narration we observed and WHEN it first appeared this
  // session. Feeds selfReportBody's freshness test (Phase-2b). Pruned to the current owned agents
  // each run by stampActivity.
  const activitySeen = useRef<Record<string, ActivityStamp>>({});

  // Badge + notification side-effects, recomputed whenever status, the owned agent set, or the
  // notify prefs change. The badge stays strictly waiting/approval (countAttention); the banner
  // fires for any newly-entered status the user enabled.
  useEffect(() => {
    const now = Date.now();
    const ownedIds = agents.map((a) => a.id);
    reportAttentionCount(label, countAttention(status, ownedIds));

    // Observe activity narrations so we can judge their freshness at fire time (Phase-2b). Done
    // every run (before the sameProject gate) so a project switch still re-baselines the stamps.
    activitySeen.current = stampActivity(activitySeen.current, agents, now);

    // The cross-window status BROADCAST is gone (roborev 46485-M). It existed so a second window
    // could list this window's red agents at the top of its sidebar; CM-U7 part 2 deleted that
    // reader along with the multi-window shell, and a writer with no reader is a localStorage
    // write plus a Tauri emit on every status change, feeding nothing. What replaced it: one
    // window shows every project (the tab bar surfaces other projects' reds), and the island/phone
    // read the roster published by useRosterPublisher.
    const sameProject = prevProject.current === projectId;
    if (sameProject) {
      // Read live at fire time (no extra deps / re-baselining): is THIS window the OS-focused
      // window, and which of its agents is the selected tab. Together they let us suppress the
      // single "you're already looking at this exact agent" case while still firing for a
      // different agent, a background window/project, or another app in front.
      const windowFocused = typeof document !== "undefined" && document.hasFocus();
      const selectedAgentId =
        useProjectStore.getState().projects.find((p) => p.id === projectId)?.selectedAgentId ?? null;
      // For each agent that just crossed into a notifiable status, dispatch ONE independent
      // fire-and-forget task. The task computes the Haiku "what is it asking" summary ONCE (for the
      // waiting/approval ask statuses) and feeds it to BOTH channels — the paired phone (emitAttention
      // → the iOS push body) and the native macOS banner (notifyAttention body) — so the Mac and the
      // phone read identically. Tasks are independent (not serialized behind one another's await) so a
      // slow/hung summary (the Haiku call can take up to ~40s before its timeout falls back) never
      // delays an unrelated notice. The effect can't be async, so each task has its own catch.
      const pid = projectId;
      for (const { id, status: st } of newlyEntered(prevStatus.current, status, ownedIds, enabled)) {
        const agent = agents.find((a) => a.id === id);
        if (!agent || pid == null) continue;
        const agentName = agent.name;
        const relay = needsAttention(st); // mirrored to the phone regardless of local suppression
        const suppressed = suppressNotification({ windowFocused, selectedAgentId, agentId: id });
        if (!relay && suppressed) continue; // not relayed and locally suppressed — nothing to send
        // Phase-2b: if the agent FRESHLY self-reported what it's doing (within ACTIVITY_FRESH_MS of
        // this needs-you transition), prefer that text as the body and skip the paid Haiku scrape.
        // Captured synchronously here — the ref reflects this tick's stamping above. Null for stale/
        // absent narration (and for non-ask statuses), which falls through to Haiku exactly as before.
        const selfReported = selfReportBody(agent.activity, activitySeen.current[id], now, st);
        void (async () => {
          // The agent's ask, summarized once and shared by phone + banner. A fresh self-report wins;
          // otherwise only the two "ask" statuses are summarized (cost control), and any miss/empty/
          // throw → null → generic copy below. `awaited` records whether we actually yielded on the
          // Haiku call — it gates the live status re-check below so the synchronous path (self-report
          // or no screen) doesn't second-guess the just-validated `st`.
          let summary: string | null = selfReported;
          let awaited = false;
          // Phase-2c gate: track whether the PAID Haiku summary actually produced a usable body, so
          // we can classify the body source (self-report vs paid vs generic) below — observation only.
          let haikuBody: string | null = null;
          if (summary == null && (st === "waiting" || st === "approval")) {
            const screenText = useRuntimeStore.getState().attentionScreen[id];
            // Match the backend's own empty-check: `summarize_attention` trims the screen before
            // deciding there's nothing to summarize, so a whitespace/newline-only snapshot would slip
            // past a bare truthiness guard, cost an IPC round-trip, and come back as a "failed empty
            // screen" non-error. Pre-trim here so we only summarize a screen with real content.
            if (screenText?.trim()) {
              awaited = true;
              // Metering-only: attributes the summarizer's debit to the agent's OWNING project.
              const trimmed = (
                await summarizeAttention(screenText, projectNameForAgent(id))
              )?.trim();
              if (trimmed) {
                summary = trimmed;
                haikuBody = trimmed;
              }
            }
          }
          // Record which source supplied the body, once per DISPATCHED needs-you event (privacy-safe
          // enums only: source, status, kind — never the body text itself). Population = events that
          // reached at least one channel: red statuses always fire the phone relay here (even when the
          // LOCAL banner is suppressed because you're already looking at the agent), and the `!relay &&
          // suppressed` case already `continue`d above, so it never reaches this line. So this counts
          // "of needs-you events we surfaced somewhere," NOT "of banners visibly shown on this Mac."
          reportAttentionSource(attentionBodySource(selfReported, haikuBody), st, agent.kind);

          // Phone relay (separate device — fires regardless of local suppression). Only when we
          // actually awaited the summary do we re-check that the agent is STILL red: that await is the
          // gap in which the user could have answered/cleared it, and emitting after the fact would
          // race the resolve-cleanup below and leave a stale card on the phone. With no await we run
          // synchronously in the same tick `newlyEntered` validated `st`, so the captured status holds
          // and no re-check is needed (it would only re-read the same snapshot).
          if (relay && (!awaited || needsAttention(useRuntimeStore.getState().status[id]))) {
            const attentionId = crypto.randomUUID();
            attentionIds.current[id] = attentionId;
            const approval = st === "approval";
            // `errored` covers both a crash and a mid-stream API-error/self-prompt stall — the agent
            // is stuck until you look, so it relays as a (reply-less) "needs you" with its own copy.
            const errored = st === "errored";
            // The EXACT terminal text that put this agent into the red state — the ask-screen
            // snapshot captured when it crossed into waiting/approval, else the recent scrollback
            // tail (errored/stalled agents have no ask snapshot). The phone renders this verbatim in
            // monospace under the plain-English `question` summary.
            const detail = truncateDetail(
              useRuntimeStore.getState().attentionScreen[id] ?? getAgentScrollback(id) ?? "",
            );
            emitAttention({
              attention_id: attentionId,
              agent_id: id,
              agent_name: agentName, // plain — the relay server prefixes the 🔴 in the push title
              project_name: projectName,
              kind: approval ? "approval" : "question",
              question:
                summary ??
                (approval
                  ? `${agentName} needs you to approve an action in ${projectName}.`
                  : errored
                    ? `${agentName} hit an error / stalled in ${projectName} and needs you.`
                    : `${agentName} is waiting on your answer in ${projectName}.`),
              ...(detail ? { detail } : {}),
              // Real heuristic-detected direct-answers (y/n, numbered menu) when present, else a
              // generic Approve/Deny for approvals. See suggestedRepliesFor.
              suggested_replies: suggestedRepliesFor(getAgentScrollback(id) ?? "", approval),
              created_at: new Date().toISOString(),
            });
          }

          // Native macOS banner — emoji'd title from notificationFor, body = the SAME summary the
          // phone got (or its generic reason fallback). Skipped only when you're already looking at
          // this exact agent (suppressNotification). Unlike the phone relay above, the banner does
          // NOT re-check live status after the await: a banner is a transient OS notification (it
          // appears and auto-dismisses), so a slightly-stale one is low-harm — whereas a phone card
          // persists until resolved, which is why only the relay re-validates. Intentional asymmetry.
          if (!suppressed) {
            const banner = notificationFor(st, agentName, projectName);
            notifyAttention({
              projectId: pid,
              agentId: id,
              title: banner.title,
              body: summary ?? banner.body,
            });
          }
        })().catch((e) => console.debug("attention notify dispatch failed", e));
      }
    }
    // Clear the phone's card for any agent we raised that is no longer red — including agents
    // that left the owned set entirely (project switch / removed), which the loop above misses.
    for (const [id, attentionId] of Object.entries(attentionIds.current)) {
      if (!needsAttention(status[id])) {
        emitResolved(attentionId);
        delete attentionIds.current[id];
      }
    }
    prevStatus.current = status;
    prevProject.current = projectId;
  }, [
    status,
    agents,
    projectId,
    label,
    projectName,
    enabled,
  ]);

  // Report 0 on unmount so a closed window stops contributing to the app-global badge total.
  useEffect(
    () => () => {
      reportAttentionCount(label, 0);
    },
    [label],
  );

  // Notification-click routing. Registered once; reads the live current project via a ref.
  const ctx = useRef({ projectId, label, isMain, replace });
  ctx.current = { projectId, label, isMain, replace };
  useEffect(() => {
    // A cross-webview payload can name a project/agent this window's store hasn't rehydrated yet
    // (crossWindowSync coalesces up to 300ms — another webview adds a project, then immediately asks us
    // to show it). Dropping would be a dead click (roborev 46328-M2), so on an unknown id we
    // DEFER the whole response — raise included — and act once the id appears.
    //
    // Exactly ONE deferral is ever in flight, and the effect's cleanup cancels it (roborev
    // 46485-M). Both properties are load-bearing: an untracked deferral fires `replace` /
    // `selectAndOpen` after this hook unmounts (store writes from a dead tree, and cross-test
    // bleed, since the stores are module state); and N un-deduped deferrals mean the tab you
    // land on is whichever project rehydrated last, not the notification you clicked.
    let cancelPending: (() => void) | null = null;
    /** Drop whatever deferral is watching the store. Called by BOTH handlers before they act —
     *  `awaitInStore` cancelling its own predecessor covers deferral-vs-deferral, but the
     *  focus-agent FAST path reveals inline and never enters awaitInStore, so a pending deferral
     *  would still fire afterwards and re-point the tab at the older click (roborev 46897). */
    const cancelDeferral = (): void => cancelPending?.();
    const awaitInStore = (
      probe: () => boolean,
      act: () => void,
      timeoutMs = 3_000,
    ): void => {
      cancelDeferral();
      if (probe()) {
        act();
        return;
      }
      const stop = () => {
        cancelPending = null;
        unsub();
        clearTimeout(timer);
      };
      const unsub = useProjectStore.subscribe(() => {
        if (!probe()) return;
        stop();
        act();
      });
      const timer = setTimeout(stop, timeoutMs);
      cancelPending = stop;
    };
    const handle = (p: FocusAgentPayload) => {
      const { replace: setProject } = ctx.current;
      // VALIDATE FIRST. The broadcast can be stale (the roster lags a deletion) or rogue,
      // and everything below is a side effect: `runtimeStore.open` does not check that the agent
      // exists, so a phantom id would sit in `openAgentIds` forever (roborev 46249-L1). But a
      // stale AGENT id must still raise the window and land on its project when that project
      // exists (roborev 46328-M3) — the user clicked a notification; give them the closest thing.
      //
      // The RAISE rides along with that validation instead of preceding it (roborev 46485-L):
      // a window that jumps to the front is a real interruption, so it is owed to a payload that
      // names something we can show — immediately when the project is already here, one coalesce
      // later when it is still rehydrating, and never for an id that never arrives.
      if (!agentExists(p.projectId, p.agentId)) {
        awaitInStore(
          () => useProjectStore.getState().projects.some((x) => x.id === p.projectId),
          () => {
            void bringToFront();
            if (agentExists(p.projectId, p.agentId)) {
              // The agent arrived with the rehydrate — do the full reveal after all.
              //
              // UNCONDITIONAL, for the same reason as the fast path below, and this branch needs it
              // MORE: it runs when the agent was not in the store yet, i.e. the cross-webview case
              // where `requestProjectTabFromOtherWindow` has already written `selectedProjectId`
              // side-blind and projectStore has synced it in. Comparing against that value — the
              // RIGHT pair's selection — saw an equal id for a LEFT-assigned project, skipped the
              // write, and left `leftProjectId` untouched while `selectAndOpen` mounted the agent
              // into a stage showing something else. The seam is idempotent. (roborev 55196)
              ctx.current.replace(p.projectId);
              selectAndOpen(p.projectId, p.agentId);
            } else {
              openProjectTab(p.projectId);
            }
          },
        );
        return;
      }
      // If the click carried a specific prompt (a breadcrumb), queue a scroll to that turn; the
      // target agent's AgentPane consumes it once its terminal is mounted + PTY-ready. Missing/
      // scrolled-out markers (or think agents with no terminal) simply open without scrolling.
      const jumpToPrompt = () => {
        if (p.promptId) useScrollIntentStore.getState().request(p.agentId, p.promptId);
      };
      // SINGLE-WINDOW SHELL (CM-U7): this window shows every project, one per TAB, so it always
      // handles the broadcast — there is no owning-window question and no orphan case. A target in
      // another project simply selects that project's tab first (which is what `replace` now does).
      // This click resolves NOW, so any older deferral still waiting for its project is stale.
      cancelDeferral();
      void bringToFront();
      // UNCONDITIONAL — the `p.projectId !== mine` guard was wrong once the left pair existed.
      //
      // `mine` is `selectedProjectId`, which is the RIGHT pair's selection; for a LEFT-assigned
      // project it is not that pair's selection at all. The tray/capture webview reaches here with
      // `selectedProjectId` ALREADY pointing at the left project — `requestProjectTabFromOtherWindow`
      // writes it side-blind and projectStore is cross-window synced synchronously — so the guard
      // saw `p.projectId === mine`, skipped the write, and `leftProjectId` never moved. The agent
      // then mounted and selected into a stage whose pair was showing something else: a dead click.
      // The fix cannot live in the emitting webview, because uiStore (which holds the assignment
      // map) is deliberately NOT cross-window synced — only the main window can route this.
      // `setProject` is idempotent for a project already selected on its own side. (roborev 55192)
      setProject(p.projectId);
      selectAndOpen(p.projectId, p.agentId);
      jumpToPrompt();
    };
    // "Show me this project" from the tray/capture webview: select the tab, raise the window, and
    // drop the app-global Improve Sparkle overlay (with the workMode that pairs with it, see
    // services/openProjectTab) — nothing agent- or PTY-related. NO agent is mounted and no PTY is
    // spawned: that is the whole difference from focus-agent, and the reason this is its own event.
    const handleSelectProject = (p: SelectProjectPayload) => {
      // Raise + select together, deferring briefly if the project was just added in another
      // webview and hasn't rehydrated here yet (roborev 46328-M2 / 46485-L).
      awaitInStore(
        () => useProjectStore.getState().projects.some((x) => x.id === p.projectId),
        () => {
          void bringToFront();
          openProjectTab(p.projectId);
        },
      );
    };
    // A band chiclet on the floating helper island: raise the window and put that band in front of
    // the user. Deliberately does NOT mount an agent or spawn a PTY — the click means "show me
    // what's urgent", not "open this specific agent", which is why it is its own event.
    const handleFocusTier = (p: FocusTierPayload) => {
      void bringToFront();
      // Isolating writes the SAME statusFilter the sidebar's chips render, so the click's effect is
      // visible in the chip bar and clearable by the ordinary "Show all" — rather than an invisible
      // mode with its own bespoke dismiss control. (The older note here worried about clobbering
      // `agentOrdering`; that preference no longer exists — the column has one ordering now.)
      useUiStore.getState().isolateStatusBand(p.band);
    };
    // Keep the listen() promise; safeUnlisten awaits it on cleanup so a listener that resolves
    // AFTER unmount is still torn down (and the Tauri teardown race is swallowed).
    const unlistenPromise = onFocusAgent(handle);
    const unlistenSelect = onSelectProject(handleSelectProject);
    const unlistenTier = onFocusTier(handleFocusTier);
    return () => {
      void safeUnlisten(unlistenPromise);
      void safeUnlisten(unlistenSelect);
      void safeUnlisten(unlistenTier);
      // Drop any deferral still watching the store: without this it fires into an unmounted tree
      // (and, in tests, into the NEXT case's stores — roborev 46485-M).
      cancelDeferral();
    };
  }, []);
}

// Stable empty reference so the agents selector doesn't return a fresh [] each render.
const EMPTY_AGENTS: AgentTab[] = [];
