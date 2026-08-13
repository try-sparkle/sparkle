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

import { useCallback, useEffect, useRef, useState } from "react";

import { useUiStore } from "../stores/uiStore";
import { useDictationStore } from "../stores/dictationStore";
import { useMicActions } from "../components/MicButton";
import { micIntentForMode, pttHeldIntent, trayInert, type SendMode } from "./sendMode";
import { usePushToTalk } from "./usePushToTalk";
import type { MicIntent } from "../components/MicButton";

/**
 * The absolute longest a push-to-talk release will wait for the utterance it captured to finish
 * arriving before sending whatever is in the box, no matter what.
 *
 * A BACKSTOP, not a policy — see `endHold`. In the ordinary case the wait ends far sooner, via
 * {@link QUIET_WINDOW_MS} or a confirmed engine close. This is what fires when NEITHER of those
 * ever does — a dropped socket, a capture torn down mid-utterance, or content that keeps trickling
 * in without ever settling. BOUNDED GENEROUSLY, deliberately: the failure this whole file exists to
 * prevent is losing his words, and a slightly slower send is strictly better than a truncated one
 * — see the reopening note on the commit that raised this from 1.5s. 4s is long enough to cover
 * on-device decode latency described as running "hundreds of ms to seconds" behind the audio
 * (`dictationStore.onDeviceSpeech`), and short enough that a release which genuinely never settles
 * is not left hanging indefinitely.
 *
 * IT IS ALSO NEVER REACHED BY A HOLD THAT CAPTURED NOTHING. A silent hold has no utterance to wait
 * for, so it does not enter the wait at all — see `endHold`'s owed test. That matters because a
 * hold whose only content is TYPED text is a first-class case here, not an edge one, and making it
 * sit out a cap would make the send feel broken.
 */
export const PARTIAL_SETTLE_CAP_MS = 4_000;

/**
 * How a push-to-talk hold ended, and therefore what happens to the words it captured.
 *
 *   • `send`    — he let go with Auto-send ON. Wait for the utterance to finish arriving, then
 *                 dispatch it. The behaviour push-to-talk has always had.
 *   • `keep`    — he let go with Auto-send OFF (sparkle-bbfsx). Wait exactly the same way, then
 *                 leave the words in the composer for him to edit and send by hand. *"if auto-send
 *                 is off, then when I let go of the push the talk button, it does not actually
 *                 auto-send. It just leaves it in the [composer]."*
 *   • `abandon` — the gesture was aborted (window blur, a ⌘-chord, ⌘-click). Send NOTHING and do
 *                 not wait: nothing said the utterance was over, so there is no tail to protect.
 *
 * THE SPLIT THAT MATTERS IS `keep` vs `abandon`, NOT `keep` vs `send`. Both of the first two keep
 * his words, so both must drain; only `abandon` may tear the microphone down immediately. A
 * two-valued flag put `keep` on the wrong side of that line by construction.
 */
export type HoldOutcome = "send" | "keep" | "abandon";

/**
 * How long the ARRIVAL SIGNAL — committed segments, and the live interim on the cloud path — has to
 * sit COMPLETELY UNCHANGED before a release treats the utterance as settled.
 *
 * THIS IS THE PRIMARY SIGNAL, not a fallback bolted onto the engine-close confirmation below. The
 * founder tested a shipped build carrying the fully engine-close-based design (`owed`/`deferred`,
 * hardened across three roborev passes and a green suite) and it STILL cut off his last words —
 * proof that trusting `speechEndSeq` alone, however carefully gated, was not sufficient in practice.
 * A production log grep for `dictation: emit final` found nothing, which is not conclusive on its
 * own (`emit_speech_end` deliberately logs nothing at all — see dictation.rs — so its absence from
 * the log proves nothing either way), but the founder's first-hand report is not a log line to
 * second-guess. Watching ARRIVALS settle sidesteps the entire question of whether any particular
 * Rust signal fired, ordered correctly, or was delivered at all: it only asks "is anything still
 * landing", which is directly observable regardless of the mechanism behind it.
 *
 * It watches `dictationStore.committedSeq`, NOT the composer's text. The text also moves when the
 * USER TYPES, and this wait routinely runs for seconds with the box focused — so a keystroke used to
 * restart the quiet clock and settle the drain on top of a decode still in flight (roborev 57295).
 *
 * 500ms is generous relative to how often committed segments actually arrive mid-utterance (Deepgram
 * commits roughly every clause) so it does not mistake an ordinary breath for the end, while still
 * resolving well inside {@link PARTIAL_SETTLE_CAP_MS} once things actually go quiet.
 */
