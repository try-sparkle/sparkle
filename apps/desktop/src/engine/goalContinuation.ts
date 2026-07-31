// goalContinuation — "the turn ended and the goal is not met, so start another one."
//
// THE FAILURE THIS CLOSES, from the log that commissioned it (sparkle.log.2026-07-29):
//
//   15:41:01  agent bfdaa698  transition {"from":"working","to":"idle"}  source="hook"
//   ...thirty minutes of nothing...
//   16:11:28  agent bfdaa698  transition {"from":"idle","to":"working"}  source="hook"
//
// It was not blocked, not waiting on the human, not waiting on CI. Its last output said "Now back
// to building" and it was mid-write on a file. Its turn simply ended — Claude Code turns end when
// the model stops emitting — and the only thing that restarted it was a human noticing a gray row
// half an hour later. Thirty-seven such stalls that day; 23.6 aggregate agent-hours; the longest a
// single agent idle for 153 minutes mid-task.
//
// THE DANGEROUS VERSION OF THIS FIX is a loop that restarts an agent that cannot make progress —
// which burns tokens forever and is strictly worse than the stall it replaces, because a stall at
// least stops. Every rule below exists to bound that, and they fall into two groups:
//
//   GATES (is restarting even meaningful?)   — a met/expired/escalated goal, a non-idle status, a
//     GUESSED idle, an agent that cannot take input, an idle that has not yet settled.
//   BOUNDS (has restarting stopped working?) — consecutive attempts without progress, and a
//     per-goal total that survives a flapping progress mark.
//
// PURE. `decideContinuation` is data-in-data-out — clock, status and progress all arrive as
// parameters — so every rule is tested as arithmetic. The mount that spends real money on the
// decision lives in services/goalContinuationRunner.
import type { AgentTabStatus } from "@sparkle/ui";
import { type AgentGoal, goalStateOf } from "./agentGoal";
// BOTH, and they are two halves of one rule rather than two rules. `agentOriginated` says text
// SPARKLE authored carries no information about the agent (so a resume is neither a repeated command
// nor progress); `quotaBlock` says an agent behind an account limit cannot act at all. Together they
// are why this module refuses to resume: once because resuming would prove nothing, once because it
// would achieve nothing. See the gate order in `decideContinuation`.
import { RESUME_PROMPT_MARKER } from "./agentOriginated";
import { type QuotaBlock, isQuotaBlocked } from "./quotaBlock";

/**
 * How long a row must sit CONTINUOUSLY idle before an auto-continue is allowed.
 *
 * This is the flap guard, and it is load-bearing rather than cosmetic. Status is derived from
 * whether Claude's spinner is on screen, so brief gaps between tool calls register as idle — the
 * commissioning log caught three full idle→working→idle cycles inside thirty seconds while the
 * agent was working the whole time:
 *
 *   15:17:06 idle->working trigger=spinner-seen
 *   15:17:08 working->idle trigger=spinner-gone-settle
 *   15:17:27 idle->working trigger=spinner-seen
 *   15:17:31 working->idle trigger=spinner-gone-settle
 *
 * Auto-continuing on one of those two-second gaps would type into a terminal mid-turn — the exact
 * interruption `send_to_agent_terminal` refuses to make. Forty-five seconds is comfortably longer
 * than any observed flap and still an order of magnitude below the two-minute floor the PRD counts
 * as a stall, so a real stall is caught long before a human could notice it.
 */
export const IDLE_SETTLE_MS = 45_000;

/** Consecutive auto-continues WITHOUT the progress mark moving, before we escalate to the human.
 *
 *  Three, not one: the first restart of a genuinely stuck agent often does produce progress (the
 *  common case is a turn that ended mid-thought), and escalating on a single unproductive attempt
 *  would page the human for the very thing this exists to handle. Three unproductive restarts in a
 *  row is no longer bad luck. */
export const MAX_CONTINUES_WITHOUT_PROGRESS = 3;

