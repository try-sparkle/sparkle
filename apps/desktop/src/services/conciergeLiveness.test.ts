// @vitest-environment jsdom
//
// The store and its ONE timer. The decisions all live in engine/conciergeLiveness and are tested
// there; what is left here is the wiring that engine cannot see — whether an interval is scheduled
// at all, and whether the sticky state is actually latched rather than merely derived.
//
// THE TIMER GATE MATTERS. This is the only recurring timer the feature adds, in an app that keeps a
// concierge column mounted for the whole session. Ungated it would tick every second forever, for
// nothing.
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  FAILURE_OUTAGE_RUN,
  SLOW_AFTER_MS,
  STALLED_AFTER_MS,
  STALLED_SILENT_RUN,
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

  // IT STOPS AT RED, and that is what removing the seconds counter bought (roborev 55442-M3 /
  // 55468-M3, both now moot). Those findings existed because the counter was computed from the
  // tick's `now`, so stopping FROZE a number on screen and a ten-minute ceiling had to be invented
  // to stop it eventually. Nothing on screen is derived from `now` any more — red is a latched fact
  // — so the interval can simply end, and a turn that dies while the human closes the laptop
  // schedules nothing for the rest of the session.
  //
  // Asserted as a TIMER COUNT, because that is the cost being bounded: a reading of the hook's
  // derived state would go green against a version that still had the interval running.
  it("stops for good at red, with no ceiling needed", () => {
    const { result, rerender } = renderHook(() => useConciergeLiveness());
    act(() => noteConciergeSent());
    rerender();
    expect(timers()).toBe(1);

    // Just under: yellow, still moving, still ticking.
    act(() => {
      vi.advanceTimersByTime(STALLED_AFTER_MS - 1_000);
    });
    rerender();
    expect(result.current.liveness).toBe("slow");
    expect(timers()).toBe(1);

    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    rerender();
    expect(timers()).toBe(0);
    // And the verdict is not lost with the clock: it lives in latched state.
    expect(result.current.liveness).toBe("stalled");
    expect(useConciergeLivenessStore.getState().stalledLatched).toBe(true);
  });

  // A re-send into a latched red must NOT restart the interval: the row is already red and stays red
  // until something is actually observed, so there is still nothing for a clock to change. This is
  // the case the old version had to keep ticking for (the counter had to keep counting through it).
  it("a re-send into a latched red schedules nothing", () => {
    const { result, rerender } = renderHook(() => useConciergeLiveness());
    act(() => noteConciergeSent());
    rerender();
    act(() => {
      vi.advanceTimersByTime(STALLED_AFTER_MS);
    });
    rerender();
    expect(timers()).toBe(0);

    act(() => noteConciergeSent());
    rerender();
    expect(result.current.liveness).toBe("stalled");
    expect(timers()).toBe(0);
  });

  it("comes back once something clears the latch and a new turn goes out", () => {
    const { result, rerender } = renderHook(() => useConciergeLiveness());
    act(() => noteConciergeSent());
    rerender();
    act(() => {
      vi.advanceTimersByTime(STALLED_AFTER_MS);
    });
    rerender();
    expect(timers()).toBe(0);

    act(() => noteConciergeProgress("text"));
    act(() => noteConciergeSent());
    rerender();
    expect(result.current.liveness).toBe("waiting");
    expect(timers()).toBe(1);
  });

  it("unmounting clears it", () => {
    const { unmount } = renderHook(() => useConciergeLiveness());
    act(() => noteConciergeSent());
    unmount();
    expect(timers()).toBe(0);
  });
});

