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
const maybeAutoPlan = vi.fn(() => null as string | null);
// A SPY, not the constant `() => null` it used to be — and the difference is the whole reason the
// memo branch could stop calling this function without a single test noticing. A stub that always
// answers "not a resume prompt" is satisfied by never being asked, so it cannot distinguish the
// answerer declining from the answerer being unreachable. That is exactly what happened: the plan
// arm was added to this branch while the resume arm was still missing from it.
const maybeAutoResume = vi.fn(() => null as string | null);
vi.mock("./approvalsRuntime", () => ({
  maybeAutoApprove: (...a: unknown[]) => maybeAutoApprove(...(a as [])),
  maybeAutoResume: (...a: unknown[]) => maybeAutoResume(...(a as [])),
  maybeAutoPlan: (...a: unknown[]) => maybeAutoPlan(...(a as [])),
}));
vi.mock("./pendingQuestion", () => ({ detectPendingQuestion: () => false }));

// Mutable status so a test can flip the agent out of your-turn and back — the transition that
// nulls `lastHash` and, before the memo, re-bought the compute for an unchanged screen.
let status = "idle";
vi.mock("../../stores/runtimeStore", () => {
  const runtimeState = () => ({
    status: { a1: status },
    workflowShipped: {},
    workflowStage: {},
    workflowState: {},
    branchStatus: {},
  });
  return {
  useRuntimeStore: Object.assign(
    (sel: (s: {
      status: Record<string, string>;
      workflowShipped: Record<string, boolean>;
      workflowStage: Record<string, string>;
      workflowState: Record<string, unknown>;
      branchStatus: Record<string, unknown>;
    }) => unknown,
  ) => sel(runtimeState()),
    // getState is REQUIRED, not decoration: useSuggestions re-checks the LIVE status before typing
    // a picker answer, so a mock without it makes that guard read undefined and bail — which looks
    // like the hook computing nothing at all. A mock that models less than the real store fails
    // open, and this one did (roborev 53203).
    { getState: runtimeState },
  ),
  };
});

import { useSuggestions, rememberComputed, MEMO_LIMIT , resetSuggestionMemory } from "./useSuggestions";
import { useConnectionStore } from "../../stores/connectionStore";

