// Mirrors the Rust trial meter (trial.rs) into a Zustand store the gate + composer read.
// `started` = the user tapped "Try it now"; `promptsUsed` = worker prompts spent (cap 100).
import { create } from "zustand";
import { fetchTrial, startTrial, incrementTrial, TRIAL_LIMIT } from "../services/trialApi";

// Re-exported so trial consumers (the meter, chrome) get the cap from one place.
export { TRIAL_LIMIT };

interface TrialStore {
  started: boolean;
  promptsUsed: number;
  loading: boolean;
  /** The last trial read/write threw (e.g. a corrupt device-local `trial.json`, which Rust treats
   *  as a HARD error — deliberately, so corruption can't silently re-grant a fresh trial). Surfaced
   *  as a recoverable UI state (a Welcome banner) rather than leaving the gate stuck on `loading`
   *  forever. Cleared on the next successful read. */
  error: boolean;
  refresh: () => Promise<void>;
  start: () => Promise<void>;
  increment: () => Promise<void>;
}

export const useTrialStore = create<TrialStore>((set) => ({
  started: false,
  promptsUsed: 0,
  loading: true,
  error: false,
  refresh: async () => {
    try {
      const s = await fetchTrial();
      set({ started: s.started, promptsUsed: s.promptsUsed, loading: false, error: false });
    } catch (e) {
      // A throw here (corrupt trial.json → Rust hard error, or an IPC failure) MUST NOT leave the
      // gate pinned on `loading` forever. Resolve to a safe, non-stuck state: clear `loading` and
      // do NOT grant a trial (started:false), so a token-less user lands on the recoverable Welcome
      // screen (sign in / pay) with an error banner — never a re-granted trial, never a dead spinner.
      console.warn("trial refresh failed; resolving to a recoverable state:", e);
      set({ started: false, promptsUsed: 0, loading: false, error: true });
    }
  },
  start: async () => {
    try {
      const s = await startTrial();
      set({ started: s.started, promptsUsed: s.promptsUsed, error: false });
    } catch (e) {
      // "Try it now" couldn't persist the opt-in — surface it rather than swallowing it as an
      // unhandled rejection. loading is already false by now, so this only flips the error flag.
      console.warn("trial start failed:", e);
      set({ error: true });
    }
  },
  increment: async () => {
    try {
      const s = await incrementTrial();
      set({ started: s.started, promptsUsed: s.promptsUsed, error: false });
    } catch (e) {
      // A metering write that throws must not become an unhandled rejection; the caller (composer)
      // already tolerates a best-effort meter. Do NOT flip the shared `error` flag here: `error`
      // gates the token-less Welcome path (a read/start failure), which an active-trial user has
      // already passed — a benign background metering hiccup must not conflate with a corrupt-read.
      console.warn("trial increment failed:", e);
    }
  },
}));

/** Prompts remaining in the free trial, floored at 0. */
export function trialPromptsLeft(s: { promptsUsed: number }): number {
  return Math.max(0, TRIAL_LIMIT - s.promptsUsed);
}
