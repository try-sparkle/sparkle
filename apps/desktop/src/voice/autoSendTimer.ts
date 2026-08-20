// The auto-send countdown — a MOVING THRESHOLD, not a fixed delay (PRD §4c).
//
// ══════════════════════════════════════════════════════════════════════════════════════════════
// THE ONE RULE THAT MAKES THIS WORK
//
//   Elapsed silence ACCUMULATES. Each new transcript chunk recomputes confidence, which changes
//   the THRESHOLD the elapsed time is measured against. The CLOCK IS NEVER RESET.
//
// Getting this backwards makes the feature never fire, and it is the obvious implementation: a
// naive version clears its timeout and calls `setTimeout(fire, thresholdMs(tier))` on every
// re-evaluation. Transcript chunks arrive several times a second while someone is speaking, so the
// deadline is pushed past the horizon on every chunk and the send is never reached. The user stops
// talking, watches nothing happen, and presses Send by hand — at which point the whole feature is
// dead weight.
//
// So: `silenceStartedAt` is written ONCE per stretch of silence, by `noteSpeechEnd`. Re-evaluation
// writes only `tier`. `remainingMs` is then a pure function of the two.
//
// WHAT STOPS A COUNTDOWN, THEN — and how it tells a lagged chunk from new speech. Both look like
// "a transcript arrived while counting", but only one should cancel. The discriminator is which
// EVENT carried it, and it is already on the wire:
//
//   - `dictation://partial` — a COMMITTED segment. Deepgram finished transcribing audio the user
//     already spoke, and under load that lands well after the speech-end it belongs to. This is
//     the lag case: recompute the tier (`noteTranscript`) and leave the clock alone. Reacting to
//     it is the bug at the top of this header.
//   - `dictation://interim` — the live, word-by-word preview. It exists only while the microphone
//     is producing words RIGHT NOW, so it is the honest "they started talking again" signal
//     (`noteSpeechResumed`, then `noteTranscript`).
//
// The residual race — an interim from the just-ended utterance arriving after its own speech-end —
// resolves toward WAITING LONGER, which is the safe direction for a feature whose failure mode is
// sending half a sentence.
// ══════════════════════════════════════════════════════════════════════════════════════════════
//
// WHY NOT services/dispatchIntent. That module is the app's other arm/fire/cancel engine and it is
// well-tested, but it is built on a FIXED `setTimeout(delay)` chosen at arm time from a dispatch
// CLASS that never changes. Every one of its invariants — `remainingMs` measured from
// `countdownStartedAt`, the queue that re-presents with a FRESH countdown, `STALE_INTENT_MS` — is
// about a deadline that stands still. Threading a moving threshold through it would mean rewriting
// the timing core of a module whose other callers depend on exactly that stillness, so this is a
// sibling rather than an extension. What IS borrowed, deliberately:
//
//   - the STALENESS idea (see AUTO_SEND_STALE_MS): a countdown nobody has been present for stops
//     being something the user watched go past, and must not fire on its own;
//   - the ANNOUNCEMENT CONTRACT: this module produces STRINGS and never touches a live region.
//     The host feeds them to the concierge column's single `role="status"` node via `announce()`.
//     A second live region double-announces (roborev 52648/53010/53088).
//
// Pure except for `now` and one `setTimeout`, both injectable — so every rule below is testable
// with a fake clock and no React.

import { confidence, type Confidence } from "./confidence";
// THE FLOOR IS APPLIED HERE, at the one place the deadline is computed, rather than being a number
// the tray happens to respect. `settleThresholdMs` is the ladder's rung for a tier, never faster than
// SWEEP_FLOOR_MS. Importing `thresholdMs` directly instead would leave the floor as a promise no
// code kept: the ladder's fastest rung is 1s today, so the two agree until someone retunes it —
// and a retune below a second is exactly the case the floor exists for.
import { settleThresholdMs } from "./sendMode";

export type { Confidence };

