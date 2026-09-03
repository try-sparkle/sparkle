// backlogAutoscaler — CAUSE 4 of the never-idle epic (`sparkle-n2feho`), PHASE 1 ONLY.
//
// ══ THIS MODULE IS READ-ONLY BY DESIGN, AND THAT IS THE WHOLE OF PHASE 1 ════════════════════════
// It computes a number and reports it. It spawns nothing, writes no bead, writes to no PTY, and
// invokes no Tauri command. There is no arming marker here BECAUSE THERE IS NOTHING TO ARM: an
// arming gate exists to stop a WRITE from happening the moment the wiring is committed, and this
// file performs no write. Phase 2 — the one that actually issues spawns — is a separate bead and
// MUST add the gate (`scripts/lib/hook-arming-gate.sh`, in the callee, fail-closed) at the same
// time as it adds the first spawn call. AGENTS.md: DEPLOYING A HOOK IS RUNNING IT. A prior feature
// was merged on the plan that its first run would be by hand with the fleet idle; a sibling
// worktree ran it immediately and made 236 state-changing writes. `backlogAutoscaler.test.ts`
// carries a source ratchet that fails if this module ever grows a write API, so Phase 2 has to
// delete that ratchet deliberately rather than slip a spawn past review.
//
// ── THE GAP THIS MEASURES ───────────────────────────────────────────────────────────────────────
// The control loop already exists at 60s, but it is a WATCHER: it emits at most ONE message per
// 10-minute cadence, and what it emits is a message ASKING A MODEL to spin up a fleet. Nothing in
// the app computes `target = min(free capacity, ready backlog)` over the GENERAL ready backlog. So
// the fleet is supervised, not self-feeding, and the ceiling on throughput is one unit of work per
// cadence window regardless of how much the machine could carry.
//
// ── WHAT THE DRY RUN IS ACTUALLY FOR ────────────────────────────────────────────────────────────
// The concierge decision on this epic (2026-08-26) predicted a dry run would PROVE the load-gate
// bug by showing computed capacity far below the machine's RAM ceiling. Cause 1 (the load-admission
// gate, PRs #2710/#2869/#2875) has since landed, so this is now the CHECK THAT IT REALLY DID. That
// is why the decision reports `ceiling` AND `basis` AND `population` rather than just a target: a
// human has to be able to compare the computed ceiling against what the machine's RAM should
// support, and to know which population produced the count — comparing it against the number of
// visible panes is exactly the misreading that produced the original false report.
//
// *** THE RUNNING APP IS A PACKAGED BUILD WITH NO HOT RELOAD. None of this is observable in the
// currently-running process. It becomes observable only in a DMG built from a main that contains
// this merge. An "I don't see any autoscaler lines" report against today's app is NOT a failure of
// this code — it is the absence of this code from that binary. ***
//
// ── SHAPE: the two patterns that already exist, not a third ─────────────────────────────────────
//  * `drainerBridge.planDrainDispatch` — `cap = min(...)` arithmetic, single-flight per tick, and a
//    single-owner election via `ownsProjectInThisWindow(SPARKLE_PROJECT_ID)`. That module is scoped
//    to agent-feedback DRAIN SLOTS, which is why it is not this autoscaler; its structure is.
//  * `improveNudge` — a PURE decision (`decideAutoscale`) that is trivially testable, plus a thin
//    sweep that only gathers deps. Every input arrives as data so the arithmetic can be asserted
//    without a store, a timer, or a window.
import type { Bead } from "./beads";
import type { CapacityReading } from "./agentCapacity";
import { localAgentCapacity } from "./agentCapacity";
import { selectNextReadyBead, type NextReadyBead } from "./improveNudge";
import { useBeadsStore } from "../stores/beadsStore";
import { SPARKLE_PROJECT_ID } from "./sparkleAgent";
import { ownsProjectInThisWindow } from "./goalContinuationRunner";
import { log } from "../logger";

