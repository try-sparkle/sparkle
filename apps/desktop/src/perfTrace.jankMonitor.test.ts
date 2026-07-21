// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The rAF loop is driven manually: each startJankMonitor tick queues the next one, so the test
// holds the pending callback and fires it with the clock wherever it wants.
let pending: FrameRequestCallback | null = null;
let nowMs = 0;

const warn = vi.fn();
const debug = vi.fn();

vi.mock("./logger", () => ({
  log: { info: vi.fn(), debug: (...a: unknown[]) => debug(...a), warn: (...a: unknown[]) => warn(...a) },
}));

/** Advance the clock by `ms` and run one rAF tick, as the browser would after a gap of that size. */
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

describe("startJankMonitor hidden-window accounting", () => {
  beforeEach(async () => {
    vi.resetModules();
    warn.mockClear();
    debug.mockClear();
    pending = null;
    nowMs = 0;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      pending = cb;
      return 1;
    });
    vi.spyOn(performance, "now").mockImplementation(() => nowMs);
    setHidden(false);
    const { startJankMonitor } = await import("./perfTrace");
    startJankMonitor(150);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("warns on a real stall while the window stayed visible", () => {
    tick(3326);
    expect(warn).toHaveBeenCalledWith("perf", "jank stall", expect.objectContaining({ ms: 3326 }));
  });

  // The regression: the window is hidden (rAF pauses), the user comes back, and the first tick
  // observes the whole backgrounded interval. document.hidden already reads false by then, so the
  // old tick-time check let this through as a multi-second "stall".
  it("does not warn for the gap accrued while the window was hidden", () => {
    tick(16); // steady state
    setHidden(true); // window occluded — rAF pauses here
    setHidden(false); // user returns; the pending tick now fires with the whole gap
    expect(document.hidden).toBe(false); // precisely why the tick-time check could not work
    tick(2952);
    expect(warn).not.toHaveBeenCalled();
    expect(debug).not.toHaveBeenCalled();
  });

  it("resumes warning on genuine stalls after the hidden gap is consumed", () => {
    setHidden(true);
    setHidden(false);
    tick(2952); // swallowed
    expect(warn).not.toHaveBeenCalled();
    tick(1400); // a real freeze, window visible throughout (severe, so it warns on its own line)
    expect(warn).toHaveBeenCalledWith("perf", "jank stall", expect.objectContaining({ ms: 1400 }));
  });
});
