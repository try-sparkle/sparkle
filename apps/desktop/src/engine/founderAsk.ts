// founderAsk — WHAT does this red row actually want from the founder?
//
// THE FOUNDER'S ASK, verbatim: *"why it is showing as blocked"* — about agent 'Approve With Nothing
// To Approve', which was finished: goal met, six PRs merged, roborev closed, worktree clean. He
// opened it expecting a problem and found a completed job. His generalisation:
//
//   *"any row where the founder's action is a CONFIRMATION rather than an unblocking should name
//    the confirmation. A person should be able to tell 'press yes to finish this' from 'something
//    is wrong' without opening the pane."*
//
// ── THIS IS THE SECOND HALF OF THE RED-TIER WORK, NOT A SECOND TAXONOMY ─────────────────────────
// `engine/stallEscalation` answered WHICH rows may be red — only those where the founder is the
// only actor who can unblock. That made red rare and truthful, and it left the other half open: a
// truthful red still renders the same word for two situations that call for opposite reactions.
// "Needs you" on a finished agent awaiting a confirm is indistinguishable from "Needs you" on one
// wedged mid-task, so every red still costs a pane-open to classify. Naming the ask is what makes
// the colour actionable rather than merely correct.
//
// ── NO NEW STATUS. NO NEW COLOUR. NO NEW BAND. ──────────────────────────────────────────────────
// `components/rowAttention.ts:16-18` states the rule this file obeys: *"NO NEW STATUS. Everything
// here is a derived OVERLAY read ALONGSIDE `AgentTabStatus`, exactly as `rollupDot` sits beside
// `status`."* So this adds no `AgentTabStatus`, no `StatusBand`, no filter chip and no token. It
// changes only the WORDS a row uses for a status it already has, and it can never move a row into
// or out of the red tier — `askFor` is a pure function of a status the taxonomy already decided.
//
// ⚠️ IT ALSO DOES NOT TOUCH RETIREMENT-READINESS, and that is the one thing to get right here.
// `engine/retirementReadiness` spends its header explaining why the retirement pill stays OUT of
// the attention taxonomy: routing it through `bandOfStatus` would land every merged-but-unretired
// agent in `needs_you` — most of the list at any moment — which is the false "N agents need you"
// that `buildSections.ts` warns about and that the whole red-tier change exists to remove. So a
// retirement-ready row raises NO ask here at all: it keeps its informational pill and stays calm.
// See the note on {@link FounderAsk} for the arm that was tried, why it was dead, and why dropping
// it beat re-gating it.
import type { AgentTabStatus } from "../types";

/**
 * What the row wants, in the founder's terms rather than the state machine's.
 *
 * The union is deliberately about the ACTION he takes, not about the condition that produced it —
 * two conditions calling for the same action share an arm, and one condition that can call for
 * different actions gets two. That is what makes the labels honest as instructions.
 */
export type FounderAsk =
  /** A question or plan is on screen waiting for his answer. */
  | "answer"
  /** A permission/approval prompt is pending — he says yes or no to a specific action. */
  | "approve"
  /** Something is WRONG — crashed, wedged, or stalled with nobody coming. He has to go look. */
  | "unstick";

// ⚠️ THERE IS NO `confirm-retire` ARM, AND THAT IS A CORRECTION (roborev on 8148084b6).
//
// The first cut had one, gated `retirementReady && status === "unmerged"`. It was DEAD CODE: those
// two predicates are disjoint over the same stage value. `retirementPill` returns non-null only for
// `stageIndex(stage) >= stageIndex("merged")`, while the `unmerged` status is written solely by
// `unmergedAttention.calmStatusOf` behind `hasUnmergedCommittedWork`, which is
// `building_saved <= idx < merged`. No row can satisfy both, so the headline case never rendered.
//
// Its test did not catch that because it hand-built `{status: "unmerged", retirementReady: true}` —
// a pair production cannot produce — so it pinned the arm's WORDING while proving nothing about its
// reachability. That is the "guard tested against a copy of its own mechanism" trap, and the lesson
// is the general one: drive a decision from the same inputs the caller does, never from an
// independently-chosen pair.
//
// It was DROPPED rather than re-gated to a resting status, because the affordance it duplicated
// already exists and is better placed. `engine/retirementReadiness` renders "READY TO RETIRE" on
// exactly that population — as an INFORMATIONAL pill on a calm row, which is what the founder asked
// for originally ("an informational pill, kind of like the plan pill") and what keeps every
// merged-but-unretired agent out of his attention. Adding a second chip saying the same thing would
// have been the duplication, not the fix. This module's job is the gap that pill does not cover: a
// row that is genuinely RED and does not say what it wants.

