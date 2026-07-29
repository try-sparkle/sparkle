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
// THE ONLY TIMER IN THE FEATURE lives in {@link useConciergeLiveness}, and it runs only while a turn
// is actually being awaited and has not already latched — so a resting app schedules nothing.
import { useEffect, useState } from "react";
import { create } from "zustand";

import type { ConciergeFailureNotice } from "../engine/conciergeFailureNotice";
import {
  IDLE_LIVENESS,
  livenessAt,
  livenessReason,
  reduceFailed,
  reduceProgress,
  reduceSent,
  reduceSettled,
  reduceTick,
  showsElapsed,
  silentForMs,
  type ConciergeLiveness,
  type ConciergeLivenessState,
  type ConciergeProgressKind,
  type ConciergeUnavailableReason,
} from "../engine/conciergeLiveness";

/**
 * How often the clock is re-read while a turn is outstanding.
 *
 * 500ms so the elapsed counter ticks visibly on whole seconds without the render churn of a
 * requestAnimationFrame loop. It is the ONLY interval this feature schedules, and it is gated on
 * there being something to wait for — an idle app, or one already latched into UNAVAILABLE, runs no
 * timer at all.
 */
export const LIVENESS_TICK_MS = 500;

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
  liveness: ConciergeLiveness;
  /** Milliseconds since the last observed sign of life, or null when nothing is being awaited. */
  silentMs: number | null;
  /** Whether the elapsed time is old enough to be worth stating. */
  showsElapsed: boolean;
  /** The last hard failure, verbatim, or null.
   *
   *  PRESENT IS NOT THE SAME AS RELEVANT: consult {@link ConciergeLivenessReading.reason} before
   *  showing it as the cause of the current state. A failure survives the sends that follow it (it
   *  is still the last thing we know), so an outage reached through silence can be carrying an
   *  unrelated one from hours ago. */
  failure: ConciergeFailureNotice | null;
  /** Which route reached UNAVAILABLE, or null when it is not unavailable. `"failures"` is the only
   *  value that entitles a surface to present {@link failure} as the reason. */
  reason: ConciergeUnavailableReason | null;
}

/**
 * Subscribe to the liveness signal, ticking the clock while a turn is outstanding.
 *
 * The interval both re-renders the caller (so the counter advances) and drives {@link reduceTick},
 * which is what LATCHES the sticky UNAVAILABLE state. Two things follow from that:
 *
 *   • It must not run when there is nothing to wait for, or a resting app would schedule a timer
 *     forever — hence the `waiting` gate. That gate is the whole of it.
 *   • It deliberately KEEPS running after UNAVAILABLE latches. Gating on the latch looked free —
 *     there is no further escalation to reach — but the elapsed counter is still on screen, and it
 *     is computed from the `now` the last tick captured. Stopping froze it: a dead turn read
 *     `No answer yet · 1m 30s` for as long as it stayed dead. Worse, a re-send then moved
 *     `silentSince` PAST that stale `now`, so the counter computed zero and vanished entirely. The
 *     one number this feature guarantees cannot be wrong must not be the one it stops updating.
 *
 * `reduceTick` returns the same object when nothing changed, so the unconditional `setState` inside
 * the interval does not wake subscribers on every tick — the residual cost of ticking through a
 * latched outage is one `Date.now()` read and one re-render of the two rows that subscribe.
 */
export function useConciergeLiveness(): ConciergeLivenessReading {
  const state = useConciergeLivenessStore();
  const [now, setNow] = useState<number>(() => Date.now());

  const waiting = state.silentSince !== null;

  useEffect(() => {
    if (!waiting) return;
    const id = setInterval(() => {
      const t = Date.now();
      setNow(t);
      useConciergeLivenessStore.setState(reduceTick(useConciergeLivenessStore.getState(), t));
    }, LIVENESS_TICK_MS);
    return () => clearInterval(id);
  }, [waiting]);

  // Read the clock during render as well as on the tick. A turn that starts between two intervals
  // would otherwise be judged against a `now` from before it existed, which reads as an instant
  // several-second-old wait on the very first frame.
  const at = waiting ? Math.max(now, state.silentSince ?? now) : now;
  return {
    liveness: livenessAt(state, at),
    reason: livenessReason(state, at),
    silentMs: silentForMs(state, at),
    showsElapsed: showsElapsed(state, at),
    failure: state.failure,
  };
}

/** Test-only: return the detector to its resting state so cases cannot see each other's turns. */
export function _resetConciergeLivenessForTests(): void {
  useConciergeLivenessStore.setState(IDLE_LIVENESS, true);
}
