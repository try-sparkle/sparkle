// settleSwitchTrace drives the "switch:<id>" perf waterfall from a pane's visibility.
//
// The bug this pins: `selectAgent` starts the trace on EVERY selection, but a pane only becomes
// visible when no overlay (Tasks board / Sparkle pane) covers the panes. Selecting under an overlay
// therefore painted nothing and left the trace open — so dismissing the overlay minutes later ended
// it and logged that idle dwell as "switch painted (total)". In one day's session that showed up as
// ~500 switch starts against ~470 ends, with the survivors reporting inflated totals.
//
// Real perfTrace + a logger spy, so these assert on what actually reaches the perf log.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const infoSpy = vi.fn();

vi.mock("../logger", () => ({
  log: { info: (...a: unknown[]) => infoSpy(...a), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

let settleSwitchTrace: typeof import("./AgentPane").settleSwitchTrace;
let perfStart: typeof import("../perfTrace").perfStart;

// requestAnimationFrame callbacks are collected so a test can decide whether the "paint" happens.
let frames: FrameRequestCallback[] = [];
const paint = () => {
  const due = frames;
  frames = [];
  due.forEach((cb) => cb?.(0));
};

/** The perf-log messages emitted so far (the `${kind} ${milestone}` argument). */
const messages = () => infoSpy.mock.calls.map((c) => c[1] as string);

beforeEach(async () => {
  vi.resetModules();
  infoSpy.mockClear();
  frames = [];
  // Hand out 1-based handles and honour cancellation by clearing the slot, so a cancelled frame
  // genuinely never runs — a no-op stub would let a test "pass" without exercising the cleanup.
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
  vi.stubGlobal("cancelAnimationFrame", (h: number) => {
    frames[h - 1] = undefined as unknown as FrameRequestCallback;
  });
  ({ settleSwitchTrace } = await import("./AgentPane"));
  ({ perfStart } = await import("../perfTrace"));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("settleSwitchTrace", () => {
  it("ends the trace once the pane paints — the switch that actually happened is measured", () => {
    perfStart("switch:a1", "switch");
    settleSwitchTrace("switch:a1", true);
    // Nothing is recorded until the frame lands: the metric is click→PAINT, not click→commit.
    expect(messages()).toEqual(["switch start"]);
    paint();
    expect(messages()).toEqual(["switch start", "switch painted (total)"]);
  });

  it("abandons a trace for a pane that stays hidden, so a later reveal can't report idle dwell as switch latency", () => {
    perfStart("switch:a1", "switch");
    // Selection landed while an overlay covered the panes → this pane never turns visible.
    settleSwitchTrace("switch:a1", false);

    // The overlay is dismissed much later and the pane finally paints. Pre-fix this closed the
    // still-open trace and logged the whole overlay dwell as the switch total.
    settleSwitchTrace("switch:a1", true);
    paint();

    expect(messages()).toEqual(["switch start"]);
    expect(messages()).not.toContain("switch painted (total)");
  });

  it("cancels the pending frame on cleanup, so a pane torn down before painting records nothing", () => {
    perfStart("switch:a1", "switch");
    const cleanup = settleSwitchTrace("switch:a1", true);
    // Cleanup alone must be enough: the trace is deliberately left in the map here, so the only
    // thing that can stop the end is the frame actually being cancelled.
    cleanup?.();
    paint();
    expect(messages()).toEqual(["switch start"]);
  });

  it("returns no cleanup for a hidden pane and is a no-op when no switch was in flight", () => {
    expect(settleSwitchTrace("switch:never-selected", false)).toBeUndefined();
    // A pane becoming visible without a selection (boot-restored pane, re-render) records nothing.
    settleSwitchTrace("switch:never-selected", true);
    paint();
    expect(messages()).toEqual([]);
  });
});
