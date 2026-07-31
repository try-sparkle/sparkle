// agentGoal — an agent's GOAL as a readable, persisted fact, and the vocabulary for "is it met".
//
// WHY THIS EXISTS. Measured on 2026-07-29, the fleet lost 23.6 aggregate agent-hours to 37 stalls
// longer than two minutes — agents whose turn simply ENDED with work remaining and which nothing
// restarted. The longest was 153 minutes. A Claude Code turn ends when the model stops emitting;
// there is no "and it was finished" in that signal, so an agent that stops mid-task is
// indistinguishable, from the outside, from one that succeeded. The founder's requirement is
// "I never want agents to wait."
//
// The PRD that commissioned this assumed goals ALREADY existed ("the UI shows /goal active (4h)").
// They did not: there is no `/goal` command in Claude Code, no goal skill, and no goal field
// anywhere in Sparkle. So this module is the missing substrate rather than a wrapper over one — it
// is deliberately small, pure and persisted-shaped, because three separate consumers need to agree
// on what "unmet" means:
//
//   • engine/goalContinuation — decides whether an idle turn gets auto-restarted.
//   • engine/agentStall       — decides whether an idle row renders "done" or "stalled".
//   • the control surfaces     — get_state / get_agent_status report goal + met to the concierge,
//                                which is what lets it SWEEP for stalls instead of a human
//                                noticing a gray row by eye.
//
// EVERYTHING HERE IS PURE. The clock arrives as a parameter, never `Date.now()`, so the expiry and
// escalation rules are tested as arithmetic rather than by waiting four hours.

/** How long a goal stays live by default before it stops driving auto-continue: four hours.
 *
 *  A TTL is not decoration — it is the outermost bound on the whole mechanism. An agent whose goal
 *  never expires would be eligible for auto-continue forever, so a goal someone set and forgot
 *  becomes a permanent token burner. Four hours is long enough to cover a real build session and
 *  short enough that a forgotten goal dies the same working day. */
import type { GoalVerify } from "@sparkle/core";

export const DEFAULT_GOAL_TTL_MS = 4 * 60 * 60_000;

/** An agent's current goal. Persisted on the AgentTab record (see types.ts), so it survives the
 *  relaunch that is itself one of the most common ways a turn gets ended with work remaining. */
export interface AgentGoal {
  /** What the agent is trying to achieve, in the setter's own words. Shown to the human and
   *  replayed to the agent when auto-continue restarts it, so it has to read as an instruction. */
  text: string;
  /** Epoch ms the goal was set. With `ttlMs`, fixes the expiry. */
  setAt: number;
  /** Lifetime from `setAt`. Defaults to {@link DEFAULT_GOAL_TTL_MS}. */
  ttlMs: number;
  /** Epoch ms the goal was declared MET — by the agent itself, or by the human. Absent while unmet.
   *  This is the ONLY thing that makes an idle agent legitimately "done": a turn ending does not
   *  set it, which is precisely the distinction the whole feature rests on. */
  metAt?: number;
  /** Consecutive auto-continues since progress was last observed. Reset to 0 by {@link notePro
   *  gress}; the escalation bound is read against THIS, not the total, so an agent that keeps
   *  making progress keeps getting restarted. */
  continues: number;
  /** Auto-continues spent on this goal EVER, across progress resets. The backstop bound: without
   *  it, a mark that flaps (a value that changes for reasons unrelated to real progress) would
   *  reset `continues` indefinitely and the "bounded retry" guarantee would be vacuous. */
  totalContinues: number;
  /** The progress mark observed at the last auto-continue. A change means the agent DID something
   *  between restarts; see engine/goalContinuation for what the mark is built from. */
  mark?: string;
  /** Epoch ms auto-continue gave up and handed the agent to the human. Latched: an escalated goal
   *  never auto-continues again, so the escalation cannot be undone by a stray progress blip. */
  escalatedAt?: number;
  /** Why it escalated, in one sentence, for the human who now owns it. */
  escalationReason?: string;
  /** HOW this goal is checked (see @sparkle/core goalVerify). Absent on every goal that predates the
   *  field, and absence is what keeps `set_agent_goal_met` working for those: a goal that never stated
   *  a check was never claiming to be verifiable, so it is still self-markable. A goal that DID state
   *  one cannot be latched by its own claimant — `canSelfMarkMet` refuses every kind. */
  verify?: GoalVerify;
}

