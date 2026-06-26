import { create } from "zustand";
import type { Phase } from "../voice/wakeMachine";

type Status = "idle" | "listening" | "error";

interface ModelProgress {
  done: number;
  total: number | null;
}

interface DictationState {
  status: Status;
  level: number;
  error: string | null;
  /** Non-null while the backend is downloading the whisper model (~482 MB). */
  modelProgress: ModelProgress | null;
  /** Live, un-committed transcript from the cloud streaming engine (Deepgram interim results).
   *  Shown as a ghosted preview that updates word-by-word; replaced in place on each interim and
   *  cleared when the segment finalizes (committed via the normal partial → insert path). Always
   *  "" on the on-device path, which has no interim results. */
  interim: string;

  // --- ambient always-listening ---
  /** Mic hot (master mute). Default true (on by default at launch). */
  enabled: boolean;
  /** passive = hearing but not typing; active = routing speech to the box. */
  phase: Phase;
  /** The active composer's append fn, or null. Set via registerInsert. */
  insertTarget: ((text: string) => void) | null;

  setStatus: (s: Status) => void;
  setLevel: (l: number) => void;
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

export const useDictationStore = create<DictationState>((set, get) => ({
  status: "idle",
  level: 0,
  error: null,
  modelProgress: null,
  interim: "",

  enabled: true,
  phase: "passive",
  insertTarget: null,

  setStatus: (status) => set({ status }),
  setLevel: (level) => set({ level }),
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
}));