/**
 * WHICH POPULATION THIS AUTOSCALER COUNTS, decided on purpose (bead `sparkle-dv65b`, UNFIXED).
 *
 * Two counts in this app are compared against the SAME threshold and count DIFFERENT populations:
 *   * `agentCapacity.localAgentCapacity()` counts local build agents AND workers — every row that
 *     runs its own Claude Code with its own V8 heap.
 *   * `orchestrationListener.globalUsedSlots()` counts `kind === "worker"` ONLY.
 * With `max_concurrent = 4`, 3 build agents and 1 worker live, the worker-only count sees 1 of 4
 * and would admit 3 more — 7 model processes against a budget of 4.
 *
 * THIS MODULE COUNTS BUILD AGENTS AND WORKERS (`localAgentCapacity`), and the reason is that the
 * ceiling it is dividing was derived that way: `enforcedWorkerCap` is installed RAM (and core
 * count) divided by a PER-AGENT budget, so the only sound denominator is every machine-resident
 * model process. Spending free slots computed from a worker-only count against a RAM-derived
 * ceiling over-admits by exactly the number of build agents running — which, on the founder's
 * machine, is routinely most of the fleet. An autoscaler is a MULTIPLIER on whichever count it
 * picks, so picking the permissive one here would turn a known 3-agent discrepancy into a
 * 3-agent-per-tick discrepancy. When `sparkle-dv65b` is fixed, this comment is what says which side
 * this file was already on; nothing here has to change.
 */
export const AUTOSCALE_POPULATION = "local build agents + workers (localAgentCapacity)" as const;

/** Why the target is the number it is. A code, so callers branch on it rather than on prose. */
export type AutoscaleReason =
  /** The cached beads board had no snapshot this pass. NOT an empty board — see `target: null`. */
  | "board-unreadable"
  /** The board was read and the ready column is genuinely empty. Nothing to staff. */
  | "backlog-empty"
  /** Every slot against the machine-wide ceiling is taken; nothing can be started right now. */
  | "at-capacity"
  /** Free slots are the binding term: there is more ready work than the machine can carry. */
  | "capacity-bound"
  /** The ready backlog is the binding term: the machine could carry more than there is to do. */
  | "backlog-bound";

export interface AutoscaleDecision {
  /**
   * HOW MANY AGENTS THIS PASS WOULD START, were it armed. `min(freeSlots, readyCount)`.
   *
   * `null` — never `0` — when the board could not be read. Those two states are DIFFERENT FACTS
   * and conflating them is the defect bead `sparkle-hrzitj` (P0) was filed for on the sibling
   * watcher: "we do not know whether there is work" got reported as "there is no work", which
   * stood a watcher down against a live backlog. A consumer must be forced to handle the unknown,
   * which a nullable type does and a `0` does not.
   */
  target: number | null;
  /** Slots taken against the machine-wide budget right now, in `AUTOSCALE_POPULATION`. */
  current: number;
  /**
   * READY WORK THIS PASS COULD NOT STAFF: `readyCount - target`, i.e. what is left over after
   * spending every free slot. `null` when the board is unreadable, for the same reason `target` is.
   *
   * Deliberately NOT "target - current": with `target` denominated in NEW agents and `current` in
   * running ones, that subtraction is a category error. This number is the one a human wants —
   * "the machine is short of the fleet this backlog wants by N" — and it is `0` exactly when the
   * backlog is fully staffable this pass.
   */
  deficit: number | null;
  /** Slots free against the ceiling: `max(0, ceiling - current)`. */
  freeSlots: number;
  /** Size of the ready column. `null` when the board is unreadable. */
  readyCount: number | null;
  /** The machine-wide ceiling actually ENFORCED — `CapacityReading.limit`. */
  ceiling: number;
  /** WHY the ceiling is that number, in the words `agentCapacity` already computed. */
  basis: string;
  /** Which population `current` counts. See `AUTOSCALE_POPULATION`. */
  population: typeof AUTOSCALE_POPULATION;
  reason: AutoscaleReason;
  /** The bead Phase 2 would hand to the first spawn — the EXISTING selector, not a second sort. */
  nextBead: NextReadyBead | null;
  /** One line fit for a human reading a log. Carries every number above. */
  summary: string;
}

export interface AutoscaleInput {
  /**
   * FALSE means the cached board snapshot was absent this pass — the poll that fills it is gated on
   * this window owning the project and can fail to start at all. It is routine, not exotic, and it
   * is not zero backlog.
   */
  boardReadable: boolean;
  /** The board's already-filtered READY column (`board.backlog`). Ignored when `!boardReadable`. */
  readyBacklog: readonly Bead[];
  /** The machine-wide reading, verbatim from `localAgentCapacity()`. */
  capacity: CapacityReading;
}

