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
export function rollupEpicStatus(childStatuses: Bead["status"][]): EpicStatus {
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

/** The id of the epic a build agent's workers are on — the first worker bound to a bead with a
 *  parent wins (they all share one parent epic). Null when no worker is bound yet. */
function workerDerivedEpicId(
  beads: Pick<Bead, "id" | "parent">[],
  agents: Pick<AgentTab, "kind" | "parentId" | "beadId">[],
  buildAgentId: string,
): string | null {
  for (const a of agents) {
    if (a.kind !== "worker" || a.parentId !== buildAgentId || !a.beadId) continue;
    const epicId = beads.find((b) => b.id === a.beadId)?.parent;
    if (epicId) return epicId;
  }
  return null;
}

/** The epic a build (orchestrator) agent is working, derived from its workers' beads — they all
 *  share one parent epic. Returns an "id · title" label for the Build-tab orchestrator hover, or
 *  null when none of its workers are bound to a bead yet. */
export function epicForBuild(
  beads: Pick<Bead, "id" | "title" | "parent">[],
  agents: Pick<AgentTab, "kind" | "parentId" | "beadId">[],
  buildAgentId: string,
): string | null {
  const epicId = workerDerivedEpicId(beads, agents, buildAgentId);
  if (!epicId) return null;
  const epic = beads.find((b) => b.id === epicId);
  return epic ? `${epic.id} · ${epic.title}` : epicId;
}

/** The epic pill shown on an orchestrator's sidebar row (spec §8). Prefers the agent's own
 *  `epicId` — set at sendToBuild handoff, so the pill shows immediately, before any worker binds
 *  to a bead and even before the first board poll (the bare id stands in for the title until the
 *  epic appears on the board). Falls back to the worker-derived epic, else null (no pill). */
export function epicPillFor(
  agent: Pick<AgentTab, "id" | "kind" | "epicId">,
  board: Board | null,
  agents: Pick<AgentTab, "kind" | "parentId" | "beadId">[],
): { id: string; title: string } | null {
  const beads = board ? [...board.backlog, ...board.inProgress, ...board.done, ...board.delivered] : [];
  const epicId = agent.epicId ?? workerDerivedEpicId(beads, agents, agent.id);
  if (!epicId) return null;
  const epic = beads.find((b) => b.id === epicId);
  return { id: epicId, title: epic?.title ?? epicId };
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
  const derived = agents.find(
    (a) => a.kind === "build" && workerDerivedEpicId(beads, agents, a.id) === epicId,
  );
  return derived ? derived.name : null;
}

/** A short "id · title" label for the bead a worker is on (for the Build-tab worker hover).
 *  Returns null when the worker isn't bound to a bead, and falls back to the bare id if the
 *  bead isn't in the current snapshot. */
export function beadLabel(beads: Pick<Bead, "id" | "title">[], beadId: string | null | undefined): string | null {
  if (!beadId) return null;
  const b = beads.find((x) => x.id === beadId);
  return b ? `${b.id} · ${b.title}` : beadId;
}
