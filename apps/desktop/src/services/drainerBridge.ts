// THE BACKLOG-DRAINER DISPATCH BRIDGE — the app-side half that turns claimed, spooled beads into a
// BOUNDED PARALLEL FLEET of in-app drain workers, so a shipped DMG autonomously drains the
// agent-feedback backlog with as many workers as the machine can safely churn — the founder's ask.
//
// ── WHERE THE DETERMINISM LIVES (not here) ───────────────────────────────────────────────────────
// The deterministic BRAIN is the shell engine `scripts/backlog-drainer.sh`, run on a schedule by the
// LaunchAgent that `src-tauri/src/drainer.rs` installs while `[drainer] enabled` is true. Each pass it
// counts the backlog, rests at/below the floor, respects the worker cap, selects worst-first
// UNCLAIMED ready agent-feedback beads, CLAIMS them (the `draining` label + a claim file — dedupe-safe,
// claim-BEFORE-spawn), and spools a request file per bead. This bridge CONSUMES that queue; it adds no
// spawner and reimplements none of that arithmetic.
//
// ── FROM CONCURRENCY-1 TO A BOUNDED FLEET ────────────────────────────────────────────────────────
// This used to dispatch ONE bead per pass through the hourly improvement-pass SINGLETON, because the
// sparkle-self clone is not a projectStore Project (so spawnBuildAgentInProject can't target it) and
// the only headless spawn path was `runImprovementPass`, a global singleton sharing ONE worktree with
// the interactive Improve-Sparkle pane. That singleton was the concurrency-1 bottleneck.
//
// The fleet is now a SEPARATE bounded pool (services/drainSlotRunner): up to N workers, each in its
// OWN worktree keyed by a DISTINCT slot id, on its OWN rotated pool account, under its OWN per-slot
// latch and the multi-slot Rust manager's own slot. The hourly pass is untouched — distinct slots
// never contend. The fleet size N this pass may add is the STRICTEST of four bounds:
//   * the shell engine's worker cap (`max_workers`),
//   * `[drainer] max_concurrency` (already clamped to the Rust hard cap DRAIN_CONCURRENCY_HARD_CAP),
//   * the number of healthy pool accounts to rotate across (never pile N workers onto <N accounts),
//   * and the number of FREE slots (slots not already in flight),
// with the Rust `sparkle_improve_run` hard cap as a final defense-in-depth ceiling beneath all four.
//
// ── SAFETY (this is a sensitive autonomous-spawn feature) ───────────────────────────────────────
//  * KILL-SWITCH, fail-closed, at THREE layers: `[drainer] enabled=false` (or SPARKLE_DRAINER_ENABLED=0)
//    (a) uninstalls the LaunchAgent so nothing is spooled, (b) makes `read_drainer_queue` hand out no
//    entries, and (c) makes this bridge's `isEnabled()` return false. Any one off ⇒ zero spawns.
//  * CONSENT / OFFLINE hold: the fleet spends the founder's quota, so a `never` consent or a known-
//    offline machine holds the whole pass (no worker). (Pane-busy does NOT hold the fleet — drain
//    workers use their own worktrees, not the interactive pane's — which is exactly the added
//    parallelism the founder wants.)
//  * DEDUPE-SAFE (claim-before-spawn): each chosen bead is recorded in `claimedBeads` BEFORE dispatch
//    (closing the same-tick burst window), and each worker claims its own slot synchronously; a bead
//    is never dispatched twice and two workers never take the same bead or slot.
//  * SINGLE-OWNER: only the window that owns the sparkle-self namespace drains.
import { invoke } from "@tauri-apps/api/core";
import { log } from "../logger";
import { useSettingsStore } from "../stores/settingsStore";
import { useConnectionStore } from "../stores/connectionStore";
import { ownsProjectInThisWindow } from "./goalContinuationRunner";
import { availablePoolAccountCount } from "./accountSelection";
import { PASS_TIMEOUT_MS, type DrainFocus } from "./improvementPass";
import { SPARKLE_PROJECT_ID } from "./sparkleAgent";
import { busyDrainSlots } from "./drainSlotLatch";
import { drainSlotAgentId, runDrainSlot } from "./drainSlotRunner";

/** One spooled drain request, as `read_drainer_queue` returns it. */
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
  /** The shell engine's worker cap. */
  maxWorkers: number;
  /** The app-side parallel-fleet knob (`[drainer] max_concurrency`, already clamped to the Rust
   *  hard cap). One of the bounds on the fleet size. */
  maxConcurrency: number;
  entries: DrainQueueEntry[];
}

/** One planned assignment: which bead runs in which drain slot. */
export interface DrainAssignment {
  entry: DrainQueueEntry;
  /** The slot AGENT id (`__sparkle_self__-drain-<n>`) — distinct worktree + distinct account. */
  slot: string;
}

