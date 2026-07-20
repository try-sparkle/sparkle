// @vitest-environment jsdom
// The stage-driven CTA, exercised through the real hook. The sibling useSuggestions.test.ts is a
// PURE unit file (hash/backoff/gating helpers) with no jsdom or store harness, so the hook-level
// wiring lives here rather than being bolted onto it.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, cleanup, act } from "@testing-library/react";

// Mock every paid/IO edge so the CTA merge is the only thing under test. vi.mock factories are
// hoisted above the module body, so the spies they close over must come from vi.hoisted.
const h = vi.hoisted(() => ({
  computeSuggestions: vi.fn(),
  getAgentScrollback: vi.fn((_id: string) => "some terminal text" as string | null),
  pushSuggestions: vi.fn(),
}));
const { computeSuggestions, getAgentScrollback, pushSuggestions } = h;

vi.mock("./engine", () => ({
  computeSuggestions: (a: unknown) => h.computeSuggestions(a),
  // The hook branches on `instanceof SuggestionOfflineError`, so the mock must export a real class.
  SuggestionOfflineError: class SuggestionOfflineError extends Error {},
}));

vi.mock("../terminalScrollback", () => ({
  getAgentScrollback: (id: string) => h.getAgentScrollback(id),
}));

vi.mock("../aiGate", () => ({ useAiFeature: () => true }));

vi.mock("../relayClient", () => ({ pushSuggestions: (p: unknown) => h.pushSuggestions(p) }));

vi.mock("./approvalsRuntime", () => ({ maybeAutoApprove: () => null }));

import { useSuggestions } from "./useSuggestions";
import { useRuntimeStore } from "../../stores/runtimeStore";
import { useConnectionStore } from "../../stores/connectionStore";
import type { WorkflowState } from "../branchStatus";
import type { WorkflowStageId } from "../../engine/workflowStage";

const ws = (over: Partial<WorkflowState> = {}): WorkflowState => ({
  inLocalMain: false,
  inOriginMain: false,
  inParent: false,
  aheadOfBase: 0,
  prState: null,
  prNumber: null,
  prUrl: null,
  ...over,
});

/** Seed one agent in the your-turn "idle" state, with a live stage (+ raw workflow signals). Tests
 *  that care about a working agent drive the idle→working TRANSITION instead of seeding it, so the
 *  assertion can't pass before the CTA had a chance to appear. */
function seed(opts: { stage?: WorkflowStageId; shipped?: boolean; workflowState?: WorkflowState }) {
  useRuntimeStore.setState({
    status: { a1: "idle" },
    workflowStage: opts.stage ? { a1: opts.stage } : {},
    workflowShipped: opts.shipped ? { a1: true } : {},
    workflowState: opts.workflowState ? { a1: opts.workflowState } : {},
  });
}

beforeEach(() => {
  computeSuggestions.mockReset();
  computeSuggestions.mockResolvedValue({ agentId: "a1", buttons: [] });
  pushSuggestions.mockClear();
  getAgentScrollback.mockReturnValue("some terminal text");
  useConnectionStore.setState({ isOnline: true });
});
afterEach(cleanup);