/** Where a goal is in its life. `none` is the absence of a goal, kept in the union so every
 *  consumer branches over one exhaustive vocabulary rather than juggling `undefined`. */
export type GoalState = "none" | "unmet" | "met" | "expired" | "escalated";

/** Build a fresh goal. Counters start at zero; a new goal is never born escalated or met.
 *
 *  THROWS on empty/whitespace text, rather than producing a goal nobody can act on. An empty goal
 *  is fully live — `unmet`, so auto-continue restarts the agent up to `MAX_CONTINUES_TOTAL` times
 *  with a prompt reading `GOAL: ` and nothing after it (the exact "continue what?" failure
 *  `continuePrompt` exists to prevent), then escalates to a human with `The goal is still unmet:
 *  ""`. That is a four-hour, twenty-restart token burn carrying no recoverable instruction. Since
 *  this is the substrate all three consumers share, a blank from ANY caller — a mis-parsed
 *  `set_agent_goal`, a UI field submitted empty — would reach it, so the refusal belongs here
 *  rather than in each caller. Callers that want "empty means clear the goal" must check first;
 *  `projectStore.setAgentGoal` does exactly that. */
export function newGoal(
  text: string,
  now: number,
  ttlMs = DEFAULT_GOAL_TTL_MS,
  verify?: GoalVerify,
): AgentGoal {
  const trimmed = text.trim();
  if (trimmed === "") throw new Error("a goal needs text — an empty goal can never be acted on");
  // `verify` is spread conditionally so an unverified goal has NO `verify` key rather than an explicit
  // `undefined`. The two are equivalent to `canSelfMarkMet`, but only the former survives a JSON
  // round-trip through the persisted store identically, and the absence is load-bearing (it is what
  // marks a goal as pre-dating the field).
  return { text: trimmed, setAt: now, ttlMs, continues: 0, totalContinues: 0, ...(verify ? { verify } : {}) };
}

/**
 * The goal's state at `now`.
 *
 * ORDER IS LOAD-BEARING, and it is not the order you would guess. `met` is checked BEFORE
 * `expired` and before `escalated`: a goal that was achieved stays achieved, and reporting a met
 * goal as "expired" four hours later would tell the human an accomplished agent had stalled. An
 * ESCALATED goal is likewise still unmet work — but it is no longer OURS to retry, so it gets its
 * own state rather than folding back into `unmet`, where the continuation engine would pick it up
 * again and defeat the escalation.
 */
export function goalStateOf(goal: AgentGoal | undefined, now: number): GoalState {
  if (goal === undefined) return "none";
  if (goal.metAt !== undefined) return "met";
  if (goal.escalatedAt !== undefined) return "escalated";
  if (now >= goal.setAt + goal.ttlMs) return "expired";
  return "unmet";
}

/** Is there outstanding, still-live goal work? True ONLY for `unmet`.
 *
 *  `escalated` and `expired` are deliberately FALSE here even though the work was never finished.
 *  This predicate gates auto-continue, and both of those states mean "stop retrying" — an
 *  escalated goal belongs to the human now, and an expired one has outlived its mandate. The
 *  human-facing stall surface asks a different question and reads {@link goalStateOf} directly, so
 *  a stalled agent is still SHOWN as stalled after escalation; it just is not restarted again. */
export function hasUnmetGoal(goal: AgentGoal | undefined, now: number): boolean {
  return goalStateOf(goal, now) === "unmet";
}

/** Milliseconds until the goal expires; 0 once it has, and 0 when there is no goal. Used for the
 *  "active (4h)" style label the PRD described. */
export function goalRemainingMs(goal: AgentGoal | undefined, now: number): number {
  if (goal === undefined) return 0;
  return Math.max(0, goal.setAt + goal.ttlMs - now);
}

/** Mark the goal met. Idempotent — a second call keeps the FIRST timestamp, so "when was this
 *  achieved" does not drift every time something re-asserts it. */
export function markGoalMet(goal: AgentGoal, now: number): AgentGoal {
  if (goal.metAt !== undefined) return goal;
  return { ...goal, metAt: now };
}

/** Record that an auto-continue was just spent, against the mark it was spent at.
 *
 *  If the mark MOVED since the last continue the agent did something in between, so the consecutive
 *  counter resets to 1 (this attempt) rather than climbing. `totalContinues` never resets — it is
 *  the bound that survives a flapping mark. */
