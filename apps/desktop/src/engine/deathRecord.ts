// deathRecord — classify WHY an agent session ended, from what this window actually observed.
//
// The counterpart to `deathTypes.ts`, which defines the vocabulary and the honesty rule. This module
// applies them. It is the "distinguishability" the fleet-handoff retrospective said did not exist and
// declined to build auto-resurrection without: "a transient death and a permanent one are not
// distinguishable today; auto-restart without that distinction risks looping on a real fault."
//
// ── ADDS NO NEW MATCHER, AND THAT IS THE POINT ────────────────────────────────────────────────
// Every classifier this needs already exists, is tested, and is pure:
//   • `apiRecovery.classifyApiFailure`  — "retryable" (a vendor fault) vs "terminal" (an account wall)
//   • `quotaBlock.quotaBlocksIn`        — the wall, with `resetParsed` already computed by an EXACT
//                                         comparison against `parseResetInstant`'s fallback
//   • `agentGoal.goalStateOf`           — whether a goal was positively MARKED met
//   • `hookEvents` BLOCKING_TOOL_STATUS — the only sound blocked-on-human signal
// Writing a second regex for any of these is how the two copies drift; this repo has been bitten
// twice already and says so in `quotaBlock.ts`'s header.
//
// ── NO MODEL CALL ON ANY PATH ─────────────────────────────────────────────────────────────────
// When the wall is fleet-wide, every LLM in the app is gated by the same account limit. This module
// is regex and comparisons, so it keeps working exactly when it is needed.
//
// PURE. Data in, data out; the clock arrives as a parameter. No timers, no I/O, no registry reads —
// the caller gathers the observation, which is what makes Gate 0 below enforceable.
import type { AgentGoal } from "./agentGoal";
import { goalStateOf } from "./agentGoal";
import { classifyApiFailure } from "./apiRecovery";
import type { DeathVerdict, DeathWall } from "./deathTypes";
import type { QuotaBlock } from "./quotaBlock";
import { quotaBlocksIn } from "./quotaBlock";
import type { AgentLiveness } from "../services/agentLiveness";

/** The tools whose `PreToolUse` genuinely means "a person must answer before this proceeds".
 *
 *  Mirrors `hookEvents.BLOCKING_TOOL_STATUS`. Deliberately NOT exported from there and re-imported:
 *  that map's values are UI statuses, and coupling a death classification to a pill colour would mean
 *  a labelling change silently reclassifies deaths. The membership is what matters here, so it is
 *  stated as its own fact — and pinned against the other list by test. */
export type BlockingTool = "AskUserQuestion" | "ExitPlanMode";

/** What ended the session, as observed by the transport/engine layer. */
export type Terminator =
  /** The PTY closed. Carries NO exit code — `pty.rs` emits none — so it names nothing by itself. */
  | "pty-exit"
  /** A `SessionEnd` hook landed. Also says nothing about why on its own. */
  | "session-end"
  /** A quota wall tripped the engine. The agent may still be alive; it simply cannot proceed. */
  | "quota-trip";

/**
 * Everything the caller managed to observe. Gathered by the impure mount, never read from here.
 *
 * The separation is load-bearing for Gate 0: `engineRegistry`'s readers return `undefined` for BOTH
 * "healthy" and "no pane in this window", so a classifier that reached into them itself could not
 * tell the two apart. Taking `liveness` as an input forces the caller to say which it is.
 */
export interface DeathObservation {
  /** `engineRegistry.quotaBlockForAgent(agentId, now)`. */
  quota: QuotaBlock | undefined;
  /** `engineRegistry.lastFailureForAgent(agentId)` — VERBATIM, never normalized. */
  lastFailure: { message: string; at: number } | undefined;
  /** `agentLiveness.livenessOf(...)`. Anything but `"local"` means this window did not watch it. */
  liveness: AgentLiveness;
  goal: AgentGoal | undefined;
  /** The blocking tool from the agent's last `PreToolUse`, if it was one. */
  blockingTool: BlockingTool | undefined;
  terminator: Terminator | undefined;
  now: number;
}

/** The verdict a window writes when it did not watch the agent. Named because several paths return
 *  it and they must all return the SAME thing — an unobserved death is one shape, not several. */
const UNOBSERVED: DeathVerdict = { cause: "unknown", evidence: "none" };

/** Build the wall half of a verdict from a `QuotaBlock`.
 *
 *  `resetAt` is DROPPED when `resetParsed` is false. That is not tidiness: `parseResetInstant`
 *  returns a bounded 5h re-check for an unparseable message, and a monthly spend cap is exactly that
 *  case. Persisting the fallback as a reset instant would let a clock-armed recovery fire at a door
 *  only a human opens — and would state, durably, a claim about when someone's money reappears. */
function wallFrom(q: QuotaBlock): DeathWall {
  return q.resetParsed
    ? { message: q.message, resetAt: q.resetAt, resetParsed: true, observedAt: q.at }
    : { message: q.message, resetParsed: false, observedAt: q.at };
}