describe("useSuggestions — stage-driven CTA", () => {
  // REGRESSION — founder screenshot, 2026-07-15: an agent that had landed EARLIER work ("like the
  // earlier features") showed a green "Close Build Agent" pill while its own text read "It's all
  // committed on sparkle/agent-4ef7f231... I haven't pushed to main. Want me to land it?".
  // workflowShipped had latched on the earlier cycle and never cleared.
  it("offers Land, not Close, when prior work landed but fresh commits are un-landed", async () => {
    seed({ stage: "building_saved", shipped: true, workflowState: ws() });
    const { result } = renderHook(() => useSuggestions("a1", true));
    await waitFor(() => {
      expect(result.current.buttons[0]?.label).toBe("Land to Main");
    });
  });

  // Re-aimed coverage of the OLD shipped→Close short-circuit: Close is still the right call, but it
  // must now come from the live stage rather than the latch-once watermark.
  it("merged (origin has it) offers Close Build Agent", async () => {
    seed({ stage: "merged", shipped: true, workflowState: ws({ inOriginMain: true }) });
    const { result } = renderHook(() => useSuggestions("a1", true));
    await waitFor(() => {
      expect(result.current.buttons[0]?.label).toBe("Close Build Agent");
      expect(result.current.buttons[0]?.kind).toBe("control");
    });
  });

  it("shipped stage offers Close Build Agent", async () => {
    seed({ stage: "shipped", shipped: true, workflowState: ws({ inOriginMain: true }) });
    const { result } = renderHook(() => useSuggestions("a1", true));
    await waitFor(() => {
      expect(result.current.buttons[0]?.label).toBe("Close Build Agent");
    });
  });

  // REGRESSION — founder screenshot 2: landed on local main, nothing pushed → Push, not Close.
  it("merged_local with a known remote offers Push to Origin Main", async () => {
    seed({
      stage: "merged_local",
      shipped: false,
      workflowState: ws({ inLocalMain: true, hasRemote: true }),
    });
    const { result } = renderHook(() => useSuggestions("a1", true));
    await waitFor(() => {
      expect(result.current.buttons[0]?.label).toBe("Push to Origin Main");
    });
    // Close must stay reachable behind the caret, or the agent can never be closed.
    expect(result.current.buttons.map((b) => b.label)).toContain("Close Build Agent");
  });

  // The old code short-circuited on `shipped` and skipped compute entirely, so the caret was empty.
  it("computed suggestions still populate the caret alternates alongside the CTA", async () => {
    computeSuggestions.mockResolvedValue({
      agentId: "a1",
      buttons: [
        { id: "s:dmg", label: "Cut a DMG", value: "Cut a DMG.", kind: "prompt", source: "learned" },
      ],
    });
    seed({ stage: "building_saved", shipped: true, workflowState: ws() });
    const { result } = renderHook(() => useSuggestions("a1", true));
    await waitFor(() => {
      expect(result.current.buttons.map((b) => b.label)).toEqual(["Land to Main", "Cut a DMG"]);
    });
    // Compute must actually run now — the shipped short-circuit used to skip it.
    expect(computeSuggestions).toHaveBeenCalled();
  });

  it("relays the same set (CTA first) to the phone", async () => {
    seed({ stage: "building_saved", shipped: true, workflowState: ws() });
    renderHook(() => useSuggestions("a1", true));
    await waitFor(() => {
      const relayed = pushSuggestions.mock.calls
        .map((c) => c[0] as { buttons: Array<{ label: string }> })
        .filter((p) => p.buttons.length > 0);
      expect(relayed.at(-1)?.buttons[0]?.label).toBe("Land to Main");
    });
  });

  // REGRESSION (roborev #38082, High): deriveCta builds its primary from `stage`/`ws` alone, so
  // applyCta([]) is NON-empty. SuggestionRow is gated only on the composer being empty
  // (suggestionRowVisible), NOT on your-turn — so without a your-turn gate here, a build agent that
  // is actively WORKING with committed work renders a "Land to Main" pill mid-turn.
  //
  // Driven as a TRANSITION rather than a bare working seed: waiting for the CTA to appear first
  // proves the harness genuinely CAN populate it, so the emptiness assertion can't pass vacuously
  // (a plain `await sleep(20)` would assert emptiness before anything could have rendered).
  it("a WORKING agent shows no CTA, even with committed work", async () => {
    seed({ stage: "building_saved", workflowState: ws() });
    const { result } = renderHook(() => useSuggestions("a1", true));
    await waitFor(() => expect(result.current.buttons[0]?.label).toBe("Land to Main"));
    act(() => useRuntimeStore.setState({ status: { a1: "working" as never } }));
    await waitFor(() => expect(result.current.buttons).toEqual([]));
  });

  it("a working agent at merged shows no CTA either", async () => {
    seed({ stage: "merged", workflowState: ws({ inOriginMain: true }) });
    const { result } = renderHook(() => useSuggestions("a1", true));
    await waitFor(() => expect(result.current.buttons[0]?.label).toBe("Close Build Agent"));
    act(() => useRuntimeStore.setState({ status: { a1: "working" as never } }));
    await waitFor(() => expect(result.current.buttons).toEqual([]));
  });

  // REGRESSION (roborev #38384, Medium): consolidating the relay push into the render effect dropped
  // the guard that stopped it from UNDOING a retire(). On the your-turn→working transition React
  // commits a render where isYourTurn is already false but `buttons` still holds the old set
  // (setButtons([]) hasn't flushed). Effects run in declaration order, so the reset effect retires
  // (pushes []) and the push effect then immediately re-pushes that stale set — re-arming taps on
  // the phone for a state the agent has moved on from. clear() doesn't hit this (it's a callback, so
  // retire() runs before the re-render), which is why the "exactly once" test can't catch it.
  it("going back to work retires the phone's copy and never re-pushes it", async () => {
    // A NON-EMPTY computed set is essential: the stale set is what gets wrongly re-pushed. With the
    // default empty compute there is nothing stale to re-push and this passes vacuously.
    computeSuggestions.mockResolvedValue({
      agentId: "a1",
      buttons: [
        { id: "s:dmg", label: "Cut a DMG", value: "Cut a DMG.", kind: "prompt", source: "learned" },
      ],
    });
    seed({ stage: "building_saved", workflowState: ws() });
    const { result } = renderHook(() => useSuggestions("a1", true));
    await waitFor(() => expect(result.current.buttons[0]?.label).toBe("Land to Main"));
    await waitFor(() =>
      expect(
        pushSuggestions.mock.calls.some(
          (c) => (c[0] as { buttons: unknown[] }).buttons.length > 0,
        ),
      ).toBe(true),
    );
    pushSuggestions.mockClear();

    // No arbitrary sleep: waiting for the cleared buttons forces the retire commit's effect flush,
    // which is exactly where the wrongful re-push fires.
    act(() => useRuntimeStore.setState({ status: { a1: "working" as never } }));
    await waitFor(() => expect(result.current.buttons).toEqual([]));

    const sent = pushSuggestions.mock.calls.map((c) => c[0] as { buttons: unknown[] });
    expect(sent.length).toBeGreaterThan(0);
    // Every push after the agent went back to work must be a retire — a non-empty one would re-arm
    // the phone for a turn that is over.
    expect(sent.every((p) => p.buttons.length === 0)).toBe(true);
  });

  // REGRESSION (roborev #38082, Medium): the dismissal filter ran BEFORE the CTA merge, and
  // deriveCta unconditionally prepends its primary — so the pill's × advertised an action it could
  // not perform (click × → identical pill re-renders).
  it("dismissing the CTA primary actually removes it", async () => {
    computeSuggestions.mockResolvedValue({
      agentId: "a1",
      buttons: [
        { id: "s:dmg", label: "Cut a DMG", value: "Cut a DMG.", kind: "prompt", source: "learned" },
      ],
    });
    seed({ stage: "building_saved", workflowState: ws() });
    const { result } = renderHook(() => useSuggestions("a1", true));
    await waitFor(() => expect(result.current.buttons[0]?.label).toBe("Land to Main"));
    act(() => result.current.dismiss("cta:landToMain"));
    await waitFor(() => {
      expect(result.current.buttons.map((b) => b.label)).toEqual(["Cut a DMG"]);
    });
  });

  // REGRESSION (roborev #38082, Low): the compute path pushed to the relay and the render effect
  // then pushed the SAME set again, so every successful compute relayed two identical events.
  //
  // Asserts no two CONSECUTIVE pushes share a signature — exactly what the sig guard promises.
  // Global uniqueness would be stronger than the code guarantees: a set → retire → the same set
  // recomputed is a legitimate repeat of one signature.
  //
  // A NON-EMPTY computed set is what makes this falsifiable. An earlier version used the default
  // empty compute, which yields exactly ONE push — and "no two consecutive signatures match" is
  // vacuously true over a one-element array, so it could never have caught the bug it named.
  //
  // The legitimate trace here is TWO pushes with DIFFERENT content: the CTA relays as soon as the
  // agent is your-turn with committed work (["cta:landToMain"]), then the computed alternates join
  // it (["cta:landToMain","s:dmg"]). Restoring the second push owner would emit that final set
  // twice in a row, which this catches (verified by mutation, not just by going green).
  it("never relays the same set twice in a row", async () => {
    computeSuggestions.mockResolvedValue({
      agentId: "a1",
      buttons: [
        { id: "s:dmg", label: "Cut a DMG", value: "Cut a DMG.", kind: "prompt", source: "learned" },
      ],
    });
    seed({ stage: "building_saved", workflowState: ws() });
    const { result } = renderHook(() => useSuggestions("a1", true));
    await waitFor(() =>
      expect(result.current.buttons.map((b) => b.label)).toEqual(["Land to Main", "Cut a DMG"]),
    );

    const sigs = () =>
      pushSuggestions.mock.calls
        .map((c) => c[0] as { buttons: Array<{ id: string }> })
        .map((p) => p.buttons.map((b) => b.id).join("|"));
    // Guard the guard: the invariant is only meaningful once more than one push exists.
    await waitFor(() => expect(sigs().length).toBeGreaterThan(1));
    expect(sigs().some((s, i) => i > 0 && s === sigs()[i - 1])).toBe(false);
    // NOTE: a "benign re-render must not re-relay" tail used to live here and was DELETED rather
    // than fixed. Flipping status idle→waiting changes none of the push effect's deps
    // ([agentId, shownSig, isYourTurn] — both statuses are your-turn), so React never re-ran the
    // effect and the assertion held whether or not the sig guard existed. The consecutive-signature
    // assertion above already covers the invariant; a tail that cannot fail is worse than none.
  });

  it("with no committed work yet, ordinary suggestions stand on their own", async () => {
    computeSuggestions.mockResolvedValue({
      agentId: "a1",
      buttons: [
        { id: "s:y", label: "Approve", value: "y\n", kind: "terminal", source: "heuristic" },
      ],
    });
    seed({ stage: "building_unsaved", workflowState: ws() });
    const { result } = renderHook(() => useSuggestions("a1", true));
    await waitFor(() => {
      expect(result.current.buttons.map((b) => b.label)).toEqual(["Approve"]);
    });
  });
});
