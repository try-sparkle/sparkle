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
  flush: vi.fn(async (_agentId: string) => []),
  sweep: vi.fn((_agentId: string) => {}),
}));

vi.mock("../services/conciergeDispatch", () => ({
  flushScreenHeldSends: h.flush,
  sweepExpiredScreenHeldSends: h.sweep,
}));
vi.mock("../services/screenHoldQueue", () => ({
  agentIdsWithScreenHolds: (...args: unknown[]) => {
    h.agentIdsArgs.push(args);
    return h.agentIds;
  },
}));
// One viewport per agent id, opaque to everything but the mocked predicate below — this hook
// never inspects viewport shape itself, only what terminalWriteRefusal says about it.
vi.mock("../services/terminalViewport", () => ({
  getAgentViewport: (id: string) => ({ id }),
}));
vi.mock("../voice/dictationTerminalRoute", () => ({
  terminalWriteRefusal: (v: { id: string } | null) =>
    v && h.blocked.has(v.id) ? "alternate-screen" : null,
}));

import { SCREEN_HOLD_POLL_MS, useScreenHoldDrain } from "./useScreenHoldDrain";

beforeEach(() => {
  vi.useFakeTimers();
  h.agentIds = [];
  h.agentIdsArgs = [];
  h.blocked.clear();
  h.flush.mockClear();
  h.sweep.mockClear();
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
