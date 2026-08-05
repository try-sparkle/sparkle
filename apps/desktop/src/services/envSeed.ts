import { envSeedFromCheckout } from "./onepassword";
import { useSettingsStore } from "../stores/settingsStore";

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Seeding a fresh worktree with its project's `.env*` files.
//
// `.env` and `.env.*` are gitignored, so a git worktree NEVER carries one — and Sparkle cuts a
// fresh worktree for every agent and every worker. Without seeding, each new agent starts life
// missing the secrets its project needs; `naming.rs` even hardcodes a
// `$HOME/Projects/sparkle/.env.local` fallback to paper over it.
//
// THE SOURCE IS THE PROJECT CHECKOUT, NOT THE VAULT — and that is the whole point (bead
// sparkle-y5xc9).
//
// This used to call `op_seed_worktree`, downloading each file from 1Password on the spawn path. It
// worked, and it was unusable at fleet scale. 1Password's app-integration authorization is granted
// to the CALLING PROCESS — Sparkle itself, never the agent's terminal, which invokes `op` nowhere —
// and it expires after ten minutes of inactivity. Sparkle's `op` calls are sporadic by
// construction: one burst per agent spawn, then silence. Sporadic is exactly the shape that
// re-prompts, so a founder opening fifteen agents across an afternoon re-authorized roughly once
// per agent. Reducing the NUMBER of calls could never fix that; only making zero calls could.
//
// A worktree's `.env.local` was always a copy of the one already sitting in the project checkout,
// so the vault was never the nearest source — just the one that got built first. Copying locally
// makes this path incapable of prompting because it makes no call at all, and it is strictly
// fresher: it picks up edits made since the last backup. The vault keeps its real job, which is
// moving files BETWEEN machines: back up here, "Restore all" there.
//
// Two properties matter more than speed here:
//
//   • NEVER BLOCK THE SPAWN. Seeding is fire-and-forget: the caller gets its worktree immediately
//     and the files land moments later. A local copy is fast, but "fast" is not "bounded", and a
//     slow disk must not hold the UI.
//   • NEVER FAIL THE SPAWN. Every failure here is swallowed and logged. The worst case is the
//     status quo: a worktree with no `.env`, exactly as before this feature.
//
// Two properties the naive version got wrong, both about COST rather than correctness:
//
//   • ONCE PER WORKTREE, not once per open. `prepareAgentWorkspace` runs on every agent mount, not
//     only when a worktree is freshly cut (git worktree slots are reused), so an unguarded seed
//     re-walks the project tree every single time you open an agent to discover there is nothing
//     to do.
//   • ONE AT A TIME. Inherited from the `op` era, and kept: a worker fan-out cuts many worktrees at
//     once, and N concurrent tree walks over the same project buy nothing. The callers still never
//     wait, they just get their files in sequence.
//
// KNOWN LIMITATION: because seeding is unawaited, a process the agent starts at t=0 can still race
// the files in — the `.env` lands moments later, not before the PTY.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Worktree paths whose seed has SUCCEEDED this session — the "once per worktree, not once per
 *  open" guard. Success, not attempt: a failed seed (locked vault, unanswered Touch ID prompt, a
 *  timeout) must be retried the next time the agent is opened, which is the user's whole recovery
 *  path — unlock 1Password, reopen the agent. Marking on attempt poisoned the path until restart. */
const seeded = new Set<string>();

/** A seed that has been queued and not yet settled. `running` distinguishes "still waiting its turn"
 *  (skippable instantly) from "op is writing right now" (a teardown has to wait for it). */
interface PendingSeed {
  /** Resolves when THIS seed finishes or is skipped — never chained to the seeds ahead of it, so a
   *  teardown doesn't wait out the whole queue. */
  settled: Promise<void>;
  running: boolean;
  /** The worktree was torn down after this seed was queued. Recorded on the SEED, not in a
   *  path-keyed set: a later seed for the same path is a different object, and a shared key would
   *  let the new one un-abandon the stale one (which would then write into the fresh worktree). */
  abandoned: boolean;
}
const inFlight = new Map<string, PendingSeed>();

/** The serialization point: every seed chains onto this, so at most one `op` runs at a time. */
let queue: Promise<void> = Promise.resolve();

/** Whether seeding is configured to run: the tool is on and the user asked for worktree seeding.
 *
 *  NO VAULT REQUIREMENT — deliberately. Seeding copies from the project checkout now, so a vault is
 *  irrelevant to it; requiring one would refuse to copy a file sitting right there on disk because
 *  of an unrelated setting. */
export function envSeedEnabled(): boolean {
  const s = useSettingsStore.getState();
  return s.onepasswordEnabled && s.onepasswordSeedWorktrees;
}

/** Copy this project's `.env*` files into a freshly created worktree.
 *
 *  Fire-and-forget by design — see the module comment. Returns immediately; the work is queued
 *  behind any other in-flight seed and never awaited by the spawn path.
 *
 *  `sourceRoot` is the project's own checkout — the directory the files are copied FROM. Callers
 *  read it from the project store rather than deriving it from the worktree path, which points at
 *  app data and holds none of the originals. */
