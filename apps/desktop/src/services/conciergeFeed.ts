// Cross-project roster + P0/P1/P2 priority feed for Concierge Mode (bead sparkle-ld0t, CM-U3).
//
// This is the data layer the concierge column reads: ONE view of everything across all projects,
// with each agent banded into the priority tiers the prototype renders (P0 red · P1 yellow · P2
// gray). The core is a PURE builder (like useRosterPublisher.buildRoster) so it unit-tests without
// a DOM or Tauri; useConciergeFeed.ts wires it to the live stores.
//
// PRIORITY IS REUSED, NOT INVENTED — the bands are exactly the two existing attention tiers:
//   P0 = engine/attention.needsAttention  (waiting | approval | errored — "answer this NOW")
//   P1 = "wants you eventually" — the red-but-not-asking `blocked`. NOT `unmerged`, which is P2 on
//        purpose: this band buys an INTERRUPTION (see conciergePriority), and landing state must not.
//   P2 = everything else                   (working | idle | done | stopped — calm)
// The status each agent is banded ON is the same overlaid status the sidebar colors its rows with
// and the cross-window channel broadcasts: useAttentionNotifications.publishedStatusFor (unstarted-
// worker red → worker-red bubble → unmerged escalation → alert-dismissal de-escalation, in that
// contractual order). A red worker therefore also paints its orchestrator here, exactly as it does
// everywhere else.
import { AGENT_STATUS, type AgentTabStatus } from "@sparkle/ui";
import { needsAttention } from "../engine/attention";
import { agentDisplayName } from "../engine/agentDisplayName";
import { isRedStatus } from "./windowStatus";
import { resolveStage, type WorkflowStageId } from "../engine/workflowStage";
import { publishedStatusFor } from "../useAttentionNotifications";
import type { BranchStatus } from "./branchStatus";
import type { Roster } from "./rosterTypes";
import type { AgentKind, Project } from "../types";

/** 0 = answer now (red, badge tier) · 1 = wants you eventually (`blocked`) · 2 = everything else.
 *
 *  P2 is NOT "the rows the sidebar grayscales" — that is `isCalmBand`, which excludes `unmerged`.
 *  Keep the two apart; conflating them is what this file's two 2026-07-26 regressions both were. */
export type ConciergeAgentPriority = 0 | 1 | 2;

export interface ConciergeAgent {
  id: string;
  name: string;
  projectId: string;
  projectName: string;
  kind: AgentKind;
  status: AgentTabStatus;
  statusColor: string;
  statusLabel: string;
  priority: ConciergeAgentPriority;
  /** Epoch ms of the user's last touch of this agent (interactionStore.lastAt / promptHistory) —
   *  the within-tier recency tiebreak. Absent when the agent was never touched this session. */
  since?: number;
  /** False only when a pin (pinnedProjectId) scopes the concierge to a DIFFERENT project. An
   *  out-of-scope agent stays in the feed (the roster is the full truth) but never counts toward
   *  scopedCounts — pinning means "disregard other projects' alerts", not "hide them". */
  inScope: boolean;
  /** True when a do-not-interrupt rule (sparklePrefsStore.shouldInterrupt) mutes one of this
   *  item's topics (see conciergeTopics). A muted item stays listed so the UI can dim it, but is
   *  excluded from scopedCounts — the concierge doesn't surface what you asked it not to. */
  muted: boolean;
}

export interface ConciergeCounts {
  p0: number;
  p1: number;
}

export interface ConciergeProject {
  id: string;
  name: string;
  /** False only when a pin scopes the concierge to a different project. */
  inScope: boolean;
  /** This project's raw P0/P1 totals (mute/scope ignored) — the per-tab glow + count. */
  counts: ConciergeCounts;
  /** Sorted P0 → P1 → P2; within a tier, live questions first, then most recent, then name. */
  agents: ConciergeAgent[];
}

export interface ConciergeFeed {
  projects: ConciergeProject[];
  /** Raw totals across ALL projects, mute/scope ignored — the full truth. */
  counts: ConciergeCounts;
  /** What the concierge actually surfaces: in-scope (per the pin) AND not muted. This is the
   *  vitals line (U1's `vitals: { p0, p1 }`) and the "needs surfacing" gate. */
  scopedCounts: ConciergeCounts;
  pinnedProjectId: string | null;
}