/**
 * THE ARITHMETIC, pure and total: `target = min(free capacity, ready backlog)`.
 *
 * Pure so the clamp can be asserted without a store, a window, or a clock — every number it needs
 * arrives as data. It reads the ready column with the EXISTING `selectNextReadyBead` ordering
 * rather than re-sorting: a second priority sort in a second file is how two surfaces come to
 * disagree about what "the next bead" is.
 *
 * FAILS TOWARD SILENCE. An unreadable board yields `target: null` and nothing downstream may treat
 * that as a licence to act — a spawn issued on a board nobody could read is a spawn against an
 * unknown backlog.
 */
export function decideAutoscale(input: AutoscaleInput): AutoscaleDecision {
  const { capacity } = input;
  const ceiling = capacity.limit;
  const current = capacity.used;
  // `used` can EXCEED `limit` — a runtime narrowing (memory pressure, run-queue) lowers the ceiling
  // under a fleet already admitted, which `agentCapacity` documents and renders as "holding N
  // against M". So the floor at 0 is load-bearing, not defensive noise: without it `freeSlots` goes
  // negative and `min(negative, backlog)` reports a negative target, which is not a number of
  // agents at all.
  const freeSlots = Math.max(0, ceiling - current);
  const base = {
    current,
    freeSlots,
    ceiling,
    basis: capacity.basis,
    population: AUTOSCALE_POPULATION,
  } as const;

  if (!input.boardReadable) {
    // NO TARGET AT ALL, distinct from a target of 0. Every count that would be a lie stays null.
    return {
      ...base,
      target: null,
      deficit: null,
      readyCount: null,
      reason: "board-unreadable",
      nextBead: null,
      summary:
        `backlog autoscaler (DRY RUN): the cached beads board could not be read this pass, so ` +
        `there is NO target — that is not the same as a target of zero. This machine holds ` +
        `${current} of ${ceiling} agent slots (${freeSlots} free); the ceiling is ${capacity.basis}, ` +
        `counted over ${AUTOSCALE_POPULATION}.`,
    };
  }

  const readyCount = input.readyBacklog.length;
  const nextBead = selectNextReadyBead(input.readyBacklog);
  // THE CLAMP. Both terms are already non-negative, so the min is the whole of it.
  const target = Math.min(freeSlots, readyCount);
  const deficit = readyCount - target;
  const reason: AutoscaleReason =
    readyCount === 0
      ? "backlog-empty"
      : freeSlots === 0
        ? "at-capacity"
        : // A tie (free slots exactly equal to the backlog) is reported as backlog-bound: the
          // backlog is fully staffed and adding capacity would buy nothing, which is the fact a
          // human is trying to learn.
          readyCount > freeSlots
          ? "capacity-bound"
          : "backlog-bound";

  return {
    ...base,
    target,
    deficit,
    readyCount,
    reason,
    nextBead,
    summary:
      `backlog autoscaler (DRY RUN): would start ${target} agent(s) — ` +
      `min(${freeSlots} free slots, ${readyCount} ready beads) — ${reason}. This machine holds ` +
      `${current} of ${ceiling} agent slots; the ceiling is ${capacity.basis}, counted over ` +
      `${AUTOSCALE_POPULATION}. ${deficit} ready bead(s) would remain unstaffed. ` +
      `Next up: ${nextBead === null ? "(none)" : `${nextBead.id} — ${nextBead.title}`}. ` +
      `NOTHING WAS STARTED: this is Phase 1, read-only.`,
  };
}

/**
 * A stable identity for a decision, so a 60s loop does not write the same line 1,440 times a day.
 * Every number a human would act on is in it; `summary` and `nextBead.title` are not, because a
 * retitled bead is not a change in the arithmetic.
 */
export function autoscaleFingerprint(d: AutoscaleDecision): string {
  return [d.target ?? "null", d.current, d.freeSlots, d.readyCount ?? "null", d.ceiling, d.reason, d.basis].join("|");
}

/** Re-report an unchanged decision this often, so a long-lived process still shows current numbers
 *  to a human who opened the log after it settled. */
export const AUTOSCALE_REPORT_HEARTBEAT_MS = 10 * 60 * 1000;

/**
 * Should this pass emit a report? A changed decision always; an unchanged one at the heartbeat.
 * Pure, and separated from the sweep so the throttle itself is assertable.
 */
export function shouldReportAutoscale(
  prev: { fingerprint: string; at: number } | null,
  next: AutoscaleDecision,
  now: number,
): boolean {
  if (prev === null) return true;
  if (prev.fingerprint !== autoscaleFingerprint(next)) return true;
  return now - prev.at >= AUTOSCALE_REPORT_HEARTBEAT_MS;
}

