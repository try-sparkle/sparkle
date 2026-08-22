// @vitest-environment jsdom
//
// The aggregate this module used to compute and throw away. `takePendingStallMs` is what the
// heartbeat hands to the Rust watchdog's cumulative-stall trigger (`STALL_BUDGET_MS` in
// src-tauri/src/watchdog.rs), so what counts as a stall HERE is what the bar over there is measured
// against — there is one definition, and these are its tests.
//
// The case that motivated it: a 30-second unusable window in which the UI stalled 7-13 times a
// minute and never once for the five seconds the silence detector needs. Every instrument green.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Same manually-driven rAF harness as perfTrace.jankRollup.test.ts: each tick queues the next, so
// the test holds the pending callback and fires it with the clock wherever it wants.
let pending: FrameRequestCallback | null = null;
let nowMs = 0;

vi.mock("./logger", () => ({ log: { info: vi.fn(), debug: vi.fn(), warn: vi.fn() } }));

function tick(ms: number) {
  nowMs += ms;
  const cb = pending;
  pending = null;
  cb?.(nowMs);
}

function setHidden(hidden: boolean) {
  Object.defineProperty(document, "hidden", { value: hidden, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
}

let takePendingStallMs: () => number;

describe("stall budget accounting", () => {
  beforeEach(async () => {
    vi.resetModules();
    pending = null;
    nowMs = 0;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      pending = cb;
      return 1;
    });
    vi.spyOn(performance, "now").mockImplementation(() => nowMs);
    Object.defineProperty(document, "hidden", { value: false, configurable: true });
    const mod = await import("./perfTrace");
    takePendingStallMs = mod.takePendingStallMs;
    mod.startJankMonitor(150);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete (document as { hidden?: boolean }).hidden;
  });

  // THE MEASURED WINDOW, frame by frame: the one severe stall (2049ms) and three minors at the
  // observed maxima (610, 717, 956). The rollup line reports these; until now nothing acted on them.
  //
  // Both branches in ONE assertion on purpose: the severe stall bypasses the rollup entirely, so an
  // accumulator wired into the minor branch alone would silently drop the biggest stalls of all —
  // exactly the ones a hang budget is for.
  it("counts every stall the monitor sees, severe and minor alike", () => {
    tick(2_049); // severe: warns on its own line
    tick(610); // minor: coalesced into the rollup
    tick(717);
    tick(956);
    expect(takePendingStallMs()).toBe(2_049 + 610 + 717 + 956);
  });

  it("does not count a healthy frame", () => {
    tick(100); // under the 150ms threshold — not a stall by any definition here
    tick(120);
    expect(takePendingStallMs()).toBe(0);
  });

  // A DRAIN, NOT A READ. Each millisecond of stall belongs to exactly one heartbeat; a read would
  // have the watchdog's rolling window count the same bad second on every beat until the next stall
  // replaced it — which turns any single stall into a trigger given enough beats.
  it("hands each millisecond to exactly one beat", () => {
    tick(956);
    expect(takePendingStallMs()).toBe(956);
    expect(takePendingStallMs()).toBe(0);
    tick(610);
    expect(takePendingStallMs()).toBe(610);
  });

  // ── THE TWO FALSE POSITIVES THAT WOULD MAKE THE TRIGGER USELESS ─────────────────────────────
  // rAF is paused while the window is hidden, so the whole background interval arrives as one giant
  // gap on the first tick back. Counting it would put minutes of "stall" into a ten-second budget
  // and fire the hang trigger on every cmd-tab — on a perfectly healthy app, spending the visible
  // capture floor and evicting real stacks from a finite pool.
  it("does not count a gap accrued while the window was hidden", () => {
    setHidden(true);
    tick(30_000);
    expect(takePendingStallMs()).toBe(0);
  });

  // Same shape, different cause: past SUSPEND_MS the machine was asleep, and a sleeping machine is
  // not a blocked main thread. The watchdog adjudicates that case directly from its own tick
  // overshoot; feeding it here would report a hang on every lid-open.
  it("does not count a suspend/resume gap", () => {
    tick(30_000); // >= SUSPEND_MS (10s): classified "resume", not "stall"
    expect(takePendingStallMs()).toBe(0);
  });

  // The paired positive for both cases above: absence proves nothing on its own, since an
  // accumulator that never counts anything passes all three. The SAME harness, with a gap in the
  // stall band, must reach the accumulator.
  it("still counts a stall in the same harness that rejects those two", () => {
    tick(2_049);
    expect(takePendingStallMs()).toBe(2_049);
  });
});