export interface ConciergeFeedInput {
  /** All projects (projectStore.projects) — the concierge spans every one, not just the tab. */
  projects: readonly Project[];
  /** THIS window's live status map (runtimeStore.status). */
  status: Record<string, AgentTabStatus>;
  /** Stage inputs for the `unmerged` escalation (runtimeStore); omit in tests for no overlay. */
  workflowStage?: Record<string, WorkflowStageId>;
  branchStatus?: Record<string, BranchStatus>;
  /** Live agent ids (runtimeStore.openAgentIds) for the unstarted-worker red overlay. */
  openAgentIds?: readonly string[];
  /** Agent id → epoch ms of last user touch (interactionStore.lastAt). */
  interaction?: Record<string, number>;
  /** The merged cross-window fleet (getRoster/onRosterChanged). Fills statuses for agents
   *  another window runs — this window's own `status` map only covers agents it hosts, and an
   *  agent covered by NEITHER falls back to "stopped" (same default as buildRoster). Local status
   *  always wins over the tray's. */
  roster?: Roster | null;
  /** The mute gate (sparklePrefsStore.shouldInterrupt). Defaults to allow-everything. */
  shouldInterrupt?: (topic: string) => boolean;
  /** Pin scope: set → only that project's alerts count toward scopedCounts; null/omitted → all. */
  pinnedProjectId?: string | null;
}

const DEFAULT_STATUS: AgentTabStatus = "stopped";

/** The name the concierge shows — the one shared rule (engine/agentDisplayName). */
const displayName = agentDisplayName;

/** The priority band for a status: P0 "needs you now" (needsAttention) → P1 "wants you eventually"
 *  (the red-but-not-asking `blocked`) → P2 calm.
 *
 *  `unmerged` is P2. This band is the concierge's INTERRUPTION budget, not a display tier:
 *  `priority < 2` is what `ConciergeHost.surfacedAgents` renders as a nudge card, what feeds
 *  `counts.p1` / the "N need attention" line, and what lights a project tab's glow via
 *  `ProjectTabs.tabPriority`. On the fleet that started all this — 27 of 51 agents in the
 *  committed-but-unlanded band — putting `unmerged` at P1 would mean 27 nudge cards and
 *  "27 P1 need attention": the same undismissable pile the taxonomy fix exists to remove, in yellow
 *  instead of red (roborev on f7b43dc8). Landing state must not buy an interruption.
 *
 *  It must not buy a DIMMING either, which is the trap that made P1 tempting — see `isCalmBand`. */
export function conciergePriority(status: AgentTabStatus | undefined): ConciergeAgentPriority {
  if (needsAttention(status)) return 0;
  if (isRedStatus(status)) return 1;
  return 2;
}

/** Should the sidebar render this row GRAYSCALED and dimmed (`grayscale(1) opacity(.72)`)?
 *
 *  Deliberately NOT `conciergePriority(status) === 2`, which is what AgentSidebar used to ask. Those
 *  two questions look identical and are not: the band is an interruption budget, dimming is a
 *  legibility treatment, and `unmerged` needs opposite answers from them — no nudge card (so P2), but
 *  not visually muted either, because "your work hasn't landed" is exactly the thing you should still
 *  be able to see at a glance.
 *
 *  Conflating them is a two-way trap that this series hit from BOTH sides in consecutive commits:
 *  P2 silently dimmed every "Needs merge" row, and the P1 fix for that silently turned each one into
 *  a concierge nudge. Naming the predicate is what stops the next person rediscovering it. */
export function isCalmBand(status: AgentTabStatus | undefined): boolean {
  return conciergePriority(status) === 2 && status !== "unmerged";
}

/** The do-not-interrupt topics a feed item is keyed under, for sparklePrefsStore.shouldInterrupt:
 *  the agent id ("never interrupt me about THIS agent") and a `status:<status>` event-kind slug
 *  ("never interrupt me about approvals"). Muting EITHER mutes the item. Exported so the
 *  integration layer (U7) and any settings UI key rules identically. */
export function conciergeTopics(agentId: string, status: AgentTabStatus): string[] {
  return [agentId, `status:${status}`];
}

