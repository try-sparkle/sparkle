import { describe, it, expect } from "vitest";
import {
  isMeasuredSize,
  spawnSize,
  isPlausibleFit,
  implausibleFitWarning,
  SPAWN_FALLBACK_COLS,
  SPAWN_FALLBACK_ROWS,
} from "./terminalSize";

describe("isMeasuredSize", () => {
  it("accepts a real, laid-out size", () => {
    expect(isMeasuredSize(true, { cols: 132, rows: 44 })).toBe(true);
  });

  it("rejects the tiny size fit() produces for a collapsed container", () => {
    // The exact symptom from the logs: a display:none pane fits to cols=12.
    expect(isMeasuredSize(true, { cols: 12, rows: 7 })).toBe(false);
  });

  it("rejects any size when the container is not laid out", () => {
    expect(isMeasuredSize(false, { cols: 132, rows: 44 })).toBe(false);
  });
});

describe("spawnSize", () => {
  it("uses the measured size when the container is laid out", () => {
    expect(spawnSize(true, { cols: 132, rows: 44 })).toEqual({ cols: 132, rows: 44 });
  });

  it("falls back to safe defaults for a collapsed container (the thin-column bug)", () => {
    // Spawning at cols=12 is what made the CLI hard-wrap into a thin column; never do it.
    expect(spawnSize(true, { cols: 12, rows: 7 })).toEqual({
      cols: SPAWN_FALLBACK_COLS,
      rows: SPAWN_FALLBACK_ROWS,
    });
  });

  it("falls back to safe defaults when the pane is hidden at spawn", () => {
    expect(spawnSize(false, { cols: 12, rows: 7 })).toEqual({
      cols: SPAWN_FALLBACK_COLS,
      rows: SPAWN_FALLBACK_ROWS,
    });
  });
});


// ---------------------------------------------------------------------------
// The RELATIVE guard (bead sparkle-l2xgf). Every number below is the founder's
// real one, taken from the app log and measured off the screenshot:
//   pty_spawn id=ea0662ec-… cols=23 rows=42   ← what the child was actually told
//   container ≈ 304 CSS px, fontSize ≈ 11 px  ← what the pane actually was
// 23 cols clears MIN_PLAUSIBLE_COLS (20), which is exactly why the old absolute
// floor let it through and the CLI wrapped mid-phrase for the whole session.
// ---------------------------------------------------------------------------
const BAD = { containerWidth: 304, fontSize: 11 }; // 304/23 ≈ 13.2px cell = 1.2em
const GOOD = { containerWidth: 304, fontSize: 11 }; // 304/43 ≈ 7.1px cell = 0.64em

describe("isPlausibleFit — a monospace cell is never as wide as its font-size", () => {
  it("REJECTS the founder's 23-col fit that the absolute floor accepted", () => {
    // The regression proof: the old gate said yes, the new one says no.
    expect(isMeasuredSize(true, { cols: 23, rows: 42 })).toBe(true);
    expect(isMeasuredSize(true, { cols: 23, rows: 42 }, BAD)).toBe(false);
  });

  it("accepts the fit the same box should have produced", () => {
    expect(isMeasuredSize(true, { cols: 43, rows: 42 }, GOOD)).toBe(true);
  });

  it("spawns at the safe fallback rather than hard-wrapping the CLI at 23 cols", () => {
    expect(spawnSize(true, { cols: 23, rows: 42 }, BAD)).toEqual({
      cols: SPAWN_FALLBACK_COLS,
      rows: SPAWN_FALLBACK_ROWS,
    });
  });

  it("is zoom-proof: the same grid at 2x font passes, because both sides scale", () => {
    // Doubling the font halves the cols the box holds; the ratio — the thing being tested — is
    // unchanged. A guard keyed on an absolute cell width would have failed exactly here.
    expect(isPlausibleFit({ cols: 21, rows: 42 }, { containerWidth: 304, fontSize: 22 })).toBe(true);
    expect(isPlausibleFit({ cols: 11, rows: 42 }, { containerWidth: 304, fontSize: 22 })).toBe(false);
  });

  it("FAILS OPEN when the context cannot answer, so it never weakens the floors", () => {
    for (const ctx of [
      undefined,
      { containerWidth: 0, fontSize: 11 },
      { containerWidth: 304, fontSize: 0 },
    ]) {
      expect(isPlausibleFit({ cols: 23, rows: 42 }, ctx)).toBe(true);
      // …and the absolute floor still rejects a collapsed box through the same call.
      expect(isMeasuredSize(true, { cols: 12, rows: 7 }, ctx)).toBe(false);
    }
  });
});

describe("implausibleFitWarning — the loud half", () => {
  it("names the measurement, the box, and what the box should have fitted", () => {
    const w = implausibleFitWarning({ cols: 23, rows: 42 }, BAD);
    expect(w).toContain("cols=23");
    expect(w).toContain("304px");
    expect(w).toContain("fontSize=11px");
    // The actionable number: what it SHOULD have been. Without it the warning is just a complaint.
    expect(w).toContain("~46 cols");
  });

  it("stays silent on a healthy fit", () => {
    expect(implausibleFitWarning({ cols: 43, rows: 42 }, GOOD)).toBeNull();
    expect(implausibleFitWarning({ cols: 23, rows: 42 }, undefined)).toBeNull();
  });
});
