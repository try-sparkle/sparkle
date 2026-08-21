// epicGoal — an EPIC's goal, on the SAME machinery as an agent's goal, minus the parts that only
// make sense for one agent session.
//
// ── THE FOUNDER SETTLED THE CONCEPT QUESTION: "same machinery" ────────────────────────────────
// Asked directly whether an epic goal is the same thing as an agent goal (verify kind, escalation
// state, bounded continue ladder) or a different thing, he answered "same machinery". So this is
// NOT a second goal type with its own rules — two things called "goal" with different rules is how
// the status vocabulary got confusing in the first place. `EpicGoalShared` is a `Pick` of
// `AgentGoal`, which makes the claim COMPILER-CHECKED rather than a promise in a comment: rename or
// retype any of those fields on `AgentGoal` and this file stops compiling.
//
// ── WHAT IS DELIBERATELY *NOT* INHERITED, AND WHY ─────────────────────────────────────────────
// Reusing the machinery means inheriting verify kinds AND the bounded continue/escalation ladder.
// An epic legitimately spans days, so three of those parts are wrong for it — each for a different
// and concrete reason, not merely because they are mis-tuned:
//
//   • THE TTL CLOCK (`ttlMs`, `rearmedAt`, `ttlRearms`, engine/goalExpiry) — DROPPED.
//     `DEFAULT_GOAL_TTL_MS` is four hours, and its own docstring says why: it is the outermost bound
//     on how long AUTO-CONTINUE may keep spending on one agent. Nothing auto-continues an epic, and
//     an epic that is a week old is ordinary. Inheriting it would paint every epic goal `expired` by
//     the next morning — a wall of false red, which is precisely what teaches a human to ignore the
//     one alarm that is real.
//   • THE AUTO-CONTINUE LADDER (`continues`, `totalContinues`, `mark`, engine/goalContinuation) —
//     DROPPED. It restarts an agent BY TYPING INTO ITS PTY. An epic has no PTY, so this is
//     inapplicable rather than mis-tuned.
//   • ESCALATION (`escalatedAt`, `escalationReason`, …) — DROPPED, because the epic-level equivalent
//     ALREADY EXISTS and is deliberately disjoint: `engine/epicContinuation` sweeps epics that stop
//     moving (2h stall window, 14-day reach, restart/escalate/clear). Its own header enumerates the
//     four recovery sweeps and states that they must not fight. Putting epic goals on the agent
//     ladder creates the fifth sibling that header warns against.
//
// `verify` IS inherited, minus one kind — see {@link epicVerifyOf}.
//
// PURE. The clock arrives as a parameter, never `Date.now()`, exactly as in engine/agentGoal.
import { GOAL_MAX_LEN, GOAL_MIN_LEN, inferGoalVerify, type GoalVerify } from "@sparkle/core";

import type { AgentGoal } from "./agentGoal";

/**
 * The fields an epic goal shares with an agent goal, with IDENTICAL meaning.
 *
 * This is a `Pick` and not a hand-copied field list on purpose. A hand-copied list is what lets two
 * halves of one concept drift while both suites stay green; a `Pick` fails the build instead.
 */
export type EpicGoalShared = Pick<
  AgentGoal,
  "text" | "setAt" | "metAt" | "verify" | "verifyStated"
>;

/** Who wrote the goal text that is on the epic right now. */
export type EpicGoalSource = "auto" | "human";

/**
 * An epic's goal.
 *
 * Stored on `Project.epicGoals`, keyed by the epic bead's id — the same persisted store `AgentTab.goal`
 * already lives in, which is what "same machinery" means concretely. It is NOT stored on the bead:
 * there is no bd write path for a description (`BeadPatch` carries status/priority/assignee in both
 * TS and Rust), and manufacturing one would mean rewriting a shared Dolt store that has no diff and
 * no revert — the wrong trade for a display field.
 */