beforeEach(() => {
  // handledSigs/memo are per-AGENT module state now (they must survive a remount to stop
  // auto-approve re-firing), so each case has to start from a clean slate.
  resetSuggestionMemory();
  computeSuggestions.mockReset();
  maybeAutoApprove.mockReset();
  maybeAutoApprove.mockReturnValue(null);
  // Re-armed rather than `mockReset()`: these two default to NULL, and null is a load-bearing value
  // here — `memoPlan === null` is what lets the approver run at all, so a reset (which would make
  // them return undefined) would silently disable the approve arm in every case below.
  maybeAutoPlan.mockReturnValue(null);
  maybeAutoResume.mockReset();
  maybeAutoResume.mockReturnValue(null);
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

  it("a memo hit the PLAN path has claimed is never offered to the approver", async () => {
    // The leak this closes. Only NON-auto-answered results are memoized, so the screen that reaches
    // the memo branch under `plan = "ask"` is precisely a plan prompt the founder asked to see —
    // and `maybeAutoApprove` cannot classify that dialog, so it hands it to the CONCIERGE, which
    // answers it. The opt-out would then hold on the first sighting and leak on the second.
    computeSuggestions.mockResolvedValue({ agentId: "a1", buttons: [BTN] });

    const { rerender } = renderHook(() => useSuggestions("a1", true));
    await act(async () => {});
    expect(computeSuggestions).toHaveBeenCalledTimes(1);

    status = "working";
    rerender();
    await act(async () => {});

    // The same screen comes back, and the plan path now CLAIMS it ("asked" = decided, not answered).
    maybeAutoPlan.mockReturnValue("asked");
    maybeAutoApprove.mockClear();
    status = "idle";
    rerender();
    await act(async () => {});

    expect(maybeAutoPlan).toHaveBeenCalled();
    expect(maybeAutoApprove).not.toHaveBeenCalled(); // ← the assertion that fails without the guard
  });

  it("a FRESH screen the plan path has claimed is never offered to the approver either", async () => {
    // The same guard on the other call site — the ordinary compute path, not the memo hit. Both
    // exist, so covering one and not the other is the shape AGENTS.md names: a fix wired into two
    // sites, verified at one, shipping with the hole intact at the other.
    computeSuggestions.mockResolvedValue({ agentId: "a1", buttons: [BTN] });
    maybeAutoPlan.mockReturnValue("asked");
    maybeAutoApprove.mockClear();

    renderHook(() => useSuggestions("a1", true));
    await act(async () => {});

    expect(maybeAutoPlan).toHaveBeenCalled();
    expect(maybeAutoApprove).not.toHaveBeenCalled();
  });

  it("still offers an UNCLAIMED memo hit to the approver — the guard is not a blanket", async () => {
    // The paired case: proving the approver is skipped means nothing unless it is normally reached
    // through this same branch.
    computeSuggestions.mockResolvedValue({ agentId: "a1", buttons: [BTN] });

    const { rerender } = renderHook(() => useSuggestions("a1", true));
    await act(async () => {});

    status = "working";
    rerender();
    await act(async () => {});

    maybeAutoPlan.mockReturnValue(null);
    maybeAutoApprove.mockClear();
    status = "idle";
    rerender();
    await act(async () => {});

    expect(maybeAutoApprove).toHaveBeenCalled();
  });

  // THE RESUME SIBLING OF THE THREE PLAN CASES ABOVE, and it was missing — which is how this branch
  // came to consult two of the three answerers: the async path runs plan → resume → approve, this
  // one ran plan → approve.
  //
  // HOW A RESUME PICKER ACTUALLY REACHES THIS BRANCH, because the obvious story is WRONG (roborev
  // 65801). It is not "the same picker on the next restart": the async path's auto-resume arm
  // returns BEFORE `rememberComputed`, so a screen that WAS auto-answered is never memoized at all.
  // Only a NON-auto-answered screen gets cached — the rule was `ask`, the master toggle was off, or
  // `isLive()` was false at the time. So the reachable path is the same one the auto-approve case
  // above models: the screen is memoized while the gate is CLOSED, the gate then OPENS (the founder
  // sets `[approvals].resume`), and the return visit must defer to the answerer rather than serve
  // its cached pills. That is exactly the transition this test drives.
  //
  // TWO ASSERTIONS, BECAUSE ONE IS NOT ENOUGH — and the first one has to be SCOPED. That
  // `maybeAutoResume` is called is the reachability claim, and reachability was the entire defect;
  // but it is also called on the FIRST render's async path, so a bare `toHaveBeenCalled()` is true
  // before this branch runs and would pass with the new arm deleted. It is cleared immediately
  // before the return visit so the call it asserts can only have come from the memo branch.
  it("still auto-RESUMES on a memo hit whose state is the session-resume picker", async () => {
    computeSuggestions.mockResolvedValue({ agentId: "a1", buttons: [BTN] });

    const { result, rerender } = renderHook(() => useSuggestions("a1", true));
    await act(async () => {});
    expect(computeSuggestions).toHaveBeenCalledTimes(1);
    expect(result.current.buttons).toHaveLength(1);

    status = "working";
    rerender();
    await act(async () => {});

    // Same screen, and the gate has now OPENED: the founder set `[approvals].resume` between the two
    // visits, so the detector that declined on the first sighting claims the screen on this one.
    // CLEARED, not merely re-stubbed — see the note above: without this the reachability assertion
    // is already satisfied by the first render and cannot fail.
    maybeAutoResume.mockClear();
    maybeAutoResume.mockReturnValue("summary");
    maybeAutoApprove.mockClear();
    status = "idle";
    rerender();
    await act(async () => {});

    expect(computeSuggestions).toHaveBeenCalledTimes(1); // still no second paid call
    // Scoped to the memo-hit render by the mockClear above — this is the assertion that goes red
    // when the new arm is deleted, which is the whole point of upgrading the mock to a spy.
    expect(maybeAutoResume).toHaveBeenCalledTimes(1);
    expect(maybeAutoApprove).not.toHaveBeenCalled(); // the screen is answered; not the approver's
    expect(result.current.buttons).toHaveLength(0); // pills suppressed — answered on his behalf
    expect(result.current.autoApproved).toBeNull(); // not a CATEGORY note; resume has its own words
  });

  // PAIRED with it: the same branch, the same mocks, resume declining. The approver IS reached and
  // the cached pills ARE served — so the silence above is attributable to the resume answerer
  // claiming the screen, and not to this branch having gone inert.
  it("…and still serves the memo hit normally when resume declines", async () => {
    computeSuggestions.mockResolvedValue({ agentId: "a1", buttons: [BTN] });

    const { result, rerender } = renderHook(() => useSuggestions("a1", true));
    await act(async () => {});

    status = "working";
    rerender();
    await act(async () => {});

    maybeAutoResume.mockClear(); // same scoping as above: "was reached" must mean THIS render
    maybeAutoResume.mockReturnValue(null); // not a resume prompt
    maybeAutoApprove.mockClear();
    status = "idle";
    rerender();
    await act(async () => {});

    expect(maybeAutoResume).toHaveBeenCalledTimes(1);
    expect(maybeAutoApprove).toHaveBeenCalled();
    expect(result.current.buttons).toHaveLength(1);
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
