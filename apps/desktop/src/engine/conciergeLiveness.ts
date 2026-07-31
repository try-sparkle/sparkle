// IS THE CONCIERGE STILL THERE? — the state machine behind the column's liveness signal.
//
// THE COMPLAINT. "When a concierge turn fails or hangs, I see NOTHING — no error, no state change.
// It just silently stops answering." On 2026-07-29 that happened all day and the human assumed a 529
// overload. It was not: 15 turns died on quota (whose text the host discarded — see
// ./conciergeFailureNotice) and 149 of 378 were killed mid-flight by the user's own next send and
// emitted nothing at all.
//
// ─── THE SIGNAL IS A COLOUR, AND ONLY A COLOUR (2026-07-30) ──────────────────────────────────────
//
// The first version of this answered the complaint too loudly: an elapsed counter from 5s, the word
// OFFLINE at 20s, and a sticky "your concierge isn't answering" strip at 90s. The founder's verdict
// on living with it: *"don't have it say no answer yet, just have the color change from gray to
// yellow to then red."* And on the timing: going red at 30s is too distracting for something that is
// usually just a slow turn — RED SHOULD MEAN SOMETHING IS ACTUALLY WRONG, not that a reply is taking
// a moment.
//
// So there are three steps and no words:
//
//     GRAY    0-30s    a concierge taking a few seconds is NORMAL and must look normal
//     YELLOW  30s+     long enough to be worth noticing, quiet enough to ignore
//     RED     60s+     now something is probably wrong
//
// This is deliberately a WEAKER claim than the words it replaces, and that is the point. A colour
// asserts nothing a clock cannot support, so it can never be the confidently-wrong diagnosis the
// header below warns about — and it costs a glance rather than a sentence to dismiss.
//
// ─── WHY 30s AND 60s ─────────────────────────────────────────────────────────────────────────────
//
// Turn duration is not directly logged, but it is recoverable: `concierge_turn` logs its supersede
// line iff the turn slot was occupied (concierge.rs:930-935), so every consecutive spawn pair is a
// clean interval-censored observation of the earlier turn. Over 380 such observations on 2026-07-29
// (152 still alive / 228 already finished):
//
//     fastest observed round trip (spawn → quota rejection)   3.03s   nothing can return sooner
//     slowest observed hard failure                          16.67s   below this, a colour beats the real error
//     median user re-send                                    20.94s   the measured moment humans give up
//     median healthy turn                                     ~54s
//     p90 healthy turn                                       ~120s
//
// 30s clears the slowest observed hard failure by ~2x, so a turn that is going to report a real
// error always wins the race and states its own reason (a verbatim failure bubble) before any
// colour moves. It sits just past the median re-send, i.e. the signal arrives when the human starts
// doubting rather than before. And it is 10x the physical floor, so it cannot fire on a fast turn.
//
// 60s is the old 20s→90s escalation compressed to a single doubling. It is past the ~54s median
// healthy turn, which matters far less than it looks — see the next section — and it is the point
// past which only ~26% of turns are still running at all.
//
// ─── SILENCE, NOT ELAPSED TIME ───────────────────────────────────────────────────────────────────
//
// The clock measures time since the last OBSERVED SIGN OF LIFE — a send starts it, and every delta
// and every `concierge_tool` call resets it. That is the whole reason a 30s threshold is safe
// against a 54s median: a healthy turn is emitting something the entire time, so it never
// accumulates 30 quiet seconds. A turn that has gone 30s without a byte is not a slow turn.
//
// ─── SUPERSEDING IS NOT A FAILURE ────────────────────────────────────────────────────────────────
//
// A turn killed because the user sent again is self-inflicted, and the replacement turn is the one
// being awaited — so a supersede must never colour the row. Superseded/cancelled/proactive events
// are filtered at the call site and never reach a reducer here. The OTHER half of that bug — the
// user's earlier message silently going unanswered — is real, and is surfaced where it belongs, on
// the orphaned bubble itself (Concierge/RoutingReceipt `unanswered`), not as a health claim.
//
// ─── WHAT THIS DOES *NOT* TOUCH: ERRORS THE APP ACTUALLY RECEIVED ────────────────────────────────
//
// Everything above is about SILENCE. A turn that comes back with a quota message, a billing error or
// any other hard failure still surfaces verbatim, in its own thread bubble, on the path that has
// nothing to do with these thresholds (ConciergeHost's `concierge:error` handler →
// ./conciergeFailureNotice). {@link failureOutage} below is the sticky version of the same fact for
// a RUN of them, and it is the one surface in this feature that still speaks in words — because it
// is repeating what the machine said, not guessing at silence.
import {
  conciergeFailureNotice,
  type ConciergeFailureNotice,
} from "./conciergeFailureNotice";