export interface BacklogAutoscalerDeps {
  /** Single-owner election — only one window reports, or N windows log N copies of one fact. */
  ownsProject: () => boolean;
  readBoard: () => { boardReadable: boolean; readyBacklog: readonly Bead[] };
  readCapacity: () => CapacityReading;
  /** WHERE THE DECISION GOES. The only side effect this module has, and it is a log line. */
  report: (decision: AutoscaleDecision) => void;
  now: () => number;
}

/** The last decision computed in this window, for a surface that wants to render it. Read-only
 *  bookkeeping; nothing acts on it. `null` before the first pass, or in a non-owning window. */
let lastDecision: AutoscaleDecision | null = null;
let lastReport: { fingerprint: string; at: number } | null = null;

export function lastAutoscaleDecision(): AutoscaleDecision | null {
  return lastDecision;
}

/** Test seam: module state survives across cases otherwise, and a stale throttle silences the
 *  next case's report. */
export function _resetBacklogAutoscalerForTests(): void {
  lastDecision = null;
  lastReport = null;
}

/**
 * ONE PASS: gather, decide, report. Returns the decision (or `null` when this window does not own
 * the project) so a test asserts the COMPUTED TARGET rather than that the function ran.
 */
export function sweepBacklogAutoscaler(deps: BacklogAutoscalerDeps): AutoscaleDecision | null {
  if (!deps.ownsProject()) return null;
  const board = deps.readBoard();
  const decision = decideAutoscale({
    boardReadable: board.boardReadable,
    readyBacklog: board.readyBacklog,
    capacity: deps.readCapacity(),
  });
  lastDecision = decision;
  const now = deps.now();
  if (shouldReportAutoscale(lastReport, decision, now)) {
    deps.report(decision);
    lastReport = { fingerprint: autoscaleFingerprint(decision), at: now };
  }
  return decision;
}

// ── production wiring ─────────────────────────────────────────────────────────────────────────────

/**
 * The ready column, from the SAME cached 5s snapshot the never-idle watcher reads — no `bd` shell
 * call on this tick, which is what keeps the sweep free.
 *
 * An absent snapshot is BOARD-UNREADABLE. The counts stay empty so no caller can accidentally read
 * a number that means nothing; `boardReadable: false` is the fact that travels.
 */
function productionReadBoard(): { boardReadable: boolean; readyBacklog: readonly Bead[] } {
  const snap = useBeadsStore.getState().byProject[SPARKLE_PROJECT_ID];
  if (snap === undefined) return { boardReadable: false, readyBacklog: [] };
  return { boardReadable: true, readyBacklog: snap.board.backlog };
}

const PRODUCTION_DEPS: BacklogAutoscalerDeps = {
  ownsProject: () => ownsProjectInThisWindow(SPARKLE_PROJECT_ID),
  readBoard: productionReadBoard,
  readCapacity: localAgentCapacity,
  // The whole Phase-1 side effect: one log line a human can read. `log.info` and not `warn` —
  // a dry-run measurement is not a fault, and a warn-level line every heartbeat would train
  // people to filter out the surface this bead exists to create.
  report: (d) =>
    log.info("backlog-autoscaler", d.summary, {
      target: d.target,
      current: d.current,
      deficit: d.deficit,
      freeSlots: d.freeSlots,
      readyCount: d.readyCount,
      ceiling: d.ceiling,
      basis: d.basis,
      population: d.population,
      reason: d.reason,
      nextBead: d.nextBead?.id ?? null,
      dryRun: true,
    }),
  now: () => Date.now(),
};

/** Matches the drain bridge's cadence — the same 60s tick the rest of the fleet plumbing runs on. */
export const BACKLOG_AUTOSCALER_SWEEP_MS = 60_000;

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the dry-run sweep. Returns a stop function; safe to call twice (the second is a no-op).
 *
 * The pass is synchronous and cheap — a store read, a `min`, and at most one log line — so it needs
 * neither the single-flight latch nor the abandon timer `drainerBridge` carries for its awaited
 * queue read. Ownership is re-read per tick inside the pass.
 */
export function startBacklogAutoscaler(deps: BacklogAutoscalerDeps = PRODUCTION_DEPS): () => void {
  if (timer !== null) return () => {};
  const tick = (): void => {
    try {
      sweepBacklogAutoscaler(deps);
    } catch (e) {
      log.warn("backlog-autoscaler", "dry-run pass threw", { error: String(e) });
    }
  };
  tick();
  timer = setInterval(tick, BACKLOG_AUTOSCALER_SWEEP_MS);
  return () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };
}
