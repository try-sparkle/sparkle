// The wiring that makes the auto-send rail actually fire (PRD 1 §4).
//
// `autoSendTimer` is a pure reducer and `SendRail` is a pure component; between them there was
// nothing. This hook is that middle: it owns the state, feeds the reducer the facts it needs, ticks
// it, performs the send, and hands the rail its model.
//
// # The four inputs, and why each is separate
//
//   1. OWNERSHIP  — does the CONCIERGE own the mic right now. Gates everything below; see the
//      "whose speech is this" section, which is the subtlest part of this file.
//   2. TRANSCRIPT — every change to the compose box, typed or dictated. Moves the THRESHOLD.
//   3. SPEECH END — `dictationStore.speechEndSeq`, bumped when the engine says the speaker stopped.
//      STARTS the clock. A real endpointing signal off Deepgram (`speech_final` / `UtteranceEnd`),
//      not "the transcript stopped changing" — transcription lag would make the latter fire while
//      the user was still talking, which is the failure §4 names explicitly.
//   4. INTERIM    — the live, uncommitted preview. Its arrival means the user is speaking AGAIN,
//      which stops the countdown without sending.
//
// Keeping (3) and (4) separate is what makes "keep talking and it waits" work. A committed segment
// landing mid-countdown is lag, not speech, so it must move the threshold without touching the
// clock — see `noteTranscript`, the one reducer function that would be wrong in the obvious
// implementation.
//
// # WHOSE SPEECH IS THIS — the asymmetry that made this dangerous
//
// `speechEndSeq` is GLOBAL. `useDictation` bumps it for every utterance in the focused window,
// whichever surface owns the mic. The cancel signal is not global in the same way:
// `useConciergeDictation` returns `interim: micLive ? rawInterim : ""`, so while an AGENT composer
// owns dictation the concierge's interim is permanently `""`.
//
// Wire those two together naively and the rail counts down on speech it is not receiving, with a
// cancel that can never arrive: the user dictates into an agent composer, and three seconds later
// an unrelated half-finished draft sitting in the concierge box is dispatched to an agent while
// they are looking at a different column. Irreversible, and invisible until it happens.
//
// So ownership gates the clock. A speech-end that arrives while the concierge does not own the mic
// is somebody else's utterance and is ignored, and LOSING ownership mid-countdown stops the
// countdown rather than letting it run to a send nobody was watching.
//
// # Why the host owns this and not ComposeBox
//
// `components/Concierge/` is presentational by contract: it reads no stores and takes its state as
// props. The rail's model is state, so it is built out here and passed in.
import { useCallback, useEffect, useRef, useState } from "react";

import { useDictationStore } from "../stores/dictationStore";
import type { SendRailModel } from "../components/Concierge/SendRail";
import {
  autoSendAnnouncement,
  evaluate,
  initialState,
  noteManualSend,
  noteSpeechEnd,
  noteSpeechResumed,
  noteTranscript,
  remainingFraction,
  elapsedMs,
  setArmed as setArmedState,
  type AutoSendState,
} from "./autoSendTimer";
import { thresholdMs } from "./confidence";
import {
  noteManualSendDuringCountdown,
  noteUserSend,
  recordAutoSend,
} from "./autoSendTelemetry";

/**
 * How often a running countdown re-evaluates and repaints.
 *
 * 100ms, not a frame loop. The fill is a CSS transition between model updates (see SendRail), so
 * this only has to be often enough that the transition targets stay smooth and that a threshold the
 * elapsed time has just passed is honoured promptly. A rAF loop would repaint 10× as often to move
 * the same bar and would keep a timer alive on a column that is idle most of the time.
 */
export const AUTO_SEND_TICK_MS = 100;

/**
 * How long a speech-end held for a late ownership claim stays replayable.
 *
 * The deferral exists for exactly ONE lag: `micLive` is React state written by a claim effect, so it
 * trails the speech-end by a commit plus a passive-effect flush. That is single-digit milliseconds
 * in practice and a few hundred under load — never seconds, and never a user gesture away.
 *
 * The bound is what keeps the deferral from reopening the hazard the ownership gate closes. Because
 * `speechEndSeq` is global, every utterance dictated into an agent composer records a hold here too;
 * on sequence alone that hold stays valid until somebody speaks again, so the next claim of the mic
 * by this column — a re-target minutes later — would replay it and count down against an unrelated
 * draft. Bounded on age, a hold that old is simply discarded, which is the honest reading: whatever
 * that speech was, it was not this column's.
 */