/**
 * How long the rail waits before firing when a re-evaluation drops the threshold BELOW the silence
 * already elapsed (PRD §4c, the GUARD).
 *
 * The situation: the user has been quiet 4s under `verylow` (10s). A late transcript chunk lands,
 * the sentence now reads clean, and the tier jumps to `high` (1s) — which the accumulated 4s has
 * already blown past. Firing on that instant is a send with no visible countdown at all: the rail
 * would jump from a third-full to gone between two frames, and the user would never have had the
 * chance the countdown exists to give them.
 *
 * 600ms is the smallest window that still reads as a deliberate act rather than a glitch — long
 * enough for the fill's ~250ms ease to complete and be seen finishing, short enough that it does
 * not feel like a second countdown grafted onto the first.
 */
export const THRESHOLD_DROP_GRACE_MS = 600;

/**
 * How long an armed countdown may sit un-advanced before it refuses to fire on its own.
 *
 * Borrowed from `dispatchIntent.STALE_INTENT_MS` and much shorter (30s vs 10min) because the
 * bargain is tighter: this rail's promise is "you are watching a fill drain and can stop it". A
 * countdown that was suspended — the app backgrounded, the machine slept, a debugger paused the
 * event loop — resumes with an elapsed time measured against a wall clock the user was not present
 * for, and firing on that is sending a message nobody watched. `evaluate` disarms instead.
 */
export const AUTO_SEND_STALE_MS = 30_000;

/** What the rail is doing, and therefore what it draws. */
export type AutoSendPhase =
  /** The toggle is off. Nothing is watching, nothing will send. */
  | "disarmed"
  /** Armed and listening — speech is in progress or the box is empty. No clock is running. */
  | "listening"
  /** Speech has ended and silence is accumulating toward a threshold. The fill is draining. */
  | "counting";

/** Everything the rail needs to draw itself and the timer needs to decide. */
export interface AutoSendState {
  phase: AutoSendPhase;
  /** The latest transcript the rail is judging. "" while there is nothing to send. */
  transcript: string;
  /** The tier the current `transcript` earns. `verylow` while there is nothing (see confidence). */
  tier: Confidence;
  /**
   * When the CURRENT stretch of silence began, or null when speech is in progress.
   *
   * WRITTEN ONCE PER UTTERANCE, by {@link noteSpeechEnd}. Re-evaluation must never touch it — that
   * is the module's entire premise. `evaluate` only ever writes `tier`.
   */
  silenceStartedAt: number | null;
  /**
   * Set when a re-evaluation dropped the threshold below the already-elapsed silence: the instant
   * at which the {@link THRESHOLD_DROP_GRACE_MS} window closes. Null otherwise.
   *
   * Held as an ABSOLUTE deadline rather than a "grace started at" so it cannot be extended by a
   * second drop — the user is owed one visible moment, not one per late chunk.
   */
  fireNoEarlierThan: number | null;
  /**
   * The instant the clock was FROZEN, or null when it is running. See {@link pauseCountdown}.
   *
   * THE WHOLE CLOCK STOPS, not just the send: every reader of elapsed time below measures against
   * `pausedAt ?? now`, so silence does not accumulate, the fill does not drain, the staleness bound
   * does not creep, and `evaluate` refuses outright. A guard on the fire branch alone would leave
   * the deadline sliding past underneath the pause, and the send would land the instant it lifted —
   * which is the same surprise send from one moment later.
   */
  pausedAt: number | null;
  /**
   * The user has TYPED INTO this draft — it is no longer purely dictated. Floors the threshold at
   * {@link TYPED_EDIT_MIN_THRESHOLD_MS}; see that constant for why the speech ladder is not honest
   * about a hand-edited message.
   *
   * A PROPERTY OF THE DRAFT, so it outlives the keystroke that set it and every pause/resume cycle
   * after it. Cleared only when the draft itself goes: a send, a manual send, or a disarm.
   */
  handEdited: boolean;
}

