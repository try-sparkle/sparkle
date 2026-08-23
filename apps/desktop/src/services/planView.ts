// Pure data helpers for the Plan/Build overview — the worker↔bead↔epic linkage views.
// No React, no stores: the Plan view and the Build-tab hovers call these to compute what to show.
// Kept pure so the linkage logic is unit-testable without a GUI.
import { childrenOf, type Bead, type Board } from "./beads";
import type { AgentTab } from "../types";
import { rollupStages, type WorkflowStageId } from "../engine/workflowStage";

/**
 * The unified 10-stage progress stage to show for a bead card. Prefers LIVE build progress (the
 * least-advanced stage among the bead's worker agents) so the card reflects reality, then falls
 * back to mapping the bead's own status:
 *   - delivered (closed + delivered label)        → Shipped to Production
 *   - any worker building it                      → that work's rolled-up stage
 *   - closed                                      → Merged with Main
 *   - in_progress (claimed, no live worker stage) → Building Locally (Unsaved)
 *   - open                                        → Planned
 */
export function beadStage(
  status: Bead["status"],
  delivered: boolean,
  workerStages: WorkflowStageId[],
): WorkflowStageId {
  // A finished bead reflects its resolved status, NOT a lingering worker's live stage — a closed
  // unit shouldn't read as "Building" just because a stale worker tab is still around.
  if (status === "closed") return delivered ? "shipped" : "merged";
  // Otherwise prefer the live build progress (least-advanced worker), then the status mapping.
  if (workerStages.length > 0) {
    const r = rollupStages(workerStages);
    if (r) return r.stage;
  }
  if (status === "in_progress") return "building_unsaved";
  return "planned";
}


/**
 * How an epic reads at a glance, rolled up from its child beads.
 *
 * ── WHY `unplanned` AND `planning` ARE TWO WORDS AND NOT ONE ──────────────────────────────────
 * These were a single `not_started` until this change, and collapsing them is what let a whole
 * class of work die quietly. `not_started` was returned from TWO different lines below — "this
 * epic has no children at all" and "this epic has a full plan and nobody has begun it" — which are
 * opposite situations wearing the same word:
 *
 *   - an epic with no children is a TITLE. Nobody has decided what the work is. There is nothing
 *     for anything to act on, and the correct response is to plan it.
 *   - an epic whose children all sit `open` is a FINISHED PLAN THAT NOBODY PICKED UP. A build agent
 *     decomposed it, wrote the tasks, and stopped. Everything needed to start exists.
 *
 * The second is the exact state the founder named: "the plan is done but the work has not yet
 * started". While both said `not_started`, nothing could tell them apart, so nothing could act on
 * the second — and an epic that had been fully planned was indistinguishable, to every reader in
 * the app, from one nobody had thought about yet. `services/epicSweepRunner` is the first consumer
 * that needs the distinction: it restarts an epic sitting in `planning` and must never spawn an
 * agent against an epic with nothing planned, because there is nothing there to build.
 *
 * `planning` is the founder's own name for the stage (his ladder is
 * Backlog > Blocked > Planning > Building > Done > Shipped > Archived), used verbatim so this state
 * has ONE name from the roll-up through to whatever renders it, rather than an internal word and a
 * display word that can drift apart.
 */
export type EpicStatus = "unplanned" | "planning" | "in_progress" | "done";

/**
 * Roll a set of child-bead statuses up into the epic's status:
 *  - no children                → unplanned  (a title; nothing has been decided)
 *  - every child still `open`   → planning   (the plan exists, nobody has started it)
 *  - every child `closed`       → done
 *  - anything in between (any in_progress, or a mix of open/closed) → in_progress
 *
 * ORDER IS LOAD-BEARING between the first two: an epic with no children vacuously satisfies
 * `every(open)`, so the empty case must be answered before it or `planning` would swallow it and
 * the sweeper would spawn agents against epics that hold no plan.
 */
// `readonly`, because the caller now passes a bucket straight out of the shared `EpicIndex` and
// that bucket must not be mutable at any point in the chain. This function only reads, so widening
// the parameter costs nothing and removes the need for a cast at the call site (roborev 65662).
export function rollupEpicStatus(childStatuses: readonly Bead["status"][]): EpicStatus {
  if (childStatuses.length === 0) return "unplanned";
  if (childStatuses.every((s) => s === "closed")) return "done";
  if (childStatuses.every((s) => s === "open")) return "planning";
  return "in_progress";
}

