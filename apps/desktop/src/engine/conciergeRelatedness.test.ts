import { describe, it, expect } from "vitest";
import {
  judgeRelatedness,
  isRelated,
  MAX_ABSORBED_RUN,
  MAX_RUN_CHARS,
  TOPIC_SHIFT_GAP_MS,
  MAX_SUPERSEDE_GAP_MS,
} from "./conciergeRelatedness";

/**
 * Every case asserts the VERDICT — the thing the turn queue acts on — never that a list contains a
 * word or that a helper was called.
 *
 * Two setup choices carry most of the power here, and both exist so a passing row cannot be passing
 * for the wrong reason:
 *
 *  - Continuation cases run with a HUGE gap (`FAR_PAST`). Without the continuation signal that gap
 *    alone would return `different`, so a row that stays `related` proves the signal did the work.
 *  - Topic-shift cases run with a SMALL gap and a CAPITALISED opening. Without the phrase they would
 *    fall through to the absorb default, so `different` can only have come from the phrase — and the
 *    capital keeps rule 1's lowercase-start clause from short-circuiting the rule under test.
 */
const FAR_PAST = 10 * TOPIC_SHIFT_GAP_MS;
const RECENT = 1_000;

/** A run whose last message is a closed sentence, so rule 1's mid-thought clause never fires. */
const CLOSED_RUN = ["Hold the deploy."] as const;

/** A run whose last message was cut off: 9 words, no terminal punctuation. */
const CUT_OFF_RUN = ["hold the deploy until the migration has finished running"] as const;

describe("continuation openers → related", () => {
  const CASES: Array<{ marker: string; next: string }> = [
    { marker: "and", next: "And the migration is stale." },
    { marker: "and then", next: "And then push the branch." },
    { marker: "also", next: "Also the runner is offline." },
    { marker: "plus", next: "Plus the DMG never notarised." },
    { marker: "oh", next: "Oh, the flag matters here." },
    { marker: "so", next: "So the whole suite is red." },
    { marker: "but", next: "But the runner came back." },
    { marker: "because", next: "Because the migration is stale." },
    { marker: "actually", next: "Actually the other branch is fine." },
    { marker: "i mean", next: "I mean the other branch." },
    { marker: "sorry", next: "Sorry, the other branch." },
    { marker: "no wait", next: "No wait, use the other branch." },
    { marker: "to be clear", next: "To be clear, the deploy is on hold." },
    { marker: "btw", next: "BTW the tests are green." },
    { marker: "basically", next: "Basically the runner is offline." },
    { marker: "or rather", next: "Or rather the other one." },
    { marker: "one more thing", next: "One more thing, the flag." },
  ];

  for (const { marker, next } of CASES) {
    it(`"${marker}" opens a continuation, even ${FAR_PAST}ms later`, () => {
      const verdict = judgeRelatedness(CLOSED_RUN, next, FAR_PAST);
      expect(verdict.verdict).toBe("related");
      expect(verdict.reason).not.toBe("");
    });
  }

  it("does NOT fire on a marker word buried mid-sentence", () => {
    // "and" is in the list, but this message opens with a capitalised, self-contained clause.
    expect(judgeRelatedness(CLOSED_RUN, "Ship the branch and the tag.", FAR_PAST).verdict).toBe("different");
  });

  it("does NOT fire on a longer word that merely starts with a marker", () => {
    // "so" must not match "Society"; the whole-word boundary is the rule being pinned.
    expect(judgeRelatedness(CLOSED_RUN, "Society pages are broken.", FAR_PAST).verdict).toBe("different");
  });
});

