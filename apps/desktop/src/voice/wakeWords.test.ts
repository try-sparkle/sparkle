import { describe, it, expect } from "vitest";
import {
  normalize,
  matchesWake,
  matchesStop,
  stripWakePrefix,
  stripStopSuffix,
  DEFAULT_WAKE_CONFIG,
  type WakeConfig,
} from "./wakeWords";

describe("normalize", () => {
  it("lowercases, strips punctuation, collapses whitespace", () => {
    expect(normalize("  Hey, Sparkle!!  ")).toBe("hey sparkle");
  });
});

describe("matchesWake — bare wake accepted anywhere (Tier 1)", () => {
  for (const s of ["sparkle", "Sparkle.", "hey sparkle", "ok sparkle now", "sparql", "spark ql"]) {
    it(`wakes on "${s}"`, () => expect(matchesWake(s)).toBe(true));
  }
});

describe("matchesWake — Tier 2 real words require the 'hey' carrier", () => {
  it("does NOT wake on bare 'sprinkle'", () => expect(matchesWake("add some sprinkle")).toBe(false));
  it("wakes on 'hey sprinkle'", () => expect(matchesWake("hey sprinkle")).toBe(true));
  it("does NOT wake on bare 'sparkler'", () => expect(matchesWake("a sparkler")).toBe(false));
});

describe("matchesWake — phonetic/levenshtein nets, tier-gated", () => {
  it("wakes on novel spelling 'sparkal' (no Tier-2 collision)", () =>
    expect(matchesWake("sparkal")).toBe(true));
  it("inflection 'sparklers' demotes to Tier 2 (needs hey)", () => {
    expect(matchesWake("sparklers")).toBe(false);
    expect(matchesWake("hey sparklers")).toBe(true);
  });
  it("inflection 'sprinkles' demotes to Tier 2 (needs hey)", () =>
    expect(matchesWake("sprinkles")).toBe(false));
  it("does NOT wake on unrelated words", () => {
    expect(matchesWake("sparrow")).toBe(false);
    expect(matchesWake("market")).toBe(false);
  });
});

describe("matchesStop — requires 'sparkle' carrier + 'stop' (2-gram)", () => {
  // Curated hits + ASR mishearings of BOTH tokens. "sparkle" reuses the wake
  // matcher's phonetic/lev nets; "stop" matches a tight curated/lev net.
  for (const s of [
    "sparkle stop",
    "sparkle stop.",
    "Sparkle, stop",
    "hey sparkle stop",
    "sparkly stop",
    "sparkel stop",
    "sparkle stahp",
    "sparkle staap",
    "sparkle stawp",
    "sparkle stope",
  ]) {
    it(`stops on "${s}"`, () => expect(matchesStop(s)).toBe(true));
  }

  // Bare "stop" is a common dictation word — it must NEVER stop on its own.
  for (const s of [
    "stop",
    "please stop",
    "I need to stop",
    "I need to stop here",
    "let's stop for coffee",
  ]) {
    it(`does NOT stop on "${s}"`, () => expect(matchesStop(s)).toBe(false));
  }

  // Bare "sparkle" (without "stop") is harmless mid-dictation — must NOT stop.
  for (const s of ["sparkle", "sparkles are pretty", "sparkle and shine"]) {
    it(`does NOT stop on "${s}"`, () => expect(matchesStop(s)).toBe(false));
  }
});

describe("matchesStop — near-match words after 'sparkle' must NOT falsely stop (sparkle-mun0)", () => {
  // Regression: a too-loose stop-token net (lev<=1 / shared "STP" metaphone) let ordinary words
  // that merely rhyme with "stop" end capture when they happened to follow the "sparkle" carrier —
  // e.g. "make the sparkle top bar bigger" destructively ended dictation and lost the rest.
  for (const s of [
    "make the sparkle top bar bigger", // "top": lev 1 from "stop" — the original false positive
    "sparkle top",
    "put the sparkle shop link here", // "shop"
    "sparkle shop",
    "add a sparkle step to the flow", // "step": shares the "STP" metaphone code with "stop"
    "sparkle step",
    "make the sparkle stomp animation", // "stomp": a real, far word (removed from the variant set)
    "sparkle stomp",
  ]) {
    it(`does NOT stop on "${s}"`, () => expect(matchesStop(s)).toBe(false));
  }

  // A merely-2-edits-away carrier ("spark", not phonetically "sparkle") must not carry a real stop.
  it("does NOT stop on 'add a spark stop the animation'", () =>
    expect(matchesStop("add a spark stop the animation")).toBe(false));

  // …but the real stop phrase and its curated mishearings still reliably end capture.
  for (const s of [
    "sparkle stop",
    "hey sparkle stop",
    "Sparkle, stop.",
    "sparkly stop",
    "sparkel stop", // 2-edit spelling, still phonetically "SPRKL"
    "sparkle stahp",
    "sparkle stope",
    "okay that is the plan sparkle stop",
  ]) {
    it(`still stops on "${s}"`, () => expect(matchesStop(s)).toBe(true));
  }
});

describe("stripWakePrefix / stripStopSuffix — same-segment remainder", () => {
  it("strips the wake prefix, keeps the remainder", () =>
    expect(stripWakePrefix("hey sparkle add a login button")).toBe("add a login button"));
  it("strips a bare wake prefix", () =>
    expect(stripWakePrefix("sparkle open the file")).toBe("open the file"));
  it("returns empty when the segment is only the wake phrase", () =>
    expect(stripWakePrefix("hey sparkle")).toBe(""));
  it("strips the stop suffix, keeps the remainder", () =>
    expect(stripStopSuffix("okay I'm done sparkle stop")).toBe("okay i m done"));
  it("returns empty when the segment is only the stop phrase", () =>
    expect(stripStopSuffix("sparkle stop")).toBe(""));
  // Tier-2 multi-word wake entries: both tokens must be consumed, not just the first.
  it("strips multi-word Tier-2 wake prefix (hey spar kill)", () =>
    expect(stripWakePrefix("hey spar kill add a button")).toBe("add a button"));
  it("strips multi-word Tier-2 wake prefix (hey spark all)", () =>
    expect(stripWakePrefix("hey spark all open the file")).toBe("open the file"));
});

