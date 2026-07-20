// The composer's call-to-action: which single action a build agent should be nudged toward RIGHT
// NOW, derived from its LIVE workflow stage. Kept free of React (like workflowStage.ts) so the
// whole decision is unit-tested without a component.
//
// Why this module exists: the CTA used to key off `workflowShipped`, a latch-once watermark that
// trips the first time work reaches main and clears only when the agent closes. An agent that
// landed once and then started a NEW cycle kept offering "Close Build Agent" over un-landed work.
// The live stage already knew better (deriveLiveStage has new-cycle detection) — the button just
// read the wrong variable. Everything here reads the live stage; nothing reads the watermark.
import type { WorkflowStageId } from "./workflowStage";
import { stageIndex } from "./workflowStage";
import type { WorkflowState } from "../services/branchStatus";
import type { SuggestionButton } from "../services/suggestions/types";
import {
  closeBuildAgentButton,
  landToMainButton,
  pushToOriginMainButton,
} from "../services/suggestions/controlButtons";

/** The only workflow signal the CTA actually reads. Narrower than `WorkflowState` on purpose: a full
 *  WorkflowState still satisfies it structurally, while a caller that subscribes to just this field
 *  (rather than the whole object, which the poll rebuilds every tick) can keep a stable identity —
 *  see useSuggestions, where the object's churn used to abort in-flight paid computes. */
export type CtaSignals = Pick<WorkflowState, "hasRemote">;

export interface Cta {
  /** The one action to lead with — the filled pill. */
  primary: SuggestionButton;
  /** Everything else, behind the caret: computed suggestions plus the stage's escape hatch. */
  alternates: SuggestionButton[];
}

/** Max computed alternates behind the caret, keeping the menu glanceable. This is a LOCAL invariant,
 *  not a restatement of an upstream one: the engine caps its set at MAX_BUTTONS=3 today, so this
 *  rarely binds — it's here so agentCta stays correct on its own terms if that cap ever moves. The
 *  escape hatch is appended AFTER this cap, so a full computed set can never hide the only way to
 *  close the agent. */
const MAX_ALTERNATES = 4;

/**
 * The CTA for a build agent at `stage`, or null when there's nothing to nudge (the caller then
 * falls through to ordinary suggestions).
 *
 * `computed` is the existing suggestion engine's output — it reads scrollback, so it's what
 * surfaces context-specific offers the agent itself made ("cut a DMG"). The primary is
 * stage-derived and deterministic; the alternates are dynamic. Pure: no store reads, no invokes.
 */
export function deriveCta(
  stage: WorkflowStageId,
  ws: CtaSignals | null | undefined,
  computed: SuggestionButton[],
): Cta | null {
  const primary = primaryFor(stage, ws);
  if (!primary) return null;

  const escape = escapeHatchFor(stage, primary);
  const alternates = [
    ...computed.filter((b) => b.id !== primary.id).slice(0, MAX_ALTERNATES),
    ...escape,
  ];
  return { primary, alternates };
}

function primaryFor(
  stage: WorkflowStageId,
  ws: CtaSignals | null | undefined,
): SuggestionButton | null {
  // Nothing committed yet — there's no work to land, so don't crowd out ordinary suggestions.
  if (stageIndex(stage) < stageIndex("building_saved")) return null;

  // Un-landed committed work, whether or not it's pushed or has a PR open. An open PR still gets
  // Land rather than "Merge PR": this repo lands directly (scripts/land.sh) and a PR isn't a gate.
  if (stageIndex(stage) < stageIndex("merged_local")) return landToMainButton();

  if (stage === "merged_local") {
    // On local main but not origin. Only ask for a push when we have POSITIVE evidence of a remote:
    // `hasRemote` is false both for a genuinely remoteless repo AND on any non-probing fast poll, so
    // absent evidence we fail safe to Close. Worst case a remote user sees Close for one poll and it
    // self-corrects; the alternative strands a remoteless user at Push with Close unreachable.
    return ws?.hasRemote === true ? pushToOriginMainButton() : closeBuildAgentButton();
  }

  // merged (origin has it) or shipped — the work is done.
  return closeBuildAgentButton();
}

/** The stage's always-available out. At merged_local the primary is Push, so Close must stay
 *  reachable for a user who doesn't want to push — otherwise the agent can't be closed at all. */
function escapeHatchFor(stage: WorkflowStageId, primary: SuggestionButton): SuggestionButton[] {
  if (stage !== "merged_local") return [];
  const close = closeBuildAgentButton();
  return close.id === primary.id ? [] : [close];
}
