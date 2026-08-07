// resurrection — may this dead agent be brought back, and not before when?
//
// The per-agent gate. Its sibling `resurrectionCohort.ts` decides who goes FIRST when many agents
// died of one cause; this module decides whether a given agent is eligible at all.
//
// ── WHY IT IS NOT `apiRecovery`, WHICH LOOKS LIKE THE SAME THING ──────────────────────────────
// `engine/apiRecovery.ts` already ships a deterministic revive ladder, and it is good. It works by
// TYPING TEXT INTO A LIVING PTY — `decideRevive` refuses anything whose process is not still alive.
// So it cannot help a process that is GONE, which is every one of the 10 ENOTFOUND deaths and all
// 103 deaths from the two app quits on 2026-08-06. The two modules are disjoint on the liveness
// axis BY CONSTRUCTION: `errored + alive` is apiRecovery's, `errored + dead` is this one's. That
// mirror gate is asserted here, so the pair cannot start fighting silently.
//
// ── NO MODEL CALL ON ANY PATH ─────────────────────────────────────────────────────────────────
// When the wall is fleet-wide every LLM in the app is gated by the same account limit, so a
// recovery path that consults one is dead exactly when it is needed. This module is comparisons.
//
// PURE. Data in, data out; the clock arrives as a parameter.
import { REVIVE_LADDER_MS } from "./apiRecovery";
import { type DeathCause, armsOnClock, isResurrectable } from "./deathTypes";

/**
 * The respawn ladder, DERIVED from `apiRecovery.REVIVE_LADDER_MS` so the two curves cannot drift.
 *
 * The first three rungs (5s, 15s, 30s) are dropped, and that is the one real difference between a
 * revive and a respawn: a ping is a keystroke, while a respawn costs a worktree prep, a transcript
 * scan, an account pick, a `claude --resume` boot and the model re-reading its whole context.
 * Retrying that at 5s is a fork bomb, not a ladder.
 *
 * Yields 60s, 2m, 3m, 5m, 10m, 15m, 20m, 30m — 8 rungs, 1h 26m total. Both the shape and the total
 * are pinned BY VALUE in the tests, following this repo's own discipline, so an upstream edit to
 * `REVIVE_LADDER_MS` is NOTICED here rather than silently inherited.
 */
export const RESURRECT_LADDER_FIRST_RUNG = 3;
export const RESURRECT_LADDER_MS: readonly number[] = REVIVE_LADDER_MS.slice(
  RESURRECT_LADDER_FIRST_RUNG,
);

/**
 * THE LADDER IS A CEILING, NOT A CLIFF: past the last rung the gap STAYS at 30 minutes.
 *
 * This was originally a cliff, and the cliff was a bug that defeated the feature's main purpose
 * (roborev 60067). A monthly spend cap has no reset instant — it lifts when a human raises it,
 * which may be hours later — and the only way an agent comes back from one is by PROBING until a
 * probe succeeds. An episode that stops probing has simply lost that agent until someone notices,
 * which is the behaviour this whole module exists to end.
 *
 * So the backoff escalates to 30 minutes and then holds there. That is exactly the founder's
 * "exponential backoff with a ceiling"; the hard stop is the per-agent cap below, not the ladder.
 */
export const RESURRECT_LADDER_CEILING_MS =
  RESURRECT_LADDER_MS[RESURRECT_LADDER_MS.length - 1] ?? 30 * 60_000;

/**
 * The cross-episode backstop: total respawns allowed for one agent in a rolling 24h.
 *
 * Two bounds, and neither is redundant. The ladder governs PACE — after the ceiling above, at most
 * one attempt every 30 minutes, which is what actually prevents thrash. This one governs TOTAL, it
 * depends on nothing, and it is why a misidentified episode cannot become an unbounded loop.
 *
 * It MUST be counted in the durable ledger, not in memory: the largest killer of agents is the app
 * restart, which would zero an in-memory counter — the exact event the cap exists to survive.
 *
 * Why 24. It was 5, and 5 was WRONG in a way worth recording: the cap is checked before the ladder,
 * so a cap below the ladder's length made the last three rungs unreachable and burned an agent's
 * entire daily budget in 21 minutes — after which a wall lifting at hour three was never probed.
 * At the 30-minute ceiling, 24 attempts span at least ten hours of probing, which covers a session
 * limit and a same-day spend-cap raise, while still bounding the measured worst case (one session
 * retried into a closed door 45 times) well below what actually happened.
 */
export const MAX_RESURRECTS_PER_AGENT_PER_DAY = 24;
export const RESURRECT_DAY_MS = 24 * 60 * 60_000;

/** Why no respawn happened. A named reason rather than a bare `false`, mirroring
 *  `apiRecovery.NoReviveReason` and `goalContinuation.NoContinueReason` — this is the field a human
 *  reads when they ask why a dead row was left alone. */
