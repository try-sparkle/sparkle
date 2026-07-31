// THE OBSERVED HALF of the concierge liveness signal — what the app has actually seen the brain do.
//
// Same split as services/conciergeActivity: this module RECORDS, engine/conciergeLiveness DECIDES,
// and the components render. Everything written here is a first-hand observation — a send we made,
// a delta that arrived, a tool call the control listener dispatched, an error event. Nothing is
// inferred and nothing is synthesised to keep a signal moving.
//
// WHAT IS DELIBERATELY NOT RECORDED. A superseded or cancelled turn, and a proactive push's failure.
// Those are filtered by their callers (ConciergeHost's error handler, via
// services/concierge `isSupersededDetail` / `isProactiveTurn`) and must never reach these writers:
// a turn the user's own next message killed is not evidence the concierge is unwell, and a push
// nobody asked for is not a question that went unanswered. See the engine's header.
//
// THE ONLY TIMER IN THE FEATURE lives in {@link useConciergeLiveness}. It runs while a turn is
// outstanding and the colour can still move, and stops the moment the row goes RED — which is
// terminal (`engine.ticks`). A resting app, and one whose turn died an hour ago, both schedule
// nothing.
import { useEffect, useState } from "react";
import { create } from "zustand";

import type { ConciergeFailureNotice } from "../engine/conciergeFailureNotice";
import {
  failureOutage,
  IDLE_LIVENESS,
  livenessAt,
  reduceFailed,
  reduceProgress,
  reduceSent,
  reduceSettled,
  reduceTick,
  ticks,
  type ConciergeLiveness,
  type ConciergeLivenessState,
  type ConciergeProgressKind,
} from "../engine/conciergeLiveness";

/**
 * How often the clock is re-read while a turn is outstanding.
 *
 * ONE SECOND, because the only thing a tick can change now is a colour, and the two colours change
 * at 30s and 60s. The previous 500ms existed to animate a visible seconds counter on whole seconds;
 * that counter is gone (see the engine header), so half the wakeups bought nothing. Landing the
 * colour up to a second late is not observable — nobody is watching a stopwatch, which is the whole
 * premise of the retune.
 *
 * It is the ONLY interval this feature schedules, and it is gated on `engine.ticks` — there must be
 * a turn outstanding AND a colour still able to move. An idle app runs no timer; neither does one
 * already showing red.
 */
export const LIVENESS_TICK_MS = 1_000;

export const useConciergeLivenessStore = create<ConciergeLivenessState>(() => IDLE_LIVENESS);

/** A user send went out. Called from the host's `askSparkle`, never from the proactive channel. */
export function noteConciergeSent(now: number = Date.now()): void {
  useConciergeLivenessStore.setState(reduceSent(useConciergeLivenessStore.getState(), now));
}

/** A sign of life. `kind` matters: only `"text"` counts as the user having been ANSWERED — see
 *  `ConciergeLivenessState.sawText`. */
export function noteConciergeProgress(
  kind: ConciergeProgressKind,
  now: number = Date.now(),
): void {
  useConciergeLivenessStore.setState(
    reduceProgress(useConciergeLivenessStore.getState(), now, kind),
  );
}

/** A turn finished cleanly. */
export function noteConciergeSettled(): void {
  useConciergeLivenessStore.setState(reduceSettled(useConciergeLivenessStore.getState()));
}

/** A turn failed loudly. `detail` is the Rust `concierge:error` payload, passed through untouched —
 *  the engine hands it to the classifier, which keeps it verbatim. */
export function noteConciergeFailed(detail: string, now: number = Date.now()): void {
  useConciergeLivenessStore.setState(
    reduceFailed(useConciergeLivenessStore.getState(), detail, now),
  );
}

/**
 * Did the turn currently being awaited say anything to the USER — assistant text, not just a tool
 * call?
 *
 * Read by the host at send time to decide whether the message it is about to displace was left
 * unanswered. `sawText`, NOT `sawOutput`: reading a terminal before replying is the concierge's
 * normal first move, so a turn that dispatched one tool call and was then displaced is the ordinary
 * shape of a dropped question — and asking the liveness flag would leave exactly those bubbles
 * saying "Answered here".
 *
 * A synchronous getter rather than a hook: the decision happens inside a callback, not during a
 * render, and reading it through a subscription would give the host the value from the last commit
 * rather than from now.
 */
export function conciergeSawAnswerText(): boolean {
  return useConciergeLivenessStore.getState().sawText;
}

