// perfSpan / perfSpanAsync only log operations that ate a whole frame's budget (≥16ms). A span
// below one frame dropped no frame, so it isn't worth a line — this is what stops the rehydrate +
// persist spans from flooding the perf log with tens of thousands of imperceptible sub-frame lines
// a day while still surfacing the rare 50–750ms rehydrate the instrument exists to catch.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Drive perfNow() by controlling performance.now so each span has a deterministic duration: the
// value advances by a fixed delta between the span's t0 read and its final read.
const nowMock = vi.fn<() => number>();
const infoSpy = vi.fn();

vi.mock("./logger", () => ({
  log: {
    info: (scope: string, message: string, data?: unknown) => infoSpy(scope, message, data),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

let perfSpan: typeof import("./perfTrace").perfSpan;
let perfSpanAsync: typeof import("./perfTrace").perfSpanAsync;

beforeEach(async () => {
  vi.stubGlobal("performance", { now: nowMock });
  infoSpy.mockClear();
  nowMock.mockReset();
  ({ perfSpan, perfSpanAsync } = await import("./perfTrace"));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Queue the pair of performance.now() reads (t0, then end) for a single span of `durationMs`. */
function spanOf(durationMs: number) {
  nowMock.mockReturnValueOnce(0).mockReturnValueOnce(durationMs);
}

describe("perfSpan frame-budget gate", () => {
  it("does not log a sub-frame span (< 16ms)", () => {
    spanOf(4);
    expect(perfSpan("rehydrate", () => "v")).toBe("v");
    expect(infoSpy).not.toHaveBeenCalled();
  });

  it("does not log a span exactly at the last sub-frame ms (15ms)", () => {
    spanOf(15);
    perfSpan("rehydrate", () => 0);
    expect(infoSpy).not.toHaveBeenCalled();
  });

  it("logs a span at the one-frame threshold (16ms) with its ms and meta", () => {
    spanOf(16);
    perfSpan("rehydrate", () => 0, { event: "x" });
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy).toHaveBeenCalledWith("perf", "span rehydrate", { ms: 16, event: "x" });
  });

  it("logs a genuinely slow span (751ms) — the signal the instrument exists to surface", () => {
    spanOf(751);
    perfSpan("rehydrate", () => 0);
    expect(infoSpy).toHaveBeenCalledWith("perf", "span rehydrate", { ms: 751 });
  });

  it("returns the fn result and still gates on duration even when fn throws", () => {
    spanOf(4);
    expect(() =>
      perfSpan("boom", () => {
        throw new Error("nope");
      }),
    ).toThrow("nope");
    expect(infoSpy).not.toHaveBeenCalled();
  });
});

describe("perfSpanAsync frame-budget gate", () => {
  it("does not log a sub-frame async span", async () => {
    spanOf(10);
    await expect(perfSpanAsync("persist.merge", async () => "ok")).resolves.toBe("ok");
    expect(infoSpy).not.toHaveBeenCalled();
  });

  it("logs an async span at/over one frame", async () => {
    spanOf(40);
    await perfSpanAsync("persist.merge", async () => 0);
    expect(infoSpy).toHaveBeenCalledWith("perf", "span persist.merge", { ms: 40 });
  });
});