/** Auto-continues allowed on ONE goal in total, however much progress is observed in between.
 *
 *  The backstop for a mark that flaps. `MAX_CONTINUES_WITHOUT_PROGRESS` is measured against a
 *  progress signal, and any progress signal can be wrong — a value that changes for reasons
 *  unrelated to real work would reset the consecutive counter forever and turn "bounded retry"
 *  into an unbounded loop with extra steps. This bound cannot be reset by anything the agent
 *  itself does; only the human (or a NEW goal) clears it. Twenty restarts is far more than any
 *  healthy goal needs and still a hard ceiling on the spend. */
export const MAX_CONTINUES_TOTAL = 20;

/** Why no auto-continue happened. Every arm is a REASON, never a bare false, because this is the
 *  field the concierge reads when it wants to know why a stalled-looking agent was left alone. */
export type NoContinueReason =
  | "no-goal"
  | "goal-met"
  | "goal-expired"
  | "already-escalated"
  | "not-idle"
  | "process-gone"
  | "liveness-unknown"
  | "idle-not-settled"
  | "no-turn-end-authority"
  | "cannot-accept-input"
  | "quota-blocked";

export type ContinuationDecision =
  | { action: "continue"; prompt: string; attempt: number }
  | { action: "escalate"; reason: string }
  | { action: "none"; reason: NoContinueReason };

export interface ContinuationInput {
  goal: AgentGoal | undefined;
  /** The agent's OWN status (not a rollup). */
  status: AgentTabStatus;
  now: number;
  /** Epoch ms the row last became idle, or undefined if it is not idle. Drives {@link IDLE_SETTLE_MS}. */
  idleSince: number | undefined;
  /**
   * Does some source actually WITNESS the end of a turn for this agent (engine/turnEndAuthority)?
   *
   * Reusing that module rather than inventing a second answer is the single most important
   * borrowing in this file. Without a witness, `idle` means "quiet", not "finished" — and quiet is
   * equally consistent with a six-minute `pnpm test` running. Auto-continuing on a guessed idle
   * would type a prompt into a terminal in the middle of a live tool call. The gate that protects
   * destructive git operations from that same ambiguity is the right gate here too.
   */
  hasTurnEndAuthority: boolean;
  /** `services/conciergeDispatch.agentCanAcceptInput` — fails closed for an unknown agent. */
  canAcceptInput: boolean;
  /**
   * Is the agent's PROCESS still alive? Only consulted for `unmerged`, and required there.
   *
   * `unmerged` is not a status an engine ever sets: `unmergedAttention.withUnmergedWork` OVERLAYS
   * it onto any row already resting in `idle`, `done` OR `stopped`. So unlike `idle` — which is
   * derived from a live PTY's output and therefore witnesses its own liveness — `unmerged` says
   * nothing about whether the process exists. Continuing a `done`/`stopped` agent that the overlay
   * relabelled would type `continuePrompt` into a dead PTY, spend a retry against a mark that
   * cannot move, and three rounds later escalate to the human with the false reason "something is
   * blocking it that restarting cannot fix" — while `canAcceptInput` (true for any local agent) and
   * `hasTurnEndAuthority` (an exited PTY is its STRONGEST witness) both wave it through.
   *
   * Fails CLOSED: absent, the band is not continued. Never spend money typing into a terminal that
   * might not be there.
   *
   * REQUIRED-BUT-NULLABLE rather than optional, and that distinction is the whole point (roborev
   * 55298). While it was optional the first caller written would have compiled without it, taken the
   * refusal branch for EVERY `unmerged` row — the fleet's most common band — and produced `none`,
   * which never reaches the bounds either: never continued AND never escalated, verbatim the
   * silent-forever state this module exists to abolish, with no test able to see it. Spelling it
   * `boolean | undefined` means "I looked and it is gone" and "I did not look" both stay
   * expressible, but forgetting to say is a compile error. The producer is
   * `engine/turnEndAuthority.processAliveOf`, which is exported in THIS polarity on purpose — an
   * earlier `hasExited` had the identical type and the opposite meaning, so the obvious wiring
   * compiled and inverted the gate (roborev 55338).
   */
  processAlive: boolean | undefined;
  /** The current progress mark (see {@link progressMark}). */
  mark: string;
  /**
   * An observed account/quota wall (engine/quotaBlock), or `undefined` for none seen.
   *
   * THE BOUND THIS ADDS IS A TIME, NOT A COUNT, and that is what the existing bounds could not
   * express. `MAX_CONTINUES_WITHOUT_PROGRESS` asks "has restarting stopped working?" — a reasonable
   * question that needs three wasted restarts to answer. Here the answer is stated IN THE ERROR
   * before the first attempt: nothing can run until 4pm. Resuming into that is not a retry with poor
   * odds, it is a retry with zero odds, and the observed loop burned turns against it for hours
   * while looking busy.
   *
   * Worse, the count-based bounds could not even catch it eventually: a refusal that costs an
   * attempt would have escalated to the human with "something is blocking it that restarting cannot
   * fix" — true, but arrived having spent the whole retry budget and told them nothing about WHEN.
   */
  quotaBlock?: QuotaBlock;
}

