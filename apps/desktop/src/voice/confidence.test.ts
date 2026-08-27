import { describe, it, expect } from "vitest";
import {
  confidence,
  thresholdMs,
  CONFIDENCE_THRESHOLD_MS,
  LONG_UTTERANCE_WORDS,
  type Confidence,
  endsMidThought,
  endsMidClause,
  hasInteriorSplice,
} from "./confidence";

/**
 * Table-driven, because the whole value of this module is that the four tiers stay legible as a
 * TABLE — a reader should be able to see what earns each tier without tracing branches. Each row
 * names the SIGNAL it exercises, so a failure says which rule broke rather than just which string.
 */
const CASES: Array<{ signal: string; transcript: string; tier: Confidence }> = [
  // ── high — clean sentence, terminal punctuation, fully-formed question ─────────────────────
  { signal: "terminal period", transcript: "Add a login button.", tier: "high" },
  { signal: "terminal exclamation", transcript: "Ship it!", tier: "high" },
  { signal: "fully-formed question", transcript: "What is the status of the build?", tier: "high" },
  { signal: "question opener + mark, terse", transcript: "Why?", tier: "high" },
  { signal: "period after a long sentence", transcript: "Run the whole suite and then push the branch to origin.", tier: "high" },
  { signal: "CJK full stop", transcript: "ログインボタンを追加して。", tier: "high" },

  // ── normal — the default: short, unpunctuated, nothing wrong with the tail ─────────────────
  { signal: "terse imperative", transcript: "ship it", tier: "normal" },
  { signal: "short unpunctuated instruction", transcript: "run the tests", tier: "normal" },
  { signal: "exactly at the long-utterance bound (6 words)", transcript: "run the tests and push it", tier: "normal" },

  // ── low — trailing filler, or a long utterance with no terminal punctuation ────────────────
  { signal: "trailing filler after a complete instruction", transcript: "add a login button, um", tier: "low" },
  { signal: "trailing filler, bare", transcript: "let's redo the header uh", tier: "low" },
  { signal: "trailing 'like'", transcript: "make the spacing a bit tighter like", tier: "low" },
  { signal: "long utterance, no terminal punctuation", transcript: "go through the migration files and check that every one of them applies", tier: "low" },

  // ── verylow — trailing conjunction, unclosed question, mid-clause ──────────────────────────
  { signal: "trailing coordinating conjunction", transcript: "fix the header and", tier: "verylow" },
  { signal: "trailing subordinating conjunction", transcript: "hold the deploy because", tier: "verylow" },
  { signal: "trailing preposition", transcript: "send the diff to", tier: "verylow" },
  { signal: "trailing determiner", transcript: "open the", tier: "verylow" },
  { signal: "trailing auxiliary", transcript: "the build is", tier: "verylow" },
  { signal: "unclosed question (opener, no mark)", transcript: "how do I roll this back", tier: "verylow" },
  { signal: "unclosed question, short", transcript: "what happened", tier: "verylow" },
  // Interior splice — two utterances concatenated. The TAIL looks complete (ends on a full stop),
  // so without the interior-splice check these would score `high`; they must not. Founder's verbatim
  // example from bead sparkle-r3wl6f's splice comment, plus a minimal reproduction.
  { signal: "interior splice — founder's verbatim two-utterance concat", transcript: "As a part of that work, feel free to also compress it so it has less information, not more But looking for something within 10/01/2026 move in dates, period, just wanna confirm that this property is not available then.", tier: "verylow" },
  { signal: "interior splice — capitalised 'But', no stop before it", transcript: "compress the file to less information not more But looking for a rental.", tier: "verylow" },
  { signal: "interior splice — capitalised 'So' seam", transcript: "the build is finally green So can you confirm the property is available.", tier: "verylow" },
  { signal: "nothing said yet", transcript: "", tier: "verylow" },
  { signal: "whitespace only", transcript: "   \n  ", tier: "verylow" },
];

describe("confidence — the tier table", () => {
  for (const { signal, transcript, tier } of CASES) {
    it(`${tier} — ${signal}: ${JSON.stringify(transcript)}`, () => {
      expect(confidence(transcript)).toBe(tier);
    });
  }
});

