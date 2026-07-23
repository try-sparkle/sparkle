// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

const computeSuggestions = vi.fn();
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

// The terminal screen the agent is parked on. Mutable so a test can move the terminal on and prove
// a genuinely different state still recomputes.
let scrollback = "Done. Committed abc. Nothing further.";
vi.mock("../terminalScrollback", () => ({ getAgentScrollback: () => scrollback }));
vi.mock("../aiGate", () => ({ useAiFeature: () => true }));
vi.mock("../relayClient", () => ({ pushSuggestions: vi.fn() }));

// Mocked so these tests isolate the CACHING behavior. Left real, they would implicitly depend on
// the auto-approve and pending-question classifiers continuing to read the chosen fixture strings
// as "not a prompt / no question" — so a future heuristics change would fail the memo tests for
// reasons that have nothing to do with the memo. Mocking also lets the auto-approve-on-hit test
// below drive the branch directly.
const maybeAutoApprove = vi.fn(() => null as string | null);
vi.mock("./approvalsRuntime", () => ({
  maybeAutoApprove: (...a: unknown[]) => maybeAutoApprove(...(a as [])),
  maybeAutoResume: () => null,
}));
vi.mock("./pendingQuestion", () => ({ detectPendingQuestion: () => false }));

// Mutable status so a test can flip the agent out of your-turn and back — the transition that
// nulls `lastHash` and, before the memo, re-bought the compute for an unchanged screen.
let status = "idle";
vi.mock("../../stores/runtimeStore", () => ({
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
      status: { a1: status },
      workflowShipped: {},
      workflowStage: {},
      workflowState: {},
      branchStatus: {},
    }),
}));

import { useSuggestions, rememberComputed, MEMO_LIMIT } from "./useSuggestions";
import { useConnectionStore } from "../../stores/connectionStore";

beforeEach(() => {
  computeSuggestions.mockReset();
  maybeAutoApprove.mockReset();
  maybeAutoApprove.mockReturnValue(null);
  scrollback = "Done. Committed abc. Nothing further.";
  status = "idle";
  useConnectionStore.setState({ browserOnline: true, probeOk: true, isOnline: true });
});

const BTN = { id: "learned:0:x", label: "Open PR", value: "Open a PR", kind: "prompt", source: "learned" };

describe("useSuggestions memo across your-turn flips", () => {
  it("does not recompute when the agent returns to the SAME settled screen", async () => {
    computeSuggestions.mockResolvedValue({ agentId: "a1", buttons: [BTN] });

    const { result, rerender } = renderHook(() => useSuggestions("a1", true));
    await act(async () => {});
    expect(computeSuggestions).toHaveBeenCalledTimes(1);
    expect(result.current.buttons).toHaveLength(1);

    // Agent goes back to working: buttons are dropped and lastHash is nulled.
    status = "working";
    rerender();
    await act(async () => {});
    expect(result.current.buttons).toHaveLength(0);

    // ...and returns to your-turn on the identical screen. The memo serves it: no second call.
    status = "idle";
    rerender();
    await act(async () => {});
    expect(computeSuggestions).toHaveBeenCalledTimes(1);
    expect(result.current.buttons).toHaveLength(1);
  });

  it("still computes when the screen actually changed", async () => {
    computeSuggestions.mockResolvedValue({ agentId: "a1", buttons: [BTN] });

    const { rerender } = renderHook(() => useSuggestions("a1", true));
    await act(async () => {});
    expect(computeSuggestions).toHaveBeenCalledTimes(1);

    status = "working";
    rerender();
    await act(async () => {});

    scrollback = "Ran the tests. 3 failed. Want me to dig in?";
    status = "idle";
    rerender();
    await act(async () => {});
    expect(computeSuggestions).toHaveBeenCalledTimes(2);
  });

  // The subtlest branch: a screen memoized as ordinary buttons must still be AUTO-ANSWERED on the
  // return visit if it now classifies that way (the user turned on an "always" rule in between).
  // This is the path that sends a real keystroke, so serving the memo blindly would silently leave
  // a permission prompt sitting there showing buttons instead of being answered.
  it("still auto-approves on a memo hit whose state now classifies as auto-approve", async () => {
    computeSuggestions.mockResolvedValue({ agentId: "a1", buttons: [BTN] });

    const { result, rerender } = renderHook(() => useSuggestions("a1", true));
    await act(async () => {});
    expect(computeSuggestions).toHaveBeenCalledTimes(1);
    expect(result.current.buttons).toHaveLength(1);
    expect(result.current.autoApproved).toBeNull();

    status = "working";
    rerender();
    await act(async () => {});

    // Same screen, but the classifier now claims it — the memo hit must defer to it.
    maybeAutoApprove.mockReturnValue("file-write");
    status = "idle";
    rerender();
    await act(async () => {});

    expect(computeSuggestions).toHaveBeenCalledTimes(1); // still no second paid call
    expect(maybeAutoApprove).toHaveBeenCalled();
    expect(result.current.autoApproved).toBe("file-write");
    expect(result.current.buttons).toHaveLength(0);
  });
});

describe("rememberComputed", () => {
  it("evicts the oldest entry past the limit and refreshes recency on re-insert", () => {
    const memo = new Map<string, number>();
    for (let i = 0; i < MEMO_LIMIT; i++) rememberComputed(memo, `h${i}`, i);
    expect(memo.size).toBe(MEMO_LIMIT);

    // Touch the oldest so it is no longer the eviction candidate.
    rememberComputed(memo, "h0", 0);
    rememberComputed(memo, "new", 99);

    expect(memo.size).toBe(MEMO_LIMIT);
    expect(memo.has("h0")).toBe(true);
    expect(memo.has("h1")).toBe(false); // the oldest after h0 was refreshed
    expect(memo.get("new")).toBe(99);
  });
});
