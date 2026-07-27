import { invoke } from "@tauri-apps/api/core";

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Giving a freshly-cut worktree the dependencies it needs to run its own tests.
//
// A git worktree carries only TRACKED files, and `node_modules` is gitignored everywhere. So every
// agent and every worker has, until now, started life in a directory where `pnpm -r test` dies in
// about four seconds with `sh: vitest: command not found`. Measured on this machine: 44 of 84 live
// agent worktrees had no `node_modules` at any level.
//
// That matters more than it looks. This repo's agent instructions require running the suite before
// committing, so a worktree that cannot run tests leaves an agent two choices — burn a minute
// rediscovering that it has to install first, or commit unverified. The second is what happens, and
// it is invisible in the diff.
//
// Measured cost of closing it (this repo, warm pnpm store): 27s wall, zero downloads, 1,492 packages
// hardlinked from the shared store, 91 MB of real disk per worktree.
//
// This module is modelled directly on envSeed.ts, and for the same reasons — the two share every
// hazard, because both are best-effort work aimed at a directory git may delete underneath them:
//
//   • NEVER BLOCK THE SPAWN. 27 seconds is far past what anyone will wait to open an agent, so this
//     is fire-and-forget. The caller gets its worktree immediately and `node_modules` lands later.
//   • NEVER FAIL THE SPAWN. Every failure is swallowed and logged. A missing pnpm, a lockfile that
//     no longer matches, a full disk — none of those are reasons to stop the user opening an agent.
//     The worst case is precisely the status quo: a worktree with no `node_modules`.
//   • ONCE PER WORKTREE, not once per open. `prepareAgentWorkspace` runs on every agent mount and
//     worktree slots are reused, so an unguarded call spawns a package manager every single time an
//     agent is opened, to discover there is nothing to do.
//   • ONE AT A TIME. A worker fan-out cuts many worktrees at once, and every install writes through
//     the same shared package-manager store. Queued means callers still never wait — they just get
//     their dependencies in sequence instead of thrashing one store with N writers.
//
// The Rust side (`bootstrap_worktree_deps`) decides whether an install is warranted at all, and
// skips instantly on a non-JS repo, a worktree that already has `node_modules`, or a `package.json`
// with no lockfile. It never resolves a fresh dependency graph — a background convenience task must
// not be able to rewrite someone's lockfile.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** What the Rust command reports back. `status` is the only field callers switch on. */
interface BootstrapOutcome {
  status: "installed" | "skipped" | "failed";
  detail: string | null;
  manager: string | null;
}

/** Worktree paths whose bootstrap has SETTLED without throwing this session.
 *
 *  Recorded on completion, not on attempt: a bootstrap that threw (no pnpm on PATH, a lockfile
 *  mismatch) must be retried the next time the agent is opened, because reopening is the user's
 *  entire recovery path after fixing the cause. Marking on attempt poisons the path until restart.
 *
 *  A `skipped` or `failed` OUTCOME still counts as settled — those are answers from Rust, not
 *  transport failures, and re-asking produces the same answer at the cost of another subprocess. */
const bootstrapped = new Set<string>();

/** A bootstrap that has been queued and has not yet settled. */
interface PendingBootstrap {
  /** Resolves when THIS bootstrap finishes or is skipped. Never chained to the ones ahead of it, so
   *  a teardown does not wait out the whole queue. */
  settled: Promise<void>;
  /** Distinguishes "still waiting its turn" (droppable instantly) from "a package manager is
   *  writing into that directory right now" (a teardown has to wait for it). */
  running: boolean;
  /** The worktree was torn down after this was queued. Recorded on the ENTRY, not in a path-keyed
   *  set: a later bootstrap for the same path is a different object, and a shared key would let the
   *  new one un-abandon the stale one — which would then install into the fresh worktree. */
  abandoned: boolean;
}
const inFlight = new Map<string, PendingBootstrap>();

/** The serialization point: every bootstrap chains onto this, so at most one install runs at a time. */
let queue: Promise<void> = Promise.resolve();

/**
 * Install a freshly-cut worktree's dependencies so the agent in it can run the repo's tests.
 *
 * Fire-and-forget by design — returns immediately, never rejects, never blocks the spawn. See the
 * module comment for why each of those is load-bearing rather than merely convenient.
 */
