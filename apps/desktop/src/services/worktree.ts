// Frontend bridge to the Rust worktree commands (src-tauri/src/worktree.rs). Each agent
// gets its own isolated git worktree so agents never overwrite each other — all git
// mechanics stay hidden from the user. Tauri converts camelCase JS keys → snake_case
// Rust params automatically.
import { invoke } from "@tauri-apps/api/core";

export interface WorktreeInfo {
  path: string;
  branch: string;
}

/** Make sure the project folder is a git repo with at least one commit (idempotent). */
export function ensureProjectRepo(path: string): Promise<void> {
  return invoke("ensure_project_repo", { path });
}

/** Create (or reuse) an isolated worktree for an agent, cut from `baseBranch` (the project's
 *  logical integration branch). Returns its path + branch. */
export function createAgentWorktree(
  root: string,
  projectId: string,
  agentId: string,
  baseBranch: string,
): Promise<WorktreeInfo> {
  return invoke<WorktreeInfo>("create_agent_worktree", { root, projectId, agentId, baseBranch });
}

/** Remove an agent's worktree (leaves the branch so it can resume later). */
export function removeAgentWorktree(
  root: string,
  projectId: string,
  agentId: string,
): Promise<void> {
  return invoke("remove_agent_worktree", { root, projectId, agentId });
}

/** Tripwire: throws if the worktree's git toplevel isn't the worktree itself. */
export function assertWorkspaceIntegrity(worktree: string): Promise<void> {
  return invoke("assert_workspace_integrity", { worktree });
}

/** Install/merge the PreToolUse write-guard into the worktree's settings.local.json. */
export function installWorktreeGuard(worktree: string): Promise<void> {
  return invoke("install_worktree_guard", { worktree });
}

/** Register Claude Code event hooks () in the worktree's settings.local.json so the
 *  app gets structured lifecycle events instead of scraping the TUI. Resolves to the absolute
 *  event-log path the emitter appends to (which a watcher then tails). */
export function installAgentHooks(worktree: string): Promise<string> {
  return invoke<string>("install_agent_hooks", { worktree });
}

/** Move/rename a project folder on disk and repair its worktree links. Stop the
 * project's agents before calling (their PTYs hold the old working directory). */
export function moveProjectFolder(oldPath: string, newPath: string): Promise<void> {
  return invoke("move_project", { oldPath, newPath });
}

// Serialize git operations per project root: opening several agents at once would
// otherwise run concurrent `git init`/`commit`/`worktree add` against the same repo and
// collide on `index.lock`. Each root keeps a promise chain; new ops queue behind it.
const repoLocks = new Map<string, Promise<unknown>>();

function withRepoLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const prev = repoLocks.get(root) ?? Promise.resolve();
  const next = prev.then(fn, fn); // run fn regardless of the previous op's outcome
  repoLocks.set(
    root,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

/**
 * Ensure the project repo exists and create this agent's isolated worktree — serialized
 * per project root so concurrent agent opens can't collide on git locks.
 */
export function prepareAgentWorkspace(
  root: string,
  projectId: string,
  agentId: string,
  baseBranch: string,
): Promise<WorktreeInfo> {
  return withRepoLock(root, async () => {
    await ensureProjectRepo(root);
    return createAgentWorktree(root, projectId, agentId, baseBranch);
  });
}

/**
 * Remove this agent's worktree — serialized on the SAME per-root lock as
 * prepareAgentWorkspace. Closing one agent (git worktree remove) while another opens on
 * the same project root (git init/commit/worktree add) would otherwise race on
 * `.git/index.lock`. Always route agent-close cleanup through this, never the raw
 * removeAgentWorktree bridge, so removal queues behind any in-flight prepare/remove.
 */
export function removeAgentWorkspace(
  root: string,
  projectId: string,
  agentId: string,
): Promise<void> {
  return withRepoLock(root, () => removeAgentWorktree(root, projectId, agentId));
}
