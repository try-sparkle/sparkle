// @vitest-environment jsdom
//
// THE DELIVERY MECHANISM ITSELF, not just its parts (roborev 64236/64238's "no test at all" — the
// service-level suites cover the queue and a MANUALLY-called flush, but nothing pinned that the
// poll actually widens beyond the mounted agent, actually skips a blocked screen, or actually
// sweeps an expired hold rather than leaving it to rot. Deleting the hook body entirely used to
// leave every other suite in this feature green.
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  agentIds: [] as string[],
  agentIdsArgs: [] as unknown[][],
  blocked: new Set<string>(),
  /** Agents whose terminal is not mounted in THIS window — `getAgentViewport` returns null. */
  hidden: new Set<string>(),
  flush: vi.fn(async (_agentId: string) => []),
  sweep: vi.fn((_agentId: string) => {}),
  defer: vi.fn((_agentId: string) => {}),
}));

vi.mock("../services/conciergeDispatch", () => ({
  flushScreenHeldSends: h.flush,
  sweepExpiredScreenHeldSends: h.sweep,
  deferScreenHoldsWhileHidden: h.defer,
}));
vi.mock("../services/screenHoldQueue", () => ({
  agentIdsWithScreenHolds: (...args: unknown[]) => {
    h.agentIdsArgs.push(args);
    return h.agentIds;
  },
}));
// One viewport per agent id, opaque to everything but the mocked predicate below — this hook
// never inspects viewport shape itself, only what terminalWriteRefusal says about it. NULL for a
// hidden agent, which is the real registry's own answer for a terminal that isn't mounted here.
vi.mock("../services/terminalViewport", () => ({
  getAgentViewport: (id: string) => (h.hidden.has(id) ? null : { id }),
}));
// Mirrors the real predicate's first two lines: a null viewport is `no-viewport`, an alternate
// buffer is `alternate-screen`. Collapsing the two — which is what the hook itself used to do —
// is the defect these rows exist to pin.
vi.mock("../voice/dictationTerminalRoute", () => ({
  terminalWriteRefusal: (v: { id: string } | null) =>
    v === null ? "no-viewport" : h.blocked.has(v.id) ? "alternate-screen" : null,
}));

import { SCREEN_HOLD_POLL_MS, useScreenHoldDrain } from "./useScreenHoldDrain";

