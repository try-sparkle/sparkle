// THE BACKLOG-DRAINER DISPATCH BRIDGE — the app-side half that turns a claimed, spooled bead into a
// real in-app worker run, so a shipped DMG autonomously drains the agent-feedback backlog 24/7.
//
// ── WHERE THE DETERMINISM LIVES (not here) ───────────────────────────────────────────────────────
// The deterministic BRAIN is the shell engine `scripts/backlog-drainer.sh`, run on a schedule by the
// LaunchAgent that `src-tauri/src/drainer.rs` installs while `[drainer] enabled` is true. Each pass it
// counts the backlog, rests at/below the floor, respects the worker cap, selects the worst-first
// UNCLAIMED ready agent-feedback bead, CLAIMS it (the `draining` label + a claim file — dedupe-safe,
// claim-BEFORE-spawn), and spools a request file `<git-common-dir>/sparkle-drainer/queue/<beadId>.json`.
// There is no shell/CLI path to launch a Claude worker, so this bridge is the only place the spawn can
// live. It adds NO new spawner and reimplements none of that arithmetic — it consumes the queue.
//
// ── WHY IT REUSES THE IMPROVEMENT-PASS SINGLETON, NOT spawnBuildAgentInProject ──────────────────
// The backlog is about SPARKLE ITSELF, so the work happens in the app-owned sparkle-self clone. That
// clone is deliberately NOT a projectStore Project (see services/sparkleAgent.ts), so
// spawnBuildAgentInProject / spawnWorker cannot target it — both are gated on a registered Project.
// The only sanctioned way to run a headless agent in that clone is the improvement-pass machinery
// (`runImprovementPass` → the `sparkle_improve_run` command), which is a GLOBAL SINGLETON (one pass at
// a time, sharing the one worktree with the interactive Improve-Sparkle pane). So this bridge dispatches
// ONE bead-focused improvement pass at a time via `runImprovementPass(consent, false, focusBead)` — the
// existing spawn path, given a drain brief for the claimed bead. Effective in-app concurrency is 1 (the
// singleton), which is more conservative than the shell's worker cap and is the correct bound until the
// clone supports multiple concurrent headless worktrees.
//
// ── SAFETY (this is a sensitive autonomous-spawn feature) ───────────────────────────────────────
//  * KILL-SWITCH, fail-closed, at THREE layers: `[drainer] enabled=false` (or SPARKLE_DRAINER_ENABLED=0)
//    (a) uninstalls the LaunchAgent so nothing is spooled, (b) makes `read_drainer_queue` hand out no
//    entries, and (c) makes this bridge's `isEnabled()` (settingsStore.drainerEnabled) return false. Any
//    one of the three off ⇒ no spawn.
//  * CONSENT: the underlying machinery spends the founder's quota on the sparkle-self clone, so it also
//    requires the Sparkle self-improvement consent to not be "never" — the same authorization the hourly
//    pass uses. `never` ⇒ no spawn, whatever `[drainer] enabled` says.
//  * BOUNDED: never exceeds min(worker cap, the singleton) concurrent passes.
//  * DEDUPE-SAFE (claim-before-spawn): the shell claims the bead before spooling; this bridge records the
//    bead in `claimedBeads` BEFORE dispatch (closing the same-tick burst window) and `ack`s (deletes) the
//    queue file on start, so the same bead is never dispatched twice — even across app restarts (a
//    still-`draining` bead is not re-spooled).
//  * SINGLE-OWNER: only the window that owns the sparkle-self namespace drains, so N windows don't each
//    consume the queue.
import { invoke } from "@tauri-apps/api/core";
import { log } from "../logger";
import { useSettingsStore } from "../stores/settingsStore";
import { ownsProjectInThisWindow } from "./goalContinuationRunner";
import { isPassRunning } from "./improvementPassLatch";
import { passHoldReason, runImprovementPass, PASS_TIMEOUT_MS } from "./improvementPass";
import { readPassGate } from "./improveDutySnapshot";
import { SPARKLE_PROJECT_ID } from "./sparkleAgent";

/** One spooled drain request, as `read_drainer_queue` returns it (shape written by the shell engine's
 *  `dispatch_bead`, plus the `_queueFile` the Rust reader adds). */
export interface DrainQueueEntry {
  beadId: string;
  title?: string;
  priority?: string;
  task?: string;
  goal?: string;
  /** Absolute path of the queue file, for `ack`. */
  _queueFile?: string;
}

/** What `read_drainer_queue` hands the bridge for one pass. `enabled=false` ⇒ `entries` is empty. */
export interface DrainerSnapshot {
  enabled: boolean;
  maxWorkers: number;
  entries: DrainQueueEntry[];
}

/** The seams the tick supplies in production and a test replaces (same injection style as
 *  babysitDispatcher's `BabysitSweepDeps`). */
