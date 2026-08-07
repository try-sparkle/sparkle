// VERIFY BEFORE SPEAK — a finding may be emitted only if the thing it rests on is STILL TRUE at the
// moment it is emitted.
//
// ── THE DEFECT THIS CLOSES ───────────────────────────────────────────────────────────────────────
// The Pusher measures once and speaks later, and everything between those two moments is invisible
// to it. `deps.conflicts()` reads a store a poller refreshes every ten minutes; `hasUnlandedWork`
// comes from a branch poll keyed on the displayed project; an escalation is LATCHED and by
// construction never clears itself. Then `REPEAT_COOLDOWN_MS` is four hours. So the report's
// evidence can be hours old, and the sentences are written in the present tense.
//
// Measured, on one afternoon (2026-08-07), every one caught by checking against git rather than by
// trusting the report:
//
//   • #1358 and #1406 reported as "mergeable but drifting behind main". BOTH WERE ALREADY MERGED.
//   • A goal reported as escalated with "something is blocking it that restarting cannot fix" — all
//     three PRs it named were already mergeable with CI runs. The goal was MET. The agent had
//     finished and was being reported as stuck.
//   • Twice an agent reported as "met their goal with no unlanded work, safe to retire" while it was
//     MID-MERGE. Retiring either would have destroyed work.
//
// None of these is a bug in the arithmetic. `pusherFleet` composed exactly the right sentence about
// exactly the evidence it was handed. The evidence was stale, and nothing re-read it.
//
// ── THE SHAPE OF THE FIX: RE-READ THE OBSERVABLE, NOT THE SENTENCE ───────────────────────────────
// A finding is not re-judged. Re-judging would be a second opinion about the same PR, invisible to
// the producer's own tests — the failure `fleetVerdict` names and `pusherSnapshots` refuses. What is
// re-read is the FACT the finding rests on, and the only thing that can happen to it is that it
// turns out to be false, in which case the EVIDENCE is dropped and the report is recomposed from
// what is left. The sentence a surviving finding gets is byte-identical to the one it would have
// had; the arithmetic in `pusherFleet` is untouched.
//
// This is the same discipline `verify: {kind:"landed"}` already enforces on goals, and that one
// works for precisely this reason: GIT ANSWERS, the agent does not.
//
// ── A CLAIM, NOT A SUBJECT — and this is the one thing easy to get backwards ─────────────────────
// Each {@link PusherClaim} names WHAT IS BEING ASSERTED, never merely which PR or agent is involved.
// The two unlanded-work claims are the reason. One agent's branch supports two OPPOSITE findings:
//
//   • `done-not-retired` says "no unlanded work, safe to retire" — it rests on
//     `agent-has-no-unlanded-work`, and is refuted by FINDING commits.
//   • `unpushed-commits` says "you are holding work" — it rests on `agent-holds-unlanded-work`, and
//     is refuted by finding NONE.
//
// Keyed by subject (`agent:<id>`), one verdict would have to mean both things at once, and whichever
// direction the verifier picked would silently invert the other finding. Keyed by claim, `refuted`
// always means exactly one thing: THAT ASSERTION IS FALSE NOW.
//
// ── `unreadable` IS NOT A REFUTATION, AND THAT IS THE WHOLE SAFETY ARGUMENT ──────────────────────
// The standing rule is never to hide a row that needs the founder. A re-read that could not be taken
// — `gh` unauthenticated, offline, a saturated list, a goal whose kind no machine can answer —
// establishes NOTHING, and must leave the finding exactly as it was. Only an affirmative reading
// that CONTRADICTS the claim may drop it.
//
// Failing the other way would rebuild the original bug pointed backwards: a network blip would
// silence a real fleet-wide block, and silence is the failure mode this whole feature exists to
// eliminate. It is also why a claim NOBODY ASKED ABOUT is left alone: an absent verdict and an
// unreadable one are the same fact — nothing was learned — and neither may edit evidence.
//
// ── PURE ────────────────────────────────────────────────────────────────────────────────────────
// No clock, no store, no I/O, no model. It says WHICH facts a set of findings rests on, and it
// prunes evidence given somebody else's readings. The reading itself belongs to the caller that owns
// git and the GitHub API, and keeping it out is what makes every rule below testable as arithmetic.

