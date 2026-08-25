// EPIC SIZE GUIDANCE — bead `sparkle-o05vcs.4`.
//
// WHAT THESE TESTS ARE CAREFUL NOT TO BE. "The constant equals 8" is the vacuous shape here: it
// asserts a declaration and would pass against a build where nothing ever consults it. Every test
// below drives the real entry points and asserts the OUTPUT — which band came back, whether a split
// was suggested, and whether a sentence was actually produced.
//
// AND THE ONE THAT CARRIES THE FOUNDER DECISION: the guidance is a SUGGESTION. `shouldSuggestSplit`
// pins a boolean whose only sanctioned use is "show this"; the create path's own test
// (services/conciergeTools/board.epicSizeGuidance.test.ts) proves the item is still filed.
import { describe, it, expect } from "vitest";
import {
  assessEpicSize,
  assessEpicForNewChild,
  EPIC_SIZE_MIN,
  EPIC_SIZE_MAX,
  EPIC_SIZE_FLEX_MAX,
} from "./epicSizeGuidance";

describe("the band, pinned at every boundary", () => {
  // THE BAND ITSELF, in the founder's numbers. Written as an explicit table rather than derived
  // from the constants, so a change to a constant makes this go RED and someone has to agree to it
  // — a table computed from the thing under test can never disagree with it.
  it.each([
    [0, "small"],
    [1, "small"],
    [2, "small"],
    [3, "healthy"],
    [7, "healthy"],
    [8, "healthy"],
    [9, "flexing"],
    [12, "flexing"],
    [13, "oversized"],
    [40, "oversized"],
  ])("an epic holding %i children is %s", (count, band) => {
    expect(assessEpicSize(count).band).toBe(band);
  });

  it("keeps the constants at the values the decision named", () => {
    expect([EPIC_SIZE_MIN, EPIC_SIZE_MAX, EPIC_SIZE_FLEX_MAX]).toEqual([3, 8, 12]);
  });
});

describe("under the threshold, the guidance is silent", () => {
  // The acceptance criterion's first case. Silence must be REAL silence: no message to render and
  // nothing to suggest, so a caller that concatenates blindly emits nothing.
  it.each([0, 2, 3, 7, 8])("says nothing about an epic of %i", (count) => {
    const a = assessEpicSize(count);
    expect(a.shouldSuggestSplit).toBe(false);
    expect(a.message).toBe("");
  });

  // Filing a child into a SMALL epic moves it toward the band — advising against the thing the user
  // is already doing would be the guidance working backwards.
  it("never nags on the way up: filing into a 1-child epic is silent", () => {
    const a = assessEpicForNewChild(1);
    expect(a.band).toBe("small");
    expect(a.shouldSuggestSplit).toBe(false);
    expect(a.message).toBe("");
  });
});

describe("over the threshold, a split is actually suggested", () => {
  // The acceptance criterion's second case, asserted on the PRODUCED SENTENCE and not on the flag
  // alone: a true flag with an empty message renders as nothing at all, which is the failure this
  // whole bead is about.
  it("produces a real split suggestion inside the flex allowance", () => {
    const a = assessEpicSize(EPIC_SIZE_FLEX_MAX);
    expect(a.band).toBe("flexing");
    expect(a.shouldSuggestSplit).toBe(true);
    expect(a.message).toMatch(/splitting/i);
    expect(a.message).toContain("12 children");
  });

  it("sharpens past the flex allowance without ever becoming a refusal", () => {
    const a = assessEpicSize(EPIC_SIZE_FLEX_MAX + 1);
    expect(a.band).toBe("oversized");
    expect(a.shouldSuggestSplit).toBe(true);
    expect(a.message).toMatch(/split/i);
    // The founder's rationale, carried in the copy: the epic stops closing and the fraction stops
    // meaning anything. This is the sentence, not a paraphrase a caller has to invent.
    expect(a.message).toMatch(/progress fraction/i);
  });

  // NOT A GATE. Every message the module can emit says so in words — a caller pasting it in front
  // of a human must never read as a rejection, and a message that dropped this clause would be a
  // regression nothing else here would catch.
  it.each([9, 12, 13, 40])("still frames %i children as a suggestion, never a refusal", (count) => {
    const a = assessEpicSize(count);
    expect(a.message).toMatch(/suggestion|not a blocker|either way/i);
    expect(a.message).not.toMatch(/refus|cannot file|can't file|blocked/i);
  });
});

describe("file time asks a different question from inspection time", () => {
  // THE BOUNDARY THAT MATTERS, and the reason the two entry points exist. An epic AT the top of the
  // band is fine to look at; filing into it is the click that takes it out of band, and file time is
  // the only moment the advice can still change anything.
  it("is silent about an 8-child epic but warns about filing into it", () => {
    expect(assessEpicSize(EPIC_SIZE_MAX).shouldSuggestSplit).toBe(false);
    expect(assessEpicForNewChild(EPIC_SIZE_MAX).shouldSuggestSplit).toBe(true);
  });

  // The last silent file-time count, pinned from the other side so an off-by-one in either
  // direction is red.
  it("is silent about filing into a 7-child epic — that lands it exactly at the top of the band", () => {
    const a = assessEpicForNewChild(EPIC_SIZE_MAX - 1);
    expect(a.childCount).toBe(EPIC_SIZE_MAX);
    expect(a.band).toBe("healthy");
    expect(a.message).toBe("");
  });

  it("counts the child about to be added, and says so in the sentence", () => {
    expect(assessEpicForNewChild(8).childCount).toBe(9);
    expect(assessEpicForNewChild(8).message).toContain("9 children");
  });
});

describe("a junk count degrades instead of throwing", () => {
  // This is advisory output on a path that must not fail. An exception thrown from a child count
  // would take a whole create down to protect a sentence.
  it.each([-4, Number.NaN, Number.POSITIVE_INFINITY])("treats %s as zero children", (count) => {
    const a = assessEpicSize(count);
    expect(a.childCount).toBe(0);
    expect(a.band).toBe("small");
    expect(a.message).toBe("");
  });

  it("floors a fractional count rather than banding on it", () => {
    expect(assessEpicSize(8.9).band).toBe("healthy");
    expect(assessEpicSize(12.9).band).toBe("flexing");
  });
});
