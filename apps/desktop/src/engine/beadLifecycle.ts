// Pure decision logic for the PROGRAMMATIC bead lifecycle. Given an agent's current workflow stage
// and the highest lifecycle level already written for it, decide which FORWARD-ONLY bead actions to
// take. Kept React/IO-free so the edge logic (auto-create gating, in_progress/closed/delivered
// precedence, monotonicity) is unit-tested without a `bd` backend — the async shell-outs live in
// runtimeStore.syncBeadLifecycle.
import { stageIndex, type WorkflowStageId } from "./workflowStage";

export type BeadAction = "create" | "in_progress" | "closed" | "delivered";

// Monotonic lifecycle levels: 0 none · 1 in_progress · 2 closed · 3 delivered. The app only ever
// advances a bead forward through these; it never reopens one (a re-climbing "new cycle" on an
// already-delivered bead must not re-close/re-deliver it — see the cycle-reset edge).
export const BEAD_LEVEL = { none: 0, in_progress: 1, closed: 2, delivered: 3 } as const;

/** The lifecycle level a workflow stage implies: building/pushed/PR ⇒ in_progress, merged ⇒ closed,
 *  shipped ⇒ delivered, anything earlier (planning) ⇒ none. */
export function beadTargetLevel(stage: WorkflowStageId): number {
  const idx = stageIndex(stage);
  if (idx >= stageIndex("shipped")) return BEAD_LEVEL.delivered;
  if (idx >= stageIndex("merged")) return BEAD_LEVEL.closed;
  if (idx >= stageIndex("building_unsaved")) return BEAD_LEVEL.in_progress;
  return BEAD_LEVEL.none;
}

export interface BeadLifecycleInputs {
  kind: string; // only "build" auto-creates; "worker" already carries a bead; think/shell never reach here
  hasBead: boolean;
  hasRealWork: boolean; // a commit or dirty tree exists — gates auto-create so an idle agent leaves none
  stage: WorkflowStageId; // the agent's current derived stage
  writtenLevel: number; // highest lifecycle level already applied for this agent (0 if none)
}

/** Forward-only bead actions for this tick. Empty when there's nothing to do (no stage signal, no
 *  bead and not an eligible auto-create, or the bead is already at/ahead of the target level). */
export function beadLifecycleActions(input: BeadLifecycleInputs): BeadAction[] {
  const target = beadTargetLevel(input.stage);
  if (target === BEAD_LEVEL.none) return [];

  const actions: BeadAction[] = [];
  if (!input.hasBead) {
    // Workers spawn already carrying a bead; think/shell are filtered upstream. Only a deliverable
    // build agent auto-creates, and only once real work exists.
    if (input.kind !== "build" || !input.hasRealWork) return [];
    actions.push("create");
  }
  // in_progress ONLY while work is still in-flight (target === in_progress). If a relaunch first
  // observes already-merged/shipped work, we must NOT write in_progress (it would reopen the bead) —
  // we jump straight to closed/delivered below.
  if (target === BEAD_LEVEL.in_progress && input.writtenLevel < BEAD_LEVEL.in_progress) {
    actions.push("in_progress");
  }
  // delivered subsumes closed (it closes + labels), so never emit both.
  if (target >= BEAD_LEVEL.delivered && input.writtenLevel < BEAD_LEVEL.delivered) {
    actions.push("delivered");
  } else if (target === BEAD_LEVEL.closed && input.writtenLevel < BEAD_LEVEL.closed) {
    actions.push("closed");
  }
  return actions;
}

/** The lifecycle level an action establishes once it succeeds (for advancing the watermark). `create`
 *  itself establishes nothing (the following status action does). */
export function levelAfter(action: BeadAction): number {
  switch (action) {
    case "in_progress":
      return BEAD_LEVEL.in_progress;
    case "closed":
      return BEAD_LEVEL.closed;
    case "delivered":
      return BEAD_LEVEL.delivered;
    default:
      return BEAD_LEVEL.none;
  }
}