/**
 * YELLOW: nothing has come back for long enough to be worth noticing.
 *
 * See the module header for the measurements. The short version: past the 16.67s slowest observed
 * hard failure (so a real error always states itself first) and past the 20.94s median re-send (so
 * it arrives when the human starts doubting, not before).
 */
export const SLOW_AFTER_MS = 30_000;

/**
 * RED: nothing has come back for long enough that something is probably wrong.
 *
 * The founder's reasoning, which is the whole reason this is 60s and not the 30s an earlier draft
 * used: *going red at 30 seconds is too distracting for something that is usually just a slow turn.
 * Red should mean something is actually wrong, not that a reply is taking a moment.* A red that
 * fires on ordinary slowness is a red nobody reads.
 *
 * This is also the TERMINAL step — it subsumes the 90s sticky UNAVAILABLE state this replaced.
 * A fourth escalation would have to distinguish itself from red without words, and there is no
 * fourth colour that means "worse than red" at a glance; it would only have re-introduced the
 * loudness that was the complaint.
 */
export const STALLED_AFTER_MS = 60_000;

/**
 * How many consecutive unanswered sends go RED regardless of the clock.
 *
 * ESSENTIAL, not belt-and-braces. Every re-send restarts the silence clock, so a user pinging every
 * 30s never accumulates 60 continuous quiet seconds — which is precisely the shape of the
 * 20:18–20:31 burst on 2026-07-29, where 12 of 14 turns died unanswered. The time bound alone would
 * have stayed gray through the exact incident this feature was built for.
 */
export const STALLED_SILENT_RUN = 3;

/**
 * How many consecutive HARD FAILURES raise the sticky outage strip.
 *
 * Not a colour step — see {@link failureOutage}. This counts errors the app RECEIVED, which end the
 * wait and so produce no silence at all: every failure actually observed in a day of logs was a
 * fast, loud error (3–17s). Six consecutive monthly-spend-limit rejections is the textbook "your
 * concierge is unavailable" condition and the silence clock never moves for it.
 *
 * Three, not one, for the reason `aiServiceHealthStore.AI_SERVICE_DEGRADED_THRESHOLD` is four: a
 * lone failure is the blip the retry path exists for, and a sticky banner on it would be worse than
 * the one bubble it already wrote. Lower than that store's four because a concierge turn is a
 * deliberate user action — three in a row is three questions the human asked and did not get
 * answered.
 */
export const FAILURE_OUTAGE_RUN = 3;

/**
 * The longest gap allowed BETWEEN two failures in the same run.
 *
 * Mirrors `aiServiceHealthStore.RUN_MAX_GAP_MS`, and exists for the same reason: without it,
 * "3 consecutive failures" silently means "3 failures ever, with any amount of working concierge in
 * between" — a morning quota rejection and two unrelated evening ones would raise a sticky outage
 * strip describing a run that never happened. An hour is long enough to survive the real case (a
 * user retrying into an exhausted quota over several minutes) and short enough that isolated blips
 * days apart cannot accumulate.
 */
export const FAILURE_RUN_MAX_GAP_MS = 60 * 60 * 1000;

/**
 * What the column is entitled to say about the brain right now — and it says it in COLOUR.
 *
 *   `idle`     nothing is being awaited; the row is not on screen at all
 *   `waiting`  gray — the normal state, and the one the first 30 seconds must look like
 *   `slow`     yellow
 *   `stalled`  red, and sticky (see {@link ConciergeLivenessState.stalledLatched})
 *
 * `offline` and `unavailable` were the previous two names. They are gone on purpose: both were
 * CLAIMS about the brain that the app could not support from silence alone, and the words that
 * carried them are what the founder asked to remove.
 */
export type ConciergeLiveness = "idle" | "waiting" | "slow" | "stalled";

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
 *     STALLED bound          |             |           |           |            |         |
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
  /** Consecutive sends that crossed {@link SLOW_AFTER_MS} and produced nothing. */
  silentRun: number;
  /** Consecutive hard failures with no success in between, and no gap longer than
   *  {@link FAILURE_RUN_MAX_GAP_MS}. */
  failureRun: number;
  /** When the most recent hard failure was observed, so the run above can be bounded in time.
   *  `null` when no failure has been seen. */
  lastFailureAt: number | null;
  /** Sticky RED. Set by {@link reduceTick} when the time bound is crossed and cleared ONLY by
   *  observed output — this is what stops a fresh send from silently returning the row to gray over
   *  a brain we have no evidence is back. */
  stalledLatched: boolean;
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
  stalledLatched: false,
  failure: null,
};

