// THE GOAL GATE: no worker is dispatched without a checkable objective.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────────────────
// `task` and `goal` are DIFFERENT FACTS, and conflating them is a root cause of stranded work.
//
//   A TASK says what to DO — "refactor the parser". It can be worked on forever. Nothing about it
//   is checkable, so an agent holding only a task can report "done" at any moment and no other
//   party can contradict it.
//
//   A GOAL states the OBSERVABLE END STATE that makes the work finished — "parser handles nested
//   groups and parser.test.ts passes". It can be checked by someone other than the agent that
//   claimed it, which is the only reason a deadline, an escalation, or a refutation can exist.
//
// On 2026-07-30 a fleet scan found 218 unlanded commits across 29 branches against ONE open pull
// request: work was not stuck at the merge gate, it never arrived. `spawn_worker` accepted a task
// with no stated objective, so nothing downstream could tell a worker that had finished from one
// that had merely stopped. This module is the earliest possible point to close that — before the
// worktree is cut, before a single token is spent.
//
// ── THIS ENFORCES A RULE THAT ALREADY EXISTED AS PROSE AND WAS NOT FOLLOWED ───────────────────────
// `<app_data>/concierge-guidelines.md` has carried this since 2026-07-29:
//
//     "Whenever you task an agent, set its goal in the same message as the task — an objectively
//      verifiable completion criterion that anyone can check to determine whether the task was met."
//
// It is injected into the concierge's context every session and it is still routinely skipped. That
// is the whole case for this module: a rule a model is asked to remember is advisory, and the fleet
// measured above is what advisory produced. The same sentence expressed as a REFUSAL cannot be
// skipped, because the dispatch does not happen without it.
//
// The enforcement is HERE, not in the tool schemas. Both callers declare `goal` OPTIONAL so that an
// omitted goal reaches this function and is refused with a message explaining what a goal is — a
// schema-level `required` produced a generic "goal: Required" validation error instead, and broke the
// documented override form outright (roborev 55743). So: schema-optional, gate-required. Wording
// below quotes the guideline deliberately, so the gate and the prose cannot drift apart.
//
// ── WHAT IS AND IS NOT ENFORCEABLE HERE ──────────────────────────────────────────────────────────
// Enforced mechanically: a goal is PRESENT, is long enough to state an end state, is not a filler
// phrase, and ADDS INFORMATION BEYOND THE TASK (a goal that is just the task echoed back carries no
// new checkable fact — the precise failure mode this catches).
//
// NOT enforced here, and deliberately not claimed to be: that the goal is *true*, *achievable*, or
// *well chosen*. Those are judgements; this module only refuses the absence of a claim. It also
// cannot prove a human approved an override — this process has no channel to a human, so an override
// is a STATED decision, not an approved one. Saying otherwise would be the same false confidence the
// gate exists to remove.
//
// WHERE AN OVERRIDE REASON ACTUALLY GOES — and it DIFFERS BY SURFACE, which two rounds of review
// caught this header getting wrong (roborev 55743, then 55836). No sentence here may describe "the
// override reason" as if there were one path.
//
//   spawn_worker (`goalOverride`): validated, forwarded on the wire, and visible in the call payload
//     and logs. Its accountability rests on a COMPUTED fact rather than on the string — the worker
//     ends up with NO GOAL, which the unlanded-work surface can find without reading any reason.
//
//   send_to_agent_terminal (`notWork`): validated and WRITTEN TO THE APP LOG by the caller. The
//     computed-fact argument above does NOT transfer: that path deliberately leaves the agent's
//     PRIOR goal intact, so nothing about the record distinguishes "chatter was sent" from "work was
//     dispatched with no objective". The log entry is the whole audit trail, which is why the
//     handler must actually write it and why `notWork` is not merely decorative.
//
// Neither is persisted on the agent record and NO SURFACE RENDERS EITHER. So the messages below say
// "recorded", never "shown to the human". Do not re-add a display promise without a surface for it.
//
// Pure: no clock, no I/O, no env. Every rule is a total function of its arguments.

