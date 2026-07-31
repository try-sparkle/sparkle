// The send tray's STATE — the one place the tray position, the microphone and the push-to-talk
// gesture are held together.
//
// WHY THEY HAVE TO BE ONE THING. Before this, "is a countdown armed?" lived in uiStore and "is the
// mic on?" lived in dictationStore, and nothing reconciled them: you could arm auto-send with the
// microphone released and get a control promising to send when you stopped talking, over a mic that
// was never going to hear you. The tray's position is now the single answer — picking a position
// drives the SHIPPED mic actions (components/MicButton `useMicActions`), so the tray and the mic
// glyph cannot say different things about the same microphone.
//
// THE PURE RULES ARE NOT HERE. Which mic each mode implies, which mode counts down, the sweep
// floor, the chords and the inert test all live in ./sendMode, unit-tested without React. This hook
// is only the wiring: store reads, the mic calls, and the hold gesture's lifecycle.

import { useCallback, useEffect, useRef } from "react";

import { useUiStore } from "../stores/uiStore";
import { useDictationStore } from "../stores/dictationStore";
import { useMicActions } from "../components/MicButton";
import { micIntentForMode, pttHeldIntent, trayInert, type SendMode } from "./sendMode";
import { usePushToTalk } from "./usePushToTalk";
import type { MicIntent } from "../components/MicButton";

/**
 * The longest a push-to-talk release will wait for the utterance it captured to finish arriving
 * before sending whatever is in the box.
 *
 * A BACKSTOP, not a policy — see `endHold`. The wait ends the instant the engine closes the
 * utterance, so this number is only ever reached when that close never arrives at all (a dropped
 * socket, a capture torn down mid-utterance). 1.5s is long enough to cover a normal commit's tail
 * and short enough that a user who hit the failure case is not left staring at a composer that
 * appears to have ignored them.
 *
 * IT IS ALSO NEVER REACHED BY A HOLD THAT CAPTURED NOTHING. A silent hold has no utterance to wait
 * for, so it does not enter the wait at all — see `endHold`'s pending test. That matters because a
 * hold whose only content is TYPED text is a first-class case here, not an edge one, and making it
 * sit out a cap would make the send feel broken.
 */
export const PARTIAL_SETTLE_CAP_MS = 1_500;

export interface UseSendModeArgs {
  /**
   * Send whatever is in the box. Returns whether anything actually went out.
   *
   * Called on a push-to-talk RELEASE — and on nothing else here, because every other way of
   * sending is a press the tray reports directly to its host.
   *
   * A RELEASE IS A SEND, FULL STOP — not "a send that happens when there is a transcript". The
   * gesture means *send this message*, and what the message is made of (spoken, typed, or both) is
   * the composer's business, not this hook's. So this is called on every clean release, including
   * one that captured no speech at all.
   */
  onSend: () => boolean;
}

export interface SendModeController {
  /** Where the tray is parked. */
  mode: SendMode;
  /** Move the tray, driving the microphone with it. */
  setMode: (next: SendMode) => void;
  /** A live PTY owns the keyboard: the tray is not being addressed (./sendMode `trayInert`). */
  inert: boolean;
  /** Is the auto-send countdown allowed to run at all right now? Speak, and not inert. */
  armed: boolean;
}

