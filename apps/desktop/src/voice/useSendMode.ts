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
 * The longest a push-to-talk release will wait for an in-flight partial to commit before sending
 * whatever is in the box.
 *
 * A BACKSTOP, not a policy — see `endHold`. The wait ends the instant the transcript lands, so this
 * number is only ever reached when the commit never arrives at all (a dropped socket, a capture torn
 * down mid-utterance). 1.5s is long enough to cover a normal commit's tail and short enough that a
 * user who hit the failure case is not left staring at a composer that appears to have ignored them.
 */
export const PARTIAL_SETTLE_CAP_MS = 1_500;

export interface UseSendModeArgs {
  /**
   * Send whatever is in the box. Returns whether anything actually went out.
   *
   * Called on a push-to-talk RELEASE — and on nothing else here, because every other way of
   * sending is a press the tray reports directly to its host.
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
  useEffect(() => {
    const intent = micIntentForMode(mode);
    if (intent === "off" && useDictationStore.getState().enabled) return;
    applyIntent(intent);
  }, [mode, applyIntent]);

  const onSendRef = useRef(onSend);
  onSendRef.current = onSend;

  // A release that is waiting on an in-flight partial, so a second gesture (or an unmount) can call
  // it off rather than leaving a send armed against a hold that no longer exists.
  const settling = useRef<(() => void) | null>(null);
  useEffect(() => () => settling.current?.(), []);

  /**
   * End the hold: send (or not), then drop the mic back to armed-but-not-routing.
   *
   * ── "IMMEDIATELY" DOES NOT MEAN "IN THIS TICK" ────────────────────────────────────────────────
   * Release fires the send — no countdown, no grace period, no confirmation. But the transcript is
   * not always finished arriving when the key comes up: on the cloud path Deepgram publishes a live
   * `interim` and only later commits it as a segment that reaches the composer. Sending in the
   * keyup's own tick when an interim is outstanding delivers a TRUNCATED phrase — or, if the user
   * spoke one short sentence and let go, an empty box and no message at all.
   *
   * So a release with an interim outstanding waits for that interim to CLEAR — the signal that the
   * segment committed into the box — and sends the whole phrase then. That is not a delay anyone
   * chose: there is no timer to expire, nothing to wait out, and the common case (no interim, or the
   * on-device path, which has no interim results at all) still sends in the keyup's own tick.
   *
   * THE CAP IS A BACKSTOP, NOT A POLICY. If the commit never arrives — a dropped socket, a capture
   * torn down mid-utterance — the message must not be stranded forever, so after
   * {@link PARTIAL_SETTLE_CAP_MS} it sends what is in the box. Reaching the cap means we sent a
   * possibly-truncated phrase, which is still better than swallowing the user's message.
   *
   * THE MIC IS DROPPED AFTER THE SEND, not before, and that ordering is load-bearing on this path:
   * `paused` stops routing, so tearing the mic down first can be what prevents the very partial we
   * are waiting for from ever landing.
   */
  const endHold = useCallback(
    (send: boolean) => {
      settling.current?.();
      const finish = () => {
        settling.current = null;
        if (send) onSendRef.current();
        applyIntent(micIntentForMode("ptt"));
      };
      if (!send || !useDictationStore.getState().interim) {
        finish();
        return;
      }
      // TWO RACES END THIS WAIT — the commit landing and the cap expiring — and each needs a handle
      // on the other to tear it down. Held in one object rather than two `let`s so neither can be
      // read before it is assigned, with `settled` making the teardown idempotent: both paths can
      // fire in the same turn, and finishing twice would send the message twice.
      const wait: { timer?: ReturnType<typeof setTimeout>; unsub?: () => void; settled?: boolean } = {};
      const settle = () => {
        if (wait.settled) return;
        wait.settled = true;
        if (wait.timer) clearTimeout(wait.timer);
        wait.unsub?.();
        finish();
      };
      wait.unsub = useDictationStore.subscribe((s) => {
        if (!s.interim) settle(); // the segment committed — the phrase is whole now
      });
      wait.timer = setTimeout(settle, PARTIAL_SETTLE_CAP_MS);
      settling.current = () => {
        wait.settled = true; // cancelled, so neither race may finish
        if (wait.timer) clearTimeout(wait.timer);
        wait.unsub?.();
        settling.current = null;
      };
    },
    [applyIntent],
  );

  usePushToTalk({
    active: mode === "ptt",
    inert,
    onHoldStart: useCallback(() => {
      // A new hold cancels a release still waiting on a partial: the user carried on talking, so
      // the phrase they were about to send is no longer the whole of what they mean to say.
      settling.current?.();
      applyIntent(pttHeldIntent());
    }, [applyIntent]),
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