export function seedWorktreeEnv(sourceRoot: string, destRoot: string): void {
  if (!envSeedEnabled()) return;
  // No path, nothing to seed — and an empty key would collapse every worktree onto one entry.
  if (!destRoot) return;
  // Nothing to copy FROM. Distinct from the checks above: this is a project with no root on disk,
  // not a disabled feature.
  if (!sourceRoot) return;
  // Already seeded successfully this session: the files are there, and re-running only buys another
  // `op` invocation and another biometric prompt.
  if (seeded.has(destRoot)) return;
  // Already queued for this path — don't stack a second one behind it. (An ABANDONED entry is
  // retired by abandonWorktreeSeed rather than left here, so a worktree re-cut at this path can
  // still queue a fresh seed.)
  if (inFlight.has(destRoot)) return;

  let markSettled!: () => void;
  const pending: PendingSeed = {
    settled: new Promise<void>((resolve) => {
      markSettled = resolve;
    }),
    running: false,
    abandoned: false,
  };
  inFlight.set(destRoot, pending);

  const run = queue.then(async () => {
    try {
      // The worktree may have been torn down while this seed waited its turn — writing into it now
      // would recreate the directory git just deleted.
      if (pending.abandoned) return;
      // Re-read rather than capture: the user can switch seeding off between queueing and running,
      // and a seed that was queued under the old setting must not still fire.
      if (!envSeedEnabled()) return;
      pending.running = true;
      try {
        const written = await envSeedFromCheckout(sourceRoot, destRoot);
        // Only a completed seed marks the path done; a failure below stays retryable. And NOT when
        // the worktree was torn down mid-write: marking then would make a worktree re-cut at this
        // path skip seeding for the rest of the session — the exact property abandon exists for.
        if (!pending.abandoned) seeded.add(destRoot);
        // Log a COUNT, never the paths — an env file's absolute path is exactly the kind of thing
        // the repo's privacy precedent keeps out of log lines.
        if (written.length > 0) {
          console.info(`env seed: restored ${written.length} file(s) into a new worktree`);
        }
      } catch (e) {
        // Never surfaced as a spawn failure. The agent still opens; it just opens without secrets,
        // which is precisely the behavior that existed before this feature. The path is deliberately
        // NOT marked seeded, so reopening the agent retries — the user's recovery path for a
        // transient failure (a project root that was temporarily unreadable, a full disk).
        console.warn("env seed: could not copy env files into the new worktree", e);
      }
    } finally {
      pending.running = false;
      if (inFlight.get(destRoot) === pending) inFlight.delete(destRoot);
      markSettled();
    }
  });

  // The `.catch` is what makes "one bad seed can't poison the queue" true of the CODE and not just
  // of the body's own try/catch: a throw from the store read or from console.* would otherwise
  // reject `queue`, and every later seed chaining onto it would never run.
  queue = run.catch(() => {});
}

/** How long a teardown will wait for an in-flight seed before proceeding anyway. Long enough to
 *  cover the common case (a fast `op`), short enough that closing an agent never feels stuck — a
 *  seed still running past this has already had its destination marked abandoned. */
const TEARDOWN_WAIT_MS = 5_000;

/** Tell the seeder that this worktree is being removed.
 *
 *  Seeding escapes the per-root git lock by design (it is fire-and-forget), so without this a
 *  `git worktree remove` can run while `op` is mid-write: the backend recreates parent directories
 *  per file, leaving a stray non-empty directory at a slot path a later `git worktree add` reuse
 *  then fails on — and a plaintext `.env` outside any tracked worktree.
 *
 *  A queued-but-not-started seed is skipped outright; an already-running one is waited on, bounded,
 *  so teardown can never hang on a stuck `op`. The path is also un-marked as seeded, so a worktree
 *  later re-cut at the same location seeds again. */
export function abandonWorktreeSeed(destRoot: string, timeoutMs = TEARDOWN_WAIT_MS): Promise<void> {
  if (!destRoot) return Promise.resolve();
  seeded.delete(destRoot);
  const pending = inFlight.get(destRoot);
  if (!pending) return Promise.resolve();
  pending.abandoned = true;
  // A seed that has NOT started yet is skipped at its turn and needs no waiting — and waiting would
  // be actively harmful: this runs inside the per-root git lock, so blocking here on the seeds
  // AHEAD of it in the queue would stall unrelated prepares/removes on the same project. Retire it
  // from the in-flight map right away, too, so a worktree re-cut at this path can queue its own
  // seed instead of being turned away by a stale entry that is only going to no-op.
  if (!pending.running) {
    if (inFlight.get(destRoot) === pending) inFlight.delete(destRoot);
    return Promise.resolve();
  }
  return Promise.race([
    pending.settled,
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

/** Test seam: drop the session-global seed bookkeeping. Never called by app code. */
export function resetEnvSeedStateForTests(): void {
  seeded.clear();
  inFlight.clear();
  queue = Promise.resolve();
}
