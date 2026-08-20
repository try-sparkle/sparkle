import { describe, it, expect } from "vitest";
import {
  confidence,
  thresholdMs,
  CONFIDENCE_PACE,
  CONFIDENCE_THRESHOLD_MS,
  LONG_UTTERANCE_WORDS,
  type Confidence,
  endsMidThought,
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
  it("keeps the PRD's 1 : 3 : 5 : 10 SHAPE, paced by CONFIDENCE_PACE", () => {
    // The founder asked for the countdown to run 20% slower, so the absolute numbers moved
    // (1200 / 3600 / 6000 / 12000). Asserted as the PRD RATIO times the pace multiplier rather than
    // as four fresh literals: the ladder's shape is the decision, the pace is a tuning knob, and
    // re-pinning literals here would just have to be rewritten by the next tuning without ever
    // catching a real regression.
    expect(CONFIDENCE_THRESHOLD_MS).toEqual({
      high: 1_000 * CONFIDENCE_PACE,
      normal: 3_000 * CONFIDENCE_PACE,
      low: 5_000 * CONFIDENCE_PACE,
      verylow: 10_000 * CONFIDENCE_PACE,
    });
    // …and the shape itself, independent of the pace, so a bad multiplier cannot quietly flatten it.
    expect(thresholdMs("normal") / thresholdMs("high")).toBeCloseTo(3, 5);
    expect(thresholdMs("low") / thresholdMs("high")).toBeCloseTo(5, 5);
    expect(thresholdMs("verylow") / thresholdMs("high")).toBeCloseTo(10, 5);
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
    // PRD §4: no cap on the TOTAL wait. Each re-evaluation re-imposes verylow's 10s from the
    // accumulated clock, so a sentence that keeps trailing off waits indefinitely by construction
    // rather than by a special case. See autoSendTimer.
    expect(thresholdMs("verylow")).toBe(10_000 * CONFIDENCE_PACE);
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
