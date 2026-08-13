import { describe, it, expect } from "vitest";
import { steady, VOLATILE_SPAN } from "./promptTextNormalize";

// This file exists because `VOLATILE_SPAN` had a ReDoS in its percentage arm and NOTHING covered
// this module (bead sparkle-70btv). The bound test below is the point; the behaviour tests are here
// so a future "simplification" of the lookbehind cannot quietly change what gets normalised.

describe("steady — volatile-span normalisation", () => {
  it("neutralises each moving shape while keeping the surrounding text", () => {
    expect(steady("50%")).toBe("#");
    expect(steady("  12.5 %")).toBe("  #");
    expect(steady("(3120/6640)")).toBe("#");
    expect(steady("1m 20s remaining")).toBe("# remaining");
    expect(steady("⠋ loading")).toBe("# loading");
    // The case roborev 55170/55172 is about: an ordinary question is volatile by this pattern, so
    // the SPAN is replaced and the distinguishing text survives.
    expect(steady("Delete 2.3 GB of build artifacts? [y/n]")).toBe("Delete # of build artifacts? [y/n]");
    expect(steady("100% done (1/2) 4 GB 3m 2s")).toBe("# done # # #");
    expect(steady("no volatile content")).toBe("no volatile content");
  });

  // These three pin the exact boundary the `(?<!\d)` introduces. A wider lookbehind — `(?<![\d.])`,
  // the form written first for the sibling patterns in engine/statusEngine.ts — changes the second
  // and third of these, so they are the guard against "tidying" it to match.
  it("keeps matching a figure that follows a letter or a dot", () => {
    expect(steady("abc50%")).toBe("abc#");
    expect(steady("1.2.3%")).toBe("1.#");
    expect(steady("12a3%")).toBe("12a#");
  });

  // THE REGRESSION. `VOLATILE_SPAN` is a `/g` regex driven through `.replace`, so a bare `\d+` in
  // the percentage arm restarts at every offset of a long digit run and re-scans the remainder each
  // time. Measured at 18_221ms on this exact input before the fix, 0.8ms after — so the 2s bound is
  // a ~4-order-of-magnitude margin, not a tight timing assertion. Bounded time IS the defect here,
  // which is why this asserts elapsed time rather than a return value.
  it("normalises a long digit run in bounded time", () => {
    const flood = "1234567890".repeat(3200); // 32k digits
    const started = performance.now();
    expect(steady(flood)).toBe(flood); // nothing volatile in it — the point is that it RETURNS
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it("is declared global, which is what makes the restart cost compound", () => {
    // Pins the flag the bound above depends on: without /g, `.replace` stops at the first match and
    // the quadratic never shows, so a future flag change must re-read the note in the source.
    expect(VOLATILE_SPAN.flags).toContain("g");
  });
});