export function noteContinue(goal: AgentGoal, mark: string): AgentGoal {
  const progressed = goal.mark !== undefined && goal.mark !== mark;
  return {
    ...goal,
    continues: progressed ? 1 : goal.continues + 1,
    totalContinues: goal.totalContinues + 1,
    mark,
  };
}

/** Hand the goal to the human. Latched (see {@link AgentGoal.escalatedAt}); a second escalation
 *  keeps the first reason, so the human reads why it ORIGINALLY gave up. */
export function escalateGoal(goal: AgentGoal, now: number, reason: string): AgentGoal {
  if (goal.escalatedAt !== undefined) return goal;
  return { ...goal, escalatedAt: now, escalationReason: reason };
}

/** Clear the retry budget because a HUMAN changed the picture — they typed to the agent, or
 *  rewrote the goal. Also clears an escalation: the human acting on the escalation is exactly the
 *  event that makes retrying reasonable again.
 *
 *  THIS IS THE HUMAN'S LEVER, and that is why it resets `totalContinues` too. Nothing the agent
 *  can do reaches it — see {@link clearGoalMet} for the agent-facing counterpart, which
 *  deliberately cannot refill the ceiling. */
export function resetGoalRetries(goal: AgentGoal): AgentGoal {
  const { escalatedAt: _e, escalationReason: _r, mark: _m, ...rest } = goal;
  return { ...rest, continues: 0, totalContinues: 0 };
}

/**
 * Un-mark a met goal — "it turned out not to be done after all".
 *
 * THE AGENT'S OWN LEVER, and deliberately much weaker than {@link resetGoalRetries}. It clears the
 * consecutive streak (the agent is going back to work and deserves a fresh run at it) but leaves
 * `totalContinues` and any escalation exactly where they were.
 *
 * The difference is a real hole otherwise. `setAgentGoalMet` is how an AGENT declares itself done,
 * so the actor holding this lever is precisely the one `MAX_CONTINUES_TOTAL` defends the fleet
 * against: an agent that marked itself met and then un-marked itself would refill its entire
 * twenty-restart budget, and could do it again every twenty restarts, forever. Worse, un-latching
 * `escalatedAt` would take back a goal a human had already been handed and quietly return it to
 * the auto-continue pool.
 *
 * A no-op when the goal was never met, so this cannot be used as a budget reset by calling it on
 * an unmet goal.
 */
export function clearGoalMet(goal: AgentGoal): AgentGoal {
  if (goal.metAt === undefined) return goal;
  const { metAt: _m, ...rest } = goal;
  return { ...rest, continues: 0 };
}

/**
 * What an agent still OWES after its goal record is gone.
 *
 * THE HOLE THIS CLOSES (roborev 55451). Every bound in engine/goalContinuation — `already-escalated`,
 * `MAX_CONTINUES_TOTAL`, `MAX_CONTINUES_WITHOUT_PROGRESS` — is read off the `AgentGoal` record and
 * NOWHERE ELSE. So deleting the record deletes the debt, and `set_agent_goal` is agent-reachable and
 * free-tier, with an empty string documented as "clears it". Two calls, no cleverness:
 *
 *   1. `set_agent_goal {goal: ""}`      → record dropped: budget spent AND escalation both gone
 *   2. `set_agent_goal {goal: "…"}`     → no prior goal, so the inherit-the-debts branch cannot fire
 *
 * …and the agent is back in the auto-continue pool with a full ceiling and a human's escalation
 * silently cancelled, repeatable forever. Carrying the debt forward across a text change (which the
 * `actor === "agent"` branch of `setAgentGoal` already did) is not enough on its own, because the
 * clear path erases the very record that branch reads.
 *
 * So the debt OUTLIVES the goal. It is deliberately the narrow set — the two latched facts a human
 * owns — and never `continues`, which is the "is restarting getting anywhere" signal and is supposed
 * to reset when the work genuinely changes.
 */