export const DEFERRED_SPEECH_END_MAX_LAG_MS = 500;

export interface UseAutoSendArgs {
  /** The arming toggle's state, owned by the caller so it can persist it. */
  armed: boolean;
  /**
   * The CONCIERGE currently owns dictation (`useConciergeDictation().micLive`).
   *
   * Load-bearing, not a nicety — see "whose speech is this" above. Without it the rail counts down
   * on utterances dictated into an agent composer, with a cancel signal that cannot arrive.
   */
  micLive: boolean;
  /** Current compose-box contents — typed OR dictated. See the header: this moves the threshold. */
  composedText: string;
  /** Live uncommitted transcript; non-empty means the user is speaking into THIS box right now. */
  interim: string;
  /** Who this send would reach. The rail's only label, and the mis-route safety net. */
  targetName: string;
  /**
   * Perform the send. Called when the countdown expires.
   *
   * MUST report whether a message left the compose box. Returning `void` made "I called it" mean
   * "it sent", which is false in two ways this can see: the box is unmounted behind an AI lock so
   * no submit is registered, and `submit()` early-returns on an empty box. On a false return the
   * rail must NOT announce "Sent to …" — telling a screen-reader user a message went out when none
   * did is worse than the silent no-op it replaced — and must NOT record a tuning sample, since a
   * phantom sample does not merely miscount, it trains the thresholds.
   *
   * DISPATCH, NOT DELIVERY, and deliberately so. A send that fails asynchronously restores the
   * draft, and no synchronous return can know that yet; waiting for it would hold the announcement
   * behind a network round-trip on the one path whose whole point is that it is hands-free. `true`
   * therefore means the words left the box — which is what the rail is telling the user about.
   */
  onFire: () => boolean;
  /**
   * Speak a line through the column's ONE `role="status"` region.
   *
   * The rail draws a draining fill that is `aria-hidden` and a toggle whose accessible name never
   * changes, so without this the entire feature is silent to a screen reader: nothing says a
   * countdown started, nothing says a message went, and the target name — the documented
   * mis-route safety net — is never announced at all.
   */
  onAnnounce?: (message: string) => void;
}