/**
 * Should this agent be restarted right now?
 *
 * Read the arms in order — the sequence encodes the priority, and two orderings matter:
 *
 *   • The GOAL gates come before the STATUS gates, so an agent with no goal is "no-goal" rather
 *     than "not-idle". The caller uses this reason to explain itself to a human, and "it has no
 *     goal" is the actionable sentence; "it isn't idle" sends them looking at the wrong thing.
 *   • The BOUNDS come LAST, after every gate. Escalation is a real event with a human cost, so it
 *     must only fire on an agent we would genuinely otherwise have restarted — never on one that
 *     merely looks bad while it is busy, un-witnessed, or unreachable.
 */
export function decideContinuation(input: ContinuationInput): ContinuationDecision {
  const { goal, status, now, idleSince, hasTurnEndAuthority, canAcceptInput, mark, processAlive } =
    input;

  const state = goalStateOf(goal, now);
  if (state === "none") return { action: "none", reason: "no-goal" };
  if (state === "met") return { action: "none", reason: "goal-met" };
  if (state === "expired") return { action: "none", reason: "goal-expired" };
  if (state === "escalated") return { action: "none", reason: "already-escalated" };
  // `state === "unmet"` here, which `goalStateOf` only returns for a defined goal — but that
  // implication lives in another module, so the guard is restated rather than asserted away with a
  // cast. An impossible branch that returns a reason is cheaper than a `!` that becomes a crash if
  // the state machine ever grows an arm.
  if (goal === undefined) return { action: "none", reason: "no-goal" };
  const live = goal;

  // `idle` OR `unmerged`. Not `waiting`/`approval`/`blocked`/`errored` — those are the red tier,
  // where the agent is genuinely stuck on the human and typing an unrelated "continue" would answer
  // a question it never read. Not `done`/`stopped` either: the process is gone, so there is no turn
  // to continue and a prompt would vanish into a dead PTY. Not `new`: nobody has briefed it.
  //
  // `unmerged` IS continued, deliberately (roborev 55252). It is the gray "Needs merge" state
  // `unmergedAttention` overlays onto a resting row with committed-but-unlanded work — on a real
  // fleet the single most common band — and an agent sitting there with an unmet goal is the
  // motivating case almost exactly: it did the work, its turn ended before the work landed, and
  // nothing is coming to finish it. Restarting is precisely right, because landing the branch is
  // work the agent can do itself. Leaving it in `not-idle` meant such an agent was never continued
  // AND never escalated, which is the silent-forever state this whole module exists to abolish.
  // THE QUOTA WALL COMES BEFORE THE STATUS GATE, and the order is the entire fix.
  //
  // Tripping the wall forces `status: "blocked"`, which is NOT a resting status — so with this check
  // placed after the gate below, every quota-walled agent was refused as `not-idle` and the quota
  // reason was unreachable by construction. That is the same uninformative answer the founder was
  // given by `get_agent_status`, reproduced in the one field the concierge reads to explain why an
  // agent was left alone. It is also why the first cut's "resumes once the reset has passed" test
  // proved nothing: it passed `status: "idle"`, which a live wall can never produce.
  //
  // Before the BOUNDS too, so waiting out a wall never spends a retry and never escalates. The reset
  // instant is the schedule: StatusEngine releases the row at that instant (armQuotaRelease), it
  // settles back to idle, and the next 15s sweep resumes it — the "then resume ONCE automatically"
  // half of the requirement, with no second timer here to drift from that one.
  if (isQuotaBlocked(input.quotaBlock, now)) return { action: "none", reason: "quota-blocked" };
  if (!isRestingStatus(status)) return { action: "none", reason: "not-idle" };
  // ...but `unmerged` must prove the process still EXISTS, because the overlay that writes it also
  // covers `done` and `stopped`. See ContinuationInput.processAlive: `idle` witnesses its own
  // liveness, `unmerged` cannot, and the two gates that would otherwise catch a dead process
  // (`canAcceptInput`, `hasTurnEndAuthority`) both pass for one. Fails closed on absent evidence.
  //
  // TWO REFUSALS, NOT ONE, because this reason string is what the concierge reads out to a human
  // (see NoContinueReason). Reporting "its process is gone" about an agent nobody looked up is the
  // same false-positive-from-silence that `agentLiveness` was written to prevent and that
  // `stallReport`'s `unknown` arm preserves in the sibling module — and it would have said it about
  // every live agent in the band, sending the human to close a tab whose agent is running
  // (roborev 55298). Both still refuse; only the sentence differs.
  if (status === "unmerged" && processAlive !== true) {
    return { action: "none", reason: processAlive === false ? "process-gone" : "liveness-unknown" };
  }
  if (!hasTurnEndAuthority) return { action: "none", reason: "no-turn-end-authority" };
  if (idleSince === undefined || now - idleSince < IDLE_SETTLE_MS) {
    return { action: "none", reason: "idle-not-settled" };
  }
  if (!canAcceptInput) return { action: "none", reason: "cannot-accept-input" };

  // BOUNDS. `continues` counts attempts since the mark last moved; a mark that has moved since the
  // last attempt means the agent DID something, so that streak is over and this attempt starts a
  // fresh one (mirroring agentGoal.noteContinue, which applies the same rule when recording).
  const progressed = live.mark !== undefined && live.mark !== mark;
  const consecutive = progressed ? 0 : live.continues;
  if (consecutive >= MAX_CONTINUES_WITHOUT_PROGRESS) {
    return {
      action: "escalate",
      reason:
        `Auto-continued ${consecutive} times with no sign of progress. The goal is still unmet: ` +
        `"${live.text}". Something is blocking it that restarting cannot fix.`,
    };
  }
  if (live.totalContinues >= MAX_CONTINUES_TOTAL) {
    return {
      action: "escalate",
      reason:
        `Auto-continued ${live.totalContinues} times on this goal — the per-goal ceiling. The goal ` +
        `is still unmet: "${live.text}".`,
    };
  }

  // `consecutive + 1`, NOT `live.continues + 1`. The bound above is read from `consecutive`, so
  // reporting an attempt number derived from the un-reset counter made the two disagree in exactly
  // the progressed case the reset exists for — and made `attempt` non-monotonic: continues=2 with a
  // moved mark reported attempt 3, `noteContinue` then set continues=1, and the next sweep reported
  // attempt 2. A runner surfacing "auto-continue attempt N" printed 3 then 2 for consecutive
  // restarts of a healthy agent, and could print a number above the limit while the streak was
  // zero. (roborev 55252.)
  return { action: "continue", prompt: continuePrompt(live), attempt: consecutive + 1 };
}

