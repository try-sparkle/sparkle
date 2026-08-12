// Mic dictation for the concierge compose box (bead sparkle-4562.2 / CM-U9).
//
// Reuses the app's existing dictation stack wholesale — the ambient controller (useDictation), the
// on-device/Deepgram pipeline behind it, and the shared mic semantics in components/MicButton — and
// adds only what the concierge needs on top: OWNERSHIP. dictationStore has one app-wide insert
// target and every mounted agent composer registers for it, so the concierge column — which is on
// screen for the whole session — must not hold it merely because it exists. It BORROWS the target
// while the mic is routing speech AND the concierge is the surface the user is talking to, and
// hands it straight back otherwise.
//
// THE BOX NO LONGER HAS A MIC BUTTON, and that is what this file is really about. It used to: a
// press-to-dictate control beside Send, whose handler both armed the mic and claimed the target in
// one gesture. That button was the duplicate of the ring in the column header, and with it removed
// the claim has to come from somewhere else — because the two ways the mic now goes live (the ring,
// and the send tray moving to Speak or a push-to-talk hold beginning, neither of which is a click
// on a composer) never ran that handler. Ownership is therefore derived from state rather than
// from a click:
//
//   routing  = mic armed AND phase "active"        (speech is being typed into a box at all)
//   ours     = dictationStore.voiceSurface === "concierge"   (…and this is the box it belongs to)
//
// `voiceSurface` is set by the mic CONTROLS themselves — the ring sets "concierge", an agent
// composer's ComposerMic sets "agent" — so "the mic you operated owns the transcript" still holds,
// including for a tray-driven arm, which lands on whichever surface was last operated (and on the
// ring by default). Moving the tray off Speak (or releasing a hold), muting from anywhere, or
// arming an agent composer's own mic all drop one of the two conditions, which releases the target
// here without a click.

import { useCallback, useEffect, useRef, useState } from "react";
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
  const voiceSurface = useDictationStore((s) => s.voiceSurface);
  // Subscribed, not read through getState, so a composer that registers AFTER us — an agent pane
  // mounting registers unconditionally (Composer.tsx) — re-runs the ownership effect below and we
  // take the target back rather than silently believing we still hold it.
  const insertTarget = useDictationStore((s) => s.insertTarget);

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
    if (store.getInsertTarget() === append) {
      // Already pointed at us. Nothing to take and nobody to remember as displaced; just make sure
      // our own bookkeeping agrees, so the release path knows it has something to hand back.
      owningRef.current = true;
      setOwning(true);
      return;
    }
    if (owningRef.current) {
      // We still consider ourselves the owner but the target moved — an agent pane mounted and
      // registered over us. Re-register WITHOUT re-recording a displaced holder: displacedRef
      // already names the composer this ownership episode must restore, and overwriting it with
      // the interloper would hand the mic to a pane the user never armed when we let go.
      store.registerInsert(append);
      return;
    }
    displacedRef.current = claimDictationTarget(store, append);
    owningRef.current = true;
    setOwning(true);
  }, [store]);

  // Routing = the mic is armed AND speech is being typed into a box (rather than armed-but-idle,
  // i.e. Push to talk between holds). Ownership only makes sense while that holds AND this is the
  // surface the user is talking to — see `voiceSurface` in dictationStore.
  const routing = enabled && phase === "active";
  const oursToHold = routing && voiceSurface === "concierge";

  // THE ORPHAN CASE. `voiceSurface` only moves when a mic control is operated, so it can outlive
  // the surface it names: arm an agent composer's mic, then close that pane, and its cleanup
  // registers null while the mic is still armed. Nobody then holds the target — dictationStore's
  // insert() no-ops against null — so the ring reads "Actively listening" and the words go nowhere.
  // That is the same failure this file exists to fix, just mirrored.
  //
  // Handled by moving the ARBITER back rather than by widening `oursToHold`: a derived "claim when
  // orphaned" would flip its own input (claiming makes the target non-null, which un-orphans us,
  // which releases, which orphans us again). Rewriting the state settles once, and the ordinary
  // rule above then does the claiming. Keyed on the target being GONE, never merely on it not
  // being ours — an agent composer that still holds it owns it, and this must not evict it.
  const setVoiceSurface = useDictationStore((s) => s.setVoiceSurface);
  useEffect(() => {
    if (routing && voiceSurface === "agent" && insertTarget === null) setVoiceSurface("concierge");
  }, [routing, voiceSurface, insertTarget, setVoiceSurface]);

  // THE ownership rule, and the only thing that claims now that the box has no mic button of its
  // own. Takes the target the moment the mic starts routing to this surface — whether that came
  // from the header ring, from a pill choice, or from the send tray with no click on a box at all —
  // and hands it back the moment either condition drops (the tray leaving Speak, a hold released, a
  // mute from anywhere, focus loss, out of credits, or the user arming an agent composer's own mic).
  useEffect(() => {
    if (oursToHold) {
      if (appendRef.current && insertTarget !== appendRef.current) claim();
    } else if (owning) release();
    // `insertTarget` is a dependency so a later registration by someone else is noticed; `owning`
    // so the release branch re-evaluates once a claim lands.
  }, [oursToHold, insertTarget, owning, claim, release]);

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
      // The re-claim used to be gated on `wasOwning` alone, and was noted as latent because the
      // only caller is ComposeBox's effect, whose cleanup runs first (so a live re-registration
      // arrives as null → non-null and wasOwning is already false). It is no longer latent, and no
      // longer only about re-registration: the box registers its append fn AFTER the first render,
      // so on a cold start where the mic is already armed and routing here, this is the moment the
      // append fn we need in order to claim finally exists. The ownership effect above cannot cover
      // it — appendRef is a ref, so filling it re-runs nothing.
      //
      // Re-claiming on ANY non-null registration while routing was previously rejected as "that
      // would steal the target from an agent composer the user is legitimately dictating into".
      // That is exactly what `voiceSurface` now answers: we claim only when the user's mic gesture
      // named THIS surface, so an agent composer the user armed keeps what it holds.
      const wasOwning = owningRef.current;
      if (append !== appendRef.current) release();
      appendRef.current = append;
      if (!append) return;
      const s = useDictationStore.getState();
      if (wasOwning || (s.enabled && s.phase === "active" && s.voiceSurface === "concierge")) claim();
    },
    [release, claim],
  );

  const micLive = owning && routing;

  return {
    micLive,
    // Only the surface that owns dictation paints the live preview, so the concierge never
    // ghosts words that are landing in an agent composer.
    interim: micLive ? rawInterim : "",
    registerInsert,
  };
}