/** What a component needs to render the signal. */
export interface ConciergeLivenessReading {
  /** The colour step: `waiting` gray, `slow` yellow, `stalled` red. */
  liveness: ConciergeLiveness;
  /**
   * A RUN of hard failures, in the machine's own words — or null.
   *
   * The only worded surface left in this feature, and deliberately separate from `liveness`: it
   * repeats an error the app RECEIVED rather than interpreting silence. Already gated on the run
   * (see `engine.failureOutage`), so a caller may render it as-is; a bare `failure` field would
   * have let a stale morning quota rejection be presented as the account of an afternoon lull.
   */
  outage: ConciergeFailureNotice | null;
}

/**
 * Subscribe to the liveness signal, ticking the clock while a turn is outstanding.
 *
 * The interval both re-renders the caller (so the colour advances) and drives {@link reduceTick},
 * which is what LATCHES red. Two things follow from that:
 *
 *   • It must not run when there is nothing to wait for, or a resting app would schedule a timer
 *     forever.
 *   • It stops AT red, because red is terminal: there is no further escalation to reach and — since
 *     the visible seconds counter was removed — nothing on screen is derived from `now` any more, so
 *     no later tick could change a pixel. That is a straight simplification of the previous version,
 *     which had to keep ticking through the terminal state to advance the counter and needed a
 *     ten-minute ceiling to stop a dead turn re-rendering twice a second for the rest of the
 *     session.
 *
 * `reduceTick` returns the same object when nothing changed, so the unconditional `setState` inside
 * the interval does not wake subscribers on every tick.
 */
export function useConciergeLiveness(): ConciergeLivenessReading {
  const state = useConciergeLivenessStore();
  const [now, setNow] = useState<number>(() => Date.now());

  const liveness = livenessAt(state, now);
  // Derived during render, so the gate re-evaluates on the very tick that carries it to red — that
  // render is what tears the interval down.
  const running = ticks(state, now);

  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => {
      const t = Date.now();
      setNow(t);
      useConciergeLivenessStore.setState(reduceTick(useConciergeLivenessStore.getState(), t));
    }, LIVENESS_TICK_MS);
    return () => clearInterval(id);
  }, [running]);

  // LATCH ON WHAT WAS READ, not only on what was ticked (roborev 56112-M2).
  //
  // `reduceTick` is the only writer of `stalledLatched`, and it used to run exclusively from the
  // interval above — which is fine only while a consumer stays mounted across the crossing. It does
  // not: when `aiLock` flips (an entitlement or credits refresh) ConciergeColumn swaps the thread
  // for ConciergeAiLocked and drops the strip, unmounting BOTH consumers. If the silence passes 60s
  // in that window, the row comes back red from the clock alone with the latch never set — and the
  // next send moves `silentSince` forward, so it drops silently back to gray over a brain nothing
  // proved is back. That is precisely what `stalledLatched` exists to prevent.
  //
  // So red latches the moment it is OBSERVED, from whichever path produced it. Idempotent: the
  // write flips the flag, the re-render re-runs this with `stalledLatched` true, and it stops.
  useEffect(() => {
    if (liveness !== "stalled" || state.stalledLatched) return;
    useConciergeLivenessStore.setState(reduceTick(useConciergeLivenessStore.getState(), Date.now()));
  }, [liveness, state.stalledLatched]);

  return {
    liveness,
    outage: failureOutage(state),
  };
}

/**
 * A DIFFERENT HUMAN IS HERE NOW — forget everything this detector observed.
 *
 * Called from the host's identity-reset subscription (roborev 55813). Distinct from
 * {@link noteConciergeSettled} even though the two produce the same eight fields today, because they
 * are answering different questions and only one of them is allowed to preserve anything:
 * `reduceSettled` spreads `...s` on purpose — it is a TURN ending, so a field describing the
 * conversation rather than the turn would rightly survive it. At an identity boundary nothing may
 * survive, so this REPLACES the state outright. Keeping them the same call would mean the next field
 * added to `ConciergeLivenessState` leaks one human's signal to the next, silently and by default.
 */
export function clearConciergeLiveness(): void {
  useConciergeLivenessStore.setState(IDLE_LIVENESS, true);
}

/** Test-only: return the detector to its resting state so cases cannot see each other's turns. */
export function _resetConciergeLivenessForTests(): void {
  clearConciergeLiveness();
}
