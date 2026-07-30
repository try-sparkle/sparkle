// @vitest-environment jsdom
// Spans are wall-clock, so a span that outlived a machine sleep or a background-throttled window
// is NOT main-thread work — reporting it at INFO both floods the log and mis-sizes the operation
// (a `rehydrate` span whose body is a parse + merge has been observed at 21s). These cover the
// attribution that keeps such a sample out of the INFO stream while preserving it at DEBUG.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const nowMock = vi.fn<() => number>();
const infoSpy = vi.fn();
const debugSpy = vi.fn();

vi.mock("./logger", () => ({
  log: {
    info: (scope: string, message: string, data?: unknown) => infoSpy(scope, message, data),
    debug: (scope: string, message: string, data?: unknown) => debugSpy(scope, message, data),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

let perfSpan: typeof import("./perfTrace").perfSpan;
let perfSpanAsync: typeof import("./perfTrace").perfSpanAsync;
let classifySpan: typeof import("./perfTrace").classifySpan;

beforeEach(async () => {
  vi.resetModules();
  infoSpy.mockClear();
  debugSpy.mockClear();
  nowMock.mockReset();
  setHidden(false);
  vi.spyOn(performance, "now").mockImplementation(() => nowMock());
  ({ perfSpan, perfSpanAsync, classifySpan } = await import("./perfTrace"));
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Queue the pair of performance.now() reads (t0, then end) for a single span of `durationMs`. */
function spanOf(durationMs: number) {
  nowMock.mockReturnValueOnce(0).mockReturnValueOnce(durationMs);
}

function setHidden(hidden: boolean) {
  Object.defineProperty(document, "hidden", { value: hidden, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("classifySpan", () => {
  it("reports ordinary main-thread cost", () => {
    expect(classifySpan(751, false)).toBe("report");
  });

  it("calls a span at the suspend threshold a resume, not work", () => {
    expect(classifySpan(10_000, false)).toBe("suspend");
  });

  it("still reports the ms just below the suspend threshold", () => {
    expect(classifySpan(9_999, false)).toBe("report");
  });

  it("calls a hidden-window span background", () => {
    expect(classifySpan(751, true)).toBe("background");
  });

  it("prefers the suspend verdict when a span is both long and hidden", () => {
    expect(classifySpan(21_454, true)).toBe("suspend");
  });
});

describe("perfSpanAsync attribution", () => {
  it("keeps a genuinely slow visible span on the INFO line", async () => {
    spanOf(751);
    await perfSpanAsync("rehydrate", async () => 0);
    expect(infoSpy).toHaveBeenCalledWith("perf", "span rehydrate", { ms: 751 });
    expect(debugSpy).not.toHaveBeenCalled();
  });

  // Relabelled, not demoted. The verdict still says "suspend" so nobody reads 21s as 21s of work,
  // but it stays on a level the shipped build actually writes to the log file: `logger.ts` forwards
  // only above debug (`debugForwardEnabled = import.meta.env.DEV`), so the old DEBUG line meant this
  // was DELETED for every user whose log we read. The jank monitor had the identical bug and it cost
  // a real diagnosis — a >=10s span is exactly the freeze worth keeping, and this is the one
  // instrument that names the operation.
  it("relabels a 21s span as a suspend but keeps it on a level the log file retains", async () => {
    spanOf(21_454);
    await perfSpanAsync("rehydrate", async () => 0, { event: "projects-changed" });
    expect(debugSpy).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith("perf", "span rehydrate (suspend)", {
      ms: 21_454,
      event: "projects-changed",
    });
  });

  // `classifySpan` tests the duration BEFORE `hiddenOverlap`, so a long hidden interval never
  // reaches the `background` verdict — it lands in the `suspend` promotion instead, at INFO. An
  // async span that merely awaits across a >10s occlusion (a poll, an IPC round-trip, a rehydrate
  // while the user is away) is exactly that case, and it is FREQUENT and LEGITIMATE. Without a
  // discriminator it renders in the shipped log identically to the 30s synchronous block the
  // promotion exists to preserve. `hidden` is what tells the two apart, and it was being dropped —
  // while the sibling jank line added in the same change deliberately carries it "for a reader to
  // discount". The case was unpinned in either direction before this test.
  it("marks a long ASYNC span that overlapped an occlusion as hidden, so a reader can discount it", async () => {
    setHidden(true);
    spanOf(21_454);
    await perfSpanAsync("poll", async () => 0);
    expect(debugSpy).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith("perf", "span poll (suspend)", {
      ms: 21_454,
      hidden: true,
    });
  });

  // The neighbouring case that must NOT have changed: a long span with the window visible
  // throughout is the genuine-block reading, and tagging it `hidden` would be a lie.
  it("does not claim hidden for a long span the window stayed visible through", async () => {
    spanOf(21_454);
    await perfSpanAsync("poll", async () => 0);
    expect(infoSpy).toHaveBeenCalledWith("perf", "span poll (suspend)", { ms: 21_454 });
  });

  it("demotes a span that ran while the window was hidden", async () => {
    setHidden(true);
    spanOf(400);
    await perfSpanAsync("rehydrate", async () => 0);
    expect(infoSpy).not.toHaveBeenCalled();
    expect(debugSpy).toHaveBeenCalledWith("perf", "span rehydrate (background)", { ms: 400 });
  });

  it("demotes a span the window was hidden and re-shown DURING — visible at both ends", async () => {
    // The trap classifyJankGap documents: sampling document.hidden at either end alone reads
    // "visible", so only the latched epoch can see that the interval was throttled.
    nowMock.mockReturnValueOnce(0).mockImplementationOnce(() => {
      setHidden(true);
      setHidden(false);
      return 400;
    });
    await perfSpanAsync("rehydrate", async () => 0);
    expect(infoSpy).not.toHaveBeenCalled();
    expect(debugSpy).toHaveBeenCalledWith("perf", "span rehydrate (background)", { ms: 400 });
  });

  it("still drops a sub-frame span entirely, hidden or not", async () => {
    setHidden(true);
    spanOf(4);
    await perfSpanAsync("rehydrate", async () => 0);
    expect(infoSpy).not.toHaveBeenCalled();
    expect(debugSpy).not.toHaveBeenCalled();
  });

  it("returns the awaited value and attributes a rejected span too", async () => {
    spanOf(40);
    await expect(perfSpanAsync("ok", async () => "v")).resolves.toBe("v");
    expect(infoSpy).toHaveBeenCalledWith("perf", "span ok", { ms: 40 });

    setHidden(true);
    spanOf(40);
    await expect(
      perfSpanAsync("boom", () => Promise.reject(new Error("nope"))),
    ).rejects.toThrow("nope");
    expect(debugSpy).toHaveBeenCalledWith("perf", "span boom (background)", { ms: 40 });
  });
});

describe("perfSpan (synchronous) attribution", () => {
  it("keeps a slow sync span at INFO even in a hidden window", () => {
    // A synchronous body never yields, so it cannot be background-throttled part-way through:
    // this is real main-thread work that a background window is doing, and discounting it would
    // hide exactly the cost the instrument exists to surface.
    setHidden(true);
    spanOf(751);
    perfSpan("persist.merge", () => 0);
    expect(infoSpy).toHaveBeenCalledWith("perf", "span persist.merge", { ms: 751 });
    expect(debugSpy).not.toHaveBeenCalled();
  });

  // The case with the most at stake. `perfSpan` is SYNCHRONOUS and passes `hiddenOverlap = false`,
  // so a body that cleared the threshold could not have been throttled part-way through — it is far
  // more likely a genuine main-thread block than a machine sleep. Sending that to a level the
  // shipped build discards deleted the best evidence we had about long freezes.
  it("keeps a 30s SYNC span in the log file, since it is more likely a block than a sleep", () => {
    spanOf(30_000);
    perfSpan("persist.merge", () => 0);
    expect(debugSpy).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith("perf", "span persist.merge (suspend)", { ms: 30_000 });
  });

  // A SYNC span never takes the background discount, however hidden the window: `perfSpan` passes
  // `hiddenOverlap = false` because a synchronous body cannot be throttled part-way through, so its
  // cost is genuine main-thread work either way. Pinned here because the promotion above is
  // deliberately narrow — only the `suspend` verdict moved — and this is the neighbouring case that
  // must NOT have changed.
  it("keeps an ordinary sync span on its plain INFO line even while hidden", () => {
    setHidden(true);
    spanOf(400);
    perfSpan("persist.merge", () => 0);
    expect(debugSpy).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith("perf", "span persist.merge", { ms: 400 });
  });
});
