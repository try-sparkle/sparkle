// epicSweepRunner — THE MOUNT for `engine/epicContinuation`: it reads the board and the agent
// roster, asks the pure engine what to do about each epic, and performs the one side effect.
//
// The engine is pure and knows nothing about stores, agents or timers. This module is the half that
// SPENDS something — an agent slot, a bd write, a line in the founder's concierge — so every
// dependency arrives injected and every rule stays testable without a real project. Same split as
// `services/goalContinuationRunner`, `services/resurrectionRunner` and `services/apiRecoveryRunner`,
// and modelled on the first throughout: the same `ownsProjectInThisWindow` election, the same
// never-throws contract, the same re-entrancy guard, and the same "return outcomes so tests assert
// DECISIONS rather than spies".
//
// ── WHAT IT IS FOR ───────────────────────────────────────────────────────────────────────────
// A build agent is handed an epic, decomposes it into child beads, and stops. The plan is complete
// and nobody is carrying it. Today nothing notices, so the epic sits until the founder happens to
// remember it. This sweep notices, hands it to a build agent once, and — if that bought nothing —
// stops and puts it in front of him rather than looping.
//
// ── THE THREE THINGS THAT KEEP IT FROM RUNNING AWAY ──────────────────────────────────────────
// This module can start agents, in an app where the founder spent a whole session RETIRING twenty
// of them to reclaim capacity. So the bounds are not incidental:
//   1. THE WATCH SET is "epics he has promoted to Build at least once" (`engine/epicContinuation`'s
//      `promoted` gate). The store holds 39 epics, 15 of them already past the stall line, and
//      thousands of retro beads besides; none are candidates until he hands one over himself.
//   2. ONE RESTART PER STALL, decided by the engine from two timestamps that outlive the app — the
//      newest child `updatedAt`, and a `sweep-restarted:<ms>` label THIS SWEEP writes. An in-memory
//      counter would have re-granted a restart on every app relaunch, and reading a bound agent's
//      `createdAt` instead never advances at all, because `sendToBuild` REUSES that agent.
//   3. ONE RESTART PER SWEEP PER PROJECT (`MAX_RESTARTS_PER_SWEEP` below). Even if ten epics
//      qualify at once, this tick starts one. Ten agents appearing while he is not looking is not a
//      recovery, and the rest are still there next tick.
//
// ── NO MODEL CALL ON ANY PATH ────────────────────────────────────────────────────────────────
// A fleet-wide wall gates every LLM in the app behind one account limit, so a recovery path that
// consults one is dead exactly when it is needed. This sweep is timestamp comparisons, one store
// read, and at most one handoff.
import {
  childrenOf,
  commentBead,
  isAutoRestartOptedOut,
  isEpic,
  isPromotedToBuild,
  labelBead,
  sweepRestartedAt,
  NO_AUTO_RESTART_LABEL,
  PROMOTED_LABEL,
  STALLED_LABEL,
  SWEEP_NO_AUTO_LABEL,
  SWEEP_RESTART_PREFIX,
  type Bead,
} from "./beads";
import { epicStatus } from "./planView";
import {
  loadEpicPrdIndex,
  resolveEpicPrdPath,
  type EpicPrdIndex,
} from "./epicPrd";
import { useBeadsStore } from "../stores/beadsStore";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { sendToBuildAwaited, didRelaunch, AtCapacityError, type BuildHandoff } from "./sendToBuild";
import { conciergeNotifierAvailable, notifyConcierge } from "./conciergeNotifier";
import { processAliveFor, ownsProjectInThisWindow } from "./goalContinuationRunner";
import {
  decideEpicSweep,
  EPIC_HOLLOW_SETTLE_MS,
  EPIC_MAX_STALL_AGE_MS,
  EPIC_STALL_MS,
  type EpicSweepCandidate,
  type EpicSweepDecision,
} from "../engine/epicContinuation";
import { DECOMPOSE_REQUESTED_LABEL } from "./epicDecompose";
import {
  isDecomposeRequested,
  isInDecomposePipeline,
  requestDecomposeMessage,
  requestDecomposeNote,
} from "./epicDecomposeRequest";
import type { AgentTab } from "../types";
import { log } from "../logger";

/** How often the sweep runs. Slow on purpose: the thing it detects is measured in hours, so a tick
 *  every ten minutes is already far finer than the two-hour window it judges against, and each tick
 *  reads the store rather than shelling out. */
export const EPIC_SWEEP_INTERVAL_MS = 10 * 60 * 1000;

/**
 * At most one epic is restarted per sweep, per project.
 *
 * A cap of one is not timidity — it is the difference between a recovery and a surprise. If a
 * project has been closed for a week, several epics can cross the stall line on the SAME tick, and
 * starting all of them would consume the agent capacity the founder had just reclaimed, all at
 * once, with no one watching. The others are not lost: they are still stalled next tick, ten
 * minutes later, and the engine's decision for them is unchanged.
 */
export const MAX_ACTIONS_PER_SWEEP = 1;

/** @deprecated Kept as the old name while callers migrate; it is the same bound.
 *  It was renamed because it no longer governs restarts alone — see {@link MAX_ACTIONS_PER_SWEEP}. */
export const MAX_RESTARTS_PER_SWEEP = MAX_ACTIONS_PER_SWEEP;

/**
 * IS THE AUTOMATIC RESTART LIVE? YES, since bead sparkle-7d3985. The relaunch-and-deliver
 * mechanism it was waiting on now exists.
 *
 * ── WHAT IT DOES ─────────────────────────────────────────────────────────────────────────────
 * A promoted epic whose plan was written and then abandoned gets its orchestrator relaunched and
 * the epic handed back to it — ONCE. If that restart buys nothing, the next stall ESCALATES: the
 * epic is marked, moved to the Blocked lane and put in front of the founder, and this sweep does
 * not restart it again. One retry catches the common transient case (the agent died, the
 * orchestrator forgot); an unbounded restarter would burn agent slots on a genuinely broken epic,
 * which is the opposite of what the capacity work was for.
 *
 * ── THE FIVE DEFECTS THAT HAD TO BE FIXED FIRST, so nobody re-derives them ────────────────────
 * Eleven review rounds found a real defect apiece, in a different layer nearly every time. All are
 * closed; the notes survive because each one is a shape that reads as correct:
 *
 *   1. The restart budget could never be spent, so "restart once" never bound. Fixed by the
 *      `sweep-restarted:<epoch-ms>` label THIS sweep writes — reading the bound agent's `createdAt`
 *      does not work, because `sendToBuild` REUSES that agent so the timestamp never advances.
 *   2. Suppressing the view also suppressed the mount, so nothing was relaunched.
 *   3. `runtimeStore.open` is a provable no-op in exactly the state the sweep reaches. Fixed in
 *      `services/agentMount`, which is now the ONE implementation of "bring this agent back".
 *   4. `restartPane` returns a DISPATCH RECEIPT, not a result (`paneControl` says so in as many
 *      words). The sweep is precisely the caller that must not use it: it spends a one-shot budget
 *      and then tells a human. Fixed by `mountAgentAwaited`, which waits for the pane's own
 *      readiness verdict — reached here through `sendToBuildAwaited`.
 *   5. THE SEED WAS NEVER DELIVERED ON THE RESUME PATH, which made a "successful" restart inert.
 *      A restart resumes the session, so `briefForLaunch` returns `undefined` BY DESIGN and
 *      `appendPrompt` only writes a draft nobody reads. Fixed by delivering through the concierge
 *      dispatcher — the channel `goalContinuationRunner` and `fleetWatch` use — inside
 *      `sendToBuildAwaited`, which reports an undelivered send as a FAILURE rather than a handoff.
 *
 * ── WHAT THE FLAG STILL DOES ─────────────────────────────────────────────────────────────────
 * It remains the one switch. Set it to `false` and a `restart` decision is ESCALATED instead of
 * performed — never dropped, because a stalled epic with no signal at all is strictly worse than
 * what the founder had before. Such a stand-in escalation also carries `SWEEP_NO_AUTO_LABEL` so it
 * does not burn the restart it never received.
 */