/**
 * The instant this state's clock is measured at: frozen while paused, `now` otherwise.
 *
 * One helper rather than a `pausedAt ?? now` at five call sites, because a reader that forgets it
 * does not fail loudly — it silently un-pauses one of elapsed/remaining/fraction/staleness while
 * the others stay frozen, and the rail then disagrees with itself about the same clock.
 */
function clockAt(state: AutoSendState, now: number): number {
  return state.pausedAt ?? now;
}

/**
 * The threshold THIS state is measured against. One helper for the same reason as {@link clockAt}:
 * a reader that reaches for the bare ladder instead un-floors one of deadline/fill/telemetry while
 * the others stay floored, and the rail then disagrees with itself about when it will fire.
 */
export function thresholdFor(state: AutoSendState): number {
  return settleThresholdMs(state.tier, state.handEdited);
}

/** A fresh, disarmed rail. */
export function initialState(): AutoSendState {
  return {
    phase: "disarmed",
    transcript: "",
    tier: "verylow",
    silenceStartedAt: null,
    fireNoEarlierThan: null,
    pausedAt: null,
    handEdited: false,
  };
}

/** Turn the rail on (`listening`) or off. Off clears every clock — an armed-later rail starts fresh. */
export function setArmed(state: AutoSendState, armed: boolean): AutoSendState {
  // `handEdited` rides along with the transcript, and for the same reason: both describe the DRAFT
  // still sitting in the box, which a tray move does not touch. Dropping it here would hand the
  // express lane back to a hand-edited message the moment the tray left Speak and returned.
  if (!armed)
    return {
      ...initialState(),
      transcript: state.transcript,
      tier: state.tier,
      handEdited: state.handEdited,
    };
  if (state.phase !== "disarmed") return state;
  return { ...state, phase: "listening", silenceStartedAt: null, fireNoEarlierThan: null };
}

/**
 * A new transcript chunk landed. Recompute the tier — AND NOTHING ELSE ABOUT THE CLOCK.
 *
 * This is the function that would be wrong in the obvious implementation. It does not write
 * `silenceStartedAt`, does not clear it, and does not restart anything. Its whole job is to move
 * the target that the accumulated silence is measured against.
 *
 * It DOES clear `fireNoEarlierThan` when the new tier no longer puts the deadline behind us: a
 * grace window granted for a threshold drop that a later chunk undid has nothing left to protect.
 */
export function noteTranscript(
  state: AutoSendState,
  transcript: string,
  now: number,
): AutoSendState {
  if (state.phase === "disarmed") return { ...state, transcript, tier: confidence(transcript) };
  const tier = confidence(transcript);
  const next: AutoSendState = { ...state, transcript, tier };
  // `silenceStartedAt` is NOT touched. A committed segment arriving mid-countdown is transcription
  // lag, not new speech; the caller signals real speech separately via `noteSpeechResumed`. See the
  // module header for how the two are told apart.
  if (next.silenceStartedAt === null) return next;
  // Against the FROZEN clock while paused: a grace window granted on a stale elapsed would outlive
  // the pause, and `remainingMs` can only be delayed by it.
  const elapsed = clockAt(next, now) - next.silenceStartedAt;
  // The grace window only exists while the threshold is genuinely behind the elapsed time.
  if (elapsed < settleThresholdMs(tier, next.handEdited)) next.fireNoEarlierThan = null;
  else if (state.fireNoEarlierThan === null) next.fireNoEarlierThan = now + THRESHOLD_DROP_GRACE_MS;
  return next;
}

/**
 * The engine says the speaker stopped (`dictation://speech-end`). START the clock.
 *
 * THE ONLY writer of `silenceStartedAt`, and idempotent within an utterance: a `speech_final`
 * Results frame and the standalone `UtteranceEnd` frame can both describe the same silence
 * (cloud.rs emits either), and the second must not push the deadline out by a second.
 *
 * Does nothing with an empty transcript — there is no message to send, so there is nothing to count
 * toward.
 */
export function noteSpeechEnd(state: AutoSendState, now: number): AutoSendState {
  if (state.phase === "disarmed") return state;
  if (state.transcript.trim() === "") return state;
  if (state.silenceStartedAt !== null) return state; // already counting this silence
  return { ...state, phase: "counting", silenceStartedAt: now };
}

