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
// THREE WAYS A HOLD IS ABANDONED, and they are all about ⌘ being the OS's modifier as well as ours:
// a second KEY pressed while ⌘ is down (⌘V, ⌘A, ⌘Z), a deliberate POINTER PRESS while ⌘ is down
// (⌘-click or a context menu — neither emits a keydown, and a click inside the app emits no blur
// either), and a window blur. None of them send.
//
// A SCROLL IS NOT ONE OF THEM. `wheel` was briefly in that set and had to come out; the note above
// `abandon` says why. Stated here too because this header is what the next reader plans against,
// and a header naming a guard that no longer exists is worse than no header (roborev 56100).
//
// WHAT IS DELIBERATELY *NOT* A REASON TO ABANDON: a short hold, or a hold during which nothing was
// dictated. Both were proposed as extra evidence that the gesture "was really speech", and both
// would break the mode — a deliberate silent hold is how you dispatch a draft you TYPED, and
// gating the release on a minimum duration or a transcript delta would turn that gesture into a
// silent no-op. The user let go; that is the whole signal this mode takes.
//
// The argument used to rest on ⌘↩ being inert here ("the RELEASE is the only way a typed draft can
// leave the box"). IT NO LONGER IS — the founder asked for both, so `chordSends` now honours ⌘↩ in
// this mode too (sparkle-u81cz). That removes the *stranding* risk, not the reason: a release that
// quietly dropped the draft would still be a gesture the user performed and the app ignored.
//
// It also makes the chord guard below load-bearing in a way it was not before. ⌘↩ now reaches this
// listener as `Meta` down → `Enter` down, and it is precisely the "second key abandons the hold"
// branch that stops the composer's submit and a hold-release send from STACKING into two messages.
//
// WHY THE WINDOW-BLUR ABANDON IS NOT DEFENSIVE. While ⌘ is held, every stray letter becomes an OS
// chord — ⌘Q, ⌘W, ⌘Tab. ⌘Tab in particular switches application WITHOUT ever delivering the
// `keyup` for ⌘, so a hold that ends that way never ends at all: the mic stays hot forever and the
// next thing the user says goes into a message they thought they had abandoned. Blur therefore
// CANCELS — it disarms the hold and does NOT send. Abandoning is the safe direction; a send nobody
// asked for is the failure this whole feature exists to make impossible.

import { useEffect, useRef } from "react";

/** The key that means "talk", as `KeyboardEvent.key` reports it. Held as a constant so the tray's
 *  chiclet (./sendMode `chicletFor`) and this listener are talking about the same key.
 *
 *  Its HUMAN-READABLE form is `./sendMode` `TALK_KEY_GLYPH` ("⌘") — a separate constant because the
 *  copy that names this key ("Hold ⌘ to talk", ./dictationCopy) must not import a React hook module
 *  to say so. The pair is one fact; change one and change the other. */
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

    // ⌘-CLICK IS A CHORD TOO, and it reaches none of the branches above: a mouse press delivers no
    // `keydown`, and a click INSIDE the app fires no `blur` either — so ⌘-click (open-in-new-window,
    // multi-select, a context menu) held the gesture open and then dispatched the draft on ⌘-up.
    // Same failure as ⌘V, reached by mouse. A deliberate POINTER PRESS while ⌘ is down means ⌘ was
    // being used as a MODIFIER, not as the talk key, so the hold is abandoned as a second keydown is.
    //
    // A SCROLL IS NOT A PRESS, and `wheel` is deliberately NOT in this set. It was, briefly, and it
    // contradicted the feature this file sells: scrolling the transcript with a trackpad while
    // holding ⌘ killed the gesture mid-utterance, with no cue that anything had happened. macOS also
    // delivers momentum `wheel` events for up to ~1s after the fingers leave the trackpad, so a
    // scroll performed BEFORE ⌘ went down could abandon a hold with no gesture from the user at all
    // (roborev 56087).
    const abandon = () => {
      if (!held.current) return;
      held.current = false;
      cbs.current.onAbandon();
    };
    // See the header: ⌘Tab never delivers its keyup, so blur is the only end that hold will get.
    const blur = abandon;

    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    window.addEventListener("mousedown", abandon);
    window.addEventListener("contextmenu", abandon);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
      window.removeEventListener("mousedown", abandon);
      window.removeEventListener("contextmenu", abandon);
    };
  }, [active, inert]);
}
