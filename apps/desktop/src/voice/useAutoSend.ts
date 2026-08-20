// The wiring that makes the auto-send rail actually fire (PRD 1 §4).
//
// `autoSendTimer` is a pure reducer and `SendModeTray` is a pure component; between them there was
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
import type { SendTrayModel } from "../components/Concierge/SendModeTray";
import {
  autoSendAnnouncement,
  evaluate,
  initialState,
  noteCountdownHeld,
  noteManualSend,
  noteSpeechEnd,
  noteSpeechResumed,
  noteTranscript,
  noteHandEdit,
  pauseCountdown,
  restartCountdown,
  remainingFraction,
  resumeCountdown,
  elapsedMs,
  setArmed as setArmedState,
  type AutoSendState,
} from "./autoSendTimer";
import { settleThresholdMs } from "./sendMode";
import {
  TYPING_SETTLE_MS,
  interactionInFlight,
  type ComposeInteraction,
} from "./composeInteraction";
import {
  noteManualSendDuringCountdown,
  noteUserSend,
  recordAutoSend,
} from "./autoSendTelemetry";

/**
 * How often a running countdown re-evaluates and repaints.
 *
 * 100ms, not a frame loop. The sweep is a CSS transition between model updates (see SendModeTray), so
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

/**
 * How long a speech-end held for a transcript that has not reached this hook yet stays replayable.
 *
 * A SECOND lag, on a different axis from the one above, and it is what made the FIRST utterance
 * after activation never send while the second one did.
 *
 * The backend emits the transcript and THEN the speech-end, deliberately and on both capture paths
 * (dictation.rs `PartialThenSpeechEnd`), precisely so the rail scores this sentence rather than the
 * previous one. That ordering does not survive the trip in here. `speechEndSeq` is a store field
 * this hook subscribes to directly, so it lands in the very next commit; the words take three more
 * hops — the dictation insert writes ComposeBox's own `text` state, a ComposeBox effect reports it
 * up through `onComposedText`, the host stores it, and only then does it arrive as `composedText`.
 * So the boundary is evaluated a commit or two BEFORE the text it belongs to.
 *
 * `noteSpeechEnd` then correctly refuses to start a clock on an empty transcript — and nothing ever
 * bumps `speechEndSeq` again for that utterance, so the first sentence after the tray is switched to
 * Speak sits in the box forever. The second one worked only by accident: the first sentence's text
 * was still sitting there, so ITS boundary found a non-empty transcript.
 *
 * Bounded for the same reason its sibling is. Unbounded, a boundary whose words never arrived would
 * stay live until something else put text in the box — and the next thing to do that is the user
 * TYPING, which would count down over a draft nobody spoke. Past this window the honest reading is
 * that whatever that speech was, its words are not coming.
 */
export const PENDING_TRANSCRIPT_MAX_LAG_MS = 500;

