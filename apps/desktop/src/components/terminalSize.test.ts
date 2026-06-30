import { describe, it, expect } from "vitest";
import {
  isMeasuredSize,
  spawnSize,
  convergeStep,
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

describe("convergeStep", () => {
  it("waits while the revealed pane has not laid out a box yet", () => {
    // display:none→flex hasn't produced a box this frame: keep retrying, don't sync a stale size.
    expect(convergeStep(false, false, 60)).toBe("wait");
  });

  it("waits when laid out but the fit is still a collapsed/tiny (unmeasured) size", () => {
    // The container has a box but fit() is still proposing a thin-column size — not safe to push.
    expect(convergeStep(true, false, 60)).toBe("wait");
  });

  it("syncs once the pane is laid out AND the fitted size is plausible", () => {
    expect(convergeStep(true, true, 60)).toBe("sync");
  });

  it("gives up after the frame budget is exhausted (the ResizeObserver remains the backstop)", () => {
    // Never spin forever: a pane that never lays out (stays hidden) stops retrying.
    expect(convergeStep(false, false, 0)).toBe("give-up");
  });

  it("still syncs on the last frame if the pane just became measured", () => {
    // A measured pane syncs even with no frames left — sync wins over give-up.
    expect(convergeStep(true, true, 0)).toBe("sync");
  });
});
