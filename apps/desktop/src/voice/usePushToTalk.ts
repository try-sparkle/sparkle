// Push to talk — hold ⌘ ANYWHERE in the window to talk, release to send.
//
// "ANYWHERE" IS THE FEATURE, and it is why this listens on `window` rather than on the textarea.
// A push-to-talk you can only use while the caret is parked in the compose box is not push-to-talk;
// the whole point is that you can be reading the thread, or hovering a diff, and still speak. The
// only thing that takes the gesture away is a live PTY owning the keyboard — see `inert`.
//
// RELEASE SENDS IMMEDIATELY. No timer, no confidence tier, no countdown. Push to talk is the
// DELIBERATE mode: the user said where the utterance ends by letting go, and making them then wait
// out a clock would make the deliberate mode feel laggier than the automatic one (Speak). That
// asymmetry is stated in ./sendMode `modeCountsDown` and this is the other half of it.
//
// TWO WAYS A HOLD IS ABANDONED, and both are about ⌘ being the OS's modifier as well as ours:
// a second key pressed while ⌘ is down (the gesture was a CHORD — ⌘V, ⌘A, ⌘Z — not speech), and a
// window blur. Neither sends.
//
// WHY THE WINDOW-BLUR ABANDON IS NOT DEFENSIVE. While ⌘ is held, every stray letter becomes an OS
// chord — ⌘Q, ⌘W, ⌘Tab. ⌘Tab in particular switches application WITHOUT ever delivering the
// `keyup` for ⌘, so a hold that ends that way never ends at all: the mic stays hot forever and the
// next thing the user says goes into a message they thought they had abandoned. Blur therefore
// CANCELS — it disarms the hold and does NOT send. Abandoning is the safe direction; a send nobody
// asked for is the failure this whole feature exists to make impossible.

import { useEffect, useRef } from "react";

/** The key that means "talk". `⌘` on this platform; held as a constant so the tray's chiclet
 *  (./sendMode `chicletFor`) and this listener are talking about the same key. */
export const TALK_KEY = "Meta";

export interface UsePushToTalkArgs {
  /** Is Push to talk the selected tray position? Nothing binds unless it is. */
  active: boolean;
  /** A live PTY owns the keyboard, so the gesture is not ours to take (./sendMode `trayInert`). */
  inert?: boolean;
  /** The hold began: route the mic here and go live. */
  onHoldStart: () => void;
  /** The hold ENDED CLEANLY (the user let go): stop routing and send. */
  onHoldEnd: () => void;
  /** The hold was ABANDONED (window blur — see the header): stop routing and send NOTHING. */
  onAbandon: () => void;
}

/**
 * Binds the hold gesture while `active`. Returns nothing: the caller already knows the mode, and a
 * "held" flag returned from here would be a second copy of a fact the caller's own callbacks
 * establish — two sources for one state is how a stuck-hot microphone happens.
 */
export function usePushToTalk({
  active,
  inert = false,
  onHoldStart,
  onHoldEnd,
  onAbandon,
}: UsePushToTalkArgs): void {
  // The callbacks are read through a ref so a caller passing fresh closures every render does not
  // tear the listeners down and rebuild them mid-hold — which would drop the `keyup` for a hold
  // that was already in progress, i.e. reproduce the stuck-hot bug on purpose.
  const cbs = useRef({ onHoldStart, onHoldEnd, onAbandon });
  cbs.current = { onHoldStart, onHoldEnd, onAbandon };

  const held = useRef(false);

  useEffect(() => {
    // Leaving the mode (or the terminal taking the keyboard) mid-hold must not strand a hot mic.
    // Abandon rather than send: the user did not release, so nothing said the utterance was over.
    if (!active || inert) {
      if (held.current) {
        held.current = false;
        cbs.current.onAbandon();
      }
      return;
    }

    const down = (e: KeyboardEvent) => {
      // ⌘ IS ALSO THE OS'S CHORD MODIFIER, and that is the sharpest edge on this whole feature.
      // ⌘V, ⌘A, ⌘C, ⌘Z, ⌘K, ⌘1…9 all begin with a `Meta` keydown and end with a `Meta` keyup, so
      // without this branch every one of them dispatched the draft the instant ⌘ came back up — an
      // irreversible send nobody asked for, in the mode whose whole promise is that you decide when
      // the message goes. A second key arriving mid-hold means the gesture was a CHORD, not speech,
      // so the hold is abandoned (never sent) and the composer keeps its draft.
      if (held.current && e.key !== TALK_KEY) {
        held.current = false;
        cbs.current.onAbandon();
        return;
      }
      // `repeat` fires many times a second while a key is down. Only the FIRST one is the gesture
      // starting; the rest would re-arm a mic that is already hot.
      if (e.key !== TALK_KEY || e.repeat || held.current) return;
      held.current = true;
      cbs.current.onHoldStart();
    };

    const up = (e: KeyboardEvent) => {
      if (e.key !== TALK_KEY || !held.current) return;
      held.current = false;
      cbs.current.onHoldEnd();
    };

    // See the header: ⌘Tab never delivers its keyup, so blur is the only end this hold will get.
    const blur = () => {
      if (!held.current) return;
      held.current = false;
      cbs.current.onAbandon();
    };

    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, [active, inert]);
}
