// Ephemeral hand-off from a terminal-selection action to the Brainstorm panel: carries the
// initial prompt (and whether to auto-send it) for the project's singleton brainstorm agent.
// Deliberately NOT persisted — it's consumed on the next render and cleared.
import { create } from "zustand";

export interface BrainstormHandoff {
  projectId: string;
  text: string;
  autoSend: boolean;
}

interface HandoffState {
  pending: BrainstormHandoff | null;
  setPending: (h: BrainstormHandoff) => void;
  clear: () => void;
}

export const useHandoffStore = create<HandoffState>((set) => ({
  pending: null,
  setPending: (h) => set({ pending: h }),
  clear: () => set({ pending: null }),
}));