describe("explicit topic-shift phrases → different", () => {
  const CASES: Array<{ phrase: string; next: string }> = [
    { phrase: "separately", next: "Separately, what about the DMG?" },
    { phrase: "different topic", next: "Different topic: what about the DMG?" },
    { phrase: "unrelated", next: "Unrelated: is the DMG cut?" },
    { phrase: "changing subject", next: "Changing subject, what about the DMG?" },
    { phrase: "change of subject", next: "Change of subject: what about the DMG?" },
    { phrase: "new topic", next: "New topic: the DMG." },
    { phrase: "on another note", next: "On another note, the DMG." },
    { phrase: "switching gears", next: "Switching gears, the DMG." },
    { phrase: "totally different", next: "Totally different, what about the DMG?" },
    { phrase: "different question", next: "Different question: what about the DMG?" },
  ];

  for (const { phrase, next } of CASES) {
    it(`"${phrase}" announces a new topic, even ${RECENT}ms later`, () => {
      const verdict = judgeRelatedness(CLOSED_RUN, next, RECENT);
      expect(verdict.verdict).toBe("different");
      expect(verdict.reason).not.toBe("");
    });
  }

  it("does NOT fire on the same word used far into the message", () => {
    // A phrase announces a shift at the OPENING; deep inside it is just vocabulary.
    const next =
      "The runner claimed the release job at noon and the notarisation step is separately tracked.";
    expect(judgeRelatedness(CLOSED_RUN, next, RECENT).verdict).toBe("related");
  });
});

describe("leading bare pronoun", () => {
  it("a message OPENING with a pronoun is a continuation, even after a long gap", () => {
    // Capitalised on purpose: this must pass on the pronoun rule alone, not on lowercase-start.
    expect(judgeRelatedness(CLOSED_RUN, "It needs the flag too.", FAR_PAST).verdict).toBe("related");
  });

  it("also holds for the lowercase form the founder actually types", () => {
    expect(judgeRelatedness(CLOSED_RUN, "it needs the flag too", FAR_PAST).verdict).toBe("related");
  });

  it("a pronoun INSIDE the sentence is not a continuation — its antecedent is right there", () => {
    expect(judgeRelatedness(CLOSED_RUN, "Deploy it now.", FAR_PAST).verdict).toBe("different");
  });

  for (const pronoun of ["That", "This", "Those", "These", "They", "Them"]) {
    it(`"${pronoun}" opening a message points back into the run`, () => {
      expect(judgeRelatedness(CLOSED_RUN, `${pronoun} broke the build.`, FAR_PAST).verdict).toBe("related");
    });
  }
});

describe("lowercase start", () => {
  it("a lowercase opening reads as a dictation continuation, even after a long gap", () => {
    expect(judgeRelatedness(CLOSED_RUN, "needs the flag too", FAR_PAST).verdict).toBe("related");
  });

  it("a capitalised self-contained sentence after a long gap is a new topic", () => {
    expect(judgeRelatedness(CLOSED_RUN, "The runner is offline.", FAR_PAST).verdict).toBe("different");
  });
});

describe("the run's last message was cut off mid-thought", () => {
  const NEXT = "The runner is offline.";

  it("absorbs whatever follows, EVEN with a gap far past the topic-shift threshold", () => {
    // Rule 1 short-circuits rule 3. This pairing is the one most likely to regress.
    expect(judgeRelatedness(CUT_OFF_RUN, NEXT, FAR_PAST).verdict).toBe("related");
  });

  it("and the SAME message after a CLOSED run at the SAME gap is different", () => {
    // The paired half: proves the verdict above came from the run being cut off, not from the next
    // message or the gap, both of which are held constant here.
    expect(judgeRelatedness(CLOSED_RUN, NEXT, FAR_PAST).verdict).toBe("different");
  });

  it("a SHORT unpunctuated last message does not count as cut off", () => {
    // `endsMidThought` needs length as well as missing punctuation — "ship it" is a whole thought.
    expect(judgeRelatedness(["ship it"], NEXT, FAR_PAST).verdict).toBe("different");
  });
});

