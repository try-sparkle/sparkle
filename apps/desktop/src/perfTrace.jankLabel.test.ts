// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

// The rAF loop is driven manually: each startJankMonitor tick queues the next one, so the test
// holds the pending callback and fires it with the clock wherever it wants.
let pending: FrameRequestCallback | null = null;
let nowMs = 0;

const info = vi.fn();
const warn = vi.fn();
const debug = vi.fn();

vi.mock("./logger", () => ({
  log: {
    info: (...a: unknown[]) => info(...a),
    debug: (...a: unknown[]) => debug(...a),
    warn: (...a: unknown[]) => warn(...a),
  },
}));

/** Advance the clock by `ms` and run one rAF tick, as the browser would after a gap of that size. */
function tick(ms: number) {
  nowMs += ms;
  const cb = pending;
  pending = null;
  cb?.(nowMs);
}

/** The meta object of the last call to a mocked log fn. */
function lastMeta(fn: ReturnType<typeof vi.fn>): Record<string, unknown> {
  return fn.mock.calls.at(-1)?.[2] as Record<string, unknown>;
}

describe("startJankMonitor window labelling", () => {
  beforeEach(() => {
    vi.resetModules();
    info.mockClear();
    warn.mockClear();
    debug.mockClear();
    pending = null;
    nowMs = 0;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      pending = cb;
      return 1;
    });
    vi.spyOn(performance, "now").mockImplementation(() => nowMs);
  });

  // Gaps must clear JANK_SEVERE_MS (1000) to get their own warn line. A sub-severe stall is
  // coalesced into the periodic rollup instead — covered separately below.
  it("stamps a stall with the window label it was given", async () => {
    const { startJankMonitor } = await import("./perfTrace");
    startJankMonitor(150, "w-7");
    tick(0);
    tick(1200);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(lastMeta(warn)).toMatchObject({ ms: 1200, win: "w-7" });
  });

  it("defaults to the main window when no label is given", async () => {
    const { startJankMonitor } = await import("./perfTrace");
    startJankMonitor(150);
    tick(0);
    tick(1200);

    expect(lastMeta(warn)).toMatchObject({ win: "main" });
  });

  it("labels the coalesced minor-stall rollup as well as the severe line", async () => {
    // The rollup is the line most minor stalls actually arrive on, so it needs the label for the
    // same reason the warn does: N windows each emit their own, and they are otherwise identical.
    const { startJankMonitor } = await import("./perfTrace");
    startJankMonitor(150, "w-7");
    tick(0);
    tick(400); // sub-severe → counted, not warned
    expect(warn).not.toHaveBeenCalled();

    // Elapse the 60s rollup window in healthy frames so the pending window flushes.
    for (let elapsed = 0; elapsed < 61_000; elapsed += 100) tick(100);

    const rollup = info.mock.calls.filter((c) => c[1] === "jank minor stalls").at(-1);
    expect(rollup?.[2]).toMatchObject({ count: 1, win: "w-7" });
  });

  it("labels the startup line and a suspend resume too", async () => {
    const { startJankMonitor } = await import("./perfTrace");
    startJankMonitor(150, "w-7");
    expect(lastMeta(info)).toMatchObject({ win: "w-7" });

    tick(0);
    tick(60_000); // past SUSPEND_MS — a wake, recorded as a debug resume rather than a warn.
    expect(warn).not.toHaveBeenCalled();
    expect(lastMeta(debug)).toMatchObject({ win: "w-7" });
  });
});
