import { describe, it, expect } from "vitest";
import { truncateOnBoundary, stripLoneSurrogates, hasLoneSurrogate } from "./safeText";

// 🎉 U+1F389 is non-BMP: JS stores it as the surrogate PAIR 🎉 (2 code units).
// Slicing between them leaves a lone LEADING surrogate, which JSON.stringify emits as the
// escape "\ud83c" — and serde_json rejects that with exactly:
//   "unexpected end of hex escape at line N column N"
// which is the publish_window_roster failure this module exists to prevent.
const PARTY = "\u{1F389}";

describe("hasLoneSurrogate", () => {
  it("detects a lone leading surrogate (the serde-fatal case)", () => {
    expect(hasLoneSurrogate("hi \uD83C")).toBe(true);
  });
  it("detects a lone trailing surrogate", () => {
    expect(hasLoneSurrogate("\uDF89 hi")).toBe(true);
  });
  it("accepts a well-formed surrogate pair and plain text", () => {
    expect(hasLoneSurrogate(`party ${PARTY} time`)).toBe(false);
    expect(hasLoneSurrogate("plain ascii")).toBe(false);
    expect(hasLoneSurrogate("café éè")).toBe(false);
  });
});

describe("truncateOnBoundary", () => {
  it("never splits a surrogate pair straddling the cap (regression: hex-escape bug)", () => {
    // 79 filler chars, then the emoji occupying code units 79 and 80. A naive
    // slice(0, 80) keeps unit 79 (the HIGH surrogate) and drops unit 80 (the low one).
    const text = "x".repeat(79) + PARTY + "trailing";
    const naive = text.slice(0, 80);
    expect(hasLoneSurrogate(naive)).toBe(true); // pins the bug we are fixing

    const safe = truncateOnBoundary(text, 80);
    expect(hasLoneSurrogate(safe)).toBe(false);
    expect(safe).toBe("x".repeat(79)); // the half emoji is dropped, not half-kept
    expect(safe.length).toBeLessThanOrEqual(80);
  });

  it("keeps a pair that fits entirely within the cap", () => {
    const text = "x".repeat(78) + PARTY + "trailing";
    const safe = truncateOnBoundary(text, 80);
    expect(safe).toBe("x".repeat(78) + PARTY);
    expect(hasLoneSurrogate(safe)).toBe(false);
  });

  it("leaves short strings untouched and handles empty input", () => {
    expect(truncateOnBoundary("short", 80)).toBe("short");
    expect(truncateOnBoundary("", 80)).toBe("");
    expect(truncateOnBoundary(PARTY, 80)).toBe(PARTY);
  });

  it("survives a cap that lands on the very first code unit of a pair", () => {
    expect(truncateOnBoundary(PARTY + "rest", 1)).toBe("");
  });
});

describe("stripLoneSurrogates", () => {
  it("replaces an already-malformed lone surrogate with U+FFFD", () => {
    const out = stripLoneSurrogates("bad \uD83C end");
    expect(hasLoneSurrogate(out)).toBe(false);
    expect(out).toBe("bad � end");
  });

  it("preserves valid pairs untouched", () => {
    const good = `ok ${PARTY} ok`;
    expect(stripLoneSurrogates(good)).toBe(good);
  });
});

describe("JSON round-trip: the sanitized payload is well-formed JSON", () => {
  it("a naively-sliced emoji prompt produces the escape serde_json rejects", () => {
    const naive = ("x".repeat(79) + PARTY).slice(0, 80);
    // This is the literal wire text that reaches serde_json and blows up.
    expect(JSON.stringify(naive)).toContain("\\ud83c");
  });

  it("truncateOnBoundary output never emits a lone-surrogate escape", () => {
    const safe = truncateOnBoundary("x".repeat(79) + PARTY, 80);
    expect(JSON.stringify(safe)).not.toMatch(/\\ud[89ab][0-9a-f]{2}/i);
  });
});
