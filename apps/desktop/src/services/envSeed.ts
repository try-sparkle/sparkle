import { opSeedWorktree } from "./onepassword";
import { useSettingsStore } from "../stores/settingsStore";

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Seeding a fresh worktree with its project's `.env*` files.
//
// This is the payoff of the whole 1Password feature. `.env` and `.env.*` are gitignored, so a git
// worktree NEVER carries one — and Sparkle cuts a fresh worktree for every agent and every worker.
// The result today is that each new agent starts life missing the secrets its project needs;
// `naming.rs` even hardcodes a `$HOME/Projects/sparkle/.env.local` fallback to paper over it.
// Restoring the backed-up files into a new worktree fixes the cause rather than the symptom.
//
// Two properties matter more than speed here:
//
//   • NEVER BLOCK THE SPAWN. Opening an agent must not wait on a network round-trip to 1Password.
//     `op` can be slow, can sit behind a Touch ID prompt, or can hang; the Rust side bounds each
//     call at 20s, but even that is far too long to hold the UI. So seeding is fire-and-forget:
//     the caller gets its worktree immediately and the files land moments later.
//   • NEVER FAIL THE SPAWN. Every failure here is swallowed and logged. A missing vault, a locked
//     1Password, a revoked item — none of these are reasons to stop the user opening an agent.
//     The worst case is the status quo: a worktree with no `.env`, exactly as before this feature.
//
// Two properties the naive version got wrong, both about COST rather than correctness:
//
//   • ONCE PER WORKTREE, not once per open. `prepareAgentWorkspace` runs on every agent mount, not
//     only when a worktree is freshly cut (git worktree slots are reused), so an unguarded seed
//     fires an `op item list` — a 20s-bounded subprocess that can raise a Touch ID prompt — every
//     single time you open an agent, to discover there is nothing to do.
//   • ONE AT A TIME. `op` is a single-user CLI sitting behind one biometric prompt. A worker
//     fan-out cuts many worktrees at once, and N concurrent seeds would stack N prompts and N
//     concurrent CLI invocations on it. Seeds are queued so at most one is ever in flight; the
//     callers still never wait, they just get their files in sequence.
//
// KNOWN LIMITATION: the vault item titles are `<projectName>/<relPath>`, captured at BACKUP time,
// and a Sparkle project name is user-mutable. Renaming a project makes its existing backups
// unmatchable, and seeding then silently restores nothing (see sparkle bead in the progress doc).
// Also, because seeding is unawaited, a process the agent starts at t=0 can still race the files
// in — the `.env` lands moments later, not before the PTY.
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

/** Whether seeding is configured to run: the tool is on, the user asked for worktree seeding, and
 *  a vault has been chosen. All three are required — a missing vault is not an error to report at
 *  spawn time, it just means there is nowhere to read from yet. */
export function envSeedEnabled(): boolean {
  const s = useSettingsStore.getState();
  return s.onepasswordEnabled && s.onepasswordSeedWorktrees && !!s.onepasswordVaultId;
}

/** Restore this project's backed-up env files into a freshly created worktree.
 *
 *  Fire-and-forget by design — see the module comment. Returns immediately; the work is queued
 *  behind any other in-flight seed and never awaited by the spawn path.
 *
 *  `projectName` must be the same name the backup was written under, since the vault item titles
 *  are `<projectName>/<relPath>`. Passing a different name silently seeds nothing, which is why
 *  callers read it from the project store rather than deriving it from a path. */
export function seedWorktreeEnv(projectName: string, destRoot: string): void {
  if (!envSeedEnabled()) return;
  // No path, nothing to seed — and an empty key would collapse every worktree onto one entry.
  if (!destRoot) return;
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
      // Re-read rather than capture: the store can change between queueing and running, and a vault
      // that has since been cleared means there is nowhere to read from.
      const vaultId = useSettingsStore.getState().onepasswordVaultId;
      if (!vaultId) return;
      pending.running = true;
      try {
        // The RAW store name goes in: `opSeedWorktree` normalizes it the same way `backupTitle` did
        // when the items were written (a project named `acme/web` is stored as `acme-web/…`), so the
        // invariant lives at that boundary rather than at each call site.
        const written = await opSeedWorktree(vaultId, projectName, destRoot);
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
        // NOT marked seeded, so reopening the agent after unlocking 1Password retries.
        console.warn("env seed: could not restore env files into the new worktree", e);
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
