import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { Phase } from "../voice/wakeMachine";

/** localStorage key for the persisted slice (only `enabled`). Exported so the cross-window
 *  sync service can rehydrate on the browser `storage` event. */
export const DICTATION_PERSIST_KEY = "sparkle-dictation";

type Status = "idle" | "listening" | "error";

interface ModelProgress {
  done: number;
  total: number | null;
}

interface DictationState {
  status: Status;
  level: number;
  /** Real-time "is the user speaking right now?" flag from the backend Silero VAD
   *  (`dictation://speaking`). Drives the waveform animation: the meter only moves while
   *  this is true, so it sits as a flat, static line in silence instead of wiggling on
   *  ambient noise. Distinct from `level` (raw loudness, used only for bar HEIGHT). */
  speaking: boolean;
  error: string | null;
  /** Non-null while the backend is downloading the whisper model (~482 MB). */
  modelProgress: ModelProgress | null;
  /** Live, un-committed transcript from the cloud streaming engine (Deepgram interim results).
   *  Shown as a ghosted preview that updates word-by-word; replaced in place on each interim and
   *  cleared when the segment finalizes (committed via the normal partial → insert path). Always
   *  "" on the on-device path, which has no interim results. */
  interim: string;

  // --- ambient always-listening ---
  /** Mic hot (master mute). Default FALSE — the ambient mic is opt-in, so a fresh install doesn't
   *  fire the OS mic-permission prompt or load the VAD/wake-word model during cold start. Persisted
   *  and synced across all windows, so a user who turns it on stays on across windows and relaunch
   *  (only the DEFAULT changed — existing persisted `enabled: true` preferences are untouched). */
  enabled: boolean;
  /** passive = hearing but not typing; active = routing speech to the box. */
  phase: Phase;
  /** The active composer's append fn, or null. Set via registerInsert. */
  insertTarget: ((text: string) => void) | null;

  setStatus: (s: Status) => void;
  setLevel: (l: number) => void;
  setSpeaking: (v: boolean) => void;
  /** Replace the live interim preview (cloud path). Pass "" to clear it. */
  setInterim: (text: string) => void;
  /** Setting a non-null value also transitions status to "error". Clearing with
   *  null only returns to "idle" if we were in the "error" state — an active
   *  "listening" session is left untouched. */
  setError: (e: string | null) => void;
  setModelProgress: (p: ModelProgress | null) => void;

  setEnabled: (v: boolean) => void;
  setPhase: (p: Phase) => void;
  togglePhase: () => void;
  registerInsert: (fn: ((text: string) => void) | null) => void;
  insert: (text: string) => void;
}

export const useDictationStore = create<DictationState>()(
  persist(
    (set, get) => ({
      status: "idle",
      level: 0,
      speaking: false,
      error: null,
      modelProgress: null,
      interim: "",

      enabled: false, // opt-in: no mic-permission prompt / model load on a fresh cold start
      phase: "passive",
      insertTarget: null,

      setStatus: (status) => set({ status }),
      setLevel: (level) => set({ level }),
      setSpeaking: (speaking) => set({ speaking }),
      setInterim: (interim) => set({ interim }),
      setError: (error) =>
        set((s) => ({
          error,
          status: error ? "error" : s.status === "error" ? "idle" : s.status,
        })),
      setModelProgress: (modelProgress) => set({ modelProgress }),

      setEnabled: (enabled) => set({ enabled }),
      setPhase: (phase) => set({ phase }),
      togglePhase: () => set((s) => ({ phase: s.phase === "passive" ? "active" : "passive" })),
      registerInsert: (insertTarget) => set({ insertTarget }),
      insert: (text) => {
        const fn = get().insertTarget;
        if (fn) fn(text);
      },
    }),
    {
      name: DICTATION_PERSIST_KEY,
      storage: createJSONStorage(() => localStorage),
      // Only the master mute is a real setting; everything else (mic level, status, phase,
      // download progress, the live insert callback) is per-session runtime that must not persist.
      partialize: (s) => ({ enabled: s.enabled }),
    },
  ),
);