import type { ConflictingPr, FleetCondition, FleetSnapshot } from "./pusherFleet";
import type { Observation, Trigger } from "./pusherTriggers";

/**
 * One assertion a finding rests on, phrased so that `refuted` can only mean one thing.
 *
 * See the header for why these are CLAIMS rather than subjects — the two unlanded-work entries look
 * redundant and are the reason the type exists in this shape.
 */
export type PusherClaim =
  /**
   * This pull request is still OPEN.
   *
   * Refuted by a merge or a close. This is the claim under every `pr-conflicting` line: both the
   * conflicting rows ("cannot merge, and therefore untested") and the stale ones ("mergeable, but
   * drifting further with every merge") are statements about a PR that is still waiting, and a
   * merged PR makes both of them false rather than merely out of date.
   */
  | { kind: "pr-open"; pr: number }
  /**
   * This agent IS holding work that has not landed — what `unpushed-commits` challenges it about.
   *
   * Refuted when git says the branch is already contained in `origin/main`. That is the founder's
   * "an agent whose branch is an ancestor of origin/main must not be reported as having unlanded
   * work": telling a partner to push work that has already shipped is advice to redo finished work.
   */
  | { kind: "agent-holds-unlanded-work"; agentId: string }
  /**
   * This agent is holding NOTHING unlanded — the load-bearing half of "safe to retire".
   *
   * Refuted the moment git finds commits, and this is the most expensive claim in the Pusher to be
   * wrong about. It is not a noisy message: `done-not-retired` tells the founder a row is safe to
   * discard, and `spin_down_worker` deletes a worktree. Two agents were reported this way MID-MERGE.
   */
  | { kind: "agent-has-no-unlanded-work"; agentId: string }
  /**
   * This agent's goal is NOT yet satisfied — what an escalation and an expiry both presuppose.
   *
   * Refuted when the goal's own `verify` kind answers YES at emit time. An escalated goal whose
   * success condition is already true is an agent being punished for succeeding, and it is the one
   * class the app RESERVES for the human — so a false one costs a person's attention directly.
   */
  | { kind: "goal-unmet"; agentId: string };

/**
 * What a re-read said about one claim.
 *
 * THREE-VALUED, and the third value is the point. `unreadable` is what an unauthenticated `gh`, an
 * offline machine, a saturated PR list and a `{kind:"human"}` goal all produce, and it must be
 * strictly weaker than `holds` — it licenses no change to the evidence in EITHER direction. See the
 * header: only a contradiction may drop a finding.
 */
export type ClaimVerdict = "holds" | "refuted" | "unreadable";

/** claim key → verdict. A claim ABSENT from the map was never asked, which reads exactly as `unreadable`. */
export type ClaimVerdicts = ReadonlyMap<string, ClaimVerdict>;

/**
 * The stable identity of a claim — what a verifier keys its answers by.
 *
 * The kind is part of the key and cannot be dropped as redundant: `agent-holds-unlanded-work` and
 * `agent-has-no-unlanded-work` are the SAME agent and OPPOSITE claims, so a key built from the
 * subject alone would let one finding's verdict silently decide the other's, in the wrong direction.
 */
export function claimKey(claim: PusherClaim): string {
  return claim.kind === "pr-open" ? `pr-open:${claim.pr}` : `${claim.kind}:${claim.agentId}`;
}

/** Read one claim's verdict. Absent means nobody looked, which is {@link ClaimVerdict} `unreadable`. */
export function verdictOf(verdicts: ClaimVerdicts, claim: PusherClaim): ClaimVerdict {
  return verdicts.get(claimKey(claim)) ?? "unreadable";
}

/** Was this claim affirmatively CONTRADICTED? The only condition under which evidence may be dropped. */
function isRefuted(verdicts: ClaimVerdicts, claim: PusherClaim): boolean {
  return verdictOf(verdicts, claim) === "refuted";
}

