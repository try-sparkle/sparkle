// One-click "Close Build Agent" (spin down a shipped build agent). Composes the existing teardown
// pieces: drop the agent + its workers from the stores, remove their worktrees, and — per the
// `delete_merged_branch` workflow setting — SAFELY delete each now-merged branch. The branch delete
// uses `git branch -d` (refuses an unmerged branch), so a mis-fire can never lose unmerged work.
//
// Used by the green "Close Build Agent" suggestion-row button, which only appears once an agent has
// actually shipped/landed (runtimeStore.workflowShipped), so closing is safe and one-click.
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useSettingsStore } from "../stores/settingsStore";
import { terminateIfCloud } from "./cloudAgents/terminate";
import { spinDownAgentGit } from "./closeAgentActions";

/** Resolve the project + worker ids for a build agent, then tear it (and its workers) down. */
export async function closeBuildAgent(buildAgentId: string): Promise<void> {
  const project = useProjectStore
    .getState()
    .projects.find((p) => p.agents.some((a) => a.id === buildAgentId));
  if (!project) return; // already gone

  const workerIds = project.agents.filter((a) => a.parentId === buildAgentId).map((a) => a.id);
  const ids = [buildAgentId, ...workerIds];

  // A CLOUD agent's deliberate close is a gesture that means "stop the sandbox" — the pane's unmount
  // only detaches (the session survives the pane by design), so without this the sandbox would keep
  // metering until idle-pause and re-attach would resurrect the tab on the next project open. Over
  // the whole subtree, and shared with the sidebar × / Discard so every close path terminates every
  // sandbox it drops (roborev 46339, 46881, 46918). CONCURRENT, not sequential: each DELETE
  // carries its own deadline, and N cloud rows awaited in series could stall the visible teardown
  // for N deadlines on a black-holed connection (roborev 47220).
  await Promise.all(ids.map((id) => terminateIfCloud(project.agents.find((a) => a.id === id))));

  // Store teardown first: drop each from the open set (unmounts the pane → kills PTY + stops the
  // orchestration bridge). Keep this before the git teardown so nothing is mid-write on the worktree.
  const { close } = useRuntimeStore.getState();
  for (const id of ids) close(id);

  await spinDownAgentGit({
    root: project.rootPath,
    projectId: project.id,
    ids,
    deleteBranch: useSettingsStore.getState().deleteMergedBranch,
  });

  // Finally drop the build agent (and, via cascade, its workers) from the sidebar.
  useProjectStore.getState().removeAgent(project.id, buildAgentId);
}
