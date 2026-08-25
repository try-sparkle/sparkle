// EPIC SIZE GUIDANCE — the 3-8 band, the flex-up allowance, and the wording, in ONE place.
// Bead `sparkle-o05vcs.4` (child of `sparkle-o05vcs`).
//
// ══ THIS IS GUIDANCE, NEVER ENFORCEMENT ═══════════════════════════════════════════════════════
// The founder's decision, in his own words: "Three to eight sounds fine. I'm happy to also let it
// be flexible to flex up by some reasonable amount." The bead is explicit that a REFUSAL HERE
// WOULD BE A BUG, not a stricter reading — "Do not refuse; he explicitly wants flex". So nothing in
// this module returns an error, throws, or produces a value a caller is meant to gate on. It
// produces a SENTENCE. The item is always still filed.
//
// ══ WHY A BAND AT ALL ═════════════════════════════════════════════════════════════════════════
// The rationale offered and accepted: two children is a task wearing a costume, and twenty means
// the epic never closes and the progress fraction stops meaning anything (epic `huw924` sat at
// 8-of-9 for days). The real test is whether a human can hold the epic in their head and watch it
// finish inside a week — which is a judgement, not an arithmetic fact, which is exactly why the
// numbers below only ever produce a suggestion.
//
// ══ WHY ONE MODULE ════════════════════════════════════════════════════════════════════════════
// The threshold and the wording drift apart the moment they live in two files: a caller nudges the
// number, the message still says "eight", and the guidance starts contradicting itself in front of
// the human it is advising. Every caller imports the numbers AND the sentence from here.
//
// PURE. No store read, no model call, no I/O. It is consumed on the create path, in front of a
// human waiting for a bead to be filed (see `services/conciergeTools/epicCandidates.ts`, whose
// header makes the same promise about its scorer), so it must stay arithmetic.

/**
 * Smallest child count that makes an epic an epic rather than a task in a costume. Below this the
 * band is `small` — which is NOT a warning at file time: filing a child moves a small epic TOWARD
 * the band, so nagging about it would be advice against the thing the user is already doing.
 */
export const EPIC_SIZE_MIN = 3;

/** Top of the band the founder named: "three to eight sounds fine". */
export const EPIC_SIZE_MAX = 8;

/**
 * "Flex up by some reasonable amount", made numeric so it can be tested and so the wording cannot
 * quietly mean something different from the check.
 *
 * THE CHOICE, WRITTEN DOWN: half again as many as the top of the band — 8 + 4 = 12. Half again is
 * the smallest step that is unambiguously "some reasonable amount" rather than rounding error, and
 * 12 is still a count a human can hold in their head and burn down in a week, which is the test the
 * founder actually stated. Past 12 the epic is heading for the `huw924` failure (a fraction that
 * stops meaning anything), so the wording sharpens — but it still only ever suggests.
 */
export const EPIC_SIZE_FLEX_MAX = 12;

/**
 * Where a child count sits against the band. Four bands, not two, because "one over the band" and
 * "three times the band" deserve different sentences and a boolean cannot carry that.
 *
 * - `small`    — under {@link EPIC_SIZE_MIN}. A plan not yet decomposed; silent at file time.
 * - `healthy`  — inside 3..8. Silent.
 * - `flexing`  — 9..{@link EPIC_SIZE_FLEX_MAX}. Inside the founder's explicit flex allowance, so
 *                the sentence says the epic is still fine and merely offers the split.
 * - `oversized`— past the flex allowance. The sentence is plain about the cost. Still not a gate.
 */
export type EpicSizeBand = "small" | "healthy" | "flexing" | "oversized";

/** What one assessment says. `message` is `""` whenever there is nothing worth saying — callers
 *  render it verbatim and must not have to know which bands are silent. */
export interface EpicSizeAssessment {
  /** The count that was assessed. Echoed back so a caller composing a longer message does not have
   *  to remember whether it passed the current count or the projected one. */
  childCount: number;
  band: EpicSizeBand;
  /**
   * Whether to offer a split. TRUE IS NOT A REFUSAL — it means "show the suggestion and carry on".
   * No caller may branch on this to abort a create; see the header.
   */
  shouldSuggestSplit: boolean;
  /** One line of advice, or `""` for the silent bands. */
  message: string;
}

/**
 * Assess an epic that HAS this many children, right now.
 *
 * Use this to describe an epic as it stands. To ask the file-time question — "what would this epic
 * become if I filed here" — use {@link assessEpicForNewChild}, which is the same rule offset by the
 * child about to be added.
 *
 * A negative or non-integer count is floored at 0 rather than rejected: this is advisory output on
 * a path that must not fail, and an exception thrown from a count would take the whole create down
 * to protect a sentence.
 */
export function assessEpicSize(childCount: number): EpicSizeAssessment {
  const count = Number.isFinite(childCount) ? Math.max(0, Math.floor(childCount)) : 0;

  if (count < EPIC_SIZE_MIN) {
    return { childCount: count, band: "small", shouldSuggestSplit: false, message: "" };
  }
  if (count <= EPIC_SIZE_MAX) {
    return { childCount: count, band: "healthy", shouldSuggestSplit: false, message: "" };
  }
  if (count <= EPIC_SIZE_FLEX_MAX) {
    return {
      childCount: count,
      band: "flexing",
      shouldSuggestSplit: true,
      message:
        `Heads up: that epic would carry ${count} children, past the ${EPIC_SIZE_MIN}-${EPIC_SIZE_MAX} ` +
        "an epic reads best at. That is inside the flex we allow, so this is a suggestion and not a " +
        "blocker — but if two themes have crept in, splitting them into sibling epics keeps each " +
        "one finishable inside a week. Filing it either way.",
    };
  }
  return {
    childCount: count,
    band: "oversized",
    shouldSuggestSplit: true,
    message:
      `Heads up: that epic would carry ${count} children — well past the ${EPIC_SIZE_MIN}-${EPIC_SIZE_MAX} ` +
      `an epic reads best at, and past the ${EPIC_SIZE_FLEX_MAX} we flex to. An epic this size stops ` +
      "closing and its progress fraction stops meaning anything. Splitting it into sibling epics is " +
      "worth doing. This is still only a suggestion — filing it either way.",
  };
}

/**
 * The FILE-TIME question: this epic has `currentChildren` children, and one more is about to be
 * filed under it — what is it becoming?
 *
 * Offset by one deliberately, and this is the boundary the tests pin: an epic sitting at exactly
 * {@link EPIC_SIZE_MAX} is at the TOP of the band and perfectly fine to look at, but filing into it
 * is the click that takes it out of band, and file time is the only moment the advice can still
 * change the outcome. So `assessEpicForNewChild(8)` warns while `assessEpicSize(8)` does not; they
 * are answering different questions about the same epic.
 */
export function assessEpicForNewChild(currentChildren: number): EpicSizeAssessment {
  const current = Number.isFinite(currentChildren) ? Math.max(0, Math.floor(currentChildren)) : 0;
  return assessEpicSize(current + 1);
}
