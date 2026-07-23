// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// The your-turn status flip (Claude's Stop hook) races the final terminal paint into xterm, so the
// one-shot compute frequently hashes a mid-paint (or empty, terminal-not-yet-mounted) scrollback,
// commits that hash, and — without the settle-watcher — never looks at the terminal again. These
// tests drive that exact sequence with a MUTABLE scrollback + fake timers.
const computeSuggestions = vi.fn();
// The hook imports SuggestionOfflineError for its `instanceof` offline branch, so the mock must
// re-export it even though these settle tests never exercise the offline path. vi.hoisted so the
// class exists when the (hoisted) vi.mock factory runs.
const { SuggestionOfflineError } = vi.hoisted(() => ({ SuggestionOfflineError: class extends Error {} }));
vi.mock("./engine", () => ({
  computeSuggestions: (...a: unknown[]) => computeSuggestions(...a),
  SuggestionOfflineError,
}));
let scrollback = "";
vi.mock("../terminalScrollback", () => ({ getAgentScrollback: () => scrollback }));
vi.mock("../aiGate", () => ({ useAiFeature: () => true }));
vi.mock("../relayClient", () => ({ pushSuggestions: vi.fn() }));
vi.mock("../../stores/runtimeStore", () => ({
  // No workflowStage entry AND no branchStatus for a1 → the resolved stage is building_unsaved, for
  // which deriveCta returns null, so these settle/retry tests see the raw computed set with no CTA
  // merged over it. The CTA's own wiring is covered by useSuggestions.cta.test.tsx.
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

import { useSuggestions, SETTLE_TICK_MS, MAX_COMPUTE_ATTEMPTS } from "./useSuggestions";

const BTN = { id: "learned:0:x", label: "x", value: "x", kind: "prompt", source: "learned" };

beforeEach(() => {
  vi.useFakeTimers();
  computeSuggestions.mockReset();
  scrollback = "";
});
afterEach(() => vi.useRealTimers());

// Two ticks: one to seed the watcher's previous hash, one to observe it unchanged (= settled).
const settle = async () => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(SETTLE_TICK_MS * 2);
  });
};