/** How long we have gone without a sign of life, or null when nothing is being awaited. */
export function silentForMs(s: ConciergeLivenessState, now: number): number | null {
  return s.silentSince === null ? null : Math.max(0, now - s.silentSince);
}

/**
 * The colour step the column may show. Pure, with `now` injected — so the rule is testable without
 * fake timers and the component cannot drift from the store (the posture
 * `aiServiceHealthStore.isServiceDegraded` takes).
 *
 * Ordered most-severe first: a stalled brain that happens to have a fresh send against it is still
 * stalled until something proves otherwise.
 *
 * SILENCE ONLY. A hard failure does not appear here, because a failure ENDS the wait — there is no
 * row left to colour, and the error is already in the thread in its own words. {@link failureOutage}
 * is where a run of them surfaces.
 */
export function livenessAt(s: ConciergeLivenessState, now: number): ConciergeLiveness {
  if (s.stalledLatched || s.silentRun >= STALLED_SILENT_RUN) return "stalled";
  const silent = silentForMs(s, now);
  if (silent === null) return "idle";
  if (silent >= STALLED_AFTER_MS) return "stalled";
  if (silent >= SLOW_AFTER_MS) return "slow";
  return "waiting";
}

/**
 * THE ONE SURFACE HERE THAT STILL USES WORDS: a run of hard failures, in the machine's own words.
 *
 * Returns the last failure notice once {@link FAILURE_OUTAGE_RUN} consecutive errors have been
 * observed, and null otherwise. This is NOT the silence signal and must not be conflated with it —
 * it is a verbatim repeat of something the app actually received (a quota message, a billing error,
 * an unclassifiable stderr dump), which is exactly the class of thing the colour-only retune was
 * told to leave alone.
 *
 * THIS IS WHAT KEEPS THE STRIP HONEST. `failure` is deliberately kept across a send (it is still the
 * last thing we know, and clearing it on send would break the failure run, since every failure is
 * followed by another send). Gating the strip on the RUN rather than on `failure != null` is what
 * stops a quota rejection from this morning being rendered at 2pm as an account of a concierge that
 * has merely gone quiet — a diagnosis from stale evidence, which is precisely what
 * Concierge/ConciergeUnavailable's own header forbids (roborev 55442-M4).
 */
export function failureOutage(s: ConciergeLivenessState): ConciergeFailureNotice | null {
  return s.failureRun >= FAILURE_OUTAGE_RUN ? s.failure : null;
}

/**
 * Is there anything left for a clock to change? The gate on the feature's only timer.
 *
 * TRUE while a turn is outstanding and the colour can still move. FALSE at RED, which is terminal:
 * `stalledLatched` holds the verdict in state, there is no fourth step to escalate to, and — since
 * the elapsed counter was removed — nothing on screen is computed from `now` any more. A tick past
 * that point could not change a pixel, so a turn that dies and is never retried schedules nothing
 * for the rest of the session.
 *
 * (The previous version had to keep ticking through the terminal state to advance a visible seconds
 * counter, and needed a 10-minute ceiling to stop it eventually. Removing the counter removed the
 * reason for both.)
 *
 * Pure and exported so the bound is asserted directly, rather than inferred from a timer count in a
 * component test.
 */
export function ticks(s: ConciergeLivenessState, now: number): boolean {
  return s.silentSince !== null && livenessAt(s, now) !== "stalled";
}

/**
 * A user send went out.
 *
 * This is where "repeated pings with still no response" is counted. The wait being REPLACED is
 * judged, not the new one: if it had already gone yellow and never produced a byte, that is one
 * unanswered ping. A wait that streamed something — even a partial answer the user then interrupted
 * — is not silence and does not count.
 */
export function reduceSent(s: ConciergeLivenessState, now: number): ConciergeLivenessState {
  const wentUnanswered =
    s.silentSince !== null && !s.sawOutput && now - s.silentSince >= SLOW_AFTER_MS;
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
 * emitting a word of text; counting only deltas would paint a working concierge red. Only `"text"`
 * sets {@link ConciergeLivenessState.sawText} — see that field for why the distinction is
 * load-bearing rather than tidy.
 *
 * Clears every escalation: this is the "recovering clears the state promptly" requirement, and it is
 * the ONLY thing that unlatches RED.
 *
 * Progress observed while nothing is being awaited (a proactive push's tool call) still unlatches:
 * showing red over a brain that is visibly working is the one thing worse than showing nothing. It
 * does not start a wait, because nobody is waiting.
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
    stalledLatched: false,
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
    stalledLatched: false,
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
 * and the verbatim reason is already going into the thread as its own bubble; a sticky strip on a
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
  if (s.stalledLatched) return s;
  if (livenessAt(s, now) !== "stalled") return s;
  return { ...s, stalledLatched: true };
}
