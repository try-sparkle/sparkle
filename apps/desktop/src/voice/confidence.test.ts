import { describe, it, expect } from "vitest";
import {
  confidence,
  thresholdMs,
  CONFIDENCE_THRESHOLD_MS,
  LONG_UTTERANCE_WORDS,
  type Confidence,
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
  it("matches the PRD's 1 / 3 / 5 / 10 second table", () => {
    expect(CONFIDENCE_THRESHOLD_MS).toEqual({
      high: 1_000,
      normal: 3_000,
      low: 5_000,
      verylow: 10_000,
    });
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
    expect(thresholdMs("verylow")).toBe(10_000);
  });
});
