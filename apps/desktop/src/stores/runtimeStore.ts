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
import { syncAgentMarkdown } from "../services/chiefSync";
import { useSettingsStore, effectiveChiefPat } from "./settingsStore";
import { useProjectStore } from "./projectStore";

// Agents with a Chief markdown sync currently in flight. The poll fires `syncMarkdownToChief`
// unawaited on every tick, so without this guard two overlapping ticks would both read the same
// watermark, re-run the same diff, and — when no Chief project is linked yet — both call
// ensureChiefProject, racing to create two duplicate projects. One sync per agent at a time.
const syncingAgents = new Set<string>();

/** After a status poll, push any newly-committed markdown to the agent's Chief project so the
 *  Brainstorm agent stays current. Best-effort + store-driven: pulls PAT/project/marker from
 *  the stores, leaves the watermark un-advanced on failure so the next tick retries. Brainstorm
 *  agents are skipped — they have no worktree and produce no commits. Exported for testing. */
export async function syncMarkdownToChief(projectId: string, agentId: string): Promise<void> {
  const settings = useSettingsStore.getState();
  const pat = effectiveChiefPat(settings.chiefPat, settings.runtimeChiefPat);
  if (!pat) return;
  const project = useProjectStore.getState().projects.find((p) => p.id === projectId);
  const agent = project?.agents.find((a) => a.id === agentId);
  if (!project || !agent || agent.kind === "brainstorm") return;
  if (syncingAgents.has(agentId)) return; // a sync for this agent is already running
  syncingAgents.add(agentId);
  try {
    const res = await syncAgentMarkdown({
      pat,
      projectId,
      projectName: project.name,
      agentId,
      chiefProjectId: settings.chiefProjectByProject[projectId],
      sinceSha: settings.chiefSyncByAgent[agentId],
    });
    if (!res) return;
    if (res.chiefProjectId && res.chiefProjectId !== settings.chiefProjectByProject[projectId]) {
      settings.setChiefProject(projectId, res.chiefProjectId);
    }
    if (res.headSha && res.headSha !== settings.chiefSyncByAgent[agentId]) {
      settings.setChiefSync(agentId, res.headSha);
    }
  } catch (e) {
    // Best-effort: a Chief/git hiccup must not break the UI. The un-advanced marker retries.
    console.debug("chief markdown sync failed for", agentId, e);
  } finally {
    syncingAgents.delete(agentId);
  }
}

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
          // Piggyback the Chief markdown sync on the same signal a commit would refresh.
          void syncMarkdownToChief(projectId, agentId);
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
