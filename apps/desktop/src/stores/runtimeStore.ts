// runtimeStore — live, non-persisted state for agents that are currently open: their
// status (drives tab color) and which agents are "live" (PTY spawned, pane mounted and
// kept alive across tab/project switches so their Claude session isn't lost).
import { create } from "zustand";
import type { AgentTabStatus } from "../types";

interface RuntimeState {
  status: Record<string, AgentTabStatus>; // agentId -> status
  openAgentIds: string[]; // agents whose pane is mounted + PTY alive

  open: (agentId: string) => void;
  close: (agentId: string) => void;
  setStatus: (agentId: string, status: AgentTabStatus) => void;
  isOpen: (agentId: string) => boolean;
}

export const useRuntimeStore = create<RuntimeState>((set, get) => ({
  status: {},
  openAgentIds: [],

  open: (agentId) =>
    set((s) =>
      s.openAgentIds.includes(agentId)
        ? s
        : { openAgentIds: [...s.openAgentIds, agentId] },
    ),

  close: (agentId) =>
    set((s) => {
      const { [agentId]: _removed, ...status } = s.status;
      return {
        openAgentIds: s.openAgentIds.filter((id) => id !== agentId),
        status,
      };
    }),

  setStatus: (agentId, status) =>
    set((s) => ({ status: { ...s.status, [agentId]: status } })),

  isOpen: (agentId) => get().openAgentIds.includes(agentId),
}));
