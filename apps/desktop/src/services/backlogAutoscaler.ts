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
// PHASE 2 IMPORTS A WRITER, AND THAT IS THE REVIEWABLE ACT. Phase 1's ratchet asserted this module
// imported nothing that could write, precisely so adding one could not be quiet. It is replaced by
// a behavioural ratchet: DISARMED, the sweep must still call no spawn at all.
import { spawnBuildAgentInProject } from "./buildAgentSpawn";
import { useProjectStore } from "../stores/projectStore";
import { useSettingsStore } from "../stores/settingsStore";
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

/**
 * What one spawn attempt actually did.
 *
 * `"refused"` means PROVABLY nothing was created — the callee turned the request down before doing
 * anything. It is not an error condition and it must not blacklist the bead, or the likeliest
 * production first tick (a background spawn into a project nobody has opened this session) burns the
 * top bead and leaves the whole feature inert behind one warn line.
 */
export type SpawnOutcome = "spawned" | "refused";

export interface BacklogAutoscalerDeps {
  /** Single-owner election — only one window reports, or N windows log N copies of one fact. */
  ownsProject: () => boolean;
  readBoard: () => { boardReadable: boolean; readyBacklog: readonly Bead[] };
  readCapacity: () => CapacityReading;
  /** WHERE THE DECISION GOES. A log line, and — when ARMED — the spawns below. */
  report: (decision: AutoscaleDecision) => void;
  now: () => number;
  /**
   * IS THE SPAWNING PASS ARMED? Fail-closed: anything other than a definite `true` means NO SPAWN.
   *
   * AGENTS.md: DEPLOYING A HOOK IS RUNNING IT. This module already ticks every 60s in every mounted
   * window, so merging Phase 2's wiring IS its deployment — there is no dormant state to land in. A
   * feature once shipped on the stated plan that its first run would be by hand with the fleet idle,
   * and a sibling worktree ran it immediately: ~30 minutes, 236 state-changing writes, silent. The
   * writes here are heavier still — they are AGENTS, not rows.
   *
   * So the gate lives HERE, in the callee, rather than at the mount in `App.tsx`: the mount is the
   * thing whose commit deploys it, and a gate at the call site is a gate the deployment skips.
   */
  isArmed: () => boolean;
  /**
   * START ONE AGENT on `bead`. Called at most `decision.target` times per pass, and ONLY when armed.
   *
   * Injected rather than imported so this module still imports nothing that can write — the Phase-1
   * ratchet asserted exactly that and the replacement asserts it still holds while DISARMED.
   *
   * RETURNS AN OUTCOME, and the distinction is load-bearing rather than decorative.
   * `spawnBuildAgentInProject` has four documented refusals — no Sparkle project row, at capacity, a
   * torn-out project, and a project the human has not opened this session — and its own contract for
   * those paths is explicit: IN EVERY CASE NO AGENT EXISTS. A `=> void` seam discarded that fact, so
   * a bead was permanently blacklisted for a spawn that provably never happened. A `null` return is
   * PROOF OF NON-CREATION; a THROW is ambiguous, because the call does real work before it can fail.
   * Only the first is retried.
   */
  spawn: (bead: NextReadyBead) => SpawnOutcome;
  /**
   * RECORD THE INTENT BEFORE THE ATTEMPT. Called immediately before each `spawn`, never after.
   *
   * The 236-write incident was recoverable ONLY because every write had been journalled first. That
   * property is the one worth copying, and it is worth more than the ordering costs: a journal
   * entry with no spawn behind it is a readable over-count, while a spawn with no journal entry is
   * an agent nobody can account for.
   */
  journal: (bead: NextReadyBead, index: number, of: number) => void;
}

/** The last decision computed in this window, for a surface that wants to render it. Read-only
 *  bookkeeping; nothing acts on it. `null` before the first pass, or in a non-owning window. */
let lastDecision: AutoscaleDecision | null = null;
let lastReport: { fingerprint: string; at: number } | null = null;

/**
 * BEADS THIS WINDOW HAS ALREADY STARTED AN AGENT ON, and why a per-pass cap was not enough.
 *
 * `PHASE2_MAX_SPAWNS_PER_PASS = 1` bounds ONE tick. It does nothing across ticks, and across ticks
 * is where the duplication actually happens: nothing in this path marks the bead `in_progress` or
 * writes a claim — `spawnBuildAgentInProject` mints its own `sparkle-auto` telemetry bead and never
 * touches the target — so the bead is still `open` and unblocked on the next 60s tick, and
 * `selectNextReadyBead` is deterministic. It therefore returns THE SAME BEAD, and an armed loop with
 * free slots starts an agent on it every minute until something else moves it. Caught by review
 * (roborev 80524) against tests that hid it by reassigning the board between ticks — the one shape
 * the steady state never takes.
 *
 * PROCESS-LOCAL, AND THAT IS A KNOWN LIMIT RATHER THAN THE FIX. A second window runs its own module
 * instance and its own 60s tick, so this cannot stop two windows double-booking one bead; only a
 * DURABLE claim-at-spawn can, and that is Phase 3. It is still strictly better than nothing: the
 * single-window case is the one the 60s cadence makes CERTAIN rather than merely possible.
 *
 * Never pruned. An armed session's spawn count is bounded by the ready backlog, and a bead that
 * leaves the ready column never comes back to it — so this grows with work actually started, not
 * with time.
 */