export interface EpicGoal extends EpicGoalShared {
  /**
   * Where the text came from. This is the field that satisfies the founder's first constraint on
   * auto-generation: an auto-written goal must be VISIBLY DISTINGUISHABLE from one he wrote.
   * `"auto"` paints a badge; `"human"` paints nothing, because his own words are the default reading.
   */
  source: EpicGoalSource;
  /**
   * Epoch ms a HUMAN (directly, or via the concierge acting on their instruction) last wrote this
   * goal. THE LATCH: once present, automatic regeneration never fires for this epic again.
   *
   * ⚠️ It is a LATCH and not merely `source === "human"`, and the difference is load-bearing. A
   * human may clear a goal back to empty, or a later explicit regenerate may set `source` back to
   * `"auto"` — and neither of those may re-open the door to the machine silently overwriting his
   * wording later. Silently overwriting it is the single failure that would make him stop trusting
   * the field, so the thing that records "a person has had an opinion about this" has to outlive
   * whatever the text currently says.
   */
  humanEditedAt?: number;
  /**
   * Epoch ms the last generation ATTEMPT produced nothing, and one sentence naming why.
   *
   * These exist so a failed generation is a RECORDED absence rather than an untried one — the
   * founder's second constraint is "on failure or timeout, NO goal rather than a bad one", and an
   * empty field with no explanation cannot be told apart from an epic nobody has generated for yet.
   *
   * ⚠️ THEY DO NOT IMPLY AN EMPTY `text`, AND EVERY CONSUMER MUST HANDLE THE PAIR (roborev 65856).
   * This docstring used to say "when either is present, `text` is empty", and that was true only
   * while a failure BLANKED an existing goal — the data-loss bug on the `force` regenerate path.
   * Now a record may legitimately carry a goal AND a failure reason at once: the goal that is still
   * in force, plus why the regenerate someone asked for produced nothing. A reader that branches
   * "generation failed ⇒ show the empty state" would paint over a live goal. Branch on
   * {@link hasEpicGoalText} for whether there is anything to READ, and on these for whether to
   * offer a retry.
   */
  generationFailedAt?: number;
  generationFailureReason?: string;
}

/**
 * The verify kinds an EPIC goal may carry.
 *
 * `landed` is REFUSED, and this is the one place the inherited vocabulary is narrowed. `canSelfMarkMet`
 * answers `{kind:"landed"}` from `GoalVerifyEvidence.landed`, which `services/agentGoalReading`
 * computes from ONE agent's branch reachability. An epic is not a branch and has no agent, so there
 * is no evidence source that could ever supply it — a `landed` epic goal would be permanently
 * unmarkable. That is not a harmless no-op: it is an advertised signal that never arrives, which is
 * the exact inert-feature failure PRD/sparkle/concierge-goal-autonomy.md records.
 */
export const EPIC_GOAL_VERIFY_KINDS = ["command", "human"] as const;

/** Is this a check an epic goal may carry? */
export function isEpicVerifyKind(kind: string): boolean {
  return (EPIC_GOAL_VERIFY_KINDS as readonly string[]).includes(kind);
}

/**
 * Narrow a `GoalVerify` to something an epic can actually carry.
 *
 * `landed` becomes `human` rather than being dropped: the goal still needs SOMEONE to close it, and
 * dropping the check entirely would make it self-markable, which is a WIDENING. The repo's standing
 * rule on inference is that it may only ever move a goal toward a machine-checkable check, never
 * away from one; falling back to `human` respects that in the one direction available here.
 */
export function epicVerifyOf(verify: GoalVerify | undefined): GoalVerify | undefined {
  if (!verify) return undefined;
  return isEpicVerifyKind(verify.kind) ? verify : { kind: "human" };
}

/** The check a goal with this text should carry, already narrowed for an epic. */
export function inferEpicVerify(text: string): GoalVerify | undefined {
  return epicVerifyOf(inferGoalVerify(text));
}

/**
 * Is this goal text usable at all?
 *
 * Reuses `@sparkle/core`'s worker-goal bounds rather than inventing a second pair of numbers, so a
 * one-word hallucination is refused by the SAME rule that refuses a one-word worker goal. Callers
 * treat a refusal from the generator as a FAILURE (no goal written), never as something to save
 * anyway — an empty field is honest, a bad one is worse than nothing.
 */
/**
 * The goal text, normalised the way {@link newEpicGoal} normalises it, so an edit that changes only
 * whitespace is recognised as a no-op instead of costing a write and a poll round-trip.
 *
 * CANONICAL, and it lives beside {@link epicGoalTextRejection} because the two have to agree: the
 * rejection measures `trim().replace(/\s+/g, " ")` and then something else writes a DIFFERENT
 * string, which is how a value passes validation at one length and is stored at another.
 * `EpicGoalRow.tsx` still carries a private copy of this; it is byte-identical and should be
 * replaced by this import once PR #2285 (which is editing that file right now) has landed.
 */
export function normalizeEpicGoalText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

export function epicGoalTextRejection(text: string): string | null {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (trimmed.length === 0) return "empty";
  if (trimmed.length < GOAL_MIN_LEN) {
    return `too short (${trimmed.length} chars, need ${GOAL_MIN_LEN})`;
  }
  if (trimmed.length > GOAL_MAX_LEN) {
    return `too long (${trimmed.length} chars, max ${GOAL_MAX_LEN})`;
  }
  return null;
}

