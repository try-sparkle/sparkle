// Frontend bridge to the Rust worktree commands (src-tauri/src/worktree.rs). Each agent
// gets its own isolated git worktree so agents never overwrite each other — all git
// mechanics stay hidden from the user. Tauri converts camelCase JS keys → snake_case
// Rust params automatically.
import { invoke } from "@tauri-apps/api/core";
import { loadAccountState } from "./accountSelection";
import { createWorkerWorktree } from "../pty";
import { abandonWorktreeSeed, seedWorktreeEnv } from "./envSeed";
import { abandonWorktreeBootstrap, bootstrapWorktreeDeps } from "./depsBootstrap";
import { stopPreviewForAgent } from "./preview";
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

/** What a park may do about a worktree that is dirty with something other than the session-tooling
 *  churn the Rust side already whitelists.
 *
 *  `"decline"` is the DEFAULT and is what an omitted argument means: leave the tree exactly as
 *  found. `"stash"` sets the leftovers aside into a per-agent stash (untracked files included) and
 *  parks anyway — never commits them, never discards them, so every line stays recoverable by hand.
 *  Only pass `"stash"` for a worktree the APP owns end to end; a user's own project worktree keeps
 *  the decline-don't-touch semantics, because their uncommitted edits are not ours to relocate. */
export type DirtyPolicy = "decline" | "stash";

/** What `parkWorktreeOnBase` did, or the machine token for why it declined. */
export interface ParkOutcome {
  parked: boolean;
  /** `parked` | `already-fresh` | `no-worktree` | `in-use` | `dirty` | `unpushed` | `no-base` |
   *  `checkout-failed`. `in-use` means a LIVE session holds the worktree lease, so the park refused
   *  to reset the branch out from under it (bead sparkle-hc7hvm). */
  reason: string;
  /** True when the park pushed a stash — session-tooling churn, or (under `"stash"`) the whole
   *  leftover tree. Means "something was set aside and is recoverable from `git stash list`".
   *
   *  OPTIONAL on purpose. Rust always sends it, but typing it as required would break every test
   *  double that returns a bare `{parked, reason}` — and forcing those to grow a field they do not
   *  exercise buys nothing. Read it as `park.stashed === true`, never as a bare truthiness check on
   *  an outcome that may predate the field. */
  stashed?: boolean;
}

/** Park an app-owned, UNATTENDED agent worktree back on a fresh `origin/<baseBranch>` before its
 *  next headless run. `createAgentWorktree` is idempotent by leaving an existing worktree alone, so
 *  a recurring pass would otherwise inherit the previous run's topic branch and drift further
 *  behind main every hour. Conservative by construction: declines (never destroys) when the tree
 *  carries commits that aren't on any origin ref yet, and — unless `dirtyPolicy` says otherwise —
 *  when it is dirty. Not for interactive agents: their in-progress branch must survive. */
export function parkWorktreeOnBase(
  root: string,
  projectId: string,
  agentId: string,
  baseBranch: string,
  dirtyPolicy?: DirtyPolicy,
): Promise<ParkOutcome> {
  return invoke<ParkOutcome>("park_worktree_on_base", {
    root,
    projectId,
    agentId,
    baseBranch,
    dirtyPolicy,
  });
}

/** Acquire or refresh (heartbeat) the worktree lease for `(projectId, agentId)`.
 *
 *  The INTERACTIVE occupant of an app-owned SHARED worktree — notably the "Improve Sparkle" pane,
 *  which keys on the same `__sparkle_self__` id as the hourly headless pass — calls this on mount
 *  and on an interval below the lease TTL. While the lease is fresh, `parkWorktreeOnBase` refuses to
 *  reset the branch out from under the live session (`reason: "in-use"`) instead of switching HEAD
 *  and stashing its edits (bead sparkle-hc7hvm). Best-effort; a failure here is not fatal — the
 *  park's own conservative valves still stand underneath the lease. */
export function acquireWorktreeLease(
  root: string,
  projectId: string,
  agentId: string,
): Promise<void> {
  return invoke("acquire_worktree_lease", { root, projectId, agentId });
}

