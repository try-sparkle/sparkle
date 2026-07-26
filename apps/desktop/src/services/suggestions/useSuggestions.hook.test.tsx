// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

// Mock every dependency the hook reaches so we can drive compute timing deterministically.
const computeSuggestions = vi.fn();
// A stand-in for the real SuggestionOfflineError — the hook's `instanceof` check keys off the class
// it imports from "./engine", so the mock must hand back the SAME class we reject with in tests.
// vi.hoisted so the class exists when the (hoisted) vi.mock factory runs.
const { SuggestionOfflineError } = vi.hoisted(() => {
  class SuggestionOfflineError extends Error {
    constructor() {
      super("offline");
      this.name = "SuggestionOfflineError";
    }
  }
  return { SuggestionOfflineError };
});
vi.mock("./engine", () => ({
  computeSuggestions: (...a: unknown[]) => computeSuggestions(...a),
  SuggestionOfflineError,
}));
// Same stand-in trick for AiUnavailableError / AiUnreachableError: the hook's `instanceof` checks key
// off the classes it imports from "../anthropic", so tests must reject with the very same classes.
// Mocking the module also keeps the real one's @tauri-apps/api/core import out of this suite.
const { AiUnavailableError, AiUnreachableError } = vi.hoisted(() => {
  class AiUnavailableError extends Error {
    constructor() {
      super("AI backend is unavailable");
      this.name = "AiUnavailableError";
    }
  }
  class AiUnreachableError extends Error {
    constructor() {
      super("Claude request failed: the network is unreachable");
      this.name = "AiUnreachableError";
    }
  }
  return { AiUnavailableError, AiUnreachableError };
});
vi.mock("../anthropic", () => ({ AiUnavailableError, AiUnreachableError }));
vi.mock("../terminalScrollback", () => ({ getAgentScrollback: () => "Done. Committed abc. Nothing further." }));
vi.mock("../aiGate", () => ({ useAiFeature: () => true }));
vi.mock("../relayClient", () => ({ pushSuggestions: vi.fn() }));
vi.mock("../../stores/runtimeStore", () => ({
  // status[agentId] === "idle" → a your-turn state, so the hook computes. No workflowStage entry AND
  // no branchStatus for a1 → the resolved stage is building_unsaved, for which deriveCta returns
  // null, so these concurrency tests see the raw computed set with no CTA merged over it. The CTA's
  // own wiring is covered by useSuggestions.cta.test.tsx.
  useRuntimeStore: (
    sel: (s: {
      status: Record<string, string>;
      workflowShipped: Record<string, boolean>;
      workflowStage: Record<string, string>;
      workflowState: Record<string, unknown>;
      branchStatus: Record<string, unknown>;
    }) => unknown,
  ) =>
    sel({
      status: { a1: "idle" },
      workflowShipped: {},
      workflowStage: {},
      workflowState: {},
      branchStatus: {},
    }),
}));

import { useSuggestions } from "./useSuggestions";
import { useConnectionStore } from "../../stores/connectionStore";

beforeEach(() => {
  computeSuggestions.mockReset();
  // Reset to the store's optimistic default so each test starts online.
  useConnectionStore.setState({ browserOnline: true, probeOk: true, isOnline: true });
});