const QUIET_WINDOW_MS = 500;

/** How often the stable-partial detector re-checks the arrival counter and the live interim. Well
 *  under {@link QUIET_WINDOW_MS} so the quiet window is measured precisely, and cheap enough (two
 *  store reads and a compare) that a plain interval is simpler than a subscription — the poll also
 *  has to notice the ABSENCE of change, which a subscription cannot deliver. */
const STABLE_PARTIAL_POLL_MS = 100;

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
  /** Is the auto-send countdown allowed to run at all right now? Speak, and not inert.
   *
   *  DELIBERATELY UNAFFECTED BY {@link SendModeController.autoSend} — see that field. */
  armed: boolean;
  /**
   * Does this position's automatic dispatch actually SEND, or leave the words in the composer?
   * Persisted, because the founder asked for a switch that remembers its position across mode
   * changes and across relaunches.
   *
   * ── IT IS RESOLVED PER POSITION, AND THE TRIGGER DIFFERS (sparkle-bbfsx) ──────────────────────
   *   Speak        → uiStore `conciergeSpeakAutoSend`. The dispatch is the COUNTDOWN expiring.
   *   Push to talk → uiStore `conciergePttAutoSend`.   The dispatch is the KEY COMING UP.
   * Two settings, one control shape. See the store's `conciergePttAutoSend` doc for why they are
   * not one shared boolean.
   *
   * READ IT ALONGSIDE `armed`, NOT INSTEAD OF IT. `armed` says whether the countdown runs; this says
   * what happens at the dispatch. Off does NOT stop the countdown in Speak — the utterance still
   * ends on the same schedule, the fill still drains, typing still pauses it — it only withholds the
   * dispatch. In Push to talk there is no countdown to stop either way (`modeCountsDown`), so off
   * means only that the release keeps the words instead of sending them.
   */
  autoSend: boolean;
  /** Flip the Auto-send toggle FOR THE CURRENT POSITION. Writes straight through to that
   *  position's persisted setting — see `autoSend` for which one that is. */
  setAutoSend: (v: boolean) => void;
  /** Is the push-to-talk GESTURE active right now — the key or the button held down?
   *
   *  The third tray state, and the one that was missing: `mode === "ptt"` says only that the
   *  position is selected, so selected-and-armed and selected-and-holding painted identically and
   *  the user could not tell his voice was being taken.
   *
   *  IT TRACKS THE GESTURE, NOT THE MICROPHONE (roborev 57302). Those coincided until the release
   *  drain landed; now a release with an outstanding run keeps the mic live for up to
   *  {@link PARTIAL_SETTLE_CAP_MS} after this goes false. The mic's own truth is the sidebar ring's
   *  to tell. */
  held: boolean;
}

