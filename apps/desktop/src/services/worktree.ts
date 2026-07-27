// Frontend bridge to the Rust worktree commands (src-tauri/src/worktree.rs). Each agent
// gets its own isolated git worktree so agents never overwrite each other — all git
// mechanics stay hidden from the user. Tauri converts camelCase JS keys → snake_case
// Rust params automatically.
import { invoke } from "@tauri-apps/api/core";
import { loadAccountState } from "./accountSelection";
import { createWorkerWorktree } from "../pty";
import { abandonWorktreeSeed, seedWorktreeEnv } from "./envSeed";
import { useProjectStore } from "../stores/projectStore";

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
  // Make the folder a git repo up front (idempotent), not only on the first BUILD-agent spawn.
  // This is what makes a freshly-created project "just work": a build agent can spawn immediately,
  // AND in-place Think/Chief/Shell work — which runs in the project root with NO worktree — lands in
  // a version-controlled folder instead of being unrecoverable if the app later loses track of the
  // project (the hazel-eco case: a full app scaffolded in a folder that was never a git repo).
  // Serialized on the SAME per-root lock as the agent-spawn ensureProjectRepo so the two can't
  // collide on git's index.lock, and fully best-effort — a failure here never blocks the open (the
  // build-spawn path re-ensures as a backstop).
  void withRepoLock(root, () => ensureProjectRepo(root)).catch(() => {});
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

/** What `parkWorktreeOnBase` did, or the machine token for why it declined. */
export interface ParkOutcome {
  parked: boolean;
  /** `parked` | `already-fresh` | `no-worktree` | `dirty` | `unpushed` | `no-base` | `checkout-failed`. */
  reason: string;
}

/** Park an app-owned, UNATTENDED agent worktree back on a fresh `origin/<baseBranch>` before its
 *  next headless run. `createAgentWorktree` is idempotent by leaving an existing worktree alone, so
 *  a recurring pass would otherwise inherit the previous run's topic branch and drift further
 *  behind main every hour. Conservative by construction: declines (never destroys) when the tree is
 *  dirty or carries commits that aren't on any origin ref yet. Not for interactive agents — their
 *  in-progress branch must survive. */
export function parkWorktreeOnBase(
  root: string,
  projectId: string,
  agentId: string,
  baseBranch: string,
): Promise<ParkOutcome> {
  return invoke<ParkOutcome>("park_worktree_on_base", { root, projectId, agentId, baseBranch });
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
 *  app gets structured lifecycle events instead of scraping the TUI, and pre-enable Sparkle's
 *  default-on Claude Code plugins in the same file. Resolves to the absolute event-log path the
 *  emitter appends to (which a watcher then tails).
 *
 *  `projectRoot` is the repo the worktree belongs to; it only resolves the repo-scoped [plugins]
 *  layer, so a repo's `.sparkle/config.toml` can pick its own agent plugins. Omitting it falls
 *  back to the global config, which is correct — just not repo-aware. */
export function installAgentHooks(worktree: string, projectRoot?: string): Promise<string> {
  return invoke<string>("install_agent_hooks", { worktree, projectRoot });
}

/** What the install pass did for one plugin. `key` is the `[plugins]` TOML key
 *  (`superpowers`, `frontend_design`), which is how a caller maps an outcome back to its row. */
export type PluginInstallOutcome = {
  key: string;
  /** The `<plugin>@<marketplace>` id. */
  id: string;
  /** `unverified` = "we believe it's there but couldn't read Claude Code's plugin folder" — kept
   *  distinct from `alreadyPresent` so "can't see it" never renders as "it's fine". */
  status: "installed" | "alreadyPresent" | "unverified" | "failed";
  /** A user-facing sentence naming the remedy — present only when `status` is `"failed"`.
   *  Distinct remedies stay distinct: "finish setup" ≠ "check your connection". */
  message: string | null;
  /** The underlying technical error (child stderr), for a tooltip or the console — not row copy. */
  detail: string | null;
};

/** Install the Claude Code plugins the [plugins] flags turn on (`claude plugin install`, user
 *  scope, into the one shared plugin cache). Idempotent and gated on what's already on the machine,
 *  so calling it when everything is present is a filesystem check and nothing more. Runs at startup;
 *  also called when a plugin toggle is switched ON so the install doesn't wait for the next launch.
 *
 *  RESOLVING IS NOT SUCCESS. The pass is best-effort by contract — a plugin that can't install must
 *  not break agent spawning — so it resolves even when every install failed. Read `status` per
 *  plugin; a rejection here means the pass itself couldn't run.
 *
 *  `forceKey` is the `[plugins]` TOML key the user just switched on. It bypasses the per-process
 *  retry suppression FOR THAT PLUGIN, without which an install that already failed this session is
 *  skipped and toggling off and on — the only remedy the UI offers — is a silent no-op that renders
 *  as success. It names one plugin rather than being a bare flag because clearing every
 *  enabled-but-missing plugin's suppression would re-run their installs inside the same awaited
 *  call: on an offline machine, toggling one row would block on two more 90s network shell-outs for
 *  the other, which is the exact burn the suppression exists to prevent. */
export function ensureDefaultPluginsInstalled(forceKey?: string): Promise<PluginInstallOutcome[]> {
  return invoke<PluginInstallOutcome[]>("ensure_default_plugins_installed", { forceKey });
}

/** What the LAST install pass concluded, per plugin — without running one. Cheap (a cached read in
 *  Rust: no filesystem work, no shell-out), empty before any pass has run.
 *
 *  This is how a startup failure reaches the UI at all. The startup and agent-prepare passes compute
 *  a per-plugin verdict; before this existed they logged it and dropped it, so on the machine the
 *  whole mechanism is for — install fails, retries next launch, fails again — the Tools pane showed
 *  the switch ON with no hint, and the hint only appeared if the user happened to toggle. A cached
 *  read rather than an event means the pane can't miss an outcome by mounting after it fired. */
export function pluginInstallOutcomes(): Promise<PluginInstallOutcome[]> {
  return invoke<PluginInstallOutcome[]>("plugin_install_outcomes");
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
    const info = await createAgentWorktree(root, projectId, agentId, baseBranch);
    seedEnvInto(projectId, agentId, info.path);
    return info;
  });
}

