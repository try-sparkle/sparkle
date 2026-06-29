// Programmatically spawn a worker agent under a build agent: register the tab, cut its worktree
// from the parent's local branch, and persist the worktree. The PTY launch happens when the
// worker tab opens (AgentPane), driven by the worker persona + the stored task.
import { useProjectStore } from "../stores/projectStore";
import { createWorkerWorktree, type WorktreeInfo, killPty } from "../pty";
import { removeAgentWorktree } from "./worktree";
import { useRuntimeStore } from "../stores/runtimeStore";
import { maybeAutoName } from "./agentNaming";
import { aiFeatureNow } from "./aiGate";

export async function spawnWorker(args: {
  projectId: string;
  parentAgentId: string;
  task: string;
  beadId?: string;
}): Promise<string> {
  const store = useProjectStore.getState();
  const project = store.projects.find((p) => p.id === args.projectId);
  if (!project) throw new Error(`unknown project ${args.projectId}`);
  const parent = project.agents.find((a) => a.id === args.parentAgentId);
  if (!parent) throw new Error(`unknown parent agent ${args.parentAgentId}`);
  if (!parent.branch) throw new Error("parent agent has no branch yet — open it first");

  // Capture the active tab before addAgent shifts selection to the new worker, so a failed
  // worktree cut can restore the user to where they were instead of landing on agents[0].
  const prevSelectedId = project.selectedAgentId;

  const workerId = store.addAgent(args.projectId, {
    kind: "worker",
    parentId: args.parentAgentId,
    task: args.task,
    parentBranch: parent.branch,
    beadId: args.beadId,
  });

  let info: WorktreeInfo;
  try {
    info = await createWorkerWorktree({
      root: project.rootPath,
      projectId: args.projectId,
      workerId,
      parentBranch: parent.branch,
    });
  } catch (e) {
    // Roll back the orphaned tab: a failed worktree cut must not leave a dead, un-launchable
    // worker (worktreePath/branch null) stranded in the sidebar.
    useProjectStore.getState().removeAgent(args.projectId, workerId);
    // Restore the previously-active tab — removeAgent recomputes selection to agents[0] which
    // may not be the agent the user was working in.
    if (prevSelectedId) {
      useProjectStore.getState().selectAgent(args.projectId, prevSelectedId);
    }
    throw e;
  }
  useProjectStore.getState().setAgentWorktree(args.projectId, workerId, info.path, info.branch);

  // Auto-name the worker from its assigned task, the same way a build/orchestrator agent is named
  // from its first typed prompt. A worker's task never flows through the Composer's onSubmitPrompt
  // handler (it's injected as the PTY's initialPrompt at launch), so without this it would keep its
  // default "Worker N" name until Claude Code eventually writes a session title. Fire-and-forget,
  // gated on the same autoRename AI feature; no-ops if pinned, thin, or no API key. Claude Code's
  // later ai-title still supersedes (maybeAutoName bails once aiTitle is set).
  if (aiFeatureNow("autoRename") && args.task.trim()) {
    void maybeAutoName(args.projectId, workerId, args.task);
  }

  return workerId;
}

/** Tear down a finished worker: kill its PTY, remove its worktree (branch is kept), drop its tab
 *  and runtime entry. Idempotent for sequential calls — a worker already gone is a no-op.
 *  Worker-only: a non-worker id is a no-op, because removeAgent cascades to a build's workers and
 *  would orphan their PTYs/worktrees (this fn only tears down the single passed id). */
export async function spinDownWorker(args: { projectId: string; workerId: string }): Promise<void> {
  const project = useProjectStore.getState().projects.find((p) => p.id === args.projectId);
  if (!project) return;
  const worker = project.agents.find((a) => a.id === args.workerId);
  if (!worker || worker.kind !== "worker") return;
  // Errors are swallowed so a partially-gone worker still finishes teardown; warn so a failed
  // PTY kill / worktree removal (e.g. a transient git error leaving an orphan on disk) is visible.
  await killPty(args.workerId).catch((e) => console.warn("spinDownWorker: killPty failed", e));
  await removeAgentWorktree(project.rootPath, args.projectId, args.workerId).catch((e) =>
    console.warn("spinDownWorker: removeAgentWorktree failed", e),
  );
  useRuntimeStore.getState().close(args.workerId);
  useProjectStore.getState().removeAgent(args.projectId, args.workerId);
}
