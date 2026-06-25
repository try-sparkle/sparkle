import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useDictationStore } from "./stores/dictationStore";
import { advance } from "./voice/wakeMachine";

// ---------------------------------------------------------------------------
// Controller factory
//
// Extracted so it can be instantiated without React (e.g. in tests) and also
// used by useAmbientVoice.  Returns `{ toggle, cleanup }`.
// ---------------------------------------------------------------------------

interface DictationOptions {
  onSegment: (text: string) => void;
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

  const { setStatus, setLevel, setError, setModelProgress } =
    useDictationStore.getState();

  // Register event listeners — each `listen()` returns an unsubscribe fn.
  const unsubscribes = await Promise.all([
    listen<string>("dictation://partial", (e) => {
      // Capture started — clear any lingering model-download progress.
      useDictationStore.getState().setModelProgress(null);
      onSegment(e.payload);
    }),

    listen<number>("dictation://level", (e) => {
      // Capture started — clear any lingering model-download progress.
      useDictationStore.getState().setModelProgress(null);
      setLevel(e.payload);
    }),

    listen<string>("dictation://error", (e) => {
      setModelProgress(null);
      setError(e.payload);
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
      await invoke("stop_dictation");
      state.setModelProgress(null);
      state.setStatus("idle");
      state.setLevel(0);
    } else {
      state.setError(null);
      state.setStatus("listening");
      try {
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
    const p = createDictationController({ onSegment: onSegment.current });
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
      invoke("stop_dictation").catch(() => {});
      store.setStatus("idle");
      store.setLevel(0);
      store.setPhase("passive");
    }
    return () => { activeRun = false; };
  }, [enabled]);
}