/** Epic status computed from the full bead list (resolves the epic's children first). */
export function epicStatus(beads: Bead[], epicId: string): EpicStatus {
  return rollupEpicStatus(childrenOf(beads, epicId).map((b) => b.status));
}

/** Names of the worker agents currently assigned to a given bead (for the Plan view's
 *  per-bead "who's building this" line). */
export function workersForBead(
  agents: Pick<AgentTab, "name" | "kind" | "beadId">[],
  beadId: string,
): string[] {
  return agents.filter((a) => a.kind === "worker" && a.beadId === beadId).map((a) => a.name);
}

/**
 * Names of every worker building ANY bead inside an epic — the epic's own bead and all its
 * children.
 *
 * WHY THIS EXISTS SEPARATELY FROM {@link workersForBead}. The founder, 2026-08-20, looking at an
 * epic card reading nine-of-nine: *"I don't see any build agents… it should be showing any build
 * agent that's working on any bead that is part of the card."* The card was asking
 * `workersForBead(agents, epic.id)`, which matches workers bound to the EPIC'S OWN bead id — and
 * almost nothing is ever bound there, because workers are dispatched against the CHILDREN. So the
 * field was correct code answering the wrong question, and it rendered empty on exactly the epics
 * with the most work in flight.
 *
 * MEMBERSHIP COMES FROM `childrenOf`, never from a parent-field equality test written out locally.
 * That edge has one owner (`services/beads.ts`) and `scripts/lib/epic-membership-guard.sh` fails CI
 * on a re-derivation — the dotted-id and reparented-bead forms are both the same edge and a
 * hand-rolled filter silently misses one of them.
 *
 * THE FORBIDDEN IDIOM IS DESCRIBED HERE RATHER THAN QUOTED, ON PURPOSE. The guard's pattern is
 * deliberately broad and does NOT skip comment lines, so writing the literal comparison out — even
 * inside a sentence telling you not to write it — reds the guard. It did, on this very branch. The
 * escape hatch (`// epic-guard-ok`) exists, but the guard's own header warns that sprinkling
 * opt-outs is how a broad pattern gets trained away, and narrowing the pattern to dodge a false
 * positive is what reopened the SIGPIPE hole. So the prose steps around the literal instead, the
 * same way `EpicsColumn.tsx` steps around the label-treatment ratchet's literal. Do not "restore"
 * the example.
 *
 * DEDUPED, because one worker can be bound to a bead that is reachable twice, and ORDER-STABLE on
 * the agents array so the line does not reshuffle between polls.
 */
export function workersInEpic(
  agents: Pick<AgentTab, "name" | "kind" | "beadId">[],
  beads: readonly Bead[],
  epicId: string,
): string[] {
  const ids = new Set<string>([epicId, ...childrenOf(beads, epicId).map((b) => b.id)]);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of agents) {
    if (a.kind !== "worker") continue;
    if (a.beadId === null || a.beadId === undefined || !ids.has(a.beadId)) continue;
    if (seen.has(a.name)) continue;
    seen.add(a.name);
    out.push(a.name);
  }
  return out;
}

// ── ONE RULE, INDEXED ONCE ─────────────────────────────────────────────────────────────────────
//
// ══ WHY AN INDEX EXISTS AT ALL ═════════════════════════════════════════════════════════════════
// Every helper below used to answer its question with a linear `beads.find(...)`, which is correct
// and was cheap when the backlog was small. It is not small: the founder's store holds ~7,400 beads
// and he runs ~60 agents, and `components/AgentRow` called `epicForBuild` + `epicPillFor` +
// `beadLabel` ONCE PER ROW on every beads-store notification. That is 60 full-store scans per poll,
// and `epicPillFor` additionally allocated a fresh 4-way concatenation of the whole board PER ROW —
// ~6,600 elements × 60 rows of pure garbage, every time the store moved. `stores/beadsStore.ts`
// documents the same hazard from the store's end; this is the other half of that fix.
//
// ══ WHY THE INDEX IS THE IMPLEMENTATION AND THE OLD SIGNATURES ARE WRAPPERS ═════════════════════
// The `*Indexed` functions below are now the ONLY place each rule is written; `epicForBuild`,
// `epicPillFor` and `beadLabel` keep their old signatures and delegate, building a throwaway index
// for their one query. That is deliberately NOT a second copy of the rule: a caller with one
// question pays O(beads) exactly as it did before, a caller with N questions (the sidebar) pays
// O(beads) once, and neither can drift from the other because there is one body.
//
// The precedent for caring about this is `scripts/lib/epic-membership-guard.sh`: this codebase
// shipped three incompatible definitions of epic membership because each local copy was locally
// reasonable. A hand-rolled `Map<id, bead>` in the sidebar would have been the fourth.

