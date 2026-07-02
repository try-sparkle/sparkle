// Evaluate one bead against a stage definition — the per-card criteria engine for Definable Done &
// Delivered. Each criterion resolves to met / unmet / unknown; a stage is `allMet` when every
// criterion is met. AUTO criteria REUSE the app's existing 9-stage workflow computation
// (engine/workflowStage.ts + services/planView.ts `beadStage`) rather than re-deriving any git
// logic; MANUAL criteria read from the persisted tick store (criteriaStore.ts).
// Spec: docs/superpowers/specs/2026-07-02-definable-done-delivered-design.md
import type { Bead } from "./beads";
import { DELIVERED_LABEL } from "./beads";
import type { WorkflowState } from "./branchStatus";
import { stageIndex, type WorkflowStageId } from "../engine/workflowStage";
import type { AutoSignal, StageCriterion, StageDefinition, StageKey } from "./stageDefs";
import { useCriteriaStore } from "./criteriaStore";

export type CriterionState = "met" | "unmet" | "unknown";

export interface EvaluatedCriterion {
  criterion: StageCriterion;
  state: CriterionState;
  /** True for `kind === "manual"` (a human tick), false for auto-observed criteria. */
  manual: boolean;
}

export interface StageEvaluation {
  key: StageKey;
  criteria: EvaluatedCriterion[];
  /** True iff EVERY criterion is `met` (an empty definition is vacuously allMet=false — see below). */
  allMet: boolean;
}

/**
 * Inputs an auto-signal evaluator needs, supplied by the caller from data the app already holds.
 * Nothing here re-computes git state: `stage` is the bead's rolled-up 9-stage stage (from
 * `planView.beadStage` / `workflowStage.deriveLiveStage`), `workflowState` is the live PR probe
 * (`agent_workflow_state`), and `inRelease` is Unit 3's delivery-monitor verdict (wired later —
 * when absent, `in_release` falls back to the legacy `delivered` label / shipped stage).
 */
export interface EvalContext {
  /** Which stage is being evaluated — also names the manual-tick namespace in criteriaStore. */
  key: StageKey;
  /** The bead's current 9-stage workflow stage. Drives `merged_to_main` and `pushed`; when absent
   *  those signals fall back to what the bead's own status can prove, else read `unknown`. */
  stage?: WorkflowStageId | null;
  /** Live PR/merge probe for the bead's branch. Drives `pr_merged`; absent → `unknown`. */
  workflowState?: WorkflowState | null;
  /** Unit 3's monitor: is the bead's merge commit contained in a shipped release? Drives
   *  `in_release` when provided; absent → fall back to the legacy `delivered` label / shipped stage. */
  inRelease?: boolean;
}

/** Has this bead's work reached/passed `merged`? A closed bead is merged-or-beyond; otherwise the
 *  9-stage stage decides. With no stage and an unclosed bead we can observe it is NOT merged. */
function reachedMerged(bead: Bead, ctx: EvalContext): boolean {
  if (bead.status === "closed") return true;
  if (ctx.stage) return stageIndex(ctx.stage) >= stageIndex("merged");
  return false;
}

/** Is the bead's work in a shipped release? Prefers Unit 3's monitor verdict; else falls back to
 *  the legacy `delivered` label or the bead having reached the `shipped` stage. */
function inRelease(bead: Bead, ctx: EvalContext): boolean {
  if (ctx.inRelease !== undefined) return ctx.inRelease;
  if (bead.labels.includes(DELIVERED_LABEL)) return true;
  if (ctx.stage) return stageIndex(ctx.stage) >= stageIndex("shipped");
  return false;
}

/** Evaluate a single AUTO signal against the reused workflow computation. Returns `unknown` when the
 *  input a signal depends on isn't available, so the UI can show "can't tell yet" honestly rather
 *  than a false negative. */
function evalAuto(signal: AutoSignal | undefined, bead: Bead, ctx: EvalContext): CriterionState {
  switch (signal) {
    case "merged_to_main":
      return reachedMerged(bead, ctx) ? "met" : "unmet";
    case "pushed": {
      if (bead.status === "closed") return "met"; // closed ⇒ was pushed on its way to merge
      if (!ctx.stage) return "unknown";
      return stageIndex(ctx.stage) >= stageIndex("pushed") ? "met" : "unmet";
    }
    case "pr_merged": {
      if (ctx.workflowState == null) return "unknown";
      return ctx.workflowState.prState === "merged" ? "met" : "unmet";
    }
    case "in_release":
      return inRelease(bead, ctx) ? "met" : "unmet";
    default:
      // An auto criterion with no (or an unrecognized) signal can't be observed.
      return "unknown";
  }
}

/**
 * Evaluate one bead against a stage definition. Auto criteria are observed via `evalAuto` (reusing
 * the 9-stage workflow computation); manual criteria read their tick from `criteriaStore`, keyed by
 * (bead.id, ctx.key, criterionIndex). `allMet` requires a non-empty criteria list where every
 * criterion is `met` (an `unknown` or `unmet` blocks it).
 */
export function evaluateStage(bead: Bead, def: StageDefinition, ctx: EvalContext): StageEvaluation {
  const store = useCriteriaStore.getState();
  const criteria: EvaluatedCriterion[] = def.criteria.map((criterion, index) => {
    if (criterion.kind === "manual") {
      const ticked = store.isChecked(bead.id, ctx.key, index);
      return { criterion, state: ticked ? "met" : "unmet", manual: true };
    }
    return { criterion, state: evalAuto(criterion.signal, bead, ctx), manual: false };
  });
  const allMet = criteria.length > 0 && criteria.every((c) => c.state === "met");
  return { key: ctx.key, criteria, allMet };
}