/** Minimum characters in a goal. An end state does not fit in fewer; "done" and "ship it" must fail. */
export const GOAL_MIN_LEN = 16;

/**
 * Maximum characters in a goal.
 *
 * A completion criterion is SHORT by nature — it names a condition someone else can check. Prose of
 * several hundred characters is a status update, a handoff note, or a design discussion, and none of
 * those can be checked. This rule exists because of an observed real case: the concierge sent an
 * agent a ~900-character narrative covering two unrelated topics (a half-fixed mount, plus a P1 defect
 * report) as if it were an objective. Every OTHER rule here passed it — long enough, not filler, not
 * an echo of the task — so without a cap the gate accepts exactly the shape that is hardest to hold
 * anyone to. Rejecting length is a proxy, not a judgement of content; it is the only part of "this is
 * not a criterion" that is mechanically decidable.
 *
 * Set generously so a legitimate multi-condition criterion ("X parses, Y.test.ts passes, and the
 * CLI exits 0") fits comfortably; the target is narrative, not thoroughness.
 */
export const GOAL_MAX_LEN = 200;

/** Minimum characters in an override reason — long enough to be an actual justification. */
export const OVERRIDE_REASON_MIN_LEN = 12;

/**
 * Vague restatements that parse as goals but state no observable end state. Compared against the
 * NORMALIZED goal (see `normalize`), so punctuation and casing do not smuggle one past.
 *
 * These are whole-string matches on purpose. Substring matching would reject legitimate goals that
 * merely contain one of these words ("the migration is complete and migrate.test.ts passes").
 */
const FILLER_GOALS: ReadonlySet<string> = new Set([
  "done",
  "finish",
  "finish it",
  "finish the task",
  "finish the work",
  "complete",
  "complete it",
  "complete the task",
  "complete the work",
  "make it work",
  "make it pass",
  "ship it",
  "ship the work",
  "as described",
  "as described above",
  "see task",
  "see the task",
  "the task",
  "do the task",
  "implement the task",
  "n/a",
  "na",
  "none",
  "tbd",
  "todo",
  "unknown",
]);

/**
 * Which surface is asking, so a refusal names the tool and the override parameter THAT CALLER has.
 *
 * This exists because the refusal copy was written for `spawn_worker` and then relayed verbatim by
 * `send_to_agent_terminal`, where it named the wrong tool and told the caller to pass `goalOverride` —
 * a key that surface's `.strict()` schema REJECTS. Following the remedy produced a second `bad-args`
 * ("Unrecognized key: goalOverride") whose message again said `goalOverride`: a non-terminating loop
 * with no path to a successful call, and the refusal is the only place the contract is stated
 * (roborev 55826/55836). A remedy string is an instruction the caller WILL follow, so it has to be
 * followable on the surface that emitted it.
 */
export interface GoalGateSurface {
  /** The tool name to name in refusals, e.g. "send_to_agent_terminal". */
  tool: string;
  /** The parameter that carries the no-goal escape hatch on THIS surface. */
  overrideParam: string;
}

const DEFAULT_SURFACE: GoalGateSurface = { tool: "spawn_worker", overrideParam: "goalOverride" };

/** An explicit, stated decision to dispatch work with no goal. Auditable, not human-proven. */
export interface WorkerGoalOverride {
  /** Why this work is being dispatched with no checkable objective. */
  reason: string;
}

/** Accepted: the goal to record against the worker, or `null` when an override was used. */
export interface GoalAccepted {
  ok: true;
  /** The trimmed goal to persist, or `null` when dispatched under an override. */
  goal: string | null;
  /** Present only when an override was used, so callers can surface it rather than swallow it. */
  override?: WorkerGoalOverride;
}

/** Rejected: `reason` is a machine-readable tag, `message` is for the caller to relay verbatim. */
export interface GoalRejected {
  ok: false;
  reason:
    | "goal-missing"
    | "goal-too-short"
    | "goal-too-long"
    | "goal-filler"
    | "goal-echoes-task"
    | "override-reason-missing";
  message: string;
}

export type GoalVerdict = GoalAccepted | GoalRejected;

