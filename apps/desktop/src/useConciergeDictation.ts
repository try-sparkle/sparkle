// Mic dictation for the concierge compose box (bead sparkle-4562.2 / CM-U9).
//
// Reuses the app's existing dictation stack wholesale — the ambient controller (useDictation), the
// on-device/Deepgram pipeline behind it, and the shared mic semantics in components/MicButton — and
// adds only the two things the concierge needs on top:
//
//   1. OWNERSHIP. dictationStore has one app-wide insert target and the visible agent composer
//      claims it. The concierge column is on screen for the whole session, so it borrows the
//      target ONLY while its own mic is live and hands it back on release.
//   2. A single press-to-dictate gesture. Pressing arms the mic AND routes speech straight into
//      the box (setActive, which refuses and shows the out-of-credits notice on an empty balance,
//      exactly as the legacy mics do). Pressing again PAUSES rather than releasing the mic — the
//      same "never jump straight to off" cycle useMicToggle uses. Saying the stop word, muting
//      from another surface, or losing the mic any other way drops phase out of "active", which
//      releases ownership here too, so end-of-speech ends the concierge's turn without a click.

import { useCallback, useEffect, useRef, useState } from "react";
import { useMicActions } from "./components/MicButton";
import {
  claimDictationTarget,
  dictationTargetStore,
  releaseDictationTarget,
  type DictationTargetStore,
  type InsertFn,
} from "./services/conciergeDictationTarget";
import { useDictationStore } from "./stores/dictationStore";

export interface ConciergeDictation {
  /** The mic is armed AND routing speech into the concierge box right now. */
  micLive: boolean;
  /** Live, uncommitted transcript (Deepgram interim results); empty unless we are live. */
  interim: string;
  /** Press-to-dictate / press-to-pause. */
  toggleMic: () => void;
  /** The compose box hands its append fn here while mounted (null on unmount). */
  registerInsert: (append: InsertFn | null) => void;
}

// Module-level so the default handle keeps a STABLE identity across renders (a fresh object per
// render would churn every callback that depends on it).
const LIVE_TARGET = dictationTargetStore(useDictationStore);

export function useConciergeDictation(
  store: DictationTargetStore = LIVE_TARGET,
): ConciergeDictation {
  const enabled = useDictationStore((s) => s.enabled);
  const phase = useDictationStore((s) => s.phase);
  const rawInterim = useDictationStore((s) => s.interim);
  const { setActive, setMuted } = useMicActions();

  const [owning, setOwning] = useState(false);
  const appendRef = useRef<InsertFn | null>(null);
  const displacedRef = useRef<InsertFn | null>(null);
  // Mirrors owning for the callbacks below, which must read it without re-subscribing.
  const owningRef = useRef(false);

  const release = useCallback(() => {
    if (!owningRef.current) return;
    const append = appendRef.current;
    if (append) releaseDictationTarget(store, append, displacedRef.current);
    displacedRef.current = null;
    owningRef.current = false;
    setOwning(false);
  }, [store]);

  const claim = useCallback(() => {
    const append = appendRef.current;
    if (!append) return;
    if (owningRef.current) return;
    displacedRef.current = claimDictationTarget(store, append);
    owningRef.current = true;
    setOwning(true);
  }, [store]);

  // Routing = the mic is armed AND speech is being typed into a box (rather than waiting on the
  // wake word). Ownership only makes sense while that holds.
  const routing = enabled && phase === "active";

  // The mic left the routing state (stop word, a mute from the top ring, focus loss, out of
  // credits) — hand the target back without waiting for a click on the concierge mic.
  useEffect(() => {
    if (owning && !routing) release();
  }, [owning, routing, release]);

  // Never leave the app-wide target pointing at an unmounted box.
  useEffect(() => release, [release]);

  const registerInsert = useCallback(
    (append: InsertFn | null) => {
      // Release BEFORE overwriting the ref, on ANY change of identity — not just on null (roborev
      // 46922). release() needs the fn we registered in order to prove we still hold the app-wide
      // target; overwriting first would leave the store pointing at the OLD append with owningRef
      // still true, so the next release() would fail its identity guard, silently return, and
      // strand the target on a box that is likely already unmounted — never restoring the composer
      // it displaced. A child ComposeBox unmounts before its parent, so null is the path a real
      // unmount-while-live takes. release() is a no-op when we don't own the target, so the FIRST
      // registration is unaffected.
      //
      // …and RE-CLAIM for the new fn when we were live, because releasing alone would hand the
      // app-wide target back to the agent composer we displaced while the concierge box is still
      // the visible, focused surface: the mic would keep transcribing into an off-screen box and
      // micLive would go dark with nothing the user could do but toggle the mic (roborev 49293).
      //
      // LATENT today, and worth being honest about (roborev 52362): the only caller is ComposeBox's
      // effect, whose cleanup runs FIRST, so a live re-registration arrives as null → non-null and
      // the re-claim sees wasOwning === false. Deliberately not "fixed" by re-claiming on any
      // non-null registration while routing — that would steal the target from an agent composer
      // the user is legitimately dictating into. This keeps the invariant correct for the day a
      // caller re-registers in place; the null path above is the one that runs.
      const wasOwning = owningRef.current;
      if (append !== appendRef.current) release();
      appendRef.current = append;
      if (append && wasOwning) claim();
    },
    [release, claim],
  );

  const micLive = owning && routing;

  const toggleMic = useCallback(() => {
    const live = owningRef.current && useDictationStore.getState().phase === "active";
    if (live) {
      // Active to paused: stop dictating but stay armed, matching the legacy mic cycle.
      setMuted();
      release();
      return;
    }
    // Refused (notice shown, nothing armed) on an empty balance, so only claim the app-wide
    // target once the store actually reports a live routing state.
    setActive();
    const s = useDictationStore.getState();
    if (s.enabled && s.phase === "active") claim();
  }, [setActive, setMuted, claim, release]);

  return {
    micLive,
    // Only the surface that owns dictation paints the live preview, so the concierge never
    // ghosts words that are landing in an agent composer.
    interim: micLive ? rawInterim : "",
    toggleMic,
    registerInsert,
  };
}
