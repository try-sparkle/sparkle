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
  mergePrButton,
  openPrButton,
  pushToOriginMainButton,
} from "../services/suggestions/controlButtons";

/**
 * How work is expected to reach the integration branch.
 *
 * - `pr_first` — a pull request IS the gate. Committed work is proposed as a PR and merged by the
 *   user. The default, mirroring `[workflow] require_pr` (which defaults true in config.rs).
 * - `direct` — work is landed straight onto the integration branch, no PR required.
 *
 * This used to be prose in a comment here ("this repo lands directly and a PR isn't a gate") rather
 * than a value, which is precisely why open PRs accumulated: the primary action routed around them,
 * while `require_pr` sat in the config defaulting to true with nothing reading it. Making the policy
 * a parameter is what lets the setting actually govern behavior — and keeps both flows tested.
 */
export type DeliveryPolicy = "pr_first" | "direct";

/** The workflow signals the CTA actually reads. Narrower than `WorkflowState` on purpose: a full
 *  WorkflowState still satisfies it structurally, while a caller that subscribes to just these
 *  fields (rather than the whole object, which the poll rebuilds every tick) can keep a stable
 *  identity — see useSuggestions, where the object's churn used to abort in-flight paid computes.
 *  `prState`/`prNumber` joined `hasRemote` when the PR became a gate under `pr_first`. */
export type CtaSignals = Pick<WorkflowState, "hasRemote" | "prState" | "prNumber">;

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
export interface CtaOpts {
  /** Whether the agent is blocked awaiting an ANSWER from the user — a prose question or a terminal
   *  widget (see services/suggestions/pendingQuestion.ts). When true the stage action steps aside. */
  questionPending?: boolean;
  /** How work reaches the integration branch. Defaults to `pr_first`, mirroring `[workflow]
   *  require_pr`'s own default so the engine's default and the config's default agree. Callers
   *  resolve the effective value from config (global, overridable per repo). */
  policy?: DeliveryPolicy;
}

export function deriveCta(
  stage: WorkflowStageId,
  ws: CtaSignals | null | undefined,
  computed: SuggestionButton[],
  opts: CtaOpts = {},
): Cta | null {
  const stageAction = primaryFor(stage, ws, opts.policy ?? "pr_first");
  if (!stageAction) return null;

  // The agent asked the user something. The stage describes the BRANCH ("this work has landed");
  // the question describes the MOMENT ("do you want me to push?") — and it's the moment the user is
  // looking at. Leading with a stage action here answers a question nobody asked, which is exactly
  // what the founder hit: "Close Build Agent" over "Want me to commit, then merge main in?", and
  // "Land to Main" over "Want me to push?" on a branch that had already landed.
  //
  // Only when there IS an answer to lead with. With no computed set (learned actions off, offline,
  // or the model offered nothing) suppressing the stage action would empty the row and leave no way
  // to close the agent — so we fall through to the normal stage CTA.
  if (opts.questionPending && computed.length > 0) {
    const [answer, ...rest] = computed as [SuggestionButton, ...SuggestionButton[]];
    // Appended AFTER the cap, like the escape hatch below and for the same reason: a full set of
    // answers must never hide the stage action entirely.
    const demoted = answer.id === stageAction.id ? [] : [stageAction];
    // The escape hatch must survive this path too (roborev, Medium). At merged_local the stage
    // action is PUSH, so demoting it alone leaves no Close anywhere — and if the computed answers
    // don't happen to include one, the agent becomes impossible to close. That's the exact
    // invariant escapeHatchFor exists to protect, and the question path was quietly opting out.
    const taken = new Set([answer.id, ...demoted.map((b) => b.id)]);
    const escape = escapeHatchFor(stage, stageAction).filter((b) => !taken.has(b.id));
    return {
      primary: answer,
      alternates: [
        ...rest.filter((b) => b.id !== stageAction.id).slice(0, MAX_ALTERNATES),
        ...demoted,
        ...escape,
      ],
    };
  }

  const escape = escapeHatchFor(stage, stageAction);
  const alternates = [
    ...computed.filter((b) => b.id !== stageAction.id).slice(0, MAX_ALTERNATES),
    ...escape,
  ];
  return { primary: stageAction, alternates };
}

function primaryFor(
  stage: WorkflowStageId,
  ws: CtaSignals | null | undefined,
  policy: DeliveryPolicy,
): SuggestionButton | null {
  // Nothing committed yet — there's no work to land, so don't crowd out ordinary suggestions.
  if (stageIndex(stage) < stageIndex("building_saved")) return null;

  // Un-landed committed work, whether or not it's pushed or has a PR open.
  if (stageIndex(stage) < stageIndex("merged_local")) {
    // `pr_first` makes the PR the gate. It requires POSITIVE evidence of a remote for the same
    // reason the merged_local branch below does: `hasRemote` reads false both for a genuinely
    // remoteless repo AND for any non-probing fast poll, and those are indistinguishable here. A
    // policy that demanded a PR on absent evidence would strand a local-only agent at an action it
    // can never complete, so we fall back to landing directly — the policy expresses a preference,
    // never a trap.
    if (policy === "pr_first" && ws?.hasRemote === true) {
      // Only an OPEN PR is the live gate. A merged/closed one belongs to a finished cycle; treating
      // it as the gate would tell the agent to merge something already merged (the tracker resets
      // for a new cycle — see the tip-relative probe in worktree.rs).
      return ws.prState === "open" ? mergePrButton(ws.prNumber) : openPrButton();
    }
    return landToMainButton();
  }

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