/**
 * Casefold + strip surrounding punctuation + collapse internal whitespace, so `"Done."`, `"done"`
 * and `"  DONE  "` all compare equal against FILLER_GOALS and against the task.
 *
 * Trailing/leading punctuation only — internal punctuation is meaningful in a real goal
 * ("parser.test.ts passes") and must survive.
 */
function normalize(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .replace(/[^\p{L}\p{N}]+$/u, "");
}

/**
 * Decide whether this dispatch carries a checkable objective.
 *
 * `goal` is what the caller stated. `task` is the work itself — passed in ONLY so the gate can
 * reject a goal that merely echoes it (an echo adds no checkable fact). `override` is the explicit
 * escape hatch; when supplied with a substantive reason it accepts with `goal: null` so the absence
 * is RECORDED rather than silently permitted.
 *
 * Precedence is deliberate: a VALID GOAL WINS over an override. A caller that supplies both meant to
 * state a goal, and honouring the override there would discard a real objective and mark the worker
 * goalless — strictly worse than ignoring a redundant escape hatch.
 */
export function validateWorkerGoal(
  goal: string | undefined | null,
  task: string,
  override?: WorkerGoalOverride | null,
  surface: GoalGateSurface = DEFAULT_SURFACE,
): GoalVerdict {
  const stated = (goal ?? "").trim();

  // A real goal is accepted regardless of any override (see precedence note above).
  if (stated.length > 0) {
    const norm = normalize(stated);
    if (norm.length < GOAL_MIN_LEN) {
      return {
        ok: false,
        reason: "goal-too-short",
        message:
          `goal is too short (${norm.length} chars, need ${GOAL_MIN_LEN}). State the OBSERVABLE END ` +
          `STATE that means this work is finished — what will be true, and how anyone else could ` +
          `check it — not what to do.`,
      };
    }
    if (norm.length > GOAL_MAX_LEN) {
      return {
        ok: false,
        reason: "goal-too-long",
        message:
          `goal is ${norm.length} chars (max ${GOAL_MAX_LEN}) — that length is a status update or a ` +
          `handoff note, not a completion criterion. State ONE checkable condition: what will be true ` +
          `when this is done, in a sentence someone else could verify. Put the context in the task or ` +
          `the message; the goal is the thing anyone can check.`,
      };
    }
    if (FILLER_GOALS.has(norm)) {
      return {
        ok: false,
        reason: "goal-filler",
        message:
          `"${stated}" states no end state, so nothing can check it. Say what will be TRUE when the ` +
          `work is done (e.g. "nested groups parse and parser.test.ts passes").`,
      };
    }
    if (norm === normalize(task)) {
      return {
        ok: false,
        reason: "goal-echoes-task",
        message:
          `goal repeats the task verbatim, so it adds no checkable fact. The task is what to DO; the ` +
          `goal is what will be TRUE when it is done and how to verify it.`,
      };
    }
    return { ok: true, goal: stated };
  }

  // No goal. The only way through is an explicit, reason-bearing override.
  if (override) {
    const reason = (override.reason ?? "").trim();
    if (reason.length < OVERRIDE_REASON_MIN_LEN) {
      return {
        ok: false,
        reason: "override-reason-missing",
        message:
          `\`${surface.overrideParam}\` needs a reason of at least ${OVERRIDE_REASON_MIN_LEN} ` +
          `characters. It is recorded, so say why this call carries no checkable objective.`,
      };
    }
    return { ok: true, goal: null, override: { reason } };
  }

  return {
    ok: false,
    reason: "goal-missing",
    message:
      `${surface.tool} requires a goal: "an objectively verifiable completion criterion that anyone ` +
      `can check to determine whether the task was met" (concierge-guidelines.md, 2026-07-29). ` +
      `Set it in the SAME call as the work. Without one, nothing can tell an agent that finished ` +
      `from one that merely stopped, which is how work strands off main. Pass \`goal\`, or pass ` +
      `\`${surface.overrideParam}: { reason }\` to state that this call assigns no work.`,
  };
}