/**
 * The wall this observation implies, from EITHER path it can arrive by.
 *
 * A wall usually reaches us as a parsed `QuotaBlock` on the output path. But `lastFailure` can also
 * hold one — `classifyApiFailure` returns `"terminal"` for exactly the account-limit shapes — and if
 * we only looked at `o.quota` we would classify that agent `transport-transient` and retry it into
 * the wall. So a terminal `lastFailure` is re-parsed through `quotaBlocksIn`, the SAME function, not
 * a second matcher.
 */
function effectiveWall(o: DeathObservation): QuotaBlock | undefined {
  if (o.quota) return o.quota;
  const lf = o.lastFailure;
  if (!lf) return undefined;
  if (classifyApiFailure(lf.message) !== "terminal") return undefined;
  return quotaBlocksIn(lf.message, lf.at)[0];
}

/**
 * Classify a death. Never throws; every unhandled shape lands on `unknown`.
 *
 * GATE ORDER IS THE POLICY, and it is ordered by what each mistake costs:
 *
 *  0. NOT OBSERVED → `unknown`. Unconditional and first.
 *  1. `clean-goal-met` → the agent FINISHED. Must outrank everything, because resurrecting a
 *     finished agent undoes a completed decision. Requires a positive `metAt` AND a quiet exit: a
 *     goal marked met and THEN a wall means the wall is what ended it.
 *  2. `wall-*` → outranks failures, mirroring `statusEngine`'s own precedence ("quota outranks
 *     BOTH"). Retrying into a wall is the measured 45-retry failure.
 *  3. `blocked-on-human` → a person is the blocker; a respawn re-asks nothing.
 *  4. `transport-transient` → the ordinary retryable case.
 *  5. `unknown` → observed, but nothing said why. First-class and honest.
 */
export function classifyDeath(o: DeathObservation): DeathVerdict {
  // ── Gate 0 ──────────────────────────────────────────────────────────────────────────────────
  // The single line that stops `engineRegistry`'s undefined-means-both from leaking into a durable
  // record. A window that did not watch this agent writes "unknown" — it does NOT write "healthy",
  // and it does NOT write a wall it never saw.
  if (o.liveness !== "local") return UNOBSERVED;

  const wall = effectiveWall(o);

  // ── 1. Finished ─────────────────────────────────────────────────────────────────────────────
  // `goalStateOf` returning "met" means `markGoalMet` recorded a positive `metAt`; a turn merely
  // ENDING never sets it. The extra conditions matter: an agent whose goal was met and which then
  // hit a wall or an API error did not exit cleanly, and calling it clean would make it permanently
  // unresurrectable on the strength of a stale mark.
  if (
    goalStateOf(o.goal, o.now) === "met" &&
    wall === undefined &&
    o.lastFailure === undefined &&
    o.terminator !== undefined &&
    o.goal?.metAt !== undefined
  ) {
    return { cause: "clean-goal-met", evidence: "goal-met-marked", goalMetAt: o.goal.metAt };
  }

  // ── 2. Walls ────────────────────────────────────────────────────────────────────────────────
  // `resetParsed` is the whole discriminator, and it is not a heuristic — `quotaBlock.blockFrom`
  // computes it by comparing against `parseResetInstant`'s documented fallback expression exactly.
  if (wall) {
    return {
      cause: wall.resetParsed ? "wall-session" : "wall-spend",
      evidence: "quota-block",
      message: wall.message,
      wall: wallFrom(wall),
    };
  }

  // ── 3. Waiting on a person ──────────────────────────────────────────────────────────────────
  // ONLY a structured blocking-tool hook. The string "Claude is waiting for your input" is an
  // ANTI-signal: `hookEvents.ts` documents it as a benign idle ping ~60s after Stop, so keying on it
  // marks finished agents as blocked and strands them.
  if (o.blockingTool !== undefined) {
    return { cause: "blocked-on-human", evidence: "blocking-tool" };
  }

  // ── 4. Retryable vendor fault ───────────────────────────────────────────────────────────────
  // Re-classified here rather than trusted from upstream, so a record can never inherit a stale
  // "terminal" and be retried against a wall.
  if (o.lastFailure && classifyApiFailure(o.lastFailure.message) === "retryable") {
    return {
      cause: "transport-transient",
      evidence: "api-banner",
      message: o.lastFailure.message,
    };
  }

  // ── 5. Observed, unexplained ────────────────────────────────────────────────────────────────
  // A bare PTY exit or SessionEnd is compatible with every cause there is — a local PTY carries no
  // exit code — so it names the EVIDENCE and leaves the cause unknown. Refusing to guess here is
  // what stops recovery looping on a real fault.
  if (o.terminator === "pty-exit") return { cause: "unknown", evidence: "pty-exit" };
  if (o.terminator === "session-end") return { cause: "unknown", evidence: "session-end-hook" };
  return UNOBSERVED;
}
