import { describe, it, expect } from "vitest";
import {
  isMeasuredSize,
  spawnSize,
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
