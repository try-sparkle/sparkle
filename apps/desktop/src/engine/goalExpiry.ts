// goalExpiry — what to DO about a goal whose clock ran out.
//
// WHY THIS EXISTS. Expiry used to be a dead letter: `decideContinuation` answered
// `{action:"none", reason:"goal-expired"}` and nothing else in the app ever wrote to an expired
// goal. Nothing re-armed it, nothing closed it, nothing escalated it. So an agent whose four-hour
// TTL lapsed — most cheaply during a spend outage, when the continuation engine is correctly
// refusing to spend retries against a quota wall while the clock keeps running — was never
// auto-resumed again by anything, ever. Roughly twenty agents went calm gray in one day that way,
// each looking finished while holding open work.
//
// The fix is not to make expiry LOUDER. It is to make it a DECISION. Expiry stops being where the
// machine gives up and becomes the point where it looks at the work and resolves into one of four
// proven outcomes:
//
//   • the work landed and the tree is clean  → DISCHARGE (calm gray, on git's proof)
//   • the work is outstanding, budget remains → RE-ARM (extend the clock; the ordinary sweep resumes)
//   • budget spent, work visibly unlanded     → ABANDON (escalate, and raise the red cause)
//   • anything unproven                       → NOTHING (fail closed; never latch on a guess)
//
// ⚠️ WHAT THIS MODULE DELIBERATELY DOES NOT DO: promote `expired-goal` into a louder escalation tier.
// That membership was removed on evidence (bead sparkle-biezi) after expiry became the single biggest
// source of false red on the fleet, and `engine/stallEscalation` says in terms not to add it back.
// Every agent that outlives its TTL earns an `expired-goal`, so the tier built to stop a wall of
// false red would immediately start building a wall of amber. The loudness here is carried instead by
// the ABANDON outcome, whose gate is narrow enough that a clean agent can never reach it.
//
// EVERYTHING HERE IS PURE — the clock and the git evidence both arrive as parameters, so every rule
// below is tested as arithmetic rather than by waiting seven hours with a real repository.

import { DEFAULT_GOAL_TTL_MS, goalStateOf, type AgentGoal } from "./agentGoal";

/** How many times a lapsed goal may have its clock extended before a human is told.
 *
 *  Three is a bet on the shape of the outage rather than a round number: the common cause of an
 *  unattended lapse is a wall (a spend limit, a sleeping laptop) that clears on its own within an
 *  hour or two, and three extensions cover that without letting a genuinely dead agent hold a slot
 *  overnight in silence. */
export const MAX_TTL_REARMS = 3;

/** The clock a RE-ARMED goal gets: one hour, not the four a fresh goal gets.
 *
 *  `DEFAULT_GOAL_TTL_MS` is four hours because — in its own words — that is "short enough that a
 *  forgotten goal dies the same working day". Re-arming at the same generosity would make the real
 *  outer bound 4 + 3×4 = sixteen hours, which crosses a night and turns that sentence into a lie
 *  about the code. At one hour the outer bound is seven, the stated property survives, and each
 *  extension is a cheaper bet — which is the right shape for a decision nobody is watching. */
export const REARM_TTL_MS = 60 * 60_000;

/** How many times the clock actually ran out before abandonment: the INITIAL expiry plus one per
 *  extension. Reaching the abandon arm requires `rearms === MAX_TTL_REARMS`, and a goal only gets its
 *  first extension by having expired once — so the count a human is told is 4, not 3. */
const LAPSES_BEFORE_ABANDON = MAX_TTL_REARMS + 1;

/** The outer bound in hours, computed from the two TTLs it is actually made of.
 *
 *  ⚠️ THIS USED TO READ `MAX_TTL_REARMS + hours(REARM_TTL_MS) * MAX_TTL_REARMS`, which evaluates to
 *  3 + 1×3 = 6 while the module header states SEVEN. The first term used the re-arm COUNT as the
 *  initial TTL in hours — it only looked right because `MAX_TTL_REARMS` happens to sit near
 *  `DEFAULT_GOAL_TTL_MS` in hours, and it would have drifted silently the moment either constant
 *  moved. This is the one sentence a human reads to make the disposition call on the loudest signal
 *  in the app, so it is derived from the same constants the header's claim is. */
const OUTER_BOUND_HOURS = Math.round(
  (DEFAULT_GOAL_TTL_MS + REARM_TTL_MS * MAX_TTL_REARMS) / 3_600_000,
);

