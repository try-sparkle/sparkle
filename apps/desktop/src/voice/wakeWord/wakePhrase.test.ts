// What the matcher must HEAR, and what it must REFUSE to hear.
//
// Every row here asserts a VALUE the caller consumes — the residual string, the offset, the score —
// rather than that a match object exists. A `expect(match).not.toBeNull()` suite would stay green
// against a matcher that returned the whole sentence as the residual, or that matched at the wrong
// word, which are the two ways this function fails in practice.
import { describe, it, expect } from "vitest";
import {
  DEFAULT_MIN_CONFIDENCE,
  DEFAULT_WAKE_PHRASE,
  matchWakePhrase,
  normalizeTranscript,
} from "./wakePhrase";

describe("normalizeTranscript", () => {
  it("lowercases, drops punctuation and collapses whitespace", () => {
    expect(normalizeTranscript("  Hey,   SPARKLE!  ")).toBe("hey sparkle");
  });

  it("strips diacritics so an accented rendering compares equal", () => {
    expect(normalizeTranscript("héy spärklé")).toBe("hey sparkle");
  });

  it("keeps a contraction as ONE word — 'what's' must not become 'what s'", () => {
    // The residual is sliced out of the ORIGINAL text, but the token COUNT drives where the slice
    // starts. Splitting a contraction shifts every later offset.
    expect(normalizeTranscript("what's on my calendar")).toBe("whats on my calendar");
  });

  it("is empty for text with no words at all", () => {
    expect(normalizeTranscript("  ,.!?  ")).toBe("");
  });
});

describe("matchWakePhrase — the happy path carries the residual", () => {
  it("returns the words after the phrase, in the user's own casing and punctuation", () => {
    const m = matchWakePhrase("hey sparkle what's on my calendar");
    expect(m).not.toBeNull();
    expect(m?.residual).toBe("what's on my calendar");
    expect(m?.heard).toBe("hey sparkle");
    expect(m?.index).toBe(0);
    expect(m?.endIndex).toBe("hey sparkle".length);
    expect(m?.confidence).toBe(1);
  });

  it("trims the punctuation the transcriber puts between the phrase and the request", () => {
    const m = matchWakePhrase("Hey, Sparkle, what's on my calendar?");
    expect(m?.residual).toBe("what's on my calendar?");
    expect(m?.heard).toBe("Hey, Sparkle");
    expect(m?.confidence).toBe(1);
  });

  it("residual is EMPTY when the phrase was the whole utterance", () => {
    const m = matchWakePhrase("Hey, sparkle.");
    expect(m?.residual).toBe("");
  });

  it("finds the phrase mid-sentence and reports where it starts", () => {
    const m = matchWakePhrase("so I said hey sparkle open the door");
    expect(m?.index).toBe("so I said ".length);
    expect(m?.residual).toBe("open the door");
  });
});

describe("matchWakePhrase — tolerance of the slips the transcriber actually makes", () => {
  it("hears a TRANSPOSITION as one edit: 'sparkel'", () => {
    const m = matchWakePhrase("hey sparkel open settings");
    // 1 edit over the phrase's 10 characters. Plain Levenshtein would score this 2 (→ 0.8); the
    // Damerau transposition is what keeps the most common mishearing cheap.
    expect(m?.confidence).toBeCloseTo(0.9, 5);
    expect(m?.residual).toBe("open settings");
  });

  it("hears a trailing plural: 'sparkles'", () => {
    const m = matchWakePhrase("hey sparkles open settings");
    expect(m?.confidence).toBeCloseTo(0.9, 5);
    expect(m?.residual).toBe("open settings");
  });

  it("hears a word the transcriber SPLIT IN TWO: 'spar kle'", () => {
    const m = matchWakePhrase("hey spar kle turn on the lights");
    expect(m?.confidence).toBe(1);
    expect(m?.heard).toBe("hey spar kle");
    // The join must not eat the first word of the request.
    expect(m?.residual).toBe("turn on the lights");
  });

  it("does not join when the word was heard cleanly on its own", () => {
    // "sparkle" is exact at one token; joining it with "what" would still be a match under a
    // best-effort search, and would swallow the first word of the residual.
    const m = matchWakePhrase("hey sparkle what time is it");
    expect(m?.residual).toBe("what time is it");
  });
});

describe("matchWakePhrase — what must NOT fire", () => {
  it.each([
    ["a bare 'sparkle' with no carrier", "make the sparkle logo bigger"],
    ["a carrier that is not adjacent", "hey there sparkle"],
    ["a longer real word", "hey sparkling water please"],
    ["an unrelated word of similar length", "hey spatula"],
    ["the carrier alone", "hey what's up"],
    ["text with no words at all", "  ,.!?  "],
  ])("refuses %s", (_label, text) => {
    expect(matchWakePhrase(text)).toBeNull();
  });

  it("gives a SHORT carrier token zero slack — 'hay'/'they' are ordinary speech", () => {
    // `sparkle-mun0` restated: every edit-distance net around a 3-letter word admits real English.
    // The carrier is what stops a bare noun opening the overlay, so it must be heard exactly.
    expect(matchWakePhrase("hay sparkle open settings")).toBeNull();
    expect(matchWakePhrase("they sparkle in the light")).toBeNull();
    // …and the exact carrier still works, so this is a bound, not a broken matcher.
    expect(matchWakePhrase("hey sparkle open settings")?.residual).toBe("open settings");
  });

  it("returns null when the phrase itself has no words", () => {
    expect(matchWakePhrase("hey sparkle", "  ,  ")).toBeNull();
  });
});

describe("matchWakePhrase — the confidence gate is a real gate", () => {
  it("rejects a match that scores below minConfidence, and accepts the same text above it", () => {
    const text = "hey sparkel open settings"; // one edit → 0.9
    expect(matchWakePhrase(text, DEFAULT_WAKE_PHRASE, { minConfidence: 0.95 })).toBeNull();
    expect(matchWakePhrase(text, DEFAULT_WAKE_PHRASE, { minConfidence: 0.85 })?.confidence).toBeCloseTo(
      0.9,
      5,
    );
  });

  it("the default threshold admits a one-edit slip", () => {
    // Pins the relationship between the two exported constants rather than re-spelling 0.7: if the
    // default ever rose above 0.9 the tolerant match would be dead code and nothing else would say so.
    expect(DEFAULT_MIN_CONFIDENCE).toBeLessThanOrEqual(0.9);
    expect(matchWakePhrase("hey sparkel go")).not.toBeNull();
  });
});

describe("matchWakePhrase — the phrase is configurable, not baked in", () => {
  it("matches a custom phrase and ignores the default one", () => {
    const m = matchWakePhrase("yo genie what's the weather", "yo genie");
    expect(m?.residual).toBe("what's the weather");
    expect(matchWakePhrase("hey sparkle what's the weather", "yo genie")).toBeNull();
  });

  it("normalizes the configured phrase too, so 'Hey, Sparkle!' configures the same matcher", () => {
    expect(matchWakePhrase("hey sparkle go", "Hey, Sparkle!")?.residual).toBe("go");
  });

  it("a three-word phrase must be heard whole", () => {
    expect(matchWakePhrase("okay hey sparkle go", "okay hey sparkle")?.residual).toBe("go");
    expect(matchWakePhrase("hey sparkle go", "okay hey sparkle")).toBeNull();
  });
});