/**
 * Every claim the given fleet conditions rest on — the exact set to re-read before speaking.
 *
 * ── DERIVED FROM THE EVIDENCE, NEVER PARSED OUT OF `members` OR THE TEXT ─────────────────────────
 * `FleetCondition.members` carries `pr:<number>` strings that would parse, and the text quotes every
 * PR number. Both are DISPLAY, and a verifier keyed on display breaks the moment a sentence is
 * reworded — silently, by asking about nothing and therefore refuting nothing, which is the failure
 * shape this module exists to remove. The conditions say WHICH CLASSES fired; the evidence says what
 * they were built from.
 *
 * ── THREE CLASSES DELIBERATELY YIELD NOTHING ────────────────────────────────────────────────────
 * `quota-blocked` is already re-checked against `now` on every sweep by `isQuotaWalled`, so its
 * staleness is bounded by the sweep interval rather than by the cooldown. `shared-failure` is
 * bounded the same way by `SHARED_FAILURE_MAX_AGE_MINUTES` and quotes its own age in the text.
 * `duty-overdue` is arithmetic over a clock this process owns. None of the three has an observable
 * that a re-read could contradict, so asking about them would spend I/O to learn nothing.
 *
 * That is a statement about TODAY'S six classes, not a rule. A class added later whose evidence can
 * go stale between sweeps belongs here, and the cost of forgetting is exactly the defect above.
 */
export function claimsForConditions(
  conditions: readonly FleetCondition[],
  snapshots: readonly FleetSnapshot[],
  conflicts: readonly ConflictingPr[] | undefined,
): PusherClaim[] {
  const out: PusherClaim[] = [];
  const seen = new Set<string>();
  const add = (claim: PusherClaim): void => {
    const key = claimKey(claim);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(claim);
  };

  const byId = new Map(snapshots.map((s) => [s.agentId, s] as const));

  for (const condition of conditions) {
    switch (condition.id) {
      case "pr-conflicting":
        // EVERY conflict, not the ones whose owner resolved. `conflictCondition` is built from the
        // whole list and `agentIds` holds resolved owners only — which for the five PRs that
        // motivated the class is NONE. Reading the claims off `agentIds` would ask about nothing
        // for exactly the case the class exists to find.
        for (const c of conflicts ?? []) add({ kind: "pr-open", pr: c.pr });
        break;
      case "goals-escalated":
        for (const agentId of condition.agentIds) add({ kind: "goal-unmet", agentId });
        break;
      case "done-not-retired":
        for (const agentId of condition.agentIds) {
          add({ kind: "agent-has-no-unlanded-work", agentId });
          // The retire claim ALSO presupposes the goal really was met. `goalMetAt` is latched on the
          // agent's own word (`set_agent_goal_met`), so re-reading it is the same discipline applied
          // one field over — and getting it wrong points at discarding an agent, not at a message.
          if (byId.get(agentId)?.goalMetAt !== undefined) add({ kind: "goal-unmet", agentId });
        }
        break;
      // No observable that a re-read can contradict — see the note above.
      case "quota-blocked":
      case "shared-failure":
      case "duty-overdue":
        break;
    }
  }
  return out;
}

/**
 * Every claim one partner's triggers rest on.
 *
 * `roborev-rounds` and `unanswered-question` yield nothing: both are counts over local state this
 * process already reads fresh each sweep, so there is no second source for a re-read to disagree
 * with. Adding a hop that can only ever answer `unreadable` would be cost with no verdict.
 */
export function claimsForTriggers(
  triggers: readonly Trigger[],
  agentId: string,
): PusherClaim[] {
  const out: PusherClaim[] = [];
  for (const trigger of triggers) {
    if (trigger.id === "unpushed-commits") out.push({ kind: "agent-holds-unlanded-work", agentId });
    if (trigger.id === "goal-expired") out.push({ kind: "goal-unmet", agentId });
  }
  return out;
}

/** The evidence a fleet report is composed from — everything a verdict may edit, and nothing else. */
export interface FleetEvidence {
  snapshots: readonly FleetSnapshot[];
  /** `undefined` is WE DID NOT LOOK and survives every prune — see {@link pruneRefutedFleetEvidence}. */
  conflicts: readonly ConflictingPr[] | undefined;
}