/** Release the worktree lease so the headless park may run again immediately rather than waiting
 *  out the TTL. An already-absent lease is success. */
export function releaseWorktreeLease(
  root: string,
  projectId: string,
  agentId: string,
): Promise<void> {
  return invoke("release_worktree_lease", { root, projectId, agentId });
}

/** Remove an agent's worktree (leaves the branch so it can resume later). */
export function removeAgentWorktree(
  root: string,
  projectId: string,
  agentId: string,
): Promise<void> {
  return invoke("remove_agent_worktree", { root, projectId, agentId });
}

/** What became of the working directory of a process still holding a reserved dev port.
 *
 *  Mirrors the Rust `dev_port_preflight::CwdState`, which serializes kebab-case. */
export type DevPortCwdState = "evacuated" | "deleted" | "live" | "unknown";

/** One process listening on the port. Every optional field is a Rust `Option`, so it crosses the
 *  wire as `null` and NEVER as an absent key — `| null`, not `?:` (AGENTS.md, "A Rust `Option`
 *  crosses the wire as `null`"). */
export interface DevPortHolder {
  pid: number;
  addr: string;
  command?: string | null;
  cwd?: string | null;
  cwdState: DevPortCwdState;
}

/** The preflight's answer.
 *
 *  `"undetermined"` is deliberately NOT `"free"`: a probe that could not run must never read as an
 *  all-clear, which is the shape that turns a broken diagnostic into a false clean bill of health. */
export interface DevPortReport {
  port: number;
  verdict: "free" | "held" | "undetermined";
  holders: DevPortHolder[];
  /** The sentence to show a human. Empty ONLY when the port is free. */
  message: string;
}

/** Ask who is listening on a reserved dev port (default: Sparkle's own 1420).
 *
 *  REPORT ONLY — the Rust command reads `lsof`/`ps` and returns text. It kills nothing, and there is
 *  no code path from it to a signal (bead `sparkle-r28em`). */
export function devPortPreflight(port?: number): Promise<DevPortReport> {
  return invoke("dev_port_preflight", { port: port ?? null });
}

/**
 * What a WIP snapshot did. `sha` is a Rust `Option<String>`, so it arrives as `null` and NEVER as an
 * absent key — hence `string | null` rather than the `sha?: string` the shape invites (AGENTS.md,
 * "A Rust `Option` crosses the wire as `null`").
 *
 * `sha` MAY BE NULL ON EVERY KIND, `"committed"` included. It was documented as non-null for that
 * one, and that is now false in both directions: the bookkeeping after the commit is best-effort on
 * purpose, so a `rev-parse` that could not be read degrades the REPORT rather than discarding a
 * commit that was really made. Read it as "the snapshot happened; here is its sha if we could name
 * it" — never as a guarantee, and never with `!` (roborev 64480).
 */
export interface WipCommitOutcome {
  kind: "committed" | "committed-detached" | "nothing-to-commit" | "no-worktree";
  sha: string | null;
  files: number;
  /** Set only for `"committed-detached"`: the ref holding a commit that is on no branch. */
  rescueRef: string | null;
}

/**
 * Commit whatever is uncommitted in an agent's (or worker's) worktree onto its own branch, so the
 * teardown that follows cannot take that work with it. See `commit_worktree_wip_at` in
 * `worktree.rs` for the three choices behind it (`--no-verify`, `add -A`, fallback identity).
 *
 * The branch SURVIVES a spin-down by design and the worktree does not, which is the whole asymmetry
 * this closes: before it, a killed worker's edits lived only in the directory teardown deletes.
 */
export function commitWorktreeWip(
  projectId: string,
  agentId: string,
  message?: string,
): Promise<WipCommitOutcome> {
  return invoke<WipCommitOutcome>("commit_worktree_wip", { projectId, agentId, message });
}

