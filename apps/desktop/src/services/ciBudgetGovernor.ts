// The FLEET's global CI-concurrency budget with release priority — the systemic version of the
// manual "pause the fleet" (PRD/sparkle/ci-throughput-refactor.md, workstream D).
//
// THE PROBLEM. ~40 build agents each SHIP their branch (push + open a PR), and every PR fans out a
// full CI matrix onto ONE shared, hard-capped self-hosted runner pool (`linux-ci`, 8 VMs globally).
// With no coordination they collectively saturate it and starve everything downstream — most
// visibly the release DMG, whose base-CI run then can't get a runner and whose gate times out,
// discarding a built, notarized binary. Tonight's mitigation was a human pausing the fleet by hand.
//
// THE GOVERNOR. This caps how many ships may have CI-triggering work presumed IN FLIGHT at once
// (`[fleet].ci_budget`). A ship past the cap does not push — it QUEUES, and drains as slots free.
// While a release DMG is building, the fleet's ships pause ENTIRELY so the release's base CI gets
// the pool. It is deliberately dependency-free (no store/tauri/React imports) so its admission logic
// is unit-tested by driving the REAL object, and so importing it costs a shipping caller nothing;
// the production signal + config are injected by `ciBudgetGovernorInit.ts` at startup.
//
// SEAM. It wraps `closeAgentActions.shipAgent`'s push+PR — the one app-orchestration chokepoint both
// the human close-agent Ship and the concierge `ship_agent` tool funnel through.

/** A three-valued signal. `null` = UNKNOWN/unreadable — the fail-safe case, distinct from `false`. */
export type TriBool = boolean | null;

/** The CI-load input the governor reacts to, fail-safe on `null` (see {@link admitCiWork}). */
export interface CiLoad {
  /** `true` = a release DMG is building right now (`sparkle-release` runner busy), so the fleet
   *  pauses to leave the pool for its base CI; `false` = not; `null` = the signal was unreadable. */
  releaseInProgress: TriBool;
}

export type Admission = "grant" | "hold";

/** The load a probe reports when it cannot read anything — UNKNOWN, so the decision falls back to
 *  the pure numeric budget cap (never a flood, never a freeze). */
export const UNKNOWN_LOAD: CiLoad = { releaseInProgress: null };

/**
 * PURE admission decision: given the in-flight count, the budget, and the load, may a new
 * CI-triggering ship proceed *right now*? The rule ORDER is load-bearing and each rule is
 * independently mutation-checked — deleting either lets work through that should have been held.
 *
 * DELIBERATELY only two holds — budget + release-priority — and NO pool-saturation backpressure.
 * A "hold while the linux-ci pool is fully busy" rule is self-defeating: the pool autoscales on
 * QUEUE DEPTH (`scripts/lib/ci-autoscale.sh`, `unserved = queued - idle`), so withholding pushes
 * exactly when `idle == 0` suppresses the demand signal that triggers a scale-out — the fleet stops
 * pushing, the queue stays flat, and the pool never grows. It also fires in the common case (all
 * busy is the steady state this feature exists for), which would freeze even the FIRST ship. The
 * numeric budget is the backpressure; letting a bounded number of jobs queue is what the autoscaler
 * consumes. (Removed after roborev 65809/65810.)
 *
 * Fail-safe: an UNKNOWN release signal (`null`) never HOLDS on rule 1 — a transient `gh` hiccup must
 * not freeze the fleet — but rule 2, the numeric budget, is enforced UNCONDITIONALLY, so an unknown
 * signal degrades to a pure count cap: never a flood, never a freeze.
 */
export function admitCiWork(state: { inFlight: number; budget: number; load: CiLoad }): Admission {
  const { inFlight, budget, load } = state;
  // Rule 0 — DISABLED. `ci_budget = 0` opts the governor out entirely: every ship pushes at once.
  if (budget <= 0) return "grant";
  // Rule 1 — RELEASE PRIORITY. A release is building → pause the fleet so its base CI gets runners.
  if (load.releaseInProgress === true) return "hold";
  // Rule 2 — BUDGET CAP. The conservative floor, enforced even when the load signal is unknown.
  if (inFlight >= budget) return "hold";
  return "grant";
}

/** Cancels a scheduled callback. */
type Cancel = () => void;
/** Schedule `cb` after `ms`; returns a canceller. Injected so lease expiry is deterministic in tests. */
export type Scheduler = (ms: number, cb: () => void) => Cancel;

const realScheduler: Scheduler = (ms, cb) => {
  const t = setTimeout(cb, ms);
  return () => clearTimeout(t);
};

interface Waiter {
  resolve: () => void;
}

export interface GovernorOptions {
  /** Max in-flight CI-triggering ships. `0` disables the governor (pass-through). */
  budget: number;
  /** How long an occupied slot is held after its ship pushes — the presumed-CI-in-flight window. */
  leaseMs: number;
  /** Reads the current CI load. Wrapped so a throw degrades to {@link UNKNOWN_LOAD}, not a crash. */
  loadProbe: () => CiLoad;
  /** Defaults to real `setTimeout`; tests inject a manual one to fire lease expiry on demand. */
  scheduler?: Scheduler;
}