/**
 * The user started speaking again — or the composer was emptied. Stop counting WITHOUT sending.
 *
 * Distinct from `setArmed(false)`: the rail stays armed and will count again on the next
 * speech-end. This is what "keep talking and it waits" is made of.
 *
 * Driven by `dictation://interim` (the live preview), NOT by a committed segment — see the module
 * header. Clearing `silenceStartedAt` is also what lets the NEXT `noteSpeechEnd` re-anchor: without
 * it, a second utterance would be measured against the first one's silence and could fire while
 * the user was still mid-sentence.
 */
export function noteSpeechResumed(state: AutoSendState): AutoSendState {
  if (state.phase !== "counting") return state;
  return { ...state, phase: "listening", silenceStartedAt: null, fireNoEarlierThan: null };
}

/** Silence accumulated so far, or 0 when no clock is running. NEVER reset by re-evaluation, and it
 *  stops accumulating while the clock is paused (see {@link pauseCountdown}). */
export function elapsedMs(state: AutoSendState, now: number): number {
  if (state.silenceStartedAt === null) return 0;
  return Math.max(0, clockAt(state, now) - state.silenceStartedAt);
}

/**
 * FREEZE the clock — the user is writing an `@`-address and the message is not finished (bead
 * sparkle-14dtu).
 *
 * ══ THE FOUNDER'S REPORT ════════════════════════════════════════════════════════════════════════
 * *"When I'm in speak mode and I start to type the name of an agent with the at sign, I want the
 * countdown timer to pause as I'm typing the name of the agent. Right now, it doesn't pause until I
 * finish typing the name of the agent, and it often sends before I'm done."* A dictated sentence
 * ends, the clock starts, and he reaches for the keyboard to address it — so the countdown he is
 * racing is one that started before he began typing, and the half-typed `@Blue` goes out aimed at
 * nobody. `Concierge/mentions.isComposingMention` is the trigger, and it is true from the `@`
 * keystroke itself rather than from a name that has resolved.
 *
 * ── PAUSE, NOT CANCEL, AND NOT MERELY "DON'T FIRE" ─────────────────────────────────────────────
 * `noteSpeechResumed` also stops a countdown, and reaching for it here would be the obvious
 * implementation — but it is the wrong statement: it CLEARS `silenceStartedAt`, so nothing but a
 * fresh speech-end can ever count again, and a user who addresses a sentence he has already spoken
 * would find the rail permanently quiet with his words still in the box. He asked for a pause.
 *
 * IDEMPOTENT: a second pause must not re-anchor at a later instant, which would hand back the
 * silence accumulated between the two and shorten the countdown the pause exists to protect.
 */
export function pauseCountdown(state: AutoSendState, now: number): AutoSendState {
  if (state.pausedAt !== null) return state;
  return { ...state, pausedAt: now };
}

/**
 * Un-freeze the clock — the address is finished, or the `@` is gone.
 *
 * ══ THE COUNTDOWN RESTARTS FROM FULL. IT DOES NOT RESUME WHERE IT STOPPED ═══════════════════════
 * A literal resume is the reading the name suggests, and it is the one that would surprise him: he
 * types `@` with 200ms left on the clock, writes the name, presses space — and the message goes the
 * moment his finger leaves the spacebar, which from where he is sitting is indistinguishable from
 * the bug this fixes. *"He must not be surprised by a send he did not expect"* is the governing
 * rule, so the pause is worth a whole fresh threshold on the way out.
 *
 * It is also the honest reading of what happened: the draft CHANGED while the clock was stopped —
 * it has a new address on the front of it — so the silence being measured is silence since that
 * edit, not since the utterance before it. Re-anchoring is the same statement `noteSpeechEnd` makes
 * about a new utterance. Note this does NOT contradict the module header's "re-evaluation never
 * resets the clock": that rule is about a transcript CHUNK arriving on its own (transcription lag,
 * which must not push the deadline out), and this is an explicit edit gesture the user made.
 *
 * The drop-grace goes with it: {@link THRESHOLD_DROP_GRACE_MS} buys one visible moment against an
 * elapsed time that no longer exists.
 */