export interface UseAutoSendArgs {
  /** The arming toggle's state, owned by the caller so it can persist it. */
  armed: boolean;
  /**
   * Does an EXPIRED countdown actually send? The **Auto-send** toggle (uiStore
   * `conciergeSpeakAutoSend`), which the founder asked for as a switch under the Speak tray.
   *
   * ── THIS IS NOT `armed`, AND CONFLATING THEM WOULD BREAK THE COUNTDOWN ──────────────────────────
   * The distinction is the entire feature and it is easy to get backwards, so it is stated here in
   * the terms the founder used. `armed: false` means NOTHING IS WATCHING — no clock, no fill, no
   * end to the utterance; it is what a tray parked on Send is. `autoSend: false` means the opposite
   * of that in every respect except one: the silence countdown STILL RUNS, the fill STILL drains,
   * and it STILL ends the dictated utterance on exactly the schedule it does today — including the
   * "type during the countdown and it pauses, then re-evaluates" behaviour that was built for it.
   * The ONLY thing it removes is the send at the end, so the words sit in the composer waiting for a
   * deliberate press.
   *
   * Wiring this into `armed` would delete the countdown the founder already asked for and had
   * built, and would present as the feature "working" (nothing sends) while a behaviour he
   * specified silently disappeared.
   *
   * DEFAULT TRUE at every layer above this one, because Speak has auto-sent since it shipped:
   * flipping the default would change what an existing user's chosen mode does, with no notice.
   */
  autoSend: boolean;
  /**
   * The CONCIERGE currently owns dictation (`useConciergeDictation().micLive`).
   *
   * Load-bearing, not a nicety — see "whose speech is this" above. Without it the rail counts down
   * on utterances dictated into an agent composer, with a cancel signal that cannot arrive.
   */
  micLive: boolean;
  /** Current compose-box contents — typed OR dictated. See the header: this moves the threshold. */
  composedText: string;
  /**
   * The user is part-way through typing an `@`-address, so the message is NOT finished — freeze the
   * clock (bead sparkle-14dtu).
   *
   * ── WHY THIS CANNOT BE DERIVED FROM `composedText` ───────────────────────────────────────────
   * It depends on the CARET, which only the textarea has: `@Blue` with the caret after it is a
   * mention being typed, and the same string with the caret three words later is not. So the box
   * reports it (ComposeBox's `onMentionComposing`), exactly as it reports its text, and the rule
   * itself is the pure `Concierge/mentions.isComposingMention`.
   *
   * REQUIRED, not optional-defaulting-false, and the difference is this repo's most-repeated
   * failure: an omitted prop makes a feature inert with a fully green suite. There is one caller;
   * making it spell out the answer is cheap, and a `= false` default would let the pause be dropped
   * in a refactor with nothing going red.
   */
  composingMention: boolean;
  /**
   * A native attach picker this composer opened is ON SCREEN — the screenshot crosshairs, or the
   * Finder open panel. Freezes the clock for exactly as long as it is up.
   *
   * ── THE FOUNDER'S REPORT ─────────────────────────────────────────────────────────────────────
   * *"If I click the screenshot or the upload icons, I want you to pause the countdown while those
   * are active … because it means that I'm taking an action, basically."* A dictated sentence ends,
   * the clock starts, and he reaches for the thing the message is ABOUT — and the send goes out
   * carrying the words with no attachment on them.
   *
   * ── A SECOND PAUSE TERM, NOT A WIDER `composingMention` ──────────────────────────────────────
   * The two are separate facts with separate causes, and merging them would mean a bug in either
   * one silently changing the other. They compose through the reducer instead: `pauseCountdown` is
   * idempotent, so an `@`-address typed and abandoned while a picker is open cannot un-pause it.
   *
   * ── WHY THIS AND `draftGrewSeq` ARE BOTH REQUIRED ────────────────────────────────────────────
   * `draftGrewSeq` fires when files LAND and restarts the clock from full — it says nothing during
   * the seconds the panel is open, and nothing at all when the panel is cancelled. This covers the
   * *while*; that covers the *after*. Together: the countdown holds still while he is choosing, and
   * starts over from full once something arrives.
   *
   * REQUIRED, not optional-defaulting-false, for the reason stated on `composingMention` directly
   * above: an omitted prop makes a feature inert with a fully green suite, and there is exactly one
   * caller.
   */
  attachPickerOpen: boolean;
  /**
   * Bumped once per gesture that PUT SOMETHING IN the composer — a paste, a dropped image, a file
   * chosen from the picker. Each bump restarts the countdown from a full threshold (bead
   * sparkle-3kqg2v, `restartCountdown`).
   *
   * ── A SEQUENCE NUMBER, BECAUSE THESE ARE INSTANTS AND NOT A STATE ────────────────────────────
   * `composingMention` above is a condition that is true for a stretch of time, so a boolean is the
   * honest shape for it and both edges mean something. A paste has no duration: it is over the
   * moment it lands, and pasting twice is two gestures each owed its own full threshold. A boolean
   * would collapse the second into the first, which is precisely the founder's complaint arriving
   * one paste later.
   *
   * ── WHY IT CANNOT BE DERIVED FROM `composedText` ─────────────────────────────────────────────
   * Two reasons, and the second is the one that matters. (1) A dropped image or an uploaded file
   * changes no text at all — the draft grew, the string did not — so text is blind to two of the
   * three cases outright. (2) For the paste that DOES change text, the arriving string is
   * indistinguishable from a committed dictation chunk, and those must move the threshold WITHOUT
   * touching the clock (`noteTranscript`, and the module header on why transcription lag must never
   * push the deadline out). The gesture is the fact; the text is a consequence some gestures have.
   *
   * REQUIRED, not optional-defaulting-0, for the reason stated on `composingMention`: an omitted
   * prop makes a feature inert with a fully green suite, and there is exactly one caller.
   */
  draftGrewSeq: number;
  /**
   * The compose window was USED — a keystroke, a caret move, a name picked off the `@`-list. One
   * bump per gesture; `edited` says whether that gesture changed the draft's text.
   *
   * ── THIS IS THE FOUNDER'S ORIGINAL REPORT, AND IT IS THE CLASS FIX ───────────────────────────
   * *"when I start by talking, and then I start typing in the compose window, it's not pausing the
   * auto send … It should pause the auto send and then reevaluate it."* Typing was the one
   * deliberate action the countdown could not see: `composingMention` covers only an unfinished
   * `@`-address, and `draftGrewSeq` covers only a gesture that PUT something in the box. Ordinary
   * characters landed in neither, so the clock ran on underneath him and fired mid-sentence.
   *
   * ── WHY IT DOES NOT REPLACE `composingMention` / `attachPickerOpen` ──────────────────────────
   * Those are STATES with two observable edges; this is a stream of INSTANTS that has to be given a
   * duration ({@link TYPING_SETTLE_MS}). They are different shapes of evidence about the same rule,
   * so they stay separate terms and meet in ONE predicate — voice/composeInteraction's
   * `interactionInFlight` — rather than being OR'd afresh at each call site.
   *
   * ── WHY IT CANNOT BE DERIVED FROM `composedText` ─────────────────────────────────────────────
   * The same reason `draftGrewSeq` cannot, and it is the module header's central rule: a committed
   * dictation chunk changes `composedText` too, and those must move the threshold WITHOUT touching
   * the clock. Text is what some gestures leave behind; the gesture is the fact. A caret move
   * changes no text at all and must still pause.
   *
   * REQUIRED, not optional-defaulting, for the reason stated on `composingMention`: an omitted prop
   * makes a feature inert with a fully green suite, and there is exactly one caller.
   */
  composeInteraction: ComposeInteraction;
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
  autoSend,
  micLive,
  composedText,
  composingMention,
  attachPickerOpen,
  draftGrewSeq,
  composeInteraction,
  interim,
  targetName,
  onFire,
  onAnnounce,
}: UseAutoSendArgs): SendTrayModel {
  const [state, setState] = useState<AutoSendState>(initialState);
  // Repaint clock. Bumped by the tick so `remainingFraction` is recomputed as time passes — the
  // state itself does not change while a countdown merely runs.
  const [, setNow] = useState(0);
  /** Monotonic count of AUTO-SENDS that actually fired — the tray's Speak fill reads this. See the
   *  bump site for why a rendered `remainingFraction === 0` cannot serve. */
  const [firedSeq, setFiredSeq] = useState(0);

  const speechEndSeq = useDictationStore((s) => s.speechEndSeq);
  // THE ON-DEVICE CANCEL. `interim` below is the cloud path's "the user is talking again"; this is
  // the on-device path's, and without it that path could arm a clock that resumed speech was unable
  // to stop (see dictationStore.onDeviceSpeech). Always false while the cloud owns the audio, so
  // the two never both apply.
  const onDeviceSpeech = useDictationStore((s) => s.onDeviceSpeech);

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
  /**
   * The Auto-send toggle, read through a ref for the same reason every other input here is: the
   * tick runs on a plain `setInterval` outside React's render cycle, and `say` is a no-dep callback
   * that effects depend on — closing over the prop would either stale the value or re-subscribe the
   * timer every time the user flipped the switch.
   */
  const autoSendRef = useRef(autoSend);
  autoSendRef.current = autoSend;
  const say = useCallback((event: Parameters<typeof autoSendAnnouncement>[0]) => {
    // THE FLAG REACHES THE COPY, not just the send — see `autoSendAnnouncement`'s `willSend` doc.
    // Every countdown announcement still fires with auto-send off (the countdown still runs), so
    // the announcements are where a phantom "Sent to …" would come back.
    announceRef.current?.(autoSendAnnouncement(event, targetRef.current, autoSendRef.current));
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

  /**
   * A speech-end whose TRANSCRIPT had not reached this hook yet, held rather than thrown away.
   *
   * See {@link PENDING_TRANSCRIPT_MAX_LAG_MS} for the lag this covers and the symptom it caused.
   * Written only by `startClock`, consumed only by the transcript effect (2) — which nulls it
   * BEFORE replaying, exactly as effect (3b) does with its own hold, so a replay the still-talking
   * guard refuses does not leave a latch behind for the next chunk to trip.
   */
  const boundaryAwaitingText = useRef<{ at: number } | null>(null);

  // ── (1) ARM / DISARM ────────────────────────────────────────────────────────────────────────
  // Skips the very first run so merely mounting disarmed does not announce "Auto-send off."
  const armedBefore = useRef<boolean | null>(null);
  useEffect(() => {
    apply(setArmedState(stateRef.current, armed));
    if (!armed) {
      // Disarming clears every clock, and a held boundary is a clock that has not started yet — an
      // armed-later rail starts fresh (see `setArmed`), so it must not inherit one.
      boundaryAwaitingText.current = null;
      resetSample();
    }
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

  // ── (2b) THE USER IS MID-ACTION — freeze the clock ──────────────────────────────────────────
  // The founder's report (sparkle-14dtu) in one effect: a dictated sentence has ended, the clock is
  // draining, and he reaches for the keyboard to say WHO it is for. Until that name is finished the
  // message is not finished, so nothing may go out.
  //
  // TWO TERMS NOW, ONE RULE. The second is an open attach picker — the screenshot crosshairs or the
  // Finder panel — and it is the same principle stated about a different gesture: *"it means that
  // I'm taking an action, basically."* The composer must not fire underneath a user who is mid-
  // action, whether the action is typing an address or picking the file the message is about.
  //
  // OR'd rather than merged into one signal upstream, because they are independent facts that can
  // overlap: clicking Upload does not end a half-typed `@`-address, and finishing the address does
  // not close the panel. `pauseCountdown` is idempotent and `resumeCountdown` runs only on the way
  // out, so whichever term drops first, the clock stays frozen until BOTH are false — and it is one
  // full threshold on the way out either way, never two.
  //
  // DECLARED AFTER (1) AND (2), and `armed` is a dependency of it, both deliberately:
  //   • effects run in declaration order, so in a commit that arms the rail this re-establishes a
  //     pause that `setArmed`'s reset would otherwise have dropped — a mention typed against a tray
  //     parked on Send must still be paused when the tray moves to Speak;
  //   • (2) has already folded the new text into the state, so a pause and the keystroke that
  //     caused it land in the same commit rather than one apart.
  //
  // Both directions run through one effect rather than an edge check, because both reducers are
  // idempotent no-ops when they do not apply — and an edge check is what would leave the composer
  // WEDGED (paused with no way back) the first time a state change slipped past its comparison.
  //
  // THREE TERMS NOW, STILL ONE RULE — and the third is why they moved into a predicate of their own
  // (bead sparkle-wfwypy). Typing is the gesture the founder reported FIRST and the one the
  // countdown could not see: ordinary characters are neither an `@`-address nor something PUT in
  // the box, so they fell through both existing terms and the clock ran on underneath him.
  //
  // The terms are no longer OR'd here. `interactionInFlight` (voice/composeInteraction) owns the
  // rule, and a fourth trigger is a term in THAT file rather than another `||` in this line — which
  // is what stops the list of special cases from growing one report at a time.
  const gestureSeen = useRef(composeInteraction.seq);
  const [lastGestureAt, setLastGestureAt] = useState<number | null>(null);

  // ── (2b-i) A GESTURE LANDED — stamp it, and remember if it CHANGED the draft ─────────────────
  // Guarded on the previous seq, like `draftGrewSeq` below and for the same reason: this is an
  // instant, not a state, so re-running it on an unrelated re-render would hold the pause open
  // forever. The ref starts at the seq the hook mounted with, so a remount is not a fresh gesture.
  //
  // `noteHandEdit` is applied HERE rather than in the predicate effect because it is a fact about
  // the DRAFT that outlives the pause: it floors the threshold on the way out, for every countdown
  // this message ever runs, until the message leaves the box. See TYPED_EDIT_MIN_THRESHOLD_MS.
  useEffect(() => {
    if (composeInteraction.seq === gestureSeen.current) return;
    gestureSeen.current = composeInteraction.seq;
    if (composeInteraction.edited) apply(noteHandEdit(stateRef.current));
    setLastGestureAt(Date.now());
  }, [composeInteraction.seq, composeInteraction.edited, apply]);

  // ── (2b-ii) …AND IT SETTLES ─────────────────────────────────────────────────────────────────
  // The timer is re-armed from scratch on every stamp (the cleanup clears the previous one), so a
  // burst of typing is ONE unbroken pause rather than a strobe — a pause that lifted between two
  // characters would re-anchor the clock on each of them, and `resumeCountdown` grants a FULL fresh
  // threshold every time, so a fast typist would push the deadline out indefinitely.
  useEffect(() => {
    if (lastGestureAt === null) return;
    const t = setTimeout(() => setLastGestureAt(null), TYPING_SETTLE_MS);
    return () => clearTimeout(t);
  }, [lastGestureAt]);

  // ── (2b-iii) THE ONE QUESTION ───────────────────────────────────────────────────────────────
  useEffect(() => {
    const now = Date.now();
    apply(
      interactionInFlight({ composingMention, attachPickerOpen, lastGestureAt }, now)
        ? pauseCountdown(stateRef.current, now)
        : resumeCountdown(stateRef.current, now),
    );
  }, [composingMention, attachPickerOpen, lastGestureAt, armed, apply]);

  // ── (2c) SOMETHING WAS PUT IN THE BOX — start the clock OVER ────────────────────────────────
  // The other half of the founder's countdown complaint (sparkle-3kqg2v): *"reset the countdown if
  // I paste something in or if I drop in an image or upload a file."* Three producers, one signal —
  // ComposeBox's `onPasted` and useConciergeAttachments' `stagedSeq`, summed by the host.
  //
  // DECLARED AFTER (2b) so a reset and the pause state it lands inside settle in that order: a
  // paste made mid-`@`-address anchors at the frozen instant rather than at wall-clock time, which
  // is what `restartCountdown`'s `clockAt` is for.
  //
  // GUARDED ON THE PREVIOUS VALUE rather than run on every commit, because unlike (2b)'s two
  // idempotent reducers this one is deliberately NOT idempotent — re-applying it on an unrelated
  // re-render would hold the deadline out indefinitely, which is a countdown that never fires
  // dressed up as one that does. The ref starts at the seq the hook mounted with, so a host that
  // remounts mid-session does not read its existing count as a fresh gesture.
  const draftGrewBefore = useRef(draftGrewSeq);
  useEffect(() => {
    if (draftGrewSeq === draftGrewBefore.current) return;
    draftGrewBefore.current = draftGrewSeq;
    apply(restartCountdown(stateRef.current, Date.now()));
  }, [draftGrewSeq, apply]);

  // ── (3) SPEECH END — starts the clock, but only for OUR speech ──────────────────────────────
  // Keyed on the sequence number, not a boolean: two consecutive utterances must be two signals,
  // and an edge on a boolean would collapse them. Gated on ownership — see the header.
  /**
   * A speech-end that arrived before ownership did, held rather than thrown away.
   *
   * `micLive = owning && routing`, and `owning` is React state written by a claim effect — so it
   * lags the phase flip by at least a commit plus a passive-effect flush. On the flagship hands-free
   * path (the tray on Speak, "deploy the staging branch" said in one breath) the phase flip and the
   * speech-end for the SAME utterance come from one Deepgram frame pair, so the speech-end can land
   * while `micLive` is still false. Dropping it there is unrecoverable: only a NEW `speechEndSeq` bump can start a
   * clock, so the user's first sentence sits in the box, nothing counts down, and they press Send
   * by hand — the dead-weight outcome the rail exists to remove.
   */
  const deferredSpeechEnd = useRef<{ seq: number; at: number } | null>(null);

  // Read by startClock, which must see the CURRENT value without re-arming on every VAD edge.
  const onDeviceSpeechRef = useRef(onDeviceSpeech);
  onDeviceSpeechRef.current = onDeviceSpeech;

  /**
   * The FULL "they are talking right now" fact — BOTH sources — for the replay in (3c) to read.
   *
   * Assigned from the same expression effect (4) uses, at its one definition below, so the two can
   * never drift apart. Written during render AFTER (3c) is declared, which is fine: (3c) reads it
   * from an effect body, and effects run once the whole render has finished.
   */
  const speakingRef = useRef(false);

  const startClock = useCallback(
    (at: number) => {
      // THE USER IS STILL TALKING — do not arm. The on-device decode runs hundreds of ms behind the
      // audio, so someone who pauses, gets a segment closed, and resumes before the decode lands
      // produces resume-then-arm IN THAT ORDER. Without this guard the clock would start while they
      // are mid-sentence, and the only thing that could stop it is another pause — which is exactly
      // the "fires half a sentence" failure the asymmetric-cost rule in this file exists to avoid.
      //
      // Checked HERE rather than at the listener because this is the one place a clock ever starts,
      // including the deferred replay path below, so no caller can forget it.
      if (onDeviceSpeechRef.current) return;
      const prev = stateRef.current;
      // THE WORDS HAVE NOT ARRIVED YET — hold the boundary rather than dropping it. `noteSpeechEnd`
      // refuses to start a clock on an empty transcript, which is right (there is nothing to send),
      // but the transcript reaches this hook a commit or two behind the boundary that belongs to it
      // — see PENDING_TRANSCRIPT_MAX_LAG_MS. Dropping it here is unrecoverable in exactly the way
      // dropping an unclaimed one is: only a NEW `speechEndSeq` bump can start a clock, and this
      // utterance has already had its only one.
      //
      // Checked in `startClock` rather than at the listener for the same reason the still-talking
      // guard above is: this is the one place a clock ever starts, replay paths included.
      if (prev.phase !== "disarmed" && prev.transcript.trim() === "") {
        boundaryAwaitingText.current = { at };
        return;
      }
      boundaryAwaitingText.current = null;
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
    // A boundary held for words that had not landed IS cleared here, unlike the hold above, and the
    // asymmetry is the point: that one exists to survive precisely this transition (the claim has
    // not arrived yet), this one was recorded while we DID own the mic and has no claim to wait for.
    // Left alive it would arm off whatever text next reaches the box on speech this column is no
    // longer receiving — the hazard the ownership gate exists to close, reopened from a third side.
    boundaryAwaitingText.current = null;
    // Stop counting, without sending: whatever the user is doing now, it is not watching this
    // rail's fill drain.
    if (stateRef.current.phase !== "counting") return;
    apply(noteSpeechResumed(stateRef.current));
    resetSample();
  }, [micLive, speechEndSeq, startClock, apply, resetSample]);

  // ── (3c) THE HELD BOUNDARY'S WORDS ARRIVED ──────────────────────────────────────────────────
  // The other half of the hold above, and the fix for "the first utterance after activation never
  // sends". Declared AFTER (3b) so that in a commit where ownership is lost and text lands at once,
  // the hold is already gone; and after (2), so `stateRef` carries the transcript this replays over.
  useEffect(() => {
    const held = boundaryAwaitingText.current;
    if (held === null) return;
    if (stateRef.current.transcript.trim() === "") return; // still nothing to send
    // Consumed BEFORE the replay, exactly as (3b) consumes its own hold: if the replay is refused —
    // the user is talking again — no latch may survive for the next chunk to trip.
    boundaryAwaitingText.current = null;
    if (Date.now() - held.at > PENDING_TRANSCRIPT_MAX_LAG_MS) return;
    // THEY ARE TALKING RIGHT NOW — the boundary is refuted, drop it. `startClock` makes this check
    // too, but against the ON-DEVICE source alone, and that is not enough HERE. On the cloud path
    // `interim` carries the fact instead, and effect (4) cannot clean up afterwards: its dependency
    // is the `speaking` BOOLEAN, so once it is already true it does not re-run when a clock starts
    // underneath it. The countdown would then be unstoppable — `noteTranscript` deliberately never
    // touches the clock, and the next real speech-end hits `noteSpeechEnd`'s idempotence branch —
    // and three seconds later it dispatches the previous sentence plus a fragment of this one.
    //
    // Checked HERE and not inside `startClock` on purpose. This is the one caller replaying a
    // boundary that is STALE BY CONSTRUCTION, which is what opens the window for a NEW utterance's
    // interim to appear in. Evidence that the user is speaking now refutes a stale boundary; it does
    // not refute a live one, where a lagging interim from the just-ended utterance is the likelier
    // reading (see the module header's residual race) and refusing would lose the send outright.
    if (speakingRef.current) return;
    // Anchored at the REAL speech end. Re-anchoring at the moment the words showed up would hand
    // back the propagation time, so the user waits out a longer silence than their tier promises.
    startClock(held.at);
  }, [composedText, startClock]);

  // ── (4) INTERIM / ON-DEVICE VAD — the user is talking again; stop counting without sending ──
  // Two sources for ONE fact, because the two capture engines report it differently and neither can
  // speak for the other: the cloud path streams `interim` results, the on-device path decodes whole
  // closed segments and has none, so it reports the VAD level instead. Exactly one is ever live —
  // Rust pins the on-device level false whenever the cloud owns the audio — so OR-ing them cannot
  // double-count, and "keep talking and it waits" now holds on both paths rather than just one.
  const speaking = interim.trim().length > 0 || onDeviceSpeech;
  speakingRef.current = speaking; // the replay in (3c) needs this fact too — see that ref's doc
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
        // ── AUTO-SEND OFF: THE COUNTDOWN RAN, THE UTTERANCE ENDED, NOTHING IS SENT ───────────────
        // Everything up to this line is identical to the auto-sending path — the clock started on
        // the speech-end, accumulated silence against a moving threshold, honoured the type-during-
        // the-countdown grace, and reached its deadline. This branch takes away ONLY the dispatch.
        //
        // FOUR THINGS ARE DELIBERATELY SKIPPED, and each of them would be a lie on its own:
        //   • `onFire` — nothing may leave the box;
        //   • `say("fired")` — the rail must never announce a send that did not happen. That is the
        //     defect this hook's `onFire` contract already exists to prevent, and an auto-send
        //     toggle is the most direct way to reintroduce it, so `say("held")` says the true thing
        //     instead: the words are waiting;
        //   • `setFiredSeq` — the tray's Speak pill flashes green on that counter, and a flash with
        //     no send is the same lie in paint (roborev 57314/57330 pinned the two together);
        //   • `recordAutoSend` — a sample for a send that never went does not merely miscount, it
        //     TRAINS the thresholds.
        //
        // `noteCountdownHeld` rather than `decision.state`: the fire branch clears the transcript
        // because the message is gone, and here it is still in the composer. See that reducer.
        if (!autoSendRef.current) {
          apply(noteCountdownHeld(s));
          resetSample();
          say("held");
          return;
        }
        const sample = {
          tier: s.tier,
          thresholdMs: settleThresholdMs(s.tier, s.handEdited),
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
          // THE FIRE EVENT, published as a counter — the tray's Speak fill reads this (roborev
          // 57314). INSIDE the confirmed-dispatch guard, with the announcement it visually
          // duplicates (roborev 57330): it was briefly bumped above this branch, so a fire that
          // sent NOTHING — compose box unmounted behind an AI lock, or an empty box early-returning
          // — still painted the pill green for ACTING_FLASH_MS while the screen-reader user was
          // correctly told nothing at all. One event, one guard, or the two surfaces disagree.
          setFiredSeq((n) => n + 1);
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
    firedSeq,
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