describe("the topic-shift gap boundary", () => {
  const NEXT = "The runner is offline.";

  it(`is related at exactly ${TOPIC_SHIFT_GAP_MS}ms (the threshold is exclusive)`, () => {
    expect(judgeRelatedness(CLOSED_RUN, NEXT, TOPIC_SHIFT_GAP_MS).verdict).toBe("related");
  });

  it("is related just under the threshold", () => {
    expect(judgeRelatedness(CLOSED_RUN, NEXT, TOPIC_SHIFT_GAP_MS - 1).verdict).toBe("related");
  });

  it("is different just over the threshold", () => {
    expect(judgeRelatedness(CLOSED_RUN, NEXT, TOPIC_SHIFT_GAP_MS + 1).verdict).toBe("different");
  });
});

describe("rule 1 beats rule 2 — precedence is pinned, not incidental", () => {
  it('"and separately, ..." is related, because the continuation opener wins', () => {
    const verdict = judgeRelatedness(CLOSED_RUN, "and separately, can you check the runner?", RECENT);
    expect(verdict.verdict).toBe("related");
    expect(verdict.reason).toContain("continuation opener");
  });

  it("capitalised, so only the opener (not lowercase-start) can be doing the work", () => {
    expect(judgeRelatedness(CLOSED_RUN, "And separately, can you check the runner?", RECENT).verdict).toBe(
      "related",
    );
  });

  it("control: the same phrase WITHOUT the opener is different", () => {
    expect(judgeRelatedness(CLOSED_RUN, "Separately, can you check the runner?", RECENT).verdict).toBe(
      "different",
    );
  });
});

describe("fail toward absorbing", () => {
  it("absorbs — never throws — when the rules blow up on a bad `next`", () => {
    // A real throw, not a simulated one: `next.trim` does not exist on this value.
    //
    // THIS ROW USED TO ASSERT `judgeRelatedness` THROWS, and roborev 65837 was right that pinning
    // that was pinning the defect: `judgeRelatedness` is the exported call a caller must use to get
    // a `reason`, so the documented usage was the one path with no guard. It now degrades to
    // `related` like everything else here.
    const bogusNext = {} as unknown as string;
    expect(judgeRelatedness(CLOSED_RUN, bogusNext, RECENT).verdict).toBe("related");
    expect(isRelated(CLOSED_RUN, bogusNext, RECENT)).toBe(true);
  });

  it("returns TRUE when judgeRelatedness throws on a bad `run`", () => {
    const explodingRun = {
      get length(): number {
        throw new Error("run exploded");
      },
    } as unknown as readonly string[];
    // "The runner is offline." reaches the run only after every `next`-only rule has declined.
    expect(judgeRelatedness(explodingRun, "The runner is offline.", RECENT).verdict).toBe("related");
    expect(isRelated(explodingRun, "The runner is offline.", RECENT)).toBe(true);
  });

  it("a non-finite gap is never read as a topic shift", () => {
    for (const gap of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(judgeRelatedness(CLOSED_RUN, "The runner is offline.", gap).verdict).toBe("related");
    }
  });

  it("an empty or whitespace-only message is related", () => {
    expect(judgeRelatedness(CLOSED_RUN, "", FAR_PAST).verdict).toBe("related");
    expect(judgeRelatedness(CLOSED_RUN, "   \n\t ", FAR_PAST).verdict).toBe("related");
  });

  it("an empty run is related — there is nothing to be different from", () => {
    expect(judgeRelatedness([], "The runner is offline.", RECENT).verdict).toBe("related");
  });

  it("the default with no evidence either way is related", () => {
    expect(judgeRelatedness(CLOSED_RUN, "The runner is offline.", RECENT).verdict).toBe("related");
  });
});

describe("isRelated tracks the verdict — it is not a constant", () => {
  it("is true for a related verdict", () => {
    expect(isRelated(CLOSED_RUN, "And the migration is stale.", FAR_PAST)).toBe(true);
  });

  it("is FALSE for a different verdict", () => {
    // Without this, `isRelated` could be `() => true` and every other case above would still pass.
    expect(isRelated(CLOSED_RUN, "Separately, what about the DMG?", RECENT)).toBe(false);
    expect(isRelated(CLOSED_RUN, "The runner is offline.", FAR_PAST)).toBe(false);
  });
});

