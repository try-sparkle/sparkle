// The auto-send tuning record (PRD 1 §4f).
//
// Two things are actually worth pinning here, and they are the two that would rot silently:
//   1. THE PRIVACY LINE. The transcript must never reach `capture()`. Nothing type-checks that —
//      the props bag is `Record<string, unknown>` — so it can only be a test.
//   2. THE CORRECTION SIGNAL. It is the only evidence of a PREMATURE send, and every other prop on
//      the event exists to make it readable.
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const capture = vi.fn();
const logInfo = vi.fn();
const logDebug = vi.fn();
const invoke = vi.fn();

vi.mock("../analytics", () => ({ capture: (...a: unknown[]) => capture(...a) }));
vi.mock("../logger", () => ({
  log: {
    info: (...a: unknown[]) => logInfo(...a),
    debug: (...a: unknown[]) => logDebug(...a),
  },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { useUiStore } from "../stores/uiStore";
import {
  CORRECTION_WINDOW_MS,
  bucketMs,
  noteUserSend,
  recordAutoSend,
  resetAutoSendTelemetry,
  type AutoSendSample,
} from "./autoSendTelemetry";

const SAMPLE: AutoSendSample = {
  tier: "normal",
  thresholdMs: 3000,
  elapsedSilenceMs: 3010,
  keptTalkingAfterReeval: false,
  graceApplied: false,
  transcript: "deploy the staging branch",
};

beforeEach(() => {
  vi.useFakeTimers();
  capture.mockClear();
  logInfo.mockClear();
  logDebug.mockClear();
  // Resolves to null: the ordinary case is "no second opinion", and every test here is about the
  // local bookkeeping rather than the classify.
  invoke.mockReset();
  invoke.mockResolvedValue(null);
  resetAutoSendTelemetry();
  useUiStore.setState({ conciergeAutoSendTuner: true });
});

afterEach(() => {
  resetAutoSendTelemetry();
  vi.useRealTimers();
});

describe("bucketMs — durations are banded, never raw", () => {
  it("bands around the four thresholds the tiers actually use", () => {
    expect(bucketMs(900)).toBe("under_1_5s");
    expect(bucketMs(3000)).toBe("1_5s_to_3_5s");
    expect(bucketMs(5000)).toBe("3_5s_to_6s");
    expect(bucketMs(10_000)).toBe("6s_to_11s");
    expect(bucketMs(45_000)).toBe("over_11s");
  });
});

describe("the privacy line", () => {
  it("NEVER puts the transcript, or anything reconstructible, into a PostHog prop", () => {
    recordAutoSend({ ...SAMPLE, transcript: "my bank password is hunter2" }, 0);
    vi.advanceTimersByTime(CORRECTION_WINDOW_MS + 1);

    expect(capture).toHaveBeenCalledTimes(1);
    const [, props] = capture.mock.calls[0] as [string, Record<string, unknown>];
    // The whole point: every value is an enum, a band or a boolean.
    for (const v of Object.values(props)) {
      expect(["string", "boolean"]).toContain(typeof v);
    }
    expect(JSON.stringify(props)).not.toContain("hunter2");
    expect(JSON.stringify(props)).not.toContain("password");
    // And no raw millisecond field slipped in beside the banded ones.
    expect(props).not.toHaveProperty("elapsedSilenceMs");
    expect(props).not.toHaveProperty("thresholdMs");
    expect(props).not.toHaveProperty("transcript");
  });

  it("keeps the transcript and the two verdicts in the LOCAL log, where the tuning reads them", async () => {
    useUiStore.setState({ conciergeAutoSendTuner: true }); // opt-in; see the default-off test below
    invoke.mockResolvedValue("verylow");
    recordAutoSend({ ...SAMPLE, tier: "normal", transcript: "ship it and" }, 0);
    await vi.runOnlyPendingTimersAsync();

    const comparison = logInfo.mock.calls.find((c) => c[1] === "heuristic vs haiku");
    expect(comparison).toBeDefined();
    expect(comparison?.[2]).toMatchObject({
      heuristic: "normal",
      haiku: "verylow",
      // The disagreements ARE the corpus.
      agree: false,
    });
    // ENUMS ONLY at info — that line lands in a support bundle. The spoken text goes to debug,
    // which production builds suppress unless forwarding is switched on.
    expect(JSON.stringify(comparison?.[2])).not.toContain("ship it and");
    const spoken = logDebug.mock.calls.find((c) => c[1] === "transcript");
    expect(spoken?.[2]).toMatchObject({ transcript: "ship it and" });
  });
});

describe("the correction signal — the only evidence of a premature send", () => {
  it("reports no correction when the window closes quietly", () => {
    recordAutoSend(SAMPLE, 0);
    vi.advanceTimersByTime(CORRECTION_WINDOW_MS + 1);

    expect(capture.mock.calls[0]?.[1]).toMatchObject({ correction_within_window: false });
  });

  it("reports a correction when the user sends again inside the window", () => {
    recordAutoSend(SAMPLE, 0);
    vi.advanceTimersByTime(2_000);
    noteUserSend(2_000); // same clock basis as the recordAutoSend(…, 0) above

    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture.mock.calls[0]?.[1]).toMatchObject({ correction_within_window: true });
  });

  it("uses the WALL CLOCK, not the timer, to decide the window is closed", () => {
    // The timer is the emit trigger; it is not the authority. WKWebView throttles and suspends
    // timers in a backgrounded window, so a 15s timeout can fire minutes late — and `firedAt` used
    // to be recorded and never read, so a genuinely new message two minutes later was recorded as
    // a CORRECTION of the earlier auto-send, corrupting the one metric this module produces.
    //
    // Fake timers are punctual by construction, so the timer can never be late here. `now` is
    // driven explicitly instead, which is the only way to express "the timer has not fired yet but
    // the window is long gone".
    recordAutoSend(SAMPLE, 0);
    noteUserSend(CORRECTION_WINDOW_MS + 60_000); // two minutes later, timer still pending

    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture.mock.calls[0]?.[1]).toMatchObject({ correction_within_window: false });
  });

  it("does NOT report a correction for a send after the window has closed", () => {
    recordAutoSend(SAMPLE, 0);
    vi.advanceTimersByTime(CORRECTION_WINDOW_MS + 1);
    capture.mockClear();
    noteUserSend(CORRECTION_WINDOW_MS + 1); // a genuinely new thought, not a correction

    expect(capture).not.toHaveBeenCalled();
  });

  it("treats a SECOND auto-send inside the window as the first one's correction", () => {
    // Two auto-sends within 15s is the pathological case this metric hunts, and the second one's
    // arrival is itself the evidence about the first.
    recordAutoSend(SAMPLE, 0);
    vi.advanceTimersByTime(1_000);
    recordAutoSend(SAMPLE, 1_000);

    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture.mock.calls[0]?.[1]).toMatchObject({ correction_within_window: true });
  });

  it("emits exactly once per auto-send, never twice for the same one", () => {
    recordAutoSend(SAMPLE, 0);
    noteUserSend(10);
    noteUserSend(20); // no open window left
    vi.advanceTimersByTime(CORRECTION_WINDOW_MS + 1); // the timer must not re-emit

    expect(capture).toHaveBeenCalledTimes(1);
  });
});

