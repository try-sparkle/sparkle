// The clamp, and the five-column width budget it has to answer to.
//
// What these pin is the thing the v0.63.0 resize report could not be diagnosed without: a drag that
// lands somewhere other than where it was aimed must say WHICH bound moved it. "It didn't move" is
// two different bugs — clamped, or not applied at all — and they have different fixes.
import { describe, expect, it } from "vitest";
import { clampWidth, windowAwareMax } from "./columnResize";

describe("clampWidth — the applied width, and why", () => {
  it("honours a request inside the range and reports no clamp", () => {
    expect(clampWidth(400, 280, 560)).toEqual({ requested: 400, applied: 400, clampedBy: null });
  });

  it("names the bound when it stops short of the request", () => {
    // The line the log was missing: requested 600, applied 560, clamped by max.
    expect(clampWidth(600, 280, 560)).toEqual({ requested: 600, applied: 560, clampedBy: "max" });
    expect(clampWidth(100, 280, 560)).toEqual({ requested: 100, applied: 280, clampedBy: "min" });
  });

  it("rounds the request before comparing, so a sub-pixel drag is not a clamp", () => {
    expect(clampWidth(279.6, 280, 560)).toEqual({ requested: 280, applied: 280, clampedBy: null });
  });

  it("reports the exact boundary values as UNCLAMPED", () => {
    // Off-by-one guard: sitting exactly on a bound is a width the user asked for and got.
    expect(clampWidth(280, 280, 560).clampedBy).toBeNull();
    expect(clampWidth(560, 280, 560).clampedBy).toBeNull();
  });

  it("surfaces an impossible range instead of silently inverting it", () => {
    const r = clampWidth(400, 500, 300);
    expect(r.applied).toBe(500);
    expect(r.clampedBy).toBe("min");
  });
});

// ── THE WINDOW IS A BOUND TOO (roborev 55847) ──────────────────────────────────────────────────
//
// A ceiling fixed at author time lets a column be dragged, or RESTORED from storage, wider than the
// window it shares — which puts its own resize handle past the viewport edge with `overflow: hidden`
// and no way back except editing localStorage. These pin the arithmetic that prevents it.
describe("windowAwareMax — a ceiling that knows how big the window is", () => {
  it("returns the hard ceiling when the window can afford it", () => {
    // 2000 - 600 = 1400 available, which is more than the column is ever allowed anyway.
    expect(windowAwareMax(1200, 2000, 600, 160)).toBe(1200);
  });

  it("LOWERS the ceiling when the window cannot, which is the whole point", () => {
    // The case that shipped broken: a 1000px window must not permit 1200.
    expect(windowAwareMax(1200, 1000, 600, 160)).toBe(400);
  });

  it("never returns less than the column's own minimum, so the range cannot invert", () => {
    // A window too narrow to satisfy even the reserve. Answering below `min` would make `clampWidth`
    // see min > max — a degenerate range, which is how a clamp starts returning nonsense.
    expect(windowAwareMax(1200, 500, 600, 160)).toBe(160);
    const degenerate = windowAwareMax(1200, 100, 600, 160);
    expect(degenerate).toBeGreaterThanOrEqual(160);
    expect(clampWidth(800, 160, degenerate).applied).toBe(160);
  });
});
