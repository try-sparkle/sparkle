// IS THE CONCIERGE STILL THERE? — the state machine behind the column's liveness signal.
//
// THE COMPLAINT. "When a concierge turn fails or hangs, I see NOTHING — no error, no state change.
// It just silently stops answering." On 2026-07-29 that happened all day and the human assumed a 529
// overload. It was not: 15 turns died on quota (whose text the host discarded — see
// ./conciergeFailureNotice) and 149 of 378 were killed mid-flight by the user's own next send and
// emitted nothing at all.
//
// ─── WHY THE THRESHOLDS ARE WHAT THEY ARE ────────────────────────────────────────────────────────
//
// The instinct is "no answer in a few seconds → offline". The logs say that would fire on nearly
// every HEALTHY turn. Turn duration is not directly logged, but it is recoverable: `concierge_turn`
// logs its supersede line iff the turn slot was occupied (concierge.rs:930-935), so every
// consecutive spawn pair is a clean interval-censored observation of the earlier turn. Over 380 such
// observations on 2026-07-29 (152 still alive / 228 already finished):
//
//     fastest observed round trip (spawn → quota rejection)   3.03s   nothing can return sooner
//     slowest observed hard failure                          16.67s   below this, OFFLINE beats the real error
//     median user re-send                                    20.94s   the measured moment humans give up
//     median healthy turn                                     ~54s
//     p90 healthy turn                                       ~120s
//
// So a 5s OFFLINE would be permanently on, and a signal that is always on is not a signal.
//
// ─── SILENCE, NOT ELAPSED TIME ───────────────────────────────────────────────────────────────────
//
// The clock measures time since the last OBSERVED SIGN OF LIFE — a send starts it, and every delta
// and every `concierge_tool` call resets it. That is the whole reason a 20s threshold is safe
// against a 54s median: a healthy turn is emitting something the entire time, so it never
// accumulates 20 quiet seconds. A turn that has gone 20s without a byte is not a slow turn.
//
// ─── SUPERSEDING IS NOT A FAILURE ────────────────────────────────────────────────────────────────
//
// A turn killed because the user sent again is self-inflicted, and the replacement turn is the one
// being awaited — so a supersede must never read as OFFLINE. Superseded/cancelled/proactive events
// are filtered at the call site and never reach a reducer here. The OTHER half of that bug — the
// user's earlier message silently going unanswered — is real, and is surfaced where it belongs, on
// the orphaned bubble itself (Concierge/RoutingReceipt `unanswered`), not as a health claim.
import {
  conciergeFailureNotice,
  type ConciergeFailureNotice,
} from "./conciergeFailureNotice";

/**
 * When the column starts stating the elapsed time.
 *
 * This is the honest version of the "a few seconds" instinct: at 5s the column says `12s`, which
 * ASSERTS NOTHING. It cannot be wrong, so it can fire early — which is exactly what a human waiting
 * on a slow turn wants and what the bare `…` never gave them.
 */
export const ELAPSED_COUNTER_AFTER_MS = 5_000;

/**
 * When silence becomes a CLAIM: "no answer yet".
 *
 * Three independent anchors land on 20s, all from the table in the module header:
 *   • above the slowest observed hard failure (16.67s), so a turn that is going to report a real
 *     error always wins the race and states its own reason instead of flashing OFFLINE first;
 *   • at the median moment users actually re-send (20.94s) — the signal arrives exactly when the
 *     human starts doubting, which is the whole point;
 *   • ~7× the 3.03s physical floor for any round trip, so it cannot fire on a fast healthy turn.
 */
export const OFFLINE_AFTER_MS = 20_000;

/** When continuous silence stops being "slow" and becomes "gone". Only ~14% of turns are still
 *  running at all past 90s, and a running turn emits deltas or tool calls long before then. */
export const UNAVAILABLE_AFTER_MS = 90_000;

/**
 * How many consecutive unanswered sends escalate to UNAVAILABLE regardless of the clock.
 *
 * ESSENTIAL, not belt-and-braces. Every re-send restarts the silence clock, so a user pinging every
 * 20s never accumulates 90 continuous quiet seconds — which is precisely the shape of the
 * 20:18–20:31 burst on 2026-07-29, where 12 of 14 turns died unanswered. The time bound alone would
 * have stayed silent through the exact incident this feature was built for.
 */