export function useSendMode({ onSend }: UseSendModeArgs): SendModeController {
  const mode = useUiStore((s) => s.conciergeSendMode);
  const setStoredMode = useUiStore((s) => s.setConciergeSendMode);
  // The store's MIRROR of the focus owner, not a live DOM read. That is the right choice for paint
  // (it is what re-renders the tray when the caret moves) and the wrong one for routing, which is
  // why voice/dictationFocus keeps `focusOwnerNow` separate — see its doc.
  const focusOwner = useDictationStore((s) => s.focusOwner);
  const inert = trayInert(focusOwner);

  const { setActive, setMuted, setOff } = useMicActions();
  // Held through a ref so the effects below do not re-run every time useMicActions mints fresh
  // closures — a re-run mid-hold would re-issue the mic call and fight the gesture.
  const mic = useRef({ setActive, setMuted, setOff });
  mic.current = { setActive, setMuted, setOff };

  const applyIntent = useCallback((intent: MicIntent) => {
    // The tray belongs to the CONCIERGE box, so operating it points dictation at that box and keeps
    // it there. Without this claim the agent composer's own mic arbitration takes the transcript
    // off a surface the user just deliberately armed (dictationStore.voiceSurface).
    useDictationStore.getState().setVoiceSurface("concierge");
    if (intent === "off") mic.current.setOff();
    else if (intent === "paused") mic.current.setMuted();
    else mic.current.setActive();
  }, []);

  const setMode = useCallback(
    (next: SendMode) => {
      setStoredMode(next);
      applyIntent(micIntentForMode(next));
    },
    [setStoredMode, applyIntent],
  );

  // ── RECONCILING A RESTORED POSITION WITH A MICROPHONE NOBODY TOLD US ABOUT ──────────────────
  //
  // A mode restored from the persisted blob was never PICKED this session, so nothing ran the mic
  // call for it — the tray would come back reading "Speak" over a released microphone, which is the
  // two-controls-disagreeing failure this hook exists to delete. So it reconciles on mount, and
  // again whenever the mode changes from anywhere else (another window syncs uiStore too).
  //
  // WITH ONE EXCEPTION, and it is the only asymmetry here. `send` is the DEFAULT position — the one
  // nobody chose — and its mic call RELEASES the microphone. The mic is also armable from surfaces
  // this tray knows nothing about (the header ring, the voice menu, another window, a persisted
  // `enabled: true`), so an unconditional reconcile would have the concierge mounting quietly switch
  // off a microphone the user had just turned on somewhere else. Releasing is the one direction that
  // destroys state set elsewhere, so in exactly that case the reconcile STANDS DOWN: it neither
  // releases the mic nor rewrites the mode.
  //
  // IT DOES NOT "ADOPT" A POSITION EITHER, and that is a correction rather than an omission. An
  // earlier version moved the tray to `speak` when it found the mic live — which quietly promoted
  // "the user armed the mic in the header" into "the user consented to auto-send", the one position
  // that dispatches irreversible instructions on its own. uiStore's own contract says that has to be
  // switched on deliberately, once, by the user; a remount is not that. Moving to `ptt` instead is
  // no better, because the tray's mode setter DRIVES the mic, so it would demote a `listening` mic
  // to `muted` — the same clobber, gentler.
  //
  // So the tray reads `Send` while a mic armed elsewhere stays on. That is a true statement about
  // the thing the tray governs — how THIS box sends — and nothing irreversible follows from it: no
  // countdown runs outside `speak`. The mic's own state is stated where it is set, by the mic glyph.
  //
  // Every other combination imposes, which is the intended direction — a position someone (or the
  // v3 migration) deliberately chose should arm the mic it names.
  // ── A TERMINAL PAUSES SPEAK, EXACTLY AS IT ALREADY PAUSES PUSH TO TALK ────────────────────────
  //
  // THE BUG, and it is not the one it looks like. The founder reported: "when I am in push to talk
  // mode and I go into terminal, that works correctly — it turns the microphone off. But when it's
  // in speak mode, it doesn't do that." The obvious reading is that the focus gate is wired into one
  // path and not the other. It is not — both read the same `focusOwner`. What differs is `phase`:
  //
  //   Push to talk at rest -> `micIntentForMode` = "paused" -> phase PASSIVE -> the wake gate in
  //     `terminalRoutingArmed` (voice/dictationFocus) is false -> `dictationPauseReason` returns
  //     "terminal" -> capture pauses. Correct, and by accident of the resting intent.
  //   Speak -> "active" -> phase ACTIVE -> the wake gate PASSES -> the terminal stops being a pause
  //     and becomes a DESTINATION: `isTerminalRoutable()` is true and dictated speech is typed
  //     straight into the focused agent's PTY (useDictation's `dictation://partial` handler).
  //
  // So Speak did not "keep listening" by omission — it was routing the user's voice into an agent's
  // command line while they typed there. That is strictly worse than a hot mic: with the countdown
  // armed it can also dispatch text the user never addressed to anyone.
  //
  // Dropping to the PAUSED intent while inert closes it at the one term both gates read. It is a
  // demotion of `phase`, not of `enabled`, which matters: the mic stays ARMED, so leaving the
  // terminal costs a resume rather than a re-arm, and the tray's position is never rewritten
  // underneath the user. `armedStatus` then reports `idle`, so every surface draws the honest
  // not-capturing state instead of an invitation to speak.
  //
  // ONLY POSITIONS WHOSE RESTING INTENT IS A LIVE MIC ARE DEMOTED — `resting !== "off"`.
  //
  // An earlier version of this wrote `inert ? "paused" : micIntentForMode(mode)` and claimed in a
  // comment that it no-opped for Send. It did the opposite (roborev 56315, High). `"paused"` is not
  // a weaker "off": `applyIntent("paused")` calls `setMuted`, and `setMuted` is an ARM —
  // `setEnabled(true); setPhase("passive")` (components/MicButton). So with the tray at Send and the
  // microphone released, moving the caret into a terminal TURNED THE MIC ON. It did not repair
  // itself either: leaving the terminal re-ran with `intent === "off"` and `enabled` now true, so
  // the stand-down guard below returned and left the mic armed and wake-word listening indefinitely
  // under a tray reading "Send" — with the indicator painting it grey "Microphone: off" the whole
  // time, which is the exact two-controls-disagreeing state this hook exists to delete. It also
  // fired the out-of-credits notice at anyone who merely clicked into a terminal, and stole
  // `voiceSurface` from a mic armed in the header or another window.
  //
  // Keying on the RESTING intent keeps Send on the "off" branch, where the stand-down guard can do
  // its job, while still demoting the one position that is actually live.
  useEffect(() => {
    const resting = micIntentForMode(mode);
    const intent = inert && resting !== "off" ? "paused" : resting;
    if (intent === "off" && useDictationStore.getState().enabled) return;
    applyIntent(intent);
    // `inert` IS a dependency now. Without it this effect only re-ran when the tray moved, so the
    // caret entering or leaving a terminal changed nothing — which is precisely why Speak stayed
    // routing into the PTY.
  }, [mode, inert, applyIntent]);

  const onSendRef = useRef(onSend);
  onSendRef.current = onSend;

  // A release that is waiting on an in-flight partial, so a second gesture (or an unmount) can call
  // it off rather than leaving a send armed against a hold that no longer exists.
  const settling = useRef<(() => void) | null>(null);

  // ── THE HOLD'S UTTERANCE WATCH — "how many captured runs still owe a transcript?" ──────────────
  //
  // Live for the whole gesture, because `endHold` has to answer that in the keyup's own tick and
  // nothing readable at that instant answers it on its own.
  //
  // A COUNT, NOT A FLAG — a single boolean debt cannot represent more than one outstanding run, and
  // the on-device path can genuinely owe two: Whisper's decode runs "hundreds of ms behind the audio"
  // (dictationStore.onDeviceSpeech), so "restart the server" <VAD closes, quiet> "now" <VAD closes
  // again, quiet> can both be fully CAPTURED, with NEITHER transcript decoded yet, before the key is
  // released. A single flag confirmed by the first segment's bump-while-quiet would discard the
  // second — still-queued — segment outright.
  //
  // `owed` counts RUNS: incremented on a genuine QUIET→NOISY transition (`wasQuiet && nowNoisy`,
  // computed from the store's own before/after, not a re-read of an unchanged level), decremented by
  // exactly one per confirmed close. A close (`speechEndSeq` bump) confirms immediately if the room
  // is quiet in that same event; if it lands while still noisy — one clause of several within a
  // single continuous run, or the cloud race below — the confirmation is DEFERRED (`deferred`) until
  // whatever LATER event first finds the room quiet, which then discharges every deferred close at
  // once (a run that has gone fully quiet has, by construction, had every one of its clauses commit).
  //
  // NEITHER COUNTER MOVES ON A RE-OBSERVATION OF STATE THAT DID NOT CHANGE, and that is what makes
  // this survive `dictation://level`: it is forwarded to `setLevel` roughly 25×/sec for the whole
  // capturing window (LEVEL_EMIT_INTERVAL = 40ms, dictation.rs), and this subscriber runs on EVERY
  // store update, not just the fields it cares about. An earlier version reset a "close is still
  // awaiting quiet" flag on any tick where `speaking` READ true — which included every level tick
  // during ordinary ongoing speech, destroying the deferred confirmation within 40ms of it being set
  // and silently reopening the cloud race the deferral exists to close (roborev, on the commit before
  // this one). `wasQuiet`/`nowNoisy` are computed from `prev`/`s` directly, so an update that leaves
  // `speaking`/`interim` unchanged computes the same answer either side of it and moves nothing.
  //
  // THE VAD IS READ AS A LEVEL AT THE START, never only from the subscription. `dictationStore.speaking`
  // is the raw Silero VAD on both capture paths (dictation.rs `frame_speaking` ignores `cloud_active`),
  // and Rust emits it only on a CHANGE — speech already in progress when the hold starts produces no
  // event for this watch to see, so the seed below counts it as a run already underway.
  const utterance = useRef<{
    /** Captured runs whose transcript is not yet confirmed dispatched. `0` ⇒ safe to send. */
    owed: number;
    /** Closes that landed while still noisy, awaiting the room going quiet to discharge them. */
    deferred: number;
    unsub: () => void;
  } | null>(null);

  const stopUtteranceWatch = useCallback(() => {
    utterance.current?.unsub();
    utterance.current = null;
  }, []);

  const startUtteranceWatch = useCallback(() => {
    stopUtteranceWatch();
    const st = useDictationStore.getState();
    // ALREADY MID-WORD WHEN THE KEY WENT DOWN counts as one run from frame one — see the doc above.
    const u = { owed: st.speaking || st.interim !== "" ? 1 : 0, deferred: 0, unsub: () => {} };
    u.unsub = useDictationStore.subscribe((s, prev) => {
      const wasQuiet = !prev.speaking && prev.interim === "";
      const nowNoisy = s.speaking || s.interim !== "";
      if (wasQuiet && nowNoisy) u.owed += 1;
      if (s.speechEndSeq !== prev.speechEndSeq) {
        if (nowNoisy) u.deferred += 1;
        else u.owed = Math.max(0, u.owed - 1);
      }
      if (!nowNoisy && u.deferred > 0) {
        u.owed = Math.max(0, u.owed - u.deferred);
        u.deferred = 0;
      }
    });
    utterance.current = u;
  }, [stopUtteranceWatch]);

  // The watch is a store subscription, so it has to be dropped when this host goes away even on the
  // paths that never reach `endHold` — usePushToTalk's own cleanup just unbinds its listeners, so an
  // unmount mid-hold ends the gesture without calling anything here.
  useEffect(() => stopUtteranceWatch, [stopUtteranceWatch]);
  // UNMOUNTING CANCELS IT TOO — and it has to put the microphone back for the same reason the
  // mode/inert canceller below does. While the wait is running the mic is at `pttHeldIntent` (live
  // AND routing), and `finish` is the only thing on this path that drops it; ConciergeHost unmounts
  // whenever no project is open (see App.tsx), so closing the project inside PARTIAL_SETTLE_CAP_MS
  // detached the two races and left a hot mic routing at a concierge box that no longer exists —
  // with nothing to repair it until one mounts again, and nothing at all if the user never reopens.
  // Same always-hot failure as the terminal-focus case, reached by teardown (roborev 56100).
  useEffect(
    () => () => {
      if (!settling.current) return;
      settling.current();
      applyIntent(micIntentForMode(useUiStore.getState().conciergeSendMode));
    },
    [applyIntent],
  );

  // LEAVING PUSH TO TALK CANCELS A PENDING RELEASE. The wait can outlive the gesture by up to
  // PARTIAL_SETTLE_CAP_MS, and before this a user who released and then moved the tray got a message
  // dispatched a second and a half after they had left the mode — from a mode they were no longer
  // in. Same for the tray going inert: a live PTY owns the keyboard, and a send nobody is looking at
  // is exactly what the inert state exists to prevent (roborev 56078).
  //
  // CANCELLING MUST ALSO RESTORE THE MICROPHONE. `finish` is the only thing that drops the mic back
  // to the resting intent on this path, so a canceller that merely detached the two races left it
  // LIVE AND ROUTING: hold ⌘, release with an interim outstanding, click into a terminal inside the
  // cap, and the mic stayed hot indefinitely — `mode` never changes again, so the reconcile effect
  // does not re-run, and `usePushToTalk`'s own inert branch only fires while a hold is still held,
  // which it is not after the keyup. Capture then resumes the moment the user leaves the terminal
  // and the next thing they say lands in the concierge box with no key held: the always-hot
  // push-to-talk this module exists to prevent (roborev 56087).
  //
  // Restoring only when a settle was actually pending keeps this idempotent on the mode-change path,
  // where `setMode` has already applied the new position's intent.
  useEffect(() => {
    if (mode === "ptt" && !inert) return;
    if (!settling.current) return;
    settling.current();
    applyIntent(micIntentForMode(useUiStore.getState().conciergeSendMode));
  }, [mode, inert, applyIntent]);

  /**
   * End the hold: send (or not), then drop the mic back to armed-but-not-routing.
   *
   * ── A RELEASE IS A SEND, FULL STOP ────────────────────────────────────────────────────────────
   * Not "a send when there is a transcript". A hold with no speech in it at all is a deliberate way
   * to dispatch a TYPED draft — in this mode it is the ONLY way, since `chordSends` makes ⌘↩ inert
   * here on purpose — so it takes the fast path below and sends in the keyup's own tick. Anything
   * that made a silent hold wait, or made it a no-op, would take that draft's only send path away.
   *
   * ── "IMMEDIATELY" DOES NOT MEAN "IN THIS TICK" WHEN HE ACTUALLY SPOKE ─────────────────────────
   * The transcript is not always finished arriving when the key comes up: on the cloud path Deepgram
   * publishes a live `interim` and only later commits it as a segment that reaches the composer.
   * Sending in the keyup's own tick then delivers a TRUNCATED phrase — or, for one short sentence,
   * an empty box and no message at all.
   *
   * ── WHY THE OLD "IS AN INTERIM OUTSTANDING?" TEST WAS THE BUG ─────────────────────────────────
   * This used to wait only when `interim` was non-empty at the instant of the keyup, and this doc
   * used to claim that covered the case. IT DID NOT, and the gap is the ordinary release rather than
   * an exotic one. The relay runs `endpointing=200`, so a 200ms gap between clauses CLOSES a segment:
   * the committed text lands, `useDictation` clears the interim, and the words spoken after that gap
   * have not produced an interim yet — transcription runs behind the audio. Let go there and
   * `interim` is already `""`, the old test early-returned, and the tail of the sentence was sent
   * into the void. The founder's report is exactly this: "if I let go and you haven't fully processed
   * the text that I said, we lose it." An empty interim is not "nothing is coming"; it is "nothing is
   * being previewed right now", which is a different fact and true in the middle of every utterance.
   *
   * ── THE SIGNAL: `speechEndSeq`, WHICH THE BACKEND ORDERS BEHIND THE TRANSCRIPT ────────────────
   * `dictation://speech-end` is the engine's own endpoint decision, and Rust emits it AFTER the
   * committed transcript it belongs to, on the same thread, on BOTH capture paths — the cloud relay
   * loop emits `partial` then `speech-end` for a `speech_final` frame (and for the trailing
   * standalone `UtteranceEnd`, whose transcript already went out earlier), and the on-device worker
   * asserts the same order in its own tests ("a closed VAD segment must emit its transcript and THEN
   * the speech-end"). That ordering is what makes it usable here: a bump observed after the keyup is
   * a GUARANTEE that the committed text it closes has already been dispatched to this window.
   *
   * IT IS PER CLAUSE, NOT PER HOLD, AND THAT IS THE TRAP. `speech_end_action` emits on every
   * `speech_final` frame and re-arms on the next interim, so at `endpointing=200` a mid-sentence
   * breath produces one while the user is still talking. "A speech-end arrived" therefore does NOT
   * mean the utterance is over — only that SOME clause is, and on the on-device path it can even be
   * one of SEVERAL still-queued segments. What makes it mean everything captured has landed is
   * `utterance.owed`, the watch's own counted debt: it reaches zero only once every run's close has
   * been confirmed against a moment the room was quiet — the same event as the close, or, for the
   * cloud race where a close can outrun the VAD's slower drop, whatever LATER event first finds the
   * room quiet. See the watch's own doc for why this has to be an accumulated, counted debt and NOT a
   * live "is it quiet right now" read: that reopens the bug on the on-device path (quiet-but-still-
   * decoding) exactly as badly as it reopens it on the cloud path (the confirming close deduped away,
   * so only the cap would ever fire) — and why a single flag isn't enough either, once a hold can
   * genuinely owe more than one segment at release time.
   *
   * WE ONLY WAIT WHEN SOMETHING IS ACTUALLY OUTSTANDING — a hold that captured no audio at all
   * (`utterance.owed` stays `0`) never enters the wait.
   *
   * THE MACROTASK IS STILL LOAD-BEARING. `submit` reads `text` from React state as of the last
   * render, so the insert triggered by the preceding `dictation://partial` needs its RE-RENDER to
   * have flushed. A microtask is not enough (roborev 56078), so this yields a full macrotask after
   * the seq bump before sending.
   *
   * THE CAP IS A BACKSTOP, NOT A POLICY, and ON EXPIRY IT SENDS. If the close never arrives — a
   * dropped socket, a capture torn down mid-utterance — the message must not be stranded, so after
   * {@link PARTIAL_SETTLE_CAP_MS} it sends what is in the box. Reaching the cap means a possibly
   * truncated phrase went out, which is still strictly better than swallowing the message; losing
   * his words is the failure being fixed here and must never be the timeout's behaviour.
   *
   * THE MIC IS DROPPED AFTER THE SEND, not before, and that ordering is load-bearing on this path:
   * `paused` stops routing, so tearing the mic down first can be what prevents the very transcript
   * we are waiting for from ever landing.
   */
  const endHold = useCallback(
    (send: boolean) => {
      settling.current?.();
      const finish = () => {
        settling.current = null;
        stopUtteranceWatch();
        if (send) onSendRef.current();
        // RE-READ the live position rather than hard-coding "ptt". `finish` can now run up to
        // PARTIAL_SETTLE_CAP_MS after the release, and hard-coding it dropped a mic that a mode the
        // user had since picked had just armed — the tray reading "Speak" over a muted microphone,
        // which is the two-controls-disagreeing failure this hook exists to delete, and one the
        // reconcile effect would not repair because `mode` did not change again (roborev 56078).
        applyIntent(micIntentForMode(useUiStore.getState().conciergeSendMode));
      };
      // ── THE FAST PATH: IS THERE ANYTHING LEFT TO DRAIN? ──────────────────────────────────────
      // Skipped only when the watch's own debt says there is nothing to drain: nothing was ever
      // captured, or every captured run's close has already been confirmed. NOT a live "is it quiet
      // right now" read — see the watch's doc for why that reopens the bug on the on-device path.
      if (!send || !utterance.current || utterance.current.owed <= 0) {
        finish();
        return;
      }
      // TWO RACES END THIS WAIT — the utterance closing and the cap expiring — and each needs a
      // handle on the other to tear it down. Held in one object rather than two `let`s so neither can
      // be read before it is assigned, with `settled` making the teardown idempotent: both paths can
      // fire in the same turn, and finishing twice would send the message twice.
      const wait: { timer?: ReturnType<typeof setTimeout>; unsub?: () => void; settled?: boolean } = {};
      const settle = () => {
        if (wait.settled) return;
        wait.settled = true;
        if (wait.timer) clearTimeout(wait.timer);
        wait.unsub?.();
        finish();
      };
      wait.unsub = useDictationStore.subscribe(() => {
        // The watch's own subscriber (registered earlier, in `onHoldStart`) has already run for this
        // exact event by the time this one does — zustand notifies subscribers in registration order
        // — so `utterance.current.owed` already reflects it: every run confirmed clear (each close
        // coinciding with quiet, now or deferred from an earlier noisy bump), or something still
        // outstanding. This proxies the watch rather than re-deriving the decision, so there is
        // exactly one place that makes it.
        if ((utterance.current?.owed ?? 0) > 0) return;
        // Confirmed clear — every committed run has already been dispatched. Yield a macrotask so the
        // insert's render lands first, then send.
        setTimeout(settle, 0);
      });
      wait.timer = setTimeout(settle, PARTIAL_SETTLE_CAP_MS);
      settling.current = () => {
        wait.settled = true; // cancelled, so neither race may finish
        if (wait.timer) clearTimeout(wait.timer);
        wait.unsub?.();
        settling.current = null;
        stopUtteranceWatch();
      };
    },
    [applyIntent, stopUtteranceWatch],
  );

  usePushToTalk({
    active: mode === "ptt",
    inert,
    onHoldStart: useCallback(() => {
      // A new hold cancels a release still waiting on a partial: the user carried on talking, so
      // the phrase they were about to send is no longer the whole of what they mean to say.
      settling.current?.();
      // Fresh gesture, fresh debt — the watch is what lets the release tell "he spoke and the text
      // is still coming" apart from "he held the key in silence to send a typed draft".
      startUtteranceWatch();
      applyIntent(pttHeldIntent());
    }, [applyIntent, startUtteranceWatch]),
    onHoldEnd: useCallback(() => endHold(true), [endHold]),
    // ABANDON SENDS NOTHING — see usePushToTalk's header on ⌘Tab never delivering its keyup.
    onAbandon: useCallback(() => endHold(false), [endHold]),
  });

  return {
    mode,
    setMode,
    inert,
    // A countdown must not run against a microphone that is not being heard. `armed` is what the
    // host hands voice/useAutoSend, so an inert tray stops counting rather than counting invisibly
    // and firing when colour returns.
    armed: mode === "speak" && !inert,
  };
}