export function resumeCountdown(state: AutoSendState, now: number): AutoSendState {
  if (state.pausedAt === null) return state;
  if (state.phase !== "counting" || state.silenceStartedAt === null) {
    return { ...state, pausedAt: null };
  }
  return { ...state, pausedAt: null, silenceStartedAt: now, fireNoEarlierThan: null };
}

/**
 * The draft GREW by a gesture the user made — a paste, a dropped image, a picked file. Put the
 * clock back to a FULL threshold and keep counting (bead sparkle-3kqg2v).
 *
 * ══ THE FOUNDER'S REPORT ════════════════════════════════════════════════════════════════════════
 * *"So maybe we just need to reset the countdown if I paste something in or if I drop in an image
 * or upload a file. Just reset the countdown back and then start the countdown again."* The
 * `@`-address pause above already covers the case he checked first; this is the other half of the
 * same complaint. A dictated sentence ends, the clock starts, and he reaches for the keyboard or
 * the mouse to add the thing the message is ABOUT — and the send goes out carrying the words
 * without the attachment, or with half a paste.
 *
 * ── RESET, NOT PAUSE, AND NOT CANCEL — THE THREE DIFFER AND ONLY ONE IS ASKED FOR ──────────────
 * {@link pauseCountdown} freezes and waits for a matching resume, so a gesture with no "end" to it
 * (a paste is over the instant it lands) would wedge the rail with nothing left to un-freeze it.
 * {@link noteSpeechResumed} clears `silenceStartedAt` outright, so nothing but a fresh speech-end
 * could ever count again and the finished sentence would sit in the box forever. He asked for
 * neither: he asked for the clock to *start over*, which is exactly what {@link resumeCountdown}
 * already does on its way out of a pause — this is that re-anchor, reachable on its own.
 *
 * ── AN INSTANT, NOT A STATE, SO IT IS NOT IDEMPOTENT ───────────────────────────────────────────
 * The opposite of `pauseCountdown`'s rule, and deliberately: pasting twice is two gestures and each
 * one is owed its own full threshold. The caller therefore signals it with a monotonic sequence
 * number rather than a boolean (see useAutoSend), because two consecutive pastes must be two
 * signals and an edge on a boolean would collapse them.
 *
 * ── ONLY WHILE A CLOCK IS ACTUALLY RUNNING ─────────────────────────────────────────────────────
 * A no-op while `listening`, and that is the whole safety argument for wiring this to paste. There
 * is no countdown to reset before a speech-end, so this can only ever DELAY a send — it can never
 * start one. Pasting into an idle box does not arm anything.
 *
 * Anchored at {@link clockAt} rather than `now` so a reset landing DURING a pause (paste a URL
 * mid-`@`-address) anchors at the frozen instant instead of handing back the wall-clock time the
 * pause was holding off. The elapsed stays 0 either way, and `resumeCountdown` re-anchors again on
 * the way out, so the two compose rather than fight.
 *
 * The drop-grace goes with it, for the reason `resumeCountdown` states: THRESHOLD_DROP_GRACE_MS
 * buys one visible moment against an elapsed time that no longer exists.
 */
export function restartCountdown(state: AutoSendState, now: number): AutoSendState {
  if (state.phase !== "counting" || state.silenceStartedAt === null) return state;
  return { ...state, silenceStartedAt: clockAt(state, now), fireNoEarlierThan: null };
}

