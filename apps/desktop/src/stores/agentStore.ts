import { create } from "zustand";
import { MOCK_CHAT } from "../mock";
import type { ChatMessage } from "../types";

interface AgentUiState {
  // Expert Mode (macOS only): which card's raw-terminal drawer is open.
  expertSessionId: string | null;
  toggleExpert: (sessionId: string) => void;

  // Floor level (§15) — gates Expert Mode toggle (floor >= 4) etc.
  floorLevel: number;
  setFloor: (level: number) => void;

  chat: ChatMessage[];
  addChat: (message: ChatMessage) => void;
}

export const useAgentStore = create<AgentUiState>((set) => ({
  expertSessionId: null,
  toggleExpert: (sessionId) =>
    set((s) => ({
      expertSessionId: s.expertSessionId === sessionId ? null : sessionId,
    })),

  floorLevel: 4, // demo: Expert Mode visible
  setFloor: (level) => set({ floorLevel: level }),

  chat: MOCK_CHAT,
  addChat: (message) => set((s) => ({ chat: [...s.chat, message] })),
}));