/** The seams the tick supplies in production and a test replaces. */
export interface DrainerBridgeDeps {
  /** The frontend kill-switch (settingsStore.drainerEnabled). Read per tick. */
  isEnabled: () => boolean;
  /** Read the spooled queue + kill-switch + caps from Rust. */
  readQueue: () => Promise<DrainerSnapshot>;
  /** The UNIVERSAL hold for the fleet (consent-off / offline), or null when it may run. Unlike the
   *  hourly gate this does NOT include pane-busy / already-running: drain workers use their own
   *  worktrees, so the interactive pane and the hourly pass never block them. */
  holdReason: () => string | null;
  /** The slot ids in flight right now (drainSlotLatch) — the FREE-slot bound. */
  busySlots: () => Set<string>;
  /** How many healthy pool accounts the fleet may rotate across — the account bound. */
  availableAccounts: () => Promise<number>;
  /** Beads dispatched this session and not yet finished — the dedup set. */
  claimed: Set<string>;
  /** Start ONE drain worker for a bead in a slot. Resolves to whether a worker actually RAN (so the
   *  caller acks the queue file only then). Never throws in production (logs + returns false). */
  dispatch: (entry: DrainQueueEntry, slot: string) => Promise<boolean>;
  /** Remove one spooled request after its worker ran, so it is never dispatched twice. */
  ack: (entry: DrainQueueEntry) => Promise<void>;
}

/**
 * The pure decision: which beads to dispatch into which slots this pass, worst-first, up to the
 * bounded fleet size. Returns [] when the kill-switch is off, the fleet is full, or nothing eligible
 * is queued. Side-effect-free and injection-free so every branch is unit- and mutation-testable.
 *
 * Fleet size = min(maxWorkers, maxConcurrency, availableAccounts); free capacity = that minus the
 * slots already in flight. Each chosen bead is UNCLAIMED and DISTINCT, and is assigned a DISTINCT
 * FREE slot, so two workers never share a bead or a slot.
 */
export function planDrainDispatch(args: {
  enabled: boolean;
  entries: DrainQueueEntry[];
  claimed: Set<string>;
  busySlots: Set<string>;
  maxWorkers: number;
  maxConcurrency: number;
  availableAccounts: number;
}): DrainAssignment[] {
  if (!args.enabled) return []; // kill-switch — no spawn, ever
  const cap = Math.max(
    0,
    Math.min(args.maxWorkers, args.maxConcurrency, args.availableAccounts),
  );
  if (cap <= 0) return [];
  // The fleet's slots are drain-0..drain-(cap-1); a slot already in flight is not free. This bounds
  // the pass to `cap` total workers AND to the free capacity within it.
  const freeSlots: string[] = [];
  for (let i = 0; i < cap; i++) {
    const slot = drainSlotAgentId(i);
    if (!args.busySlots.has(slot)) freeSlots.push(slot);
  }
  if (freeSlots.length === 0) return [];
  const out: DrainAssignment[] = [];
  const takenThisPass = new Set<string>(); // guards a duplicate bead within one snapshot
  for (const e of args.entries) {
    if (out.length >= freeSlots.length) break; // fleet full
    if (!e.beadId) continue;
    if (args.claimed.has(e.beadId)) continue; // never double-dispatch a bead across passes
    if (takenThisPass.has(e.beadId)) continue; // …or twice within this pass
    const slot = freeSlots[out.length];
    if (slot === undefined) break; // exhausted the free slots (redundant with the length guard)
    takenThisPass.add(e.beadId);
    out.push({ entry: e, slot });
  }
  return out;
}

/**
 * One dispatch pass: read the queue, plan the bounded fleet, and kick off a worker per assignment.
 * NON-BLOCKING: it records each claim, starts each worker (which claims its slot synchronously), and
 * returns the beads it kicked off WITHOUT awaiting the workers — so the next tick tops the fleet back
 * up as slots free, rather than idling finished slots until a whole batch completes. The ack (and the
 * claim release on a bail) happen when each worker settles. Fail-closed at every gate.
 */
