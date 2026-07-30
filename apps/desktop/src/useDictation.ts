import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useDictationStore } from "./stores/dictationStore";
import { useSettingsStore } from "./stores/settingsStore";
import { useAiFeature, aiFeatureNow } from "./services/aiGate";
import { useAuthStore } from "./stores/authStore";
import { advance, type Advance } from "./voice/wakeMachine";
import { openCloudDictationWindow, nextBalanceCents } from "./services/cloudDictation";
import { safeUnlisten } from "./services/safeUnlisten";
import { selectedProjectName } from "./services/creditProject";
import { classifyVoiceError } from "./voice/dictationCopy";
import {
  armedStatus,
  dictationPauseReason,
  focusOwnerNow as readFocusOwnerFromDom,
  type FocusOwner,
  type PauseReason,
} from "./voice/dictationFocus";

/**
 * The cloud-stream command (if any) a wake-machine transition implies. Pure so the
 * "local gate, then stream" wiring is unit-testable without the hook: only a *transition*
 * acts — entering ACTIVE opens the Deepgram stream, returning to PASSIVE closes it. A segment
 * that merely inserts text (no phase change) leaves the stream as-is.
 */
export function cloudStreamCommandFor(
  r: Advance,
): "start_cloud_stream" | "stop_cloud_stream" | null {
  if (!r.transitioned) return null;
  return r.phase === "active" ? "start_cloud_stream" : "stop_cloud_stream";
}

// ---------------------------------------------------------------------------
// Controller factory
//
// Extracted so it can be instantiated without React (e.g. in tests) and also
// used by useAmbientVoice.  Returns `{ toggle, cleanup }`.
// ---------------------------------------------------------------------------

interface DictationOptions {
  onSegment: (text: string) => void;
  /** Called on focus REGAIN when a dictation session is still ACTIVE (phase === "active"), so the
   *  cloud stream resumes without the user re-saying the wake word. Optional (tests may omit it). */
  onResumeActive?: () => void;
  /** True when THIS window is the active/focused OS window. The backend broadcasts every
   *  `dictation://*` event to ALL Sparkle windows (focus is tracked app-globally — see
   *  dictation.rs), so without this gate the same dictated phrase types into every open window's
   *  composer at once. Each Tauri window is its own webview, so `document.hasFocus()` is true in
   *  exactly the focused one. Injected so the multi-window routing is unit-testable; defaults to a
   *  real `document.hasFocus()` check (and `true` in the document-less test/node env). */
  isWindowActive?: () => boolean;
  /** WHO holds the DOM caret right now — the sibling of `isWindowActive` for focus WITHIN this
   *  window. Injected for the same reason: the node/test env has no real caret to move, and the
   *  listener must not reach into the store to re-derive a decision that lives in one pure place.
   *  Defaults to classifying the LIVE `document.activeElement`, which is race-free by construction
   *  (nothing can be stale about reading the DOM at the moment the event arrives). */
  focusOwner?: () => FocusOwner;
}

interface DictationController {
  toggle: () => Promise<void>;
  cleanup: () => void;
  /** Drive the caret-owner transition within this window: "terminal" = the caret moved INTO a
   *  terminal pane (pause, mirroring a window blur), anything else = it left one (resume, through
   *  the same guard a window refocus uses). Wired to the focus tracker's store field in a real
   *  webview; exposed so the terminal handoff is unit-testable without a DOM. */
  notifyFocusOwner: (owner: FocusOwner) => void;
  /** Drive the per-WINDOW OS-focus transition for THIS window (not the app-level `dictation://focus`,
   *  which never fires on a window-to-window switch — see dictation.rs `set_focused`). Wired to the
   *  DOM `window` focus/blur events in a real webview; exposed so the multi-window ownership handoff is
   *  unit-testable in the (window-less) node env. `false` = this window lost OS focus; `true` = regained. */
  notifyWindowFocus: (focused: boolean) => void;
}

/**
 * Registers Tauri event listeners for all `dictation://*` events and returns
 * a controller with `toggle()` and `cleanup()`.
 *
 * Suitable for use from tests or from useAmbientVoice.
 */