/** Which worktree path each (project, agent/worker) pair was seeded into. Teardown is addressed by
 *  id, not by path, so this is how `removeAgentWorkspace` finds the seed aimed at the directory it
 *  is about to delete. */
const seededPaths = new Map<string, string>();
const seedKey = (projectId: string, agentId: string) => `${projectId}\u0000${agentId}`;

/** Kick off the 1Password env-file restore for a newly cut worktree, if the user has turned it on.
 *
 *  Deliberately NOT awaited: the worktree is ready and the caller should proceed. Seeding is a
 *  best-effort convenience that must never delay — or fail — opening an agent. See envSeed.ts.
 *
 *  The project NAME (not the id) is what the vault item titles are keyed on, so it is read from the
 *  store here rather than derived from the root path, which can differ from the project's name. */
function seedEnvInto(projectId: string, agentId: string, worktreePath: string): void {
  // The try/catch enforces "seeding never fails a spawn" HERE rather than trusting every callee to
  // keep being throw-free. The store read and the seeder are both non-throwing today; this is what
  // makes that a property of this seam instead of a fact you have to re-verify downstream.
  try {
    const project = useProjectStore.getState().projects.find((p) => p.id === projectId);
    if (!project) {
      // An evicted record, a worker re-derived from its on-disk manifest, or a store still
      // rehydrating: without the name there is no title prefix to match, so seeding is impossible
      // rather than merely empty. Say so — silence here looks identical to "the feature is off".
      // The project ID only: a worktree path is exactly what these logs keep out.
      console.warn(`env seed: no project record for ${projectId}; skipping seed`);
      return;
    }
    seededPaths.set(seedKey(projectId, agentId), worktreePath);
    seedWorktreeEnv(project.name, worktreePath);
  } catch (e) {
    console.warn("env seed: could not start the seed for this worktree", e);
  }
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
  return withRepoLock(args.root, async () => {
    const info = await createWorkerWorktree(args);
    // Workers need this MORE than agents do: a fan-out cuts many worktrees at once, and every one
    // of them would otherwise start without the project's secrets. (envSeed queues them so the
    // fan-out doesn't turn into N concurrent `op` invocations.)
    seedEnvInto(args.projectId, args.workerId, info.path);
    return info;
  });
}

/**
 * Remove this agent's worktree — serialized on the SAME per-root lock as
 * prepareAgentWorkspace. Closing one agent (git worktree remove) while another opens on
 * the same project root (git init/commit/worktree add) would otherwise race on
 * `.git/index.lock`. Always route agent-close cleanup through this, never the raw
 * removeAgentWorktree bridge, so removal queues behind any in-flight prepare/remove.
 *
 * Also settles any env seed aimed at this worktree FIRST. Seeding is fire-and-forget and so
 * escapes this lock; without that step a `git worktree remove` can run while `op` is still
 * writing into the directory, which re-creates the tree git just deleted (see envSeed.ts).
 */
export function removeAgentWorkspace(
  root: string,
  projectId: string,
  agentId: string,
): Promise<void> {
  const key = seedKey(projectId, agentId);
  const seedPath = seededPaths.get(key);
  seededPaths.delete(key);
  return withRepoLock(root, async () => {
    if (seedPath) await abandonWorktreeSeed(seedPath);
    return removeAgentWorktree(root, projectId, agentId);
  });
}