describe("useSuggestions settle-watcher", () => {
  it("recomputes when the scrollback settles on new content after the initial compute", async () => {
    // Initial compute sees the mid-paint (empty) scrollback and finds nothing.
    computeSuggestions
      .mockResolvedValueOnce({ agentId: "a1", buttons: [] })
      .mockResolvedValueOnce({ agentId: "a1", buttons: [BTN] });

    const { result } = renderHook(() => useSuggestions("a1", true));
    await act(async () => {});
    expect(computeSuggestions).toHaveBeenCalledTimes(1);
    expect(computeSuggestions.mock.calls[0]?.[0]).toMatchObject({ scrollback: "" });

    // The terminal finishes painting AFTER the status flip already triggered the compute.
    scrollback = "All changes committed. Say the word to rebase and open a PR.";
    await settle();

    expect(computeSuggestions).toHaveBeenCalledTimes(2);
    expect(computeSuggestions.mock.calls[1]?.[0]).toMatchObject({ scrollback });
    expect(result.current.buttons).toEqual([BTN]);
  });

  it("does not recompute on a still-changing (unsettled) scrollback tail", async () => {
    computeSuggestions.mockResolvedValue({ agentId: "a1", buttons: [] });
    renderHook(() => useSuggestions("a1", true));
    await act(async () => {});
    expect(computeSuggestions).toHaveBeenCalledTimes(1);

    // The tail changes on EVERY tick — never two identical hashes in a row, so never a compute.
    for (let i = 0; i < 4; i++) {
      scrollback += `\nstreaming line ${i}`;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(SETTLE_TICK_MS);
      });
    }
    expect(computeSuggestions).toHaveBeenCalledTimes(1);
  });

  it("does not recompute the hash it already computed (one paid call per settled state)", async () => {
    computeSuggestions.mockResolvedValue({ agentId: "a1", buttons: [] });
    scrollback = "settled from the start";
    renderHook(() => useSuggestions("a1", true));
    await act(async () => {});
    expect(computeSuggestions).toHaveBeenCalledTimes(1);

    await settle();
    await settle();
    expect(computeSuggestions).toHaveBeenCalledTimes(1);
  });

  it("retries a persistently-failing state EXACTLY up to the budget, then stops", async () => {
    computeSuggestions.mockRejectedValue(new Error("boom"));
    scrollback = "stable failing state";
    renderHook(() => useSuggestions("a1", true));
    await act(async () => {});

    // Let the watcher tick far past the budget. The retries must actually HAPPEN (a dead watcher
    // would leave this at 1) and must stop exactly at the budget (attempt 3 exhausts it; the
    // watcher's lastFailHash gate then refuses to resurrect the loop).
    for (let i = 0; i < 10; i++) await settle();
    expect(computeSuggestions).toHaveBeenCalledTimes(MAX_COMPUTE_ATTEMPTS);
  });

  it("does not buy a fresh paid call for an exhausted hash on a composer type-then-clear cycle", async () => {
    computeSuggestions.mockRejectedValue(new Error("boom"));
    scrollback = "stable failing state";
    const { rerender } = renderHook(({ empty }) => useSuggestions("a1", empty), {
      initialProps: { empty: true },
    });
    // The failed-compute retries are spaced by a backoff timer (retryBackoffMs), so pump the fake
    // clock in steps (one reject→timer→retry hop settles per step) until the budget is spent.
    for (let i = 0; i < 6; i++) await settle();
    expect(computeSuggestions).toHaveBeenCalledTimes(MAX_COMPUTE_ATTEMPTS);

    // The user types and deletes: composerEmpty flips false → true, re-running the compute effect
    // for the SAME exhausted hash. The effect's budget gate must refuse it.
    rerender({ empty: false });
    rerender({ empty: true });
    for (let i = 0; i < 4; i++) await settle();
    expect(computeSuggestions).toHaveBeenCalledTimes(MAX_COMPUTE_ATTEMPTS);
  });

  it("recovers from a transient failure: fail once, succeed on retry, fresh budget later", async () => {
    computeSuggestions
      .mockRejectedValueOnce(new Error("blip"))
      .mockResolvedValueOnce({ agentId: "a1", buttons: [BTN] })
      .mockRejectedValue(new Error("persistent"));
    scrollback = "state A, settled";
    const { result } = renderHook(() => useSuggestions("a1", true));
    // First attempt rejects, then a backoff-delayed retry (retryBackoffMs) succeeds → buttons
    // render (the whole point of rethrowing engine failures instead of resolving []). Pump the fake
    // clock past the first-retry backoff to let that reject→timer→retry→resolve chain run.
    await settle();
    await settle();
    expect(result.current.buttons).toEqual([BTN]);
    expect(computeSuggestions).toHaveBeenCalledTimes(2);

    // A LATER distinct failing state gets the FULL budget (success reset the failure counter).
    scrollback = "state B, settled, persistently failing";
    for (let i = 0; i < 10; i++) await settle();
    expect(computeSuggestions).toHaveBeenCalledTimes(2 + MAX_COMPUTE_ATTEMPTS);
  });

  it("drops stale buttons (and retires the phone copy) once a failing state exhausts the budget", async () => {
    computeSuggestions
      .mockResolvedValueOnce({ agentId: "a1", buttons: [BTN] })
      .mockRejectedValue(new Error("boom"));
    scrollback = "state A, settled";
    const { result } = renderHook(() => useSuggestions("a1", true));
    await act(async () => {});
    expect(result.current.buttons).toEqual([BTN]);

    // The terminal advances to state B, whose compute fails every attempt. State A's buttons must
    // NOT stay live against a terminal that shows something else.
    scrollback = "state B, settled, uncomputable";
    for (let i = 0; i < 6; i++) await settle();
    expect(result.current.buttons).toEqual([]);
  });

  it("does not resurrect just-cleared suggestions while the settled state is unchanged", async () => {
    computeSuggestions.mockResolvedValue({ agentId: "a1", buttons: [BTN] });
    scrollback = "settled state the user acted on";
    const { result } = renderHook(() => useSuggestions("a1", true));
    await act(async () => {});
    expect(result.current.buttons).toEqual([BTN]);

    // A suggestion click clears the row; the agent may stay your-turn for a beat. The watcher
    // must NOT recompute (and re-push) the very state the user just acted on...
    await act(async () => {
      result.current.clear();
    });
    await settle();
    await settle();
    expect(computeSuggestions).toHaveBeenCalledTimes(1);
    expect(result.current.buttons).toEqual([]);

    // ...but once the terminal actually moves, the new settled state computes normally.
    scrollback = "agent replied with new output";
    await settle();
    expect(computeSuggestions).toHaveBeenCalledTimes(2);
  });

  it("stops watching (no further computes) once the composer goes non-empty", async () => {
    computeSuggestions.mockResolvedValue({ agentId: "a1", buttons: [] });
    scrollback = "first settled state";
    const { rerender } = renderHook(({ empty }) => useSuggestions("a1", empty), {
      initialProps: { empty: true },
    });
    await act(async () => {});
    expect(computeSuggestions).toHaveBeenCalledTimes(1);

    // The user starts typing: the watcher must tear down — new settled content must NOT trigger
    // a (paid) compute while the composer is non-empty.
    rerender({ empty: false });
    scrollback = "agent painted something new while the user was typing";
    await settle();
    await settle();
    expect(computeSuggestions).toHaveBeenCalledTimes(1);
  });
});
