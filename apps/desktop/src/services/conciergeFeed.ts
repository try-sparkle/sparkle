// Cross-project roster + status-band feed for Concierge Mode (bead sparkle-ld0t, CM-U3).
//
// This is the data layer the concierge column reads: ONE view of everything across all projects,
// with each agent placed in one of the three STATUS BANDS the whole app now speaks in —
// "Needs you" · "Running" · "Done". The core is a PURE builder (like useRosterPublisher.buildRoster)
// so it unit-tests without a DOM or Tauri; useConciergeFeed.ts wires it to the live stores.
//
// THE VOCABULARY IS IMPORTED, NOT INVENTED — `bandOfStatus`/`STATUS_BANDS` live in
// engine/buildSections, where the Build column's filter chips read them, so a status can never band
// one way in the sidebar and another in the concierge:
//   needs_you ← waiting | approval | blocked | errored   ("this cannot proceed without you")
//   running   ← working
//   done      ← idle | done | stopped | unmerged
// This replaced a P0/P1/P2 scheme that split `blocked` off into its own amber tier and lumped
// `working` in with the finished rows. The split that matters to a user is the one that survived:
// in-flight work is not finished work. The one that didn't — "asks you now" vs "wants you
// eventually" — bought a second alarm color for a distinction nobody acted on differently, so
// `blocked` now reads RED like every other Needs-you status and there is exactly ONE red treatment.
//
// `unmerged` is in `done`, and that is load-bearing: the band buys an INTERRUPTION (see
// `conciergeBand`), and landing state must not. It is kept out of the DIMMING predicate separately —
// see `isCalmBand`, and do not collapse the two.
//
// The status each agent is banded ON is the same overlaid status the sidebar colors its rows with
// and the cross-window channel broadcasts: useAttentionNotifications.publishedStatusFor (unstarted-
// worker red → worker-red bubble → unmerged escalation → alert-dismissal de-escalation, in that
// contractual order). A red worker therefore also paints its orchestrator here, exactly as it does
// everywhere else.
import { AGENT_STATUS, type AgentTabStatus } from "@sparkle/ui";
import { agentDisplayName } from "../engine/agentDisplayName";
import { isTopLevelAgent } from "../engine/agentOrdering";
import { STATUS_BANDS, bandOfStatus, type StatusBand } from "../engine/buildSections";
import { resolveStage, type WorkflowStageId } from "../engine/workflowStage";
import { publishedStatusFor } from "../useAttentionNotifications";
import type { BranchStatus } from "./branchStatus";
import type { Roster } from "./rosterTypes";
import type { AgentKind, Project } from "../types";

export interface ConciergeAgent {
  id: string;
  name: string;
  projectId: string;
  projectName: string;
  kind: AgentKind;
  status: AgentTabStatus;
  statusColor: string;
  statusLabel: string;
  band: StatusBand;
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
  /** Whether this agent gets a ROW OF ITS OWN in the Build column, per the one shared rule
   *  (engine/agentOrdering.isTopLevelAgent) — i.e. it is not a worker, and not nested under a build
   *  agent that is present in the same project.
   *
   *  Stamped here, on the feed, because the digest's count is a PROMISE the click has to keep:
   *  clicking "2 Need you in web" isolates that band in column two, which narrows top-level rows and
   *  nothing else. A digest that counted workers would state a number column two cannot produce —
   *  two blocked workers gave the user "2" and an empty column. The feed still LISTS workers (it is
   *  the full cross-project truth, and a worker's red still bubbles to its orchestrator); this field
   *  is what lets the surfacing gate count only what is clickable-to. */
  topLevel: boolean;
  /** True when this agent gets NO row of its own AND a present ancestor ALREADY carries its band —
   *  so the concierge would be saying the same thing twice if it counted both.
   *
   *  This is the other half of `topLevel`, and the two only make sense together. `topLevel` says
   *  "can the Build column show this?"; a rowless agent that nothing else speaks for still has to
   *  reach the user SOMEHOW, or the `topLevel` gate turns it into silence. That is precisely what
   *  happened: `isTopLevelAgent` excludes every worker unconditionally, while
   *  `engine/workerAttention.withRedWorkerAttention` bubbles a worker's red to its orchestrator only
   *  sometimes — it skips a worker with no `parentId`, it writes to a status-map key with no agent
   *  behind it when the parent is not in the fleet, and it deliberately SUPPRESSES a non-ask red
   *  (`blocked`) while the orchestrator is still in motion. A worker in any of those three cases had
   *  no row, no card, no digest line and no count.
   *
   *  So the rule is representation, not kind: counted once, at whichever agent actually stands for
   *  the work. Represented → the ancestor's row speaks for it. Not represented → it speaks for
   *  itself (ConciergeHost surfaces it as its own nudge card, never folded into a digest line's
   *  count, because a line's count is a promise about ROWS).
   *
   *  BAND EQUALITY is the test, not mere parenthood: a `blocked` worker under a `working`
   *  orchestrator is NOT represented (the orchestrator's row is banded Running — the Needs-you
   *  filter hides it), while a `waiting` worker under the orchestrator that inherited that exact
   *  `waiting` IS. It also keeps the `running` band honest in the other direction: a `working`
   *  worker under an `idle` parent still counts, because nothing else is reporting that work.
   *
   *  Walked over the FLATTENED fleet, so a worker whose orchestrator lives in another project is
   *  represented by that orchestrator's row — which is where `publishedStatusFor` put its red.
   *  Mute and scope are deliberately NOT consulted: they are applied to the agent itself, and a
   *  user who muted an orchestrator muted its build, workers included. */
  representedElsewhere: boolean;
}