export const RESTART_ENABLED = true;

/**
 * Is the sweep allowed to ASK for a hollow epic to be decomposed? Ships `true`.
 *
 * ── WHY IT HAS ITS OWN SWITCH AND NOT {@link RESTART_ENABLED}'s ───────────────────────────────
 * They bound different spends and they fail differently. `RESTART_ENABLED` governs starting an
 * AGENT — a slot out of a pool the founder spent a whole session reclaiming — and turning it off
 * degrades to an escalation, because a stalled epic with no signal at all is worse than what he had
 * before. This governs a PAID AI CALL fired by a later `epicDecompose` poll, and turning it off
 * degrades to nothing at all, because the epic is not stalled: it has never been planned, so there
 * is nothing to tell him that he cannot already see on the card.
 *
 * It is the kill switch for exactly one thing: "stop writing the opt-in label". Everything
 * downstream keeps its own gates — `epicDecompose` still refuses without the label and still checks
 * the master AI gate before and DURING its sweep.
 */
export const DECOMPOSE_REQUEST_ENABLED = true;

/**
 * How many times to try the best-effort audit note, and how long to pause between tries.
 *
 * SMALL and SHORT on purpose. This retry runs INSIDE the sweep loop, so a long one would stall the
 * whole fleet on a store that is only momentarily busy. A Dolt lock is transient — the store is a
 * single embedded database shared by every worktree and polled every five seconds, so a write that
 * loses the race clears within tens to low-hundreds of ms — and a couple of retries recover the
 * common case (~15 notes/day were being dropped on a single locked attempt) without turning
 * best-effort bookkeeping into a stall. Both are injectable via {@link EpicSweepOptions} so a test
 * drives the retry with no real timers.
 */
export const AUDIT_WRITE_ATTEMPTS = 3;
export const AUDIT_RETRY_BACKOFF_MS = 40;

/**
 * The lock/contention wordings that mean "the store was momentarily busy", so re-issuing the SAME
 * write is the right remedy.
 *
 * Mirrors `beads_cmd.rs`'s `STORE_BUSY_WORDINGS` — the clean-rejection family where bd gave up
 * BEFORE writing anything — plus the raw `locked by another dolt process` phrase bd/dolt can print
 * directly. Every entry can only be produced by the store being unavailable for the length of the
 * call, so a retry cannot duplicate a write. Deliberately NARROW: a `bd comment` has no idempotency
 * key, and a TIMEOUT leaves the write genuinely ambiguous (it may have committed in the instant
 * before the kill), so timeout wording is intentionally absent here and such an error is not retried.
 */
const LOCK_CONTENTION_WORDINGS: readonly string[] = [
  "locked by another dolt process",
  "context canceled",
  "context cancelled",
  "context deadline exceeded",
  "database is locked",
  "could not acquire lock",
  "failed to acquire lock",
  "lock is held",
  "database is in use",
];

/** Pull a message string out of any rejection shape: a plain string (the default `commentBead` path
 *  rejects with one — Tauri hands back the serialized value, not an `Error`), an `Error`, or a
 *  structured `BeadsError`-like object carrying `.message`. */
function auditErrorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object" && typeof (e as { message?: unknown }).message === "string") {
    return (e as { message: string }).message;
  }
  return String(e);
}

/**
 * Is this a TRANSIENT store-lock error — one that will clear on its own, so re-issuing the same
 * write is the right remedy?
 *
 * Matches the clean-rejection lock family only ({@link LOCK_CONTENTION_WORDINGS}). A non-lock error
 * (malformed input, bd missing) returns false, so the sweep does not spin on something a wait cannot
 * fix; and an ambiguous write TIMEOUT returns false too, so a retry cannot duplicate a note that may
 * already have landed.
 */
export function isTransientLockError(e: unknown): boolean {
  const lower = auditErrorText(e).toLowerCase();
  return LOCK_CONTENTION_WORDINGS.some((w) => lower.includes(w));
}

/** Non-blocking pause; resolves immediately for a non-positive duration so tests need no fake
 *  timers (`auditBackoffMs: 0`). */
function auditBackoff(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

/**
 * Write the durable audit note, retrying a TRANSIENT store lock up to `attempts` times.
 *
 * BEST-EFFORT BY CONTRACT — this NEVER throws. By the time it runs the restart has already happened
 * and is irreversible, so a persistently-locked store must not turn a real handoff into a reported
 * failure: on a clean exhaustion it logs the same warning the single-attempt version did and returns,
 * and the caller continues to notify the founder and record `restarted`.
 *
 * Retries ONLY a lock/contention error ({@link isTransientLockError}). A non-lock failure will not
 * clear by waiting, so it breaks out after the first attempt rather than spending the sweep's budget
 * on a doomed spin. The bound is hard — at most `attempts` tries — so a permanently locked store can
 * never wedge the loop.
 */
async function writeAuditNoteResilient(
  audit: (projectPath: string, epicId: string, text: string) => Promise<void>,
  projectPath: string,
  epicId: string,
  text: string,
  attempts: number,
  backoffMs: number,
): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await audit(projectPath, epicId, text);
      return;
    } catch (e) {
      lastErr = e;
      // Stop early on a non-lock error (a wait cannot fix it) or once the budget is spent — the
      // latter check also avoids a pointless final backoff after the last attempt.
      if (!isTransientLockError(e) || attempt === attempts) break;
      await auditBackoff(backoffMs);
    }
  }
  log.warn("epics", "restarted an epic but could not write its audit note", {
    epic: epicId,
    error: String(lastErr),
  });
}


/** What the sweep actually did about one epic — the decision plus its outcome. Returned rather than
 *  logged so tests assert on decisions instead of spying on side effects. */
export interface EpicSweepOutcome extends EpicSweepDecision {
  projectId: string;
  /** The action that was actually performed. Differs from `action` when the sweep was capped for
   *  this tick, or when a write failed — a decision is not a deed and the two must be legible
   *  apart. */
  performed: "restarted" | "escalated" | "cleared" | "decompose-requested" | "none";
  /**
   * Did the handoff actually RELAUNCH the orchestrator, or was it already running?
   *
   * Present only on a `restarted` outcome. Both spend the epic's one-shot budget — an epic handed
   * back is handed back either way, and re-poking a live orchestrator every ten minutes would be
   * worse than not watching it. But only one of them is a RESTART, and the notice and the durable
   * audit note both say so in words. Fixing the mount layer to stop reporting relaunches that did
   * not happen simply moved that falsehood up here until this field existed.
   */
  relaunched?: boolean;
  /** Why nothing was performed despite a non-skip decision. */
  note?: "capped" | "at-capacity" | "write-failed" | "spawn-failed" | "cannot-notify" | "disabled";
  /**
   * Did the founder actually GET the notice? Absent when none was owed.
   *
   * ── "TELL YOU" IS HALF THE REQUIREMENT, SO A DROPPED NOTICE IS A REAL OUTCOME ────────────────
   * The founder's instruction was "restart it, then tell you". `notifyConcierge` returns `false`
   * when the text was dropped — no sink registered in this window, a sink refusing at its ceiling,
   * or a throwing one — and its own header records why that distinction exists: treating "a sink
   * exists" as "the message was delivered" is what made findings die silently.
   *
   * Ignoring it here would mean the sweep restarts an agent, tells nobody, and reports `restarted`
   * — which is the same "reported success while doing nothing" shape three review rounds already
   * found in this file. It is recorded rather than retried because the restart has HAPPENED and its
   * marker is stamped: the next tick will escalate or skip, so there is no later sweep for the
   * notice to ride. Saying so truthfully is the honest option; claiming delivery is not.
   */
  noticed?: boolean;
}