export const UNAVAILABLE_SILENT_RUN = 3;

/**
 * How many consecutive HARD FAILURES escalate to UNAVAILABLE.
 *
 * Without this, UNAVAILABLE could essentially never fire in the real world: every failure actually
 * observed in a day of logs was a fast, loud error (3–17s), which ends the wait and so never
 * accumulates silence. Six consecutive monthly-spend-limit rejections is the textbook "your
 * concierge is unavailable" condition and it produces zero silent seconds.
 *
 * Three, not one, for the reason `aiServiceHealthStore.AI_SERVICE_DEGRADED_THRESHOLD` is four: a
 * lone failure is the blip the retry path exists for, and a sticky banner on it would be worse than
 * the silence. Lower than that store's four because a concierge turn is a deliberate user action —
 * three in a row is three questions the human asked and did not get answered.
 */
export const UNAVAILABLE_FAILURE_RUN = 3;

/**
 * The longest gap allowed BETWEEN two failures in the same run.
 *
 * Mirrors `aiServiceHealthStore.RUN_MAX_GAP_MS`, and exists for the same reason: without it,
 * "3 consecutive failures" silently means "3 failures ever, with any amount of working concierge in
 * between" — a morning quota rejection and two unrelated evening ones would raise a sticky outage
 * banner describing a run that never happened. An hour is long enough to survive the real case (a
 * user retrying into an exhausted quota over several minutes) and short enough that isolated blips
 * days apart cannot accumulate.
 */
export const FAILURE_RUN_MAX_GAP_MS = 60 * 60 * 1000;

/** How the concierge came to be UNAVAILABLE — which decides whether there is a REASON to show.
 *
 *  `null` when it is not unavailable at all. See {@link livenessReason} for why the distinction has
 *  to be drawn at read time rather than stored. */
export type ConciergeUnavailableReason = "failures" | "silence";

/** What the column is entitled to say about the brain right now. */
export type ConciergeLiveness = "idle" | "waiting" | "offline" | "unavailable";

/**
 * Everything the detector knows. ONE record, so the counters and the latched flag cannot drift.
 *
 *   trigger                  | silentSince | sawOutput | silentRun | failureRun | latched | failure
 *   -------------------------|-------------|-----------|-----------|------------|---------|--------
 *   a send                   | = now       | false     | +1 iff the| unchanged  | kept    | kept
 *                            |             |           | wait it   |            |         |
 *                            |             |           | replaced  |            |         |
 *                            |             |           | was       |            |         |
 *                            |             |           | unanswered|            |         |
 *   a delta / tool call      | = now (if   | true (if  | 0         | 0          | false   | null
 *                            | waiting)    | waiting)  |           |            |         |
 *   a `done`                 | null        | false     | 0         | 0          | false   | null
 *   a hard error             | null        | false     | 0         | +1         | kept    | = notice
 *   the ticker crossing the  | unchanged   | unchanged | unchanged | unchanged  | true    | kept
 *     UNAVAILABLE bound      |             |           |           |            |         |
 *
 * A supersede/cancel appears nowhere: it is filtered before it reaches a reducer.
 */