/**
 * The result of a PERIODIC autosave (`autosave_worktree_wip`). Unlike the teardown snapshot, this
 * never touches the agent's index, HEAD, branch, or hooks — it anchors the work to a side ref
 * (`refs/sparkle-autosave/<agentId>`) built out of band. Every field is `string | null` because a
 * Rust `Option` crosses the wire as `null`, never an absent key (AGENTS.md).
 */
export interface AutosaveOutcome {
  /** `snapshotted` captured work to the side ref; `nothing-to-commit` a clean tree; `no-worktree`
   *  none at that slot; `skipped-mid-operation` a merge/rebase/cherry-pick was in progress so the
   *  worktree was left entirely alone. */
  kind: "snapshotted" | "nothing-to-commit" | "no-worktree" | "skipped-mid-operation";
  /** The snapshot commit — set only for `snapshotted`. */
  sha: string | null;
  /** The side ref holding the snapshot — set only for `snapshotted`. */
  refName: string | null;
  files: number;
}

/**
 * Periodic autosave of a LIVE agent's uncommitted work to its side ref
 * (`refs/sparkle-autosave/<agentId>`). Safe to run while the agent is working: it stages into a
 * throwaway index and uses `write-tree`/`commit-tree` plumbing (which fires NO hooks) + `update-ref`,
 * so the agent's index, HEAD, branch and working diff are untouched, and it never triggers the
 * project's `post-commit` review hook. Best-effort: the caller treats any rejection as "nothing saved
 * this tick". See `autosave_worktree_wip_at` in `worktree.rs`.
 */
export function autosaveWorktreeWip(projectId: string, agentId: string): Promise<AutosaveOutcome> {
  return invoke<AutosaveOutcome>("autosave_worktree_wip", { projectId, agentId });
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

/** Register ONLY the Claude Code event hooks (the `sparkle-hook.mjs` emitter) in an APP-OWNED
 *  worktree's `settings.local.json`, so peer messages queued to that agent drain at its next turn
 *  boundary. Resolves to the absolute event-log path.
 *
 *  NOT a variant of {@link installAgentHooks} to reach for casually — it is the SURGICAL half, and
 *  the difference is the point. `installAgentHooks` also pre-enables plugins and writes the
 *  permission posture (`bypassPermissions` and its consent record); this writes event hooks and
 *  nothing else. An app-owned worktree's posture is set elsewhere and must not change as a side
 *  effect of registering a mailbox drain.
 *
 *  WHY IT IS CALLED AT PANE PREPARE (bead sparkle-6yrvqd). The drain rides the `Stop` hook, and
 *  until this existed the only thing that ever registered that hook in the canonical
 *  `__sparkle_self__` worktree was the hourly improvement pass. Measured 2026-09-04: it never had —
 *  that worktree carried two hook events, neither of them the emitter, where an ordinary agent
 *  carries nine — so 114 messages queued and `delivered` was 0 for the inbox's whole lifetime.
 *  Registering here makes the drain a property of the agent being MOUNTED rather than of an
 *  unrelated background pass having happened to run first. */
export function installInboxDrainHooks(worktree: string): Promise<string> {
  return invoke<string>("install_inbox_drain_hooks", { worktree });
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
    // Recorded BEFORE either background task starts, and independently of whether either one
    // decides it has work to do — teardown must be able to settle them regardless.
    preparedPaths.set(seedKey(projectId, agentId), info.path);
    seedEnvInto(projectId, agentId, info.path);
    bootstrapDepsInto(info.path);
    return info;
  });
}

/** Kick off the dependency install for a newly cut worktree.
 *
 *  Deliberately NOT awaited, for the same reason as the env seed and then some: a `pnpm install`
 *  measures ~27s even against a fully warm store, and nobody will wait that long to open an agent.
 *
 *  The try/catch enforces "bootstrapping never fails a spawn" AT THIS SEAM rather than trusting the
 *  callee to stay throw-free — the same reasoning as seedEnvInto above. A machine with no pnpm on
 *  its PATH must still be able to open agents; the worst case is the status quo, a worktree whose
 *  tests cannot run, which is what every worktree had before this existed. */