export interface EpicSweepOptions {
  /** Injected clock, house style — so the staleness arithmetic needs no fake timers. */
  now?: number;
  /** Single-owner election. Defaults to {@link ownsProjectInThisWindow}; injected by tests. */
  ownsProject?: (projectId: string) => boolean;
  /** Stall window; defaults to the engine's {@link EPIC_STALL_MS}. */
  stallMs?: number;
  /** How far back the sweep reaches; defaults to {@link EPIC_MAX_STALL_AGE_MS}. */
  maxAgeMs?: number;
  /** Grace period before a CHILDLESS epic is asked about; defaults to the engine's
   *  {@link EPIC_HOLLOW_SETTLE_MS}. A separate window from `stallMs` — see that constant. */
  hollowMs?: number;
  /** May the sweep ask for a hollow epic to be decomposed? Defaults to
   *  {@link DECOMPOSE_REQUEST_ENABLED}, which ships `true`. Injected by tests so the OFF
   *  configuration — reachable in production if someone flips the constant — stays covered. */
  requestDecomposeEnabled?: boolean;
  /**
   * Is the automatic restart live? Defaults to {@link RESTART_ENABLED}, which now ships `true`.
   *
   * STILL INJECTABLE, for the mirror of the reason it was injectable while the flag was off: the
   * OFF configuration remains reachable in production (someone may flip it back), so its behaviour
   * — a `restart` decision becoming a stand-in escalation that does not burn the budget — needs
   * tests of its own. Deleting them to match the shipped value would leave that path unguarded.
   */
  restartEnabled?: boolean;
  /** Everything below is injected only by tests. Production takes the real stores. */
  projects?: { id: string; rootPath: string; agents: AgentTab[] }[];
  beadsFor?: (projectId: string) => Bead[] | null;
  aliveFor?: (agentId: string) => boolean | undefined;
  restart?: (projectId: string, epicId: string) => Promise<BuildHandoff>;
  /** The durable audit note. Defaults to a `bd comment` on the epic. Injected by tests, and
   *  best-effort in production — see the call site for why a failed note must not undo a restart. */
  audit?: (projectPath: string, epicId: string, text: string) => Promise<void>;
  /** Bounded, lock-aware retry for the best-effort audit note. `auditAttempts` is the TOTAL number
   *  of tries (default {@link AUDIT_WRITE_ATTEMPTS}); `auditBackoffMs` is the pause between them
   *  (default {@link AUDIT_RETRY_BACKOFF_MS}). Injected by tests to drive the retry with no real
   *  timers (`auditBackoffMs: 0`). See {@link writeAuditNoteResilient} for the contract. */
  auditAttempts?: number;
  auditBackoffMs?: number;
  mark?: (projectPath: string, action: "add" | "remove", epicId: string) => Promise<void>;
  /** The raw label write, used for the sweep's own restart marker. Separate from `mark` because
   *  `mark` names one fixed label and this one carries a timestamp in its value. */
  setLabel?: (
    projectPath: string,
    action: "add" | "remove",
    epicId: string,
    label: string,
  ) => Promise<void>;
  notify?: (text: string) => boolean;
  /** Can a notice reach the founder from THIS window at all? Defaults to the real probe. */
  canNotify?: () => boolean;
  /** id → PRD path for the beads carrying structured `prd` metadata, so the restart hands the
   *  resumed orchestrator the epic's PRD by path. Defaults to the real (cached, never-throwing)
   *  `loadEpicPrdIndex`; injected by tests. */
  prdIndexFor?: (projectPath: string) => Promise<EpicPrdIndex>;
}

/** Parse a bd ISO-8601 timestamp. Returns null on anything unreadable, which the engine then
 *  fail-closes on (`unknown-age`) rather than treating as old. */