export interface ConciergeLivenessState {
  /** Epoch ms of the last observed sign of life. `null` means no turn is being awaited. */
  silentSince: number | null;
  /** Has the turn currently being awaited produced ANY sign of life — a delta OR a tool call? This
   *  is the LIVENESS question, and it is what {@link reduceSent} counts a silent ping by. */
  sawOutput: boolean;
  /**
   * Has the turn currently being awaited produced assistant TEXT?
   *
   * A SECOND flag rather than a reading of `sawOutput`, because the two answer different questions
   * and disagree in the common case. Liveness asks "is anything happening?", for which a tool call
   * counts. The unanswered-message receipt asks "did the user get an answer?", for which it does
   * NOT — and reading state or a terminal before replying is the concierge's normal FIRST move, so
   * a displaced turn that had dispatched one tool call is the ordinary shape of a dropped question,
   * not a corner case. Sharing one flag left exactly those bubbles claiming "Answered here", which
   * is the lie this feature exists to remove.
   */
  sawText: boolean;
  /** Consecutive sends that crossed {@link OFFLINE_AFTER_MS} and produced nothing. */
  silentRun: number;
  /** Consecutive hard failures with no success in between, and no gap longer than
   *  {@link FAILURE_RUN_MAX_GAP_MS}. */
  failureRun: number;
  /** When the most recent hard failure was observed, so the run above can be bounded in time.
   *  `null` when no failure has been seen. */
  lastFailureAt: number | null;
  /** Sticky UNAVAILABLE. Set by {@link reduceTick} when the time bound is crossed and cleared ONLY
   *  by observed output — this is what makes the state "stronger and stickier" than OFFLINE, and
   *  what stops a fresh send from silently downgrading a brain we have no evidence is back. */
  unavailableLatched: boolean;
  /** The last hard failure, verbatim. Outlives its turn so the sticky strip can state a REASON
   *  rather than a shrug; cleared the moment anything succeeds. */
  failure: ConciergeFailureNotice | null;
}

export const IDLE_LIVENESS: ConciergeLivenessState = {
  silentSince: null,
  sawOutput: false,
  sawText: false,
  silentRun: 0,
  failureRun: 0,
  lastFailureAt: null,
  unavailableLatched: false,
  failure: null,
};

/** How long we have gone without a sign of life, or null when nothing is being awaited. */
export function silentForMs(s: ConciergeLivenessState, now: number): number | null {
  return s.silentSince === null ? null : Math.max(0, now - s.silentSince);
}

/**
 * The state the column may assert. Pure, with `now` injected — so the rule is testable without fake
 * timers and the component cannot drift from the store (the posture
 * `aiServiceHealthStore.isServiceDegraded` takes).
 *
 * Ordered most-severe first: an UNAVAILABLE brain that happens to have a fresh send against it is
 * still unavailable until something proves otherwise.
 */
export function livenessAt(s: ConciergeLivenessState, now: number): ConciergeLiveness {
  if (
    s.unavailableLatched ||
    s.silentRun >= UNAVAILABLE_SILENT_RUN ||
    s.failureRun >= UNAVAILABLE_FAILURE_RUN
  ) {
    return "unavailable";
  }
  const silent = silentForMs(s, now);
  if (silent === null) return "idle";
  if (silent >= UNAVAILABLE_AFTER_MS) return "unavailable";
  if (silent >= OFFLINE_AFTER_MS) return "offline";
  return "waiting";
}

/**
 * WHY it is unavailable — `"failures"` when a run of hard errors got us here, `"silence"` when
 * nothing came back, `null` when it is not unavailable at all.
 *
 * THIS IS WHAT KEEPS THE STRIP HONEST. `failure` is deliberately kept across a send (it is still the
 * last thing we know, and clearing it on send would break the failure run, since every failure is
 * followed by another send). But an outage reached through SILENCE has no causal connection to a
 * quota rejection from this morning, and rendering `resets 8:40am` hours later as the reason the
 * concierge is quiet now is a diagnosis from stale evidence — exactly what ConciergeUnavailable's
 * own header forbids. So the reason is DERIVED at read time from which route actually tripped, and
 * only the failure route is entitled to show the failure text.
 *
 * The failure route wins a tie: if both counters are over, a concrete error we observed is a better
 * account than "nothing came back".
 */
export function livenessReason(
  s: ConciergeLivenessState,
  now: number,
): ConciergeUnavailableReason | null {
  if (livenessAt(s, now) !== "unavailable") return null;
  return s.failureRun >= UNAVAILABLE_FAILURE_RUN ? "failures" : "silence";
}

/** Should the column be stating the elapsed time yet? */
export function showsElapsed(s: ConciergeLivenessState, now: number): boolean {
  const silent = silentForMs(s, now);
  return silent !== null && silent >= ELAPSED_COUNTER_AFTER_MS;
}

