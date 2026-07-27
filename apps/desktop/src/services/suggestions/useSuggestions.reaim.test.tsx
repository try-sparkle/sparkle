// @vitest-environment jsdom
//
// RE-POINTING one instance at a different agent.
//
// `useSuggestions` was written on "one hook instance owns one agent" — see the comments on
// `handledSigs` — and for a long time nothing in it reset on `agentId` changing. ConciergeSuggestions
// mounts it with `key={agentId}` for exactly that reason, and that mitigation is correct and stays.
// This file pins the guarantee at the HOOK level, so the invariant no longer depends on every
// caller remembering the key: the Probe below deliberately mounts ONE instance and re-points it,
// which is precisely what `key=` prevents and therefore what `key=` can never prove.
//
// The consequence that must never ship is at the top of this file for a reason: agent A's computed
// buttons rendered under agent B's name, and a click in that window sent A's prompt into B's
// TERMINAL. `memo` and the `fail` budget carrying over are the quieter two.
import { useLayoutEffect } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";

const computeSuggestions = vi.fn();
const { SuggestionOfflineError } = vi.hoisted(() => {
  class SuggestionOfflineError extends Error {}
  return { SuggestionOfflineError };
});
vi.mock("./engine", () => ({
  computeSuggestions: (...a: unknown[]) => computeSuggestions(...a),
  SuggestionOfflineError,
}));
const { AiUnavailableError, AiUnreachableError } = vi.hoisted(() => {
  class AiUnavailableError extends Error {}
  class AiUnreachableError extends Error {}
  return { AiUnavailableError, AiUnreachableError };
});
vi.mock("../anthropic", () => ({ AiUnavailableError, AiUnreachableError }));

// PER-AGENT scrollback — the whole point of this file is that two agents are in play at once, so a
// single constant screen (what the other useSuggestions suites use) would hide exactly what's
// being tested.
const { screens } = vi.hoisted(() => ({ screens: {} as Record<string, string> }));
vi.mock("../terminalScrollback", () => ({
  getAgentScrollback: (id: string) => screens[id] ?? null,
}));
vi.mock("../aiGate", () => ({ useAiFeature: () => true }));
const { pushSuggestions } = vi.hoisted(() => ({ pushSuggestions: vi.fn() }));
vi.mock("../relayClient", () => ({ pushSuggestions }));
// Both agents are in a your-turn status, and neither has a stage that yields a CTA (no
// branchStatus, no workflowStage → building_unsaved → deriveCta returns null), so `buttons` below
// is the raw computed set. The CTA's own wiring is covered by useSuggestions.cta.test.tsx.
vi.mock("../../stores/runtimeStore", () => ({
  useRuntimeStore: Object.assign(
    (
      sel: (s: {
        status: Record<string, string>;
        workflowShipped: Record<string, boolean>;
        workflowStage: Record<string, string>;
        workflowState: Record<string, unknown>;
        branchStatus: Record<string, unknown>;
      }) => unknown,
    ) =>
      sel({
        status: { A: "idle", B: "idle" },
        workflowShipped: {},
        workflowStage: {},
        workflowState: {},
        branchStatus: {},
      }),
    {
      // `isLive()` reads the store imperatively before either auto-answer fires.
      getState: () => ({ status: { A: "idle", B: "idle" } }),
    },
  ),
}));

import { useSuggestions, resetSuggestionMemory } from "./useSuggestions";
import { useConnectionStore } from "../../stores/connectionStore";
import type { SuggestionButton } from "./types";

const btn = (id: string, label: string, value: string): SuggestionButton => ({
  id,
  label,
  value,
  kind: "prompt",
  source: "control",
});
/** A's action. Its VALUE is the thing that must never reach B's terminal. */
const A_ACTION = btn("a-land", "Land to Main", "Land agent A's work to main.");
const B_ACTION = btn("b-tests", "Fix the tests", "Fix agent B's failing tests.");

/** Every COMMIT this component makes, as (agentId, button ids). Recorded in a LAYOUT effect, which
 *  is the load-bearing detail: it fires once per committed render, before paint, and before any
 *  passive effect the hook itself schedules. So a reset done in a `useEffect` shows up here as a
 *  committed (B, A's ids) pair — the frame a click lands in — while a reset done during RENDER
 *  never produces one. Recording in the render body instead would prove nothing: React runs a
 *  component that sets its own state during render TWICE and DISCARDS the first pass, so the stale
 *  pass would be logged despite never reaching the screen.
 *
 *  This is the difference between asserting the wiring and asserting the settled value. The settled
 *  value is identical under both fixes; only one of them is actually safe. */
let commits: { agentId: string; ids: string[]; values: string[] }[] = [];
function Probe({ agentId }: { agentId: string }) {
  const { buttons } = useSuggestions(agentId, true);
  useLayoutEffect(() => {
    commits.push({
      agentId,
      ids: buttons.map((b) => b.id),
      values: buttons.map((b) => b.value),
    });
  });
  return null;
}

/** What the latest COMMITTED render shows. */
const latest = () => commits[commits.length - 1]!;
/** Every commit made while pointed at `agentId`. */
const rendersFor = (agentId: string) => commits.filter((r) => r.agentId === agentId);

beforeEach(() => {
  commits = [];
  computeSuggestions.mockReset();
  pushSuggestions.mockReset();
  // The memo and the answered-picker set are MODULE-scoped per agent, so they outlive a test.
  resetSuggestionMemory();
  screens.A = "Agent A finished. Committed abc.";
  screens.B = "Agent B finished. Committed def.";
  useConnectionStore.setState({ browserOnline: true, probeOk: true, isOnline: true });
});