/** Builds the rail's model and drives the timer. */
export function useAutoSend({
  armed,
  micLive,
  composedText,
  interim,
  targetName,
  onFire,
  onAnnounce,
}: UseAutoSendArgs): SendRailModel {
  const [state, setState] = useState<AutoSendState>(initialState);
  // Repaint clock. Bumped by the tick so `remainingFraction` is recomputed as time passes — the
  // state itself does not change while a countdown merely runs.
  const [, setNow] = useState(0);

  const speechEndSeq = useDictationStore((s) => s.speechEndSeq);

  /**
   * The authoritative copy of the state.
   *
   * Everything reads and writes through `apply` below rather than through a functional `setState`
   * updater. React may DISCARD and re-run a render (an interrupted concurrent render, a Suspense
   * retry, StrictMode), which re-invokes updaters — so an updater that performs a send would
   * dispatch the same dictated instruction twice. Updaters here stay out of it entirely: the
   * decision is computed against this ref, the effects run once, and `setState` only ever receives
   * a finished value.
   */
  const stateRef = useRef(state);
  const apply = useCallback((next: AutoSendState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  // Handlers are called from timers and effects that must not re-subscribe when the caller passes a
  // fresh closure, which it does on every render of the host.
  const onFireRef = useRef(onFire);
  onFireRef.current = onFire;
  const announceRef = useRef(onAnnounce);
  announceRef.current = onAnnounce;
  const targetRef = useRef(targetName);
  targetRef.current = targetName;
  const say = useCallback((event: Parameters<typeof autoSendAnnouncement>[0]) => {
    announceRef.current?.(autoSendAnnouncement(event, targetRef.current));
  }, []);

  /**
   * Telemetry facts the reducer deliberately does not carry.
   *
   * Its state is what the rail DRAWS; these are what the rail DID. Keeping them out of
   * `AutoSendState` keeps that module pure and its tests about one thing.
   */
  const reeval = useRef({ sawReeval: false, keptTalking: false, graceApplied: false });
  const resetSample = useCallback(() => {
    reeval.current = { sawReeval: false, keptTalking: false, graceApplied: false };
  }, []);

  // ── (1) ARM / DISARM ────────────────────────────────────────────────────────────────────────
  // Skips the very first run so merely mounting disarmed does not announce "Auto-send off."
  const armedBefore = useRef<boolean | null>(null);
  useEffect(() => {
    apply(setArmedState(stateRef.current, armed));
    if (!armed) resetSample();
    if (armedBefore.current !== null && armedBefore.current !== armed) {
      say(armed ? "armed" : "disarmed");
    }
    armedBefore.current = armed;
  }, [armed, apply, resetSample, say]);

  // ── (2) TRANSCRIPT — moves the threshold, never the clock ───────────────────────────────────
  useEffect(() => {
    const prev = stateRef.current;
    const next = noteTranscript(prev, composedText, Date.now());
    // Only a re-evaluation during a LIVE countdown is worth recording: it is the one that moved a
    // deadline the user was watching.
    if (prev.phase === "counting") reeval.current.sawReeval = true;
    if (next.fireNoEarlierThan !== null && prev.fireNoEarlierThan === null) {
      reeval.current.graceApplied = true;
    }
    apply(next);
  }, [composedText, apply]);

  // ── (3) SPEECH END — starts the clock, but only for OUR speech ──────────────────────────────
  // Keyed on the sequence number, not a boolean: two consecutive utterances must be two signals,
  // and an edge on a boolean would collapse them. Gated on ownership — see the header.
  /**
   * A speech-end that arrived before ownership did, held rather than thrown away.
   *
   * `micLive = owning && routing`, and `owning` is React state written by a claim effect — so it
   * lags the phase flip by at least a commit plus a passive-effect flush. On the flagship hands-free
   * path ("Hey Sparkle, deploy the staging branch") the wake word and the speech-end for the SAME
   * utterance come from one Deepgram frame pair, so the speech-end can land while `micLive` is
   * still false. Dropping it there is unrecoverable: only a NEW `speechEndSeq` bump can start a
   * clock, so the user's first sentence sits in the box, nothing counts down, and they press Send
   * by hand — the dead-weight outcome the rail exists to remove.
   */
  const deferredSpeechEnd = useRef<{ seq: number; at: number } | null>(null);

  const startClock = useCallback(
    (at: number) => {
      const prev = stateRef.current;
      const next = noteSpeechEnd(prev, at);
      apply(next);
      if (prev.phase !== "counting" && next.phase === "counting") say("counting");
    },
    [apply, say],
  );

  useEffect(() => {
    if (speechEndSeq === 0) return;
    if (!micLive) {
      // Somebody else's utterance — OR ours, arriving a beat before the claim lands. Held for the
      // ownership effect to replay; it cannot be told apart here, and holding is the safe reading.
      // The INSTANT is recorded with it: the replay is bounded on age, and it re-anchors the clock
      // at the real speech end rather than at whenever ownership got around to arriving.
      deferredSpeechEnd.current = { seq: speechEndSeq, at: Date.now() };
      return;
    }
    deferredSpeechEnd.current = null;
    startClock(Date.now());
    // `micLive` is deliberately NOT a dependency: this must run when a NEW speech-end arrives, not
    // when ownership changes. Ownership changing is handled by its own effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [speechEndSeq, startClock]);

  // ── (3b) OWNERSHIP CHANGES ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (micLive) {
      // Ownership arrived. Replay a speech-end we held, but only if BOTH still hold:
      //
      //  • it is still the NEWEST one — an older seq means another utterance has happened since;
      //  • it is young enough to BE the claim lag it exists for (see the constant).
      //
      // The age bound is the load-bearing half. `speechEndSeq` is global, so an utterance dictated
      // into an AGENT composer records a deferral here too; on seq alone that deferral stays valid
      // for as long as nobody speaks again, and the next time the concierge becomes `micLive` — the
      // user re-targets the column minutes later — it would start a countdown against whatever
      // draft is sitting in the box and dispatch it on speech this column never received. That is
      // the hazard the ownership gate exists to close, reopened from the other side.
      const held = deferredSpeechEnd.current;
      deferredSpeechEnd.current = null;
      if (held && held.seq === speechEndSeq && Date.now() - held.at <= DEFERRED_SPEECH_END_MAX_LAG_MS) {
        // Anchored at the REAL speech end. Re-anchoring at the claim would silently hand back the
        // time the claim took, so the user waits out a longer silence than the tier promises.
        startClock(held.at);
      }
      return;
    }
    // The mic is elsewhere. NOTHING is cleared here, deliberately: this effect also runs when a new
    // speech-end arrives while the mic is already elsewhere, and effect (3) has just recorded that
    // hold one line earlier — clearing here would delete the very hold that path exists to create,
    // and with it the flagship "Hey Sparkle, …" case where the speech-end beats the claim. A stale
    // hold cannot survive anyway: the claim branch above clears unconditionally, whether or not it
    // replays, and the age bound decides which of those two it does.
    //
    // Stop counting, without sending: whatever the user is doing now, it is not watching this
    // rail's fill drain.
    if (stateRef.current.phase !== "counting") return;
    apply(noteSpeechResumed(stateRef.current));
    resetSample();
  }, [micLive, speechEndSeq, startClock, apply, resetSample]);

  // ── (4) INTERIM — the user is talking again; stop counting without sending ──────────────────
  const speaking = interim.trim().length > 0;
  useEffect(() => {
    if (!speaking) return;
    const prev = stateRef.current;
    if (prev.phase === "counting" && reeval.current.sawReeval) reeval.current.keptTalking = true;
    apply(noteSpeechResumed(prev));
  }, [speaking, apply]);

  // ── THE TICK ────────────────────────────────────────────────────────────────────────────────
  // Every side effect happens HERE, in the interval callback, never inside a state updater.
  useEffect(() => {
    if (state.phase !== "counting") return;
    const id = setInterval(() => {
      const now = Date.now();
      const s = stateRef.current;
      const decision = evaluate(s, now);

      if (decision.action === "fire") {
        const sample = {
          tier: s.tier,
          thresholdMs: thresholdMs(s.tier),
          elapsedSilenceMs: elapsedMs(s, now),
          keptTalkingAfterReeval: reeval.current.keptTalking,
          graceApplied: reeval.current.graceApplied,
          transcript: decision.text,
        };
        apply(decision.state);
        resetSample();
        // ONLY on a confirmed dispatch. See UseAutoSendArgs.onFire: a false return means nothing
        // was sent, and both the announcement and the tuning sample would then be lies — one to a
        // screen-reader user, one to the corpus that tunes the thresholds.
        if (onFireRef.current()) {
          recordAutoSend(sample);
          say("fired");
        }
        return;
      }
      if (decision.action === "stale") {
        apply(decision.state);
        resetSample();
        return;
      }
      setNow(now); // repaint only — the fill has moved, the state has not
    }, AUTO_SEND_TICK_MS);
    return () => clearInterval(id);
  }, [state.phase, apply, resetSample, say]);

  // ── MANUAL SEND ─────────────────────────────────────────────────────────────────────────────
  useManualSendBridge(apply, stateRef, resetSample);

  return {
    phase: state.phase,
    targetName,
    tier: state.tier,
    remainingFraction: remainingFraction(state, Date.now()),
  };
}

/**
 * Registers the app-wide "the user pressed Send" hook.
 *
 * MANUAL SEND ALWAYS OVERRIDES (PRD §4c). A press is strictly better information than the heuristic
 * has, so it cancels rather than shortening — and it is recorded, because a user who repeatedly
 * refuses to wait is telling us the thresholds are too long.
 */
function useManualSendBridge(
  apply: (next: AutoSendState) => void,
  stateRef: React.MutableRefObject<AutoSendState>,
  resetSample: () => void,
): void {
  const onManual = useCallback(() => {
    const s = stateRef.current;
    if (s.phase === "counting") {
      noteManualSendDuringCountdown(s.tier, elapsedMs(s, Date.now()));
    }
    // Closes an open correction window: a send by hand right after an auto-send is the clearest
    // evidence the auto-send went early.
    noteUserSend();
    apply(noteManualSend(s));
    resetSample();
  }, [apply, stateRef, resetSample]);

  useEffect(() => {
    registerManualSend(onManual);
    return () => registerManualSend(null);
  }, [onManual]);
}

/**
 * The single manual-send listener.
 *
 * A module-level slot rather than a store: there is exactly one concierge composer, the rail lives
 * beside it, and a store would invite a second subscriber whose cancel would race this one.
 */
let manualSendListener: (() => void) | null = null;

function registerManualSend(fn: (() => void) | null): void {
  manualSendListener = fn;
}

/** Called by the composer when the user presses Send (or ⌘↩). Safe when nothing is armed. */
export function notifyManualSend(): void {
  manualSendListener?.();
}