function parseTs(iso: string | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/**
 * The newest moment any CHILD of this epic moved.
 *
 * CHILDREN ONLY, and that exclusion is load-bearing rather than tidy: escalating writes a label to
 * the EPIC, which bumps the epic's own `updatedAt`. If the epic counted, the sweep's own escalation
 * would reset the staleness clock it had just measured, and the epic would read as freshly active
 * forever afterwards. The children are the work; only the work counts as movement.
 *
 * Returns null when NO child carries a readable timestamp — never `0` and never "now". Both of those
 * are answers, and this is the absence of one.
 */
export function lastChildProgressAt(beads: readonly Bead[], epicId: string): number | null {
  let newest: number | null = null;
  for (const child of childrenOf(beads, epicId)) {
    const t = parseTs(child.updatedAt) ?? parseTs(child.createdAt);
    if (t !== null && (newest === null || t > newest)) newest = t;
  }
  return newest;
}

/** Build agents bound to this epic. ONE definition, shared by the watch gate in `candidateFor` and
 *  the marker self-heal in `sweepEpics`, so the two can never disagree about what "bound" means.
 *
 *  Deliberately ABOVE the block below rather than between it and `candidateFor`: that block is the
 *  "do NOT reduce this back to the roster" warning, and it has to stay adjacent to the function it
 *  describes or the next maintainer opens `candidateFor` and finds nothing. */
export function boundAgentsFor(
  agents: readonly AgentTab[],
  epicId: string,
): readonly AgentTab[] {
  return agents.filter((a) => a.kind === "build" && a.epicId === epicId);
}

/**
 * Build the engine's view of one epic from the live roster.
 *
 * ── TWO DIFFERENT FACTS, FROM TWO DIFFERENT PLACES, AND CONFLATING THEM WAS A REAL BUG ────────
 * `promoted` (the watch gate) is `bound.length > 0 || isPromotedToBuild(epic)` — a live bound build
 * agent OR the durable `promoted-to-build` label. `lastSweepRestartAt` (the budget) comes from a
 * separate LABEL ON THE BEAD that only this sweep writes.
 *
 * ── THE GATE WAS ROSTER-ONLY UNTIL 2026-08-18, AND THAT MADE THE WHOLE SWEEP INERT ─────────────
 * `bound.length > 0` alone is a fact about a TAB, and the thing it stands for is about the WORK, so
 * it decayed on close, on retire, and on every relaunch. Measured on the founder's install: 39
 * epics, 28 persisted build agents, NOT ONE carrying an `epicId` — so this returned `promoted:
 * false` for every epic, `decideEpicSweep` answered `not-watched` on its first check every tick,
 * and nothing was ever restarted. See `beads.PROMOTED_LABEL`. Do NOT reduce this back to the
 * roster: the label is the half that survives, and the sweep re-stamps it when it sees a bound
 * agent on an unstamped epic so a lost write costs a tick rather than the epic.
 *
 * `lastSweepRestartAt` is a SEPARATE fact and must stay one. The first version used a single number
 * for both — the newest bound agent's `createdAt` — and it was wrong twice over. `sendToBuild`
 * REUSES the agent already bound to an epic, so `createdAt` never advanced past a restart, making
 * the escalate branch unreachable and the restart loop infinite. And even had it advanced, it could
 * not tell a sweep restart from a human promotion, so a founder promoting an already-planned epic
 * would have been escalated on the first tick for a restart nobody spent.
 */
export function candidateFor(
  beads: readonly Bead[],
  agents: readonly AgentTab[],
  epic: Bead,
  alive: (agentId: string) => boolean | undefined,
): EpicSweepCandidate {
  const bound = boundAgentsFor(agents, epic.id);
  // UNKNOWN LIVENESS COUNTS AS ALIVE. `processAliveFor` returns undefined for an agent this window
  // never observed, and the conservative reading of "I cannot tell whether anyone is on this" is
  // to leave it alone: a wrong "alive" costs one skipped tick, a wrong "dead" spawns a rival
  // orchestrator against an epic somebody is already building.
  const orchestratorAlive = bound.some((a) => alive(a.id) !== false);
  return {
    epicId: epic.id,
    status: epicStatus(beads as Bead[], epic.id),
    // THE WATCH GATE, AND IT MUST NOT DEPEND ON A LIVE TAB. A bound agent row still counts — it is
    // the freshest possible evidence — but the DURABLE marker is what makes the gate survive the
    // orchestrator being closed, retired, or lost to a relaunch. Deriving this from the roster
    // alone is what left the sweep structurally inert from v0.114.0 until this landed: not one
    // persisted build agent in the founder's install carried an `epicId`, so every epic answered
    // `skip: not-watched` on the first check, every tick. See `beads.PROMOTED_LABEL`.
    promoted: bound.length > 0 || isPromotedToBuild(epic),
    lastSweepRestartAt: sweepRestartedAt(epic),
    orchestratorAlive,
    lastChildProgressAt: lastChildProgressAt(beads, epic.id),
    // THE RAW MARK, and it must stay raw. Excluding a stand-in escalation here — which a previous
    // round did, to stop the stand-in consuming the owed restart — makes the escalation
    // NON-TERMINAL: the epic reads as un-escalated on the very next tick, is decided `restart`
    // again, is converted to `escalate` again, and re-marks and re-notifies every ten minutes
    // forever. It also makes `clear` unreachable for exactly those epics, so a recovered one keeps
    // a false alarm in the Blocked lane permanently.
    //
    // "Is there an escalation mark" and "is the restart still owed" are TWO questions. This answers
    // only the first. The second is handled where it belongs — in the runner, which resets a
    // stand-in the moment the restart becomes available (see `standInToReset`).
    alreadyEscalated: epic.labels.includes(STALLED_LABEL),
    optedOut: isAutoRestartOptedOut(epic),
    // ── THE HOLLOW-EPIC FACTS ────────────────────────────────────────────────────────────────
    // `status` is the roll-up over CHILDREN, so it answers `unplanned` for a CLOSED childless epic
    // exactly as it does for an open one. Read the epic's own status separately or the sweep asks
    // for a paid decomposition of finished work.
    epicClosed: epic.status === "closed",
    decomposeRequested: isDecomposeRequested(epic),
    inDecomposePipeline: isInDecomposePipeline(epic),
    // THE EPIC'S OWN TIMESTAMP, deliberately the opposite rule to `lastChildProgressAt` above — a
    // hollow epic has no children to read, and "somebody just promoted this" is exactly the freshness
    // signal worth acting on. `createdAt` is the fallback for a bead bd has never updated.
    hollowSinceAt: parseTs(epic.updatedAt) ?? parseTs(epic.createdAt),
  };
}

/**
 * The sentence the founder actually reads. Deliberately says what was done and what he can do — a
 * recovery notice that only reports a fact leaves him to work out whether anything is owed.
 *
 * THE OPT-OUT IT NAMES HAS TO BE THE ONE THE CODE ACTUALLY IMPLEMENTS, and two drafts have already
 * been wrong here. "The next time it stalls I will ask you instead" was false — the sweep went
 * silent rather than asking. "Close that agent" was true only while the watch gate was derived from
 * the roster, and `beads.PROMOTED_LABEL` made it false: the epic now stays watched across the
 * orchestrator being closed, which is the entire point of that fix. The opt-out is
 * `beads.NO_AUTO_RESTART_LABEL`, vetoed in `decideEpicSweep`, and the copy below names it.
 *
 * Remedy copy is an instruction the reader will follow, so it gets audited like a branch, not
 * proofread like prose — and it is pinned by a test against the constant the engine vetoes on, so
 * the sentence and the behaviour cannot drift apart again.
 */
export function restartMessage(epic: Bead, relaunched = true): string {
  const name = `**${epic.id} — ${epic.title}**`;
  const why =
    `Its plan was written and then nothing moved on it for over two hours`;
  // ── TWO WORDINGS, EACH WRITTEN OUT IN FULL ──────────────────────────────────────────────────
  // Deliberately NOT sharing a `head` fragment between them. An earlier cut factored out the common
  // opening and produced a broken sentence — "I handed **e1 — Ship the thing**. Its plan was
  // written…" — because the shared fragment ended in a full stop and the two branches needed
  // different grammar around it. This is the notice the founder reads IN THE MOMENT to decide what
  // to do about a stalled epic, and this repo treats user-facing copy as code; a few duplicated
  // words are cheaper than a sentence with no object.
  //
  // The distinction matters to him beyond grammar. He spent today reclaiming agent capacity, so
  // "I restarted an agent" and "an agent was already running and idle" point at different problems.
  // ── THE OPT-OUT NAMED HERE CHANGED WHEN THE WATCH GATE BECAME DURABLE ───────────────────────
  // This used to say "close that agent — I stop watching an epic the moment nothing is bound to
  // it". That was true of the roster-derived gate and is now FALSE: `beads.PROMOTED_LABEL` keeps
  // the epic watched across the orchestrator being closed, retired, or lost to a relaunch, which is
  // the entire point of the fix. Leaving the old sentence would hand the founder an instruction
  // that silently does nothing — the failure mode this repo audits remedy copy for.
  return relaunched
    ? `I restarted ${name}. ${why}, with no build agent on it, so I handed it back to one. ` +
      `If that was not what you wanted, add the \`${NO_AUTO_RESTART_LABEL}\` label to the epic and ` +
      `I will leave it alone — closing the agent no longer stops me, because I now track the epic ` +
      `rather than its tab. Either way I will not restart this one again until it moves.`
    : `I handed ${name} back to its orchestrator. ${why} — but the orchestrator was already ` +
      `running, so I did not restart it; I told it to pick the epic back up. An epic sitting ` +
      `still with a live agent on it is worth a look. I will not hand this one back again ` +
      `until it moves.`;
}

/**
 * The durable audit note written onto the epic when the sweep restarts it.
 *
 * WHY THIS EXISTS AT ALL, given the concierge notice and the `sweep-restarted` label already do
 * something: neither answers the question actually asked later. The notice is a chat message the
 * founder may not have been at the machine for, and it scrolls. The label carries an epoch and
 * nothing else — it can say WHEN but never WHY or WHAT. This is the only artifact that survives an
 * app restart AND states the reasoning, and it lands on the epic itself, in a store every worktree
 * shares and the board polls every five seconds.
 *
 * STATES ONLY WHAT WAS MEASURED. Every number here is read from the same values the DECISION was
 * made from — the newest child `updatedAt`, the child count, the agent that was relaunched — so the
 * note and the decision cannot disagree. A note that reconstructed its own facts would eventually
 * describe a restart that happened for a different reason than it claims.
 */
export function auditNote(
  epic: Bead,
  agentId: string,
  now: number,
  beads: readonly Bead[],
  relaunched = true,
): string {
  const children = childrenOf(beads, epic.id);
  const progressed = lastChildProgressAt(beads, epic.id);
  // Whole hours: the stall line is two hours and the reach cap is fourteen days, so minutes are
  // noise at every scale this note is read at. `null` stays `null` rather than becoming 0 — "no
  // child has ever moved" and "a child moved this instant" are opposite facts.
  const idleHours = progressed === null ? null : Math.floor((now - progressed) / (60 * 60 * 1000));
  return [
    `Auto-restarted by the epic sweep.`,
    ``,
    `WHY: this epic was promoted to Build and its plan was written, but no child bead has moved` +
      (idleHours === null ? ` and none carries a timestamp at all.` : ` in ${idleHours}h.`),
    `CHILDREN: ${children.length} filed.`,
    // The line a human reads months later to answer "what did it actually do?". It must not say
    // "relaunched" about an orchestrator that was already up — this is the durable record, so a
    // false word here outlives every other copy of the claim.
    relaunched
      ? `ACTION: relaunched orchestrator ${agentId} and handed the epic back to it.`
      : `ACTION: orchestrator ${agentId} was ALREADY RUNNING — not restarted. Handed the epic` +
        ` back to it and told it to resume.`,
    `BUDGET: this epic's ONE automatic restart is now spent. If nothing moves, the next sweep` +
      ` escalates it to the Blocked lane instead of restarting it again. The budget resets only` +
      ` when a child bead actually moves.`,
  ].join("\n");
}

/**
 * The give-up sentence. Names the fact that the sweep has STOPPED, because an escalation that reads
 * like a status update gets treated as one.
 *
 * TWO WORDINGS, because there are two different truths and only one of them may claim a restart.
 * `afterRestart` says whether this sweep actually spent one (read from the epic's own marker, not
 * assumed). Saying "I restarted it once" about an epic nothing was ever handed back to is a false
 * statement to the person deciding what to do about it.
 *
 * WHICH WORDING IS REACHABLE IS DECIDED BY THE FLAG, and it is worth stating exactly because the
 * obvious reading is backwards in both configurations. While `RESTART_ENABLED` was false the
 * no-restart wording was EVERY escalation. Now that it ships `true` the OPPOSITE holds: the engine
 * escalates only on `lastSweepRestartAt > lastChildProgressAt` (see `epicContinuation`), which is
 * the same predicate the runner recomputes as `afterRestart`, and the degrade branch that could
 * escalate without a spent restart requires the flag OFF — so every escalation in the shipped
 * configuration follows a restart, and `afterRestart` is necessarily `true`.
 *
 * The `false` arm is therefore live ONLY under the OFF configuration. That is also what keeps its
 * copy ("I do not restart epics on my own yet") truthful, so it must be revisited if the degrade
 * path is ever removed. The marker is still read rather than assumed because the two must not be
 * allowed to drift: a wrong `afterRestart` is a false sentence either way.
 */
export function escalateMessage(epic: Bead, afterRestart: boolean): string {
  const head = `**${epic.id} — ${epic.title}** has stopped moving`;
  return afterRestart
    ? `${head}. I restarted it once and it still has not moved, so I have stopped retrying and ` +
        `moved it to Blocked. It needs your call: finish it, hand it to someone directly, or ` +
        `cancel it. I will not start another agent against it on my own.`
    : `${head} — its plan is written, nothing is building it, and no agent is on it. I have moved ` +
        `it to Blocked so it is in front of you. I do not restart epics on my own yet, so this one ` +
        `needs you: hand it to a build agent, finish it, or cancel it.`;
}

// ── The sweep ──────────────────────────────────────────────────────────────────────────────────

/**
 * One pass over every epic in every project this window owns.
 *
 * Exported (not merely driven by the interval) so a caller can force a pass and so the tests drive
 * THE REAL THING rather than a re-implementation. Never throws: a failure on one epic must not stop
 * the sweep reaching the others, and a sweep that throws would take its own timer down.
 */
export async function sweepEpics(opts: EpicSweepOptions = {}): Promise<EpicSweepOutcome[]> {
  const now = opts.now ?? Date.now();
  const owns = opts.ownsProject ?? ownsProjectInThisWindow;
  const stallMs = opts.stallMs ?? EPIC_STALL_MS;
  const maxAgeMs = opts.maxAgeMs ?? EPIC_MAX_STALL_AGE_MS;
  const hollowMs = opts.hollowMs ?? EPIC_HOLLOW_SETTLE_MS;
  const restartEnabled = opts.restartEnabled ?? RESTART_ENABLED;
  const requestDecomposeEnabled = opts.requestDecomposeEnabled ?? DECOMPOSE_REQUEST_ENABLED;
  const notify = opts.notify ?? ((text: string) => notifyConcierge(text, "pusher"));
  const canNotify = opts.canNotify ?? conciergeNotifierAvailable;
  const prdIndexFor = opts.prdIndexFor ?? loadEpicPrdIndex;
  const restart =
    opts.restart ??
    (async (projectId: string, epicId: string) =>
      sendToBuildAwaited({
        projectId,
        epicId,
        // The epic's own PRD, so the resumed orchestrator is pointed at the plan by path rather than
        // told to go find it. `resolveEpicPrdPath` is the ONE rule the board's Start button, the
        // epic ladder and `decomposeEpic` also use — structured `prd` metadata first, the prose
        // `PRD file:` line only as fallback — and it returns null for a PRD-less epic, which
        // `resumeInstruction` handles by falling back to `bd show`.
        // The bead is read through `beadsFor`, the same seam the sweep reads everything else from,
        // so a test that injects beads gets the PRD it declared rather than a store read. Both it
        // and `projects` are declared below this closure but initialized long before it is called.
        prdPath: resolveEpicPrdPath(
          beadsFor(projectId)?.find((b) => b.id === epicId),
          await prdIndexFor(projects.find((p) => p.id === projectId)?.rootPath ?? ""),
        ),
        mode: "epic",
        // NOBODY CLICKED THIS. `landInAgent` would leave the board, select the agent, open its pane
        // and scroll its row into view — stealing the founder's screen on a ten-minute timer, which
        // `landInAgent`'s own header forbids for a handoff the user did not ask for.
        reveal: false,
        // The concierge's own reasoning, for the same reuse path: seeding a REUSED orchestrator
        // through `appendPrompt` releases its goal debt, so a machine-driven handoff would un-latch
        // an escalation nothing spent and nothing counted.
        humanAuthored: false,
      }));
  const mark =
    opts.mark ??
    ((projectPath: string, action: "add" | "remove", epicId: string) =>
      labelBead(projectPath, action, epicId, STALLED_LABEL));
  const setLabel = opts.setLabel ?? labelBead;
  // THE DURABLE AUDIT TRAIL. A `log.warn` line dies with the app session and the `sweep-restarted`
  // label can only carry a timestamp, so neither answers "why did it restart that, three days ago?"
  // — the question the founder actually asks. A bd comment lands on the epic itself, in a store
  // every worktree shares and the board polls, which is where he is already looking.
  const audit = opts.audit ?? commentBead;
  const auditAttempts = opts.auditAttempts ?? AUDIT_WRITE_ATTEMPTS;
  const auditBackoffMs = opts.auditBackoffMs ?? AUDIT_RETRY_BACKOFF_MS;

  /**
   * Record that THE SWEEP restarted this epic, at `at`.
   *
   * Removes any earlier marker before adding the new one, so exactly one survives and the label set
   * cannot grow without bound across a long-lived epic. The removals are awaited but their failure
   * is not fatal — a leftover OLDER marker can only ever under-state how recently we restarted,
   * which biases towards granting another restart rather than towards a false escalation.
   */
  async function stamp(projectPath: string, epic: Bead, at: number): Promise<void> {
    for (const old of epic.labels.filter((l) => l.startsWith(SWEEP_RESTART_PREFIX))) {
      try {
        await setLabel(projectPath, "remove", epic.id, old);
      } catch (e) {
        log.warn("epics", "could not clear an old sweep marker", { epic: epic.id, error: String(e) });
      }
    }
    await setLabel(projectPath, "add", epic.id, `${SWEEP_RESTART_PREFIX}${at}`);
  }
  const beadsFor =
    opts.beadsFor ?? ((projectId: string) => useBeadsStore.getState().byProject[projectId]?.beads ?? null);
  const aliveFor =
    opts.aliveFor ??
    ((agentId: string) => {
      const rt = useRuntimeStore.getState();
      return processAliveFor(agentId, rt.status, new Set(rt.openAgentIds));
    });

  const projects = opts.projects ?? useProjectStore.getState().projects;
  const outcomes: EpicSweepOutcome[] = [];

  for (const project of projects) {
    // SINGLE-OWNER ELECTION, the same one the other three sweeps use. Without it every open window
    // reaches the same conclusion about the same epic and each starts its own agent.
    if (!owns(project.id)) continue;
    const beads = beadsFor(project.id);
    // A project whose board has never loaded is NOT a project with no epics. Skipping is the only
    // honest answer — acting on an empty list would read every epic as having no children and
    // therefore nothing planned, which is silence rather than a decision.
    if (!beads || beads.length === 0) continue;

    let acted = 0;
    for (const epic of beads.filter((b) => isEpic(beads, b))) {
      // ── SELF-HEAL THE WATCH MARKER ────────────────────────────────────────────────────────────
      // A bound build agent proves this epic WAS handed over, so the durable marker should exist.
      // When it does not, the stamp at handoff time was lost — `sendToBuild` writes it
      // fire-and-forget, and this repo documents `bd` writes queueing behind a single writer and
      // timing out as routine. Re-stamping here means one lost write costs a tick, not the epic:
      // without it the failure is PERMANENT and silent, because the case the whole fix addresses is
      // precisely "nobody hands this epic over again", so no later handoff would re-stamp it. That
      // is the same shape as the roster gate this replaced, only rarer — which is what makes it
      // worth healing rather than logging.
      //
      // Not counted against MAX_ACTIONS_PER_SWEEP: it starts no agent and notifies nobody. It is
      // bookkeeping that makes an existing fact durable, not a decision about the work.
      if (!isPromotedToBuild(epic) && boundAgentsFor(project.agents, epic.id).length > 0) {
        try {
          await setLabel(project.rootPath, "add", epic.id, PROMOTED_LABEL);
          epic.labels = [...epic.labels, PROMOTED_LABEL];
        } catch (e) {
          log.warn("epics", "could not heal a missing promoted-to-build marker", {
            epic: epic.id,
            error: String(e),
          });
        }
      }
      const candidate = candidateFor(beads, project.agents, epic, aliveFor);
      const decision = decideEpicSweep(candidate, now, stallMs, maxAgeMs, hollowMs);
      const out: EpicSweepOutcome = { ...decision, projectId: project.id, performed: "none" };

      // ── A STAND-IN IS RETRACTED THE MOMENT THE REAL THING IS AVAILABLE ──────────────────────
      // While the restart is gated off, a `restart` decision is escalated instead — which marks the
      // epic and, correctly, is TERMINAL: the engine will not re-escalate it. That terminality is
      // what must not become permanent once the restart is switched on, because those epics were
      // never actually handed back and are still owed one.
      //
      // So this is the ONE place that knows both facts — the flag and the marker — and it resolves
      // them by RETRACTING: remove both labels, report a `cleared`, and let the next tick decide
      // `restart` on a clean epic. It costs one sweep of latency and needs no engine change, and it
      // is why `alreadyEscalated` above can stay raw.
      // ...but ONLY when the mark is the sole thing standing in the way. Retracting it regardless of
      // the engine's decision erases the founder-facing signal for epics the engine deliberately
      // skipped for OTHER reasons: a `too-old` epic (out of the 14-day reach, still stalled — the
      // ordering in `decideEpicSweep` exists so its flag is KEPT) would silently leave the Blocked
      // lane on the first tick after the flip and never come back, since the next tick answers
      // `too-old` with the mark now gone. Same for `not-watched` (the founder closed the
      // orchestrator, which IS the documented opt-out), `nothing-planned` and `unknown-age`.
      //
      // `already-escalated` is the exact condition, and it has to be the REASON rather than
      // `decision.action === "restart"`: a marked epic never reaches the restart branch at all —
      // the mark short-circuits it at step 8 — so keying on the action would make this dead code.
      // This reason means "in reach, still stalled, promoted, nobody on it, and the only thing
      // stopping a restart is a mark we wrote as a stand-in for one".
      // …and only from a window that could actually FOLLOW THROUGH. A satellite's sink is null for
      // the window's whole life, and `routeToOwningWindow` hands a torn-out project's ownership TO
      // that satellite — which is why the restart branch refuses there with `cannot-notify`.
      // Escalation is deliberately not gated that way (the label is the durable signal), so such a
      // window DOES stand-in-mark its epics. Retracting those marks from the same window would
      // strip both labels, then refuse the restart on the next tick, and leave the epic clean
      // forever: never re-escalated (`alreadyEscalated` false) and never restarted (refused every
      // tick) until it ages out. That destroys the one durable signal that survived the
      // un-notifiable window, via the path meant to UPGRADE it. Leaving the mark costs nothing —
      // the next tick in a window that can notify resets it properly.
      // One line, deliberately: split across a `&&` chain the last conjunct is a bare continuation
      // that no mutation can be applied to without breaking the parse, so the guard could not be
      // proven able to fail. Kept whole so mutation-check can judge it.
      const isStandIn =
        epic.labels.includes(SWEEP_NO_AUTO_LABEL) && decision.reason === "already-escalated";
      const standInToReset = restartEnabled && isStandIn && canNotify();

      // When the restart is gated OFF (see RESTART_ENABLED, which ships `true`), a `restart`
      // decision degrades to an escalation so the founder still learns the epic has stopped,
      // rather than the sweep deciding to act and then doing nothing observable.
      const action = standInToReset
        ? "clear"
        : decision.action === "restart" && !restartEnabled
          ? "escalate"
          : decision.action;

      // CHECKED AFTER THE RESET, NOT BEFORE. A stand-in-marked epic is answered `skip
      // ("already-escalated")` by the engine — correctly, because the mark IS terminal — so
      // short-circuiting on the raw decision here would make the reset unreachable and the
      // terminality permanent. `action` is what the sweep is actually going to do.
      if (action === "skip") {
        outcomes.push(out);
        continue;
      }

      // ── THE KILL SWITCH, CHECKED BEFORE THE CAP ────────────────────────────────────────────
      // Above the cap on purpose: a suppressed request must not consume the tick's one action, or
      // switching the flag off would silently starve the restart half in any project that also
      // holds a hollow epic. Reported rather than folded into `skip`, so "we decided to ask and
      // chose not to" stays legible apart from "there was nothing to ask about".
      if (action === "request-decompose" && !requestDecomposeEnabled) {
        outcomes.push({ ...out, note: "disabled" });
        continue;
      }

      // ── THE PER-SWEEP CAP BOUNDS WHAT THE TICK SPENDS, NOT WHAT IT RETRACTS ─────────────────
      // Hoisted above the restart/escalate split, and that is a fix rather than tidiness. It used to
      // sit INSIDE the restart branch — so with the restart gated off no epic entered that branch
      // and the cap governed nothing: the first production tick would label EVERY in-window stalled
      // epic and fire one concierge notice per epic, all at once. That is the same first-run burst
      // the 14-day reach cap exists to control, which only shaves the long tail. An epic not acted
      // on is not lost: it is still stalled ten minutes later and the engine's answer is unchanged.
      // A GENUINE `clear` is EXEMPT. It spends nothing and sends nothing, and it removes a FALSE
      // alarm from the lane the founder scans for real ones — the cap's rationale ("a surprise, not
      // a recovery"; the first-run notice burst) is about spends and notices. Capping those means a
      // recovered epic's stale mark waits behind whatever escalation happened to be first in board
      // order, reported as `capped` and indistinguishable from a suppressed action.
      //
      // A STAND-IN RESET IS NOT THAT, and reusing the same action word hid the difference. Its epic
      // is STILL STALLED, so it retracts a TRUE alarm — and the restart meant to follow is rate
      // limited to one per tick. Left exempt, the tick after the flag flips de-escalates every
      // marked epic in the project at once while the restarts trickle behind at one per ten
      // minutes: epics 2..N sit with no mark, no agent and `capped`, invisible for up to N ticks.
      // That is the "clean and invisible" state the last three rounds were closing, bounded in time
      // rather than permanent, and worst exactly when the flip matters most — a large gated
      // backlog. So it is capped, at the same rate as the restart it stands in for.
      const exemptFromCap = action === "clear" && !standInToReset;
      if (!exemptFromCap && acted >= MAX_ACTIONS_PER_SWEEP) {
        outcomes.push({ ...out, note: "capped" });
        continue;
      }

      if (action === "request-decompose") {
        // ── ASK FOR A PLAN FOR AN EPIC THAT HAS NONE ─────────────────────────────────────────
        // The whole action is ONE label write. That write is not bookkeeping: `epicDecompose`'s
        // watcher spends a PAID AI call on any epic carrying it, which is why this branch is
        // guarded like the restart branch rather than like the `clear` one.
        //
        // DECLARED EPICS ONLY, AND THAT IS AN INVARIANT RATHER THAN A CHECK. `pickEpicsToDecompose`
        // requires `isTypedEpic`, so a label on a merely-structural epic would be a request nothing
        // could ever answer. The engine cannot assert it — it is handed a status, not a bead — but
        // it does not have to: `isEpic` is `isTypedEpic(b) || hasChildren(b)`, and this branch is
        // reached only for `status === "unplanned"`, which is `childrenOf(...).length === 0`. A
        // structural epic therefore cannot be here, from the same bead list that answered both.
        // Deliberately NOT re-checked with an `if`: a guard nothing can make fire is a branch no
        // test can red, and the invariant is stronger stated than half-enforced. If the runner's own
        // `isEpic` filter or `epicStatus`'s source list is ever changed to disagree, THAT is where
        // the check belongs.
        // The same refusal the restart branch makes, for the same reason: this spends the founder's
        // money and its whole point is that he is TOLD. In a satellite window `sink` is null for the
        // life of the window and `routeToOwningWindow` can hand a torn-out project's ownership to
        // exactly that window — so the notice would not be transiently dropped, it would be
        // permanently undeliverable, and no window that COULD tell him will ever sweep this project.
        // Skipping leaves the epic fully eligible: nothing is written, so the next sweep in a window
        // that can notify asks properly.
        if (!canNotify()) {
          log.warn("epics", "skipping a decompose request this window could not report", {
            epic: epic.id,
          });
          outcomes.push({ ...out, note: "cannot-notify" });
          continue;
        }
        try {
          await setLabel(project.rootPath, "add", epic.id, DECOMPOSE_REQUESTED_LABEL);
          // Keep the in-hand snapshot honest, exactly as the promoted-marker heal above does. A
          // second pass over the same board within one tick must not read the pre-write state and
          // ask twice.
          //
          // DEDUPED, because `bd` labels are a SET and this mirror must not be able to say otherwise.
          // A caller whose own label write already updated this object (which is exactly what the
          // suite's mutating `setLabel` does, and what a real re-read would do) would otherwise leave
          // the bead carrying two copies — a shape no store can produce, so anything downstream
          // counting labels reads a state that cannot exist.
          epic.labels = [
            ...epic.labels.filter((l) => l !== DECOMPOSE_REQUESTED_LABEL),
            DECOMPOSE_REQUESTED_LABEL,
          ];
        } catch (e) {
          // A FAILED WRITE MUST NOT NOTIFY: the sentence says "I have asked for it to be broken
          // down", and nothing was asked. Nothing is spent either — the epic is untouched and fully
          // eligible on the next tick.
          log.warn("epics", "could not request decomposition", { epic: epic.id, error: String(e) });
          outcomes.push({ ...out, note: "write-failed" });
          continue;
        }
        acted += 1;
        // The durable record, written AFTER the request actually landed so it can never describe
        // one that did not. Best-effort and never throws — the label is what does the work, and a
        // locked store must not turn a real request into a reported failure. Same bounded,
        // lock-aware retry the restart path uses; the store is single-writer and shared by every
        // worktree, so a transient lock is the ORDINARY failure here.
        await writeAuditNoteResilient(
          audit,
          project.rootPath,
          epic.id,
          requestDecomposeNote(epic, candidate.hollowSinceAt ?? null, now),
          auditAttempts,
          auditBackoffMs,
        );
        // The notifier's own answer, not an assumption that sending equals delivering.
        const noticed = notify(requestDecomposeMessage(epic, NO_AUTO_RESTART_LABEL));
        if (!noticed) {
          log.warn("epics", "requested a decomposition but the notice was dropped", {
            epic: epic.id,
          });
        }
        outcomes.push({ ...out, performed: "decompose-requested", noticed });
        continue;
      }

      if (action === "restart") {
        // ── DECIDE BEFORE SPENDING, NOT AFTER ──────────────────────────────────────────────────
        // A restart spends two irreversible things — an agent slot and this epic's one-shot
        // `sweep-restarted` budget — and its whole point is that the founder is TOLD. In a
        // satellite window there is no `ConciergeHost`, so `sink` is null for the life of that
        // window, and `routeToOwningWindow` hands a torn-out project's ownership TO the satellite
        // (which is why this runner is mounted there at all). So for such a project the notice is
        // not transiently dropped, it is permanently undeliverable — and no window that COULD tell
        // him will ever sweep it. Spending the budget there would restart an orchestrator and tell
        // him nothing, ever.
        //
        // `conciergeNotifierAvailable` is exported precisely "so a caller can decide before
        // composing an expensive message"; here the expensive thing is the spend itself. Skipping
        // leaves the epic fully eligible — nothing is stamped, so the next sweep in a window that
        // CAN notify does the restart properly.
        //
        // ESCALATION IS DELIBERATELY NOT GATED THIS WAY: its durable signal is the `stalled` LABEL,
        // which lands regardless and puts the epic in the Blocked lane where he looks. The notice
        // is the nicety there, not the mechanism.
        if (!canNotify()) {
          log.warn("epics", "skipping a restart this window could not report", { epic: epic.id });
          outcomes.push({ ...out, note: "cannot-notify" });
          continue;
        }
        try {
          // STAMP BEFORE HANDING OVER. The marker is what makes "restart once" a real bound, so it
          // has to be written on the path that spends the restart — and written FIRST, because a
          // handoff that succeeded while the stamp failed is the infinite-loop state this whole
          // marker exists to prevent. Stamping first can at worst cost the epic one restart it was
          // owed (recoverable: the founder promotes it, or removes the label); stamping last can
          // cost the fleet an agent every ten minutes forever.
          await stamp(project.rootPath, epic, now);
          // AWAITED, and that is the point of this half of the work. The old call was
          // fire-and-forget into `sendToBuild`, whose relaunch reported a DISPATCH RECEIPT and whose
          // seed was swallowed by the resume path — so this line could "succeed" while nothing was
          // relaunched and nothing was told. `sendToBuildAwaited` waits for the pane's own readiness
          // verdict AND for the instruction to reach the terminal, and throws otherwise; the catch
          // below turns that into `spawn-failed` with no notice to the founder.
          const handoff = await restart(project.id, epic.id);
          // "Was the epic handed back" and "was the orchestrator relaunched" are TWO facts, and only
          // the second may be called a restart. `mountAgentAwaited` refuses to tear down an
          // orchestrator that recovered while the stamp above was being written, and reports
          // `already-live` — a real handoff, but not a relaunch. Reading the verdict here is what
          // stops the fix in the mount layer from simply relocating the false claim into the notice
          // and the durable audit note.
          const relaunched = didRelaunch(handoff);
          acted += 1;
          // THE DURABLE RECORD, written after the restart has actually happened so it can never
          // describe one that did not. Best-effort and deliberately NOT allowed to throw into the
          // try's failure path: the restart is real and irreversible by now, so a bd write that
          // fails must not turn a successful handoff into a reported failure. The store is
          // single-writer and shared by every worktree, so a lock is the ORDINARY failure here and
          // a single attempt silently dropped ~15 notes/day — so the write is retried a bounded few
          // times on a transient lock (`writeAuditNoteResilient`), then, if the store stays locked,
          // logs the same warning and continues. It NEVER throws. The concierge notice below is the
          // signal the founder sees in the moment; this is the one he can still read next week.
          await writeAuditNoteResilient(
            audit,
            project.rootPath,
            epic.id,
            auditNote(epic, handoff.agentId, now, beads, relaunched),
            auditAttempts,
            auditBackoffMs,
          );
          // The notice's own answer, not an assumption that sending equals delivering.
          const noticed = notify(restartMessage(epic, relaunched));
          if (!noticed) {
            log.warn("epics", "restarted an epic but the notice was dropped", { epic: epic.id });
          }
          outcomes.push({ ...out, performed: "restarted", relaunched, noticed });
        } catch (e) {
          // AT CAPACITY IS NOT THE EPIC'S FAULT, and neither is a failed stamp — but the stamp has
          // already landed by the time a handoff can fail, so this epic has spent its restart on an
          // attempt that did not happen. That is the SAFE direction: the next tick escalates to the
          // founder rather than silently retrying a handoff the fleet has no room for.
          //
          // A REFUSED MOUNT LANDS HERE TOO, and that is the point of it throwing. `sendToBuild`
          // raises `MountRefusedError` when nothing could relaunch the agent, so the sweep records
          // a failure and says NOTHING to the founder — rather than notifying him of a restart that
          // did not happen. Three review rounds all found some version of "reported success,
          // relaunched nothing"; this is the shape that makes it unavailable.
          const note = e instanceof AtCapacityError ? "at-capacity" : "spawn-failed";
          log.warn("epics", "epic restart failed", { epic: epic.id, note, error: String(e) });
          outcomes.push({ ...out, note });
        }
        continue;
      }

      // escalate / clear — both are one label write on the epic.
      try {
        await mark(project.rootPath, action === "escalate" ? "add" : "remove", epic.id);
        // A STAND-IN escalation gets a second marker so the engine does not read it as a spent
        // budget. Without it, every epic that stalls while the restart is gated off permanently
        // burns the restart it is still owed, and flipping RESTART_ENABLED on later could never
        // hand any of them back — for exactly the population the restart half exists to serve.
        // On the clear path the marker comes off with the label, so a recovered epic is fully reset.
        const standIn = decision.action === "restart" && !restartEnabled;
        if (action === "escalate" && standIn) {
          await setLabel(project.rootPath, "add", epic.id, SWEEP_NO_AUTO_LABEL);
        } else if (action === "clear") {
          // BOTH labels come off, on a genuine clear and on a stand-in reset alike. Leaving the
          // marker behind would reset the epic on every tick from here on.
          await setLabel(project.rootPath, "remove", epic.id, SWEEP_NO_AUTO_LABEL);
        }
        // A stand-in reset SPENDS the tick's action, because it is the first half of a restart the
        // next tick performs. A genuine recovery clear does not.
        if (standInToReset) acted += 1;
        if (action === "escalate") {
          acted += 1;
          // A dropped escalation notice is less bad than a dropped restart notice — the label DID
          // land, so the epic is sitting in the Blocked lane where the founder looks for exactly
          // this. It is still recorded: "he was told" and "the label is written" are two facts, and
          // only one of them is proven here.
          // THE ENGINE'S OWN CONDITION, not a looser re-derivation. The engine escalates only when
          // a spent restart was followed by NO movement; asking merely "has a marker ever existed"
          // diverges for the case it documents — restart at t3, children move at t5, stalls again
          // later — and would tell the founder "I restarted it once and it still has not moved"
          // about a stall for which nothing was handed back and against work that demonstrably did
          // move. That false sentence is the exact thing this message was split in two to prevent.
          const spent = sweepRestartedAt(epic);
          const progressed = lastChildProgressAt(beads, epic.id);
          // REDUNDANT BUT NOT DEAD, and the distinction is the point. `spent > progressed` and
          // `!standIn` coincide on every reachable state — `escalate` comes either from the
          // engine's own branch (which requires `spent > progressed`, so `standIn` is false) or
          // from the degrade (which requires the engine to have wanted `restart`, so the
          // comparison is false). Dropping EITHER leaves the suite green; dropping BOTH reds the
          // marker-older-than-work case. Kept as belt-and-braces because the failure it prevents
          // is a false "I restarted it once" to the founder, and this way a future engine change
          // that breaks the coincidence fails closed rather than open.
          const afterRestart =
            spent !== null && progressed !== null && spent > progressed && !standIn;
          const noticed = notify(escalateMessage(epic, afterRestart));
          if (!noticed) {
            log.warn("epics", "escalated an epic but the notice was dropped", { epic: epic.id });
          }
          outcomes.push({ ...out, performed: "escalated", noticed });
        } else {
          outcomes.push({ ...out, performed: "cleared" });
        }
      } catch (e) {
        // A FAILED WRITE MUST NOT NOTIFY. The concierge line says "I moved it to Blocked"; sending
        // it when the label never landed tells the founder to look somewhere the epic is not.
        log.warn("epics", "epic mark failed", {
          epic: epic.id,
          action: decision.action,
          error: String(e),
        });
        outcomes.push({ ...out, note: "write-failed" });
      }
    }
  }

  return outcomes;
}

// ── The mount ──────────────────────────────────────────────────────────────────────────────────

let timer: ReturnType<typeof setInterval> | null = null;
let sweeping = false;

/**
 * Start the sweep. Returns a teardown. Idempotent: a second call replaces the first interval rather
 * than running two.
 *
 * NO IMMEDIATE TICK, matching `goalContinuationRunner`. The first pass of a freshly-launched window
 * would run before the beads store has loaded anything, so every project would be skipped for want
 * of a board — and, worse, a window opened for two seconds has observed nothing about whether
 * anybody is working on these epics.
 */
export function startEpicSweepRunner(intervalMs: number = EPIC_SWEEP_INTERVAL_MS): () => void {
  stopEpicSweepRunner();
  const tick = async () => {
    // A sweep awaits label writes, so a slow `bd` can outlast the interval. Overlapping ticks would
    // each read the pre-write state and could escalate the same epic twice.
    if (sweeping) return;
    sweeping = true;
    try {
      await sweepEpics();
    } catch (e) {
      log.warn("epics", "epic sweep failed", { error: String(e) });
    } finally {
      sweeping = false;
    }
  };
  timer = setInterval(() => void tick(), intervalMs);
  return stopEpicSweepRunner;
}

/** Stop the sweep (idempotent). */
export function stopEpicSweepRunner(): void {
  if (timer !== null) clearInterval(timer);
  timer = null;
}

/** Test/introspection helper: is the sweep armed? */
export function isEpicSweepRunnerRunning(): boolean {
  return timer !== null;
}