describe("useSuggestions — one instance re-pointed at another agent", () => {
  /** Compute A's set, then re-point the same instance at B. Returns the rerender handle. */
  async function aimAtAThenB(bResult: { buttons: SuggestionButton[] } | null = null) {
    computeSuggestions.mockResolvedValue({ buttons: [A_ACTION] });
    const { rerender } = render(<Probe agentId="A" />);
    await waitFor(() => expect(latest().ids).toEqual(["a-land"]));
    computeSuggestions.mockReset();
    if (bResult) computeSuggestions.mockResolvedValue(bResult);
    else computeSuggestions.mockReturnValue(new Promise(() => {})); // B's compute never settles
    rerender(<Probe agentId="B" />);
    return { rerender };
  }

  // THE finding. Not "the buttons eventually become B's" — that a late reset also satisfies — but
  // that NO render pointed at B ever carried A's set. A pill only has to be on screen for one frame
  // for a click to route A's prompt into B's terminal, so the frame IS the bug.
  it("never paints A's buttons under B, not even for one frame", async () => {
    await aimAtAThenB();
    expect(latest().agentId).toBe("B");
    expect(latest().ids).toEqual([]);
    for (const r of rendersFor("B")) {
      expect(r.ids).not.toContain("a-land");
    }
  });

  // The consequence that must not ship, stated as the dispatch itself: `value` is what a click
  // sends, and A's prose must never be reachable from a box aimed at B.
  it("makes A's prompt text unreachable while aimed at B", async () => {
    await aimAtAThenB();
    for (const r of rendersFor("B")) {
      expect(r.values).not.toContain("Land agent A's work to main.");
    }
  });

  it("shows B's OWN buttons once B's compute lands", async () => {
    await aimAtAThenB({ buttons: [B_ACTION] });
    await waitFor(() => expect(latest().ids).toEqual(["b-tests"]));
    expect(latest().agentId).toBe("B");
  });

  // `memo` is keyed by scrollback hash WITHIN an agent. Two agents showing the same screen — two
  // workers on the same repo settling on the same "Done." tail is ordinary — must not let B be
  // served A's cached buttons with no compute at all.
  it("does not serve A's memoized set to B off a matching screen hash", async () => {
    screens.B = screens.A!; // same tail → same hash
    await aimAtAThenB({ buttons: [B_ACTION] });
    // A memo hit would have skipped the compute entirely and shown A's set.
    await waitFor(() => expect(computeSuggestions).toHaveBeenCalled());
    expect(computeSuggestions.mock.calls[0]![0]).toMatchObject({ agentId: "B" });
    await waitFor(() => expect(latest().ids).toEqual(["b-tests"]));
  });

  // The retry budget is spent PER FAILING STATE and read relative to its hash. Carried across a
  // re-aim onto an identical screen, A's exhausted budget refuses B a compute it never had a turn
  // at — B simply never gets suggestions.
  it("does not spend A's exhausted retry budget on B", async () => {
    screens.B = screens.A!;
    computeSuggestions.mockRejectedValue(new Error("ai request failed (HTTP 400)")); // terminal
    const { rerender } = render(<Probe agentId="A" />);
    await waitFor(() => expect(computeSuggestions).toHaveBeenCalledTimes(1));
    computeSuggestions.mockReset();
    computeSuggestions.mockResolvedValue({ buttons: [B_ACTION] });
    rerender(<Probe agentId="B" />);
    await waitFor(() => expect(latest().ids).toEqual(["b-tests"]));
  });

  // A's phone copy is a live tap target. Re-aiming the desktop away from A leaves the desktop
  // showing nothing for A, so the phone must be cleared too — otherwise a tap fires an action for
  // an agent no surface is offering it for.
  it("retires A's phone copy when the box stops pointing at A", async () => {
    await aimAtAThenB();
    await waitFor(() =>
      expect(pushSuggestions).toHaveBeenCalledWith({ agent_id: "A", buttons: [] }),
    );
  });

  // Unmount is the other way an instance stops owning an agent, and it goes through the same
  // cleanup — so a regression that guarded the reset on "agentId changed" alone would leave a
  // closed pane's buttons armed on the phone.
  it("retires the phone copy on unmount too", async () => {
    computeSuggestions.mockResolvedValue({ buttons: [A_ACTION] });
    const { unmount } = render(<Probe agentId="A" />);
    await waitFor(() => expect(latest().ids).toEqual(["a-land"]));
    pushSuggestions.mockReset();
    unmount();
    expect(pushSuggestions).toHaveBeenCalledWith({ agent_id: "A", buttons: [] });
  });

  // Aiming back at SPARKLE (agentId "") is a re-point like any other: the hook goes inert, and it
  // must not keep the last agent's set up while it does. This is the DEFAULT concierge mode — the
  // box is cross-project and aimed at no agent — so the inert case is the common one, not a corner.
  it("drops the set when the box goes back to Sparkle", async () => {
    computeSuggestions.mockResolvedValue({ buttons: [A_ACTION] });
    const { rerender } = render(<Probe agentId="A" />);
    await waitFor(() => expect(latest().ids).toEqual(["a-land"]));
    rerender(<Probe agentId="" />);
    expect(latest().ids).toEqual([]);
    for (const r of rendersFor("")) expect(r.ids).toEqual([]);
  });

  // Scoped to agentId "" the hook must cost NOTHING: no scrollback, no status, and above all no
  // metered compute. That is what lets ConciergeHost keep it mounted in default Sparkle mode.
  it("buys no compute at all while aimed at Sparkle", async () => {
    computeSuggestions.mockResolvedValue({ buttons: [A_ACTION] });
    render(<Probe agentId="" />);
    await Promise.resolve();
    expect(computeSuggestions).not.toHaveBeenCalled();
  });
});