export interface DrainerBridgeDeps {
  /** The frontend kill-switch (settingsStore.drainerEnabled). Read per tick so a Settings toggle
   *  takes effect without a restart. */
  isEnabled: () => boolean;
  /** Read the spooled queue + kill-switch + cap from Rust. */
  readQueue: () => Promise<DrainerSnapshot>;
  /** The SHARED headless-pass hold reason (consent-off / already-running / pane-busy / offline /
   *  clock-unseeded), or null when a pass may run. Reuses the same gate the hourly pass uses so the
   *  drain honours every hold — most importantly pane-busy: the interactive Improve-Sparkle pane and
   *  the drain pass share ONE worktree, and dispatching while the pane is live would stash its work. */
  holdReason: () => string | null;
  /** Live in-app drain passes right now (0 or 1 — the sparkle-self singleton). */
  running: () => number;
  /** Beads dispatched this session and not yet finished — the dedup set (mutated by the pass). */
  claimed: Set<string>;
  /** Start a drain worker for one bead. Returns true iff a pass actually STARTED (so the caller acks
   *  the queue file only then). Never throws in production (logs + returns false). */
  dispatch: (entry: DrainQueueEntry) => Promise<boolean>;
  /** Remove one spooled request after its worker ran, so it is never dispatched twice. Takes the
   *  entry so production can ack by the exact `_queueFile` path the reader returned. */
  ack: (entry: DrainQueueEntry) => Promise<void>;
}

/** In-app concurrency ceiling: the sparkle-self clone admits ONE headless agent at a time (the
 *  improvement-pass singleton). The effective cap is min(this, the shell's worker cap). Raise only
 *  when the clone can host multiple concurrent headless worktrees. */
export const MAX_INFLIGHT_DRAIN_PASSES = 1;

/**
 * The pure decision: which single bead (if any) to dispatch next, worst-first. Returns null when the
 * kill-switch is off, when the effective cap is already full, or when nothing un-claimed is queued.
 * Deliberately side-effect-free and injection-free so every branch is unit- and mutation-testable.
 */
export function selectDrainDispatch(args: {
  enabled: boolean;
  entries: DrainQueueEntry[];
  running: number;
  claimed: Set<string>;
  maxWorkers: number;
}): DrainQueueEntry | null {
  if (!args.enabled) return null; // kill-switch — no spawn, ever
  const cap = Math.max(0, Math.min(args.maxWorkers, MAX_INFLIGHT_DRAIN_PASSES));
  if (args.running >= cap) return null; // cap / singleton respected — Nth+1 is not dispatched
  for (const e of args.entries) {
    if (!e.beadId) continue;
    if (args.claimed.has(e.beadId)) continue; // dedup — never double-dispatch a bead
    return e; // entries arrive worst-first from Rust; the first eligible one wins
  }
  return null;
}

/**
 * One dispatch pass: read the queue, pick the worst-first eligible bead, and start a worker for it.
 * At most one bead per pass (the singleton). Fail-closed at every gate. Returns the bead dispatched,
 * or null.
 */
export async function runDrainerBridgePass(
  deps: DrainerBridgeDeps,
): Promise<{ dispatched: string | null }> {
  if (!deps.isEnabled()) return { dispatched: null }; // frontend kill-switch (fail-closed)

  let snap: DrainerSnapshot;
  try {
    snap = await deps.readQueue();
  } catch (e) {
    log.warn("drainer-bridge", "read_drainer_queue failed; no dispatch this pass", {
      error: String(e),
    });
    return { dispatched: null }; // fail-closed: a blind read never dispatches
  }
  if (!snap.enabled) return { dispatched: null }; // Rust kill-switch (fail-closed)

  // Honour the shared headless-pass holds (pane-busy, offline, consent-off, singleton) BEFORE picking
  // a bead — dispatching through any of them would collide with the interactive pane on the shared
  // worktree or spend a pass into a dead network (roborev 68224).
  const hold = deps.holdReason();
  if (hold !== null) return { dispatched: null };

  const pick = selectDrainDispatch({
    enabled: true,
    entries: snap.entries,
    running: deps.running(),
    claimed: deps.claimed,
    maxWorkers: snap.maxWorkers,
  });
  if (!pick) return { dispatched: null };

  // Record the claim BEFORE the dispatch — this closes the same-tick / burst window a store-only
  // check misses, so a second reader cannot also select this bead.
  deps.claimed.add(pick.beadId);
  let started = false;
  try {
    started = await deps.dispatch(pick);
  } catch (e) {
    deps.claimed.delete(pick.beadId);
    log.warn("drainer-bridge", "dispatch threw; releasing claim", {
      bead: pick.beadId,
      error: String(e),
    });
    return { dispatched: null };
  }
  if (!started) {
    // The singleton was busy or the machinery refused (e.g. consent). Leave the queue file so a
    // later pass retries, and release the session claim.
    deps.claimed.delete(pick.beadId);
    return { dispatched: null };
  }
  // A worker ran — remove the request so it is never dispatched again. Best-effort: the
  // `claimedBeads` session dedup and the shell's `draining` label both still hold if the ack fails.
  try {
    await deps.ack(pick);
  } catch (e) {
    log.warn("drainer-bridge", "ack failed after dispatch (harmless; dedup still holds)", {
      bead: pick.beadId,
      error: String(e),
    });
  }
  log.info("drainer-bridge", "dispatched a drain worker", { bead: pick.beadId });
  return { dispatched: pick.beadId };
}