describe("the background grader is opt-in", () => {
  it("SHIPS OFF — it spends the user's own Claude subscription, so it is never a default", () => {
    // The value a fresh install actually gets. This is the assertion that would have to be
    // deliberately changed to start billing someone's quota for a diagnostic.
    expect(useUiStore.getInitialState().conciergeAutoSendTuner).toBe(false);
  });

  it("does not spawn a classify while it is switched off", async () => {
    useUiStore.setState({ conciergeAutoSendTuner: false });
    recordAutoSend(SAMPLE, 0);
    await vi.runOnlyPendingTimersAsync();

    expect(invoke).not.toHaveBeenCalled();
    // The PostHog record still lands — only the paid second opinion is gated.
    vi.advanceTimersByTime(CORRECTION_WINDOW_MS + 1);
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it("runs at most ONE classify at a time, however fast auto-sends arrive", async () => {
    // Each one is a 15-27s Node boot holding hundreds of MB. Six concurrent is the failure.
    let release: (v: unknown) => void = () => {};
    invoke.mockImplementation(() => new Promise((r) => { release = r; }));

    recordAutoSend(SAMPLE, 0);
    recordAutoSend(SAMPLE, 1);
    recordAutoSend(SAMPLE, 2);
    expect(invoke).toHaveBeenCalledTimes(1);

    release(null);
    await vi.runOnlyPendingTimersAsync();
  });
});

describe("the classify never affects the send", () => {
  it("swallows a failing tuner call — a missing second opinion is not a fault", async () => {
    invoke.mockRejectedValue(new Error("claude not installed"));
    expect(() => recordAutoSend(SAMPLE, 0)).not.toThrow();
    await vi.runOnlyPendingTimersAsync();

    expect(logInfo.mock.calls.find((c) => c[1] === "heuristic vs haiku")).toBeUndefined();
    // The PostHog record still lands: the tuner is optional, the tuning record is not.
    vi.advanceTimersByTime(CORRECTION_WINDOW_MS + 1);
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it("records nothing from the tuner when it returns no verdict", async () => {
    invoke.mockResolvedValue(null);
    recordAutoSend(SAMPLE, 0);
    await vi.runOnlyPendingTimersAsync();

    expect(logInfo.mock.calls.find((c) => c[1] === "heuristic vs haiku")).toBeUndefined();
  });
});
