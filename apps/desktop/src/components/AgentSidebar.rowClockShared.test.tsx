// @vitest-environment jsdom
//
// SIXTY ROWS, ONE TIMER — counted.
//
// `useRowClock` used to create a `setInterval` per row. On the founder's 60-agent fleet that is 60
// scheduler entries and 60 `visibilitychange` listeners producing renders that ONE timer can
// produce. This file measures the timer count directly, because it is the thing that changed: the
// renders are the feature and are deliberately unchanged.
//
// ── THE REGRESSION THIS FILE EXISTS TO CATCH IS NOT "MANY TIMERS" ───────────────────────────────
// It is the obvious wrong fix. One shared 1s ticker that wakes every subscriber each second would
// report "1 interval" and pass a naive count while QUINTUPLING the re-renders of every relaxed row
// — strictly worse than the sixty timers it replaced. So the mixed-cadence row below is the load
// bearing one: with a fast row forcing the ticker to 1s, the relaxed rows must still render at
// their own 5s beat.
//
// `useRowClock` is exercised through mounted components rather than `renderHook` so the render
// counts are real component renders, and in an isolated harness rather than the whole sidebar so
// the timer count is attributable (the sidebar mounts unrelated polls).
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}));

import { useRowClock } from "./AgentSidebar";

const T0 = 1_700_000_000_000;
/** Under 100s since the interaction → the 1s cadence. */
const FAST_SINCE = T0 - 10_000;
/** Well past 100s → the 5s cadence. */
const SLOW_SINCE = T0 - 500_000;

let visibility: "visible" | "hidden" = "visible";
const setVisibility = (v: "visible" | "hidden") => {
  visibility = v;
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
};

/** Only the call log is read, and `setInterval`'s overloads make the full MockInstance type
 *  unassignable to anything writable — so the handles are narrowed to what is actually used. */
interface CallLog {
  mock: { calls: unknown[][] };
}
let setSpy: CallLog;
let clearSpy: CallLog;

/** Intervals created but not yet cleared — the resource this change is about. */
const liveIntervals = () => setSpy.mock.calls.length - clearSpy.mock.calls.length;
/** The delay the currently-running shared interval was started at. */
const tickerCadence = () => setSpy.mock.calls.at(-1)?.[1];