// ── THE LATCH DOES NOT DEPEND ON A CONSUMER BEING MOUNTED AT THE RIGHT MOMENT ──────────────────
//
// roborev 56112-M2. `reduceTick` is the only writer of `stalledLatched`, and it used to run only
// from the interval — so a crossing that happened while nothing was mounted (ConciergeColumn swaps
// the whole thread out when `aiLock` flips) left the row red from the clock with the latch unset,
// and the next send quietly returned it to gray.
describe("red latches on what is READ, not only on what is ticked", () => {
  it("latches when the crossing happened while nothing was subscribed", () => {
    // No hook mounted for the whole silence — exactly the aiLock window.
    act(() => noteConciergeSent());
    act(() => {
      vi.advanceTimersByTime(STALLED_AFTER_MS + 5_000);
    });
    expect(useConciergeLivenessStore.getState().stalledLatched).toBe(false);

    const { result, rerender } = renderHook(() => useConciergeLiveness());
    rerender();
    expect(result.current.liveness).toBe("stalled");
    expect(useConciergeLivenessStore.getState().stalledLatched).toBe(true);

    // THE CONSEQUENCE, which is the part that was actually broken: without the latch this send
    // moves `silentSince` forward and the row drops back to gray over a brain nothing proved is
    // back.
    act(() => noteConciergeSent());
    rerender();
    expect(result.current.liveness).toBe("stalled");
  });

  // …BUT ONLY THE CLOCK LATCHES (roborev 56122-M1). `livenessAt` also reads stalled for a RUN of
  // unanswered sends, and latching that would make the run sticky in a way nothing can undo:
  // `reduceFailed` clears `silentRun` deliberately — an error is a response, the turn WAS answered —
  // but it does not touch the latch. So the user gets told their quota is gone in a verbatim bubble,
  // and then their next brand-new question paints red on its first frame over no silence evidence at
  // all.
  it("does not latch a run-derived red, so a hard failure still returns the next send to gray", () => {
    const { result, rerender } = renderHook(() => useConciergeLiveness());
    for (let i = 0; i <= STALLED_SILENT_RUN; i += 1) {
      act(() => noteConciergeSent());
      act(() => {
        vi.advanceTimersByTime(SLOW_AFTER_MS + 1_000);
      });
      rerender();
    }
    // Red, and correctly so — but from the run, not from the clock.
    expect(result.current.liveness).toBe("stalled");
    expect(useConciergeLivenessStore.getState().silentRun).toBeGreaterThanOrEqual(
      STALLED_SILENT_RUN,
    );
    expect(useConciergeLivenessStore.getState().stalledLatched).toBe(false);

    // The turn comes back with a loud error, which resets the run. The next question is new.
    act(() => noteConciergeFailed("You've hit your session limit"));
    act(() => noteConciergeSent());
    rerender();
    expect(result.current.liveness).toBe("waiting");
  });
});

describe("what the hook reports", () => {
  it("walks gray → yellow → red as the silence grows", () => {
    const { result, rerender } = renderHook(() => useConciergeLiveness());
    act(() => noteConciergeSent());
    rerender();
    expect(result.current.liveness).toBe("waiting");

    act(() => {
      vi.advanceTimersByTime(SLOW_AFTER_MS);
    });
    rerender();
    expect(result.current.liveness).toBe("slow");

    act(() => {
      vi.advanceTimersByTime(STALLED_AFTER_MS - SLOW_AFTER_MS);
    });
    rerender();
    expect(result.current.liveness).toBe("stalled");
  });

  // THE SCOPE OF THE RETUNE, at the boundary between the two halves. Silence lost its words; an
  // error the app RECEIVED did not.
  it("hands a RUN of verbatim failure details through to whatever renders it", () => {
    const detail = "You've hit your session limit · resets 8:40am (America/Bogota)";
    const { result, rerender } = renderHook(() => useConciergeLiveness());

    act(() => noteConciergeFailed(detail));
    rerender();
    expect(result.current.outage).toBeNull();

    for (let i = 1; i < FAILURE_OUTAGE_RUN; i += 1) act(() => noteConciergeFailed(detail));
    rerender();
    expect(result.current.outage?.evidence).toBe(detail);
  });

  it("never reports an outage from silence, however long it lasts", () => {
    const { result, rerender } = renderHook(() => useConciergeLiveness());
    act(() => noteConciergeSent());
    rerender();
    act(() => {
      vi.advanceTimersByTime(STALLED_AFTER_MS * 10);
    });
    rerender();
    expect(result.current.liveness).toBe("stalled");
    expect(result.current.outage).toBeNull();
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
