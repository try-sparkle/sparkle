// TURNING ONE SWEEP OF THE ROSTER INTO OBSERVATIONS — the step between "what the stores say" and
// "what the triggers can fire on".
//
// ── WHY THIS IS PURE, AND WHY IT TAKES PRIMITIVES ────────────────────────────────────────────────
// Everything here is data-in / data-out: a list of snapshots and the previous clocks go in,
// observations and the next clocks come out. No store, no Tauri, no `Date.now()`. That is what lets
// the two rules with real teeth — the duration clocks and the fail-closed defaults — be tested as
// arithmetic rather than by driving a running app.
//
// The snapshot deliberately carries PRIMITIVES (`goalSetAt`, `goalTtlMs`, `goalMetAt`) rather than
// the app's `AgentGoal`. `AgentGoal` lives in `apps/desktop/src/engine/agentGoal.ts` and imports
// `GoalVerify` from this package, so depending on it here would be a cycle. The adapter that reads
// the stores does that mapping; it is three field reads and it keeps this module free of the app.
//
// ── THE ONE RULE THAT MATTERS MOST HERE ──────────────────────────────────────────────────────────
// FAIL CLOSED. `undefined` means WE DID NOT LOOK, and it must never satisfy anything. This is
// `agentStall`'s rule, inherited verbatim because the reasoning transfers exactly:
//
//   "an ABSENT input never manufactures a stall… a stall claim that fires on missing data trains the
//    human to ignore the signal, which costs more than the stall did."
//
// It matters more for a Pusher than for a painted overlay, because the overlay is looked at when
// someone chooses to look, while a challenge arrives unasked. And the citation gate cannot save us:
// it refuses numbers absent from `measured`, so a number this module derived from missing data would
// pass — it really was "measured", just from nothing.

import { trackSince, elapsedSince, type SinceClock } from "./pusherClocks";
import type { Observation } from "./pusherTriggers";

/**
 * What one sweep saw about one partner. Every field is optional except the id, and every optional is
 * three-valued: present-and-true, present-and-false, or ABSENT — see the header.
 */
export interface PartnerSnapshot {
  agentId: string;
  /** Whether the partner is holding work that has not landed. `undefined` = not looked up. */
  hasUnlandedWork?: boolean;
  /** Commits ahead, where a poll supplied one. `undefined` = no count available (the common case). */
  unpushedCommits?: number;
  /** Whether the partner is waiting on a human answer — `status` in `waiting`/`approval`. */
  awaitingAnswer?: boolean;
  /** `goal.setAt`, epoch ms. */
  goalSetAt?: number;
  /** `goal.ttlMs`. */
  goalTtlMs?: number;
  /** `goal.metAt`. Present means met, at any time. */
  goalMetAt?: number;
  /** Open roborev reviews on this branch. Currently always 0 — see `pusherTriggers`. */
  roborevRounds?: number;
}

/**
 * The Pusher's own memory between sweeps. Two clocks, because the app records neither duration —
 * see `pusherClocks` for the four places that look like they would and do not.
 */
export interface ObserveState {
  /** agentId → when unlanded work was first seen in the CURRENT episode. */
  unlandedSince: SinceClock;
  /** agentId → when the partner was first seen awaiting an answer in the current episode. */
  awaitingSince: SinceClock;
}

/** An empty memory, for the first sweep and for tests. */
export function emptyObserveState(): ObserveState {
  return { unlandedSince: new Map(), awaitingSince: new Map() };
}

/**
 * Advance the clocks and build one `Observation` per partner.
 *
 * Returns the NEXT state rather than mutating: the caller owns persistence, exactly as it does for
 * the budget and the repeat stamps, so a sweep that throws part-way cannot leave a half-advanced
 * clock behind.
 *
 * A partner with nothing measurable still gets an observation. That is deliberate — `evaluateTriggers`
 * returns `[]` for it, and `persistedTriggers` needs that empty list to notice a condition CLEARED.
 * Omitting quiet partners would make every cleared condition look like a partner that vanished.
 */
export function observeFleet(
  snapshots: readonly PartnerSnapshot[],
  prev: ObserveState,
  now: number,
): { observations: Map<string, Observation>; next: ObserveState } {
  // Only agents where the condition is affirmatively TRUE advance a clock. `undefined` is excluded
  // by the `=== true` test rather than by falsiness, so "we did not look" and "we looked and it is
  // false" both correctly fail to start a clock — and both correctly CLEAR one that was running.
  const unlandedNow = snapshots.filter((s) => s.hasUnlandedWork === true).map((s) => s.agentId);
  const awaitingNow = snapshots.filter((s) => s.awaitingAnswer === true).map((s) => s.agentId);

  const next: ObserveState = {
    unlandedSince: trackSince(prev.unlandedSince, unlandedNow, now),
    awaitingSince: trackSince(prev.awaitingSince, awaitingNow, now),
  };

  const observations = new Map<string, Observation>();
  for (const s of snapshots) {
    // `setAt + ttlMs` is the expiry `goalStateOf` compares against. Both parts are required: a goal
    // with one and not the other is a partial read, not a goal that never expires.
    const goalExpiresAt =
      s.goalSetAt !== undefined && s.goalTtlMs !== undefined ? s.goalSetAt + s.goalTtlMs : undefined;

    const unlandedFor = elapsedSince(next.unlandedSince, s.agentId, now);
    const awaitingFor = elapsedSince(next.awaitingSince, s.agentId, now);

    observations.set(s.agentId, {
      hasUnlandedWork: s.hasUnlandedWork,
      unpushedCommits: s.unpushedCommits,
      // The clock hands back a DURATION; the trigger wants the instant it started. Converting here
      // rather than there keeps `pusherTriggers` a pure function of an observation, with no notion
      // that a clock exists.
      oldestUnpushedAt: unlandedFor === undefined ? undefined : now - unlandedFor,
      goalExpiresAt,
      goalMet: s.goalMetAt !== undefined,
      roborevRounds: s.roborevRounds ?? 0,
      questionUnansweredSince: awaitingFor === undefined ? undefined : now - awaitingFor,
      now,
    });
  }

  return { observations, next };
}