export async function runDrainerBridgePass(
  deps: DrainerBridgeDeps,
): Promise<{ dispatched: string[] }> {
  if (!deps.isEnabled()) return { dispatched: [] }; // frontend kill-switch (fail-closed)

  let snap: DrainerSnapshot;
  try {
    snap = await deps.readQueue();
  } catch (e) {
    log.warn("drainer-bridge", "read_drainer_queue failed; no dispatch this pass", { error: String(e) });
    return { dispatched: [] }; // fail-closed: a blind read never dispatches
  }
  if (!snap.enabled) return { dispatched: [] }; // Rust kill-switch (fail-closed)

  const hold = deps.holdReason();
  if (hold !== null) return { dispatched: [] }; // consent-off / offline

  const availableAccounts = await deps.availableAccounts();
  const plan = planDrainDispatch({
    enabled: true,
    entries: snap.entries,
    claimed: deps.claimed,
    busySlots: deps.busySlots(),
    maxWorkers: snap.maxWorkers,
    maxConcurrency: snap.maxConcurrency,
    availableAccounts,
  });
  if (plan.length === 0) return { dispatched: [] };

  for (const a of plan) {
    // Record the claim BEFORE the dispatch — closes the same-tick / burst window a store-only check
    // misses, so a second reader (this or the next tick) cannot also select this bead.
    deps.claimed.add(a.entry.beadId);
    // Kick off the worker. `dispatch` claims the slot synchronously (before its first await), so by
    // the next tick `busySlots()` already reflects it. We do NOT await the worker — the pass returns
    // once the fleet is kicked off, and the ack / release rides the worker's own settlement.
    void (async () => {
      let ran = false;
      try {
        ran = await deps.dispatch(a.entry, a.slot);
      } catch (e) {
        log.warn("drainer-bridge", "dispatch threw; releasing claim", { bead: a.entry.beadId, error: String(e) });
        deps.claimed.delete(a.entry.beadId);
        return;
      }
      if (!ran) {
        // The worker bailed (consent, park refused, no claude, timeout). Leave the queue file so a
        // later pass retries, and release the session claim.
        deps.claimed.delete(a.entry.beadId);
        return;
      }
      try {
        await deps.ack(a.entry);
      } catch (e) {
        log.warn("drainer-bridge", "ack failed after dispatch (harmless; dedup still holds)", { bead: a.entry.beadId, error: String(e) });
      }
    })();
  }
  const dispatched = plan.map((a) => a.entry.beadId);
  log.info("drainer-bridge", "dispatched drain workers", { beads: dispatched, slots: plan.map((a) => a.slot) });
  return { dispatched };
}

// ── production wiring ─────────────────────────────────────────────────────────────────────────────

/** Beads dispatched this session, released when their worker bails. Module scope so it survives
 *  across ticks (the whole point of the dedup) and resets with the page. */
const claimedBeads = new Set<string>();

/** Start ONE drain worker via the sanctioned per-slot runner. Returns true only when a worker
 *  actually RAN, so the caller acks the request only on a real run. */
async function productionDispatch(entry: DrainQueueEntry, slot: string): Promise<boolean> {
  const consent = useSettingsStore.getState().sparkleImprovementConsent;
  const focus: DrainFocus = { beadId: entry.beadId, title: entry.title, task: entry.task, goal: entry.goal };
  return await runDrainSlot(slot, focus, consent);
}

/** The universal fleet hold: consent-off or known-offline. NOT pane-busy / already-running — drain
 *  workers run in their own worktrees, so the interactive pane and the hourly pass never block them. */
function productionHoldReason(): string | null {
  if (useSettingsStore.getState().sparkleImprovementConsent === "never") return "consent-off";
  if (useConnectionStore.getState().isOnline === false) return "offline";
  return null;
}

const PRODUCTION_DEPS: DrainerBridgeDeps = {
  isEnabled: () => useSettingsStore.getState().drainerEnabled,
  readQueue: () => invoke<DrainerSnapshot>("read_drainer_queue"),
  holdReason: productionHoldReason,
  busySlots: () => new Set(busyDrainSlots()),
  availableAccounts: () => availablePoolAccountCount(),
  claimed: claimedBeads,
  dispatch: productionDispatch,
  ack: async (entry: DrainQueueEntry) => {
    if (entry._queueFile) await invoke("ack_drainer_queue_file", { queueFile: entry._queueFile });
  },
};

/** How often to check the spooled queue and top the fleet back up. */
export const DRAINER_BRIDGE_SWEEP_MS = 60_000;

let timer: ReturnType<typeof setInterval> | null = null;
let sweepStartedAt: number | null = null;
let sweepGeneration = 0;
/** The pass is non-blocking (it does not await the workers), so a sweep is short; this generous
 *  ceiling only guards against a wedged read/plan, well above any normal pass. */
const DRAINER_SWEEP_ABANDON_MS = PASS_TIMEOUT_MS + 5 * 60_000;

/**
 * Start the dispatch bridge. Returns a stop function; safe to call twice (the second is a no-op).
 * Single-flight per tick and single-owner. The kill-switch / consent / caps are all re-read per pass.
 */
export function startDrainerBridge(deps: DrainerBridgeDeps = PRODUCTION_DEPS): () => void {
  const tick = async (): Promise<void> => {
    if (!ownsProjectInThisWindow(SPARKLE_PROJECT_ID)) return;
    const startedAt = Date.now();
    if (sweepStartedAt !== null) {
      if (startedAt - sweepStartedAt < DRAINER_SWEEP_ABANDON_MS) return; // one at a time
      log.warn("drainer-bridge", "abandoning a wedged sweep and starting fresh", { ageMs: startedAt - sweepStartedAt });
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
