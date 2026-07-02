import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useDictationStore } from "./stores/dictationStore";
import { useAiFeature, aiFeatureNow } from "./services/aiGate";
import { useAuthStore } from "./stores/authStore";
import { advance, type Advance } from "./voice/wakeMachine";
import { openCloudDictationWindow, nextBalanceCents } from "./services/cloudDictation";

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
}

interface DictationController {
  toggle: () => Promise<void>;
  cleanup: () => void;
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
  let onSegment = options.onSegment;
  const onResumeActive = options.onResumeActive;
  // Only the focused window should consume the (app-broadcast) committed text + live preview, so a
  // phrase doesn't land in every open window at once. Default to a real per-window focus check.
  const isWindowActive =
    options.isWindowActive ?? (() => typeof document === "undefined" || document.hasFocus());

  const { setStatus, setLevel, setSpeaking, setError, setModelProgress } =
    useDictationStore.getState();

  // Register event listeners — each `listen()` returns an unsubscribe fn.
  const unsubscribes = await Promise.all([
    listen<string>("dictation://partial", (e) => {
      // Multi-window: this event is broadcast to EVERY Sparkle window, but committed text must land
      // in only the focused one — otherwise the same phrase types into every open window's composer
      // (and each would run the wake machine / open its own cloud stream). Background windows bail.
      if (!isWindowActive()) return;
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
      // Same multi-window gate as the partial path: only the focused window paints the live ghost.
      // A background window clears any stale preview it might still be showing and ignores the rest.
      if (!isWindowActive()) {
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
        const { me } = useAuthStore.getState();
        if (!me) return;
        const { balanceCents, debitedCents } = e.payload;
        useAuthStore.setState({
          me: {
            ...me,
            balanceCents: nextBalanceCents(me.balanceCents, balanceCents, debitedCents),
          },
        });
      },
    ),

    listen<number>("dictation://level", (e) => {
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
      setSpeaking(e.payload);
    }),

    listen<string>("dictation://error", (e) => {
      setModelProgress(null);
      setError(e.payload);
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
        store.setInterim("");
        store.setLevel(0);
        // Capture is paused — no more frames, so clear the VAD flag ourselves (the backend
        // emits edges only while capturing) to freeze the waveform flat while unfocused.
        store.setSpeaking(false);
        if (store.status !== "error") store.setStatus("idle");
      } else if (store.enabled && store.status !== "error") {
        store.setStatus("listening");
        // Mid-dictation when focus left → resume the cloud stream now, no wake word needed.
        if (store.phase === "active") onResumeActive?.();
      }
    }),

    // [doneBytes, totalBytesOrNull]
    listen<[number, number | null]>("dictation://model-progress", (e) => {
      const [done, total] = e.payload;
      // Clear on completion so the UI doesn't linger on "Downloading… 100%".
      setModelProgress(total !== null && done >= total ? null : { done, total });
    }),
  ]);

  const cleanup = () => unsubscribes.forEach((u) => u());

  const toggle = async () => {
    const state = useDictationStore.getState();
    if (state.status === "listening") {
      // stop_dictation tears down any live relay stream in Rust, which stops server-side metering.
      await invoke("stop_dictation");
      state.setModelProgress(null);
      state.setStatus("idle");
      state.setLevel(0);
      state.setSpeaking(false);
      state.setInterim("");
    } else {
      state.setError(null);
      state.setStatus("listening");
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

  return { toggle, cleanup };
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
      startCloudStream: () => invoke<boolean>("start_cloud_stream"),
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
    const now = Date.now();
    const r = advance(store.phase, seg);
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
      store.setStatus("listening");
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
      // server-side metering).
      invoke("stop_dictation").catch(() => {});
      store.setStatus("idle");
      store.setLevel(0);
      store.setSpeaking(false);
      store.setPhase("passive");
      store.setInterim("");
    }
    return () => { activeRun = false; };
  }, [enabled]);
}