/** Build a fresh epic goal. THROWS on text that fails {@link epicGoalTextRejection}, for the same
 *  reason `newGoal` throws on empty: a goal nobody can act on is worse than no goal at all. */
export function newEpicGoal(
  text: string,
  now: number,
  source: EpicGoalSource,
  verify?: GoalVerify,
): EpicGoal {
  const rejection = epicGoalTextRejection(text);
  if (rejection !== null) throw new Error(`an epic goal needs usable text — ${rejection}`);
  const narrowed = epicVerifyOf(verify);
  return {
    text: text.trim().replace(/\s+/g, " "),
    setAt: now,
    source,
    ...(source === "human" ? { humanEditedAt: now } : {}),
    // Spread conditionally so an unverified goal has NO `verify` key rather than an explicit
    // `undefined` — same rule as `newGoal`, and for the same reason (only the absence survives a
    // JSON round-trip through the persisted store identically).
    ...(narrowed ? { verify: narrowed, verifyStated: true } : {}),
  };
}

/**
 * The record left behind when generation could not produce a usable goal.
 *
 * ⚠️ IT RECORDS THE FAILURE BESIDE ANY EXISTING GOAL, NEVER IN PLACE OF ONE (roborev 65849). The
 * first cut returned a bare `text: ""`, which is right for the ordinary path — nothing was there —
 * but WRONG on the one path that can reach a record that already has text: an explicit `force`
 * regenerate. `mayAutoGenerate` refuses a record with usable text unless forced, so the ONLY way
 * here with a goal in hand is a person asking to regenerate a goal they can see. Blanking it means
 * "regenerate this" + a timeout DESTROYS the founder's wording — the single failure this module's
 * own header says would cost trust, arriving through the feature meant to protect it.
 *
 * So the prior text, its check, and the human latch are all carried through. What the caller gets
 * is the goal it had plus an explanation of why the regenerate produced nothing.
 */
export function failedEpicGoal(now: number, reason: string, prior?: EpicGoal): EpicGoal {
  return {
    // The latch outlives the text, and the text now outlives a failed regenerate.
    ...(prior?.humanEditedAt !== undefined ? { humanEditedAt: prior.humanEditedAt } : {}),
    ...(prior?.verify !== undefined
      ? { verify: prior.verify, ...(prior.verifyStated !== undefined ? { verifyStated: prior.verifyStated } : {}) }
      : {}),
    // `metAt` TRAVELS WITH THE TEXT (roborev 65856). It is part of `EpicGoalShared` and is written
    // by `setEpicGoalMet`, so dropping it meant an epic goal a human had marked MET, then asked to
    // regenerate, silently reverted to unmet the instant the model call timed out — while showing
    // the identical text. Same class of silent state loss as the blanked text above, through the
    // same path. A failed regenerate changes nothing about whether the goal was achieved.
    ...(prior?.text && prior.metAt !== undefined ? { metAt: prior.metAt } : {}),
    text: prior?.text ?? "",
    // `setAt` follows the TEXT, not the failure — it dates the goal, and a goal that survived a
    // failed regenerate was not re-set. `generationFailedAt` is what dates the failure.
    setAt: prior?.text ? prior.setAt : now,
    source: prior?.text ? prior.source : "auto",
    generationFailedAt: now,
    generationFailureReason: reason,
  };
}

/**
 * May the machine generate (or REgenerate) a goal for this epic on its own?
 *
 * FALSE once a human has ever written one — the latch. `force` is the explicit human ask ("change
 * the goal", "regenerate it"), which is a person choosing to spend the call, and is the only thing
 * that overrides the latch. Note the asymmetry: the latch blocks the AUTOMATIC path only. It never
 * blocks the human.
 */
export function mayAutoGenerate(existing: EpicGoal | undefined, force = false): boolean {
  if (force) return true;
  if (existing === undefined) return true;
  if (existing.humanEditedAt !== undefined) return false;
  // A goal that already has usable text is not regenerated either — the field is filled, and a
  // second call would only spend money to reword it under the reader.
  if (existing.text.trim() !== "") return false;
  // An earlier attempt FAILED. Do not retry on a timer; a failed generation is retried only by an
  // explicit human gesture (the Generate button, or asking the concierge), which arrives as `force`.
  return existing.generationFailedAt === undefined;
}

/** Does this epic have a goal a human can read?
 *
 *  TRUE whenever readable text survives — INCLUDING on a record that also carries a failure
 *  (roborev 65856). This is the predicate to branch on for "is there anything to show"; it is not
 *  a synonym for "the last generation succeeded". A cleared record and one that never had text are
 *  both false. */
export function hasEpicGoalText(goal: EpicGoal | undefined): goal is EpicGoal {
  return goal !== undefined && goal.text.trim() !== "";
}