function bootstrapDepsInto(worktreePath: string): void {
  try {
    bootstrapWorktreeDeps(worktreePath);
  } catch (e) {
    console.warn("deps bootstrap: could not start the install for this worktree", e);
  }
}

/** Which worktree path each (project, agent/worker) pair was prepared into. Teardown is addressed
 *  by id, not by path, so this is how `removeAgentWorkspace` finds the directory it is about to
 *  delete in order to settle the background work aimed at it.
 *
 *  Written by the PREPARE seams, not by either background task. It used to be written inside
 *  `seedEnvInto`, BELOW its `if (!project) return` guard — which silently coupled the dependency
 *  bootstrap's teardown handshake to whether the ENV SEED found a project record. When it did not
 *  (an evicted record, a worker re-derived from its on-disk manifest, a store still rehydrating —
 *  all documented real cases), an install was queued for a worktree that teardown then deleted
 *  without waiting: a package manager writing into a directory git had just removed, leaving a
 *  stray non-empty directory at a slot path a later `git worktree add` fails on. Recording the path
 *  where the worktree is actually CUT is what makes the handshake unconditional. */
const preparedPaths = new Map<string, string>();
const seedKey = (projectId: string, agentId: string) => `${projectId}\u0000${agentId}`;

/** Kick off the env-file copy for a newly cut worktree, if the user has turned it on.
 *
 *  Deliberately NOT awaited: the worktree is ready and the caller should proceed. Seeding is a
 *  best-effort convenience that must never delay — or fail — opening an agent. See envSeed.ts.
 *
 *  The project's ROOT PATH is what seeding needs — the files are copied from the project's own
 *  checkout, not downloaded from 1Password (bead sparkle-y5xc9), so this path makes no `op` call
 *  and can never raise an authorization prompt. It is read from the store rather than derived from
 *  the worktree path, which points at app data and holds none of the originals. */