/** Flatten a tray roster to agent id → status, keeping only statuses in the AGENT_STATUS taxonomy
 *  (the tray's field is a plain string that crossed the Rust boundary). Null/absent roster → {}. */
export function trayStatusMap(
  roster: Roster | null | undefined,
): Record<string, AgentTabStatus> {
  const out: Record<string, AgentTabStatus> = {};
  if (!roster) return out;
  for (const p of roster.projects) {
    for (const a of p.agents) {
      // Own-property check (NOT `in`): status is a raw string from the Rust boundary, so `in` would
      // also match Object.prototype keys ("toString", "constructor", …) and leak a bogus status.
      if (Object.hasOwn(AGENT_STATUS, a.status)) out[a.id] = a.status as AgentTabStatus;
    }
  }
  return out;
}

// Within-tier rank: a live question (waiting/approval — the user is actively blocking) outranks
// the rest of its tier. Mirrors windowStatus.attentionRank (module-private there).
function tierRank(status: AgentTabStatus): number {
  return status === "waiting" || status === "approval" ? 0 : 1;
}

// P0 → P1 → P2; within a tier live questions first, then most-recently-touched, then name — a
// total order (name last) so the rendered list is stable across rebuilds.
function compareAgents(a: ConciergeAgent, b: ConciergeAgent): number {
  return (
    a.priority - b.priority ||
    tierRank(a.status) - tierRank(b.status) ||
    (b.since ?? 0) - (a.since ?? 0) ||
    a.name.localeCompare(b.name)
  );
}

/** Build the concierge's cross-project priority feed. Pure — no store reads, no Tauri. */
export function buildConciergeFeed(input: ConciergeFeedInput): ConciergeFeed {
  const {
    projects,
    workflowStage = {},
    branchStatus = {},
    openAgentIds = [],
    interaction = {},
    shouldInterrupt = () => true,
  } = input;
  const pinnedProjectId = input.pinnedProjectId ?? null;

  // Cross-window completeness: the tray's merged fleet fills statuses this window doesn't run;
  // the local live map wins wherever both know the agent.
  const mergedStatus: Record<string, AgentTabStatus> = {
    ...trayStatusMap(input.roster),
    ...input.status,
  };

  // The same overlaid status every other surface bands/colors on. Run over the FLATTENED fleet so
  // a worker's red bubbles to its orchestrator regardless of which project holds them.
  const allAgents = projects.flatMap((p) => p.agents);
  const derived = publishedStatusFor(allAgents, mergedStatus, new Set(openAgentIds), (id) =>
    resolveStage(branchStatus[id], workflowStage[id]),
  );

  const counts: ConciergeCounts = { p0: 0, p1: 0 };
  const scopedCounts: ConciergeCounts = { p0: 0, p1: 0 };
  const outProjects: ConciergeProject[] = projects.map((p) => {
    const inScope = pinnedProjectId === null || p.id === pinnedProjectId;
    const projectCounts: ConciergeCounts = { p0: 0, p1: 0 };
    const agents = p.agents.map((a): ConciergeAgent => {
      const status = derived[a.id] ?? DEFAULT_STATUS;
      const tok = AGENT_STATUS[status] ?? AGENT_STATUS[DEFAULT_STATUS];
      const priority = conciergePriority(status);
      const muted = conciergeTopics(a.id, status).some((t) => !shouldInterrupt(t));
      const since = interaction[a.id];
      if (priority === 0) projectCounts.p0++;
      else if (priority === 1) projectCounts.p1++;
      if (priority < 2 && inScope && !muted) {
        if (priority === 0) scopedCounts.p0++;
        else scopedCounts.p1++;
      }
      return {
        id: a.id,
        name: displayName(a),
        projectId: p.id,
        projectName: p.name,
        kind: a.kind,
        status,
        statusColor: tok.color,
        statusLabel: tok.label,
        priority,
        ...(since !== undefined && since > 0 ? { since } : {}),
        inScope,
        muted,
      };
    });
    agents.sort(compareAgents);
    counts.p0 += projectCounts.p0;
    counts.p1 += projectCounts.p1;
    return { id: p.id, name: p.name, inScope, counts: projectCounts, agents };
  });

  return { projects: outProjects, counts, scopedCounts, pinnedProjectId };
}
