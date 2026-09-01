/**
 * THE CLOSER CENSUS — every path that can leave the billable Deepgram relay open, and the closer
 * that runs on it (bead sparkle-xr5ak).
 *
 * WHY THIS FILE EXISTS AND WHY IT IS SEPARATE. Retiring the wake word deleted its stop phrase and
 * its pause-on-submit. Those two call sites were THE ONLY TWO THINGS that closed the relay. Nothing
 * in the tree described them as "the closers", so the deletion was type-safe, no import dangled and
 * a 14,000-test suite stayed green while an always-on Speak session billed per elapsed minute
 * through arbitrary silence (roborev 57785, High). The individual behaviours were tested — blur,
 * phase edges, cloud-ended — but each in its own row, describing a FEATURE. Nothing anywhere said
 * "these, together, are the complete set of things that stop the meter", so removing two of them
 * subtracted from a set no file named.
 *
 * SO THIS IS AN ENUMERATION, NOT A FEATURE TEST. Each row below is a way a user can leave a relay
 * open, and each asserts that the relay is ACTUALLY RELINQUISHED — the `stop_cloud_stream` side
 * effect, never merely that a timer was armed or a flag flipped. Deleting any one closer makes
 * exactly one row red and names the path in its own title. Adding a sixth way to leave a relay open
 * without a closer should mean adding a row here that fails.
 *
 * SUBMIT IS DELIBERATELY ABSENT AND THAT IS RECORDED, NOT FORGOTTEN. Sending a message does not
 * close the relay: in Speak the phase stays ACTIVE across a send, which is the promise "always on"
 * makes. The idle park is what bounds the cost of that decision, so the silence row below is
 * carrying submit's weight and must never be deleted as redundant.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const listeners: Record<string, Array<(e: { payload: unknown }) => void>> = {};
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, cb: (e: { payload: unknown }) => void) => {
    (listeners[name] ??= []).push(cb);
    return Promise.resolve(() => {
      listeners[name] = (listeners[name] ?? []).filter((c) => c !== cb);
      if (listeners[name].length === 0) delete listeners[name];
    });
  },
}));

vi.mock("./services/dictationTerminalSink", () => ({
  routeDictationToTerminal: vi.fn().mockResolvedValue({ kind: "dropped" }),
}));

const invoke = vi.fn().mockResolvedValue(undefined);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invoke(...a),
}));

import { useDictationStore } from "./stores/dictationStore";
import { createDictationController, IDLE_RELAY_PARK_MS } from "./useDictation";

/** Broadcast a fake Tauri event to every registration, exactly as Tauri does. */
function emit(name: string, payload: unknown) {
  for (const cb of listeners[name] ?? []) cb({ payload });
}

/** The store state of a window that OWNS a live, billable relay right now. */
function anOpenRelay() {
  useDictationStore.setState({
    enabled: true,
    status: "listening",
    phase: "active",
    focusOwner: "other",
    windowFocused: true,
    speaking: false,
    interim: "",
  });
}

/** A controller for the focused window that owns the relay. */
const ownerController = () =>
  createDictationController({
    onSegment: vi.fn(),
    isWindowActive: () => true,
    focusOwner: () => "other",
  });

const closedTheRelay = () =>
  invoke.mock.calls.some((c) => c[0] === "stop_cloud_stream" || c[0] === "stop_dictation");

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
  for (const k of Object.keys(listeners)) delete listeners[k];
});
afterEach(() => {
  vi.useRealTimers();
});

