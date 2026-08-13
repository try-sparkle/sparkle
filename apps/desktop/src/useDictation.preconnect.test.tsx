// @vitest-environment jsdom
/**
 * THE PRODUCTION CALL SITE of the push-to-talk relay pre-connect (sparkle-v3990, the latency half).
 *
 * `voice/cloudPreconnect.test.ts` pins the DECISION; this pins that anything ever asks it. AGENTS.md
 * names the gap explicitly — a rule can be correct, unit-tested and completely unreachable, because
 * the one line that wires it into the running app is covered by nothing. Delete the effect in
 * `useAmbientVoice` and every assertion in the pure test stays green while the founder goes back to
 * paying a ~490 ms handshake inside a 76-567 ms hold.
 *
 * Its own file, and in jsdom, for the same reason `useDictation.arm.test.tsx` is: the effect runs in
 * a React render, so the node-env tests cannot reach it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
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

// Both AI gates ON, so the pre-connect's own gate is what decides rather than an entitlement.
vi.mock("./services/aiGate", () => ({
  useAiFeature: () => true,
  aiFeatureNow: () => true,
}));

import { useDictationStore } from "./stores/dictationStore";
import { useUiStore } from "./stores/uiStore";
import { useAmbientVoice } from "./useDictation";

const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

/** Every `preconnect_cloud_stream` call the hook made, in order, with its `want` flag. */
function preconnectCalls(): boolean[] {
  return invoke.mock.calls
    .filter((c) => c[0] === "preconnect_cloud_stream")
    .map((c) => (c[1] as { want: boolean }).want);
}

beforeEach(() => {
  invoke.mockClear();
  for (const k of Object.keys(listeners)) delete listeners[k];
  // The mic RESTS disarmed on push to talk (`useMicActions::setOff`), which is the whole reason the
  // pre-connect cannot be gated on `enabled` — this fixture is the founder's actual rest state.
  useDictationStore.setState({
    enabled: false,
    phase: "passive",
    windowFocused: true,
    status: "idle",
    error: null,
  });
  useUiStore.setState({ conciergeSendMode: "send" });
});

describe("the push-to-talk pre-connect is actually wired to the hook", () => {
  it("asks the backend to pre-connect when the tray moves to push to talk", async () => {
    renderHook(() => useAmbientVoice());
    await flush();
    // Nothing yet: the tray is parked at Send (the default), so a mounting window costs nothing.
    expect(preconnectCalls()).toEqual([]);

    await act(async () => {
      useUiStore.setState({ conciergeSendMode: "ptt" });
    });

    // THE ASSERTION. Not "the decision function returns true" — that the running hook reached the
    // backend with it, before the user pressed anything.
    expect(preconnectCalls()).toEqual([true]);
    expect(invoke).toHaveBeenCalledWith(
      "preconnect_cloud_stream",
      expect.objectContaining({ want: true }),
    );
  });

  it("RELEASES on blur rather than merely declining to open the next one", async () => {
    useUiStore.setState({ conciergeSendMode: "ptt" });
    renderHook(() => useAmbientVoice());
    await flush();
    expect(preconnectCalls()).toEqual([true]);

    await act(async () => {
      useDictationStore.setState({ windowFocused: false });
    });

    // A `false` is the release — it is what hands a speculative relay connection back instead of
    // holding one open to Sparkle's servers while the user is in another app. A hook that only
    // fired on `true` would leave the socket up for the whole warm window, and this row is the
    // difference.
    expect(preconnectCalls()).toEqual([true, false]);
  });

  it("never opens a speculative socket while a hold is underway", async () => {
    useUiStore.setState({ conciergeSendMode: "ptt" });
    renderHook(() => useAmbientVoice());
    await flush();
    invoke.mockClear();

    // The keydown: the tray's push-to-talk hold drives the phase ACTIVE, which is where
    // `start_cloud_stream` takes ownership of the socket.
    await act(async () => {
      useDictationStore.setState({ phase: "active" });
    });

    expect(preconnectCalls()).toEqual([false]);
    // And nothing here starts a meter: the pre-connect never reaches the cloud-open path, whose
    // outcome is what `classifyCloudOutcome` bills on.
    expect(invoke).not.toHaveBeenCalledWith("start_cloud_stream", expect.anything());
  });
});