export function bootstrapWorktreeDeps(worktreePath: string): void {
  // An empty key would collapse every worktree onto one entry.
  if (!worktreePath) return;
  // Already settled this session — re-asking buys another subprocess and the same answer.
  if (bootstrapped.has(worktreePath)) return;
  // Already queued for this path; don't stack a second one behind it. (An ABANDONED entry is
  // retired by abandonWorktreeBootstrap rather than left here, so a worktree re-cut at this path
  // can still queue a fresh bootstrap.)
  if (inFlight.has(worktreePath)) return;

  let markSettled!: () => void;
  const pending: PendingBootstrap = {
    settled: new Promise<void>((resolve) => {
      markSettled = resolve;
    }),
    running: false,
    abandoned: false,
  };
  inFlight.set(worktreePath, pending);

  const run = queue.then(async () => {
    try {
      // The worktree may have been torn down while this waited its turn. Installing now would
      // recreate the directory git just deleted, leaving a stray non-empty directory at a slot path
      // that a later `git worktree add` then fails on.
      if (pending.abandoned) return;
      pending.running = true;
      try {
        const outcome = await invoke<BootstrapOutcome>("bootstrap_worktree_deps", {
          worktree: worktreePath,
        });
        // Not when the worktree was torn down mid-install: marking then would make a worktree
        // re-cut at this path skip its bootstrap for the rest of the session, which is the exact
        // property abandon exists to preserve.
        if (!pending.abandoned) bootstrapped.add(worktreePath);
        // Logged without the path — a worktree path is the kind of thing this repo's logs keep out.
        if (outcome.status === "installed") {
          console.info(`deps bootstrap: installed dependencies (${outcome.manager}) in a new worktree`);
        } else if (outcome.status === "failed") {
          console.warn(`deps bootstrap: install failed — ${outcome.detail ?? "no detail"}`);
        }
      } catch (e) {
        // Never surfaced as a spawn failure: the agent still opens, it just opens without
        // dependencies — the behavior that existed before this module. Deliberately NOT marked
        // bootstrapped, so reopening the agent retries.
        console.warn("deps bootstrap: could not install dependencies for the new worktree", e);
      }
    } finally {
      pending.running = false;
      if (inFlight.get(worktreePath) === pending) inFlight.delete(worktreePath);
      markSettled();
    }
  });

  // What makes "one bad bootstrap can't poison the queue" a property of the CODE rather than of the
  // body's own try/catch: a throw from console.* would otherwise reject `queue`, and every later
  // bootstrap chaining onto it would never run at all.
  queue = run.catch(() => {});
}

/** How long a teardown waits for a running install before proceeding anyway. The Rust side does not
 *  time the install out — killing a package manager mid-write leaves a half-built `node_modules`
 *  that is worse than none — so the bound has to live here, or closing an agent could hang. */
const TEARDOWN_WAIT_MS = 5_000;

/**
 * Tell the bootstrapper that this worktree is being removed.
 *
 * Bootstrapping escapes the per-root git lock by design (it is fire-and-forget), so without this a
 * `git worktree remove` can run while a package manager is mid-write.
 *
 * A queued-but-not-started bootstrap is dropped outright; a running one is waited on, bounded. The
 * path is also un-marked, so a worktree later re-cut at the same location bootstraps again.
 */
export function abandonWorktreeBootstrap(
  worktreePath: string,
  timeoutMs = TEARDOWN_WAIT_MS,
): Promise<void> {
  if (!worktreePath) return Promise.resolve();
  bootstrapped.delete(worktreePath);
  const pending = inFlight.get(worktreePath);
  if (!pending) return Promise.resolve();
  pending.abandoned = true;
  // One that has NOT started needs no waiting — and waiting would be actively harmful: this runs
  // inside the per-root git lock, so blocking on the installs AHEAD of it would stall unrelated
  // prepares and removes on the same project. Retire it now so a worktree re-cut at this path can
  // queue its own bootstrap instead of being turned away by a stale entry that will only no-op.
  if (!pending.running) {
    if (inFlight.get(worktreePath) === pending) inFlight.delete(worktreePath);
    return Promise.resolve();
  }
  return Promise.race([
    pending.settled,
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

/** Test seam: drop the session-global bookkeeping. Never called by app code. */
export function resetDepsBootstrapStateForTests(): void {
  bootstrapped.clear();
  inFlight.clear();
  queue = Promise.resolve();
}