describe("confidence — precedence between signals", () => {
  it("a dangling conjunction beats a terminal mark", () => {
    // "…, and." is punctuation landing on an unfinished clause — a transcription artefact, not a
    // finished thought. Sending here truncates the user mid-sentence, which is the failure the
    // whole rail exists to avoid, so the strongest keep-waiting signal has to win outright.
    expect(confidence("let's deploy it, and.")).toBe("verylow");
  });

  it("a dangling conjunction beats a closed question", () => {
    expect(confidence("what should I do about the migration and")).toBe("verylow");
  });

  it("a closed question outranks the long-utterance rule", () => {
    // Long AND a question — but it is punctuated, so the punctuator found the end and the
    // no-terminal-punctuation rule never applies.
    const t = "why did the release job fail on the notarization step this morning?";
    expect(t.trim().split(/\s+/).length).toBeGreaterThan(LONG_UTTERANCE_WORDS);
    expect(confidence(t)).toBe("high");
  });

  it("trailing filler outranks a clean short sentence but not a dangling conjunction", () => {
    expect(confidence("ship it um")).toBe("low");
    expect(confidence("ship it um and")).toBe("verylow");
  });

  it("a question opener mid-sentence does not make an unclosed question", () => {
    // The unclosed-question rule keys off the FIRST word. "tell me what happened" is an
    // instruction, not a question, and must not be dragged to verylow by the "what" inside it.
    expect(confidence("tell me what happened")).toBe("normal");
    expect(confidence("tell me more")).toBe("normal");
    // …but the SAME words as an actual opener are the unclosed question the rule is for.
    expect(confidence("what happened")).toBe("verylow");
  });
});

describe("confidence — the long-utterance bound", () => {
  it("is exclusive: exactly LONG_UTTERANCE_WORDS words stays normal, one more drops to low", () => {
    const at = Array.from({ length: LONG_UTTERANCE_WORDS }, (_, i) => `word${i}`).join(" ");
    const over = `${at} extra`;
    expect(at.split(/\s+/)).toHaveLength(LONG_UTTERANCE_WORDS);
    expect(confidence(at)).toBe("normal");
    expect(confidence(over)).toBe("low");
  });
});

describe("confidence — purity", () => {
  it("is deterministic and does not mutate its input", () => {
    // The rail calls this on EVERY transcript chunk while the user is speaking, so a call must
    // cost nothing and mean the same thing every time.
    const t = "add a login button and";
    const before = t;
    expect(confidence(t)).toBe(confidence(t));
    expect(t).toBe(before);
  });

  it("ignores surrounding whitespace", () => {
    expect(confidence("  ship it.  ")).toBe("high");
    expect(confidence("\n fix the header and \t")).toBe("verylow");
  });
});

describe("thresholds", () => {
  it("pins the rungs the founder chose after being cut off mid-sentence", () => {
    // ══ WHY THIS IS FOUR LITERALS AND NOT A RATIO ═══════════════════════════════════════════
    // It used to assert `1 : 3 : 5 : 10` times a pace multiplier, on the reasoning that the shape
    // was the decision and the pace a knob. That stopped being true (bead `sparkle-r3wl6f`): the
    // top and bottom rungs now move by different factors, deliberately, because a clean sentence
    // and a dangling `and` are not the same kind of wrong to get wrong. A ratio cannot express
    // that, and keeping one would have forced a 6s `high` to reach a 30s `verylow` — a wait the
    // founder explicitly declined.
    //
    // Two of these four are RECORDED DECISIONS, not tuning, which is the other reason to spell
    // them: he was shown worked examples of 2s / 3s / 5s and picked 2s, and shown "hold forever"
    // against 30s and picked 30s. Someone retuning these should have to read that.
    expect(CONFIDENCE_THRESHOLD_MS).toEqual({
      high: 2_000, // his choice — the rung that a glance at the screen used to blow past
      normal: 4_000, // his choice
      low: 7_000, // the agent's — nobody chose it; it only has to sit between the two above
      verylow: 30_000, // his choice, over "never auto-send"
    });
  });

  it("gives a mid-clause tail enough room for a pause spent reading the screen", () => {
    // The DEFECT, stated as a property rather than as a number: the founder dictates while reading
    // the UI, so the rung that a dangling word earns has to outlast a stare at the screen. Twelve
    // seconds did not, and eight consecutive messages were truncated. Pinned as a relation to the
    // observed behaviour so a future retune has to argue with the evidence, not just edit a literal.
    const A_LONG_STARE_MS = 15_000;
    expect(thresholdMs("verylow")).toBeGreaterThan(A_LONG_STARE_MS);
    // …and a clean sentence must outlast an ordinary glance, which is what `smart_format` putting a
    // full stop on an unfinished thought turns into a truncated send.
    expect(thresholdMs("high")).toBeGreaterThan(1_500);
  });

  it("keeps every tier above the tray's one-second sweep floor", () => {
    // SWEEP_FLOOR_MS (voice/sendMode) promises no countdown paints a sweep shorter than a second —
    // below that it is a flicker between two frames, not a countdown. Worth pinning at the source
    // of the numbers: after the 1.2x pacing the floor is no longer binding on ANY tier (the fastest
    // is 1200ms), so a future tuning that lowered the ladder would silently start relying on the
    // clamp instead of failing here.
    for (const tier of ["high", "normal", "low", "verylow"] as const) {
      expect(thresholdMs(tier)).toBeGreaterThanOrEqual(1_000);
    }
  });

  it("is strictly monotonic: less confident always waits longer", () => {
    // The ordering IS the feature. If two tiers ever collide, the rail stops distinguishing cases
    // the heuristic went to the trouble of telling apart.
    const order = ["high", "normal", "low", "verylow"] as const;
    for (let i = 1; i < order.length; i += 1) {
      const [prev, cur] = [order[i - 1] as Confidence, order[i] as Confidence];
      expect(thresholdMs(cur), `${cur} must wait longer than ${prev}`).toBeGreaterThan(
        thresholdMs(prev),
      );
    }
  });

  it("has no upper cap — verylow is the longest wait and it is finite per evaluation", () => {
    // PRD §4: no cap on the TOTAL wait. Each re-evaluation re-imposes verylow's 30s from the
    // accumulated clock, so a sentence that keeps trailing off waits indefinitely by construction
    // rather than by a special case. See autoSendTimer.
    expect(thresholdMs("verylow")).toBe(CONFIDENCE_THRESHOLD_MS.verylow);
    expect(thresholdMs("verylow")).toBeGreaterThan(thresholdMs("low"));
  });
});