/** How many agents sit in each band. Every band is counted — a surface that only cares about
 *  "Needs you" reads that one field rather than the feed having to guess which ones matter. */
export type ConciergeCounts = Record<StatusBand, number>;

/** All-zero counts — the shape every accumulator starts from. */
export function emptyCounts(): ConciergeCounts {
  return { needs_you: 0, running: 0, done: 0 };
}

export interface ConciergeProject {
  id: string;
  name: string;
  /** False only when a pin scopes the concierge to a different project. */
  inScope: boolean;
  /** This project's raw per-band totals (mute/scope ignored) — the per-tab glow + count. */
  counts: ConciergeCounts;
  /** Sorted Needs you → Running → Done; within a band, live questions first, then most recent,
   *  then name. */
  agents: ConciergeAgent[];
}

export interface ConciergeFeed {
  projects: ConciergeProject[];
  /** Raw totals across ALL projects, mute/scope ignored — the full truth. */
  counts: ConciergeCounts;
  /** What the concierge actually surfaces: in-scope (per the pin) AND not muted. This is the
   *  vitals line (U1's `vitals`) and the "needs surfacing" gate. */
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

/** The status band for a status, tolerating "no status at all" (an agent no window is running):
 *  that reads as `done`, the same place `stopped` — the builder's default — lands.
 *
 *  A thin `undefined`-shim over engine/buildSections.bandOfStatus, NOT a second opinion about where
 *  a status belongs. Adding an arm here instead of there is how the sidebar's filter chips and the
 *  concierge start disagreeing about the same agent.
 *
 *  `unmerged` bands `done`. This band is the concierge's INTERRUPTION budget, not a display tier:
 *  `band === "needs_you"` is what `ConciergeHost.surfacedAgents` renders as a nudge card, what feeds
 *  the "N Need you" line, and what lights a project tab's glow via `ProjectTabs.tabBand`. On the
 *  fleet that started all this — 27 of 51 agents in the committed-but-unlanded band — banding
 *  `unmerged` as needs_you would mean 27 nudge cards and "27 Need you": the same undismissable pile
 *  the taxonomy fix exists to remove (roborev on f7b43dc8). Landing state must not buy an
 *  interruption.
 *
 *  It must not buy a DIMMING either, which is the trap the other direction — see `isCalmBand`. */
export function conciergeBand(status: AgentTabStatus | undefined): StatusBand {
  return status === undefined ? "done" : bandOfStatus(status);
}

/** Should the sidebar render this row GRAYSCALED and dimmed (`grayscale(1) opacity(.72)`)?
 *
 *  Deliberately NOT "is this row's band `done`", and deliberately NOT "is it anything but
 *  needs_you" alone. The set is {idle, done, stopped, working, no-status}: everything that is not
 *  asking for you, MINUS `unmerged`.
 *
 *  Those questions look identical to the band and are not: the band is an interruption budget,
 *  dimming is a legibility treatment, and `unmerged` needs opposite answers from them — no nudge
 *  card (so, `done`), but not visually muted either, because "your work hasn't landed" is exactly
 *  the thing you should still be able to see at a glance.
 *
 *  Conflating them is a two-way trap that this series hit from BOTH sides in consecutive commits:
 *  the calm band silently dimmed every "Needs merge" row, and the fix for that silently turned each
 *  one into a concierge nudge. Naming the predicate is what stops the next person rediscovering it.
 *
 *  Note `working` is in here even though it is its own band now: a running agent is not asking you
 *  for anything, and the terminal you are watching desaturating the moment it starts working would
 *  be a treatment nobody wants. The band split running from done for POSITION and COUNTS; it did not
 *  change what dims. */
export function isCalmBand(status: AgentTabStatus | undefined): boolean {
  return conciergeBand(status) !== "needs_you" && status !== "unmerged";
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

// Within-band rank: a live question (waiting/approval — the user is actively blocking) outranks
// the rest of its band. Mirrors windowStatus.attentionRank (module-private there).
function tierRank(status: AgentTabStatus): number {
  return status === "waiting" || status === "approval" ? 0 : 1;
}

// Sort key for a band, read off STATUS_BANDS' declared order rather than a second table here — the
// chips render top-to-bottom in that order, and the feed must not be able to disagree with them.
function bandRank(band: StatusBand): number {
  const i = STATUS_BANDS.findIndex((b) => b.id === band);
  return i === -1 ? STATUS_BANDS.length : i;
}

// Needs you → Running → Done; within a band live questions first, then most-recently-touched, then
// name — a total order (name last) so the rendered list is stable across rebuilds. Red still sorts
// above calm; what changed is that a RUNNING agent now sorts above a finished one instead of tying
// with it.
function compareAgents(a: ConciergeAgent, b: ConciergeAgent): number {
  return (
    bandRank(a.band) - bandRank(b.band) ||
    tierRank(a.status) - tierRank(b.status) ||
    (b.since ?? 0) - (a.since ?? 0) ||
    a.name.localeCompare(b.name)
  );
}

/** Build the concierge's cross-project status-band feed. Pure — no store reads, no Tauri. */
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

  // Band + parent for EVERY agent in the fleet, so representation can be resolved across projects
  // (a worker's orchestrator may live in another one — that is where publishedStatusFor, which runs
  // over this same flattened list, put its red).
  const bandById = new Map<string, StatusBand>();
  const parentById = new Map<string, string | null>();
  for (const a of allAgents) {
    bandById.set(a.id, conciergeBand(derived[a.id] ?? DEFAULT_STATUS));
    parentById.set(a.id, a.parentId);
  }

  /** Does a present ancestor already carry this agent's band? See `ConciergeAgent.representedElsewhere`.
   *
   *  Walks the chain rather than checking only the parent so a deeper nesting can't silently open the
   *  same hole, and carries a `seen` set because `parentId` is persisted data — a cycle in it must
   *  not hang the feed. An ABSENT ancestor ends the walk with `false`: a bubble aimed at an agent
   *  that is not in the fleet lands nowhere, which is the very case this exists to catch. */
  const isRepresented = (agent: { id: string; parentId: string | null }): boolean => {
    const band = bandById.get(agent.id);
    const seen = new Set<string>([agent.id]);
    let pid = agent.parentId;
    while (pid !== null && !seen.has(pid)) {
      seen.add(pid);
      const parentBand = bandById.get(pid);
      if (parentBand === undefined) return false; // parent not in the fleet — nothing speaks for it
      if (parentBand === band) return true;
      pid = parentById.get(pid) ?? null;
    }
    return false;
  };

  const counts = emptyCounts();
  const scopedCounts = emptyCounts();
  const outProjects: ConciergeProject[] = projects.map((p) => {
    const inScope = pinnedProjectId === null || p.id === pinnedProjectId;
    const projectCounts = emptyCounts();
    // Closed over THIS PROJECT's agents, matching AgentSidebar exactly: the sidebar asks
    // `isTopLevelAgent(project.agents)`, so nesting is judged against the same population on both
    // sides. Judging it against the flattened fleet instead would call a worker whose orchestrator
    // lives in another project "nested" here, where it has no parent row to nest under.
    const isTopLevel = isTopLevelAgent(p.agents);
    const agents = p.agents.map((a): ConciergeAgent => {
      const status = derived[a.id] ?? DEFAULT_STATUS;
      const tok = AGENT_STATUS[status] ?? AGENT_STATUS[DEFAULT_STATUS];
      const band = conciergeBand(status);
      const muted = conciergeTopics(a.id, status).some((t) => !shouldInterrupt(t));
      const since = interaction[a.id];
      const topLevel = isTopLevel(a);
      // A rowless agent an ancestor already speaks for. See `representedElsewhere` — this is what
      // stops one piece of work being counted twice (the red worker AND the orchestrator that
      // inherited its red), which is what made the vitals line and the thread disagree.
      const representedElsewhere = !topLevel && isRepresented(a);
      projectCounts[band]++;
      // The scoped view applies the SAME gates to every band (in scope per the pin, not muted, not
      // already spoken for), so "3 Running" shrinks when you pin exactly the way "3 Need you" does.
      // The old shape only ever scoped the interrupting tiers because it had no field for the rest.
      //
      // These are the counts column one STATES, and `ConciergeHost` derives the thread from the same
      // three gates — so the vitals number and the items the thread accounts for are one population
      // by construction, not two computations that happen to agree. `counts` above stays the raw
      // truth (every agent, once per agent), which is what the per-project tab badges read.
      if (inScope && !muted && !representedElsewhere) scopedCounts[band]++;
      return {
        id: a.id,
        name: displayName(a),
        projectId: p.id,
        projectName: p.name,
        kind: a.kind,
        status,
        statusColor: tok.color,
        statusLabel: tok.label,
        band,
        ...(since !== undefined && since > 0 ? { since } : {}),
        inScope,
        muted,
        topLevel,
        representedElsewhere,
      };
    });
    agents.sort(compareAgents);
    for (const b of STATUS_BANDS) counts[b.id] += projectCounts[b.id];
    return { id: p.id, name: p.name, inScope, counts: projectCounts, agents };
  });

  return { projects: outProjects, counts, scopedCounts, pinnedProjectId };
}
