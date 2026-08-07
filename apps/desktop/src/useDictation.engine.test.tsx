// @vitest-environment jsdom
/**
 * THE ENGINE-FALLBACK SIGNAL, ON THE PATH THAT ACTUALLY OPENS THE RELAY.
 *
 * `start_cloud_stream` returns a boolean the relay itself decided: `true` = the socket opened,
 * `false` = it REFUSED (signed out, not entitled, can't afford the first minute) and dictation
 * silently continues on-device. On-device is an OFFLINE transducer with no interim results at all,
 * so the live word-by-word preview structurally stops existing — a swap the user reads as a broken
 * feature unless something says so (see stores/dictationEngineStore).
 *
 * ITS OWN FILE, IN JSDOM, FOR THE SAME REASON `useDictation.arm.test.tsx` IS: the invoke lives in
 * `useAmbientVoice`'s `openCloud` ref, which is a React hook and unreachable from the node-env
 * controller tests. Those drive `createDictationController` directly and never construct the
 * `startCloudStream` closure at all — so the wiring could be deleted outright and every one of them
 * would stay green.
 *
 * The AI gate is mocked because it is not what is under test here: without it `aiFeatureNow` is
 * false for an unauthenticated fixture and `openCloud` early-returns before any invoke, so the test
 * would pass while proving nothing about the relay's answer.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";

const listeners: Record<string, Array<(e: { payload: unknown }) => void>> = {};
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, cb: (e: { payload: unknown }) => void) => {
    (listeners[name] ??= []).push(cb);
    return Promise.resolve(() => {
      listeners[name] = (listeners[name] ?? []).filter((c) => c !== cb);
    });
  },
}));

const invoke = vi.fn().mockResolvedValue(undefined);
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

vi.mock("./services/dictationTerminalSink", () => ({
  routeDictationToTerminal: vi.fn().mockResolvedValue({ kind: "delivered", agentId: "a1", text: "x" }),
}));

// Both AI gates ON, so the cloud open is reached. `useAiFeature` is the hook form the component
// body calls; `aiFeatureNow` is the imperative one `openCloud` reads live.
vi.mock("./services/aiGate", () => ({
  useAiFeature: () => true,
  aiFeatureNow: () => true,
}));

import { useDictationStore } from "./stores/dictationStore";
import { useDictationEngineStore } from "./stores/dictationEngineStore";
import { useAmbientVoice } from "./useDictation";

/** Yield a real MACROTASK, not a microtask. `createDictationController` awaits a `Promise.all` over
 *  ~10 `listen()` calls before it subscribes to the store, and each mocked `listen` resolves on its
 *  own tick — so a fixed handful of `await Promise.resolve()` does NOT reliably get past them. A
 *  phase change driven too early outruns the subscriber, no edge fires, and the test fails asserting
 *  that `start_cloud_stream` was never invoked (which is what it did before this was a macrotask). */
const flush = () => act(async () => {
  await new Promise((r) => setTimeout(r, 0));
});

/** Mount the hook and let the controller finish attaching its listeners AND its store subscriber. */
async function mountVoice(): Promise<void> {
  renderHook(() => useAmbientVoice());
  await flush();
}

/** Drive the passive→active phase edge — the ONE opener of the billable relay — and let the async
 *  open settle. */
async function goActive(): Promise<void> {
  await act(async () => {
    useDictationStore.setState({ phase: "active" });
  });
  await flush();
}

/** Focus a real composer textarea. TWO separate things depend on this, and missing either one makes
 *  the relay never open — which presents as the confusing "only `start_dictation` was invoked":
 *    1. `isWindowActive()` defaults to `document.hasFocus()`, and **jsdom reports `false` until
 *       something in the document is actually focused** (measured). `isCapturable()` fails on that
 *       alone, so the passive→active subscriber skips the cloud open entirely.
 *    2. `focusOwnerNow()` reads the LIVE DOM (not the store's `focusOwner` mirror, which exists for
 *       the copy), so a real focused element is what makes `focusPauseReason()` null.
 *  Mirrors `focusTheComposer` in useDictation.arm.test.tsx. */
function focusTheComposer(): void {
  const ta = document.createElement("textarea");
  document.body.appendChild(ta);
  ta.focus();
}

beforeEach(() => {
  document.body.innerHTML = "";
  focusTheComposer();
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
  for (const k of Object.keys(listeners)) delete listeners[k];
  // Armed, routable, and PASSIVE — so the phase write below is a real edge.
  useDictationStore.setState({
    enabled: true,
    status: "listening",
    error: null,
    phase: "passive",
    interim: "",
    windowFocused: true,
    focusOwner: "other",
  });
  useDictationEngineStore.setState({ fallbackReason: null, dismissed: false });
});