/**
 * The user TYPED into the draft (bead sparkle-wfwypy). Mark it hand-edited — for good, until the
 * message leaves the box.
 *
 * ── WHAT THIS DOES *NOT* DO, AND WHY THAT IS THE POINT ─────────────────────────────────────────
 * It does not pause and it does not re-anchor. Those are {@link pauseCountdown} and
 * {@link resumeCountdown}, driven by the SHARED INTERACTION PREDICATE (voice/composeInteraction),
 * which is what actually freezes the clock while the keys are moving. This records the one thing
 * that outlives the gesture: that the threshold on the way out must be floored, because the speech
 * ladder is no longer judging speech. See {@link TYPED_EDIT_MIN_THRESHOLD_MS}.
 *
 * ── UNCONDITIONAL, UNLIKE ITS NEIGHBOURS ───────────────────────────────────────────────────────
 * `restartCountdown` above is a deliberate no-op while `listening`, because there is no clock to
 * reset and starting one would be a send nobody asked for. This is the opposite: it starts nothing
 * and can only ever LENGTHEN a later countdown, so recording it before the clock exists is both
 * safe and necessary — the user types into an idle box, THEN dictates a tail onto it, and the
 * message that eventually counts down is still one he had his hands in.
 */
export function noteHandEdit(state: AutoSendState): AutoSendState {
  if (state.handEdited) return state;
  return { ...state, handEdited: true };
}

/**
 * How long until the send fires, floored at 0. `Infinity` when nothing is counting.
 *
 * A PURE function of `silenceStartedAt` and the CURRENT tier — which is exactly what "move the
 * threshold, don't reset the clock" means expressed as arithmetic. A rising tier makes this jump
 * FORWARD (that is the point); the fill eases to the new value rather than teleporting (see
 * SendRail).
 */
export function remainingMs(state: AutoSendState, now: number): number {
  if (state.phase !== "counting" || state.silenceStartedAt === null) return Infinity;
  const at = clockAt(state, now);
  const byThreshold = state.silenceStartedAt + thresholdFor(state) - at;
  const byGrace = state.fireNoEarlierThan === null ? -Infinity : state.fireNoEarlierThan - at;
  // The grace window can only DELAY. A drop-guard that had expired must not pull the deadline in
  // ahead of the threshold.
  return Math.max(0, Math.max(byThreshold, byGrace));
}

/**
 * The fraction of the fill still to drain, in [0, 1]. 1 = full (just started), 0 = fired.
 *
 * Denominated in the CURRENT threshold, so a tier change moves the fraction as well as the
 * deadline. Clamped at both ends: an accumulated elapsed already past a newly-lowered threshold
 * would otherwise compute negative, and the rail would draw an inverted bar for the grace window's
 * final 600ms.
 */
export function remainingFraction(state: AutoSendState, now: number): number {
  if (state.phase !== "counting" || state.silenceStartedAt === null) return 1;
  const total = thresholdFor(state);
  if (total <= 0) return 0;
  // Frozen while paused, so the fill visibly STOPS rather than draining behind a countdown that
  // cannot fire — the picture and the deadline are one fact (see SendModeTray).
  const left = Math.max(0, state.silenceStartedAt + total - clockAt(state, now));
  return Math.min(1, left / total);
}

/** What one `evaluate` tick concluded. */
export type AutoSendDecision =
  /** Nothing to do; keep waiting. */
  | { action: "wait"; state: AutoSendState }
  /** SEND NOW, with this text. The state returned is back to `listening`, clocks cleared. */
  | { action: "fire"; state: AutoSendState; text: string }
  /** The countdown went stale (see AUTO_SEND_STALE_MS) and was abandoned WITHOUT sending. */
  | { action: "stale"; state: AutoSendState };

/**
 * Advance the rail to `now` and say what should happen. Pure — the caller owns the actual send.
 *
 * The staleness check comes FIRST and is deliberately not "fire, we're overdue". An overdue
 * countdown is ambiguous between "the deadline just passed" and "this app has been backgrounded
 * for five minutes", and only one of those describes a user who watched a fill drain. Past
 * `AUTO_SEND_STALE_MS` of unadvanced elapsed we disarm the clock and let the next speech-end start
 * a countdown the user is actually present for.
 */