/**
 * What git says about an agent's work — the whole evidentiary basis for latching anything.
 *
 * ⚠️ EVERY BOOLEAN HERE IS REQUIRED, ON PURPOSE. Its producer returns the whole set of them or
 * `undefined`; there is no partially-known verdict. A shape that let one of them go missing would
 * invite exactly the reading this module must never make — treating "we did not look" as "there is
 * nothing there" — which is how an agent still holding work gets closed as finished.
 *
 * THE EXEMPT FIELDS — the two shas and `hasOpenPr` — are exempt on one stated test, not by taste: a
 * field may be optional only if it is read by exactly ONE arm, so its absence withholds that single
 * decision instead of colouring the others. Nothing is inferred from their absence anywhere else.
 * See {@link ExpiryProof.tipSha} and {@link ExpiryProof.hasOpenPr}. Every remaining field is read by
 * arms that can latch a goal permanently closed, and stays required.
 */
export interface ExpiryProof {
  /** Git positively says this agent's work is contained in the default branch. */
  landed: boolean;
  /** No uncommitted changes. */
  clean: boolean;
  /** Git positively says there is committed work the default branch does not contain. */
  unlanded: boolean;
  /** A pull request for this branch is open right now — or `undefined`, NOT LOOKED UP.
   *
   *  OPTIONAL FOR THE SAME REASON THE SHAS ARE, and it has to be: `prState: null` is the ordinary
   *  reading for a branch with no PR (the probe cannot distinguish "no PR" from "did not ask"), so
   *  requiring it made the producer answer `undefined` for the whole proof — and therefore made this
   *  entire module inert for the population it exists to rescue: an agent walled by an outage, work
   *  committed, no PR yet. Only the ABANDON gate consults it, so its absence withholds abandonment
   *  alone (`pr-state-unknown`) and leaves re-arm and discharge fully decidable. See that arm for why
   *  the refusal is QUIET rather than an escalation, and what it would take to close the gap. */
  hasOpenPr?: boolean;
  /** Is the worktree actually sitting on the branch this evidence describes? */
  worktreeOnBranch: boolean;
  /** The agent branch tip the reading was taken at.
   *
   *  THE ONE PAIR OF FIELDS THAT MAY BE ABSENT, and the exception is deliberate rather than a hole in
   *  the rule above. The shas are needed ONLY to make a discharge auditable; every other outcome is
   *  decided by the booleans. Requiring them for the whole proof would have made this entire module
   *  inert until the branch-status reading learns to carry them — re-arm included, which is the arm
   *  that recovers an agent walled by an outage. So their absence blocks exactly the one decision
   *  that depends on them (see `proof-unauditable`) and nothing else. */
  tipSha?: string;
  /** The `origin/<default>` tip it was compared against. */
  baseSha?: string;
}

/** Everything the decision needs, and nothing it can look up for itself.
 *
 *  ⚠️ THERE IS NO `rearms` FIELD, deliberately. It used to be one — a caller-supplied count compared
 *  against `MAX_TTL_REARMS`, which is this module's ONLY bound on the re-arm loop — while the
 *  authoritative value (`goal.ttlRearms`) sat in the same object. Nothing tied the two, and
 *  `rearmGoal` increments the goal's copy independently, so a caller passing a stale or zero count
 *  re-armed forever: the unbounded loop that typechecks, which `ttlRearms`' own docstring warns
 *  about. The count is now read from the goal the decision is ABOUT, so the two cannot disagree. */
export interface ExpiryInput {
  goal: AgentGoal | undefined;
  now: number;
  runtime: "local" | "cloud";
  /** Does this agent have a git worktree at all? Shell and chat agents do not. */
  hasWorktree: boolean;
  /** `undefined` means NOT LOOKED UP — never "nothing found". */
  proof: ExpiryProof | undefined;
}

/** Why no expiry action was taken. Every arm is a distinct sentence a human can act on, because the
 *  concierge reads these out — "we could not read its git state" and "its PR is still open" send a
 *  reader to completely different places. */
export type NoExpiryReason =
  | "not-expired"
  | "cloud-runtime"
  | "no-worktree"
  | "evidence-unreadable"
  | "worktree-parked"
  | "pr-open"
  | "pr-state-unknown"
  | "evidence-contradictory"
  | "landed-but-dirty"
  | "proof-unauditable"
  | "budget-spent-nothing-proved";

export type ExpiryDecision =
  | { action: "none"; reason: NoExpiryReason }
  | { action: "rearm"; rearms: number }
  | { action: "discharge"; sha: string; baseSha: string }
  | { action: "abandon"; evidence: string };

