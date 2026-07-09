// Frontend bridge to the Rust worktree commands (src-tauri/src/worktree.rs). Each agent
// gets its own isolated git worktree so agents never overwrite each other — all git
// mechanics stay hidden from the user. Tauri converts camelCase JS keys → snake_case
// Rust params automatically.
import { invoke } from "@tauri-apps/api/core";
import { loadAccountState } from "./accountSelection";
import { createWorkerWorktree } from "../pty";

export interface WorktreeInfo {
  path: string;
  branch: string;
}

/** The durable per-worktree worker manifest (`.sparkle/worker.json`), the disk-authoritative copy
 *  of a worker's identity + ownership (sparkle-hwfv). Written at spawn BEFORE the orchestration
 *  reply, so an evicted in-memory projectStore record can be re-derived from disk without an app
 *  restart. `worktree` is filled in from the actual on-disk path by scanWorkerManifests. */
export interface WorkerManifest {
  workerId: string;
  buildAgentId: string;
  projectId: string;
  branch: string;
  worktree: string;
  task: string;
  beadId?: string;
  createdAt: string;
}

/** Write a worker's durable manifest into its worktree. Awaited at spawn before replying so the
 *  disk record can never lag the reply (sparkle-hwfv / a670). */
export function writeWorkerManifest(worktree: string, manifest: WorkerManifest): Promise<void> {
  return invoke("write_worker_manifest", { worktree, manifest });
}

/** Read a single worker's manifest from its worktree; null if none has been written yet. */
export function readWorkerManifest(worktree: string): Promise<WorkerManifest | null> {
  return invoke<WorkerManifest | null>("read_worker_manifest", { worktree });
}

/** Scan a project's worktrees for worker manifests — the on-disk half of ownership reconcile
 *  (sparkle-3xus). Each returned manifest's `worktree` is the real directory found on disk.
 *  Best-effort: malformed/legacy entries are dropped by the backend, so this never throws on a
 *  stray file. */
export function scanWorkerManifests(projectId: string): Promise<WorkerManifest[]> {
  return invoke<WorkerManifest[]>("scan_worker_manifests", { projectId });
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

/** Warm this project's pre-warmed worktree pool up to the configured size (off the main thread), so
 *  a later agent spawn can CLAIM a ready worktree instead of paying `git worktree add` on the
 *  critical path. No-op when `[worktree_pool].enabled = false`. Fire-and-forget: never throws, never
 *  blocks — the pool is a pure optimization. Called on project open/activation. */
export function warmWorktreePool(root: string, projectId: string, baseBranch: string): Promise<void> {
  return invoke("warm_worktree_pool", { root, projectId, baseBranch });
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
 * Cut a worker's isolated worktree from its parent branch — serialized on the SAME per-root lock
 * as prepareAgentWorkspace/removeAgentWorkspace. Worker spawn previously called createWorkerWorktree
 * RAW (bypassing this lock), so two concurrent spawn_worker calls ran parallel `git worktree add`
 * on the same repo and collided on `.git/index.lock`, leaving dead, un-initialized worktrees
 * (sparkle-<id>). Routing it through withRepoLock queues worker cuts behind any other git op on the
 * root — the fix for the concurrent-spawn corruption that yk3x's authoritative-reply change didn't
 * cover.
 */
export function prepareWorkerWorkspace(args: {
  root: string;
  projectId: string;
  workerId: string;
  parentBranch: string;
}): Promise<WorktreeInfo> {
  return withRepoLock(args.root, () => createWorkerWorktree(args));
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
