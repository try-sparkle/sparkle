// Pure data helpers for the Plan/Build overview — the worker↔bead↔epic linkage views.
// No React, no stores: the Plan view and the Build-tab hovers call these to compute what to show.
// Kept pure so the linkage logic is unit-testable without a GUI.
import { childrenOf, type Bead } from "./beads";
import type { AgentTab } from "../types";
import { rollupStages, type WorkflowStageId } from "../engine/workflowStage";

/**
 * The unified 9-stage progress stage to show for a bead card. Prefers LIVE build progress (the
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

/** How an epic reads at a glance, rolled up from its child beads. */
export type EpicStatus = "not_started" | "in_progress" | "done";

/**
 * Roll a set of child-bead statuses up into the epic's status:
 *  - no children, or every child still `open`  → not_started
 *  - every child `closed`                      → done
 *  - anything in between (any in_progress, or a mix of open/closed) → in_progress
 */
export function rollupEpicStatus(childStatuses: Bead["status"][]): EpicStatus {
  if (childStatuses.length === 0) return "not_started";
  if (childStatuses.every((s) => s === "closed")) return "done";
  if (childStatuses.every((s) => s === "open")) return "not_started";
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

/** The epic a build (orchestrator) agent is working, derived from its workers' beads — they all
 *  share one parent epic. Returns an "id · title" label for the Build-tab orchestrator hover, or
 *  null when none of its workers are bound to a bead yet. */
export function epicForBuild(
  beads: Pick<Bead, "id" | "title" | "parent">[],
  agents: Pick<AgentTab, "kind" | "parentId" | "beadId">[],
  buildAgentId: string,
): string | null {
  for (const a of agents) {
    if (a.kind !== "worker" || a.parentId !== buildAgentId || !a.beadId) continue;
    const bead = beads.find((b) => b.id === a.beadId);
    const epicId = bead?.parent;
    if (epicId) {
      const epic = beads.find((b) => b.id === epicId);
      return epic ? `${epic.id} · ${epic.title}` : epicId;
    }
  }
  return null;
}

/** A short "id · title" label for the bead a worker is on (for the Build-tab worker hover).
 *  Returns null when the worker isn't bound to a bead, and falls back to the bare id if the
 *  bead isn't in the current snapshot. */
export function beadLabel(beads: Pick<Bead, "id" | "title">[], beadId: string | null | undefined): string | null {
  if (!beadId) return null;
  const b = beads.find((x) => x.id === beadId);
  return b ? `${b.id} · ${b.title}` : beadId;
}