/**
 * Adjudicate one expired goal.
 *
 * READ THE ARMS IN ORDER — the sequence is the policy, and four of the orderings are load-bearing:
 *
 *   1. NOT-EXPIRED IS FIRST, so this module is structurally incapable of touching a goal in any other
 *      state however the evidence reads. `met`, `escalated`, `discharged` and plain `unmet` all leave
 *      here untouched, which is what keeps a second writer from fighting the continuation engine over
 *      the same record.
 *   2. THE CAPABILITY GATES COME BEFORE THE EVIDENCE, because for a cloud agent or a shell the local
 *      git reading is not weak evidence — it is evidence about the wrong thing, and refusing by name
 *      gives the human a true sentence instead of a confident wrong one.
 *   3. DISCHARGE OUTRANKS RE-ARM. Re-arming an agent that already finished is how a slot gets held
 *      all night: it would be resumed, find nothing to do, lapse again, and repeat until the budget
 *      ran out — three wasted restarts and a human paged at the end of them.
 *   4. ABANDON IS LAST AND NARROWEST, because it is the only arm that paints a row red.
 */
export function decideExpiry(input: ExpiryInput): ExpiryDecision {
  const { goal, now, runtime, hasWorktree, proof } = input;
  // Read from the goal under decision, not from a parallel parameter — see ExpiryInput. The `?? 0` is
  // stated once, here, which is the other half of why the field is gone.
  const rearms = goal?.ttlRearms ?? 0;

  if (goalStateOf(goal, now) !== "expired") return none("not-expired");

  // A cloud agent's work lives in a remote sandbox. Its local worktree is clean and empty, which
  // reads as `landed && clean` — a discharge on the strength of a tree that was never the work.
  if (runtime === "cloud") return none("cloud-runtime");
  // A shell or chat agent has no branch, so expiry really is only a clock for it, and calm gray is
  // the honest rendering. Without this arm every such agent would age into the amber "we could not
  // read your git state" band, which would be true and useless.
  if (!hasWorktree) return none("no-worktree");

  // FAIL CLOSED. `undefined` is "we did not look", and a latch written on a reading nobody took is
  // the false `done` this whole mechanism exists to abolish.
  if (proof === undefined) return none("evidence-unreadable");

  // A PARKED WORKTREE'S EVIDENCE BELONGS TO ANOTHER BRANCH, and this is the highest-volume way a
  // wrong latch could be written: `git checkout -b <topic>` is what a descriptive branch name looks
  // like, and it leaves the minted `sparkle/agent-<id>` ref behind with nothing on it. Measured on
  // the founder's machine, 21 of ~48 worktrees sat off their minted branch. For every one of those
  // the reading says "clean, nothing unlanded" about an agent doing real work somewhere else.
  // Attribution is unknown, so nothing may be concluded in either direction.
  if (!proof.worktreeOnBranch) return none("worktree-parked");

  if (proof.landed && proof.clean) {
    // A DISCHARGE WITHOUT ITS SHAS IS AN ASSERTION, NOT A PROOF, so refuse rather than latch one
    // nobody can audit. Note what this arm does NOT do: it does not fall through to re-arm. This
    // agent is finished — landed and clean — and re-arming a finished agent is how a slot gets held
    // all night, resumed to do nothing and lapsing three more times. Refusing here leaves the row
    // exactly where the founder's 2026-08-06 rule already puts it (expired + landed = calm gray), so
    // the degraded behaviour is today's behaviour rather than a new failure.
    if (proof.tipSha === undefined || proof.baseSha === undefined) {
      return none("proof-unauditable");
    }
    return { action: "discharge", sha: proof.tipSha, baseSha: proof.baseSha };
  }

  if (rearms < MAX_TTL_REARMS) return { action: "rearm", rearms: rearms + 1 };

  // ── THE BUDGET IS SPENT. Everything below decides between ABANDON and a named refusal. ─────────
  //
  // ⚠️ THE NON-ABANDON REFUSALS COME FIRST, and this order is the correction to the first version.
  // `pr-state-unknown` sat at the top of this block, above the three arms below — and since
  // `prState: null` is the ORDINARY reading, it pre-empted them for almost every agent: a landed
  // agent with a dirty tree was told "we never asked about its PR" instead of the true and
  // actionable `landed-but-dirty`, and an agent that committed nothing lost its own sentence too.
  // That is precisely what this file's doc block claims the optionality is EARNED by — "its absence
  // withholds that single decision instead of colouring the others" — so it has to gate abandonment
  // ONLY, which means it belongs immediately above the abandon return and nowhere else.

  // BOTH READINGS POSITIVE IS A CONTRADICTION. `landed && unlanded` is the squash-merge shape
  // (`ahead` never returns to zero once the tip stops being an ancestor), so it is common — and
  // telling a human "it produced no work" about an agent whose evidence says it committed plenty is
  // a false sentence on the surface the concierge reads out. Nothing may be concluded; say that.
  if (proof.unlanded && proof.landed) return none("evidence-contradictory");

  // LANDED, NOTHING OUTSTANDING, AND A DIRTY TREE. The discharge gate refused this one for the dirt
  // alone. What is actually true — the work landed, and there are uncommitted leftovers in the tree
  // — is also the thing a human can act on in a few seconds.
  if (proof.landed && !proof.clean) return none("landed-but-dirty");

  // Expired, budget spent, evidence readable — and the agent simply never committed anything. There
  // is nothing to abandon and nothing to discharge; it is a goal that ran out of time having
  // produced no work, which is a fact about the agent rather than about its branch.
  if (!proof.unlanded) return none("budget-spent-nothing-proved");

  // ── ONLY AN AGENT VISIBLY HOLDING UNLANDED WORK REACHES HERE ───────────────────────────────────

  // AN OPEN PR IS UNLANDED WORK THAT IS NOT STRANDED. It has been handed to CI and review, so nobody
  // is waiting on the founder for it — and abandoning here would light up every row with a PR in
  // flight, which is the false-red wall rebuilt on the first fleet-wide run.
  if (proof.hasOpenPr === true) return none("pr-open");

  // AND AN UNKNOWN PR READING CANNOT ABANDON EITHER — same fail-closed rule one field down.
  // `undefined` is "we did not ask", and abandoning on it would be the "we did not look" → "there is
  // nothing there" slide this module refuses. It is DISTINCT from `evidence-unreadable` so the
  // concierge can say which reading is missing.
  //
  // ⚠️ THIS REFUSES QUIETLY, AND A LOUDER VERSION WAS TRIED AND REVERTED — read this before adding
  // one back. The gap is real: `hasOpenPr` can be permanently `undefined`, so an agent that spent its
  // budget holding unlanded work is never spoken about again, which is the dead letter this module
  // exists to abolish, relocated to its last arm. The obvious fix — escalate once, amber — was
  // written, reviewed and taken back out, because it is WORSE than the silence:
  //
  //   • `readOpenPr` answers `undefined` when `workflowState` is ABSENT as well as when `prState` is
  //     null, and the gh PR probe is gated on a MOUNTED PANE (`runtimeStore`'s `probePrState` is
  //     "exactly the open/closed split"). So for every CLOSED-PANE agent — the majority of a large
  //     fleet — this arm is reached regardless of whether a PR is open, including agents whose work
  //     is safely with CI. That is the wall of amber the header above forbids in terms.
  //   • And it would be IRREVERSIBLE: `goalStateOf` short-circuits on `escalatedAt` before `expired`,
  //     so a later sweep that DOES read `prState: "open"` could never re-decide the row. Only a human
  //     clearing the retries would.
  //
  // The gap therefore needs a reliable PR reading for an unmounted pane, not a louder refusal here.
  // Tracked as `sparkle-nmqcb`; until then this stays quiet, which is at least recoverable.
  if (proof.hasOpenPr === undefined) return none("pr-state-unknown");

  // TWO INDEPENDENT READINGS MUST AGREE. `unlanded` is reached through the branch's ahead-count, and
  // that count never returns to zero after a squash merge — so on its own it is true for every
  // squash-landed agent forever. Requiring `landed` to be a positive NO as well is what keeps the
  // loudest signal in the app off the backs of agents whose work actually shipped.
  if (proof.unlanded && !proof.landed) {
    // ⚠️ THE SHAS ARE OPTIONAL, SO THE SENTENCE MUST READ WITHOUT THEM. Interpolating them
    // unconditionally printed "committed work that undefined does not contain (branch tip
    // undefined)" for EVERY abandonment the mount can currently reach — `BranchStatus` carries no
    // shas, so absent is the only state they have in production — and this string is not a log line:
    // it is the notification body a human reads and the `abandonedEvidence` the row keeps.
    const where =
      proof.tipSha !== undefined && proof.baseSha !== undefined
        ? `that ${proof.baseSha} does not contain (branch tip ${proof.tipSha})`
        : `the default branch does not contain`;
    return {
      action: "abandon",
      evidence:
        `Its goal lapsed ${LAPSES_BEFORE_ABANDON} times over roughly ${OUTER_BOUND_HOURS} hours, ` +
        `and git still shows committed work ${where}. Nothing is coming to land it.`,
    };
  }

  // UNREACHABLE BY CONSTRUCTION, and stated rather than dropped: every case that is not
  // `unlanded && !landed` was answered by one of the three named arms above the PR gates. Kept as
  // the total function's floor so a future edit that loosens one of those arms lands somewhere
  // honest instead of falling off the end.
  return none("budget-spent-nothing-proved");
}

function none(reason: NoExpiryReason): ExpiryDecision {
  return { action: "none", reason };
}