describe("cloud (Deepgram smart_format) finals normalize before matching", () => {
  // The cloud path routes Deepgram finals through the same matcher; smart_format capitalizes and
  // punctuates (e.g. "Hey Sparkle." / "Sparkle, stop."). normalize() lowercases + strips punctuation,
  // so these must still match — otherwise wake/stop would break on the cloud engine.
  it("wakes on a capitalized, punctuated 'Hey Sparkle.'", () =>
    expect(matchesWake("Hey Sparkle.")).toBe(true));
  it("stops on a capitalized, punctuated 'Sparkle, stop.'", () =>
    expect(matchesStop("Sparkle, stop.")).toBe(true));
  it("stops on a trailing stop phrase within a punctuated sentence", () =>
    expect(matchesStop("Okay, that's the plan. Sparkle, stop!")).toBe(true));
});

describe("custom words — generic fuzzy matcher (non-default config)", () => {
  const jarvis: WakeConfig = { wakeWord: "Hey Jarvis", stopWord: "Jarvis, halt" };

  it("DEFAULT_WAKE_CONFIG carries the built-in words", () => {
    expect(DEFAULT_WAKE_CONFIG.wakeWord).toBe("Hey Sparkle");
    expect(DEFAULT_WAKE_CONFIG.stopWord).toBe("Sparkle, stop");
  });

  // Passing the default config (or omitting it) is the tuned path — unchanged behavior.
  it("omitting config === passing DEFAULT_WAKE_CONFIG (tuned path)", () => {
    expect(matchesWake("hey sparkle")).toBe(true);
    expect(matchesWake("hey sparkle", DEFAULT_WAKE_CONFIG)).toBe(true);
    expect(matchesStop("sparkle stop", DEFAULT_WAKE_CONFIG)).toBe(true);
  });

  it("wakes on the custom phrase", () =>
    expect(matchesWake("hey jarvis open settings", jarvis)).toBe(true));

  it("does NOT wake on the OLD default word once remapped", () =>
    expect(matchesWake("hey sparkle open settings", jarvis)).toBe(false));

  it("tolerates a close mishearing of the custom word (levenshtein)", () =>
    expect(matchesWake("hey jarviss open settings", jarvis)).toBe(true));

  it("requires the full custom phrase contiguously", () => {
    expect(matchesWake("jarvis", jarvis)).toBe(false); // missing the 'hey' token
    expect(matchesWake("hey there jarvis", jarvis)).toBe(false); // not contiguous
  });

  it("matches the custom stop phrase", () =>
    expect(matchesStop("okay i am done jarvis halt", jarvis)).toBe(true));

  it("does NOT stop on the old 'sparkle stop' once remapped", () =>
    expect(matchesStop("sparkle stop", jarvis)).toBe(false));

  it("strips the custom wake prefix, keeps the remainder", () =>
    expect(stripWakePrefix("hey jarvis add a login button", jarvis)).toBe("add a login button"));

  it("strips the custom stop suffix, keeps the remainder", () =>
    expect(stripStopSuffix("okay i am done jarvis halt", jarvis)).toBe("okay i am done"));

  // Single-token custom wake word (no carrier), matched anywhere via the per-token fuzzy rule.
  it("single-word custom wake ('computer') matches anywhere", () => {
    const cfg: WakeConfig = { wakeWord: "Computer", stopWord: "Computer, stop" };
    expect(matchesWake("okay computer do this", cfg)).toBe(true);
    expect(matchesWake("hey sparkle", cfg)).toBe(false);
  });

  // A very short custom word (<=2 chars) must NOT rely on the lev<=2 net (it would match almost
  // anything); require exact-or-phonetic for short tokens.
  it("short custom word does not over-match via edit distance", () => {
    const cfg: WakeConfig = { wakeWord: "Yo", stopWord: "no more" };
    expect(matchesWake("yo do this", cfg)).toBe(true);
    expect(matchesWake("so go by", cfg)).toBe(false); // 'go'/'by' are lev<=2 of 'yo' but must not match
  });

  // 3–4 char custom words are EXACT-only: both the edit-distance net (1-edit neighbors bat/rat)
  // and the phonetic net (metaphone collisions cat/cot/cut all "KT") over-match. (roborev 31018/31022)
  it("3–4 char custom word matches only exact tokens", () => {
    const cfg: WakeConfig = { wakeWord: "cat", stopWord: "cat, halt" };
    expect(matchesWake("hey cat now", cfg)).toBe(true); // exact
    expect(matchesWake("the bat sat", cfg)).toBe(false); // 'bat' is lev-1 of 'cat' — must NOT wake
    expect(matchesWake("a rat ran", cfg)).toBe(false); // 'rat' is lev-1 of 'cat' — must NOT wake
    expect(matchesWake("the cot bed", cfg)).toBe(false); // 'cot' shares metaphone 'KT' — must NOT wake
  });

  // 5+ char words keep the edit-distance net: a genuine mishearing ('jarvos' is lev-1 of 'jarvis',
  // NOT an exact match) must still wake. This fails if the length gate ever excludes 5+ char words.
  it("5+ char custom word still tolerates a lev<=2 mishearing", () =>
    expect(matchesWake("hey jarvos now", { wakeWord: "Jarvis", stopWord: "Jarvis, halt" })).toBe(
      true,
    ));
});