const spawnedBeads = new Set<string>();

export function lastAutoscaleDecision(): AutoscaleDecision | null {
  return lastDecision;
}

/** Test seam: module state survives across cases otherwise, and a stale throttle silences the
 *  next case's report. */
export function _resetBacklogAutoscalerForTests(): void {
  lastDecision = null;
  lastReport = null;
  spawnedBeads.clear();
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

  // ── PHASE 2: THE PASS ACTUALLY TAKES THE WORK, AND ONLY WHEN ARMED ───────────────────────────
  //
  // Everything above this line is Phase 1 and is unchanged, which is the contract: DISARMED, this
  // function computes and logs and does nothing else, exactly as it did before Phase 2 existed.
  //
  // THE ORDER OF THESE GUARDS IS THE SAFETY ARGUMENT, so read them as one:
  //   * `isArmed()` first, because a human's arming decision outranks every computed number, and
  //     because it is the one guard whose absence is catastrophic rather than merely wrong.
  //   * `target === null` next, and NOT folded into the `> 0` test. `null` is "the board could not
  //     be read", which is a DIFFERENT FACT from "there is no work" — conflating them is the P0
  //     this decision type was shaped to prevent, and a spawn issued on a board nobody could read
  //     is a spawn against an unknown backlog.
  //   * `nextBead` last: without a bead there is nothing to hand a spawn, and inventing one here
  //     would be a second selector.
  if (!deps.isArmed()) return decision;
  if (decision.target === null || decision.target <= 0) return decision;
  if (decision.nextBead === null) return decision;

  // WHICH OF THESE THREE ACTUALLY STOPS A SPAWN — stated plainly, because guessing wrong about that
  // is how a guard gets deleted as dead code later.
  //
  // ONLY `isArmed()` is independently load-bearing: mutating it away makes the disarmed cases spawn,
  // and the tests catch it. The other two are DEFENCE IN DEPTH and mutation testing correctly fails
  // to kill either, because the loop below is bounded by `Math.min(decision.target, …)` — an
  // unreadable board (`target: null`) and a full machine (`target: 0`) both yield a zero-length
  // loop on their own. `nextBead === null` is likewise covered, since the same unreadable board
  // produces it.
  //
  // They stay anyway, and the reason is specific rather than superstitious: each states an intent
  // the arithmetic only happens to satisfy right now. If `target` ever became non-null on an
  // unreadable board, or the loop bound moved off `target`, the silent failure would be a spawn
  // against an unknown backlog — the one outcome this pass must never produce. Cheap insurance
  // against a future edit, and labelled so nobody mistakes it for the thing doing the work.

  // ONE SPAWN PER PASS, journalled before each attempt, and the cap is deliberate.
  //
  // `target` is already `min(freeSlots, readyCount)`, so it never exceeds capacity — but
  // `decideAutoscale` selects ONE next bead, and spawning `target` agents would hand that SAME bead
  // to all of them. De-duplicating properly needs a DURABLE claim-at-spawn, which is PHASE 3 and
  // explicitly not this bead: `orchestrationListener`'s existing `claimedBeads` set is
  // process-local, so it cannot stop a second window double-booking the same work.
  //
  // So the honest bound until Phase 3 lands is one, and it is expressed as a `min` against `target`
  // rather than a bare `1` — the cap is the thing that changes when Phase 3 arrives, and a reader
  // should see which number is the policy and which is the arithmetic.
  // SUPPRESS AT SELECTION, NOT AT THE GATE — and that distinction is the whole of this block.
  //
  // The first version tested `spawnedBeads.has(decision.nextBead.id)` and returned. That is a
  // HEAD-OF-LINE BLOCK, not a de-duplication: `selectNextReadyBead` always returns the TOP of the
  // ready column, and nothing here moves a bead out of it (`columnFor` keeps every open, unblocked
  // bead, and `spawnBuildAgentInProject` never touches the target's status). So after one spawn every
  // later tick re-selected the same bead, hit the guard and returned — one agent for the life of the
  // window, then permanent idleness, against a machine with seven free slots and fifty ready beads.
  // The exact opposite of what this loop exists for, and my own test pinned the stall as if it were
  // the intent (roborev 80561).
  //
  // Selecting from the ready column MINUS what this window has already started fixes it while
  // keeping the de-duplication: the same bead is never picked twice, and the NEXT one is.
  const candidate = selectNextReadyBead(
    board.readyBacklog.filter((b) => !spawnedBeads.has(b.id)),
  );
  // Every ready bead already has an agent from this window. Nothing to do — which is a real
  // steady state, not an error.
  if (candidate === null) return decision;

  const toStart = Math.min(decision.target, PHASE2_MAX_SPAWNS_PER_PASS);
  for (let i = 0; i < toStart; i += 1) {
    // Recorded BEFORE the attempt: `spawnBuildAgentInProject` does real work before it can throw, so
    // a throw does NOT prove nothing was created, and re-selecting the bead would double-book it.
    // Over-suppressing costs one bead a human can re-queue; under-suppressing costs a rival worktree
    // on the same work.
    spawnedBeads.add(candidate.id);
    deps.journal(candidate, i, toStart);
    // ...but a REFUSAL is different in kind, and undoing the record is what keeps the loop alive. The
    // callee's four refusal paths each guarantee no agent exists, so blacklisting the bead there
    // would retire real work on the strength of a transient condition — at capacity now, or a
    // project the human has not opened YET. Both clear on their own.
    if (deps.spawn(candidate) === "refused") spawnedBeads.delete(candidate.id);
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
  // FAIL-CLOSED BY CONSTRUCTION: the store ships `autoscalerArmed: false` and the config reader
  // defaults a missing `[autoscaler].armed` to false, so every way of NOT deciding lands on "do not
  // spawn". `=== true` rather than a truthiness test, so an undefined slice (a store shape older
  // than this field, which a persisted rehydration can produce) cannot arm it.
  isArmed: () => useSettingsStore.getState().autoscalerArmed === true,
  // JOURNAL BEFORE THE ATTEMPT — never after. The 236-write incident was recoverable only because
  // every write had been journalled first, and this is the cheap half of that lesson.
  journal: (bead, index, of) =>
    log.info("backlog-autoscaler", `ARMED: about to spawn ${index + 1}/${of} on ${bead.id}`, {
      bead: bead.id,
      title: bead.title,
      priority: bead.priority,
      index,
      of,
    }),
  spawn: (bead) => {
    // The Sparkle repo's own project row. `drainerBridge` records that the sparkle-self clone is not
    // a projectStore Project, and `pusherMount` looks this up defensively for the same reason — so
    // ABSENCE IS A ROUTINE CASE, not an invariant violation, and it must refuse rather than throw.
    const project = useProjectStore.getState().projects.find((p) => p.id === SPARKLE_PROJECT_ID);
    if (project === undefined) {
      log.warn("backlog-autoscaler", "ARMED but no Sparkle project row is loaded — not spawning", {
        bead: bead.id,
      });
      return "refused";
    }
    // `background: true` is the machine-dispatch contract: it drops everything that would move the
    // founder's attention (project selection, reveal, compose focus) while KEEPING the pane mount,
    // because skipping that would make the spawn fictional — created and briefed on paper, never
    // started, with every caller reporting success. It returns `null` on any of three documented
    // refusals (capacity, a torn-out project, a project unvisited this session); a background caller
    // must handle that like any other null, so this logs it rather than assuming a spawn happened.
    const id = spawnBuildAgentInProject(project, {
      background: true,
      dispatchedBy: "machine",
      name: bead.id,
      prompt:
        `You were started automatically by the backlog autoscaler to work bead ${bead.id}.\n\n` +
        `Run \`bash scripts/bead-brief.sh ${bead.id}\` from the repo root for the full brief — its ` +
        `description AND its comment thread, where the newest human note usually is.\n\n` +
        `Follow AGENTS.md. Work on your own branch, commit every self-contained verified unit, and ` +
        `update PRD/<branch>.md each commit.`,
    });
    if (id === null) {
      log.warn("backlog-autoscaler", "spawn REFUSED — see buildAgentSpawn for which of the four", {
        bead: bead.id,
      });
      return "refused";
    }
    log.info("backlog-autoscaler", "spawned", { bead: bead.id, agent: id });
    return "spawned";
  },
};

/** Matches the drain bridge's cadence — the same 60s tick the rest of the fleet plumbing runs on. */
export const BACKLOG_AUTOSCALER_SWEEP_MS = 60_000;

/**
 * How many agents ONE armed pass may start. One, until Phase 3 makes the bead claim durable.
 *
 * Not a performance tuning knob: `decideAutoscale` names a single next bead, so anything above 1
 * hands the same bead to every agent it starts. Raising this without a durable claim-at-spawn is
 * how one unit of work becomes N worktrees on N branches doing identical work.
 */
export const PHASE2_MAX_SPAWNS_PER_PASS = 1;

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
