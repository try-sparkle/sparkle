import { describe, expect, it } from "vitest";
import { OVERLAP_MAX_INPUT_CHARS, collapseWhitespace, longestOverlap } from "./overlap";

describe("collapseWhitespace", () => {
  it("collapses every whitespace run to one space and trims the ends", () => {
    expect(collapseWhitespace("  a\n\n b\t\tc  ")).toBe("a b c");
  });
});

describe("longestOverlap", () => {
  it("returns the exact length and text of the longest shared run", () => {
    const hit = longestOverlap("xx the quick brown fox yy", ["zz the quick brown fox ww"]);
    expect(hit.text).toBe(" the quick brown fox ");
    expect(hit.length).toBe(" the quick brown fox ".length);
  });

  it("measures the LONGEST run, not the first or the total", () => {
    // "abc" appears first; " wxyz-longer " (spaces included — they are shared too) is longer.
    const hit = longestOverlap("abc ... wxyz-longer ...", ["abc / wxyz-longer /"]);
    expect(hit.text).toBe(" wxyz-longer ");
    expect(hit.length).toBe(13);
  });

  it("sees through re-wrapping, which is the whole reason whitespace is collapsed", () => {
    const a = "the build finished and the tests are green";
    const b = "the   build\nfinished   and\n\nthe tests are green";
    expect(longestOverlap(a, [b]).length).toBe(a.length);
  });

  it("takes the best across several candidates", () => {
    const hit = longestOverlap("alpha beta gamma delta", ["gamma delta", "beta gamma delta"]);
    expect(hit.text).toBe("beta gamma delta");
  });

  it("is zero when there is no shared run, no candidate, or an empty side", () => {
    expect(longestOverlap("abcdef", ["uvwxyz"]).length).toBe(0);
    expect(longestOverlap("abcdef", []).length).toBe(0);
    expect(longestOverlap("", ["abcdef"]).length).toBe(0);
    expect(longestOverlap("abcdef", [""]).length).toBe(0);
  });

  it("finds a single shared character when that is all there is", () => {
    expect(longestOverlap("abc", ["zzcz"])).toEqual({ length: 1, text: "c" });
  });

  it("caps the measured overlap at the documented input cap", () => {
    const huge = "q".repeat(OVERLAP_MAX_INPUT_CHARS * 2);
    expect(longestOverlap(huge, [huge]).length).toBe(OVERLAP_MAX_INPUT_CHARS);
  });

  it("stays fast on a 10KB reply against several KB of candidates", () => {
    const reply = "lorem ipsum dolor sit amet ".repeat(400); // ~10.8KB
    const candidates = ["consectetur adipiscing elit ".repeat(100), reply.slice(0, 3000)];
    const started = performance.now();
    const hit = longestOverlap(reply, candidates);
    const elapsed = performance.now() - started;
    expect(hit.length).toBeGreaterThanOrEqual(3000 - 1);
    // A quadratic scan over these sizes is ~10^7-10^8 cell updates and would blow this budget by
    // orders of magnitude; the binary-search + rolling-hash engine finishes in milliseconds.
    expect(elapsed).toBeLessThan(2000);
  });
});