/**
 * The stateful admission controller: a leased-slot semaphore + FIFO queue.
 *
 * A slot is taken when a ship is admitted and released `leaseMs` later (the presumed CI-run window),
 * so `budget` bounds CONCURRENT in-flight CI, not merely simultaneous pushes. A ship whose push
 * FAILS frees its slot immediately (no CI was triggered). The queue drains on every slot release
 * AND whenever the load changes (call {@link pump} from a pipeline-health subscription), so a
 * finished release un-pauses the fleet without waiting for a lease to time out.
 */
export class CiBudgetGovernor {
  private budget: number;
  private leaseMs: number;
  private loadProbe: () => CiLoad;
  private scheduler: Scheduler;
  private inFlight = 0;
  private queue: Waiter[] = [];

  constructor(opts: GovernorOptions) {
    this.budget = opts.budget;
    this.leaseMs = opts.leaseMs;
    this.loadProbe = opts.loadProbe;
    this.scheduler = opts.scheduler ?? realScheduler;
  }

  /** Live view, for the init wiring and tests. */
  get inFlightCount(): number {
    return this.inFlight;
  }
  get queueLength(): number {
    return this.queue.length;
  }
  get budgetValue(): number {
    return this.budget;
  }
  get leaseMsValue(): number {
    return this.leaseMs;
  }

  /** Test-only: drop all in-flight slots and queued waiters, returning the controller to empty.
   *  A pending lease timer that later fires is harmless — `release()` floors `inFlight` at 0. Used
   *  by tests that inject fake timers (which are discarded on cleanup, so their leases would
   *  otherwise leak a slot into the next test). */
  reset(): void {
    this.inFlight = 0;
    this.queue = [];
  }

  /** Update the knobs (config-changed) and/or the load source, then re-drain the queue: a raised
   *  budget or a swapped probe can admit waiters that were held under the old settings. */
  configure(opts: { budget?: number; leaseMs?: number; loadProbe?: () => CiLoad }): void {
    if (opts.budget !== undefined) this.budget = opts.budget;
    if (opts.leaseMs !== undefined) this.leaseMs = opts.leaseMs;
    if (opts.loadProbe !== undefined) this.loadProbe = opts.loadProbe;
    this.pump();
  }

  /**
   * Run one CI-triggering unit of work (a ship's push + PR) under the budget. Awaits a slot —
   * QUEUEING, not pushing, while the fleet is over budget or a release is building — then runs
   * `work`, holds the slot for the lease window, and returns whatever `work` returned. If `work`
   * throws (the push/PR failed, so no CI fired) the slot is freed at once and the error re-thrown.
   *
   * `triggersCi(result)` (default: always true) lets the caller say a SUCCESSFUL outcome did not in
   * fact trigger CI — e.g. a no-remote local land — so the slot is freed immediately instead of
   * being leased. Nothing that never touches the shared pool should hold a slot against it.
   */
  async run<T>(work: () => Promise<T>, triggersCi: (result: T) => boolean = () => true): Promise<T> {
    // Disabled: pure pass-through, no slot, no lease, no timer — so an unconfigured singleton adds
    // exactly nothing to a shipping caller (and leaks no pending timers into its tests).
    if (this.budget <= 0) return work();

    await this.acquire();
    let released = false;
    let cancelLease: Cancel | null = null;
    const releaseOnce = () => {
      if (released) return;
      released = true;
      if (cancelLease) cancelLease();
      this.release();
    };
    try {
      const result = await work();
      if (triggersCi(result)) {
        // The push happened and CI is presumed in flight: hold the slot for the lease, then
        // auto-free. This is what makes `budget` bound concurrent RUNS, not just pushes.
        cancelLease = this.scheduler(this.leaseMs, releaseOnce);
      } else {
        // Succeeded but triggered no CI (no remote → local land): free the slot now.
        releaseOnce();
      }
      return result;
    } catch (e) {
      releaseOnce();
      throw e;
    }
  }

  private acquire(): Promise<void> {
    if (this.admit()) {
      this.inFlight += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.queue.push({ resolve });
    });
  }

  private admit(): boolean {
    return (
      admitCiWork({ inFlight: this.inFlight, budget: this.budget, load: this.safeLoad() }) ===
      "grant"
    );
  }

  private safeLoad(): CiLoad {
    try {
      return this.loadProbe();
    } catch {
      return UNKNOWN_LOAD;
    }
  }

  private release(): void {
    if (this.inFlight > 0) this.inFlight -= 1;
    this.pump();
  }

  /** Re-evaluate the queue and admit as many waiters as the budget + current load now allow.
   *  Called on every slot release and, in production, on every pipeline-health reading so a
   *  finished release drains the fleet immediately. */
  pump(): void {
    while (this.queue.length > 0 && this.admit()) {
      const w = this.queue.shift()!;
      this.inFlight += 1;
      w.resolve();
    }
  }
}

/**
 * The process-wide singleton every ship routes through. Starts DISABLED (budget 0 = pass-through)
 * so it is inert until `startCiBudgetGovernor()` (ciBudgetGovernorInit.ts) reads `[fleet]` from
 * config and wires the live load signal at app startup. An unconfigured build — and every test that
 * ships an agent without touching the governor — therefore behaves exactly as before.
 */
export const ciBudgetGovernor = new CiBudgetGovernor({
  budget: 0,
  leaseMs: 900_000,
  loadProbe: () => UNKNOWN_LOAD,
});