/** `12s`, `1m 04s`. Seconds are floored, so the counter never claims time that has not passed. */
export function elapsedLabel(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, "0")}s`;
}

/**
 * A user send went out.
 *
 * This is where "repeated pings with still no response" is counted. The wait being REPLACED is
 * judged, not the new one: if it had already crossed OFFLINE and never produced a byte, that is one
 * unanswered ping. A wait that streamed something — even a partial answer the user then interrupted
 * — is not silence and does not count.
 */
export function reduceSent(s: ConciergeLivenessState, now: number): ConciergeLivenessState {
  const wentUnanswered =
    s.silentSince !== null && !s.sawOutput && now - s.silentSince >= OFFLINE_AFTER_MS;
  return {
    ...s,
    silentSince: now,
    sawOutput: false,
    sawText: false,
    silentRun: wentUnanswered ? s.silentRun + 1 : s.silentRun,
  };
}

/** What was observed. `"text"` is an assistant delta — the user is getting an ANSWER. `"tool"` is a
 *  dispatched `concierge_tool` call — the brain is alive but has said nothing yet. */
export type ConciergeProgressKind = "text" | "tool";

/**
 * A sign of life: an assistant delta, or a `concierge_tool` call the control listener dispatched.
 *
 * BOTH reset the silence clock, because a turn can legitimately spend a minute on tool calls without
 * emitting a word of text; counting only deltas would call a working concierge offline. Only
 * `"text"` sets {@link ConciergeLivenessState.sawText} — see that field for why the distinction is
 * load-bearing rather than tidy.
 *
 * Clears every escalation: this is the "recovering clears the state promptly" requirement, and it is
 * the ONLY thing that unlatches UNAVAILABLE.
 *
 * Progress observed while nothing is being awaited (a proactive push's tool call) still unlatches:
 * showing "unavailable" over a brain that is visibly working is the one thing worse than showing
 * nothing. It does not start a wait, because nobody is waiting.
 */
export function reduceProgress(
  s: ConciergeLivenessState,
  now: number,
  kind: ConciergeProgressKind,
): ConciergeLivenessState {
  const waiting = s.silentSince !== null;
  return {
    ...s,
    silentSince: waiting ? now : null,
    sawOutput: waiting ? true : s.sawOutput,
    sawText: waiting && kind === "text" ? true : s.sawText,
    silentRun: 0,
    failureRun: 0,
    lastFailureAt: null,
    unavailableLatched: false,
    failure: null,
  };
}

/** A turn finished cleanly. Proof of life whether or not it carried text — an empty reply still
 *  means the child ran, answered and exited. */
export function reduceSettled(s: ConciergeLivenessState): ConciergeLivenessState {
  return {
    ...s,
    silentSince: null,
    sawOutput: false,
    sawText: false,
    silentRun: 0,
    failureRun: 0,
    lastFailureAt: null,
    unavailableLatched: false,
    failure: null,
  };
}

/**
 * A turn failed loudly.
 *
 * `silentRun` resets: an error is a RESPONSE, and this turn was answered — just not with an answer.
 * Conflating the two would let one loud failure and two silent ones add up to a state neither
 * describes. `failureRun` is the counter that belongs to this path.
 *
 * Deliberately does NOT latch on its own. One failure is the blip the Rust retry path exists for,
 * and the verbatim reason is already going into the thread as its own bubble; a sticky banner on a
 * single error would be the flappiness `aiServiceHealthStore` was built to avoid.
 */
export function reduceFailed(
  s: ConciergeLivenessState,
  detail: string,
  now: number,
): ConciergeLivenessState {
  // A failure too long after the previous one starts a NEW run rather than extending a stale one —
  // see FAILURE_RUN_MAX_GAP_MS.
  const continues = s.lastFailureAt !== null && now - s.lastFailureAt < FAILURE_RUN_MAX_GAP_MS;
  return {
    ...s,
    silentSince: null,
    sawOutput: false,
    sawText: false,
    silentRun: 0,
    failureRun: continues ? s.failureRun + 1 : 1,
    lastFailureAt: now,
    failure: conciergeFailureNotice(detail),
  };
}

/** The clock advanced. Returns the SAME object when nothing changed, so a store can write it
 *  unconditionally without waking every subscriber on every tick. */
export function reduceTick(s: ConciergeLivenessState, now: number): ConciergeLivenessState {
  if (s.unavailableLatched) return s;
  if (livenessAt(s, now) !== "unavailable") return s;
  return { ...s, unavailableLatched: true };
}