export function useSendMode({ onSend }: UseSendModeArgs): SendModeController {
  const mode = useUiStore((s) => s.conciergeSendMode);
  const setStoredMode = useUiStore((s) => s.setConciergeSendMode);
  // The Auto-send toggle. Read from the SAME persisted store as the position, so "it remembers the
  // last position I set it to" costs nothing extra and cannot drift from the tray it belongs to.
  const speakAutoSend = useUiStore((s) => s.conciergeSpeakAutoSend);
  const setSpeakAutoSend = useUiStore((s) => s.setConciergeSpeakAutoSend);
  // …and Push to talk's own, which is a SEPARATE persisted setting behind the same control shape
  // (sparkle-bbfsx). See the store's `conciergePttAutoSend` doc for why it is not one shared
  // boolean: the two positions dispatch on different events, and switching off the release-send
  // must not switch off a countdown in a mode the user is not in.
  const pttAutoSend = useUiStore((s) => s.conciergePttAutoSend);
  const setPttAutoSend = useUiStore((s) => s.setConciergePttAutoSend);
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
  //   Push to talk at rest -> `micIntentForMode` = "paused" -> phase PASSIVE -> the routing gate in
  //     `terminalRoutingArmed` (voice/dictationFocus) is false -> `dictationPauseReason` returns
  //     "terminal" -> capture pauses. Correct, and by accident of the resting intent.
  //   Speak -> "active" -> phase ACTIVE -> the routing gate PASSES -> the terminal stops being a pause
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
  // the stand-down guard below returned and left the mic armed and listening indefinitely
  // under a tray reading "Send" — with the indicator painting it grey "Microphone: off" the whole
  // time, which is the exact two-controls-disagreeing state this hook exists to delete. It also
  // fired the out-of-credits notice at anyone who merely clicked into a terminal, and stole
  // `voiceSurface` from a mic armed in the header or another window.
  //
  // Keying on the RESTING intent keeps Send on the "off" branch, where the stand-down guard can do
  // its job, while still demoting the one position that is actually live.
  // ── THE STAND-DOWN IS FOR `send` ONLY — PUSH TO TALK MUST STILL BE RELEASED ───────────────────
  //
  // `ptt !== "off"` is load-bearing and was the highest-severity hole in sparkle-u81cz's first cut.
  // The carve-out below was reasoned for ONE position: `send` is the DEFAULT, "the one nobody
  // chose", so releasing on its behalf would destroy a mic the user armed somewhere else. When
  // push-to-talk's resting intent became "off" it silently inherited that carve-out — and that
  // defeats the fix on exactly the population it was written for.
  //
  // `dictationStore` PERSISTS `{enabled, phase}`, and every user currently parked on Push to talk
  // has `enabled: true` on disk, because the OLD resting intent armed the mic through `setMuted`.
  // So on the first launch after this change: `mode === "ptt"`, `resting === "off"`,
  // `enabled === true` → the guard returns, `setOff` is never called, and the microphone is still
  // open and capturing at rest. The founder would have upgraded into the very bug he reported.
  //
  // WHAT THIS DELIBERATELY DOES *NOT* CLOSE, so the next reader does not plan against a guard that
  // is not here: arming the mic from the HEADER RING while the tray is parked on Push to talk. The
  // deps are `[mode, inert, applyIntent]`, so nothing re-runs on `enabled`, and the mic stays open
  // until a mode change or a focus edge happens to re-run this. That is the ordinary
  // armed-from-another-surface case Send has always had, and it is left alone on purpose: `enabled`
  // cannot become a dependency here, because a push-to-talk HOLD sets it — the effect would re-run
  // mid-hold, read the resting intent, and release the microphone in the middle of the sentence.
  //
  // Push to talk is a position the user PICKED, and its whole contract is that the mic is shut
  // between holds — so a mic THIS COLUMN owns is not state to preserve here, it is the state this
  // position exists to deny. Send keeps the carve-out, and so does an unrecognised persisted value,
  // which still fails closed onto it.
  //
  // ── …BUT ONLY FOR A MIC THIS COLUMN OWNS (`voiceSurface`) ─────────────────────────────────────
  //
  // The `voiceSurface` term is not belt-and-braces; without it the ptt carve-out reaches a
  // microphone that has nothing to do with the concierge. This effect re-runs on every `inert`
  // edge — i.e. every time the caret enters or leaves a terminal — and for `ptt` the intent is
  // always "off", so each of those transitions would call `applyIntent("off")`, which does
  // `setVoiceSurface("concierge")` and then `setOff()`. The agent composer arms its own mic with
  // `voiceSurface: "agent"` (components/Composer, MicButton), so: tray parked on Push to talk and
  // not in use, the user dictates into an AGENT composer, clicks into a terminal — and the
  // concierge steals the surface and disarms their microphone mid-sentence, with no gesture aimed
  // at this column at all. The `enabled` guard used to prevent exactly that.
  //
  // `voiceSurface` is NOT persisted (`partialize` keeps only `{enabled, phase}`) and initialises to
  // "concierge", so the upgrade path this carve-out exists for still releases: a relaunch with a
  // persisted `enabled: true` reads "concierge" and falls through to `applyIntent("off")`.
  useEffect(() => {
    const resting = micIntentForMode(mode);
    const intent = inert && resting !== "off" ? "paused" : resting;
    const mic = useDictationStore.getState();
    const ownedHere = mic.voiceSurface === "concierge";
    // A RELEASE WE DO NOT OWN IS NOT OURS TO MAKE — and `enabled` is the wrong term to gate it on,
    // because `applyIntent` CLAIMS THE SURFACE before it touches the mic (`setVoiceSurface`, then
    // `setOff`). So an "off" reconcile on a foreign surface is never harmless even when the mic is
    // already released: it silently rewrites ownership to "concierge" on every mount and every
    // terminal focus edge. The user then arms from the header ring — which claims no surface of its
    // own — and their dictation lands in the concierge box instead of the agent
    // composer they last put the caret in. Checked BEFORE `enabled` for exactly that reason.
    if (intent === "off" && !ownedHere) return;
    if (intent === "off" && mic.enabled && mode !== "ptt") return;
    applyIntent(intent);
    // `inert` IS a dependency now. Without it this effect only re-ran when the tray moved, so the
    // caret entering or leaving a terminal changed nothing — which is precisely why Speak stayed
    // routing into the PTY.
  }, [mode, inert, applyIntent]);

  const onSendRef = useRef(onSend);
  onSendRef.current = onSend;

  // Mirrors the live value every render, the same pattern as `onSendRef` — read from inside
  // `endHold`'s stable-partial poll, which runs on a plain `setInterval` rather than React's
  // render cycle, so it needs a ref rather than the prop itself.

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
   * ── THREE OUTCOMES, AND THE MIDDLE ONE IS WHY THIS IS NOT A BOOLEAN (sparkle-bbfsx) ───────────
   * It used to take `send: boolean`, which conflated two different questions: *do the words go out*
   * and *do we wait for them to arrive first*. The push-to-talk Auto-send switch splits them — with
   * it off, a release must still drain the utterance (his words are being KEPT, and the whole point
   * of the wait below is that they are not all here yet) and simply not dispatch. Reusing `false`
   * there would have taken the abandon path: no wait, mic dropped immediately, and the tail of the
   * sentence never lands — a silent truncation of exactly the words he asked to keep. See
   * {@link HoldOutcome}.
   *
   * ── A RELEASE IS A SEND, FULL STOP ────────────────────────────────────────────────────────────
   * Not "a send when there is a transcript". A hold with no speech in it at all is a deliberate way
   * to dispatch a TYPED draft, so it takes the fast path below and sends in the keyup's own tick.
   * Anything that made a silent hold wait, or made it a no-op, would ignore a gesture the user
   * deliberately performed. (This used to add "in this mode it is the ONLY way to send it, since
   * `chordSends` makes ⌘↩ inert here" — no longer true: ⌘↩ sends in Push to talk too as of
   * sparkle-u81cz. The release is now one of two send paths, not the only one.)
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
   * one of SEVERAL still-queued segments. `utterance.owed`, the watch's own counted debt, is what
   * turns a bare close into that judgment: it reaches zero only once every run's close has been
   * confirmed against a moment the room was quiet.
   *
   * IT IS ALSO NOT TRUSTED ALONE ANY MORE, and that is the point of what follows. A build carrying
   * exactly this design — `owed`/`deferred`, hardened across three roborev passes, a green suite —
   * shipped and STILL cut off the founder's last words in his own testing. Whatever the exact reason
   * (a log grep for the engine's own "final" language found nothing, though `emit_speech_end`
   * deliberately never logs at all, so that is not proof either way — see `dictation.rs`), the
   * lesson is not "find the one true signal": it is that NO single Rust-side signal is safe to trust
   * exclusively for a failure whose cost is losing someone's words. So `owed` reaching zero is now an
   * OPTIMIZATION — it can settle the wait quickly when the engine's own close does arrive and confirm
   * correctly — and the STABLE-PARTIAL poll below is the thing that actually has to work: it does not
   * ask "did the right event fire", only "has anything changed", which is answerable regardless of
   * what Rust does or doesn't emit, in what order, or whether IPC delivers it at all.
   *
   * THE STABLE-PARTIAL POLL watches two things no capture path can hide behind, and BOTH are signals
   * only dictation can move: `committedSeq` (bumped by useDictation's `dictation://partial` handler
   * — the one event meaning "the engine produced text") and the live interim (cloud only, catching
   * "still actively transcribing, not committed yet" before it commits at all).
   *
   * It used to watch the COMPOSER'S TEXT, and that was wrong for a reason worth keeping written
   * down: the composer's text also moves when the USER TYPES. The wait routinely runs for seconds
   * with the key released and the box focused, so a keystroke during it restarted the quiet clock
   * and settled the drain on top of a decode still in flight (roborev 57295).
   * {@link QUIET_WINDOW_MS} of neither changing is treated as settled. Whichever race wins —
   * `owed` reaching zero, or the poll finding quiet — calls the same `settle()`, so there is exactly
   * one send regardless of which signal got there first.
   *
   * WE ONLY WAIT WHEN SOMETHING IS ACTUALLY OUTSTANDING — a hold that captured no audio at all
   * (`utterance.owed` stays `0`) never enters the wait.
   *
   * THE MACROTASK IS STILL LOAD-BEARING. `submit` reads `text` from React state as of the last
   * render, so the insert triggered by the preceding `dictation://partial` needs its RE-RENDER to
   * have flushed. A microtask is not enough (roborev 56078), so this yields a full macrotask after
   * a settle before sending.
   *
   * THE CAP IS A BACKSTOP, NOT A POLICY, and ON EXPIRY IT SENDS. If nothing ever settles — a dropped
   * socket, a capture torn down mid-utterance, content that never stops trickling in — the message
   * must not be stranded, so after {@link PARTIAL_SETTLE_CAP_MS} it sends what is in the box.
   * Reaching the cap means a possibly truncated phrase went out, which is still strictly better than
   * swallowing the message; losing his words is the failure being fixed here and must never be the
   * timeout's behaviour.
   *
   * THE MIC IS DROPPED AFTER THE SEND, not before, and that ordering is load-bearing on this path:
   * `paused` stops routing, so tearing the mic down first can be what prevents the very transcript
   * we are waiting for from ever landing.
   */
  const endHold = useCallback(
    (outcome: HoldOutcome) => {
      const send = outcome === "send";
      // WAIT FOR THE WORDS unless the gesture was aborted. `keep` drains exactly as `send` does and
      // differs only in what happens at the end of the wait — see the `HoldOutcome` doc.
      const drain = outcome !== "abandon";
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
      if (!drain || !utterance.current || utterance.current.owed <= 0) {
        finish();
        return;
      }
      // THREE RACES END THIS WAIT — the engine's own close, the stable-partial poll finding quiet,
      // and the cap expiring — and each needs a handle on the others to tear them all down together.
      // Held in one object rather than several `let`s so nothing can be read before it is assigned,
      // with `settled` making the teardown idempotent: more than one race can fire in the same turn
      // (the poll and the cap, if the last tick lands exactly on the boundary), and finishing twice
      // would send the message twice.
      const wait: {
        timer?: ReturnType<typeof setTimeout>;
        poll?: ReturnType<typeof setInterval>;
        unsub?: () => void;
        settled?: boolean;
      } = {};
      const settle = () => {
        if (wait.settled) return;
        wait.settled = true;
        if (wait.timer) clearTimeout(wait.timer);
        if (wait.poll) clearInterval(wait.poll);
        wait.unsub?.();
        finish();
      };
      // ── RACE 1: THE ENGINE'S OWN CLOSE — an optimization, not the safety net. See the doc above. ─
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
      // ── RACE 2: THE STABLE-PARTIAL POLL — the one that has to work regardless of what Rust does. ─
      // A plain interval, not a store subscription — and the reason changed with the signal. It used
      // to be "the composer's text is React state, so there is nothing to subscribe to"; both inputs
      // now live in `dictationStore` and could be subscribed. The interval stays because this has to
      // notice the ABSENCE of change over a window, which no change-notification can deliver: a
      // subscriber that stops firing sends nothing, and "nothing" is exactly the event we need.
      // ── THE ARRIVAL SIGNAL IS ONE ONLY DICTATION CAN MOVE (roborev 57295) ────────────────────
      // This used to watch the composer's own text, which cannot tell a transcript from a USER
      // KEYSTROKE. The wait routinely runs for seconds with the key released and the composer
      // focused, so typing during it is ordinary — and one character restarted the quiet clock,
      // settled the drain ~500ms later, and stranded the tail that landed afterwards in a composer
      // whose message had already gone out. The same truncation as 57274/57281/57287, reached
      // through the single gate the seed's removal made load-bearing.
      //
      // `committedSeq` is bumped only by useDictation's `dictation://partial` handler, and `interim`
      // only by the cloud preview. A keystroke moves neither, so it resets nothing and the wait
      // falls to the cap — the trade every one of these fixes has chosen.
      let lastCommitted = useDictationStore.getState().committedSeq;
      let lastInterim = useDictationStore.getState().interim;
      // ── ALWAYS null: the quiet clock starts ONLY on a POST-RELEASE ARRIVAL ────────────────────
      // Three revisions of this seed were wrong in the same direction, each one narrower than the
      // last, so the rule is now the simple one with no seed at all:
      //   1. `Date.now()` — settled 500ms after release on a pending decode (roborev 57274).
      //   2. non-empty box — same bug whenever a TYPED draft was present (roborev 57281).
      //   3. changed-since-hold-start — same bug for MULTI-CLAUSE speech, the ordinary case:
      //      "let's ship the feature" commits during the hold, "by friday" is still decoding at the
      //      keyup, so the box HAS changed, the clock starts at the release, and the poll ships the
      //      prefix (roborev 57287).
      //
      // What they share is measuring quiet from a moment when nothing has been heard from yet. And
      // this poll is reachable ONLY with a run still outstanding — `endHold`'s fast path returns
      // early on `owed <= 0` — so "we are already waiting on something" is the premise, which makes
      // treating the release itself as quiet indefensible in every one of these shapes.
      //
      // A hold whose transcript never lands now falls to the cap. That is the same trade every one
      // of these fixes made: slower is strictly better than truncated.
      let quietSince: number | null = null;
      wait.poll = setInterval(() => {
        const { committedSeq: committedNow, interim: interimNow } = useDictationStore.getState();
        if (committedNow !== lastCommitted || interimNow !== lastInterim) {
          // Something landed or is actively being previewed — the clock (re)starts from here.
          lastCommitted = committedNow;
          lastInterim = interimNow;
          quietSince = Date.now();
          return;
        }
        // ── "NOTHING HAS ARRIVED YET" IS NOT "QUIET" (roborev 57274, High) ────────────────────────
        // This poll started its clock at the RELEASE and settled on 500ms of no-change, which on the
        // on-device path is the state a PENDING DECODE looks like: there is no interim at all there,
        // and no committed segment lands until the decode finishes. So the poll fired at T+500ms
        // for a decode the source's own doc describes as running "hundreds of ms to seconds" behind
        // the audio — sending the short box and stranding the segment that arrived at T+800ms. It
        // reintroduced the exact truncation this whole mechanism exists to fix, and raising the cap
        // to 4s could not help because the poll always won the race first.
        //
        // So the quiet window is measured from the FIRST POST-RELEASE ARRIVAL, never from the
        // release itself: until something lands there is no quiet period, because we never left the
        // gap. `quietSince` stays null and this poll simply does not settle.
        //
        // DELIBERATELY NOT ALSO GATED ON `owed > 0`. That was tried and is wrong: this poll exists
        // precisely to work WITHOUT the engine-close bookkeeping — the founder tested a build whose
        // drain was fully engine-close-based and it still truncated — so blocking it on that debt
        // makes the primary mechanism depend on the signal it was written to route around. Two rows
        // in this file ("with no help from speechEnds") assert that independence directly.
        //
        // The cap remains the backstop for "nothing ever arrives at all".
        if (quietSince === null) return;
        if (Date.now() - quietSince >= QUIET_WINDOW_MS) settle();
      }, STABLE_PARTIAL_POLL_MS);
      // ── RACE 3: THE CAP — the absolute ceiling if NEITHER of the above ever resolves. ────────────
      wait.timer = setTimeout(settle, PARTIAL_SETTLE_CAP_MS);
      settling.current = () => {
        wait.settled = true; // cancelled, so none of the three races may finish
        if (wait.timer) clearTimeout(wait.timer);
        if (wait.poll) clearInterval(wait.poll);
        wait.unsub?.();
        settling.current = null;
        stopUtteranceWatch();
      };
    },
    [applyIntent, stopUtteranceWatch],
  );

  // ── IS THE KEY DOWN RIGHT NOW ────────────────────────────────────────────────────────────────
  //
  // THE FOUNDER'S REPORT, twice: "When I hit the command key to use the push to talk, it should show
  // as a fully pressed button, but it doesn't … It doesn't look any different than it does when it's
  // in standby mode."
  //
  // The tray drew TWO states where there are THREE: not-selected, selected-and-armed, and
  // selected-and-CAPTURING. The amber outline meant "Push to talk is the chosen mode" and was shown
  // whether or not the key was held, so a live microphone and an idle one looked identical.
  //
  // OWNED HERE, NOT IN `usePushToTalk`. That hook deliberately returns nothing, and its reason is
  // sound — a `held` flag returned from the binder would be a SECOND copy of a fact its caller's
  // callbacks establish, and two sources for one state is how a stuck-hot microphone happens. This
  // is not a second source: this hook is where `onHoldStart` / `onHoldEnd` / `onAbandon` already
  // converge, so the flag is set on the same three edges that drive the MIC ITSELF (`applyIntent`).
  // ── WHAT THIS FLAG IS, AND WHAT IT IS NOT (roborev 57302) ──────────────────────────────────────
  // It tracks THE GESTURE — is the key or button down right now — and the founder specified exactly
  // that: the pill fills "when I'm actually pushing on the button, or when I'm using the hot key",
  // and clears the instant he releases.
  //
  // IT IS NOT "the microphone is live". Those coincided while the keyup stood the mic down, and they
  // no longer do: with the truncation drain on this branch, a release with an outstanding run leaves
  // the mic at `pttHeldIntent` until `finish()` runs — up to PARTIAL_SETTLE_CAP_MS (4s) later. An
  // earlier version of this comment claimed the two were one fact; that was true when it was
  // written and is now false, so it is corrected rather than left to mislead.
  //
  // The mic's own truth is drawn where it is known: the sidebar ring derives from actual capture
  // (voice/micPresentation), which is the surface that answers "is the mic taking my voice".
  const [held, setHeld] = useState(false);

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
      setHeld(true);
      applyIntent(pttHeldIntent());
    }, [applyIntent, startUtteranceWatch]),
    // CLEARED ON THE KEYUP, which is the gesture ending — NOT on the mic standing down. Those are
    // different moments now: `endHold` may install the drain and leave the microphone live for up to
    // PARTIAL_SETTLE_CAP_MS while it waits for the tail of the utterance to arrive. Clearing here is
    // correct for what this flag means (see its declaration), and the drain window's own honesty is
    // the mic ring's job, not the pill's.
    onHoldEnd: useCallback(() => {
      setHeld(false);
      // ── THE PUSH-TO-TALK AUTO-SEND SWITCH DECIDES *DISPATCH*, NEVER *DRAIN* (sparkle-bbfsx) ────
      // "keep" is not "abandon", and collapsing the two would silently truncate his words. A
      // release still has to wait for the tail of the utterance to arrive — that wait is the whole
      // subject of `endHold`'s doc, and the microphone is deliberately dropped only AFTER it — so
      // with the switch off the drain runs exactly as before and only the `onSend` call is
      // withheld. `endHold(false)` skips the wait entirely, which is right for a gesture the user
      // aborted and wrong for one whose words they want to keep and edit.
      //
      // READ FROM THE STORE, not from a hook subscription: this callback is registered with the
      // key listener and must see the value AS OF THE RELEASE, not as of the render that bound it.
      endHold(useUiStore.getState().conciergePttAutoSend ? "send" : "keep");
    }, [endHold]),
    // ABANDON SENDS NOTHING — see usePushToTalk's header on ⌘Tab never delivering its keyup. It
    // still has to clear the indicator, or a ⌘Tab away leaves the tray painting a pressed button
    // over a microphone that was stood down: the precise "held but idle" lie this exists to remove.
    onAbandon: useCallback(() => {
      setHeld(false);
      endHold("abandon");
    }, [endHold]),
  });

  // NO SEPARATE GUARD FOR "the mode changed mid-hold", and the reason is worth recording because an
  // earlier revision of this file added one on a WRONG reading of the binder (roborev 57285).
  //
  // That guard claimed `usePushToTalk` abandons "through its OWN cleanup, which does not run our
  // `onAbandon`". It does not: its cleanup only removes listeners, and the abandon happens in the
  // EFFECT BODY — `if (!active || inert) { … cbs.current.onAbandon() }`. So flipping the mode or
  // going inert mid-hold already routes through `onAbandon` above, which is where `setHeld(false)`
  // lives. The extra effect was unreachable, and its comment would have had the next reader planning
  // against a cleanup behaviour that does not exist.

  return {
    mode,
    setMode,
    inert,
    // A countdown must not run against a microphone that is not being heard. `armed` is what the
    // host hands voice/useAutoSend, so an inert tray stops counting rather than counting invisibly
    // and firing when colour returns.
    armed: mode === "speak" && !inert,
    // NOT gated on `inert`, and NOT collapsed with "is this Speak": a terminal focus greys the tray
    // but does not un-choose a setting, and the countdown is already stopped there by `armed`. WHERE
    // the toggle is shown is ComposeBox's question, answered from the pure `modeHasAutoSend`.
    //
    // ── ONE PAIR OF FIELDS, RESOLVED PER POSITION (sparkle-bbfsx) ──────────────────────────────
    // The tray now has two Auto-send settings behind one control, so this resolves which one the
    // CURRENT position means. Exposing both and letting the consumer pick would put the resolution
    // in the surfaces — and the countdown reads `autoSend` too (voice/useAutoSend), so a surface
    // that picked wrong would silently govern the wrong dispatch. `speak` is the fallback for a
    // position with no setting of its own (`send`), where nothing reads it anyway.
    autoSend: mode === "ptt" ? pttAutoSend : speakAutoSend,
    setAutoSend: mode === "ptt" ? setPttAutoSend : setSpeakAutoSend,
    /** Is the push-to-talk key down RIGHT NOW — i.e. is the microphone actually capturing?
     *  Distinct from `mode === "ptt"`, which only says the position is selected. */
    held,
  };
}