export function evaluate(state: AutoSendState, now: number): AutoSendDecision {
  if (state.phase !== "counting" || state.silenceStartedAt === null) {
    return { action: "wait", state };
  }
  // PAUSED — the user is writing an `@`-address (see `pauseCountdown`). The frozen clock already
  // makes `remainingMs` stand still, so this is belt-and-braces for ONE window the freeze cannot
  // close on its own: the tick runs every AUTO_SEND_TICK_MS, so a deadline can pass in the interval
  // BEFORE the pause is applied and be sitting at zero when the pause arrives. Then the first tick
  // after it would fire on an already-expired clock — a send at the exact moment he reached for the
  // keyboard, which is the report this exists to answer.
  if (state.pausedAt !== null) return { action: "wait", state };
  // NOTHING LEFT TO SEND. `noteSpeechEnd` refuses to start a clock on an empty transcript, but
  // until now nothing enforced that once the clock was already running: the composer being cleared
  // mid-countdown (a store reset, a send from elsewhere, a chunk that trims to whitespace) left
  // `silenceStartedAt` intact — correct, that is what "re-evaluation never touches the clock" means
  // — dropped the tier to `confidence("")`, and then fired `{ text: "" }`, dispatching an EMPTY
  // message to an agent. `noteSpeechResumed` is documented as the caller's escape hatch, but the
  // symmetric guard belongs beside `noteSpeechEnd`'s rather than in every caller.
  if (state.transcript.trim() === "") {
    return {
      action: "wait",
      state: { ...state, phase: "listening", silenceStartedAt: null, fireNoEarlierThan: null },
    };
  }
  if (elapsedMs(state, now) >= AUTO_SEND_STALE_MS) {
    return {
      action: "stale",
      state: { ...state, phase: "listening", silenceStartedAt: null, fireNoEarlierThan: null },
    };
  }
  if (remainingMs(state, now) > 0) return { action: "wait", state };
  return {
    action: "fire",
    text: state.transcript.trim(),
    state: {
      ...state,
      phase: "listening",
      // The message is gone; the box is empty behind it. Both clocks clear, and the tier drops
      // back to what an empty transcript earns so the rail cannot draw a stale label.
      transcript: "",
      tier: confidence(""),
      silenceStartedAt: null,
      fireNoEarlierThan: null,
      // The hand-edited draft left the box with the message. The NEXT one starts purely dictated.
      handEdited: false,
    },
  };
}

/**
 * The countdown reached its deadline with **auto-send OFF**. Stop counting — and send NOTHING.
 *
 * ── "AUTO-SEND OFF" IS NOT "NO COUNTDOWN" ───────────────────────────────────────────────────────
 * This is the whole point of the toggle, and the one thing that would be easy to get backwards.
 * `setArmed(state, false)` also stops a countdown, and reaching for it here would be the obvious
 * implementation — but it means something else entirely: DISARMED is "nothing is watching", the
 * state a tray parked on Send is in. Speak with auto-send off is still watching. The silence
 * countdown still runs, the fill still drains, and it still ENDS the dictated utterance on the same
 * schedule the founder already asked for and had built. What changes is only what happens at the
 * end: the words stay in the composer and wait for a deliberate Send.
 *
 * ── SO THE TRANSCRIPT SURVIVES, AND THAT IS THE DIFFERENCE FROM `evaluate`'s FIRE BRANCH ────────
 * `evaluate` clears `transcript` when it fires, because the message is GONE — the box is empty
 * behind it. Here nothing left the box, so clearing it would make the reducer's own view of what is
 * pending disagree with the textarea the user is looking at. `noteTranscript` only re-syncs when
 * `composedText` CHANGES, so a cleared transcript here would stay wrong for as long as the user did
 * not touch the box — which is exactly the state this path leaves them in.
 *
 * ALIASED to {@link noteSpeechResumed} rather than copied, because state-wise it IS that transition:
 * stop the clock, stay armed, keep the words. The distinct NAME is what earns its keep — it says at
 * the call site which event happened — while a duplicate body would be two things to keep in step
 * for no benefit. If the two ever need to differ, split them then; today claiming they might is
 * speculation that costs a reader a diff to confirm.
 */