// ── production wiring ─────────────────────────────────────────────────────────────────────────────

/** Beads dispatched this session, pruned when their pass finishes. Module scope so it survives across
 *  ticks (the whole point of the dedup) and resets with the page. */
const claimedBeads = new Set<string>();

/** Start a bead-focused improvement pass — the sanctioned spawn path for the sparkle-self clone.
 *  Returns true only when a worker actually RAN, so the caller acks the request only on a real run. */
async function productionDispatch(entry: DrainQueueEntry): Promise<boolean> {
  // The shared hold gate is checked by runDrainerBridgePass (via `holdReason`) immediately before this
  // call; runImprovementPass re-checks consent + the latch itself. Read consent for its argument.
  const consent = useSettingsStore.getState().sparkleImprovementConsent;
  // AWAIT the pass. `runImprovementPass` returns true ONLY when a worker actually ran (past consent,
  // the latch, claude-installed and the worktree park) — false on every bail. Inferring "started"
  // from the latch was unsound: the latch is claimed synchronously but several bails happen AFTER an
  // await while still holding it, so a bailed pass looked started and its request was acked and lost
  // (roborev 68223). Awaiting is safe: the bridge is single-flight and the clone is single-worker.
  // `focusBead` marks this a drain, so it uses the drain brief and does not touch the hourly retry latch.
  return await runImprovementPass(consent, false, {
    beadId: entry.beadId,
    title: entry.title,
    task: entry.task,
    goal: entry.goal,
  });
}

const PRODUCTION_DEPS: DrainerBridgeDeps = {
  isEnabled: () => useSettingsStore.getState().drainerEnabled,
  readQueue: () => invoke<DrainerSnapshot>("read_drainer_queue"),
  holdReason: () => passHoldReason(readPassGate(Date.now())),
  running: () => (isPassRunning() ? 1 : 0),
  claimed: claimedBeads,
  dispatch: productionDispatch,
  ack: async (entry: DrainQueueEntry) => {
    // Ack by the exact path the reader returned, so a file whose name differs from its content beadId
    // is still removed (and never re-dispatched). A missing path is a no-op — nothing to remove.
    if (entry._queueFile) await invoke("ack_drainer_queue_file", { queueFile: entry._queueFile });
  },
};

/** How often to check the spooled queue. The shell watchdog spools every ~300s; the app can consume
 *  faster so a claimed bead does not sit idle. */
export const DRAINER_BRIDGE_SWEEP_MS = 60_000;

let timer: ReturnType<typeof setInterval> | null = null;
let sweepStartedAt: number | null = null;
let sweepGeneration = 0;
/** A dispatch AWAITS the full drain pass (up to PASS_TIMEOUT_MS), so a sweep legitimately runs that
 *  long; only past this — comfortably above the pass budget — is a sweep treated as wedged and a
 *  fresh one started, so a normal long pass never logs a false abandon. */
const DRAINER_SWEEP_ABANDON_MS = PASS_TIMEOUT_MS + 5 * 60_000;

/**
 * Start the dispatch bridge. Returns a stop function; safe to call twice (the second is a no-op).
 * Single-flight (one pass at a time) and single-owner (only the window that owns the sparkle-self
 * namespace drains). The `[drainer] enabled` / consent / cap gates are all re-read per pass through
 * `deps`, so a Settings toggle takes effect on the next tick without a restart.
 */
export function startDrainerBridge(deps: DrainerBridgeDeps = PRODUCTION_DEPS): () => void {
  const tick = async (): Promise<void> => {
    // Only the owning window drains, so N windows don't each consume the queue.
    if (!ownsProjectInThisWindow(SPARKLE_PROJECT_ID)) return;
    const startedAt = Date.now();
    if (sweepStartedAt !== null) {
      if (startedAt - sweepStartedAt < DRAINER_SWEEP_ABANDON_MS) return; // one at a time
      log.warn("drainer-bridge", "abandoning a wedged sweep and starting fresh", {
        ageMs: startedAt - sweepStartedAt,
      });
    }
    sweepStartedAt = startedAt;
    const myGeneration = ++sweepGeneration;
    try {
      if (myGeneration !== sweepGeneration) return;
      await runDrainerBridgePass(deps);
    } catch (e) {
      log.warn("drainer-bridge", "dispatch pass threw", { error: String(e) });
    } finally {
      if (sweepStartedAt === startedAt) sweepStartedAt = null;
    }
  };
  if (timer !== null) return () => {};
  void tick();
  timer = setInterval(() => void tick(), DRAINER_BRIDGE_SWEEP_MS);
  return () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
    sweepGeneration += 1; // fence out any in-flight sweep
  };
}
