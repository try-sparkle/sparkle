import { describe, expect, it } from "vitest";
import {
  MIN_RELAY_NEEDLE,
  carriesFounderWords,
  normalizeRelayText,
} from "./relayDerivation";

// THE TWO MEASURED INCIDENTS FROM bead `sparkle-p9s5q`, verbatim. They are first because they are
// the only cases that are not a designer's guess about what a relay looks like — they are what the
// founder actually typed and what the concierge actually sent in the same turn.
describe("the reported bug", () => {
  it("the memory question was NOT carried by either brief the concierge composed", () => {
    const founder = "You should have better memory now. can you tell me if that's true?";
    // Both sends really happened in that turn, to two different agents, and BOTH were stamped onto
    // his bubble as though he had forwarded this question to them.
    expect(
      carriesFounderWords(founder, "STOP — you are 42 commits ahead of origin/main"),
    ).toBe(false);
    expect(carriesFounderWords(founder, "commit your untracked files")).toBe(false);
  });

  it("the v0.107.0 message was NOT carried by a brief to an agent he never named", () => {
    expect(
      carriesFounderWords(
        "I just updated to v0.107.0. make sure all agents are productive",
        "Your branch is 12 commits ahead of origin/main. Push and open a PR before you do anything else.",
      ),
    ).toBe(false);
  });
});

describe("a genuine relay is still recognised", () => {
  it("accepts an exact carry", () => {
    expect(carriesFounderWords("ship the retry fix", "ship the retry fix")).toBe(true);
  });

  it("accepts his words inside the concierge's own framing", () => {
    expect(
      carriesFounderWords(
        "ship the retry fix",
        "The founder says: ship the retry fix. Please pick that up now.",
      ),
    ).toBe(true);
  });

  it("accepts a re-wrapped quote — newlines and runs collapse to single spaces", () => {
    expect(
      carriesFounderWords(
        "please rebase onto main\nand   re-run the suite",
        "Passing this along:\n\n> please rebase onto main and re-run the suite\n\nthanks.",
      ),
    ).toBe(true);
  });

  it("accepts a re-capitalised quote", () => {
    expect(
      carriesFounderWords("drain the roborev findings first", "Drain the roborev findings first."),
    ).toBe(true);
  });

  it("survives the composer's smart apostrophe being re-emitted as ASCII", () => {
    // U+2019 in, U+0027 out. Same word; a relay that failed here would be an invisible false
    // negative nobody could debug from the screen.
    expect(
      carriesFounderWords("don’t merge that until checks pass", "don't merge that until checks pass"),
    ).toBe(true);
  });

  it("tolerates punctuation drift at the ENDS of his sentence", () => {
    // He ends with "?"; the concierge's framing drops it. The interior is untouched.
    expect(
      carriesFounderWords(
        "can you rebase this branch onto main?",
        "He asked: can you rebase this branch onto main. Do that first.",
      ),
    ).toBe(true);
  });
});

describe("fail-closed — an unprovable case answers NO", () => {
  it("refuses a paraphrase, however close", () => {
    expect(carriesFounderWords("ship the retry fix", "please ship that retry change now")).toBe(
      false,
    );
  });

  it("refuses on shared vocabulary alone", () => {
    // The exact false positive a similarity score would produce. Both mention retry work.
    expect(carriesFounderWords("ship the retry fix", "the retry work is blocked, stop")).toBe(
      false,
    );
  });

  it("refuses a missing or empty founder text", () => {
    expect(carriesFounderWords(undefined, "anything at all")).toBe(false);
    expect(carriesFounderWords(null, "anything at all")).toBe(false);
    expect(carriesFounderWords("   ", "anything at all")).toBe(false);
    // Punctuation-only strips to nothing, and nothing is not evidence of a relay.
    expect(carriesFounderWords("...", "well ... that is that")).toBe(false);
  });

  it("refuses a missing or empty sent text", () => {
    expect(carriesFounderWords("ship the retry fix now", undefined)).toBe(false);
    expect(carriesFounderWords("ship the retry fix now", "")).toBe(false);
  });

  it("refuses a non-string on either side, whatever a wire hands it", () => {
    expect(carriesFounderWords(42 as unknown as string, "42")).toBe(false);
    expect(carriesFounderWords("ship the retry fix now", 42 as unknown as string)).toBe(false);
  });
});

describe("the short-message floor", () => {
  it("takes NO door for a short message — not even an exact match (roborev 64197)", () => {
    // The exact door used to be open at any length, on the reasoning that "equality cannot happen by
    // accident". One-word imperatives are the highest-coincidence case, not an exempt one: the
    // founder types `continue` in the concierge thread while the concierge independently nudges a
    // stuck agent with `continue`. Byte-identical, and nothing to do with each other.
    //
    // It broke in BOTH directions at once: the nudge was REFUSED with a lecture about forwarding his
    // private words, AND his bubble got a card claiming a message he never sent had left the room.
    expect(carriesFounderWords("continue", "continue")).toBe(false);
    expect(carriesFounderWords("go", "go")).toBe(false);
    expect(carriesFounderWords("ok", "ok")).toBe(false);
    expect(carriesFounderWords("ship it", "ship it")).toBe(false);
    // The containment side of the same coincidence.
    expect(carriesFounderWords("go", "go ahead and rebase onto origin/main")).toBe(false);
    expect(carriesFounderWords("do it", "do it in a fresh worktree, then push")).toBe(false);
  });

  it("still recognises a real relay just above the floor — the floor is not a blanket refusal", () => {
    // The positive control. Without it the row above passes against a predicate that always says no.
    expect(carriesFounderWords("ship the retry fix", "ship the retry fix")).toBe(true);
  });

  it("keeps the floor at a length real relays clear", () => {
    // "ship the retry fix" is the worked example from the founder's own interview answer.
    expect("ship the retry fix".length).toBeGreaterThanOrEqual(MIN_RELAY_NEEDLE);
  });

  it("opens exactly at the floor, not before it — for both containment and equality", () => {
    // Pins the boundary in BOTH directions, so a floor that drifted either way goes red, and pins
    // that equality takes the same floor rather than slipping under it again.
    const atFloor = "a".repeat(MIN_RELAY_NEEDLE);
    const belowFloor = "a".repeat(MIN_RELAY_NEEDLE - 1);
    expect(carriesFounderWords(atFloor, `x ${atFloor} y`)).toBe(true);
    expect(carriesFounderWords(belowFloor, `x ${belowFloor} y`)).toBe(false);
    expect(carriesFounderWords(atFloor, atFloor)).toBe(true);
    expect(carriesFounderWords(belowFloor, belowFloor)).toBe(false);
  });
});

describe("normalizeRelayText", () => {
  it("folds case, whitespace runs and smart punctuation — and nothing else", () => {
    expect(normalizeRelayText("  Ship\tThe   Retry\nFix  ")).toBe("ship the retry fix");
    expect(normalizeRelayText("‘a’ “b” — c")).toBe("'a' \"b\" - c");
  });

  it("does NOT strip interior punctuation — that would let a paraphrase pass as a quote", () => {
    expect(normalizeRelayText("ship it, then push.")).toBe("ship it, then push.");
  });

  it("collapses runs rather than stripping them, so word boundaries survive", () => {
    // If whitespace were STRIPPED, "ship it" would match inside "shipit" and the predicate would
    // start accepting text that merely shares letters.
    expect(carriesFounderWords("ship it now please", "shipitnowplease")).toBe(false);
  });
});
