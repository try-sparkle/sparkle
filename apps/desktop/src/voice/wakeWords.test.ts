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

describe("matchesStop", () => {
  for (const s of ["send it", "send it.", "Send It", "fend it", "sentit", "spend it"]) {
    it(`stops on "${s}"`, () => expect(matchesStop(s)).toBe(true));
  }
  it("does NOT stop on bare 'send'", () => expect(matchesStop("send")).toBe(false));
  it("does NOT stop on 'send an email to bob'", () =>
    expect(matchesStop("send an email to bob")).toBe(false));

  // Regression: plausible dictation phrases that lev-match "sendit" but do NOT
  // start with s/f must not false-stop capture (Fix: s/f-initial gate on lev-net).
  it("does NOT stop on 'bend it'", () => expect(matchesStop("bend it")).toBe(false));
  it("does NOT stop on 'lend it'", () => expect(matchesStop("lend it")).toBe(false));
  it("does NOT stop on 'end it'", () => expect(matchesStop("end it")).toBe(false));
  // s/f-initial variants must still stop.
  it("still stops on 'fend it'", () => expect(matchesStop("fend it")).toBe(true));
  it("still stops on 'sentit'", () => expect(matchesStop("sentit")).toBe(true));
  it("still stops on 'spend it'", () => expect(matchesStop("spend it")).toBe(true));
  it("still stops on 'send it'", () => expect(matchesStop("send it")).toBe(true));
});

describe("stripWakePrefix / stripStopSuffix — same-segment remainder", () => {
  it("strips the wake prefix, keeps the remainder", () =>
    expect(stripWakePrefix("hey sparkle add a login button")).toBe("add a login button"));
  it("strips a bare wake prefix", () =>
    expect(stripWakePrefix("sparkle open the file")).toBe("open the file"));
  it("returns empty when the segment is only the wake phrase", () =>
    expect(stripWakePrefix("hey sparkle")).toBe(""));
  it("strips the stop suffix, keeps the remainder", () =>
    expect(stripStopSuffix("and ship the change send it")).toBe("and ship the change"));
  it("returns empty when the segment is only the stop phrase", () =>
    expect(stripStopSuffix("send it")).toBe(""));
  // Tier-2 multi-word wake entries: both tokens must be consumed, not just the first.
  it("strips multi-word Tier-2 wake prefix (hey spar kill)", () =>
    expect(stripWakePrefix("hey spar kill add a button")).toBe("add a button"));
  it("strips multi-word Tier-2 wake prefix (hey spark all)", () =>
    expect(stripWakePrefix("hey spark all open the file")).toBe("open the file"));
});
