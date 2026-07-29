// The clamp, and the five-column width budget it has to answer to.
//
// What these pin is the thing the v0.63.0 resize report could not be diagnosed without: a drag that
// lands somewhere other than where it was aimed must say WHICH bound moved it. "It didn't move" is
// two different bugs — clamped, or not applied at all — and they have different fixes.
import { describe, expect, it } from "vitest";
import { clampWidth } from "./columnResize";

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
