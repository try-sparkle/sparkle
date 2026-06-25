// Programmatically spawn a worker agent under a build agent: register the tab, cut its worktree
// from the parent's local branch, and persist the worktree. The PTY launch happens when the
// worker tab opens (AgentPane), driven by the worker persona + the stored task.
import { useProjectStore } from "../stores/projectStore";
import { createWorkerWorktree, type WorktreeInfo } from "../pty";

export async function spawnWorker(args: {
  projectId: string;
  parentAgentId: string;
  task: string;
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
  return workerId;
}
