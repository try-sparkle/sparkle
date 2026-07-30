// @vitest-environment jsdom
// Hook-level tests for the ONLY production wiring (roborev 55433, Medium).
//
// The 22 tests in apiRecoveryRunner.test.ts drive `noteAgentStatus` / `sweepApiRecovery` directly, so
// nothing covered the subscription that actually calls them: the prev/next status diff, the
// gone-agent cleanup, or the interval. A regression in any of those — a wrong comparison, a missing
// cleanup, the effect simply not mounting — would leave the whole feature DORMANT with a fully green
// suite. These assert the side effects through the real store instead.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useRuntimeStore } from "../stores/runtimeStore";
import {
  SWEEP_INTERVAL_MS,
  __resetApiRecovery,
  apiRecoveryEpisode,
  useApiRecovery,
} from "./apiRecoveryRunner";

// The scrollback read at episode entry goes through this; give it a real banner so the episode
// classifies as retryable rather than null.
vi.mock("./terminalScrollback", () => ({
  getAgentScrollback: () => "⏺ API Error: 529 Overloaded.",
}));

const A = "hook-agent";

beforeEach(() => {
  __resetApiRecovery();
  useRuntimeStore.setState({ status: {} });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useApiRecovery — the production wiring", () => {
  it("opens an episode when the STORE reports an agent went errored", () => {
    renderHook(() => useApiRecovery());
    expect(apiRecoveryEpisode(A)).toBeUndefined();

    // The real signal: a status write, exactly as a StatusEngine makes it.
    act(() => {
      useRuntimeStore.getState().setStatus(A, "errored");
    });
    expect(apiRecoveryEpisode(A)).toMatchObject({ attempts: 0, failure: "retryable" });
  });

  it("closes the episode when the store reports it left errored", () => {
    renderHook(() => useApiRecovery());
    act(() => useRuntimeStore.getState().setStatus(A, "errored"));
    expect(apiRecoveryEpisode(A)).toBeDefined();
    act(() => useRuntimeStore.getState().setStatus(A, "working"));
    expect(apiRecoveryEpisode(A)).toBeUndefined();
  });

  // An agent removed from the map entirely emits no transition to observe, so without the explicit
  // cleanup its state leaks and every later sweep runs against an agent that is gone.
  it("forgets an agent that disappears from the status map", () => {
    renderHook(() => useApiRecovery());
    act(() => useRuntimeStore.getState().setStatus(A, "errored"));
    expect(apiRecoveryEpisode(A)).toBeDefined();

    act(() => {
      useRuntimeStore.setState({ status: {} }); // project unloaded / pane closed
    });
    expect(apiRecoveryEpisode(A)).toBeUndefined();
  });

  it("seeds from a store that is ALREADY populated at mount (a remount, not a restart)", () => {
    // Scope note in the hook is deliberate: on a cold start the panes mount after this effect, so the
    // seed finds nothing and the subscription does the work. What it does cover is remounting while
    // agents are already running.
    useRuntimeStore.setState({ status: { [A]: "errored" } });
    renderHook(() => useApiRecovery());
    expect(apiRecoveryEpisode(A)).toMatchObject({ attempts: 0 });
  });

  it("arms the sweep at its stated cadence and clears THAT handle on unmount", () => {
    // Real timers: with fake ones the spied setInterval hands the effect a non-timer handle and the
    // effect throws during mount. Spies alone answer the question — is the interval armed at
    // SWEEP_INTERVAL_MS, and released on unmount — without needing it to actually fire.
    const setSpy = vi.spyOn(globalThis, "setInterval");
    const clearSpy = vi.spyOn(globalThis, "clearInterval");
    const hook = renderHook(() => useApiRecovery());

    // Identify OUR interval by its cadence, and carry that one handle through to the unmount
    // assertion. This test used to collect EVERY setInterval handle observed during mount — React's,
    // jsdom's, any other hook's — and assert only that clearInterval was called with one of them,
    // which stayed green with our cleanup deleted (roborev 55457: the vacuous shape AGENTS.md flags).
    // Asserting the cadence also catches a regression to a 30s sweep, which would make the 5s first
    // rung meaningless while every other test passed.
    const i = setSpy.mock.calls.findIndex((c) => c[1] === SWEEP_INTERVAL_MS);
    expect(i).toBeGreaterThanOrEqual(0);
    const ours = setSpy.mock.results[i]?.value;

    hook.unmount();
    expect(clearSpy.mock.calls.map((c) => c[0])).toContain(ours);
    setSpy.mockRestore();
    clearSpy.mockRestore();
  });

  // The seed shares `noteAgentStatus` with the subscription, so it gets the carry-forward too — a
  // remount deep in the ladder RESUMES rather than dropping back to the 5s rung. roborev 55457
  // claimed the seed resets it; this pins the actual behaviour instead of arguing about it.
  it("RESUMES the ladder when it remounts onto an agent that is still errored", () => {
    const first = renderHook(() => useApiRecovery());
    act(() => useRuntimeStore.getState().setStatus(A, "errored"));
    // Stand in for a ping having gone out at rung 3 — that is what makes an episode carryable.
    const ep = apiRecoveryEpisode(A);
    expect(ep).toBeDefined();
    Object.assign(ep as { attempts: number; lastPingAt: number | undefined }, {
      attempts: 3,
      lastPingAt: Date.now(),
    });
    // Our own ping clears `errored`; the agent then re-enters it. The remount happens in between.
    act(() => useRuntimeStore.getState().setStatus(A, "working"));
    first.unmount();

    useRuntimeStore.setState({ status: { [A]: "errored" } });
    renderHook(() => useApiRecovery());
    expect(apiRecoveryEpisode(A)).toMatchObject({ attempts: 3 });
  });

  it("does not re-open an episode for an agent already being tracked", () => {
    renderHook(() => useApiRecovery());
    act(() => useRuntimeStore.getState().setStatus(A, "errored"));
    const first = apiRecoveryEpisode(A);
    // A repeated write of the SAME status is filtered by the store's no-op guard, and even if it
    // reached us the episode must not restart.
    act(() => useRuntimeStore.getState().setStatus(A, "errored"));
    expect(apiRecoveryEpisode(A)?.erroredSince).toBe(first?.erroredSince);
  });
});