/**
 * `endsMidThought` — the one rule this module SHARES across layers.
 *
 * Exported so `engine/conciergeRelatedness` can ask the same question without a second copy of the
 * regex. These cases assert the VERDICT for its own sake, not through `confidence()`: the concierge
 * never reads a tier, so a change that kept the tier table green while breaking the predicate would
 * silently break the caller that matters.
 */
describe("endsMidThought", () => {
  it("is true for a long utterance with no terminal punctuation", () => {
    expect(
      endsMidThought("hold the deploy until the migration has finished running"),
    ).toBe(true);
  });

  it("is false once terminal punctuation lands, however long", () => {
    expect(
      endsMidThought("hold the deploy until the migration has finished running."),
    ).toBe(false);
    expect(endsMidThought("go through every migration file and check them all?")).toBe(false);
  });

  it("is false for a SHORT unpunctuated utterance — a terse instruction is a whole thought", () => {
    expect(endsMidThought("ship it")).toBe(false);
    expect(endsMidThought("run the tests and push it")).toBe(false); // exactly LONG_UTTERANCE_WORDS
  });

  it("turns over at exactly LONG_UTTERANCE_WORDS words", () => {
    const words = (n: number) => Array.from({ length: n }, () => "word").join(" ");
    expect(endsMidThought(words(LONG_UTTERANCE_WORDS))).toBe(false);
    expect(endsMidThought(words(LONG_UTTERANCE_WORDS + 1))).toBe(true);
  });

  it("is false for empty input — there is no thought to be mid of", () => {
    expect(endsMidThought("")).toBe(false);
    expect(endsMidThought("   ")).toBe(false);
  });

  it("agrees with the tier `confidence()` derives from the same condition", () => {
    // The refactor's no-behaviour-change claim, asserted rather than assumed: whenever the
    // predicate is true and nothing worse fires first, the tier is `low`.
    const cut = "go through the migration files and check that every one of them applies";
    expect(endsMidThought(cut)).toBe(true);
    expect(confidence(cut)).toBe("low");
  });
});