function seedEnvInto(projectId: string, agentId: string, worktreePath: string): void {
  // The try/catch enforces "seeding never fails a spawn" HERE rather than trusting every callee to
  // keep being throw-free. The store read and the seeder are both non-throwing today; this is what
  // makes that a property of this seam instead of a fact you have to re-verify downstream.
  try {
    const project = useProjectStore.getState().projects.find((p) => p.id === projectId);
    if (!project) {
      // An evicted record, a worker re-derived from its on-disk manifest, or a store still
      // rehydrating: without the record there is no source checkout to copy from, so seeding is
      // impossible rather than merely empty. Say so — silence here looks identical to "the feature
      // is off". The project ID only: a worktree path is exactly what these logs keep out.
      console.warn(`env seed: no project record for ${projectId}; skipping seed`);
      return;
    }
    seedWorktreeEnv(project.rootPath, worktreePath);
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
    preparedPaths.set(seedKey(args.projectId, args.workerId), info.path);
    seedEnvInto(args.projectId, args.workerId, info.path);
    // Workers need this at least as much as agents: a fan-out cuts many worktrees at once and every
    // worker is expected to run the suite before reporting back. Without it, "tests passed" from a
    // worker means "tests never ran".
    bootstrapDepsInto(info.path);
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
 * Also settles the three writers aimed at this worktree FIRST — the env seed, the dependency
 * bootstrap, and the preview dev server. All three escape this lock by design; without that step a
 * `git worktree remove` can run while `op`, a package manager, or a dev server is still writing into
 * the directory, which re-creates the tree git just deleted (see envSeed.ts / depsBootstrap.ts /
 * stopPreviewBeforeTeardown below).
 */
export function removeAgentWorkspace(
  root: string,
  projectId: string,
  agentId: string,
  opts?: RemoveWorkspaceOptions,
): Promise<void> {
  const key = seedKey(projectId, agentId);
  const preparedPath = preparedPaths.get(key);
  preparedPaths.delete(key);
  return withRepoLock(root, async () => {
    // CONCURRENTLY, not one after the other. Each wait is separately bounded and all of them run
    // inside the per-root git lock that every other prepare/remove on this project queues behind.
    // Serialized, the worst case is the sum — and since an install measures ~27s, hitting the bound
    // is the common case when an agent is closed shortly after opening, multiplied by N because
    // a project's agents are closed one at a time. There is no ordering requirement among them;
    // the only ordering that matters is that ALL of them land before the removal below.
    const settles: Promise<unknown>[] = [stopPreviewBeforeTeardown(agentId)];
    if (preparedPath) {
      settles.push(abandonWorktreeSeed(preparedPath), abandonWorktreeBootstrap(preparedPath));
    }
    await Promise.all(settles);
    // SNAPSHOT BEFORE THE DELETE, for every caller that keeps the branch (see RemoveWorkspaceOptions).
    // Placed HERE — after the two writer handshakes, inside the per-root lock — rather than at the
    // call sites, which would run it while the env seed and the dependency bootstrap are certainly
    // still writing.
    //
    // BUT `abandonWorktreeBootstrap` IS A BOUNDED RACE, NOT A SETTLE (roborev 64457): it waits 5s and
    // deliberately never kills an install the surrounding comments measure at ~27s. So a package
    // manager can still be writing here, and the honest guarantee is not "the tree is quiet" — it is
    // that the whole snapshot shares ONE deadline (`WIP_SNAPSHOT_TIMEOUT`, ~20s for the entire
    // sequence, not per git call), so a busy tree costs a skipped snapshot rather than a wedged
    // teardown holding the per-root lock.
    if (opts?.snapshotWip) await snapshotBeforeTeardown(projectId, agentId);
    return removeAgentWorktree(root, projectId, agentId);
    // The dev-port report is chained OUTSIDE this callback, deliberately, so it runs once the
    // per-root git lock is released — see reportDevPortAfterTeardown.
  }).then(reportDevPortAfterTeardown);
}

/**
 * Say who is still holding the dev port, now that this worktree is gone (bead `sparkle-r28em`).
 *
 * A dev server a human or an agent started themselves in a PTY (`pnpm dev`, `tauri dev`) is in no
 * preview registry, so `stopPreviewBeforeTeardown` above never knew about it and
 * `preview.ts::sweep_orphans` will never reclaim it. It keeps running with its cwd pointing at a
 * checkout that has just been renamed into worktree-trash — and because vite is `strictPort` on the
 * one port `tauri.conf.json` names as `devUrl`, there is NO fallback: every later `tauri dev` on
 * this machine dies with a bare "port is already in use" that names neither the process nor where it
 * came from. Somebody then burns an afternoon rediscovering it, which is the incident behind the
 * bead.
 *
 * This is the moment to say so, because it is the moment the orphan is CREATED — hours before the
 * next `tauri dev` meets the wall.
 *
 * OUTSIDE THE PER-ROOT GIT LOCK, and that placement is the point of the `.then` rather than another
 * line inside the callback: the probe shells out to `lsof` twice and `ps` once, bounded at 5s each,
 * and every other prepare/remove on this project queues behind that lock. A diagnostic that adds up
 * to 15s of lock-held latency to every teardown would not survive its first measurement.
 *
 * REPORT ONLY, and NEVER REJECTS — the same guarantee `stopPreviewBeforeTeardown` gives, for the
 * same reason. `removeAgentWorkspace` resolves `void`, so this returns `void` too: a probe that
 * could turn a completed teardown into a rejected promise would strand the agent's concurrency slot
 * over a log line.
 */
async function reportDevPortAfterTeardown(): Promise<void> {
  try {
    const report = await devPortPreflight();
    // `message` is empty ONLY for a free port, which is the overwhelmingly common outcome. Gating
    // on the message rather than on `verdict === "held"` is deliberate: it also surfaces
    // "could not determine", which is a real answer a reader may need, without this call site having
    // to re-derive which verdicts carry text.
    if (report?.message) {
      console.warn(`dev port: ${report.message}`);
    }
  } catch (e) {
    // Includes the case where the command is not registered at all (an older backend). A missing
    // diagnostic is not worth a word to the user.
    console.debug("dev port: could not run the post-teardown preflight", e);
  }
}

/** Options for {@link removeAgentWorkspace}. */
export interface RemoveWorkspaceOptions {
  /**
   * Commit uncommitted worktree edits onto the agent's own branch before the worktree is deleted.
   *
   * Pass this from every SAVE-semantics teardown — the ones that keep the branch precisely so work
   * is not lost (worker spin-down, build-agent close, the sidebar's ×). Do NOT pass it from
   * `discardAgentGit`, where destroying unmerged work is the whole point of the operation, nor from
   * a spawn rollback, where the worktree was cut seconds ago and holds nothing.
   */
  snapshotWip?: boolean;
}

/**
 * Best-effort WIP snapshot: never throws, because a teardown must not be blockable. A refusal here
 * would strand the agent's concurrency slot permanently, which is a worse failure than the loss this
 * prevents.
 *
 * A DETACHED head is reported differently on purpose — the commit is on no branch and is held only
 * by a rescue ref, so saying "salvaged to the branch" would be a false claim about where the work is.
 */
async function snapshotBeforeTeardown(projectId: string, agentId: string): Promise<void> {
  try {
    const r = await commitWorktreeWip(projectId, agentId, `wip: ${agentId} before teardown`);
    if (r.kind === "committed") {
      console.warn(
        // `sha ?? …` — a bare null renders as "... as null", which reads as a bug rather than as
        // "the commit is safe, we just could not name it" (roborev 64480).
        `removeAgentWorkspace: salvaged ${r.files} uncommitted path(s) to ${agentId}'s branch as ` +
          `${r.sha ?? "(sha unreadable — the commit was made)"}`,
      );
    } else if (r.kind === "committed-detached") {
      console.warn(
        `removeAgentWorkspace: ${agentId} had a DETACHED head — ${r.files} path(s) committed as ` +
          `${r.sha ?? "(sha unreadable)"}, reachable only via ` +
          `${r.rescueRef ?? "(no rescue ref could be written)"}`,
      );
    }
  } catch (e) {
    console.warn("removeAgentWorkspace: WIP snapshot failed; tearing down anyway", e);
  }
}

/** Stop this agent's preview dev server before its checkout is evacuated (bead sparkle-3475b.6;
 *  docs/live-browser-preview.md §5, "Interlock with worktree teardown").
 *
 *  A preview is the one writer that outlives the agent's own processes: a `next dev`/`vite` whose
 *  cwd is INSIDE the worktree, still compiling into `.next/` or `node_modules/.vite` while
 *  `remove_agent_worktree` renames that directory into worktree-trash and deletes it on a background
 *  thread. The failure is the same stray-non-empty-slot hazard the seed and bootstrap handshakes
 *  above exist to prevent, with a longer-lived writer behind it.
 *
 *  UNCONDITIONAL — deliberately no local "did this agent have a preview" guard. The Rust command is
 *  a map lookup over live servers that answers `not-found` when there is none
 *  (`preview.rs::preview_stop_for_agent`), so the common case is already cheaper than any state read
 *  we could do here. A frontend-store guard would also fail exactly where it matters: after a window
 *  reload the store is empty while the server is still running.
 *
 *  NEVER REJECTS. A stray preview must not be able to wedge cleanup — an un-removed worktree is a
 *  permanent problem (its slot path fails a later `git worktree add`), while a preview that outlived
 *  its stop is a leaked process the supervisor's own reaping still covers. The try/catch is for a
 *  synchronous throw before the promise exists; the `.then` rejection arm is for the IPC failing. */
function stopPreviewBeforeTeardown(agentId: string): Promise<void> {
  try {
    return Promise.resolve(stopPreviewForAgent(agentId)).then(
      () => undefined,
      (e: unknown) => {
        console.warn("preview: could not stop before worktree teardown; removing anyway", e);
      },
    );
  } catch (e) {
    console.warn("preview: could not start the stop before worktree teardown", e);
    return Promise.resolve();
  }
}