/**
 * The same evidence with every REFUTED fact removed, ready to be re-evaluated.
 *
 * ── WHY PRUNE EVIDENCE RATHER THAN DROP FINDINGS ────────────────────────────────────────────────
 * A `FleetCondition` is a finished sentence over a whole cohort: "3 open PRs cannot merge…" followed
 * by three lines. Dropping one merged PR from that is not a filter, it is a REWRITE — the count in
 * the headline, the plural, the `measured` whitelist and the remedy sentence all change together,
 * and a report whose text and `measured` disagree is refused wholesale by `gateChallenge` as
 * `fabricated-citation`, which presents as SILENCE. So the pruning happens upstream of composition
 * and `pusherFleet` recomposes from scratch, exactly as it would have if the merged PR had never
 * been in the list. There is one composer, and it stays the only one.
 *
 * ── `undefined` CONFLICTS SURVIVE AS `undefined` ────────────────────────────────────────────────
 * Never coerced to `[]`. A prune cannot manufacture the claim "we looked and every PR is fine" out
 * of "nothing has looked yet" — that is the exact conflation `conflictFlags` spends its header
 * refusing, and it would arrive here through the back door.
 */
export function pruneRefutedFleetEvidence(
  evidence: FleetEvidence,
  verdicts: ClaimVerdicts,
): FleetEvidence {
  const conflicts =
    evidence.conflicts === undefined
      ? undefined
      : evidence.conflicts.filter((c) => !isRefuted(verdicts, { kind: "pr-open", pr: c.pr }));

  const snapshots = evidence.snapshots.map((s) => {
    let next = s;
    // REFUTED "no unlanded work" MEANS COMMITS WERE FOUND, so the snapshot is corrected to say so
    // rather than merely having the field cleared. `retirableAgents` demands an affirmative `false`,
    // so `undefined` would also suppress the retire claim — but it would ALSO suppress it for an
    // agent nobody could read, which is the fail-closed rule doing something different. Recording
    // what git actually said keeps the two apart in a log.
    if (isRefuted(verdicts, { kind: "agent-has-no-unlanded-work", agentId: s.agentId })) {
      next = { ...next, hasUnlandedWork: true };
    }
    // A GOAL WHOSE CONDITION IS ALREADY TRUE IS NOT A DEAD END. Escalation is the only field the
    // `goals-escalated` class reads, so dropping it is what stops the report describing a finished
    // agent as blocked.
    //
    // `goalMetAt` IS DELIBERATELY NOT WRITTEN. Latching "met" is a state change with consequences
    // well beyond this report — it is what makes an idle agent count as done — and this module has
    // no authority to make it and no timestamp that is not invented. Closing the goal is the
    // RESOLVER's job (see `pusherResolve`); all that happens here is that the Pusher stops saying
    // something untrue about it.
    if (isRefuted(verdicts, { kind: "goal-unmet", agentId: s.agentId }) && next.escalation !== undefined) {
      const { escalation: _dropped, ...rest } = next;
      next = rest;
    }
    return next;
  });

  return { snapshots, conflicts };
}

/**
 * One partner's observation with every refuted fact corrected.
 *
 * Returns the SAME object when nothing was refuted, so a caller can tell "verification changed
 * something" from "verification confirmed everything" by identity, without re-deriving it.
 */
export function pruneRefutedObservation(
  observation: Observation,
  agentId: string,
  verdicts: ClaimVerdicts,
): Observation {
  let next = observation;

  // ALREADY LANDED. `isHoldingWork` fires on EITHER piece of affirmative evidence, so both have to
  // be corrected or the trigger survives on the other one — `unpushedCommits: 4` alone is enough to
  // re-raise `unpushed-commits` about work that is already on origin/main.
  if (isRefuted(verdicts, { kind: "agent-holds-unlanded-work", agentId })) {
    next = { ...next, hasUnlandedWork: false, unpushedCommits: 0 };
  }

  // A goal whose condition is satisfied is never an expiry, however long ago the TTL elapsed —
  // `evaluateTriggers` already states that rule for `goalMet`, and this routes git's answer into it
  // rather than writing a second one beside it.
  if (isRefuted(verdicts, { kind: "goal-unmet", agentId })) {
    next = { ...next, goalMet: true };
  }

  return next;
}