export async function createDictationController(
  options: DictationOptions,
): Promise<DictationController> {
  // Keep a stable reference to the callback so callers can swap it out
  // without recreating the controller (mirrors the useRef pattern in the hook).
  const onSegment = options.onSegment;
  const onResumeActive = options.onResumeActive;
  // Only the focused window should consume the (app-broadcast) committed text + live preview, so a
  // phrase doesn't land in every open window at once. Default to a real per-window focus check.
  const isWindowActive =
    options.isWindowActive ?? (() => typeof document === "undefined" || document.hasFocus());
  // Who holds the caret. Read LIVE from the DOM by default (see the option's doc) — the store's
  // `focusOwner` mirror exists for the COPY, which needs to be reactive; routing needs to be right.
  const focusOwnerNow = options.focusOwner ?? readFocusOwnerFromDom;

  // --- THE ONE GATE ------------------------------------------------------------------------------
  // Every routed `dictation://*` event asks THIS question and no other: "may dictation route here
  // right now?" It used to ask only `isWindowActive()`, which is why the terminal case half-happened
  // — transcription kept flowing into a composer the user couldn't see while the auto-send rail,
  // reading a different signal, never armed. Widening the ONE predicate rather than adding a second
  // check per listener is what makes "arming and transcription can never disagree about the active
  // target" STRUCTURALLY true instead of merely tested: `dictation://speech-end` (the rail's clock)
  // and `dictation://partial` (the text) are gated by the same expression, evaluated at the same
  // instant, so there is no state in which one passes and the other doesn't.
  //
  // `isWindowActive()` stays as its own term: it is the per-WINDOW ownership signal (which of our
  // webviews consumes the app-wide broadcast), while dictationPauseReason answers the user-facing
  // "is dictation paused, and why". They coincide on the window axis but are not the same question,
  // and only the first is meaningful while the mic is disarmed.
  const focusPauseReason = (): PauseReason | null =>
    dictationPauseReason({
      windowFocused: isWindowActive(),
      focusOwner: focusOwnerNow(),
      enabled: useDictationStore.getState().enabled,
    });
  const isRoutable = () => isWindowActive() && focusPauseReason() === null;

  const { setLevel, setSpeaking, setError, setModelProgress } =
    useDictationStore.getState();

  // --- Per-window cloud-stream ownership (sparkle-ozvr) ------------------------------------------
  // The billable Deepgram relay is a single backend resource, but it is logically OWNED by the one
  // window that drove the wake word — i.e. the window whose OWN per-window store has `phase: "active"`.
  // Committed partials route by focus (isWindowActive), but ownership lived only in the old window's
  // store, and `dictation://focus` fires only on APP-level focus flips — never on a window-to-window
  // switch (dictation.rs keeps `focused` true while any Sparkle window is up). So saying "Hey Sparkle"
  // in window A then switching to window B left A's relay streaming (and billing) until a stop word or
  // timeout, while B (still PASSIVE) inserted nothing. Fix: tie the relay's lifetime to whether the
  // owner window is the focused dictation target — tear it down when the owner loses focus, and resume
  // it when the owner regains focus (the session follows its window).
  //
  // `true` once this window has torn its relay down and is waiting to resume on refocus. Guards resume
  // so it only fires after a real teardown (never spuriously re-opens an already-running stream).
  let streamTornDown = false;

  // Close THIS window's relay when it stops being the focused dictation target. Only the OWNER (its own
  // phase is ACTIVE) has a billable stream to close; a passive/background window is a no-op. Phase is
  // intentionally RETAINED so refocusing the owner resumes without a re-said wake word.
  const tearDownOwnedStream = () => {
    const store = useDictationStore.getState();
    if (store.phase !== "active") return;
    invoke("stop_cloud_stream").catch(() => {});
    streamTornDown = true;
    store.setInterim("");
    store.setLevel(0);
    store.setSpeaking(false);
    // CLEARED WITH IT, ALWAYS. `onDeviceSpeech` is a LATCH fed only by edges from a LIVE capture,
    // and Rust's edge state is per-capture starting false — so a capture torn down while it is true
    // emits no falling edge, and a rebuilt capture computing false sees no change and emits nothing
    // either. Left set, `useAutoSend` reads "the user is still talking" forever: startClock
    // early-returns on every speech-end and auto-send never fires again for the whole session.
    // Capture is not running in any of these states, so the level is false by definition.
    store.setOnDeviceSpeech(false);
  };

  // Resume THIS window's relay when it (re)gains focus mid-session. Guarded so ONLY the focused
  // (isWindowActive) window that owns a torn-down ACTIVE session reopens the stream — a backgrounded
  // stale-active window must never grab the single cloud stream on an app-level refocus. The short
  // cooldown de-dupes the DOM-focus and app-level `dictation://focus` signals that both fire when the
  // whole app is re-focused (only one reopen).
  let lastResumeAt = 0;
  const maybeResumeOwnedStream = () => {
    if (!streamTornDown) return;
    const now = Date.now();
    if (now - lastResumeAt < 300) return;
    const store = useDictationStore.getState();
    // `isRoutable()`, not a bare `isWindowActive()`: a window that is focused but whose caret sits
    // in a terminal is NOT somewhere the relay may resume into. Same predicate as the listeners, so
    // the relay can never be open in a state where the events it produces would be dropped.
    if (!isRoutable() || !store.enabled || store.status === "error" || store.phase !== "active") {
      return;
    }
    lastResumeAt = now;
    streamTornDown = false;
    store.setStatus("listening");
    onResumeActive?.();
  };

  // Per-WINDOW OS-focus transition (DOM window focus/blur), the signal the app-level event misses on a
  // window-to-window switch. Exposed on the controller so it is unit-testable without a real webview.
  const notifyWindowFocus = (focused: boolean) => {
    if (focused) maybeResumeOwnedStream();
    else tearDownOwnedStream();
  };

  // The caret moved into (or out of) a terminal pane inside THIS window. Deliberately the SAME
  // shape as a window blur/refocus, because to the user it is the same event: something else took
  // the keyboard, so Sparkle stops listening until they come back to the box.
  //
  // What it does NOT touch, exactly as the window path doesn't: `enabled` (the mic stays armed —
  // this is a gate on top of the mute toggle, not the toggle) and `phase` (an ACTIVE "Hey Sparkle"
  // session must survive clicking into a terminal and back without re-saying the wake word).
  const notifyFocusOwner = (owner: FocusOwner) => {
    const store = useDictationStore.getState();
    if (owner === "terminal") {
      // Close the BILLABLE relay first (no-op unless this window owns one), then flatten the live
      // UI. Status → idle is what both mic surfaces read as "focus paused", so the ring and the
      // composer stop claiming to listen at the same instant the gate stops routing.
      tearDownOwnedStream();
      store.setInterim("");
      store.setLevel(0);
      store.setSpeaking(false);
      store.setOnDeviceSpeech(false);
      if (store.status !== "error") store.setStatus("idle");
      return;
    }
    // Left the terminal. Resume through the SAME guard a window refocus uses (streamTornDown +
    // maybeResumeOwnedStream) rather than a second resume path, so the two can't drift: only a
    // window that actually tore a stream down reopens one, and only once.
    if (store.enabled && store.status !== "error" && isRoutable()) {
      store.setStatus("listening");
      maybeResumeOwnedStream();
    }
  };

  // Register event listeners — each `listen()` returns an unsubscribe fn.
  const unsubscribes = await Promise.all([
    listen<string>("dictation://partial", (e) => {
      // THE ONE GATE (see isRoutable). Committed text must land in exactly one place: the focused
      // window, and only while dictation is routable there. Background windows bail — otherwise the
      // same phrase types into every open window's composer — and so does a window whose caret sits
      // in a terminal, where the composer the text would land in isn't the thing the user is typing
      // into at all.
      if (!isRoutable()) return;
      // Capture started — clear any lingering model-download progress.
      useDictationStore.getState().setModelProgress(null);
      // A committed (final) segment supersedes the live preview — clear it so the interim text
      // doesn't briefly double up with the text that's about to land in the box.
      useDictationStore.getState().setInterim("");
      onSegment(e.payload);
    }),

    // Cloud-only: Deepgram interim results — the live, word-by-word preview. Volatile; replaced in
    // place and never routed through the wake machine (that only acts on committed segments).
    listen<string>("dictation://interim", (e) => {
      // Same ONE GATE as the partial path: only a window dictation may route into paints the live
      // ghost. Anywhere else clears any stale preview it might still be showing and ignores the
      // rest — a ghost left up in a terminal-paused composer would advertise a live transcription
      // that is not happening.
      if (!isRoutable()) {
        useDictationStore.getState().setInterim("");
        return;
      }
      useDictationStore.getState().setInterim(e.payload);
    }),

    // The cloud (relay) worker exited — clean close, a mid-stream failure, OR the relay signalling
    // out-of-credits (payload `exhausted`). Clear the stale interim ghost and call stop_cloud_stream,
    // which flips cloud_active off so the capture callback resumes routing frames to the on-device
    // model (seamless fallback; on a mid-stream death the on-device wake/stop-word path resumes
    // instead of dictation getting stranded). Idempotent on the normal stop path (cloud already torn
    // down). Metering is server-side now, so there's no client meter to stop here.
    listen<boolean>("dictation://cloud-ended", (e) => {
      useDictationStore.getState().setInterim("");
      invoke("stop_cloud_stream").catch(() => {});
      // Out-of-credits teardown → refresh the balance so the credits pill reflects the now-depleted
      // balance (the last relay `balance` frame was pre-decline). A clean close (payload false) skips
      // the round-trip.
      if (e.payload) void useAuthStore.getState().refresh();
    }),

    // The relay's per-minute `balance` control frame (server-authoritative). Cloud metering lives on
    // the server now, so this is how the credits pill ticks down in real time: prefer the server's
    // post-debit balance, optimistically decrement by the debited amount when it's absent. Broadcast
    // to every window (they all show the same balance), so no per-window focus gate is needed.
    listen<{ balanceCents: number | null; debitedCents: number }>(
      "dictation://cloud-balance",
      (e) => {
        const { me, setMe } = useAuthStore.getState();
        if (!me) return;
        const { balanceCents, debitedCents } = e.payload;
        // setMe, not setState: this frame carries a real balance change, and setMe is the seam that
        // re-arms a dismissed $0 banner when the balance crosses back above zero (roborev 48271).
        setMe({
          ...me,
          balanceCents: nextBalanceCents(me.balanceCents, balanceCents, debitedCents),
        });
      },
    ),

    listen<number>("dictation://level", (e) => {
      // THE ONE GATE: broadcast to EVERY window, but only one dictation may route into drives the
      // waveform — without it a background window animates its meter off another window's capture
      // (sparkle-ozvr), and a terminal-paused one animates a meter for speech it is discarding.
      if (!isRoutable()) return;
      // Capture started — clear any lingering model-download progress. This fires ~25×/sec, so
      // only write when there's actually progress to clear; an unconditional set(null) would churn
      // the store (and every subscriber) 25 times a second for a no-op.
      const dict = useDictationStore.getState();
      if (dict.modelProgress !== null) {
        dict.setModelProgress(null);
      }
      setLevel(e.payload);
    }),

    // Real-time voice-activity edge from the Silero VAD (rising/falling only, not per-frame).
    // The waveform animates only while this is true, so the meter sits flat in silence instead
    // of wiggling on ambient noise. `level` still drives bar HEIGHT; this gates the MOTION.
    listen<boolean>("dictation://speaking", (e) => {
      // Same ONE GATE as the level meter: only a window dictation may route into animates its
      // waveform, so it never wiggles off voice activity it is not consuming (sparkle-ozvr).
      if (!isRoutable()) return;
      setSpeaking(e.payload);
    }),

    // THE SPEAKER STOPPED — Deepgram's own endpoint decision (`speech_final`, or the standalone
    // `UtteranceEnd` frame), which is what the auto-send rail measures its silence against.
    //
    // Registered next to the partial/interim handlers on purpose: it belongs to the same utterance
    // they carry, and it MUST ride the very same gate expression. Without that a background window
    // would count down and fire a send off a phrase that was typed into another window's composer —
    // the same "one phrase, every window" bug the partial gate exists to stop (sparkle-ozvr),
    // except this one presses Send. Sharing `isRoutable()` with the partial listener is also what
    // closes the terminal half-state: there is no snapshot in which the text is being transcribed
    // but the rail isn't arming, or vice versa, because it is ONE predicate, not two agreeing ones.
    //
    // No payload: the event asserts only "as of now, speech has ended". The frontend already holds
    // a fresher transcript than any payload could carry.
    listen<null>("dictation://speech-end", () => {
      if (!isRoutable()) return;
      useDictationStore.getState().noteSpeechEnd();
    }),

    // THE COUNTDOWN'S CANCEL on the on-device path (see dictationStore.onDeviceSpeech). Rides the
    // SAME gate as the speech-end it cancels, which is the point: a window where the arm is
    // delivered but the cancel is not would be strictly worse than neither, since it can only fire
    // sends and never stop them.
    listen<boolean>("dictation://on-device-speech", (e) => {
      if (!isRoutable()) {
        // Not routable → nothing here can be counting, and a latched `true` would suspend the next
        // countdown that legitimately starts. Clear rather than ignore.
        useDictationStore.getState().setOnDeviceSpeech(false);
        return;
      }
      useDictationStore.getState().setOnDeviceSpeech(e.payload);
    }),

    listen<string>("dictation://error", (e) => {
      setModelProgress(null);
      setError(e.payload);
      // Record the dead-mic FAULT alongside the notice that reports it. STICKY, not assigned: an
      // earlier version wrote the boolean unconditionally, so any unrelated error landing between
      // the fault and its all-clear erased the fault, the recovery handler early-returned, and once
      // the user dismissed THAT notice the mic was drawn as paused over a live capture — the same
      // incident by a different route (roborev 55351). Only the recovery event, which is the only
      // positive evidence frames resumed, may clear it.
      if (classifyVoiceError(e.payload) === "no-audio") {
        useDictationStore.getState().setDeadMicSilent(true);
      }
    }),

    // The frame-liveness watchdog's all-clear: audio frames are arriving again after a stretch of
    // none. No payload — the event asserts only "as of now, frames are flowing".
    //
    // It clears the error ONLY when the notice currently on screen is the watchdog's own. The
    // backend emits this whenever frames resume, which includes resuming while some UNRELATED
    // failure is showing (a model-download error, a permission denial). A blanket `setError(null)`
    // there would wipe a failure that is still true and still needs the user — trading the bug
    // where the UI hid a dead mic for the bug where it hides a denied one. `classifyVoiceError` is
    // the same bucketing the notice itself renders from, so what we clear is exactly what the user
    // is looking at, and it stays correct if the backend rewords the watchdog sentence.
    listen<null>("dictation://audio-recovered", () => {
      const store = useDictationStore.getState();
      // Gate on the FAULT, not on the visible notice. Keying off `store.error` discarded the very
      // evidence this handler exists for whenever the user dismissed the notice first — and
      // dismiss-then-fix is the ordinary sequence: read the warning, close it, quit the screen
      // recorder, frames resume. That arrived here with `error === null`, early-returned, and left
      // a live capturing mic drawn as PAUSED for as long as the user stayed in the window (only an
      // app blur/refocus would have corrected it). The fault is not dismissible; the notice is.
      if (!store.deadMicSilent) return;
      store.setDeadMicSilent(false);
      // Clear the notice only if it is still up AND still the watchdog's own. With the fault now
      // sticky, this check is what keeps an UNRELATED failure on screen: the all-clear says frames
      // are flowing, which is no evidence at all about a failed model download or a denied
      // permission. Trading the bug where the UI hid a dead mic for the bug where it hides a denied
      // one would be no trade at all.
      if (store.error && classifyVoiceError(store.error) === "no-audio") setError(null);
      // Clearing the notice is only half the retraction. `setError(null)` moves status "error" →
      // "idle", but the mic never actually stopped: the watchdog fires MID-SESSION, so capture is
      // still live and `enabled` is still true. Left at idle, deriveMicState(enabled=true, "idle",
      // …) renders "paused" (MicButton.tsx) — a mic that has demonstrably recovered, drawn as if it
      // weren't listening, until the user cycles it by hand.
      //
      // THIS is the only place allowed to make that claim: the event is the sole positive evidence
      // that frames resumed. The notice's Dismiss buttons deliberately do NOT restore listening —
      // dismissing means "I've read this", not "the mic works again", and claiming it there would
      // paint a live mic over a still-dead one. Understating (paused) is the safe direction;
      // overstating rebuilds the incident.
      //
      // Gated on `enabled` so recovery can never un-mute a mic the user muted while the fault was
      // showing, and on focus because this notice's own remedy sends the user to System Settings →
      // Sound, which BLURS Sparkle: frames can resume while we are unfocused and not capturing, and
      // the dictation://focus(true) handler below already restores listening on refocus.
      // …and only when NO notice is left standing. Reading the store fresh, because setError above
      // just wrote to it. A surviving unrelated error means some other thing is still broken, and
      // "listening" would paint over it — the same overstatement, one failure across.
      // …and only if the caret is somewhere dictation may actually route. The sibling
      // dictation://focus(true) handler below carries this same term; without it here, a watchdog
      // fault that recovers while the caret sits in a terminal flips the UI back to claiming live
      // capture while the gate keeps discarding every event — the same contradiction by a second
      // path (roborev 55497). `focusOwnerNow()` rather than the full `isRoutable()` for the reason
      // given at that handler: the window term is already checked here.
      if (
        useDictationStore.getState().error === null &&
        store.enabled &&
        isWindowActive() &&
        focusOwnerNow() !== "terminal"
      ) {
        store.setStatus("listening");
      }
    }),

    // App-level window focus changed (sparkle-9oz6). The backend has already released or rebuilt the
    // OS mic; here we keep the frontend's billable/UI state consistent. `false` = no Sparkle window is
    // the active OS window (the user tabbed to another app): stop the per-minute cloud meter and close
    // the Deepgram socket so tabbing away mid-dictation can't keep billing, and clear the live
    // preview/level. We deliberately DON'T touch `enabled` (the mic stays armed) NOR `phase`: an
    // ACTIVE "Hey Sparkle" session must survive tabbing away and back so the user never has to
    // re-say the wake word — it simply stops writing/billing while unfocused. `true` = focus
    // returned: reflect listening again, and resume the cloud stream if we were mid-dictation.
    listen<boolean>("dictation://focus", (e) => {
      const store = useDictationStore.getState();
      if (!e.payload) {
        invoke("stop_cloud_stream").catch(() => {});
        // The relay is now closed; arm the owner-resume guard so refocus reopens it exactly once.
        streamTornDown = true;
        store.setInterim("");
        store.setLevel(0);
        // Capture is paused — no more frames, so clear the VAD flag ourselves (the backend
        // emits edges only while capturing) to freeze the waveform flat while unfocused.
        store.setSpeaking(false);
        store.setOnDeviceSpeech(false);
        if (store.status !== "error") store.setStatus("idle");
      } else if (store.enabled && store.status !== "error" && focusOwnerNow() !== "terminal") {
        // `focusOwnerNow() !== "terminal"`, not the full `isRoutable()`: this event IS the app
        // telling us focus returned, and `document.hasFocus()` can still be false for a beat when
        // it arrives — gating on the window term would drop the very signal it is reporting. The
        // terminal term has no such race (the caret is wherever it is), and without it, returning
        // to the app with the caret parked in a terminal would flip the UI back to "listening"
        // while the gate above keeps discarding every event — the exact half-state this fixes.
        store.setStatus("listening");
        // Mid-dictation when focus left → resume the cloud stream now, no wake word needed. Routed
        // through the owner guard so only the FOCUSED window (not a background stale-active one)
        // reopens the single stream, and so it can't double-open with the DOM-focus signal.
        maybeResumeOwnedStream();
      }
    }),

    // [doneBytes, totalBytesOrNull]
    listen<[number, number | null]>("dictation://model-progress", (e) => {
      const [done, total] = e.payload;
      // Clear on completion so the UI doesn't linger on "Downloading… 100%".
      setModelProgress(total !== null && done >= total ? null : { done, total });
    }),
  ]);

  // Wire the per-window OS focus/blur to the ownership handoff. Each Tauri window is its own webview,
  // so its DOM `window` focus/blur fires on window-to-window switches WITHIN the app — the gap the
  // app-level `dictation://focus` never covers (sparkle-ozvr). Guarded for the window-less test/node
  // env (tests drive `notifyWindowFocus` directly instead).
  const hasWindow = typeof window !== "undefined" && typeof window.addEventListener === "function";
  const onWinBlur = () => notifyWindowFocus(false);
  const onWinFocus = () => notifyWindowFocus(true);
  if (hasWindow) {
    window.addEventListener("blur", onWinBlur);
    window.addEventListener("focus", onWinFocus);
  }

  // Caret-owner transitions arrive through the store, which the app-root focus tracker
  // (voice/dictationFocusTracker) is the sole writer of. Subscribing HERE rather than wiring it
  // through useAmbientVoice keeps the terminal handoff working for every controller instance —
  // including the ones created directly by tests — and means there is exactly one place that turns
  // "the caret moved" into "tear the relay down". Only real CHANGES act; the store setter already
  // suppresses no-op writes, and this second guard makes the handler idempotent against any other
  // store update.
  const unsubscribeFocusOwner = useDictationStore.subscribe((s, prev) => {
    if (s.focusOwner !== prev.focusOwner) notifyFocusOwner(s.focusOwner);
  });

  const cleanup = () => {
    // safeUnlisten (not a bare `u()`): a window-close during teardown can tear down Tauri's
    // listeners map first, and a raw unlisten then throws the benign "handlerId" race. Routing
    // each call through it also means a throw can't abort the loop and leak the remaining
    // dictation listeners OR the window blur/focus removals below (sparkle teardown-leak sweep).
    unsubscribes.forEach((u) => void safeUnlisten(u));
    unsubscribeFocusOwner();
    if (hasWindow) {
      window.removeEventListener("blur", onWinBlur);
      window.removeEventListener("focus", onWinFocus);
    }
  };

  const toggle = async () => {
    const state = useDictationStore.getState();
    if (state.status === "listening") {
      // stop_dictation tears down any live relay stream in Rust, which stops server-side metering.
      await invoke("stop_dictation");
      state.setModelProgress(null);
      // The capture the fault described is gone, so the fault goes with it — otherwise a stale
      // `deadMicSilent` could let a later recovery event claim "listening" for a session that
      // no longer exists.
      state.setDeadMicSilent(false);
      state.setStatus("idle");
      state.setLevel(0);
      state.setSpeaking(false);
      state.setOnDeviceSpeech(false);
      state.setInterim("");
    } else {
      state.setError(null);
      // Not a bare "listening": see armedStatus. Arming with the caret already in a terminal must
      // read as paused-with-a-reason, not as an invitation to talk into a gate that drops everything.
      state.setStatus(armedStatus(focusOwnerNow()));
      try {
        // The cloud-dictation preference is read LIVE at the wake→active transition (start_cloud_stream),
        // not frozen here, so toggling the menu mid-session takes effect without restarting.
        await invoke("start_dictation");
      } catch (e) {
        state.setModelProgress(null);
        state.setError(String(e));
      }
    }
  };

  return { toggle, cleanup, notifyWindowFocus, notifyFocusOwner };
}

