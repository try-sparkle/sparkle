// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
    // Pin it rather than trusting the jsdom default: classifyJankGap consults `document.hidden`, so
    // an unpinned value would silently decide whether these gaps are stalls at all.
    Object.defineProperty(document, "hidden", { value: false, configurable: true });
  });

  // The rAF stub and the performance.now spy are process-global; restore them so this file cannot
  // decide the outcome of whatever runs next (perfTrace.jankMonitor/jankRollup do the same). The
  // hidden-window case below leaves an own `hidden` property that neither vitest helper removes;
  // deleting it (rather than re-pinning to false) restores jsdom's prototype getter, so `hidden`
  // tracks `visibilityState` again instead of being frozen at whatever this file last wrote. The
  // sibling suites pin `hidden` the same way and now delete it the same way.
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete (document as { hidden?: boolean }).hidden;
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

    // Assert the warn happened before reading its meta: if the severity split moves again and this
    // gap stops warning, `lastMeta` is undefined and the matcher fails for the wrong reason — which
    // is exactly how these tests went stale under the JANK_SEVERE_MS split.
    expect(warn).toHaveBeenCalledTimes(1);
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
    expect(rollup).toBeDefined();
    expect(rollup?.[2]).toMatchObject({ count: 1, win: "w-7" });
  });

  it("labels the rollup the hidden-window path force-flushes", async () => {
    // The other way a rollup reaches the log: a gap rAF did not run across closes the open window
    // early, so the stalls are reported over the span they actually happened in. The behaviour of
    // that call site is covered by perfTrace.jankRollup.test.ts ("closes the open window before a
    // hidden gap rather than spanning it") — what is NOT covered there is that its line carries the
    // label, which is this test.
    const { startJankMonitor } = await import("./perfTrace");
    startJankMonitor(150, "w-7");
    tick(0);
    tick(400); // sub-severe → pending in the rollup window
    // Real activity before backgrounding, so the flushed span is a genuine ~5s rather than the
    // degenerate 0 that `openedAt === now - gap` would otherwise produce. A zero would also match a
    // flush at `openedAt`, and would break on a behaviour-preserving change to where `openedAt` is
    // stamped; a bounded assertion on a non-degenerate span discriminates what this test is about.
    for (let elapsed = 0; elapsed < 5_000; elapsed += 100) tick(100);

    // Background the window, then flip `hidden` BACK before ticking, as the browser does: rAF only
    // resumes once the window is visible again. That is what makes the latch the only thing that can
    // produce the "ignore" verdict — with `hidden` left true the test would pass just as well
    // against an implementation that sampled document.hidden at tick time, i.e. against the exact
    // bug classifyJankGap's latch exists to prevent. Mirrors the sibling rollup suite.
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "hidden", { value: false, configurable: true });
    tick(5_000); // the whole backgrounded interval, observed by the first tick after the return

    expect(warn).not.toHaveBeenCalled();
    const rollup = info.mock.calls.filter((c) => c[1] === "jank minor stalls").at(-1);
    expect(rollup).toBeDefined();
    expect(rollup?.[2]).toMatchObject({ count: 1, win: "w-7" });
    // sinceMs is what pins this to the FORCE-flush: the window closes at `now - gap`, so it covers
    // the ~5s the stalls actually happened in and NOT the 5s pause. A regression that flushed at
    // `now` would report ~10s here — the 5.9-hour sinceMs the implementation comment documents.
    expect(rollup?.[2].sinceMs).toBeLessThan(6_000);
    // Bounded from below too, or a flush at `openedAt` (sinceMs 0) still passes. Not pinned AT the
    // observed 5000: that would fail on the openedAt-stamping change this test says it tolerates.
    expect(rollup?.[2].sinceMs).toBeGreaterThan(1_000);
  });

  // The merge-guard test. `win` (PR #460) and `during` (PR #489) were added to the SAME severe-stall
  // warn by two different branches, so resolving that conflict is exactly where one of them gets
  // silently dropped — it happened once already. `win` is pinned by the tests above; `during` was
  // only covered at the openTraceKinds() unit level, so deleting it from the warn meta left the
  // whole suite green. Assert both on one line.
  it("carries BOTH the window label and the in-flight interaction on a severe stall", async () => {
    const { startJankMonitor, perfStart } = await import("./perfTrace");
    startJankMonitor(150, "w-7");
    perfStart("agent-1", "spawn");
    tick(0);
    tick(1200);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(lastMeta(warn)).toMatchObject({ ms: 1200, win: "w-7", during: "spawn" });
  });

  it("labels the startup line and a suspend resume too", async () => {
    const { startJankMonitor } = await import("./perfTrace");
    startJankMonitor(150, "w-7");
    expect(info).toHaveBeenCalledTimes(1);
    expect(lastMeta(info)).toMatchObject({ win: "w-7" });

    tick(0);
    tick(60_000); // past SUSPEND_MS — a wake, recorded as a debug resume rather than a warn.
    expect(warn).not.toHaveBeenCalled();
    // Same reason as the warn assertions above: if the resume stops being emitted, assert on the
    // missing line rather than letting toMatchObject fail against an undefined meta.
    expect(debug).toHaveBeenCalledTimes(1);
    expect(lastMeta(debug)).toMatchObject({ win: "w-7" });
  });
});