export const noteCountdownHeld = noteSpeechResumed;

/**
 * The user pressed Send. Cancel the countdown; the send has already happened by other means.
 *
 * MANUAL SEND ALWAYS OVERRIDES, at any confidence (PRD §4c). No hold, no confirmation, no
 * "the countdown was nearly done anyway" — the button is the user saying the sentence is finished,
 * which is strictly better information than the heuristic has.
 */
export function noteManualSend(state: AutoSendState): AutoSendState {
  if (state.phase === "disarmed") return state;
  return {
    ...state,
    phase: "listening",
    transcript: "",
    tier: confidence(""),
    silenceStartedAt: null,
    fireNoEarlierThan: null,
    handEdited: false,
  };
}

/**
 * The line the host hands to the concierge column's ONE live region via `announce()`.
 *
 * A STRING, not a render — this module owns no DOM and creates no `aria-live` node. See the header.
 * Deliberately carries the TARGET NAME and no digits: the rail shows no numerals in any state, and
 * a spoken "sending in 3" would reintroduce exactly the readout the design removed. What a screen
 * reader user needs here is the same thing a sighted one does — WHERE this is about to go, so a
 * misroute is catchable before it lands.
 */
export type AutoSendEvent =
  /** Speak was selected — a countdown may now run. */
  | "armed"
  /** Silence started accumulating toward a threshold. */
  | "counting"
  /** A message actually left the box. NEVER produced while `willSend` is false. */
  | "fired"
  /** The deadline passed with auto-send OFF: the words are waiting in the composer. */
  | "held"
  /** Speak was left — nothing is counting any more. */
  | "disarmed";

export function autoSendAnnouncement(
  event: AutoSendEvent,
  targetName: string,
  /**
   * Will an expired countdown actually SEND? The Auto-send toggle, threaded in.
   *
   * ── EVERY LINE HERE IS A PROMISE, AND HALF OF THEM WERE FALSE WITH THE TOGGLE OFF ──────────────
   * This defaulted-true parameter is not a convenience: with auto-send off, "Sending to X shortly"
   * and "Auto-send on. Messages will go to X." are both statements that nothing is going to do. The
   * rail announcing a send that never happens is the exact defect this module's `onFire` contract
   * was written to close (see UseAutoSendArgs.onFire — "telling a screen-reader user a message went
   * out when none did is worse than the silent no-op it replaced"), and an auto-send toggle is the
   * most direct way to reintroduce it: the countdown still runs and still ends, so every countdown
   * announcement still fires, and only the send is gone.
   *
   * So the flag reaches the COPY, not just the send. A sighted user can see the composer still
   * holding their words; a screen-reader user has only this line.
   */
  willSend = true,
): string {
  switch (event) {
    case "armed":
      return willSend
        ? `Auto-send on. Messages will go to ${targetName}.`
        : `Speak on, auto-send off. What you say waits in the composer — press Send to send to ${targetName}.`;
    case "counting":
      return willSend
        ? `Sending to ${targetName} shortly. Press Send to go now, or keep talking to wait.`
        : `Wrapping up. What you said stays in the composer — press Send to send to ${targetName}, or keep talking.`;
    case "fired":
      // UNREACHABLE with `willSend` false — the host never calls `onFire` in that case, so there is
      // nothing to announce. Answered anyway, and answered with the HELD line rather than the sent
      // one, so that even a future wiring bug cannot make this function the thing that claims a send
      // that did not happen. Fail closed, exactly as `micIntentForMode` does one module over.
      return willSend ? `Sent to ${targetName}.` : `Ready to send to ${targetName}. Auto-send is off.`;
    case "held":
      return `Ready to send to ${targetName}. Auto-send is off.`;
    case "disarmed":
      // "Auto-send off." would be ambiguous once there are two switches — it is also the name of the
      // toggle's own off position. This event is the MODE leaving Speak, so it says so.
      return willSend ? "Auto-send off." : "Speak off.";
    default: {
      const unhandled: never = event;
      void unhandled;
      return "";
    }
  }
}