// ---------------------------------------------------------------------------
// App-level ambient hook
// ---------------------------------------------------------------------------

/**
 * App-level always-listening controller. Mount ONCE at the app root.
 *
 * Wires the on-device dictation pipeline to the wake-word phase machine:
 * every closed VAD segment runs through advance(); in PASSIVE we only watch
 * for the wake word, in ACTIVE we route speech into the active composer.
 * `enabled` (the mute toggle) starts/stops the underlying mic capture.
 */
export function useAmbientVoice(): void {
  const enabled = useDictationStore((s) => s.enabled);
  const cloudDictation = useAiFeature("voiceDictation");
  const aiComposer = useAiFeature("composer");

  // If the user turns voice dictation OR the composer off WHILE a cloud stream is open, close it
  // immediately rather than waiting for the stop word — otherwise a billable relay socket lingers
  // (and, with the composer off, streams into a sink that no longer renders). Closing the socket
  // stops the server-side meter. Idempotent; re-enabling reopens on the next wake.
  useEffect(() => {
    // Only when the mic is hot can a cloud stream be open, so gate on `enabled` to avoid a backend
    // round-trip on mount / benign re-renders when nothing is streaming.
    if (enabled && (!cloudDictation || !aiComposer)) {
      invoke("stop_cloud_stream").catch(() => {});
      useDictationStore.getState().setInterim("");
    }
  }, [enabled, cloudDictation, aiComposer]);

  // Open the cloud (relay) dictation window. Shared by BOTH the wake→active transition AND
  // focus-regain resume, so a "Hey Sparkle" session stays active across tabbing away and back
  // without re-saying the wake word. Gated on the live cloud-dictation prefs — a no-op when off, so
  // a signed-out / composer-off user never opens a stream. Metering + entitlement/affordability are
  // enforced SERVER-side by the relay: start_cloud_stream returns false when it refuses (stay
  // on-device), and mid-stream out-of-credits arrives via the cloud-ended event. Balance updates
  // arrive via the cloud-balance event (both wired in createDictationController above).
  const openCloud = useRef(() => {
    if (!(aiFeatureNow("composer") && aiFeatureNow("voiceDictation"))) return;
    void openCloudDictationWindow({
      // Metering-only: attributes the per-minute dictation debits to the project the user is
      // dictating into. Resolved at open time; undefined when no project is selected.
      startCloudStream: () =>
        invoke<boolean>("start_cloud_stream", { project: selectedProjectName() }),
      stopCloudStream: () => void invoke("stop_cloud_stream").catch(() => {}),
      isStillActive: () =>
        useDictationStore.getState().phase === "active" &&
        aiFeatureNow("composer") &&
        aiFeatureNow("voiceDictation"),
      clearInterim: () => useDictationStore.getState().setInterim(""),
    });
  });

  // Stable segment handler: runs the phase machine against the live store phase.
  const lastTransitionAt = useRef(0);
  const onSegment = useRef((seg: string) => {
    const store = useDictationStore.getState();
    // Read the configured words fresh each segment so a remap in Settings takes effect live.
    const { wakeWord, stopWord } = useSettingsStore.getState();
    const now = Date.now();
    const r = advance(store.phase, seg, { wakeWord, stopWord });
    // 750ms cooldown: ignore a *transition* that lands right after another one,
    // but still route inserts that don't change phase.
    if (r.transitioned && now - lastTransitionAt.current < 750) return;
    if (r.transitioned) {
      lastTransitionAt.current = now;
      store.setPhase(r.phase);
      // "Local gate, then stream": the wake word fires from the on-device model (passive). On
      // entering ACTIVE, meter + open the Deepgram stream; on returning to PASSIVE (stop word),
      // stop billing + close it and resume on-device wake-word listening.
      const cmd = cloudStreamCommandFor(r);
      if (cmd === "start_cloud_stream") {
        openCloud.current();
      } else if (cmd === "stop_cloud_stream") {
        // Closing the relay socket stops server-side metering; the trailing final still commits.
        invoke("stop_cloud_stream").catch(() => {});
      }
      if (r.phase === "passive") store.setInterim("");
    }
    if (r.insert) store.insert(r.insert);
  });

  // Register the dictation event listeners once.
  const controllerRef = useRef<DictationController | null>(null);
  // Holds the in-flight promise so the enabled effect can gate start_dictation
  // on listeners being fully attached (fix for startup race).
  const controllerPromiseRef = useRef<Promise<DictationController> | null>(null);
  useEffect(() => {
    let cancelled = false;
    const p = createDictationController({
      onSegment: onSegment.current,
      onResumeActive: () => openCloud.current(),
    });
    controllerPromiseRef.current = p;
    p.then((ctrl) => {
      if (cancelled) ctrl.cleanup();
      else controllerRef.current = ctrl;
    });
    return () => {
      cancelled = true;
      controllerRef.current?.cleanup();
      controllerRef.current = null;
      controllerPromiseRef.current = null;
    };
  }, []);

  // Start/stop the mic to match `enabled`.
  useEffect(() => {
    let activeRun = true;
    const store = useDictationStore.getState();
    if (enabled) {
      store.setError(null);
      // Optimistic: the real arm can be minutes of model download away, and a dead-looking button is
      // worse. KNOWN GAP: if that start aborts (a stop landed first), nothing retracts this — the
      // ring keeps claiming to listen until the else-branch below settles it on the next mute. A
      // `dictation://not-armed` broadcast was tried and removed; matching it to per-window intent
      // needs a monotonic start id echoed back from Rust. See
      // PRD/sparkle/mic-multi-window-start-stop-race.md.
      //
      // Optimistic about the DOWNLOAD, never about WHERE the caret is (armedStatus, roborev 55497).
      // THIS IS THE PRODUCTION ARM PATH — the mic button and the voice menu both arm via
      // `setEnabled(true)`, which lands here; `toggle` on the controller has no caller in the app
      // (roborev 55555). It is also the launch path (`enabled` persists across restarts) and the
      // cross-window path (`enabled` is the synced slice), which are the arms that reach the paused
      // branch below without any click of ours to have moved the caret — see `armedStatus` for why
      // the same-document click cases are NOT claimed here (roborev 55589).
      //
      // Through the shared `focusOwnerNow` seam, not an inline re-read: that duplication is what left
      // this path — the one that actually runs — without anything a test could reach.
      store.setStatus(armedStatus(readFocusOwnerFromDom()));
      // Wait until the dictation listeners are attached before starting capture,
      // so the first VAD segment after launch isn't dropped.
      (controllerPromiseRef.current ?? Promise.resolve(null))
        .then(() => {
          if (!activeRun) return;
          invoke("start_dictation").catch((e) => {
            store.setModelProgress(null);
            store.setError(String(e));
            store.setEnabled(false); // permission denied / no device → fall back to muted
          });
        })
        .catch((e) => {
          // Controller creation (listen()) failed — fall back to muted with a visible error
          // rather than leaving enabled=true with a silently dead mic.
          if (!activeRun) return;
          store.setError(String(e));
          store.setEnabled(false);
        });
    } else {
      // Muting the mic tears down dictation in Rust, which closes any relay stream (stopping
      // server-side metering). The Rust stop also bumps the stop epoch so an in-flight
      // start_dictation still downloading the model aborts instead of resurrecting a live capture
      // under a muted UI (see dictation.rs). Reset ALL runtime UI state here so muting can never
      // leave a desynced view: clear status/level/speaking/phase/interim AND any lingering
      // model-download progress (a mute mid-download would otherwise keep the "Downloading…" pill
      // up; the aborted start emits no further capture events to clear it).
      invoke("stop_dictation").catch(() => {});
      store.setStatus("idle");
      store.setLevel(0);
      store.setSpeaking(false);
      store.setOnDeviceSpeech(false);
      store.setPhase("passive");
      store.setInterim("");
      store.setModelProgress(null);
      // Muting tears the capture down, so the dead-mic fault it described is over too. Left set, a
      // later recovery event could re-assert "listening" against a session that no longer exists.
      store.setDeadMicSilent(false);
    }
    return () => { activeRun = false; };
  }, [enabled]);
}