beforeEach(() => {
  vi.useFakeTimers();
  h.agentIds = [];
  h.agentIdsArgs = [];
  h.blocked.clear();
  h.hidden.clear();
  h.flush.mockClear();
  h.sweep.mockClear();
  h.defer.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("useScreenHoldDrain", () => {
  it("flushes an agent whose screen is clear, and leaves a blocked one to the sweep instead", () => {
    h.agentIds = ["clear", "blocked"];
    h.blocked.add("blocked");
    renderHook(() => useScreenHoldDrain());
    act(() => {
      vi.advanceTimersByTime(SCREEN_HOLD_POLL_MS);
    });
    // The clear agent is DELIVERED — never merely swept.
    expect(h.flush).toHaveBeenCalledWith("clear");
    expect(h.sweep).not.toHaveBeenCalledWith("clear");
    // The blocked agent is NEVER written to — only its expired entries (if any) get reported.
    expect(h.flush).not.toHaveBeenCalledWith("blocked");
    expect(h.sweep).toHaveBeenCalledWith("blocked");
    // …and a screen that is right here and busy is NOT the hidden case: its clock keeps running.
    expect(h.defer).not.toHaveBeenCalled();
  });

  // ══ "I CANNOT SEE THIS SCREEN" IS NOT "THIS SCREEN IS BUSY" (bead sparkle-9gsjqm) ══════════════
  // THE FOUNDER'S CASE: he types into a busy mounted pane, is promised a delivery, then unmounts or
  // switches the cable. `getAgentViewport` then returns null for that agent and the refusal is
  // `no-viewport`. The branch used to test `!== null`, so a hidden pane fell in with `vim` and a
  // credential prompt: never flushed, only ever swept, and dropped at the fifteen-minute mark. The
  // header directly above this hook says a hold "does not become void because he looked away".
  it("stops a hidden agent's hold clock instead of sweeping it toward expiry", () => {
    h.agentIds = ["hidden"];
    h.hidden.add("hidden");
    renderHook(() => useScreenHoldDrain());
    act(() => {
      vi.advanceTimersByTime(SCREEN_HOLD_POLL_MS);
    });
    expect(h.defer).toHaveBeenCalledWith("hidden");
    // NEITHER of the other two things: not swept (that is what ages it out), and certainly not
    // flushed — this branch must never write into a PTY whose screen it cannot read.
    expect(h.sweep).not.toHaveBeenCalled();
    expect(h.flush).not.toHaveBeenCalled();
  });

  // THE OTHER HALF OF THE PROMISE: it is not enough to keep the words: they have to arrive. Once a
  // viewport comes back and reads clear, the very next tick delivers.
  it("delivers once the agent's viewport comes back and reads clear", () => {
    h.agentIds = ["hidden"];
    h.hidden.add("hidden");
    renderHook(() => useScreenHoldDrain());
    act(() => {
      vi.advanceTimersByTime(SCREEN_HOLD_POLL_MS);
    });
    expect(h.flush).not.toHaveBeenCalled();

    // He re-mounts the pane, and this time the screen is a clean prompt.
    h.hidden.clear();
    act(() => {
      vi.advanceTimersByTime(SCREEN_HOLD_POLL_MS);
    });
    expect(h.flush).toHaveBeenCalledWith("hidden");
  });

  // A pane that comes back STILL BUSY is not a delivery — the two facts are independent, and the
  // hidden branch must not have bought the write an exemption from the screen guard.
  it("does not deliver when the viewport returns but the screen is still blocked", () => {
    h.agentIds = ["hidden"];
    h.hidden.add("hidden");
    renderHook(() => useScreenHoldDrain());
    act(() => {
      vi.advanceTimersByTime(SCREEN_HOLD_POLL_MS);
    });

    h.hidden.clear();
    h.blocked.add("hidden");
    act(() => {
      vi.advanceTimersByTime(SCREEN_HOLD_POLL_MS);
    });
    expect(h.flush).not.toHaveBeenCalled();
    expect(h.sweep).toHaveBeenCalledWith("hidden");
  });

  // roborev 64238's High: enumerating only LIVE holds drops an agent whose entries have all
  // expired but never been swept, so nothing ever visits it again. The poll must ask for expired
  // agents too, every tick, so a hold stuck behind a permanently blocked screen is still reported.
  it("asks for agents with expired holds too, not just live ones", () => {
    renderHook(() => useScreenHoldDrain());
    act(() => {
      vi.advanceTimersByTime(SCREEN_HOLD_POLL_MS);
    });
    expect(h.agentIdsArgs[0]?.[1]).toEqual({ includeExpired: true });
  });

  it("keeps polling on every subsequent tick, not just the first", () => {
    h.agentIds = ["clear"];
    renderHook(() => useScreenHoldDrain());
    act(() => {
      vi.advanceTimersByTime(SCREEN_HOLD_POLL_MS * 3);
    });
    expect(h.flush).toHaveBeenCalledTimes(3);
  });

  it("stops polling once unmounted", () => {
    h.agentIds = ["clear"];
    const { unmount } = renderHook(() => useScreenHoldDrain());
    unmount();
    act(() => {
      vi.advanceTimersByTime(SCREEN_HOLD_POLL_MS * 3);
    });
    expect(h.flush).not.toHaveBeenCalled();
  });

  it("does nothing when no agent has anything held", () => {
    h.agentIds = [];
    renderHook(() => useScreenHoldDrain());
    act(() => {
      vi.advanceTimersByTime(SCREEN_HOLD_POLL_MS * 2);
    });
    expect(h.flush).not.toHaveBeenCalled();
    expect(h.sweep).not.toHaveBeenCalled();
  });
});
