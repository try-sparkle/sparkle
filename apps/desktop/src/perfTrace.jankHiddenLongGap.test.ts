// @vitest-environment jsdom
//
// The long-gap branch that fires when the window went hidden DURING the gap.
//
// It exists because `classifyJankGap` tests the hidden latch BEFORE the suspend threshold, so a gap
// past SUSPEND_MS that also overlapped an occlusion returns "ignore" and is recorded nowhere, at any
// level. That is not hypothetical: queued `visibilitychange` events dispatch when the main thread
// unblocks, ahead of the next rAF, so a genuine long block that occludes the window on its way — a
// window resize or move, the exact symptom this branch was written for — latches `hidden` and
// silences itself. The whole freeze this branch is named after produced no jank line for precisely
// this reason.
//
// So it is the long-gap branch MOST likely to be a real freeze, and it was the only one emitting no
// attribution: a reader who found the line had a duration and nothing to chase. These pin that it
// fires at all, and that it carries `during`/`rendered` the way its `resume` sibling does.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let pending: FrameRequestCallback | null = null;
let nowMs = 0;

const info = vi.fn();
const warn = vi.fn();

vi.mock("./logger", () => ({
  log: {
    info: (...a: unknown[]) => info(...a),
    warn: (...a: unknown[]) => warn(...a),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

/** Advance the clock by `ms` and run one rAF tick, as the browser would after a gap of that size. */
function tick(ms: number) {
  nowMs += ms;
  const cb = pending;
  pending = null;
  cb?.(nowMs);
}

/** Occlude the window and dispatch the event, which is what LATCHES `hidden` for the next tick. */
function occlude() {
  Object.defineProperty(document, "hidden", { value: true, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
}

function reveal() {
  Object.defineProperty(document, "hidden", { value: false, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
}

/** The hidden long-gap line, or undefined if it was never emitted. */
function hiddenGapLine(): Record<string, unknown> | undefined {
  const call = info.mock.calls.find(
    (c) => typeof c[1] === "string" && (c[1] as string).startsWith("long gap (window was hidden"),
  );
  return call?.[2] as Record<string, unknown> | undefined;
}

describe("startJankMonitor — a long gap the window went hidden during", () => {
  beforeEach(async () => {
    vi.resetModules();
    info.mockClear();
    warn.mockClear();
    pending = null;
    nowMs = 0;
    reveal();
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      pending = cb;
      return 1;
    });
    vi.spyOn(performance, "now").mockImplementation(() => nowMs);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    reveal();
  });

  it("reports a 30s gap that occluded, which the verdict alone would have dropped entirely", async () => {
    const { startJankMonitor, __resetRenderTraceForTest, __resetTracesForTest } = await import(
      "./perfTrace"
    );
    __resetRenderTraceForTest();
    __resetTracesForTest();
    startJankMonitor(150);
    tick(16); // one healthy visible frame
    occlude(); // the window goes away mid-gap, as it does when a blocked main thread stops drawing
    tick(30_000);

    const line = hiddenGapLine();
    expect(line, "a 30s gap that occluded must not vanish from the log").toBeDefined();
    expect(line).toMatchObject({ ms: 30_000, hidden: true });
    // Not a stall: the verdict is still "ignore", so nothing should claim 30s of main-thread work.
    expect(warn).not.toHaveBeenCalled();
  });

  // The assertion that could not have passed before the fix: the branch emitted only
  // ms/wallMs/hidden/heapMb/win, so the freeze most likely to be real was the one with no clue as to
  // what caused it.
  it("names what rendered across the freeze, so the line is something a reader can chase", async () => {
    const { startJankMonitor, perfRender, __resetRenderTraceForTest, __resetTracesForTest } =
      await import("./perfTrace");
    __resetRenderTraceForTest();
    __resetTracesForTest();
    startJankMonitor(150);
    tick(16);
    for (let i = 0; i < 40; i++) perfRender("Workspace", "root");
    perfRender("Sidebar", "root");
    occlude();
    tick(30_000);

    expect(hiddenGapLine()).toMatchObject({
      ms: 30_000,
      hidden: true,
      rendered: "Workspace×40, Sidebar",
    });
  });

  it("attributes the freeze to an interaction that was in flight across it", async () => {
    const { startJankMonitor, perfStart, __resetRenderTraceForTest, __resetTracesForTest } =
      await import("./perfTrace");
    __resetRenderTraceForTest();
    __resetTracesForTest();
    startJankMonitor(150);
    tick(16);
    perfStart("resize-1", "window-resize");
    occlude();
    tick(30_000);

    expect(hiddenGapLine()).toMatchObject({ ms: 30_000, during: "window-resize" });
  });

  // The neighbouring cases that must NOT have changed — otherwise this branch becomes the noise
  // that got the whole class of long-gap logging demoted to debug in the first place.
  it("stays quiet for an ordinary short gap in a hidden window", async () => {
    const { startJankMonitor, __resetRenderTraceForTest, __resetTracesForTest } = await import(
      "./perfTrace"
    );
    __resetRenderTraceForTest();
    __resetTracesForTest();
    startJankMonitor(150);
    tick(16);
    occlude();
    tick(3_000); // long enough to be a stall if visible, far short of the suspend threshold

    expect(hiddenGapLine()).toBeUndefined();
  });

  it("does not fire for a long gap the window stayed visible through — that is the resume branch", async () => {
    const { startJankMonitor, __resetRenderTraceForTest, __resetTracesForTest } = await import(
      "./perfTrace"
    );
    __resetRenderTraceForTest();
    __resetTracesForTest();
    startJankMonitor(150);
    tick(16);
    tick(30_000);

    expect(hiddenGapLine()).toBeUndefined();
    expect(
      info.mock.calls.some(
        (c) => c[1] === "long gap (suspend or main-thread block)",
      ),
      "the visible long gap belongs to the resume branch, which must still own it",
    ).toBe(true);
  });
});