// ⚠️ THERE IS NO `isConfirmation` PREDICATE EITHER, and dropping it is the same decision as
// dropping the arm (roborev on 6b68205d3). The first drain kept it, returning a constant `false`,
// on the reasoning that it recorded the founder's distinction for a future arm. That turned one
// piece of dead code into three: `askAction`'s `onClose()` branch became unreachable,
// `data-ask-confirmation` permanently `"false"`, and the calm-ink colour branch permanently
// unselected — and its test asserted `isConfirmation(a) === false` for every arm, which pins a
// constant rather than a decision and would pass whatever the module was meant to do. Exactly the
// shape the note above argues against.
//
// The `onClose()` branch was the dangerous part: it opens the RETIREMENT CONFIRM, and it hung off a
// pill whose reachable arms are `answer`/`approve`/`unstick`. Nothing could exercise it, so the day
// a future arm flipped the predicate true, Enter on an *errored* row would have opened the
// retirement confirm with no test in the way.
//
// The DISTINCTION is not lost — it is recorded here, in prose, which is where a rule with no live
// consumer belongs: *"a person should be able to tell 'press yes to finish this' from 'something is
// wrong'"*. Reintroduce the predicate WITH the arm that needs it, and give it its own action rather
// than letting it inherit one.

/** Everything the decision reads. A plain record rather than an `AgentTab`, matching
 *  `retirementReadiness.RetirementInput`, so this stays testable without building a whole agent and
 *  so the decision cannot quietly come to depend on a field nobody considered. */
export interface FounderAskInput {
  /** The row's EFFECTIVE status — after every overlay, i.e. what it actually renders. */
  status: AgentTabStatus;
}

/**
 * The ask for one row, or `null` when the row is asking nothing.
 *
 * `null` for every calm row, which is the overwhelming majority — a label that renders everywhere
 * is chrome, not signal, and the retirement pill's own precedent is that a chip with nothing to say
 * does not render at all.
 *
 * ── ORDER: A LIVE PROMPT OUTRANKS A DIAGNOSIS ──────────────────────────────────────────────────
 * `waiting`/`approval` are checked before `errored`/`blocked` because only the first two have
 * somebody actively waiting on him, and the agent cannot advance one step without the answer. The
 * statuses are mutually exclusive today, so the order is a statement of intent rather than a live
 * tie-break — but it is the intent a future overlapping signal must respect.
 */
export function askFor({ status }: FounderAskInput): FounderAsk | null {
  // A live prompt on screen outranks everything: it is the only arm where someone is actively
  // waiting on him and the agent cannot proceed one step without an answer.
  if (status === "waiting") return "answer";
  if (status === "approval") return "approve";
  // Something is wrong. `errored` is a crash; `blocked` is the stall escalation's red tier, whose
  // members are all "the agent is STUCK and only he can unblock it" — it said a person is blocking
  // it, the concierge has no re-arms left, or it gave up holding work nobody landed. Both arms are
  // "go look". (An agent merely awaiting his review-close is amber `lapsed`, not `blocked`: since
  // 2026-08-18 that is calm, because it is done rather than stuck.)
  if (status === "errored" || status === "blocked") return "unstick";
  // Everything else is calm and asks nothing. That includes a retirement-ready row: its
  // recommendation is carried by `retirementReadiness`'s informational pill, deliberately outside
  // the attention taxonomy. See the ⚠️ note on {@link FounderAsk}.
  return null;
}

/**
 * The words the row shows. Imperative and specific — an instruction, not a diagnosis.
 *
 * Each begins with the VERB he performs, because the founder's complaint was that he could not tell
 * what a row wanted without opening it, and the verb is the part that answers that. "Blocked" names
 * the agent's condition; "Answer a question" names his next thirty seconds.
 *
 * The `›` is carried in the label rather than added by the caller so every surface renders the same
 * string, and because it is what marks these as ACTIONABLE — the row's other chips are statements.
 */
export const FOUNDER_ASK_LABEL: Record<FounderAsk, string> = {
  answer: "Answer a question ›",
  approve: "Approve an action ›",
  // No `›`: this one is not a single press, and promising that it is would be the same overreach in
  // the other direction. It is the only arm that means "something is wrong".
  unstick: "Needs unsticking",
};

/**
 * The longer sentence, for a tooltip or an accessible name — what he is being asked and why.
 *
 * Each says what he is being asked and why, so the tooltip answers the question the label raised
 * without costing him a pane-open — which is the whole point of the feature.
 */
export const FOUNDER_ASK_DETAIL: Record<FounderAsk, string> = {
  answer:
    "This agent has put a question or a plan on screen and cannot go further until you answer it.",
  approve:
    "This agent is waiting on your approval for a specific action before it will run it.",
  unstick:
    "Something is wrong with this agent — it crashed, wedged, or stopped with work outstanding " +
    "that nothing else is coming to finish. This one needs you to go and look.",
};