/**
 * O(1) lookups over ONE bead snapshot plus ONE agent list.
 *
 * `beadById` keeps the FIRST bead for a duplicated id, because that is what the `beads.find(...)`
 * it replaces returned. Ids are unique in practice; preserving the tie-break keeps this a pure
 * refactor rather than a behaviour change nobody would notice until it mattered.
 */
export interface PlanViewIndex {
  beadById: Map<string, Pick<Bead, "id" | "title" | "parent">>;
  /** Worker agents grouped by the orchestrator they belong to, in their original list order —
   *  `workerDerivedEpicIdIndexed` takes the FIRST bound worker, so order is load-bearing. */
  workersByParent: Map<string, Pick<AgentTab, "kind" | "parentId" | "beadId">[]>;
}

function indexAgents(
  agents: readonly Pick<AgentTab, "kind" | "parentId" | "beadId">[],
): Map<string, Pick<AgentTab, "kind" | "parentId" | "beadId">[]> {
  const workersByParent = new Map<string, Pick<AgentTab, "kind" | "parentId" | "beadId">[]>();
  for (const a of agents) {
    if (a.kind !== "worker" || !a.parentId) continue;
    const bucket = workersByParent.get(a.parentId);
    if (bucket) bucket.push(a);
    else workersByParent.set(a.parentId, [a]);
  }
  return workersByParent;
}

/** Index a raw bead list (the store's `beads`) plus the agent list. */
export function buildPlanViewIndex(
  beads: readonly Pick<Bead, "id" | "title" | "parent">[],
  agents: readonly Pick<AgentTab, "kind" | "parentId" | "beadId">[],
): PlanViewIndex {
  const beadById = new Map<string, Pick<Bead, "id" | "title" | "parent">>();
  for (const b of beads) if (!beadById.has(b.id)) beadById.set(b.id, b);
  return { beadById, workersByParent: indexAgents(agents) };
}

/**
 * Index a BOARD, walking its columns in place.
 *
 * COLUMN SET AND ORDER ARE LOAD-BEARING, and both are inherited rather than chosen: `epicPillFor`
 * read `[...backlog, ...inProgress, ...done, ...delivered]`, so `blocked` and `archived` are
 * deliberately absent and backlog wins a tie. Walking the columns instead of spreading them is the
 * whole allocation saving — same reads, no ~6,600-element temporary.
 */
export function buildBoardPlanViewIndex(
  board: Board | null,
  agents: readonly Pick<AgentTab, "kind" | "parentId" | "beadId">[],
): PlanViewIndex {
  const beadById = new Map<string, Pick<Bead, "id" | "title" | "parent">>();
  if (board) {
    for (const column of [board.backlog, board.inProgress, board.done, board.delivered]) {
      for (const b of column) if (!beadById.has(b.id)) beadById.set(b.id, b);
    }
  }
  return { beadById, workersByParent: indexAgents(agents) };
}

/** The id of the epic a build agent's workers are on — the first worker bound to a bead with a
 *  parent wins (they all share one parent epic). Null when no worker is bound yet. */
function workerDerivedEpicIdIndexed(index: PlanViewIndex, buildAgentId: string): string | null {
  for (const a of index.workersByParent.get(buildAgentId) ?? []) {
    if (!a.beadId) continue;
    const epicId = index.beadById.get(a.beadId)?.parent;
    if (epicId) return epicId;
  }
  return null;
}

/** {@link epicForBuild} against a prebuilt index. */
export function epicForBuildIndexed(index: PlanViewIndex, buildAgentId: string): string | null {
  const epicId = workerDerivedEpicIdIndexed(index, buildAgentId);
  if (!epicId) return null;
  const epic = index.beadById.get(epicId);
  return epic ? `${epic.id} · ${epic.title}` : epicId;
}

/** {@link epicPillFor} against a prebuilt BOARD index (see {@link buildBoardPlanViewIndex}). */
export function epicPillForIndexed(
  index: PlanViewIndex,
  agent: Pick<AgentTab, "id" | "kind" | "epicId">,
): { id: string; title: string } | null {
  const epicId = agent.epicId ?? workerDerivedEpicIdIndexed(index, agent.id);
  if (!epicId) return null;
  const epic = index.beadById.get(epicId);
  return { id: epicId, title: epic?.title ?? epicId };
}