beforeEach(() => {
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  // Spied AFTER the fake timers are installed, so these wrap the fakes rather than the natives.
  setSpy = vi.spyOn(globalThis, "setInterval") as unknown as CallLog;
  clearSpy = vi.spyOn(globalThis, "clearInterval") as unknown as CallLog;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/**
 * Advance `seconds` of simulated time ONE SECOND AT A TIME, each in its own `act`.
 *
 * This matters for the render COUNTS and is not a stylistic choice. `advanceTimersByTime(30_000)`
 * runs all thirty timer callbacks inside a single `act`, and React batches the thirty `setNow`
 * calls into ONE render with the final value — so a correct implementation reports 1 render and an
 * implementation that woke every row every second also reports 1. Production runs each timer
 * callback as its own task, which is what stepping reproduces.
 */
const runSeconds = (seconds: number) => {
  for (let i = 0; i < seconds; i += 1) act(() => void vi.advanceTimersByTime(1000));
};

/** One "row": calls the hook exactly as `AgentRow` does and records every render it performs. */
function Probe({ since, onRender }: { since?: number; onRender: (now: number) => void }) {
  const now = useRowClock(since);
  onRender(now);
  return null;
}

/** Mount `spec.length` rows and return per-row render counts and last-seen clock values.
 *  `setSpec` re-renders with new `since` values — the shape a real terminal keystroke takes, since
 *  `since` is `interactionStore.lastAt` and the row subscribes to it. */
function mountRows(spec: Array<number | undefined>) {
  const renders = spec.map(() => 0);
  // ⚠️ COUNT CLOCK-DRIVEN RENDERS SEPARATELY, and assert on THESE (roborev 60587). `Probe` is not
  // memoized and `setSpec` re-renders the whole fragment, so a parent-driven render is
  // indistinguishable from a tick in the raw `renders` tally — a churn test that asserts on it is
  // satisfied by its own harness and passes against a completely frozen ticker. A render counts as
  // clock-driven only when the `now` the row was handed actually CHANGED, which is the one thing
  // only the ticker can cause. The mount render is excluded: there is no previous value to differ
  // from, so counting it would put a floor of 1 under every row for free.
  const clockRenders = spec.map(() => 0);
  const lastNow: Array<number | undefined> = spec.map(() => undefined);
  const element = (current: Array<number | undefined>) => (
    <>
      {current.map((since, i) => (
        <Probe
          key={i}
          since={since}
          onRender={(now) => {
            renders[i] = (renders[i] ?? 0) + 1;
            if (lastNow[i] !== undefined && lastNow[i] !== now) {
              clockRenders[i] = (clockRenders[i] ?? 0) + 1;
            }
            lastNow[i] = now;
          }}
        />
      ))}
    </>
  );
  const view = render(element(spec));
  const setSpec = (next: Array<number | undefined>) => {
    act(() => view.rerender(element(next)));
  };
  return { renders, clockRenders, lastNow, view, setSpec };
}

describe("the row clock is ONE shared ticker, not one timer per row", () => {
  it("runs a single interval with sixty rows mounted", () => {
    mountRows(Array.from({ length: 60 }, () => FAST_SINCE));
    console.log(`[rowClockShared] live intervals with 60 rows mounted: ${liveIntervals()}`);
    expect(liveIntervals()).toBe(1);
    // Cross-check against the scheduler itself: in this isolated harness the shared ticker is the
    // only pending timer there is. Counting the spy alone would miss a timer created some other way.
    expect(vi.getTimerCount()).toBe(1);
  });

  it("registers NO timer at all when no row has been interacted with", () => {
    mountRows(Array.from({ length: 60 }, () => undefined));
    expect(liveIntervals()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("tears the shared interval down when the last row unmounts", () => {
    const { view } = mountRows(Array.from({ length: 60 }, () => FAST_SINCE));
    expect(liveIntervals()).toBe(1);
    view.unmount();
    expect(liveIntervals()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("relaxes the shared cadence to 5s once no row wants 1s", () => {
    // A mixed column pins the ticker at the fast rate; once the last fast row is relaxed, the ticker
    // must relax with it rather than keep waking every second for nothing.
    //
    // Driven through `setSpec` so the rows are RECONCILED rather than remounted. Handing `rerender`
    // a differently-shaped child list unmounts the whole set and mounts a fresh one, which drops the
    // subscriber count to zero and tears the ticker down — a path that answers 5000 for a reason
    // that has nothing to do with the relaxation being tested.
    const { setSpec } = mountRows([FAST_SINCE, SLOW_SINCE, SLOW_SINCE]);
    expect(tickerCadence()).toBe(1000);

    setSpec([SLOW_SINCE, SLOW_SINCE, SLOW_SINCE]);
    // LAZY, BY DESIGN. The ticker does not relax at unsubscribe time — that restart is what starved
    // the column during `since` churn (roborev 60545) — so it is still at 1000 here and relaxes on
    // the next fire instead. One extra wakeup at the old rate is the whole cost.
    expect(tickerCadence()).toBe(1000);

    runSeconds(1);
    expect(liveIntervals()).toBe(1);
    expect(tickerCadence()).toBe(5000);
  });

  it("TIGHTENS immediately when a fast row joins a relaxed column", () => {
    // The other direction, and the one that must NOT be lazy: a row the user just prompted has to
    // start counting seconds now, not up to five seconds from now. Mounting order matters here —
    // every other case in this file subscribes the fast row first, so the relaxed→fast transition
    // would otherwise never be exercised at all.
    const { setSpec } = mountRows([SLOW_SINCE, SLOW_SINCE, SLOW_SINCE]);
    expect(tickerCadence()).toBe(5000);
    setSpec([SLOW_SINCE, SLOW_SINCE, FAST_SINCE]);
    expect(tickerCadence()).toBe(1000);
    expect(liveIntervals()).toBe(1);
  });
});

describe("the two rates survive being shared — a relaxed row is not woken at the fast rate", () => {
  it("wakes each row at its OWN cadence over 30 simulated seconds", () => {
    // ONE fast row and 59 relaxed ones — the founder's actual column, where one agent was just
    // prompted and the rest have been running a while. The ticker must run at 1s for the fast row
    // WITHOUT dragging the other 59 along with it.
    const { clockRenders } = mountRows([
      FAST_SINCE,
      ...Array.from({ length: 59 }, () => SLOW_SINCE),
    ]);

    runSeconds(30);

    const fastRenders = clockRenders[0] ?? 0;
    const slowRenders = clockRenders.slice(1);
    console.log(
      `[rowClockShared] 30s, 1 fast + 59 relaxed rows — fast row: ${fastRenders} renders, ` +
        `relaxed rows: ${slowRenders.reduce((a, b) => a + b, 0)} renders total ` +
        `(${slowRenders[0]} each); intervals: ${liveIntervals()}`,
    );

    // The ticker is at the fast rate…
    expect(tickerCadence()).toBe(1000);
    // …and the fast row gets every one of those ticks.
    expect(fastRenders).toBe(30);
    // …but every relaxed row gets 6, not 30. A shared ticker that notified everybody would put 30
    // here, which is the 5× regression this whole shape is built to avoid.
    expect(new Set(slowRenders).size).toBe(1);
    expect(slowRenders[0]).toBe(6);
  });

  it("still advances the clock each row reads, at that row's own beat", () => {
    // THE PAIRED TEST. Every bound above is about work NOT done, and all of them are satisfied by a
    // clock that stopped ticking. This one asserts the value the row actually renders.
    const { lastNow } = mountRows([FAST_SINCE, SLOW_SINCE]);
    expect(lastNow[0]).toBe(T0);
    expect(lastNow[1]).toBe(T0);

    act(() => void vi.advanceTimersByTime(1000));
    expect(lastNow[0]).toBe(T0 + 1000); // due
    expect(lastNow[1]).toBe(T0); // not due — 1s into a 5s beat

    act(() => void vi.advanceTimersByTime(3000));
    expect(lastNow[0]).toBe(T0 + 4000);
    expect(lastNow[1]).toBe(T0); // still not due at 4s

    act(() => void vi.advanceTimersByTime(1000));
    expect(lastNow[0]).toBe(T0 + 5000);
    expect(lastNow[1]).toBe(T0 + 5000); // due
  });

  it("moves a row onto the relaxed beat when it crosses 100s", () => {
    // The cadence flip is per row and must survive the move to a shared ticker: a row that has been
    // idle for just under 100s ticks every second, and stops doing so the moment it passes.
    const { clockRenders } = mountRows([T0 - 97_000]);
    runSeconds(3); // now 100s idle → relaxed from here on
    const atFlip = clockRenders[0] ?? 0;
    expect(atFlip).toBe(3); // three fast ticks

    runSeconds(10);
    // Two relaxed ticks in ten seconds, not ten fast ones.
    expect((clockRenders[0] ?? 0) - atFlip).toBe(2);
    expect(tickerCadence()).toBe(5000);
  });
});

// ── THE STARVATION BUG A SHARED TICKER CAN HAVE AND SIXTY TIMERS CANNOT ─────────────────────────
// Replacing the interval discards a PENDING fire. With one shared timer that starves EVERY row, not
// just the one that churned — which makes this the single most dangerous failure mode of the whole
// change, and the first version had it (roborev 60545).
//
// The churn is not hypothetical. `since` is `interactionStore.lastAt`, rewritten every
// TOUCH_THROTTLE_MS (900ms) for as long as the user types into a terminal, and the hook
// resubscribes on every change to it. An unsubscribe that relaxed the ticker to 5s followed
// immediately by a resubscribe that tightened it back to 1s destroyed the 1s interval every ~900ms,
// so it never reached its first fire and the entire column's clock froze while typing continued.
describe("`since` churn on one row does not freeze the rest of the column", () => {
  it("keeps the relaxed rows advancing through 30s of simulated typing", () => {
    // One row being typed into, two resting — the founder's column in miniature.
    const { clockRenders, lastNow, setSpec } = mountRows([FAST_SINCE, SLOW_SINCE, SLOW_SINCE]);

    // 33 keystroke windows of 900ms ≈ 29.7s, each rewriting the typed row's `since` exactly as
    // `touch()` does. Real time advances with them, so the resting rows are genuinely due.
    for (let i = 0; i < 33; i += 1) {
      act(() => void vi.advanceTimersByTime(900));
      setSpec([Date.now(), SLOW_SINCE, SLOW_SINCE]);
    }

    const advanced = (lastNow[1] ?? 0) - T0;
    console.log(
      `[rowClockShared] after ~30s of churn on one row — relaxed row advanced ${advanced}ms ` +
        `over ${clockRenders[1]} clock-driven renders (ticker at ${tickerCadence()}ms)`,
    );

    // THE ASSERTION. Against the restart-on-unsubscribe version both of these are ZERO: the shared
    // interval never survived long enough to fire even once in thirty seconds of typing.
    //
    // `clockRenders`, not `renders` — the harness itself re-renders every row 33 times here, so a
    // raw render count is ≥ 34 whatever the ticker does (roborev 60587).
    expect(advanced).toBeGreaterThanOrEqual(20_000);
    expect(clockRenders[1] ?? 0).toBeGreaterThanOrEqual(5);
    // Both resting rows, not just the one that happens to be first in the set.
    expect(lastNow[2]).toBe(lastNow[1]);
    // And still one timer — the fix must not have bought this back with extra intervals.
    expect(liveIntervals()).toBe(1);
  });

  // NOT ASSERTED, AND WORTH KNOWING: the CHURNING row's own shared-clock beat is also suppressed
  // while it is being typed into, because each resubscribe resets its `last` stamp before the
  // interval next fires. That is unchanged from the per-row implementation (which restarted that
  // row's own interval every 900ms with exactly the same result) and it is harmless: `since` is
  // itself a store subscription, so a keystroke re-renders that row through a different path and
  // its counter is never stale. The regression this block guards is the OTHER fifty-nine.
});

describe("the shared ticker keeps the visibility gating it replaced", () => {
  it("pauses every row on hide and catches all of them up on show", () => {
    const { lastNow } = mountRows([FAST_SINCE, SLOW_SINCE]);

    act(() => void vi.advanceTimersByTime(1000));
    expect(lastNow[0]).toBe(T0 + 1000);

    setVisibility("hidden");
    // ONE interval to stop, and it is stopped — sixty rows' worth of wakeups gone in one call.
    expect(liveIntervals()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    act(() => void vi.advanceTimersByTime(20_000));
    expect(lastNow[0]).toBe(T0 + 1000); // frozen while hidden
    expect(lastNow[1]).toBe(T0);

    setVisibility("visible");
    // BOTH rows catch up immediately — including the relaxed one, which was mid-beat.
    expect(lastNow[0]).toBe(T0 + 21_000);
    expect(lastNow[1]).toBe(T0 + 21_000);
    expect(liveIntervals()).toBe(1);

    act(() => void vi.advanceTimersByTime(1000));
    expect(lastNow[0]).toBe(T0 + 22_000);
  });

  it("adds ONE visibilitychange listener for the whole column, not one per row", () => {
    const add = vi.spyOn(document, "addEventListener");
    const remove = vi.spyOn(document, "removeEventListener");
    const { view } = mountRows(Array.from({ length: 60 }, () => FAST_SINCE));
    const added = add.mock.calls.filter(([type]) => type === "visibilitychange").length;
    console.log(`[rowClockShared] visibilitychange listeners for 60 rows: ${added}`);
    expect(added).toBe(1);
    view.unmount();
    expect(remove.mock.calls.filter(([type]) => type === "visibilitychange")).toHaveLength(1);
  });
});
