// backlogAutoscaler — CAUSE 4 of the never-idle epic (`sparkle-n2feho`), PHASES 1-4.
//
// ══ EVERY WRITE IN HERE IS BEHIND ONE ARMING FLAG, AND IT SHIPS FALSE ═══════════════════════════
// Phase 1 computed `target = min(free capacity, ready backlog)` and only logged. Phase 2 added the
// spawn. Phase 3 (`sparkle-n2feho.10`) made the de-duplication DURABLE, and Phase 4 added the floor
// and backpressure. Three kinds of write now live in this file — a claim, a journal line, and an
// agent — and NONE of them happens unless `isArmed()` returns a definite `true`.
//
// AGENTS.md: DEPLOYING A HOOK IS RUNNING IT. This module already ticks every 60s in every mounted
// window, so merging its wiring IS its deployment; there is no dormant state to land in. A feature
// once shipped on the stated plan that its first run would be by hand with the fleet idle, and a
// sibling worktree ran it immediately: ~30 minutes, 236 state-changing writes, silent. So the gate
// sits in the CALLEE, not at the `App.tsx` mount — the mount is the thing whose commit deploys it —
// and `journal` runs strictly BEFORE the claim and before the spawn, because that ordering is the
// only reason the 236-write incident was recoverable. `backlogAutoscaler.test.ts` asserts all of
// it behaviourally: DISARMED, the pass must reach no writer of any kind, the claim store included.
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
import { localAgentCapacity, localAgentRowIds } from "./agentCapacity";
import { processAliveOf } from "../engine/turnEndAuthority";
import { deathCauseForAgent } from "./deadSessionRegistry";
import { isResurrectable } from "../engine/deathTypes";
import type { ConcurrencyAdmission } from "./memoryAdmission";
import { currentMemoryAdmissionReading } from "./memoryAdmission";
import type { BeadClaimsReading, BeadClaimView, ClaimOutcome, ClaimWriteResult } from "./autoscalerClaim";
import {
  acquireBeadClaim,
  heartbeatBeadClaim,
  listAutoscalerClaims,
  mintAutoscalerClaimantId,
  releaseBeadClaim,
} from "./autoscalerClaim";
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
  /** The bead the first spawn would be handed — the EXISTING selector, not a second sort.
   *
   *  NOT the same thing as the bead a pass actually starts on: the spawn loop selects from the ready
   *  column MINUS whatever is already claimed, so when another window holds this one the pass moves
   *  to the next. This field is the unfiltered head of the column, reported for a human reading a
   *  log; the claim store is what decides. */
  nextBead: NextReadyBead | null;
  /** PHASE 4 — the configured floor (`[autoscaler].floor`). `0` means no floor. */
  floor: number;
  /**
   * HOW FAR BELOW THE FLOOR the fleet is, while there is ready work: `max(0, floor - current)`, and
   * `0` whenever the ready column is empty or unreadable.
   *
   * A floor is a PACING statement, not a second ceiling. It cannot raise `target` — `target` is
   * already `min(freeSlots, readyCount)` and the machine-wide ceiling still binds — it raises only
   * how much of that target ONE pass may spend, so a fleet that has drained does not have to climb
   * back at the ordinary per-pass rate.
   */
  floorDeficit: number;
  /** PHASE 4 — what the live memory reading says about adding load right now. */
  backpressure: Backpressure;
  /**
   * HOW MANY AGENTS THIS PASS MAY ACTUALLY START, were it armed: `min(target, cap)` where the cap is
   * the per-pass policy, widened by `floorDeficit` and narrowed by `backpressure`.
   *
   * SEPARATE FROM `target` ON PURPOSE, and the separation is the thing to preserve. `target` is the
   * ARITHMETIC — what the machine and the backlog say is possible — and it is what a human reads to
   * size the gap. `spawnBudget` is the POLICY. Folding them would make a dry-run measurement move
   * every time a pacing knob changed, and would leave nowhere to read what the loop believes it
   * could do versus what it is willing to do this minute.
   */
  spawnBudget: number;
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
  /** PHASE 4 — `[autoscaler].floor`. `0` (the shipped value) changes nothing. Required rather than
   *  defaulted, so no caller can silently inherit a floor it never stated. */
  floor: number;
  /** PHASE 4 — the verdict from [`backpressureFor`]. Passed in rather than read here so the whole
   *  decision stays pure and every branch is assertable without a memory sampler. */
  backpressure: Backpressure;
}

/**
 * WHAT THE MACHINE SAYS ABOUT ADDING MORE LOAD RIGHT NOW — PHASE 4's backpressure.
 *
 *   * `none`     — nothing is pushing back. The ordinary per-pass cap applies.
 *   * `throttle` — the machine is squeezed. One spawn per pass at most, and the FLOOR does not get
 *                  to burst past it: a floor exists to keep the fleet fed, not to feed it faster
 *                  than the machine can carry.
 *   * `hold`     — stop adding. This pass starts nothing at all.
 */
export type Backpressure = "none" | "throttle" | "hold";

/**
 * READ THE BACKPRESSURE off the live memory admission — the one signal in this app that is actually
 * READABLE rather than guessed at.
 *
 * `memoryAdmission.currentMemoryAdmissionReading()` is synchronous, cached and already TTL’d, and it
 * carries the OS's OWN verdict (`sample.level`) rather than arithmetic of ours. That last part is
 * why this reads `level` rather than comparing `effective` against `static_max`: a narrowed ceiling
 * is already applied to `capacity.limit`, so `freeSlots` has accounted for it, and re-deriving it
 * here would double-count one fact. What `capacity` cannot say is "the machine is in trouble",
 * which is exactly the sentence `level` is.
 *
 * NOTHING MEASURED IS NOT TROUBLE. A null reading (never sampled, the last sample failed, the last
 * sample expired) and `sampled: false` both mean "behave exactly as you did before" — the module's
 * own words — and reading either as pressure would let one failed sampler silence the loop forever.
 *
 * AN UNRECOGNISED LEVEL THROTTLES RATHER THAN HOLDS, and that is a deliberate choice against the
 * usual fail-closed rule. The vocabulary comes from Rust and could grow a value; treating a word we
 * do not know as an emergency would convert a vocabulary change into PERMANENT IDLENESS on a
 * never-idle epic — the failure this epic's own retro records as the more expensive one (roborev
 * 80561, a double-spawn fix that turned out to be a head-of-line block). Throttling keeps the loop
 * making progress at its most conservative rate while still refusing to burst.
 */
