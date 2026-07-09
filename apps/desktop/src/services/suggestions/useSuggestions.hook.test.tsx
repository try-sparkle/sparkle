// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

// Mock every dependency the hook reaches so we can drive compute timing deterministically.
const computeSuggestions = vi.fn();
vi.mock("./engine", () => ({ computeSuggestions: (...a: unknown[]) => computeSuggestions(...a) }));
vi.mock("../terminalScrollback", () => ({ getAgentScrollback: () => "Done. Committed abc. Nothing further." }));
vi.mock("../aiGate", () => ({ useAiFeature: () => true }));
vi.mock("../relayClient", () => ({ pushSuggestions: vi.fn() }));
vi.mock("../../stores/runtimeStore", () => ({
  // status[agentId] === "idle" → a your-turn state, so the hook computes. workflowShipped empty →
  // not shipped, so the shipped effect is a no-op and the compute path runs.
  useRuntimeStore: (
    sel: (s: { status: Record<string, string>; workflowShipped: Record<string, boolean> }) => unknown,
  ) => sel({ status: { a1: "idle" }, workflowShipped: {} }),
}));
vi.mock("./controlButtons", () => ({
  closeBuildAgentButton: () => ({ id: "control:closeAgent", label: "Close Build Agent", value: "control:closeAgent", kind: "control", source: "control" }),
}));

import { useSuggestions } from "./useSuggestions";

beforeEach(() => computeSuggestions.mockReset());

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

  // NOTE: the *bound* on persistent-rejection retries is verified by the pure `withinRetryBudget`
  // unit test in useSuggestions.test.ts. A full hook-level persistent-reject simulation was
  // intentionally omitted — driving repeated promise rejections through act() deadlocks this
  // runner — and the budget logic is the only new piece, so the pure test covers it deterministically.
});
