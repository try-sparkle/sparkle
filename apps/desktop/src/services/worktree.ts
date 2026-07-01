// Frontend bridge to the Rust worktree commands (src-tauri/src/worktree.rs). Each agent
// gets its own isolated git worktree so agents never overwrite each other — all git
// mechanics stay hidden from the user. Tauri converts camelCase JS keys → snake_case
// Rust params automatically.
import { invoke } from "@tauri-apps/api/core";
import { loadAccountState } from "./accountSelection";

export interface WorktreeInfo {
  path: string;
  branch: string;
}

/** Backend prewarm for a project root: warm the claude + node path caches and kick a throttled
 *  background origin fetch, so the first real agent spawn is already hot. Fire-and-forget. */
export function prewarmSpawn(root: string): Promise<void> {
  return invoke("prewarm_spawn", { root });
}

// Roots we've already prewarmed this session. The caches this warms are process-global (Rust path
// caches, the throttled fetch) or module-global (the account cache), so warming a root ONCE benefits
// every later spawn on it — and this guard keeps a mount storm from firing N prewarms.
const prewarmed = new Set<string>();

/** Conservatively warm the caches an agent spawn needs (claude/node paths + background origin fetch
 *  in the backend, and the account-selection cache in the frontend) the first time we touch a
 *  project root, so subsequent spawns skip the cold-resolve latency. Idempotent per root and fully
 *  fire-and-forget — never throws, never blocks. Intended for project-open / first agent mount. */
export function prewarmProjectCaches(root: string): void {
  if (!root || prewarmed.has(root)) return;
  prewarmed.add(root);
  void prewarmSpawn(root).catch(() => {});
  void loadAccountState().catch(() => {});
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

/** Self-heal stale Claude Code hook script paths across all existing agent worktrees. The emitter
 *  and write-guard script paths are baked into each worktree's settings.local.json; if the app
 *  bundle that wrote them was renamed/replaced/removed, those paths dangle and every hook errors
 *  (MODULE_NOT_FOUND) — and the lost write-guard silently un-confines that worktree. Re-points them
 *  at a stable app-data copy. Idempotent. Resolves to the number of worktrees healed. */
export function healAgentHooks(): Promise<number> {
  return invoke<number>("heal_agent_hooks");
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