/** The resting statuses an auto-continue may act on. See the note at the `not-idle` gate for why
 *  `unmerged` belongs here and the red tier does not. */
function isRestingStatus(status: AgentTabStatus): boolean {
  return status === "idle" || status === "unmerged";
}

/**
 * What we actually type into the agent's terminal.
 *
 * It restates the GOAL rather than saying "continue", and that is the difference between a prompt
 * that works and one that produces "continue what?". The agent's context may have been compacted,
 * or the process relaunched, since the goal was set — so the prompt has to carry enough to stand
 * alone.
 *
 * It also tells the agent how to STOP. An auto-continue loop with no exit the agent can reach is
 * one the agent will fight: it would keep being restarted after genuinely finishing, and the only
 * way out would be the bounds firing, which reports a false escalation to the human. Naming the
 * op that marks the goal met makes finishing a thing the agent can do, so the common case ends
 * cleanly instead of by exhaustion.
 *
 * IT OPENS WITH A SHARED CONSTANT, and that is load-bearing rather than tidiness. This string is
 * SYSTEM-AUTHORED: no human and no agent chose to send it, a timer did — so `engine/agentThrash`
 * must not count it as a repeated command and this module must not count it as progress (see
 * engine/agentOriginated for the one statement of that rule). The thrash detector recognises
 * Sparkle's own send by this opening, so the sender and the recogniser have to be ONE string rather
 * than two copies of one. Reword it here and `agentOriginated.test.ts` fails; that is the point —
 * the alternative is the detector going silently blind, which is how agent 0bf08c64 came to be
 * badged "It is looping, not working" through 46 minutes of real work.
 */
