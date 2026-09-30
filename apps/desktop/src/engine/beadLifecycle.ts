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

/** One bead bound to an agent that is being torn down. */
export interface TeardownBead {
  beadId: string;
  /** The bound agent's derived stage — the same reading `beadLifecycleActions` closes on. */
  stage: WorkflowStageId;
  /** App telemetry (`sparkle-auto`), not a finding anybody filed. Undefined when unreadable. */
  telemetry: boolean | undefined;
  /**
   * The bead's status from a FRESH read taken at teardown, or undefined when that read failed.
   * Never the cached board: machine closes happen for projects nobody is viewing, whose snapshot is
   * absent or stale, and a stale `in_progress` would reopen a bead closed since the last poll
   * (roborev 83232).
   */
  status: string | undefined;
}

/**
 * What a teardown may write to each bead it is leaving behind (bead sparkle-aoqzzo).
 *
 * CLOSE only what the agent's OWN work landed — the same `merged` threshold `beadLifecycleActions`
 * uses, so a teardown can never close a bead the live lifecycle would not have — plus app telemetry,
 * which stays closed as before so it cannot strand an epic's rollup (sparkle-f2tzxg).
 *
 * RELEASE (back to `open`) a finding bead that was claimed and did not land: the agent is going away,
 * so `in_progress` would be an orphan, and `closed` would be a lie that reads exactly like a fix.
 *
 * LEAVE an unlanded bead that is already `open` or `closed` alone: releasing a closed bead REOPENS
 * it, and closing one is the defect.
 *
 * AN UNREADABLE, UNLANDED BEAD IS NOT WRITTEN AT ALL (roborev 83346, superseding 83232's fallback).
 * Closing it is the sparkle-aoqzzo defect itself — a close reads exactly like a fix — and releasing
 * it could reopen a bead closed since. A store that cannot answer a read in budget is also unlikely
 * to take the write, so leaving it for the next lifecycle pass costs little. A bead whose own agent
 * LANDED is still closed without a read: that evidence does not come from the store.
 *
 * Deliberately keyed per bead on its own agent — never on the epic, never on siblings.
 */
export function teardownBeadWrites(beads: readonly TeardownBead[]): { close: string[]; release: string[] } {
  const close: string[] = [];
  const release: string[] = [];
  for (const b of beads) {
    if (beadTargetLevel(b.stage) >= BEAD_LEVEL.closed || b.telemetry === true) {
      if (!close.includes(b.beadId)) close.push(b.beadId);
    } else if (b.status === "in_progress" && !release.includes(b.beadId)) {
      release.push(b.beadId);
    }
  }
  // A bead bound to two agents, one of which landed it, is closed — never also released.
  return { close, release: release.filter((id) => !close.includes(id)) };
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
