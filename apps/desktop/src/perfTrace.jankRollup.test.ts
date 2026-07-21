// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Same manually-driven rAF harness as perfTrace.jankMonitor.test.ts: each tick queues the next, so
// the test holds the pending callback and fires it with the clock wherever it wants.
let pending: FrameRequestCallback | null = null;
let nowMs = 0;

const warn = vi.fn();
const info = vi.fn();

vi.mock("./logger", () => ({
  log: { info: (...a: unknown[]) => info(...a), debug: vi.fn(), warn: (...a: unknown[]) => warn(...a) },
}));

function tick(ms: number) {
  nowMs += ms;
  const cb = pending;
  pending = null;
  cb?.(nowMs);
}

/** The meta payload of each rollup line, in order. The "jank monitor started" line shares the info
 *  channel, so filter by message. */
function rollups(): Record<string, number>[] {
  return info.mock.calls
    .filter((c) => c[1] === "jank minor stalls")
    .map((c) => c[2] as Record<string, number>);
}

/** Advance `ms` of healthy frames. Each step is under the 150ms threshold so it contributes no
 *  stalls, which is how a rollup window elapses in practice — one big gap would instead be a stall
 *  (or, past SUSPEND_MS, a resume) and confound what the test is asserting. */
function quiet(ms: number) {
  for (let elapsed = 0; elapsed < ms; elapsed += 100) tick(100);
}

describe("jank minor-stall rollup", () => {
  beforeEach(async () => {
    vi.resetModules();
    warn.mockClear();
    info.mockClear();
    pending = null;
    nowMs = 0;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      pending = cb;
      return 1;
    });
    vi.spyOn(performance, "now").mockImplementation(() => nowMs);
    Object.defineProperty(document, "hidden", { value: false, configurable: true });
    const { startJankMonitor } = await import("./perfTrace");
    startJankMonitor(150);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // The flood this exists to stop: a near-threshold stall is real but imperceptible, and there are
  // thousands a day. They are counted, never warned.
  it("does not warn for a sub-severe stall", () => {
    tick(221); // the observed median stall
    expect(warn).not.toHaveBeenCalled();
  });

  it("still warns immediately for a severe stall", () => {
    // 4000ms: comfortably severe (>= JANK_SEVERE_MS, 1s) and comfortably below SUSPEND_MS (10s).
    //
    // This fixture used to be 13154 — "the observed p99". That value stopped being a STALL when
    // gaps of 10-30s were reclassified as suspend/resume (a sleeping machine, not a freeze), so the
    // case silently stopped testing what it names. Both changes were right on their own and landed
    // days apart; the collision only appeared once both were on main. Picking a value in the middle
    // of the severe band keeps this pinned to "severe stalls bypass the rollup" rather than to
    // whichever threshold happens to bound it.
    tick(4000);
    expect(warn).toHaveBeenCalledWith("perf", "jank stall", expect.objectContaining({ ms: 4000 }));
    expect(rollups()).toHaveLength(0);
  });

  it("a 10s+ gap is a suspend/resume, NOT a severe stall — the boundary that broke this file", () => {
    // Pins the interaction directly, so the next change to either threshold fails here loudly
    // instead of quietly turning the test above into a no-op.
    tick(13154); // the old fixture: now a resume, not a stall
    expect(warn).not.toHaveBeenCalledWith("perf", "jank stall", expect.anything());
  });

  it("emits one rollup carrying count/total/max once the window elapses", () => {
    tick(200);
    tick(400);
    tick(300);
    expect(rollups()).toHaveLength(0); // still inside the window — counted, not logged
    quiet(60_000);
    expect(rollups()[0]).toMatchObject({ count: 3, totalMs: 900, maxMs: 400 });
    expect(warn).not.toHaveBeenCalled(); // none of the three was severe
  });

  // Regression guard on the flood itself: many minor stalls inside one window must collapse to one
  // line, not decay back toward one line each.
  it("collapses a burst of minor stalls into a single line", () => {
    for (let i = 0; i < 200; i++) tick(200); // 40s of stalls, inside one window
    quiet(60_000);
    expect(rollups()).toHaveLength(1);
    expect(rollups()[0]).toMatchObject({ count: 200 });
    expect(warn).not.toHaveBeenCalled();
  });

  // The window opens at the first pending stall, not on a free-running clock, so a lone stall after
  // a long quiet stretch waits out a full window rather than flushing by itself.
  it("does not flush a lone stall before its window has elapsed", () => {
    quiet(70_000); // longer than a rollup window, but with nothing pending
    tick(200);
    quiet(1_000);
    expect(rollups()).toHaveLength(0);
  });

  // A severe stall reports itself immediately; it must not disturb the minors already pending.
  it("warns for a severe stall mid-window without disturbing the pending minors", () => {
    tick(200);
    tick(300);
    tick(4000); // severe, arrives mid-window
    tick(250);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("perf", "jank stall", expect.objectContaining({ ms: 4000 }));
    quiet(60_000);
    // The severe stall is reported on its own line, so it is absent from the rollup's totals.
    expect(rollups()[0]).toMatchObject({ count: 3, totalMs: 750, maxMs: 300 });
  });

  it("reports sinceMs as the span the window covered", () => {
    tick(200);
    quiet(60_000);
    const { sinceMs } = rollups()[0]!;
    expect(sinceMs).toBeGreaterThanOrEqual(60_000);
    expect(sinceMs).toBeLessThan(61_000);
  });

  // A window must not straddle a suspend: the slept interval is wall-clock the app wasn't running,
  // and folding it into sinceMs would make a normal window read as a near-zero stall rate.
  it("closes the open window before a suspend rather than spanning it", () => {
    tick(200);
    tick(300);
    quiet(5_000);
    tick(8 * 60 * 60 * 1000); // machine slept eight hours
    const [rollup] = rollups();
    expect(rollup).toMatchObject({ count: 2, totalMs: 500 });
    // Spans the pre-suspend activity only — not the eight slept hours.
    expect(rollup!.sinceMs).toBeLessThan(6_000);
  });

  it("starts a fresh window after a flush", () => {
    tick(200);
    quiet(60_000); // flushes window 1
    expect(rollups()).toHaveLength(1);
    tick(300);
    quiet(60_000); // flushes window 2
    expect(rollups()).toHaveLength(2);
    expect(rollups()[1]).toMatchObject({ count: 1, maxMs: 300 });
  });
});
