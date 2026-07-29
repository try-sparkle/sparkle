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
export function newGoal(text: string, now: number, ttlMs = DEFAULT_GOAL_TTL_MS): AgentGoal {
  const trimmed = text.trim();
  if (trimmed === "") throw new Error("a goal needs text — an empty goal can never be acted on");
  return { text: trimmed, setAt: now, ttlMs, continues: 0, totalContinues: 0 };
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
