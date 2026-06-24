import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useDictationStore } from "./stores/dictationStore";

// ---------------------------------------------------------------------------
// Controller factory
//
// Extracted so it can be instantiated without React (e.g. in tests) and also
// used by the React hook below.  Returns `{ toggle, cleanup }`.
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
 * Suitable for use from tests or from the React hook.
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
      setModelProgress({ done, total });
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
// React hook
// ---------------------------------------------------------------------------

/**
 * Subscribes to `dictation://*` Tauri events, drives `start_dictation` /
 * `stop_dictation` commands, and forwards partial transcripts to `onSegment`.
 *
 * Returns `{ status, level, modelProgress, toggle }`.
 */
export function useDictation({ onSegment }: DictationOptions) {
  const { status, level, modelProgress } = useDictationStore();
  const onSegRef = useRef(onSegment);
  onSegRef.current = onSegment;

  // Stable wrapper so the controller always calls the latest onSegment
  // without needing to recreate itself.
  const stableOnSegment = useRef((text: string) => onSegRef.current(text));

  const controllerRef = useRef<DictationController | null>(null);
  const controllerPromiseRef = useRef<Promise<DictationController> | null>(null);

  useEffect(() => {
    let cancelled = false;

    const p = createDictationController({ onSegment: stableOnSegment.current });
    controllerPromiseRef.current = p;
    p.then((ctrl) => {
      if (cancelled) {
        ctrl.cleanup();
        return;
      }
      controllerRef.current = ctrl;
    });

    return () => {
      cancelled = true;
      controllerRef.current?.cleanup();
      controllerRef.current = null;
      controllerPromiseRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = async () => {
    // Await the controller if its four listen() calls haven't resolved yet, so
    // an early toggle() can never silently no-op.
    const ctrl = controllerRef.current ?? (await controllerPromiseRef.current);
    await ctrl?.toggle();
  };

  return { status, level, modelProgress, toggle };
}