export type NoResurrectReason =
  /** Nothing recorded this agent's death, so there is nothing to act on. */
  | "no-death-record"
  /** It is not dead. Respawning a live agent orphans the first child — see the double-spawn note. */
  | "already-live"
  /** It finished. Never resurrect, under any circumstance. */
  | "clean-goal-met"
  /** A person is the blocker; a respawn re-asks nothing. Escalate the question instead. */
  | "blocked-on-human"
  /** Observed, but nothing said why. The one case where being wrong loops on a real fault. */
  | "unclassified-death"
  /** A session wall whose stated reset instant has not arrived. */
  | "wall-not-yet-reset"
  /** On the ladder, between rungs. */
  | "waiting-for-next-rung"
  /** The rolling 24h per-agent cap is exhausted. This is the ONLY terminal bound on retrying — the
   *  ladder plateaus rather than ending, so there is deliberately no "ladder-spent". */
  | "daily-cap-spent";

export type ResurrectionDecision =
  | { action: "respawn"; attempt: number }
  | { action: "none"; reason: NoResurrectReason };

export interface ResurrectionInput {
  /** From the durable ledger. `undefined` when no record exists. */
  cause: DeathCause | undefined;
  /**
   * Is the agent's PROCESS still alive?
   *
   * `boolean | undefined`, and the polarity matters: only an explicit `false` permits a respawn.
   * `undefined` means "this window cannot tell", and respawning on a maybe is what orphans a live
   * child — `pty.rs`'s session map REPLACES silently, so the first process keeps running, keeps
   * holding its worktree, keeps burning tokens, and is invisible to every surface.
   */
  processAlive: boolean | undefined;
  /** Epoch ms the wall is expected to lift. Present only for `wall-session`. */
  notBeforeMs: number | undefined;
  /** Respawns already spent on THIS death episode. */
  attemptsThisEpisode: number;
  /** Epoch ms of the last respawn attempt, if any. */
  lastAttemptAt: number | undefined;
  /** Epoch ms the death was recorded — the first rung is measured from here. */
  diedAt: number;
  /** Epoch-ms timestamps of respawns in the rolling window, from the DURABLE ledger. */
  recentAttemptsAt: readonly number[];
  now: number;
}

/** When the next rung is due. ALWAYS defined: past the last rung the gap holds at the ceiling, so an
 *  agent waiting on a wall only a human can lift keeps probing. Exported so a caller can show "next
 *  try in 3m" without re-deriving the curve. */
export function nextRungDueAt(input: {
  attemptsThisEpisode: number;
  lastAttemptAt: number | undefined;
  diedAt: number;
}): number {
  const gap = RESURRECT_LADDER_MS[input.attemptsThisEpisode] ?? RESURRECT_LADDER_CEILING_MS;
  // Gaps are measured from the LAST attempt, or from the death itself for the first rung — the same
  // convention `REVIVE_LADDER_MS` documents, so the two read alike.
  return (input.lastAttemptAt ?? input.diedAt) + gap;
}

/** Respawns inside the rolling 24h window. Counted here rather than by the caller so the window
 *  edge is defined in one place. */
export function attemptsInWindow(recentAttemptsAt: readonly number[], now: number): number {
  const floor = now - RESURRECT_DAY_MS;
  return recentAttemptsAt.filter((t) => t > floor).length;
}

/**
 * Decide whether to respawn one dead agent.
 *
 * GATE ORDER IS THE POLICY. Terminal classifications are checked FIRST — before liveness, before
 * rungs, before caps — so that "it finished" or "a person is waiting" never surfaces as
 * "waiting-for-next-rung", and never spends a rung it should not have. Same discipline
 * `decideContinuation` uses for its quota gate.
 */
export function decideResurrection(input: ResurrectionInput): ResurrectionDecision {
  const { cause } = input;

  // ── 1. Terminal, before anything else can mask them ─────────────────────────────────────────
  if (cause === undefined) return { action: "none", reason: "no-death-record" };
  if (cause === "clean-goal-met") return { action: "none", reason: "clean-goal-met" };
  if (cause === "blocked-on-human") return { action: "none", reason: "blocked-on-human" };
  if (!isResurrectable(cause)) return { action: "none", reason: "unclassified-death" };

  // ── 2. Liveness, failing CLOSED ─────────────────────────────────────────────────────────────
  // Only an explicit `false` gets past. This is the mirror of `decideRevive`'s gate, and the pair of
  // them is what keeps this module and apiRecovery from ever acting on the same agent.
  if (input.processAlive !== false) return { action: "none", reason: "already-live" };

  // ── 3. The wall's own clock ─────────────────────────────────────────────────────────────────
  // Only `wall-session` names an instant. A spend cap has none and must never be gated on one — it
  // is recovered by PROBING, which is why it falls straight through to the ladder below and comes
  // back by itself the moment a probe succeeds.
  if (armsOnClock(cause) && input.notBeforeMs !== undefined && input.now < input.notBeforeMs) {
    return { action: "none", reason: "wall-not-yet-reset" };
  }

  // ── 4. Caps. The durable one first, so a misidentified episode cannot outrun it ──────────────
  if (attemptsInWindow(input.recentAttemptsAt, input.now) >= MAX_RESURRECTS_PER_AGENT_PER_DAY) {
    return { action: "none", reason: "daily-cap-spent" };
  }

  // ── 5. The ladder, which plateaus rather than ending ────────────────────────────────────────
  if (input.now < nextRungDueAt(input)) return { action: "none", reason: "waiting-for-next-rung" };

  return { action: "respawn", attempt: input.attemptsThisEpisode + 1 };
}
