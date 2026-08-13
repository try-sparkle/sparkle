// paneFocusStore — a tiny cross-component channel for "put the caret in THIS agent's terminal."
//
// Modelled on `scrollIntentStore`, which solves the identical shape (the sidebar knows which agent
// the user asked for; only the pane holds a handle to that agent's terminal) and for the same
// reason: the two components are on opposite sides of the shell and neither may reach into the
// other's refs.
//
// ══ WHY THIS EXISTS AT ALL ══════════════════════════════════════════════════════════════════════
// Founder, 2026-08-12, naming what a single click on a build row should do now that it no longer
// mounts the concierge: *select the row AND move keyboard focus to that agent's terminal pane.*
//
// `AgentPane` already parks the caret in its terminal on `visible && ptyReady`, and that is NOT
// enough on its own — it fires on a TRANSITION, so clicking a row whose pane is already up (the
// common case: re-clicking the agent you are working in, or clicking back after the row itself took
// focus from the press) moves nothing. A request the pane consumes fires every time the user asks.
//
// ══ A TICK, NOT A BOOLEAN ══════════════════════════════════════════════════════════════════════
// The value is a monotonically increasing counter rather than a flag, so two clicks in a row are two
// requests. A boolean already set to `true` cannot express the second one, and this is exactly the
// gesture a user repeats when the first attempt did not seem to land.
//
// In-memory, not persisted, and deliberately not agent-scoped beyond the id: "where the caret should
// be" is a statement about the press that just happened and means nothing across a relaunch.
import { create } from "zustand";

interface PaneFocusState {
  /** The last tick handed out. MONOTONIC ACROSS CONSUMES, and across agents — deriving the next
   *  value from the agent's own previous one would restart at 1 after every consume, so a request,
   *  a consume and a second request would produce the same number twice. Anything comparing ticks
   *  (a React dependency list, most of all) would read the second ask as "no change" and drop it. */
  tick: number;
  /** agentId -> a request tick. Absent means "no pending request for this agent". */
  requests: Record<string, number>;
  /** Ask for this agent's terminal to take the caret (supersedes any pending request for it). */
  request: (agentId: string) => void;
  /** Take + clear the pending request for an agent (null if none). */
  consume: (agentId: string) => number | null;
}

/**
 * Apply a pending focus request: when this pane is the visible, ready terminal AND a request is
 * pending, hand it the caret and clear the request so it cannot re-fire.
 *
 * Pure given its deps — the same seam `applyScrollIntent` uses next door, and for the same reason:
 * the gate-plus-consume contract is the part that goes wrong, and it must be assertable without
 * rendering the (very heavy) AgentPane. `AgentPane.focusRequest.test.tsx` covers the wiring itself.
 *
 * NOT GATED ON "is the caret already there". `focus()` on an already-focused element is a no-op that
 * dispatches nothing, so the cheap-looking guard would buy nothing and could only be wrong.
 *
 * ══ `typing` DECLINES THE ASK, AND THE DECLINE MUST STILL CONSUME ═══════════════════════════════
 * Never out from under a HALF-TYPED message — the rule AgentPane's own auto-focus already follows,
 * and the concierge is the app's one compose surface, so yanking the caret mid-sentence is worse
 * than not honouring a click. But a decline that merely returns early leaves the request PENDING,
 * and a pending request fires on the next change to any of its inputs — so the caret would jump into
 * a terminal at an arbitrary later moment, with no gesture behind it. That delayed jump is a worse
 * bug than the one the guard prevents. So this is a DECISION, not a deferral: the ask is spent.
 *
 * Returns what happened, so a test reads an outcome rather than inferring one from a spy count.
 */
export function applyPaneFocus(opts: {
  request: number | undefined;
  visible: boolean;
  ready: boolean;
  typing?: boolean;
  focusTerminal: () => void;
  consume: () => void;
}): "focused" | "declined" | "skipped" {
  const { request, visible, ready, typing = false, focusTerminal, consume } = opts;
  if (request === undefined || !visible || !ready) return "skipped";
  if (typing) {
    consume();
    return "declined";
  }
  focusTerminal();
  consume();
  return "focused";
}

export const usePaneFocusStore = create<PaneFocusState>((set, get) => ({
  tick: 0,
  requests: {},
  request: (agentId) =>
    set((s) => ({ tick: s.tick + 1, requests: { ...s.requests, [agentId]: s.tick + 1 } })),
  consume: (agentId) => {
    const tick = get().requests[agentId];
    if (tick === undefined) return null;
    set((s) => {
      const { [agentId]: _removed, ...rest } = s.requests;
      return { requests: rest };
    });
    return tick;
  },
}));

/** Reset to empty. Tests only — the store is a module singleton shared across cases. */
export function resetPaneFocus(): void {
  usePaneFocusStore.setState({ tick: 0, requests: {} });
}
