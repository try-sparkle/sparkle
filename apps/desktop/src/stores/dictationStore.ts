import { create } from "zustand";

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

  setStatus: (s: Status) => void;
  setLevel: (l: number) => void;
  /** Setting a non-null value also transitions status to "error". Clearing with
   *  null only returns to "idle" if we were in the "error" state — an active
   *  "listening" session is left untouched. */
  setError: (e: string | null) => void;
  setModelProgress: (p: ModelProgress | null) => void;
}

export const useDictationStore = create<DictationState>((set) => ({
  status: "idle",
  level: 0,
  error: null,
  modelProgress: null,

  setStatus: (status) => set({ status }),
  setLevel: (level) => set({ level }),
  setError: (error) =>
    set((s) => ({
      error,
      status: error ? "error" : s.status === "error" ? "idle" : s.status,
    })),
  setModelProgress: (modelProgress) => set({ modelProgress }),
}));