describe("endsMidClause — the shared 'is this cut off' predicate", () => {
  // ONE definition, two callers: this rail's `verylow` tier and `engine/conciergeAutoDispatch`'s
  // refusal to spend a research child on a fragment. The cases below are the founder's own
  // truncated messages, verbatim from bead `sparkle-r3wl6f`.
  const CUT_OFF = [
    "The",
    "we can see that there is",
    "we can see that there is the",
    "Is this the",
    "Let's just take this one here. And so",
    "there are the actual tasks here. Each one of these tasks,", // the trailing COMMA
    "here's the problem:",
    "two things —",
    "and I was thinking...",
    // Interior splices — the tail is a clean full stop, but a capitalised coordinating conjunction
    // sits mid-text with no sentence boundary before it. Verbatim founder example + reproductions.
    "As a part of that work, feel free to also compress it so it has less information, not more But looking for something within 10/01/2026 move in dates, period, just wanna confirm that this property is not available then.",
    "compress the file to less information not more But looking for a rental.",
    "the build is finally green So can you confirm the property is available.",
  ];
  for (const text of CUT_OFF) {
    it(`reads as cut off: ${JSON.stringify(text)}`, () => {
      expect(endsMidClause(text)).toBe(true);
      // …and the rail must price it as such. These two travel together by construction, but a
      // reader should not have to trace `confidence` to know it.
      expect(confidence(text)).toBe("verylow");
    });
  }

  // ── THE OTHER DIRECTION, WHICH IS THE ONE THAT COSTS SOMETHING IF IT BREAKS ─────────────────
  // A predicate that answered `true` to everything would pass every row above while making the
  // dispatch guard refuse all research and the countdown never fire. These are messages that must
  // stay dispatchable, and the second is the specific false positive the narrow definition exists
  // to avoid: an unclosed question is `verylow` for the COUNTDOWN and must not be a `fragment` for
  // the DISPATCHER, because it is exactly the kind of thing research is for.
  const WHOLE = [
    "why is the DMG build red", // unclosed question — verylow, but NOT a fragment
    "why is the DMG build red?",
    "Add a login button.",
    "ship it",
    "Look into the flaky test in worktree.rs",
    // The false positive the interior-splice check MUST avoid: a real full stop before the capital
    // makes "But" a legitimate new sentence, not a splice seam. One continuous, punctuated dictation.
    "Compress the file to less information not more. But keep the examples.",
    "The build is finally green. So can you confirm the property is available?",
    // A message that merely OPENS with a coordinating conjunction is informal, not a splice — the
    // scan starts at index 1, so the leading "But" is exempt.
    "But we still need to fix the header.",
  ];
  for (const text of WHOLE) {
    it(`does NOT read as cut off: ${JSON.stringify(text)}`, () => {
      expect(endsMidClause(text)).toBe(false);
    });
  }

  it("is empty-safe and whitespace-insensitive", () => {
    expect(endsMidClause("")).toBe(false);
    expect(endsMidClause("   ")).toBe(false);
    expect(endsMidClause("  fix the header and \t")).toBe(true);
  });
});

describe("hasInteriorSplice — two utterances concatenated into one", () => {
  // The seam is a capitalised coordinating conjunction with NO terminal punctuation before it —
  // `smart_format` capitalises a new sentence only when it also punctuated the previous one, so a
  // lone capital `But`/`So`/`And` mid-text is where a second finalised utterance was appended.
  const SPLICES = [
    "compress it so it has less information, not more But looking for a rental.",
    "the build is finally green So can you confirm the property is available.",
    "run the tests And also check the migration files apply.",
    // Founder's verbatim two-utterance concatenation (bead sparkle-r3wl6f splice comment).
    "As a part of that work, feel free to also compress it so it has less information, not more But looking for something within 10/01/2026 move in dates, period, just wanna confirm that this property is not available then.",
  ];
  for (const text of SPLICES) {
    it(`detects the splice: ${JSON.stringify(text)}`, () => {
      expect(hasInteriorSplice(text)).toBe(true);
    });
  }

  // The load-bearing NON-splices: a real sentence boundary before the capital, a leading
  // conjunction, and a lowercase conjunction mid-sentence (ordinary connective, not a seam).
  const NOT_SPLICES = [
    "compress it to less information not more. But keep the examples.", // full stop → new sentence
    "ship it! But first run the tests.", // exclamation is terminal too
    "is it done? Or should I wait?", // question mark is terminal too
    "But we still need to fix the header.", // opens with a conjunction — index-0 exempt
    "run the tests and also push the branch to origin.", // lowercase 'and' — not a seam
    "add a login button.", // no interior conjunction at all
    "So we should ship it.", // opens with 'So' — index-0 exempt
    // ALL-CAPS coordinating words are emphasis or boolean/query operators, NOT sentence seams —
    // `smart_format` capitalises only the first letter at a real boundary. These must stay whole.
    "show me the PRs that are green AND unmerged.",
    "filter the board by open OR ready.",
    "make it faster AND cheaper.",
  ];
  for (const text of NOT_SPLICES) {
    it(`is NOT a splice: ${JSON.stringify(text)}`, () => {
      expect(hasInteriorSplice(text)).toBe(false);
    });
  }

  it("is empty-safe", () => {
    expect(hasInteriorSplice("")).toBe(false);
    expect(hasInteriorSplice("   ")).toBe(false);
  });
});
