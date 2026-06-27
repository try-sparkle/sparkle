// runtimeStore — state for agents that are currently open. `status` (drives tab color) and
// `branchStatus` (live ahead/behind/dirty/size) are live-only and can't be restored.
// `openAgentIds` (which agents are "live": PTY spawned, pane mounted, kept alive across
// tab/project switches) IS persisted, so quit/relaunch re-opens the same agents and each
// Claude session resumes via `claude --continue` (bead ).
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { AgentTabStatus } from "../types";
import type { BranchStatus } from "../services/branchStatus";
import type { WorkflowStageId } from "../engine/workflowStage";
import { agentBranchStatus, agentWorkflowState } from "../services/branchStatus";
import { deriveLiveStage, stageIndex } from "../engine/workflowStage";
import { syncProjectMarkdown } from "../services/chiefSync";
import { useSettingsStore, effectiveChiefPat } from "./settingsStore";
import { useProjectStore } from "./projectStore";

/** Trailing-debounce window per project. The branch-status poll fires often (mount + the ~30s
 *  connectivity probe); we coalesce those into one sync after a quiet window so a burst of commits
 *  uploads once, not once-per-commit. Content-hash dedup in syncProjectMarkdown makes an unchanged
 *  run a no-op regardless. */
export const CHIEF_SYNC_DEBOUNCE_MS = 10_000;

// Per-project failure backoff (, re-keyed from per-agent). When Chief is unreachable the
// sync throws ("Load failed"); without this a dead endpoint gets retried every debounced run for the
// app's lifetime. After a failure we skip this project's sync until an exponential, capped cooldown
// elapses; the next successful round-trip clears it.
const SYNC_BACKOFF_BASE_MS = 5_000;
const SYNC_BACKOFF_CAP_MS = 5 * 60_000;
const syncBackoff = new Map<string, { until: number; fails: number }>();

/** Test-only: clear the Chief-sync backoff state between cases. */
export function __resetChiefSyncBackoff(): void {
  syncBackoff.clear();
}

interface PendingSync {
  timer: ReturnType<typeof setTimeout>;
  agentId: string;
}
const pendingByProject = new Map<string, PendingSync>();
// One sync per project at a time. Project-level (not per-agent) because asset identity is now
// keyed by (Chief project, path) — two agents must not race to seed the same paths.
const syncingProjects = new Set<string>();

/** Schedule a debounced Chief sync for a project. Resets the timer on each call. */
export function scheduleChiefSync(projectId: string, agentId: string): void {
  const existing = pendingByProject.get(projectId);
  if (existing) clearTimeout(existing.timer);
  const timer = setTimeout(() => {
    pendingByProject.delete(projectId);
    void runChiefSync(projectId, agentId);
  }, CHIEF_SYNC_DEBOUNCE_MS);
  pendingByProject.set(projectId, { timer, agentId });
}

/** Push the project's current markdown to its Chief library (current-state model). Best-effort:
 *  a Chief/git hiccup must not break the UI, and an un-persisted ledger simply retries next run. */
export async function runChiefSync(projectId: string, agentId: string): Promise<void> {
  const settings = useSettingsStore.getState();
  const pat = effectiveChiefPat(settings.chiefPat, settings.runtimeChiefPat);
  if (!pat) return;
  const project = useProjectStore.getState().projects.find((p) => p.id === projectId);
  if (!project) return;
  // Read markdown from a real worktree — prefer the triggering agent, else any workflow agent.
  // think + shell agents have no worktree (mirrors the predicate in refreshWorkflowStage).
  const hasWorktree = (kind: string) => kind !== "think" && kind !== "shell";
  const triggering = project.agents.find((a) => a.id === agentId);
  const syncAgent =
    triggering && hasWorktree(triggering.kind)
      ? triggering
      : project.agents.find((a) => hasWorktree(a.kind));
  if (!syncAgent) return;
  if (syncingProjects.has(projectId)) return;
  const backoff = syncBackoff.get(projectId);
  if (backoff && Date.now() < backoff.until) return; // cooling down after a recent failure
  syncingProjects.add(projectId);
  try {
    const chiefProjectId = settings.chiefProjectByProject[projectId];
    const res = await syncProjectMarkdown({
      pat,
      sparkleProjectId: projectId,
      projectName: project.name,
      agentId: syncAgent.id,
      chiefProjectId,
      docState: chiefProjectId ? (settings.chiefDocStateByProject[chiefProjectId] ?? {}) : {},
    });
    syncBackoff.delete(projectId); // round-trip succeeded → endpoint healthy, reset backoff
    if (!res) return;
    if (res.chiefProjectId && res.chiefProjectId !== chiefProjectId) {
      settings.setChiefProject(projectId, res.chiefProjectId);
    }
    // Only persist the ledger when something actually changed — avoids a zustand state update +
    // localStorage write on every poll cycle when the tree is unchanged.
    if (res.chiefProjectId && (res.uploaded.length || res.deletedAssetIds.length)) {
      settings.setChiefProjectDocState(res.chiefProjectId, res.docState);
    }
  } catch (e) {
    // Back off so we don't retry a dead endpoint every run; the un-persisted ledger is reattempted
    // once the cooldown elapses.
    const fails = (syncBackoff.get(projectId)?.fails ?? 0) + 1;
    const delay = Math.min(SYNC_BACKOFF_BASE_MS * 2 ** (fails - 1), SYNC_BACKOFF_CAP_MS);
    syncBackoff.set(projectId, { until: Date.now() + delay, fails });
    console.debug("chief project sync failed for", projectId, `(backoff ${delay}ms)`, e);
  } finally {
    syncingProjects.delete(projectId);
  }
}

