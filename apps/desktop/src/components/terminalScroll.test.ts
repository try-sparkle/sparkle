import { describe, it, expect } from "vitest";
import { wheelToScrollLines } from "./terminalScroll";

const CELL = 17;
const ROWS = 24;

describe("wheelToScrollLines", () => {
  it("scrolls one line down per cell-height of pixel delta", () => {
    const r = wheelToScrollLines({ deltaY: 17, deltaMode: 0 }, CELL, ROWS, 0);
    expect(r.lines).toBe(1);
    expect(r.carry).toBe(0);
  });

  it("scrolls up on negative delta", () => {
    const r = wheelToScrollLines({ deltaY: -34, deltaMode: 0 }, CELL, ROWS, 0);
    expect(r.lines).toBe(-2);
  });

  it("carries sub-line pixel deltas so small trackpad scrolls accumulate", () => {
    // 10px < one 17px cell → no line yet, but the remainder is kept...
    const a = wheelToScrollLines({ deltaY: 10, deltaMode: 0 }, CELL, ROWS, 0);
    expect(a.lines).toBe(0);
    expect(a.carry).toBe(10);
    // ...so the next 10px tips it over into one line, carrying the leftover.
    const b = wheelToScrollLines({ deltaY: 10, deltaMode: 0 }, CELL, ROWS, a.carry);
    expect(b.lines).toBe(1);
    expect(b.carry).toBe(20 - 17);
  });

  it("treats line-mode deltas as whole lines", () => {
    const r = wheelToScrollLines({ deltaY: 3, deltaMode: 1 }, CELL, ROWS, 0);
    expect(r.lines).toBe(3);
  });

  it("treats page-mode deltas as a screenful of rows", () => {
    const r = wheelToScrollLines({ deltaY: 1, deltaMode: 2 }, CELL, ROWS, 0);
    expect(r.lines).toBe(ROWS);
  });

  it("falls back to a default cell height when unmeasured", () => {
    const r = wheelToScrollLines({ deltaY: 17, deltaMode: 0 }, 0, ROWS, 0);
    expect(r.lines).toBe(1);
  });
});