export interface GoalDebt {
  /** Auto-continues spent under the cleared goal. Feeds `MAX_CONTINUES_TOTAL` on the next goal. */
  totalContinues: number;
  /** The escalation the human was handed, if any. Latched across the clear for the same reason it is
   *  latched within a goal: taking it back is the human's call, not the agent's. */
  escalatedAt?: number;
  escalationReason?: string;
  /** The CHECK the cleared goal stated. Latched for the same reason as the escalation, and against
   *  the same escape: `verify` is what decides whether the claimant may latch `metAt`, so a goal that
   *  lost it on a rewrite would become self-markable in one extra call — the paraphrase-escape this
   *  debt mechanism already closes for the retry budget, left open for the field that gates the latch
   *  (roborev 55893).
   *
   *  THE ONE WAY OUT IS DELIBERATE AND THE CONCIERGE'S: `set_agent_goal {verify: null}`. This used to
   *  say "a HUMAN rewrite may still drop it", which was false twice over — no production caller passes
   *  `actor: "human"`, and the release that DID fire (`releaseGoalDebt`, on any typed line) was
   *  incidental rather than a take-back, so the check was simultaneously un-droppable on purpose and
   *  droppable by accident (roborev 55933). */
  verify?: GoalVerify;
}

/**
 * The debt to remember when a goal is cleared — or `undefined` when there is nothing to remember.
 *
 * Returning `undefined` for a clean goal matters: it keeps the stored field absent on the overwhelming
 * common path (an agent that never auto-continued and was never escalated), so this does not add a
 * `{ totalContinues: 0 }` to every agent in the persisted blob.
 */
export function goalDebtOf(goal: AgentGoal | undefined): GoalDebt | undefined {
  if (goal === undefined) return undefined;
  // `verify` counts as debt on its own: a goal with a clean budget and no escalation still owes its
  // CHECK across a clear, or clear-then-set launders a verified goal into an unverified one.
  if (goal.totalContinues === 0 && goal.escalatedAt === undefined && goal.verify === undefined) {
    return undefined;
  }
  return {
    totalContinues: goal.totalContinues,
    ...(goal.verify !== undefined ? { verify: goal.verify } : {}),
    ...(goal.escalatedAt !== undefined
      ? {
          escalatedAt: goal.escalatedAt,
          ...(goal.escalationReason !== undefined
            ? { escalationReason: goal.escalationReason }
            : {}),
        }
      : {}),
  };
}

/** What an inherited check becomes on NEW goal text — the obligation, without the stale proof. */
const INHERITED_VERIFY: GoalVerify = { kind: "human" };

/**
 * Charge a freshly-created goal with an outstanding {@link GoalDebt}.
 *
 * `debt` may be `undefined` (nothing owed) — the caller passes whatever it has and gets back a goal
 * either way, so no call site needs its own branch. The debt is the FLOOR, not an overwrite: a
 * `totalContinues` already on the goal wins if it is higher, so this can only ever tighten the bound.
 * An escalation on either side latches, matching {@link escalateGoal}.
 *
 * THIS IS AN AGENT-FACING PATH, so it must never be usable as a reset — see {@link clearGoalMet}.
 */
export function chargeGoalDebt(goal: AgentGoal, debt: GoalDebt | undefined): AgentGoal {
  if (debt === undefined) return goal;
  const escalatedAt = goal.escalatedAt ?? debt.escalatedAt;
  const escalationReason = goal.escalationReason ?? debt.escalationReason;
  // THE OBLIGATION IS INHERITED; THE PROOF IS NOT (roborev 55933).
  //
  // The incoming goal's own `verify` wins when it has one — the caller stated a NEW check. When it
  // states none, the owed check is inherited, but DOWNGRADED to `human` rather than restored
  // verbatim, because this branch runs on genuinely NEW goal text and nothing here can know the old
  // proof still applies to it. Restoring it verbatim was actively wrong on the routine path:
  // `send_to_agent_terminal` records every work goal with no `verify` at all, so an agent that once
  // stated `{ kind: "command", cmd: "pnpm test parser" }` had that command silently re-attached to
  // "write the release notes" — `selfMarkRefusal` then instructs it to run a command unrelated to
  // its goal, and once an executor exists a stale command exiting 0 closes an unrelated goal, which
  // is the false "done" this whole mechanism exists to prevent.
  //
  // `human` is the honest carry: it keeps the goal non-self-markable (the invariant the debt owes)
  // while asserting no machine proof about work nobody checked.
  const verify = goal.verify ?? (debt.verify !== undefined ? INHERITED_VERIFY : undefined);
  return {
    ...goal,
    totalContinues: Math.max(goal.totalContinues, debt.totalContinues),
    ...(verify !== undefined ? { verify } : {}),
    ...(escalatedAt !== undefined
      ? {
          escalatedAt,
          ...(escalationReason !== undefined ? { escalationReason } : {}),
        }
      : {}),
  };
}