describe("the closer census — every path that can leave the billable relay open", () => {
  it("SILENCE: a quiet minute on Speak relinquishes the relay (the closer submit no longer has)", async () => {
    vi.useFakeTimers();
    anOpenRelay();
    const ctrl = await ownerController();
    // The VAD falling edge is what arms the park, so drive it rather than reaching for the timer.
    useDictationStore.getState().setSpeaking(true);
    useDictationStore.getState().setSpeaking(false);
    invoke.mockClear();
    vi.advanceTimersByTime(IDLE_RELAY_PARK_MS + 1);
    expect(closedTheRelay()).toBe(true);
    ctrl.cleanup();
  });

  it("BLUR: the owner window losing focus relinquishes the relay", async () => {
    anOpenRelay();
    const ctrl = await ownerController();
    invoke.mockClear();
    ctrl.notifyWindowFocus(false);
    expect(closedTheRelay()).toBe(true);
    ctrl.cleanup();
  });

  it("MODE CHANGE: the phase leaving ACTIVE relinquishes the relay", async () => {
    anOpenRelay();
    const ctrl = await ownerController();
    invoke.mockClear();
    useDictationStore.getState().setPhase("passive");
    expect(closedTheRelay()).toBe(true);
    ctrl.cleanup();
  });

  it("ERROR: a relay that died under us is relinquished rather than left half-open", async () => {
    anOpenRelay();
    const ctrl = await ownerController();
    invoke.mockClear();
    emit("dictation://cloud-ended", false);
    expect(closedTheRelay()).toBe(true);
    ctrl.cleanup();
  });

  // ── THE ROW THAT WAS MISSING ────────────────────────────────────────────────────────────────
  // `cleanup()` clears the idle-park timer, unlistens `cloud-ended`, drops the phase-edge
  // subscriber and removes the blur/focus handlers — i.e. it removes every one of the four closers
  // above. Run against a live stream it used to leave the socket with no closer anywhere in the
  // process, metering per elapsed minute until the process died. This fails on the pre-fix
  // controller, where `cleanup` only cleared timers and unlistened.
  it("UNMOUNT: tearing the controller down relinquishes the relay it still owns", async () => {
    anOpenRelay();
    const ctrl = await ownerController();
    invoke.mockClear();
    ctrl.cleanup();
    expect(closedTheRelay()).toBe(true);
  });
});

describe("the closer census — and what must NOT be closed", () => {
  // The paired negative. Without it, a controller that closed the relay unconditionally on teardown
  // would satisfy every row above — and would reintroduce roborev 56061, where a background window
  // killed the FOCUSED window's stream on the single global backend resource.
  it("a BACKGROUND window's teardown does not close the focused window's relay", async () => {
    anOpenRelay();
    const ctrl = await createDictationController({
      onSegment: vi.fn(),
      isWindowActive: () => false, // this window is not the one holding the stream
      focusOwner: () => "other",
    });
    invoke.mockClear();
    ctrl.cleanup();
    expect(closedTheRelay()).toBe(false);
  });

  it("a window with no ACTIVE phase has no relay to close, and closes nothing", async () => {
    useDictationStore.setState({
      enabled: true,
      status: "listening",
      phase: "passive",
      focusOwner: "other",
      windowFocused: true,
      speaking: false,
    });
    const ctrl = await createDictationController({
      onSegment: vi.fn(),
      isWindowActive: () => true,
      focusOwner: () => "other",
    });
    invoke.mockClear();
    ctrl.cleanup();
    expect(closedTheRelay()).toBe(false);
  });

  it("a relay ALREADY parked is not closed a second time by the teardown that follows", async () => {
    anOpenRelay();
    const ctrl = await ownerController();
    ctrl.notifyWindowFocus(false); // the park happens here
    const afterPark = invoke.mock.calls.filter((c) => c[0] === "stop_cloud_stream").length;
    expect(afterPark).toBe(1);
    ctrl.cleanup();
    // A second close would land on a relay another window may since have opened.
    expect(invoke.mock.calls.filter((c) => c[0] === "stop_cloud_stream").length).toBe(afterPark);
  });

  it("the teardown still clears the park timer, so nothing fires against the next controller", async () => {
    vi.useFakeTimers();
    anOpenRelay();
    const ctrl = await ownerController();
    useDictationStore.getState().setSpeaking(true);
    useDictationStore.getState().setSpeaking(false);
    ctrl.cleanup();
    invoke.mockClear();
    vi.advanceTimersByTime(IDLE_RELAY_PARK_MS * 2);
    expect(invoke).not.toHaveBeenCalledWith("stop_cloud_stream");
  });
});