describe("the window-blur guard — a broadcast stand-down must not close the global relay", () => {
  // NOTHING covered this direction. useDictation.test.ts runs in the node env, where `hasWindow` is
  // false so the listener is never attached, and every window-focus case there drives
  // `notifyWindowFocus` directly — bypassing the guard entirely. So deleting the guard, or inverting
  // it, kept the whole suite green while silently disabling the per-window ownership handoff the
  // listener exists for (sparkle-ozvr / roborev 59711).
  //
  // Both cases mount with the window FOCUSED, because the guard is an EDGE: the controller seeds
  // `domWindowFocused` from `isWindowActive()` at creation, so a window that was already background
  // at mount has no true → false transition to make and would pass the first assertion vacuously.
  let hasFocus: ReturnType<typeof vi.spyOn> | null = null;
  afterEach(() => {
    // Restored here rather than at the end of each case: a case that fails before its own restore
    // would otherwise leak `hasFocus === false` into every later test in this file, where it blocks
    // the routing gate and turns unrelated relay assertions red. That is exactly what happened.
    hasFocus?.mockRestore();
    hasFocus = null;
  });

  const mountFocusedAndGoActive = async () => {
    hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    invoke.mockImplementation((cmd: string) =>
      cmd === "start_cloud_stream" ? Promise.resolve(true) : Promise.resolve(undefined),
    );
    await mountVoice();
    await goActive();
    // PRECONDITION, ASSERTED. `tearDownOwnedStream` early-returns unless phase is "active", so if
    // this were not true both cases below would pass without the guard doing anything at all.
    expect(useDictationStore.getState().phase).toBe("active");
    invoke.mockClear();
  };

  it("IGNORES a blur the DOM contradicts — the hatch's synthetic stand-down pulse", async () => {
    await mountFocusedAndGoActive();

    // The window is STILL focused; only the event claims otherwise.
    await act(async () => {
      window.dispatchEvent(new Event("blur"));
    });

    expect(invoke).not.toHaveBeenCalledWith("stop_cloud_stream");
  });

  it("still tears down on a REAL blur — the direction that must keep working", async () => {
    // The other half, and what makes the case above non-vacuous: a guard that suppressed EVERY blur
    // would also pass that assertion while breaking the window-to-window handoff that closes the
    // billable relay.
    await mountFocusedAndGoActive();

    hasFocus!.mockReturnValue(false); // the window really did go background
    await act(async () => {
      window.dispatchEvent(new Event("blur"));
    });

    expect(invoke).toHaveBeenCalledWith("stop_cloud_stream");
  });
});

describe("the relay's own answer to start_cloud_stream drives the engine signal", () => {
  it("a REFUSAL (false) records the fallback — dictation is on-device now", async () => {
    invoke.mockImplementation((cmd: string) =>
      cmd === "start_cloud_stream" ? Promise.resolve(false) : Promise.resolve(undefined),
    );
    await mountVoice();
    await goActive();
    // The invoke really happened — otherwise the assertion below would be reading an untouched
    // store and would pass for a fixture that never opened anything.
    expect(invoke).toHaveBeenCalledWith("start_cloud_stream", expect.anything());
    // THE ASSERTION. Before the wiring, the boolean was consumed by openCloudDictationWindow and
    // thrown away: a refusal was indistinguishable from a live stream anywhere in the UI.
    expect(useDictationEngineStore.getState().fallbackReason).toBe("unavailable");
  });

  it("a SUCCESS (true) records nothing — the resting state is 'no problem known'", async () => {
    invoke.mockImplementation((cmd: string) =>
      cmd === "start_cloud_stream" ? Promise.resolve(true) : Promise.resolve(undefined),
    );
    await mountVoice();
    await goActive();
    expect(invoke).toHaveBeenCalledWith("start_cloud_stream", expect.anything());
    // The overreach guard: a signal that fired on every open would light the banner permanently
    // while nothing was wrong, which is worse than not having it.
    expect(useDictationEngineStore.getState().fallbackReason).toBeNull();
  });

  it("a cloud stream coming back RETIRES a standing fallback and re-arms the dismissal", async () => {
    // The recovery half. Without it the banner outlives the outage it describes — the user fixes
    // their connection, dictation goes back to streaming interims, and the app still says it isn't.
    useDictationEngineStore.setState({ fallbackReason: "exhausted", dismissed: true });
    invoke.mockImplementation((cmd: string) =>
      cmd === "start_cloud_stream" ? Promise.resolve(true) : Promise.resolve(undefined),
    );
    await mountVoice();
    await goActive();
    expect(useDictationEngineStore.getState().fallbackReason).toBeNull();
    expect(useDictationEngineStore.getState().dismissed).toBe(false);
  });
});