describe("useSuggestions concurrency guard", () => {
  it("does not start a second compute while one is in flight (same state)", async () => {
    let resolve1: (v: unknown) => void = () => {};
    computeSuggestions
      .mockReturnValueOnce(new Promise((r) => (resolve1 = r)))
      .mockResolvedValueOnce({ agentId: "a1", buttons: [] });

    const { rerender } = renderHook(({ empty }) => useSuggestions("a1", empty), {
      initialProps: { empty: true },
    });
    await act(async () => {});
    expect(computeSuggestions).toHaveBeenCalledTimes(1);

    // Toggle composer non-empty then empty again while the first compute is still pending: the
    // in-flight guard must prevent a duplicate concurrent compute.
    rerender({ empty: false });
    rerender({ empty: true });
    await act(async () => {});
    expect(computeSuggestions).toHaveBeenCalledTimes(1);

    // The first compute was superseded (composer toggled mid-flight), so once it resolves its
    // result is discarded and the state we're back in recomputes — exactly one follow-up.
    await act(async () => {
      resolve1({ agentId: "a1", buttons: [] });
    });
    await act(async () => {});
    expect(computeSuggestions).toHaveBeenCalledTimes(2);
  });

  it("does not lock up permanently if a compute rejects (retries)", async () => {
    computeSuggestions
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ agentId: "a1", buttons: [] });

    renderHook(() => useSuggestions("a1", true));

    // First compute rejects → catch bumps retryTick after a backoff (retryBackoffMs), finally
    // clears the guard → effect re-runs and a SECOND compute fires. If the guard weren't reset,
    // this would stay at 1 forever. The timeout comfortably exceeds the first-retry backoff (700ms).
    await waitFor(() => expect(computeSuggestions).toHaveBeenCalledTimes(2), { timeout: 3000 });
  });

  it("defers (no retry storm) while offline, then computes once on reconnect", async () => {
    useConnectionStore.setState({ browserOnline: false, isOnline: false });
    computeSuggestions.mockRejectedValue(new SuggestionOfflineError());

    renderHook(() => useSuggestions("a1", true));

    // Offline: exactly one compute, which throws SuggestionOfflineError. Crucially it must NOT keep
    // re-firing — the offline branch skips the retry budget AND the retryTick bump that would spin.
    await waitFor(() => expect(computeSuggestions).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(computeSuggestions).toHaveBeenCalledTimes(1);

    // Reconnect: isOnline is an effect dep, so the deferred compute for the still-blocked state
    // re-runs — and now succeeds. lastHash was never committed while offline, so it recomputes.
    computeSuggestions.mockResolvedValue({ agentId: "a1", buttons: [] });
    await act(async () => {
      useConnectionStore.setState({ browserOnline: true, isOnline: true });
    });
    await waitFor(() => expect(computeSuggestions).toHaveBeenCalledTimes(2));
  });

  it("spends no retries when the AI backend reports itself unavailable", async () => {
    // A generic rejection is worth retrying (see the "retries" test above, which reaches 2 calls).
    // An unavailable backend is not: the retries would hit the same wall, so the first failure must
    // exhaust the budget outright — exactly ONE compute for this state, where a generic error buys 3.
    computeSuggestions.mockRejectedValue(new AiUnavailableError());

    const { unmount } = renderHook(() => useSuggestions("a1", true));

    await waitFor(() => expect(computeSuggestions).toHaveBeenCalledTimes(1));
    // Wait out the window in which a retry would have fired (first-retry backoff is 700ms), and
    // confirm nothing further was attempted.
    await new Promise((r) => setTimeout(r, 1200));
    expect(computeSuggestions).toHaveBeenCalledTimes(1);
    // Budget-exhausted, so nothing re-fires — but unmount anyway so this primed hook can't leak
    // a late compute into the NEXT test's spy.
    unmount();
  });

  it("defers a mid-flight transport failure instead of retrying it", async () => {
    // The store still reads online (the reachability heartbeat is up to 30s stale), so the
    // pre-compute gate lets this through — and the request then dies at the transport layer.
    computeSuggestions.mockRejectedValue(new AiUnreachableError());

    const { unmount } = renderHook(() => useSuggestions("a1", true));

    // Exactly one compute. Before this branch existed the failure looked like a generic rejection
    // and bought the full retry budget — three paid calls, none of which could reach the host.
    // Wait past the first-retry backoff (700ms): a scheduled retry would have pushed this to 2.
    await waitFor(() => expect(computeSuggestions).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 1200));
    expect(computeSuggestions).toHaveBeenCalledTimes(1);
    // Deferring deliberately leaves lastHash uncommitted so the state recomputes on reconnect —
    // which means this hook stays primed. Unmount it so it can't fire into the NEXT test's spy.
    unmount();
  });

  it("does not retry a permanent (4xx) rejection — it can only fail the same way", async () => {
    computeSuggestions.mockRejectedValue(
      new Error("Claude request failed: ai request failed (HTTP 404)"),
    );

    renderHook(() => useSuggestions("a1", true));

    // Exactly one compute: the terminal branch burns the whole budget up front, so no retry is
    // scheduled. Wait past the first-retry backoff (700ms) — a retry, if one were scheduled, would
    // have fired by now and pushed this to 2.
    await waitFor(() => expect(computeSuggestions).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 1200));
    expect(computeSuggestions).toHaveBeenCalledTimes(1);
  });

  // NOTE: the *bound* on retryABLE persistent rejections is verified by the pure `withinRetryBudget`
  // unit test in useSuggestions.test.ts. A full hook-level simulation of that path was intentionally
  // omitted — driving repeated promise rejections through act() deadlocks this runner. The terminal
  // (non-retryable) path above needs no such driving, so it IS covered end-to-end here.
});