interface RuntimeState {
  status: Record<string, AgentTabStatus>; // agentId -> status (live-only, never persisted)
  openAgentIds: string[]; // agents whose pane is mounted + PTY alive (persisted)
  branchStatus: Record<string, BranchStatus>; // agentId -> live ahead/behind/dirty/size (live-only)
  // agentId -> the furthest workflow stage we KNOW this agent's OWN work has reached. Derived each
  // poll from local-ref reachability + an opportunistic GitHub PR probe (see refreshWorkflowStage /
  // engine.deriveLiveStage), advanced monotonically. The sidebar overlays it on the git-derived
  // stage (resolveStage) and rolls workers up into their orchestrator. Live-only (never persisted).
  workflowStage: Record<string, WorkflowStageId>;

  open: (agentId: string) => void;
  close: (agentId: string) => void;
  setStatus: (agentId: string, status: AgentTabStatus) => void;
  setBranchStatus: (agentId: string, s: BranchStatus) => void;
  setWorkflowStage: (agentId: string, stage: WorkflowStageId) => void;
  /** Fetch + store this agent's branch status. Best-effort: a transient git error is swallowed
   *  so the UI never breaks. */
  pollBranchStatus: (
    root: string,
    projectId: string,
    agentId: string,
    baseBranch: string,
  ) => Promise<void>;
  /** Re-derive this agent's OWN workflow stage from local-ref reachability + a best-effort GitHub
   *  PR probe, and advance the stored stage if it moved forward. Best-effort: swallows git/gh
   *  errors. Skips think/shell agents (no git workflow). */
  refreshWorkflowStage: (root: string, projectId: string, agentId: string) => Promise<void>;
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
      workflowStage: {},

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
          const { [agentId]: _ws, ...workflowStage } = s.workflowStage;
          return {
            openAgentIds: s.openAgentIds.filter((id) => id !== agentId),
            status,
            branchStatus,
            workflowStage,
          };
        }),

      setStatus: (agentId, status) =>
        set((s) => ({ status: { ...s.status, [agentId]: status } })),

      setBranchStatus: (agentId, s) =>
        set((st) => ({ branchStatus: { ...st.branchStatus, [agentId]: s } })),

      setWorkflowStage: (agentId, stage) =>
        set((st) => ({ workflowStage: { ...st.workflowStage, [agentId]: stage } })),

      pollBranchStatus: async (root, projectId, agentId, baseBranch) => {
        try {
          const s = await agentBranchStatus(root, projectId, agentId, baseBranch);
          get().setBranchStatus(agentId, s);
          // Piggyback the Chief markdown sync on the same signal a commit would refresh —
          // debounced + coalesced per project.
          scheduleChiefSync(projectId, agentId);
          // …and advance the workflow tracker from reachability + an opportunistic PR probe. Runs
          // after setBranchStatus so deriveLiveStage sees this tick's fresh ahead/dirty counts.
          void get().refreshWorkflowStage(root, projectId, agentId);
        } catch (e) {
          // Best-effort: a transient git error must not break the UI. Log at debug level so a
          // persistent (structural) failure — e.g. a bad baseBranch — is still diagnosable.
          console.debug("pollBranchStatus failed for", agentId, e);
        }
      },

      refreshWorkflowStage: async (root, projectId, agentId) => {
        try {
          const project = useProjectStore.getState().projects.find((p) => p.id === projectId);
          const agent = project?.agents.find((a) => a.id === agentId);
          // No worktree / no git workflow → nothing to track.
          if (!agent || agent.kind === "think" || agent.kind === "shell") return;
          // A worker integrates into its orchestrator's branch; everyone else, into project main.
          const parentBranch =
            agent.kind === "worker" && agent.parentId ? `sparkle/agent-${agent.parentId}` : "";
          const ws = await agentWorkflowState(root, agentId, parentBranch, true);
          const prev = get().workflowStage[agentId] ?? null;
          // A worker's "Merged" = its orchestrator's OWN work has reached main. Read the parent's
          // stored stage (set by its own poll); eventually-consistent across ticks.
          let parentReachedMain = false;
          if (agent.kind === "worker" && agent.parentId) {
            const ps = get().workflowStage[agent.parentId];
            parentReachedMain = ps ? stageIndex(ps) >= stageIndex("main") : false;
          }
          const next = deriveLiveStage({
            kind: agent.kind,
            bs: get().branchStatus[agentId],
            ws,
            prev,
            parentReachedMain,
          });
          if (next !== prev) get().setWorkflowStage(agentId, next);
        } catch (e) {
          console.debug("refreshWorkflowStage failed for", agentId, e);
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
