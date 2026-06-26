// Ephemeral hand-off from a terminal-selection action to the Think panel: carries the
// initial prompt (and whether to auto-send it) for the project's singleton think agent.
// Deliberately NOT persisted — it's consumed on the next render and cleared.
import { create } from "zustand";

export interface ThinkHandoff {
  projectId: string;
  text: string;
  autoSend: boolean;
}

interface HandoffState {
  pending: ThinkHandoff | null;
  setPending: (h: ThinkHandoff) => void;
  clear: () => void;
}

export const useHandoffStore = create<HandoffState>((set) => ({
  pending: null,
  setPending: (h) => set({ pending: h }),
  clear: () => set({ pending: null }),
}));