/** {@link beadLabel} against a prebuilt index. */
export function beadLabelIndexed(
  index: PlanViewIndex,
  beadId: string | null | undefined,
): string | null {
  if (!beadId) return null;
  const b = index.beadById.get(beadId);
  return b ? `${b.id} · ${b.title}` : beadId;
}

/** The epic a build (orchestrator) agent is working, derived from its workers' beads — they all
 *  share one parent epic. Returns an "id · title" label for the Build-tab orchestrator hover, or
 *  null when none of its workers are bound to a bead yet.
 *
 *  Asking about MANY agents? Build the index once and call {@link epicForBuildIndexed} — this
 *  wrapper reindexes the whole store per call by design. */
export function epicForBuild(
  beads: Pick<Bead, "id" | "title" | "parent">[],
  agents: Pick<AgentTab, "kind" | "parentId" | "beadId">[],
  buildAgentId: string,
): string | null {
  return epicForBuildIndexed(buildPlanViewIndex(beads, agents), buildAgentId);
}

/** The epic pill shown on an orchestrator's sidebar row (spec §8). Prefers the agent's own
 *  `epicId` — set at sendToBuild handoff, so the pill shows immediately, before any worker binds
 *  to a bead and even before the first board poll (the bare id stands in for the title until the
 *  epic appears on the board). Falls back to the worker-derived epic, else null (no pill).
 *
 *  Asking about MANY agents? Use {@link buildBoardPlanViewIndex} + {@link epicPillForIndexed} —
 *  this wrapper walks the whole board per call by design. */
export function epicPillFor(
  agent: Pick<AgentTab, "id" | "kind" | "epicId">,
  board: Board | null,
  agents: Pick<AgentTab, "kind" | "parentId" | "beadId">[],
): { id: string; title: string } | null {
  return epicPillForIndexed(buildBoardPlanViewIndex(board, agents), agent);
}

/** One child row of an epic's live status view (spec §7): the child bead + the names of the
 *  workers currently on it. */
export interface EpicChildView {
  bead: Bead;
  workers: string[];
}

/** The epic's child beads, each paired with the workers currently on it — the Plan-side mirror of
 *  the sidebar's per-bead worker rows (spec §7 live epic detail). Pure; the live per-child build
 *  stage is layered on by the view (it needs the runtime store). */
export function epicChildViews(
  beads: Bead[],
  agents: Pick<AgentTab, "name" | "kind" | "beadId">[],
  epicId: string,
): EpicChildView[] {
  return childrenOf(beads, epicId).map((b) => ({ bead: b, workers: workersForBead(agents, b.id) }));
}

/** The name of the Build orchestrator bound to an epic, for the epic's live status view (spec §7,
 *  the §8 linkage in reverse). Prefers a build agent whose `epicId` matches (set at sendToBuild
 *  handoff, so it resolves before any worker binds to a bead), else the build agent whose workers
 *  are on this epic's children (`epicForBuild` reverse path). Null when no orchestrator is bound. */
export function orchestratorNameForEpic(
  beads: Pick<Bead, "id" | "parent">[],
  agents: Pick<AgentTab, "id" | "name" | "kind" | "epicId" | "parentId" | "beadId">[],
  epicId: string,
): string | null {
  const direct = agents.find((a) => a.kind === "build" && a.epicId === epicId);
  if (direct) return direct.name;
  // Indexed ONCE outside the `find`, not once per candidate: the reverse path asks the same
  // question of every build agent, and rebuilding the bead map inside the predicate is how the
  // sidebar's O(agents × beads) got there in the first place.
  const index = buildPlanViewIndex(
    beads as Pick<Bead, "id" | "title" | "parent">[],
    agents,
  );
  const derived = agents.find(
    (a) => a.kind === "build" && workerDerivedEpicIdIndexed(index, a.id) === epicId,
  );
  return derived ? derived.name : null;
}

/** A short "id · title" label for the bead a worker is on (for the Build-tab worker hover).
 *  Returns null when the worker isn't bound to a bead, and falls back to the bare id if the
 *  bead isn't in the current snapshot. */
export function beadLabel(beads: Pick<Bead, "id" | "title">[], beadId: string | null | undefined): string | null {
  return beadLabelIndexed(
    buildPlanViewIndex(beads as Pick<Bead, "id" | "title" | "parent">[], []),
    beadId,
  );
}
