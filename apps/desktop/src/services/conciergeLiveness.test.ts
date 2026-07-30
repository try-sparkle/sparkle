// @vitest-environment jsdom
//
// The store and its ONE timer. The decisions all live in engine/conciergeLiveness and are tested
// there; what is left here is the wiring that engine cannot see — whether an interval is scheduled
// at all, and whether the sticky state is actually latched rather than merely derived.
//
// THE TIMER GATE MATTERS. This is the only recurring timer the feature adds, in an app that keeps a
// concierge column mounted for the whole session. Ungated it would tick twice a second forever, for
// nothing.
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ELAPSED_CEILING_MS,
  ELAPSED_COUNTER_AFTER_MS,
  OFFLINE_AFTER_MS,
  UNAVAILABLE_AFTER_MS,
} from "../engine/conciergeLiveness";
import {
  _resetConciergeLivenessForTests,
  conciergeSawAnswerText,
  noteConciergeFailed,
  noteConciergeProgress,
  noteConciergeSent,
  noteConciergeSettled,
  useConciergeLiveness,
  useConciergeLivenessStore,
} from "./conciergeLiveness";

beforeEach(() => {
  vi.useFakeTimers();
  _resetConciergeLivenessForTests();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** How many repeating timers are live right now. `vi.getTimerCount()` counts the pending ones, and
 *  a `setInterval` always has exactly one pending. */
const timers = () => vi.getTimerCount();

describe("the ticker is scheduled only when it has something to do", () => {
  it("runs no timer while the concierge is idle", () => {
    renderHook(() => useConciergeLiveness());
    expect(timers()).toBe(0);
  });

  it("starts one when a turn goes out, and stops it when the turn lands", () => {
    const { rerender } = renderHook(() => useConciergeLiveness());
    act(() => noteConciergeSent());
    rerender();
    expect(timers()).toBe(1);

    act(() => noteConciergeSettled());
    rerender();
    expect(timers()).toBe(0);
  });

  it("stops it on a hard failure too — the wait is over, we know why", () => {
    const { rerender } = renderHook(() => useConciergeLiveness());
    act(() => noteConciergeSent());
    rerender();
    act(() => noteConciergeFailed("boom"));
    rerender();
    expect(timers()).toBe(0);
  });

  // IT KEEPS TICKING PAST THE LATCH, and that is deliberate (roborev 55442-M3). Gating on the latch
  // looked free — there is no further escalation to reach — but the elapsed counter is still on
  // screen and is computed from the tick's `now`. Stopping FROZE it: a dead turn read
  // "No answer yet · 1m 30s" for as long as it stayed dead. The one number this feature guarantees
  // cannot be wrong must not be the one it stops updating.
  it("keeps ticking once the sticky state is reached, so the counter cannot freeze", () => {
    const { result, rerender } = renderHook(() => useConciergeLiveness());
    act(() => noteConciergeSent());
    rerender();
    act(() => {
      vi.advanceTimersByTime(UNAVAILABLE_AFTER_MS);
    });
    rerender();
    expect(useConciergeLivenessStore.getState().unavailableLatched).toBe(true);
    const atLatch = result.current.silentMs;

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    rerender();
    expect(result.current.silentMs).toBe((atLatch ?? 0) + 60_000);
  });

  // The second half of the same finding. `reduceSent` moves `silentSince` forward; against a FROZEN
  // `now`, `max(now, silentSince)` then computed zero and the counter vanished entirely — stopped
  // AND wrong — until a delta unlatched it.
  it("a re-send into a latched outage still counts up", () => {
    const { result, rerender } = renderHook(() => useConciergeLiveness());
    act(() => noteConciergeSent());
    rerender();
    act(() => {
      vi.advanceTimersByTime(UNAVAILABLE_AFTER_MS);
    });
    rerender();

    act(() => noteConciergeSent());
    act(() => {
      vi.advanceTimersByTime(ELAPSED_COUNTER_AFTER_MS + 1_000);
    });
    rerender();
    expect(result.current.liveness).toBe("unavailable");
    expect(result.current.showsElapsed).toBe(true);
    expect(result.current.silentMs).toBe(ELAPSED_COUNTER_AFTER_MS + 1_000);
  });

  // THE BOUND ON "KEEPS TICKING" (roborev 55468-M3). The two cases above are the reason the ticker
  // survives the latch; this is the reason that is not the same as running forever. A turn that dies
  // silently never gets a delta, a tool call, a done or an error — so `silentSince` stays set, and
  // with the latch gate removed and nothing in its place the interval re-rendered twice a second for
  // the rest of the session, animating a number for a human who gave up and closed the laptop.
  //
  // Asserted as a TIMER COUNT, because that is the cost being bounded — a reading about the
  // component's derived state would go green against a version that still had the interval running.
  it("stops for good once the counter is no longer on screen", () => {
    const { result, rerender } = renderHook(() => useConciergeLiveness());
    act(() => noteConciergeSent());
    rerender();
    expect(timers()).toBe(1);

    // Just under: still counting, still ticking. Pinned so the ceiling cannot be quietly lowered to
    // something that swallows a wait a human is actually watching.
    act(() => {
      vi.advanceTimersByTime(ELAPSED_CEILING_MS - 2_000);
    });
    rerender();
    expect(result.current.showsElapsed).toBe(true);
    expect(timers()).toBe(1);

    act(() => {
      vi.advanceTimersByTime(4_000);
    });
    rerender();
    expect(timers()).toBe(0);
    // REMOVED, not frozen — the clock and the number it feeds stop together, so there is no stale
    // reading left on screen. That pairing is the whole reason stopping is allowed here at all.
    expect(result.current.showsElapsed).toBe(false);
    // And the verdict is untouched: it lives in latched state, not in the clock.
    expect(result.current.liveness).toBe("unavailable");
  });

  it("comes back when the user sends again after giving up", () => {
    const { result, rerender } = renderHook(() => useConciergeLiveness());
    act(() => noteConciergeSent());
    rerender();
    act(() => {
      vi.advanceTimersByTime(ELAPSED_CEILING_MS + 1_000);
    });
    rerender();
    expect(timers()).toBe(0);

    act(() => noteConciergeSent());
    rerender();
    expect(timers()).toBe(1);
    act(() => {
      vi.advanceTimersByTime(ELAPSED_COUNTER_AFTER_MS + 1_000);
    });
    rerender();
    expect(result.current.showsElapsed).toBe(true);
    expect(result.current.silentMs).toBe(ELAPSED_COUNTER_AFTER_MS + 1_000);
  });

  it("unmounting clears it", () => {
    const { unmount } = renderHook(() => useConciergeLiveness());
    act(() => noteConciergeSent());
    unmount();
    expect(timers()).toBe(0);
  });
});

describe("what the hook reports", () => {
  it("does not judge a brand-new turn against a clock read before it started", () => {
    // The hook seeds `now` at mount. A turn that starts BETWEEN two ticks would otherwise be
    // measured from that stale reading and appear seconds old on its very first frame.
    const { result, rerender } = renderHook(() => useConciergeLiveness());
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    act(() => noteConciergeSent());
    rerender();
    expect(result.current.liveness).toBe("waiting");
    expect(result.current.silentMs).toBe(0);
  });

  it("walks waiting → offline → unavailable as the silence grows", () => {
    const { result, rerender } = renderHook(() => useConciergeLiveness());
    act(() => noteConciergeSent());
    rerender();
    expect(result.current.liveness).toBe("waiting");

    act(() => {
      vi.advanceTimersByTime(OFFLINE_AFTER_MS);
    });
    rerender();
    expect(result.current.liveness).toBe("offline");

    act(() => {
      vi.advanceTimersByTime(UNAVAILABLE_AFTER_MS - OFFLINE_AFTER_MS);
    });
    rerender();
    expect(result.current.liveness).toBe("unavailable");
  });

  it("hands the verbatim failure detail through to whatever renders it", () => {
    const { result, rerender } = renderHook(() => useConciergeLiveness());
    act(() => noteConciergeFailed("You've hit your session limit · resets 8:40am (America/Bogota)"));
    rerender();
    expect(result.current.failure?.evidence).toBe(
      "You've hit your session limit · resets 8:40am (America/Bogota)",
    );
  });
});

describe("conciergeSawAnswerText", () => {
  // Read by the host INSIDE a send callback to decide whether the message it is displacing was ever
  // answered. A synchronous getter, not a subscription: a hook would hand it the value from the last
  // commit, and the delta it needs to see may have arrived since.
  it("reports whether the outstanding turn has produced anything", () => {
    noteConciergeSent();
    expect(conciergeSawAnswerText()).toBe(false);
    noteConciergeProgress("text");
    expect(conciergeSawAnswerText()).toBe(true);
  });

  it("resets for each new turn", () => {
    noteConciergeSent();
    noteConciergeProgress("text");
    noteConciergeSent();
    expect(conciergeSawAnswerText()).toBe(false);
  });
});