export function backpressureFor(admission: ConcurrencyAdmission | null): Backpressure {
  if (admission === null) return "none";
  if (!admission.sampled) return "none";
  const sample = admission.sample;
  if (sample === null) return "none";
  switch (sample.level) {
    case "normal":
      return "none";
    case "warn":
      return "throttle";
    case "critical":
      return "hold";
    default:
      return "throttle";
  }
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
  // Normalised here, once, so every consumer below reads a whole non-negative number. Rust refuses
  // an out-of-range `[autoscaler].floor` and the store clamps its setter, but this function is pure
  // and public and must not depend on either having run.
  const floor = Number.isFinite(input.floor) ? Math.max(0, Math.floor(input.floor)) : 0;
  const base = {
    current,
    freeSlots,
    ceiling,
    basis: capacity.basis,
    population: AUTOSCALE_POPULATION,
    floor,
    backpressure: input.backpressure,
  } as const;

  if (!input.boardReadable) {
    // NO TARGET AT ALL, distinct from a target of 0. Every count that would be a lie stays null.
    return {
      ...base,
      target: null,
      deficit: null,
      readyCount: null,
      // NO floor pressure on a board nobody could read. A floor is "keep N agents while there is
      // ready work", and whether there IS ready work is precisely what we do not know.
      floorDeficit: 0,
      spawnBudget: 0,
      reason: "board-unreadable",
      nextBead: null,
      summary:
        `backlog autoscaler: the cached beads board could not be read this pass, so ` +
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
  // THE FLOOR ONLY SPEAKS WHILE THERE IS READY WORK. On an empty column it is silent — "never idle"
  // means "never idle while the backlog has something in it", not "always run N agents".
  const floorDeficit = readyCount > 0 ? Math.max(0, floor - current) : 0;
  const spawnBudget = spawnBudgetFor(target, floorDeficit, input.backpressure);
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
    floorDeficit,
    spawnBudget,
    reason,
    nextBead,
    summary:
      `backlog autoscaler: the backlog wants ${target} more agent(s) — ` +
      `min(${freeSlots} free slots, ${readyCount} ready beads) — ${reason}. This machine holds ` +
      `${current} of ${ceiling} agent slots; the ceiling is ${capacity.basis}, counted over ` +
      `${AUTOSCALE_POPULATION}. ${deficit} ready bead(s) would remain unstaffed. ` +
      `Next up: ${nextBead === null ? "(none)" : `${nextBead.id} — ${nextBead.title}`}. ` +
      `This pass may start ${spawnBudget} of them (cap ${AUTOSCALE_MAX_SPAWNS_PER_PASS}, floor ` +
      `${floor} → shortfall ${floorDeficit}, backpressure ${input.backpressure}). ` +
      `NOTHING STARTS AT ALL unless [autoscaler].armed is true, which it is not by default.`,
  };
}

/**
 * A stable identity for a decision, so a 60s loop does not write the same line 1,440 times a day.
 * Every number a human would act on is in it; `summary` and `nextBead.title` are not, because a
 * retitled bead is not a change in the arithmetic.
 */
export function autoscaleFingerprint(d: AutoscaleDecision): string {
  return [
    d.target ?? "null",
    d.current,
    d.freeSlots,
    d.readyCount ?? "null",
    d.ceiling,
    d.reason,
    d.basis,
    // PHASE 4 numbers belong in the identity: a floor a human just set, or a machine that has just
    // gone from `none` to `hold`, is exactly the change they want the next line to show — and
    // without these the heartbeat would sit on a ten-minute silence over a decision that moved.
    d.floor,
    d.floorDeficit,
    d.backpressure,
    d.spawnBudget,
  ].join("|");
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
 * WHAT ONE SPAWN ATTEMPT ACTUALLY DID.
 *
 * `"refused"` means PROVABLY nothing was created — the callee turned the request down before doing
 * anything. It is not an error condition and it must not retire the bead, or the likeliest
 * production first tick (a background spawn into a project nobody has opened this session) burns the
 * top bead and leaves the whole feature inert behind one warn line.
 *
 * `"spawned"` CARRIES THE AGENT ID, and that is Phase 3's requirement rather than decoration. The
 * durable claim is renewed only while the agent it was spent on is still in the fleet; without the
 * id there is nothing to check liveness against, and the choice collapses to "renew forever" (a
 * bead parked when its agent dies) or "never renew" (a bead double-booked at the expiry backstop).
 */
export type SpawnResult =
  | { readonly outcome: "spawned"; readonly agentId: string }
  | { readonly outcome: "refused" };

export interface BacklogAutoscalerDeps {
  /** Single-owner election — only one window reports, or N windows log N copies of one fact.
   *
   *  NOT the de-duplication. This stops a SECOND WINDOW logging the same line; it does not stop a
   *  second window spawning, because each window owns the project in its own store and both can
   *  answer true. Only the durable claim decides that. */
  ownsProject: () => boolean;
  readBoard: () => { boardReadable: boolean; readyBacklog: readonly Bead[] };
  readCapacity: () => CapacityReading;
  /** PHASE 4 — `[autoscaler].floor`, read per pass so a config reload takes effect without a
   *  restart. */
  floor: () => number;
  /** PHASE 4 — the live memory admission, or `null` when there is no basis to narrow. Injected as
   *  the RAW reading rather than a pre-computed verdict so `backpressureFor`'s own branches are
   *  exercised by the sweep's tests and not only by its own. */
  readMemoryAdmission: () => ConcurrencyAdmission | null;
  /** WHERE THE DECISION GOES. A log line, and — when ARMED — the writes below. */
  report: (decision: AutoscaleDecision) => void;
  now: () => number;
  /**
   * IS THE PASS ARMED? Fail-closed: anything other than a definite `true` means NO WRITE OF ANY
   * KIND — no claim, no journal line, no agent.
   *
   * AGENTS.md: DEPLOYING A HOOK IS RUNNING IT. This module already ticks every 60s in every mounted
   * window, so merging its wiring IS its deployment — there is no dormant state to land in. A
   * feature once shipped on the stated plan that its first run would be by hand with the fleet idle,
   * and a sibling worktree ran it immediately: ~30 minutes, 236 state-changing writes, silent.
   *
   * So the gate lives HERE, in the callee, rather than at the mount in `App.tsx`: the mount is the
   * thing whose commit deploys it, and a gate at the call site is a gate the deployment skips.
   */
  isArmed: () => boolean;
  /** THIS WINDOW'S CLAIMANT IDENTITY, so the pass can tell ITS OWN claims from a peer's. */
  claimantId: () => string;
  /**
   * EVERY CLAIM IN THE DURABLE STORE, or the fact that it could not be read.
   *
   * `readable: false` is NOT an empty store, and the pass spawns nothing when it is false. A spawn
   * issued against an unreadable claim store cannot know whether another window is already on this
   * bead, which is the entire defect Phase 3 exists to close.
   */
  readClaims: () => Promise<BeadClaimsReading>;
  /** TAKE THE CLAIM. The compare-and-set; its verdict, not the listing above, is what authorises a
   *  spawn — the listing is a snapshot and a peer may have won since. */
  claimBead: (bead: NextReadyBead) => Promise<ClaimOutcome>;
  /** REFRESH a claim we hold, and (after a spawn) record the agent it was spent on. Resolves the
   *  typed reason rather than a boolean — `unknown` means renew again next pass, `lost`/`absent`
   *  mean stop, and those are opposite instructions. */
  heartbeatClaim: (beadId: string, agentId?: string) => Promise<ClaimWriteResult>;
  /** GIVE UP a claim: the bead left the ready column, the agent we started is gone, or the spawn
   *  was refused and provably created nothing. */
  releaseClaim: (beadId: string) => Promise<ClaimWriteResult>;
  /** EVERY LOCAL AGENT ROW ID, in `AUTOSCALE_POPULATION`. A ROW, not a process — a row in a tab
   *  nobody has opened this session still exists, which is why this and not the `live` subset. */
  liveAgentIds: () => ReadonlySet<string>;
  /**
   * IS THIS AGENT'S PROCESS ALIVE? **Three-valued, and all three values are used.**
   *
   * `true` running, `false` the process has provably EXITED, `undefined` this window does not
   * witness the agent at all — which is neither of the other two and must never be folded into one.
   * `engine/turnEndAuthority.processAliveOf` is the producer, and it is the app's only real death
   * signal (`services/agentLiveness` says as much: for a real one, ask something that watches the
   * process).
   *
   * A ROW IS NOT A PROCESS, AND THAT GAP IS WHERE THIS MODULE HAS BEEN WRONG TWICE. Rows are
   * rehydrated from the persisted project blob, so after a restart every id the previous launch
   * minted is still in `liveAgentIds` — and `resurrectionRunner` then brings SOME of those agents
   * back under the SAME row id. So the post-restart board is a mixture of ghosts and genuinely
   * running agents that the row list cannot tell apart, and neither can the claim's standing.
   */
  processAlive: (agentId: string) => boolean | undefined;
  /**
   * IS THE RESURRECTION RUNNER GOING TO BRING THIS AGENT BACK?
   *
   * THE ONE THING THAT MAKES A WITNESSED EXIT NON-TERMINAL, and without it this module and
   * `resurrectionRunner` read the SAME signal and act on it in OPPOSITE directions.
   * `engine/resurrection.decideResurrection`'s third gate is literally
   * `if (input.processAlive !== false) return "already-live"` — so `processAlive === false` is not
   * merely compatible with revival, it is revival's entire input domain, and its own header calls
   * the mounted-and-exited route "the COMMON case, not the rare one". Revival is `claude --resume`
   * in the agent's existing worktree under the SAME row id, i.e. it continues the SAME bead.
   *
   * So releasing a claim the moment we witness its agent exit hands that bead to a second agent
   * while the app's own machinery is about to resume the first — two worktrees, two branches, one
   * bead. `resurrectionRunner.noFight.test.ts` keeps that runner and `apiRecoveryRunner` disjoint on
   * exactly this signal; this dep is the same discipline for the third reader of it.
   *
   * THE PRODUCER IS `deadSessionRegistry.deathCauseForAgent` + `isResurrectable`, NOT the durable
   * `revival_due` mirror, and the difference is not cosmetic. `revival_due` is a **due-NOW** list:
   * `revival.rs::due_at` skips any record whose `not_before_ms` is in the future, and every
   * clock-armed cause (a session or spend wall) sets `not_before` to the wall's `reset_at`. So a
   * wall death — the fleet-wide wave this subsystem exists for — is ABSENT from that list for the
   * whole backoff, up to hours, while resurrection is unambiguously coming for it.
   *
   * The window-local registry does not vanish during backoff, and there is a reachability argument
   * that makes it sufficient here: this dep is consulted only on the `processAlive === false` arm,
   * and `processAliveOf` answers `false` only for an agent THIS WINDOW witnessed exit — which is
   * exactly when `noteAgentDeath` recorded the cause. A death we did not witness reads `undefined`
   * and never reaches this question at all.
   */
  resurrectionPending: (agentId: string) => boolean;
  /**
   * HOW LONG a bead may be held for an agent that is dead and pending revival, before the hold is
   * given up and the bead re-staffed.
   *
   * THE BOUND EXISTS BECAUSE "PENDING" CANNOT BE TRUSTED TO EXPIRE. `resurrectionRunner` leaves the
   * ledger record alone when it REFUSES an agent — a retire is durable, and its own comments say
   * refused agents "stay due" — so an agent that is permanently unfit (no project row), in an
   * abandoned cohort, or blocked by the mounted-pane ceiling stays "pending" for the life of the
   * run. Without a bound, its bead is renewed forever and worked by nobody: the head-of-line block
   * again, wearing the safest-looking clause in the file.
   *
   * So the hold is a WINDOW, not a promise. Inside it the claim is renewed and no duplicate can be
   * spawned; at the edge it is released and the bead returns to the backlog. That makes the
   * correctness of `resurrectionPending` non-critical in the direction that parks work — the
   * direction every previous round of this predicate got wrong.
   */
  deadAgentHoldMs: () => number;
  /**
   * TAKE OVER a claim left by a launch that is gone, WITHOUT spawning anything.
   *
   * The escape from a dilemma that has no safe horn. A foreign `dead-epoch` claim whose agent row
   * still exists is genuinely ambiguous — the row may be a ghost, or an agent the resurrection
   * runner is bringing back — and picking either answer ships a known defect: call it staffed and a
   * ghost parks the bead until the store's 7-day prune; call it free and the next pass spawns a
   * second agent onto a resurrected one.
   *
   * Adoption refuses the choice. The claim is `dead-epoch`, so the CAS grants it; taking it under
   * THIS window's claimant id makes it ours, and from the next pass the ordinary reconciliation
   * rules decide — the agent is gone, so release and re-staff, or it is alive, so renew. The
   * ambiguity lasts ONE pass instead of a week, and no second agent is started during it.
   */
  adoptClaim: (beadId: string, agentId: string) => Promise<void>;
  /**
   * START ONE AGENT on `bead`. Called at most `decision.spawnBudget` times per pass, and ONLY when
   * armed, and ONLY after the claim on that bead has been WON.
   *
   * Injected rather than imported so the disarmed path provably reaches no writer — the behavioural
   * ratchet in the suite asserts exactly that.
   *
   * A `refused` return is PROOF OF NON-CREATION and the claim is released; a THROW is ambiguous,
   * because the call does real work before it can fail, so the claim is KEPT (unbound, and therefore
   * unrenewed, so it expires on its own rather than parking the bead forever).
   */
  spawn: (bead: NextReadyBead) => SpawnResult;
  /**
   * RECORD THE INTENT BEFORE THE ATTEMPT. Called immediately before the claim and the spawn, never
   * after either.
   *
   * The 236-write incident was recoverable ONLY because every write had been journalled first. That
   * property is worth more than the ordering costs: a journal entry with no agent behind it is a
   * readable over-count — and with the claim now ahead of the spawn there is a second write to
   * account for, so the line has to precede both.
   */
  journal: (bead: NextReadyBead, index: number, of: number) => void;
}

/**
 * HOW MANY AGENTS ONE ARMED PASS MAY START when nothing is pushing back and the fleet is at or above
 * its floor.
 *
 * PHASE 2 SHIPPED THIS AS 1, AND SAID WHY: `decideAutoscale` names a single next bead, and the
 * de-duplication was a `Set` in one window's heap, so anything higher handed the same bead to every
 * agent it started. Phase 3 replaced that set with a durable compare-and-set, so the pass now
 * selects the ready column MINUS what is claimed and re-selects after each win — N spawns in one
 * pass name N DIFFERENT beads, and the suite proves it rather than asserting it.
 *
 * THREE, not ten, and the number is a pace rather than a limit. Every spawn is a real Claude Code
 * process with its own heap; `target` and the machine-wide ceiling already bound the fleet's SIZE,
 * so this bounds only how fast it gets there. A minute between passes with three per pass reaches a
 * ten-agent fleet inside four minutes, which is fast enough that nobody is waiting on the ramp, and
 * slow enough that a misconfiguration is visible for several minutes before it is expensive.
 */
export const AUTOSCALE_MAX_SPAWNS_PER_PASS = 3;

/**
 * The cap while the machine is pushing back (`backpressure === "throttle"`). ONE — the loop keeps
 * making progress, at the most conservative rate it has, and does not burst.
 *
 * Deliberately NOT zero. A squeezed machine is not a stopped one, and `hold` already exists for the
 * case where adding is genuinely wrong; collapsing `throttle` into `hold` would make a `warn`-level
 * memory sample indistinguishable from a critical one and stall a never-idle fleet on a transient.
 */
export const AUTOSCALE_THROTTLED_SPAWNS_PER_PASS = 1;

/**
 * How long a bead is held for a dead-but-resurrectable agent: **45 minutes**.
 *
 * Bounded above by what a never-idle backlog can tolerate sitting unworked, and below by the claim
 * store's own 30-minute expiry — the hold has to outlast that, or the claim would lapse underneath
 * it and the bound would never be the thing deciding.
 *
 * IT DOES NOT COVER EVERY RESURRECTION. A session wall can be hours away, so an agent revived after
 * this window finds its bead re-staffed. That is a stated, bounded residual rather than an unknown:
 * the alternative is holding a bead out of the backlog for a whole wall period on the evidence that
 * something MIGHT come back to it, which is the stall this epic is named for. Narrowing it further
 * needs the resurrector to publish its own verdict (abandoned / unfit / exhausted) rather than a
 * due-now list, which is follow-up work and not this bead's.
 */
export const AUTOSCALE_DEAD_AGENT_HOLD_MS = 45 * 60 * 1000;

/**
 * THE POLICY, kept apart from the arithmetic — `min(target, cap)`, where the cap is the per-pass
 * number widened by the floor shortfall and narrowed by backpressure.
 *
 * Exported and pure so the pacing rules can be asserted directly, without a board, a store or a
 * clock, and so a mutation to either direction has somewhere to be caught.
 */
export function spawnBudgetFor(
  target: number | null,
  floorDeficit: number,
  backpressure: Backpressure,
): number {
  // An unreadable board yields no budget at all. `null` is "we do not know whether there is work",
  // which is a DIFFERENT FACT from "there is none", and a spawn against it is a spawn against an
  // unknown backlog.
  if (target === null) return 0;
  if (backpressure === "hold") return 0;
  const cap =
    backpressure === "throttle"
      ? // THE FLOOR DOES NOT BURST PAST BACKPRESSURE. A floor keeps the fleet fed; it is not a
        // licence to feed it faster than the machine can carry, and letting it win here would make
        // the one setting a human reaches for during a stall the one that makes a squeeze worse.
        AUTOSCALE_THROTTLED_SPAWNS_PER_PASS
      : Math.max(AUTOSCALE_MAX_SPAWNS_PER_PASS, floorDeficit);
  return Math.max(0, Math.min(target, cap));
}

/** The last decision computed in this window, for a surface that wants to render it. Read-only
 *  bookkeeping; nothing acts on it. `null` before the first pass, or in a non-owning window. */
let lastDecision: AutoscaleDecision | null = null;
let lastReport: { fingerprint: string; at: number } | null = null;

/**
 * SINGLE FLIGHT. One pass of this window at a time, and the latch is in the CALLEE for the same
 * reason the arming gate is: a latch at the call site is a latch the next caller skips.
 *
 * MAKING THE PASS ASYNC REMOVED THE SERIALIZATION IT USED TO HAVE FOR FREE. The synchronous sweep
 * could not overlap itself; this one can, and the claim store gives no protection between two passes
 * of the SAME window — `acquire_at` grants a re-acquire by the same claimant id (that idempotence is
 * deliberate and tested), and `claimedByAnyone`/`attempted` are per-pass locals. So pass B reading
 * the claim listing before pass A commits its CAS selects the same bead, is GRANTED it, and spawns a
 * duplicate. The overlap is not hypothetical: reconciliation issues one round trip PER CLAIM WE
 * HOLD, serially, and each one can wait up to `FLOCK_ATTEMPTS × FLOCK_RETRY_MS` (2s) on a `flock`
 * contended by a second instance — a few dozen claims under contention exceed the 60s interval.
 *
 * A SKIPPED PASS RETURNS `null`. There is nothing new to report and the next tick is a minute away.
 */
let passInFlight = false;

/**
 * WHEN THIS WINDOW FIRST SAW each held bead's agent dead — the start of its hold window.
 *
 * Keyed by bead rather than by agent because the bead is what is being held, and cleared the moment
 * the claim is released or the agent is seen alive again, so a revived agent gets a fresh window if
 * it dies twice.
 */
const deadSince = new Map<string, number>();

/**
 * SHOULD THIS BEAD STILL BE HELD for an agent this window watched exit?
 *
 * Yes while resurrection is coming for it AND the hold window has not run out. The window opens the
 * first pass we see the agent dead, so a claim taken long ago does not start already expired.
 *
 * Shared by the selection filter and reconciliation on purpose — if the two derived it separately
 * they could disagree about one bead within a single pass, which is held and re-staffed at once.
 */
function holdsBeadWhileDead(
  deps: BacklogAutoscalerDeps,
  beadId: string,
  agentId: string,
  now: number,
): boolean {
  if (!deps.resurrectionPending(agentId)) {
    deadSince.delete(beadId);
    return false;
  }
  const since = deadSince.get(beadId);
  if (since === undefined) {
    deadSince.set(beadId, now);
    return true;
  }
  // `>=`, so a hold exactly at the bound is over: this is a ceiling on how long work may sit
  // unstaffed, and ties go to the backlog rather than to the incumbent — the opposite of the claim
  // store's tie rule, and for the opposite reason.
  if (now - since >= deps.deadAgentHoldMs()) {
    deadSince.delete(beadId);
    return false;
  }
  return true;
}

export function lastAutoscaleDecision(): AutoscaleDecision | null {
  return lastDecision;
}

/** Test seam: module state survives across cases otherwise, and a stale throttle silences the
 *  next case's report. */
export function _resetBacklogAutoscalerForTests(): void {
  lastDecision = null;
  lastReport = null;
  passInFlight = false;
  deadSince.clear();
}

/**
 * HOUSEKEEPING — release the claims that are finished, renew the ones that are still working.
 *
 * THIS IS THE HALF THAT KEEPS THE LOOP ALIVE, and it is worth being explicit about which failure
 * each branch prevents, because they pull in opposite directions and this epic has already shipped
 * a fix for one that caused the other (roborev 80561: a double-spawn fix that was a head-of-line
 * block — one agent for the life of the window, then permanent idleness, with its own test pinning
 * the stall as the intent).
 *
 *   * **The bead left the ready column** → RELEASE. The work moved on; holding the claim buys
 *     nothing and the store would grow without bound.
 *   * **The agent we started is gone from the fleet** → RELEASE, immediately, rather than waiting
 *     out the expiry. The bead is still ready and nobody is working it, which on a never-idle epic
 *     is exactly the state to correct.
 *   * **The agent is still in the fleet** → RENEW. Without this a live agent's bead expires at the
 *     backstop and a second window double-books it.
 *   * **The claim has no agent yet** → LEAVE IT ALONE. That state is normally seconds long (the
 *     spawn binds the id in the same pass); when it outlives a pass, the spawn threw and we cannot
 *     prove whether an agent exists. Not renewing lets it expire on its own — bounded, and the only
 *     honest answer to an ambiguous write.
 *
 * IT RUNS OVER OUR CLAIMS AT EVERY STANDING, NOT ONLY THE LIVE ONES, and that is a correction to
 * the obvious shape rather than a detail. Filtering on `standing === "live"` leaves an own claim
 * that has gone `dead-stale` WHILE ITS AGENT IS STILL RUNNING in the worst possible state: never
 * renewed (so it stays stale), never released, and — because the selection filter used the same
 * `live` test — back in the candidate pool. The pass then re-claims it, which `acquire_at` grants as
 * a takeover of our own dead claim AND which drops the recorded `agentId`, and starts a second agent
 * on a bead the first is still working. Three ordinary paths reach that state with the process alive
 * and its agent rows intact: the machine SLEEPS (a `setInterval` does not fire across system sleep,
 * so a closed lid overnight stales every claim at once), a human DISARMS and re-arms half an hour
 * later (reconciliation sits below the arming gate, so a disarmed window renews nothing), and
 * project ownership MOVES between windows (`ownsProject()` ends the pass before this runs). A
 * heartbeat recovers a stale own claim outright — `heartbeat_at` matches on claimant and epoch, not
 * on standing — so the fix is simply to look.
 *
 * AN UNREADABLE BOARD SUPPRESSES ONLY THE FIRST RULE. "I could not read the ready column" is not
 * "the ready column is empty", and releasing every claim on that reading would hand the whole
 * in-flight fleet's beads back to the next pass.
 *
 * RETURNS WHAT IT RELEASED, and that return value is load-bearing rather than informational. The
 * claim listing this pass is working from was taken BEFORE any of these releases, so a bead freed
 * here is still marked claimed in that snapshot; without subtracting it, a bead whose agent has
 * just died stays excluded from selection for the whole pass and is only re-staffed a minute later.
 * On a never-idle loop that is a minute of a free slot sitting against ready work for no reason —
 * and the shape is worth naming, because a stale snapshot re-read as fact is how the head-of-line
 * block got in last time.
 */
async function reconcileOwnClaims(
  deps: BacklogAutoscalerDeps,
  board: { boardReadable: boolean; readyBacklog: readonly Bead[] },
  claims: BeadClaimsReading,
  liveAgents: ReadonlySet<string>,
): Promise<{ released: ReadonlySet<string>; adopted: ReadonlySet<string> }> {
  const me = deps.claimantId();
  const ready = new Set(board.readyBacklog.map((b) => b.id));
  const released = new Set<string>();
  const adopted = new Set<string>();
  for (const view of claims.claims) {
    const beadId = view.claim.beadId;
    if (view.claim.claimantId !== me) {
      // NOT OURS. Normally untouched — but a `dead-epoch` claim's holder is PROVABLY gone (an
      // `epoch_is_alive` verdict, not a timeout), so nobody is coming back to reconcile it, and a
      // claim nobody owns and nobody can release is the 7-day park. Adopt the ambiguous ones: the
      // agent row still exists, and this window cannot see whether a process is behind it. Adoption
      // spawns nothing; it just makes the claim ours so the rules above govern it from next pass.
      //
      // An agent we can SEE running needs no adoption — the selection filter already excludes it and
      // its own window is renewing it. One we can see is EXITED needs none either: that bead is
      // unstaffed and selection will take it.
      const foreignAgent = view.claim.agentId;
      if (
        view.standing === "dead-epoch" &&
        foreignAgent !== null &&
        deps.processAlive(foreignAgent) === undefined &&
        liveAgents.has(foreignAgent)
      ) {
        await deps.adoptClaim(beadId, foreignAgent);
        adopted.add(beadId);
      }
      continue;
    }
    if (board.boardReadable && !ready.has(beadId)) {
      await deps.releaseClaim(beadId);
      released.add(beadId);
      continue;
    }
    const agentId = view.claim.agentId;
    if (agentId === null) continue;
    // SAME ORDERING OF EVIDENCE AS THE SELECTION FILTER, and it has to be the same or the two
    // disagree about one bead: a process we can see EXITED is the strongest unstaffed signal there
    // is and outranks the row's continued existence.
    const alive = deps.processAlive(agentId);
    // A LIVE AGENT CLOSES ANY OPEN HOLD WINDOW, so an agent that dies, is revived, and dies again
    // gets a fresh window rather than inheriting the first one's remaining time.
    if (alive === true) deadSince.delete(beadId);
    // SAME HELPER AS THE SELECTION FILTER, and it must be the same one or the two disagree about a
    // bead inside a single pass — renewed by reconciliation and re-staffed by selection.
    const goneForGood = alive === false && !holdsBeadWhileDead(deps, beadId, agentId, deps.now());
    if (goneForGood || !liveAgents.has(agentId)) {
      await deps.releaseClaim(beadId);
      released.add(beadId);
      deadSince.delete(beadId);
      continue;
    }
    // UNWITNESSED WITH THE ROW STILL PRESENT: renew. THE COST IS STATED RATHER THAN HIDDEN — an
    // ADOPTED claim whose agent turns out to have been a ghost keeps its bead out of selection for
    // as long as that row survives (until the resurrection runner gives up on it, or a human closes
    // the pane). That is a bounded park, it is visible in the log as a renewal of an adopted claim,
    // and it is the direction that CANNOT produce a duplicate. The other direction — releasing on a
    // reading that means "I cannot see this agent" — spawns a second agent onto every resurrected
    // one after a restart, across the whole board at once. Between a bounded delay and a duplicate
    // fleet, this loop takes the delay.
    await deps.heartbeatClaim(beadId, agentId);
  }
  return { released, adopted };
}

/**
 * ONE PASS: gather, decide, report — and, when armed, reconcile the claim store and take work.
 *
 * ASYNC BECAUSE THE CLAIM IS. The compare-and-set lives in Rust behind a Tauri command, and its
 * verdict has to be in hand BEFORE the spawn or it is not a claim at all. A synchronous
 * fire-and-forget claim would be a log line, not a lock.
 *
 * Returns the decision — or `null` when this window does not own the project, or when a previous
 * pass is still in flight (see [`passInFlight`]) — so a test asserts the COMPUTED NUMBERS rather
 * than that the function ran.
 */
export async function sweepBacklogAutoscaler(
  deps: BacklogAutoscalerDeps,
): Promise<AutoscaleDecision | null> {
  if (!deps.ownsProject()) return null;
  if (passInFlight) {
    log.info("backlog-autoscaler", "a pass is still in flight — skipping this tick", {});
    return null;
  }
  passInFlight = true;
  try {
    return await runOnePass(deps);
  } finally {
    // `finally`, so a throw out of the pass does not wedge the loop for the life of the window.
    // Every other guard here fails closed; this one must fail OPEN, because a latch that is never
    // released is permanent idleness — the failure this epic keeps rediscovering.
    passInFlight = false;
  }
}

/** The body of one pass. Split out only so the latch above can wrap it in a `finally`. */
async function runOnePass(deps: BacklogAutoscalerDeps): Promise<AutoscaleDecision | null> {
  const board = deps.readBoard();
  const decision = decideAutoscale({
    boardReadable: board.boardReadable,
    readyBacklog: board.readyBacklog,
    capacity: deps.readCapacity(),
    floor: deps.floor(),
    backpressure: backpressureFor(deps.readMemoryAdmission()),
  });
  lastDecision = decision;
  const now = deps.now();
  if (shouldReportAutoscale(lastReport, decision, now)) {
    deps.report(decision);
    lastReport = { fingerprint: autoscaleFingerprint(decision), at: now };
  }

  // ── EVERYTHING BELOW THIS LINE WRITES ────────────────────────────────────────────────────────
  //
  // Above it the pass computes and logs, exactly as the dry-run phase did, and that is the
  // contract: DISARMED, this function touches no store, takes no claim, journals nothing and starts
  // no agent. The claim store is a write like any other and gets the same gate — reconciling it
  // from a disarmed window would be a file this build was never authorised to touch.
  if (!deps.isArmed()) return decision;

  // THE CLAIM STORE IS READ BEFORE ANYTHING IS DECIDED ABOUT WORK, and an unreadable one ends the
  // pass. UNKNOWN IS NOT FREE: a spawn issued here cannot know whether a peer window is already on
  // this bead, which is the whole of what Phase 3 buys.
  const claims = await deps.readClaims();
  if (!claims.readable) {
    log.warn(
      "backlog-autoscaler",
      "ARMED, but the durable claim store could not be read — starting nothing this pass",
      { target: decision.target, spawnBudget: decision.spawnBudget },
    );
    return decision;
  }

  // Read ONCE per pass and shared by reconciliation and selection, so the two cannot disagree about
  // which agents exist — a bead excluded from selection for naming a live agent, by a pass that then
  // released its claim for naming a dead one, would be neither staffed nor available.
  const liveAgentIds = deps.liveAgentIds();

  // Housekeeping runs BEFORE the budget checks and regardless of them. A machine at capacity still
  // has to release the claims whose work has finished, or the next pass with a free slot finds a
  // board that looks entirely claimed.
  const { released: releasedThisPass, adopted: adoptedThisPass } = await reconcileOwnClaims(
    deps,
    board,
    claims,
    liveAgentIds,
  );

  // THE ORDER OF THESE GUARDS IS THE SAFETY ARGUMENT:
  //   * `target === null` is NOT folded into the `<= 0` test. `null` is "the board could not be
  //     read", a DIFFERENT FACT from "there is no work", and conflating them is the P0 this decision
  //     type was shaped to prevent.
  //   * `spawnBudget` carries the arming-independent policy — the cap, the floor and backpressure —
  //     so `hold` and a full machine both land here rather than being re-derived in the loop.
  if (decision.target === null || decision.spawnBudget <= 0) return decision;

  // SUPPRESS AT SELECTION, NOT AT THE GATE — the distinction is the whole of this block.
  //
  // Testing "is the head of the ready column claimed?" and returning is a HEAD-OF-LINE BLOCK, not a
  // de-duplication: `selectNextReadyBead` always returns the TOP of the column and nothing here
  // moves a bead out of it (`spawnBuildAgentInProject` never touches the target's status). After one
  // spawn every later tick would re-select the same bead, hit the guard and return — one agent for
  // the life of the window, then permanent idleness, against a machine with free slots and fifty
  // ready beads. That shipped once and its own test pinned the stall as the intent (roborev 80561).
  //
  // Selecting from the ready column MINUS what is claimed keeps the de-duplication and keeps the
  // loop moving: the claimed bead is never picked, and the next one is.
  // WHAT COUNTS AS TAKEN. Two independent facts, and the second is not redundant:
  //
  //   * the claim is LIVE — somebody has asserted recently that they are on this bead; or
  //   * the claim NAMES AN AGENT THAT IS STILL IN THE FLEET — which is stronger evidence than any
  //     timestamp. A bead whose claim points at a running agent is STAFFED, whatever a heartbeat
  //     says, and re-staffing it is the duplicate this whole phase exists to prevent. Standing
  //     alone misses it after a machine sleep, an arm/disarm cycle, or an ownership handover, none
  //     of which stop the agent — and it misses it for a PEER's claims too, which reconciliation
  //     deliberately never touches.
  //
  // ...AND "IN THE FLEET" MEANS THE PROCESS, NOT THE ROW. This module has been wrong here twice in
  // opposite directions, so the ordering of evidence is written out rather than implied:
  //
  //   1. `processAlive === true` — the agent is RUNNING, and that outranks the claim's standing
  //      completely. It is what covers an agent `resurrectionRunner` brought back after a restart:
  //      revival remounts under the SAME row id, so the old claim stays `dead-epoch` forever
  //      (reconciliation skips foreign claims, nothing heartbeats it) while a real agent works the
  //      bead. Treating standing as decisive there spawns a second agent onto it, across the whole
  //      previous board at once, on the most common lifecycle event there is.
  //   2. `processAlive === false` — the process has provably EXITED. That is the strongest evidence
  //      available that the bead is unstaffed, and it beats the row's continued existence.
  //   3. `undefined` — this window does not witness the agent, which is NEITHER of the above. Here
  //      the row is the only evidence there is, and it is weak: rows are rehydrated from the
  //      persisted project blob, so after a restart every id the previous launch minted is still
  //      present whether or not anything is running. A LIVE-launch claim (`live`, `dead-stale`) is
  //      still trusted — that is the sleeping-window case, whose agents really are running. A
  //      `dead-epoch` one is not trusted, and it is not treated as free either: `reconcileOwnClaims`
  //      ADOPTS it, so the ambiguity resolves next pass instead of parking the bead for a week.
  //
  // The listing is from BEFORE reconciliation, so anything just released is still marked claimed in
  // it. Subtracting keeps a bead whose agent has just died available to THIS pass rather than the
  // next one.
  // One clock read for the whole pass, so selection and the hold window cannot straddle a tick.
  const passNow = deps.now();
  const staffedByALiveAgent = (v: BeadClaimView): boolean => {
    const agentId = v.claim.agentId;
    if (agentId === null) return false;
    const alive = deps.processAlive(agentId);
    // A WITNESSED EXIT IS ONLY TERMINAL ONCE RESURRECTION IS NOT COMING — `processAlive === false`
    // is the resurrector's input domain, not a verdict against the bead — AND ONLY WITHIN THE HOLD
    // WINDOW, because "pending" never expires on its own for an agent the runner has refused.
    if (alive === false) return holdsBeadWhileDead(deps, v.claim.beadId, agentId, passNow);
    if (alive === true) {
      // A LIVE AGENT CLOSES ANY OPEN HOLD WINDOW — here as well as in reconciliation, because this
      // filter is the only reader that sees a PEER's claims. A peer's agent that died, was revived
      // and died again would otherwise inherit the first window and lose its bead early.
      deadSince.delete(v.claim.beadId);
      return true;
    }
    return v.standing !== "dead-epoch" && liveAgentIds.has(agentId);
  };
  const claimedByAnyone = new Set(
    claims.claims
      .filter((v) => v.standing === "live" || staffedByALiveAgent(v))
      .map((v) => v.claim.beadId)
      .filter((id) => !releasedThisPass.has(id)),
  );
  // A BEAD ADOPTED THIS PASS IS NOT SELECTABLE THIS PASS. Adoption is us taking responsibility for
  // an ambiguous claim, not declaring the bead free — spawning onto it in the same pass would be the
  // double-book with an extra step. The next pass decides it on the ordinary rules.
  for (const id of adoptedThisPass) claimedByAnyone.add(id);
  const attempted = new Set<string>();
  let started = 0;
  while (started < decision.spawnBudget) {
    const candidate = selectNextReadyBead(
      board.readyBacklog.filter((b) => !claimedByAnyone.has(b.id) && !attempted.has(b.id)),
    );
    // Every ready bead is already claimed, or already tried this pass. A real steady state, not an
    // error: it is what a fully-staffed backlog looks like.
    if (candidate === null) break;
    attempted.add(candidate.id);

    // JOURNALLED BEFORE EITHER WRITE — the claim and the spawn both follow this line, never precede
    // it. A journal entry with no agent behind it is a readable over-count; an agent with no journal
    // entry is one nobody can account for.
    deps.journal(candidate, started, decision.spawnBudget);

    // THE COMPARE-AND-SET, and its verdict is what authorises the spawn. The listing above is a
    // SNAPSHOT — a peer window may have won this bead in the milliseconds since — so a lost race
    // here is ordinary and the pass simply moves to the next bead rather than giving up. `unknown`
    // and `invalid` land in the same branch on purpose: neither is permission to start an agent.
    //
    // A LOST RACE DOES NOT SPEND THE BUDGET — `started` is only incremented by an agent that really
    // exists — so the pass tries the next bead instead of coming up short by however many races it
    // lost. It cannot spin: `attempted` grows on every iteration and the candidate pool is the
    // finite ready column, so the loop ends at the budget or when the column is exhausted.
    const outcome = await deps.claimBead(candidate);
    if (!outcome.acquired) continue;

    const result = deps.spawn(candidate);
    if (result.outcome === "refused") {
      // A refusal PROVES nothing was created — the callee's four refusal paths each say so — and
      // every one of its causes clears on its own (at capacity now, a project not opened YET). So
      // the claim goes back rather than retiring real work on a transient condition.
      await deps.releaseClaim(candidate.id);
      continue;
    }
    started += 1;
    // BIND THE AGENT TO THE CLAIM. Until this lands the claim carries no agent, and an unbound claim
    // is never renewed — so failing to bind costs at most one expiry window, never a parked bead.
    await deps.heartbeatClaim(candidate.id, result.agentId);
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
  // Read per pass, so editing `[autoscaler].floor` and reloading config takes effect on the next
  // tick rather than on the next launch.
  floor: () => useSettingsStore.getState().autoscalerFloor,
  // `currentMemoryAdmissionReading()` wraps the admission with the resident count and a sequence
  // number that identify WHICH reading it is; this module needs only the admission itself, and
  // `?? null` keeps the "no basis to narrow" case as the null `backpressureFor` already handles.
  readMemoryAdmission: () => currentMemoryAdmissionReading()?.admission ?? null,
  // The whole reporting side effect: one log line a human can read. `log.info` and not `warn` — a
  // measurement is not a fault, and a warn-level line every heartbeat would train people to filter
  // out the surface this feature exists to create.
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
      floor: d.floor,
      floorDeficit: d.floorDeficit,
      backpressure: d.backpressure,
      spawnBudget: d.spawnBudget,
    }),
  now: () => Date.now(),
  // FAIL-CLOSED BY CONSTRUCTION: the store ships `autoscalerArmed: false` and the config reader
  // defaults a missing `[autoscaler].armed` to false, so every way of NOT deciding lands on "do not
  // write". `=== true` rather than a truthiness test, so an undefined slice (a store shape older
  // than this field, which a persisted rehydration can produce) cannot arm it.
  isArmed: () => useSettingsStore.getState().autoscalerArmed === true,
  claimantId: mintAutoscalerClaimantId,
  readClaims: listAutoscalerClaims,
  claimBead: (bead) => acquireBeadClaim(bead.id),
  heartbeatClaim: heartbeatBeadClaim,
  releaseClaim: releaseBeadClaim,
  // `used`, not `live`: the same population `AUTOSCALE_POPULATION` counts. `live` excludes rows in
  // a project tab the human has not opened this session — which is a statement about panes, not
  // about whether the agent exists — and releasing a claim on that reading would double-book the
  // bead of every agent sitting in an unvisited tab.
  liveAgentIds: () => new Set(localAgentRowIds().used),
  // The app's only real death signal, and three-valued on purpose — see the dep's own note.
  processAlive: processAliveOf,
  // The WINDOW-LOCAL death record, not the durable due-now mirror: `revival_due` omits an agent for
  // the whole of its backoff, and a wall death's backoff is hours. See the dep's own note.
  resurrectionPending: (agentId) => {
    const cause = deathCauseForAgent(agentId);
    return cause !== undefined && isResurrectable(cause);
  },
  deadAgentHoldMs: () => AUTOSCALE_DEAD_AGENT_HOLD_MS,
  adoptClaim: async (beadId, agentId) => {
    const outcome = await acquireBeadClaim(beadId);
    if (!outcome.acquired) return;
    await heartbeatBeadClaim(beadId, agentId);
    log.info("backlog-autoscaler", "adopted a claim left by a launch that is gone", {
      bead: beadId,
      agent: agentId,
    });
  },
  // JOURNAL BEFORE EITHER WRITE — never after. The 236-write incident was recoverable only because
  // every write had been journalled first, and this is the cheap half of that lesson.
  journal: (bead, index, of) =>
    log.info("backlog-autoscaler", `ARMED: about to claim and spawn ${index + 1}/${of} on ${bead.id}`, {
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
      return { outcome: "refused" };
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
      return { outcome: "refused" };
    }
    log.info("backlog-autoscaler", "spawned", { bead: bead.id, agent: id });
    return { outcome: "spawned", agentId: id };
  },
};

/** Matches the drain bridge's cadence — the same 60s tick the rest of the fleet plumbing runs on. */
export const BACKLOG_AUTOSCALER_SWEEP_MS = 60_000;

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the sweep. Returns a stop function; safe to call twice (the second is a no-op).
 *
 * THE PASS IS ASYNC NOW, so the tick fires it and forgets it — no single-flight latch, because the
 * awaits inside are a store read and, at most, a handful of small file operations behind a lock
 * that already serialises them. Ownership is re-read per tick inside the pass.
 *
 * A REJECTION IS SWALLOWED HERE, and it must be: an unhandled rejection out of a `setInterval`
 * callback is an unhandled rejection for the process, and a claim store on a full disk would take
 * the window down rather than skipping a minute of autoscaling.
 */
export function startBacklogAutoscaler(deps: BacklogAutoscalerDeps = PRODUCTION_DEPS): () => void {
  if (timer !== null) return () => {};
  const tick = (): void => {
    // No latch here: `sweepBacklogAutoscaler` owns it, so every caller gets it — including a future
    // one that is not this timer.
    void sweepBacklogAutoscaler(deps).catch((e: unknown) => {
      log.warn("backlog-autoscaler", "pass threw", { error: String(e) });
    });
  };
  tick();
  timer = setInterval(tick, BACKLOG_AUTOSCALER_SWEEP_MS);
  return () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };
}
