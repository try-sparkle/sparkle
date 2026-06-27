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
  refresh: () => Promise<void>;
  start: () => Promise<void>;
  increment: () => Promise<void>;
}

export const useTrialStore = create<TrialStore>((set) => ({
  started: false,
  promptsUsed: 0,
  loading: true,
  refresh: async () => {
    const s = await fetchTrial();
    set({ started: s.started, promptsUsed: s.promptsUsed, loading: false });
  },
  start: async () => {
    const s = await startTrial();
    set({ started: s.started, promptsUsed: s.promptsUsed });
  },
  increment: async () => {
    const s = await incrementTrial();
    set({ started: s.started, promptsUsed: s.promptsUsed });
  },
}));

/** Prompts remaining in the free trial, floored at 0. */
export function trialPromptsLeft(s: { promptsUsed: number }): number {
  return Math.max(0, TRIAL_LIMIT - s.promptsUsed);
}
