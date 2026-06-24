// runtimeStore — state for agents that are currently open. `status` (drives tab color) and
// `branchStatus` (live ahead/behind/dirty/size) are live-only and can't be restored.
// `openAgentIds` (which agents are "live": PTY spawned, pane mounted, kept alive across
// tab/project switches) IS persisted, so quit/relaunch re-opens the same agents and each
// Claude session resumes via `claude --continue` (bead ).
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { AgentTabStatus } from "../types";
import type { BranchStatus } from "../services/branchStatus";
import { agentBranchStatus } from "../services/branchStatus";

interface RuntimeState {
  status: Record<string, AgentTabStatus>; // agentId -> status (live-only, never persisted)
  openAgentIds: string[]; // agents whose pane is mounted + PTY alive (persisted)
  branchStatus: Record<string, BranchStatus>; // agentId -> live ahead/behind/dirty/size (live-only)

  open: (agentId: string) => void;
  close: (agentId: string) => void;
  setStatus: (agentId: string, status: AgentTabStatus) => void;
  setBranchStatus: (agentId: string, s: BranchStatus) => void;
  /** Fetch + store this agent's branch status. Best-effort: a transient git error is swallowed
   *  so the UI never breaks. */
  pollBranchStatus: (
    root: string,
    projectId: string,
    agentId: string,
    baseBranch: string,
  ) => Promise<void>;
  isOpen: (agentId: string) => boolean;
  /** Drop any open ids whose agent no longer exists (e.g. deleted between
   * launches). Call once on boot with the ids of all agents in projectStore. */
  reconcile: (validIds: string[]) => void;
}

export const useRuntimeStore = create<RuntimeState>()(
  persist(
    (set, get) => ({
      status: {},
      openAgentIds: [],
      branchStatus: {},

      open: (agentId) =>
        set((s) =>
          s.openAgentIds.includes(agentId)
            ? s
            : { openAgentIds: [...s.openAgentIds, agentId] },
        ),

      close: (agentId) =>
        set((s) => {
          const { [agentId]: _removed, ...status } = s.status;
          const { [agentId]: _bs, ...branchStatus } = s.branchStatus;
          return {
            openAgentIds: s.openAgentIds.filter((id) => id !== agentId),
            status,
            branchStatus,
          };
        }),

      setStatus: (agentId, status) =>
        set((s) => ({ status: { ...s.status, [agentId]: status } })),

      setBranchStatus: (agentId, s) =>
        set((st) => ({ branchStatus: { ...st.branchStatus, [agentId]: s } })),

      pollBranchStatus: async (root, projectId, agentId, baseBranch) => {
        try {
          const s = await agentBranchStatus(root, projectId, agentId, baseBranch);
          get().setBranchStatus(agentId, s);
        } catch (e) {
          // Best-effort: a transient git error must not break the UI. Log at debug level so a
          // persistent (structural) failure — e.g. a bad baseBranch — is still diagnosable.
          console.debug("pollBranchStatus failed for", agentId, e);
        }
      },

      isOpen: (agentId) => get().openAgentIds.includes(agentId),

      reconcile: (validIds) =>
        set((s) => {
          const valid = new Set(validIds);
          const openAgentIds = s.openAgentIds.filter((id) => valid.has(id));
          return openAgentIds.length === s.openAgentIds.length ? s : { openAgentIds };
        }),
    }),
    {
      name: "sparkle-runtime",
      storage: createJSONStorage(() => localStorage),
      // Only the open set survives a relaunch; live status/branchStatus always boot clean.
      partialize: (s) => ({ openAgentIds: s.openAgentIds }),
    },
  ),
);