export function continuePrompt(goal: AgentGoal): string {
  return (
    `${RESUME_PROMPT_MARKER} automatically. ` +
    `Do not stop to acknowledge this — pick up exactly where you left off and keep working.\n\n` +
    `GOAL: ${goal.text}\n\n` +
    // NAME THE OP THAT EXISTS. This said `set_agent_goal with met: true`, which cannot work:
    // `set_agent_goal`'s schema is `{ targetAgentId?, goal, ttlMs? }` — there is no `met`, and
    // `goal` is required. An agent that obeyed either failed zod validation or, if it invented a
    // goal string to satisfy it, landed in `setAgentGoal` → `newGoal`, which builds a fresh record
    // that is never born met and CLEARS any existing `metAt`. Either way it could not stop being
    // resumed, and burned continues until the bound escalated to a human with a false "still
    // unmet" — the exact outcome this prompt exists to prevent. `set_agent_goal_met` is the op;
    // no `targetAgentId`, which agents are not offered.
    `If the goal IS in fact met, say so and mark it met (sparkle-control: set_agent_goal_met with ` +
    `met: true) so you stop being resumed. If you are blocked on something only the human can ` +
    `resolve, say what you need — do not sit idle.`
  );
}

/**
 * The cheap per-agent signal for "did anything happen between the last restart and this one".
 *
 * Built from evidence the store ALREADY holds, deliberately: a progress signal that costs a `git`
 * call would run on every idle sweep across a 64-agent fleet, and one that costs an LLM call would
 * cost more than the stall. Each input moves only when the agent genuinely did something:
 *
 *   • `promptHistoryLength` — a HUMAN sent it work. Explicitly NOT the auto-continue: that send
 *                             passes `userPrompt: false` precisely so it stays out of
 *                             `promptHistory` and therefore out of this mark. A resume is Sparkle
 *                             talking to itself, and counting it here would make the mark move on
 *                             every attempt, reset the consecutive streak forever, and leave
 *                             `MAX_CONTINUES_WITHOUT_PROGRESS` unable to fire at all. This is the
 *                             stall-side half of the rule stated in engine/agentOriginated — the
 *                             thrash side of the same rule is that the resume must not count as a
 *                             repeated COMMAND. One definition, two detectors, opposite failures.
 *   • `activity`            — the agent re-narrated what it is building (sparkle-control
 *                             set_agent_activity), which it only does at real phase boundaries.
 *   • `aiTitle`             — Claude Code re-derived the session title from the whole
 *                             conversation, which tracks the work actually shifting.
 *
 * NONE of these is a perfect proxy for progress, and the design does not pretend otherwise — an
 * agent can work hard and move none of them. That is exactly why {@link MAX_CONTINUES_TOTAL}
 * exists as a bound this function cannot influence: the consecutive counter is an OPTIMISATION
 * that keeps restarting an obviously-progressing agent, never the only thing standing between the
 * fleet and an unbounded loop.
 */
export function progressMark(input: {
  promptHistoryLength: number;
  activity?: string;
  aiTitle?: string | null;
}): string {
  // Joined on NUL, written as the ESCAPE and not a raw byte: a raw NUL makes git treat the whole
  // file as binary (no diffs, no review), which `services/sourceIsText.test.ts` guards against —
  // it caught exactly that here. The runtime string is identical. NUL rather than a space because
  // the fields are free text: an activity line containing the separator could otherwise make two
  // different states produce the same mark, which would read as "no progress" and burn a retry.
  return [input.promptHistoryLength, input.activity ?? "", input.aiTitle ?? ""].join("\u0000");
}