describe("the caller's bounds are frozen values", () => {
  it("MAX_ABSORBED_RUN is 8", () => {
    expect(MAX_ABSORBED_RUN).toBe(8);
  });

  it("MAX_RUN_CHARS is 12000", () => {
    expect(MAX_RUN_CHARS).toBe(12_000);
  });

  it("TOPIC_SHIFT_GAP_MS is 45000", () => {
    expect(TOPIC_SHIFT_GAP_MS).toBe(45_000);
  });

  it("MAX_SUPERSEDE_GAP_MS is 30000", () => {
    expect(MAX_SUPERSEDE_GAP_MS).toBe(30_000);
  });
});

// ══ REGRESSIONS FROM roborev REVIEW 65837 ═══════════════════════════════════════════════════════
//
// Three of these four were SPLITS — the module returning `different` on a message that plainly
// continued the run — which is the one direction this module says it must never fail in. Each row
// is written against the verdict, and each fails against the code as it was before the fix.
describe("roborev 65837 — the splits the first cut produced", () => {
  it("does NOT split a sentence that merely USES a topic-shift word early (M1)", () => {
    // Was: `unrelated` matched as a bare substring anywhere in the first 48 chars, so this ordinary
    // question — which is about the run — came back `different` and got answered on its own.
    expect(
      judgeRelatedness(CLOSED_RUN, "Can you check whether that DMG is unrelated to the runner?", RECENT)
        .verdict,
    ).toBe("related");
    // The word must OPEN the message (or the clause after a short lead) to count as announcing.
    expect(judgeRelatedness(CLOSED_RUN, "Separately, what about the DMG?", RECENT).verdict).toBe(
      "different",
    );
    expect(judgeRelatedness(CLOSED_RUN, "ok, separately, what about the DMG?", RECENT).verdict).toBe(
      "different",
    );
  });

  it("reaches the topic-shift rule for LOWERCASE input, which is how he actually types (M2)", () => {
    // Was: the lowercase-start signal short-circuited the topic-shift list entirely, so for the
    // founder's dominant input mode the whole list — and the gap rule — were unreachable.
    expect(judgeRelatedness(CLOSED_RUN, "separately, what about the DMG?", RECENT).verdict).toBe(
      "different",
    );
    // …but an explicit CONNECTIVE still outranks it: "and separately" is a continuation.
    expect(judgeRelatedness(CLOSED_RUN, "and separately, what about the DMG?", RECENT).verdict).toBe(
      "related",
    );
  });

  it("does NOT split a contracted pronoun opener (M3)", () => {
    // Was: LEADING_PRONOUNS held only bare pronouns, so "It's" / "That's" / "They're" matched
    // nothing and fell through to the gap rule. About as clear a continuation as exists, split.
    for (const opener of [
      "It's still failing on the runner.",
      "That's the one I meant.",
      "They're both red now.",
      "It’s still failing on the runner.", // typographic apostrophe — what dictation emits
    ]) {
      expect(judgeRelatedness(CLOSED_RUN, opener, FAR_PAST).verdict).toBe("related");
    }
  });

  it("makes the REASON-CARRYING entry point fail toward absorbing too (M4)", () => {
    // Was: only `isRelated` caught. `judgeRelatedness` is the exported call a caller must use to get
    // `reason`, so the documented usage was the unguarded one — a bug would reach the turn queue as
    // an exception rather than as the absorb the founder asked for.
    const exploding = {
      trim(): string {
        throw new TypeError("boom");
      },
    } as unknown as string;
    const out = judgeRelatedness(CLOSED_RUN, exploding, RECENT);
    expect(out.verdict).toBe("related");
    expect(out.reason).toMatch(/threw/);
    expect(isRelated(CLOSED_RUN, exploding, RECENT)).toBe(true);
  });
});
