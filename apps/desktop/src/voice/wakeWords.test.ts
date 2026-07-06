import { describe, it, expect } from "vitest";
import {
  normalize,
  matchesWake,
  matchesStop,
  stripWakePrefix,
  stripStopSuffix,
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
