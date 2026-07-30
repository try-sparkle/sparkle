// The ONE property this module guarantees: a worker is never dispatched without an objectively
// verifiable completion criterion, and an absent criterion is only permitted when the absence is
// RECORDED with a reason.
//
// Every case below asserts the VERDICT (the decision the gate reached), not that the input parsed.
// The rejection cases are the point: each one is a shape that reads like a goal to a human skimming
// a tool call and is worthless to anything that has to CHECK the goal later.
import { describe, it, expect } from "vitest";
import {
  validateWorkerGoal,
  GOAL_MIN_LEN,
  GOAL_MAX_LEN,
  OVERRIDE_REASON_MIN_LEN,
  type GoalVerdict,
} from "./goalGate";

const TASK = "refactor the expression parser to support nested groups";
const GOOD_GOAL = "nested groups parse and parser.test.ts passes";

/** Narrow to the rejection arm, failing loudly with the actual verdict when it accepted. */
function rejected(v: GoalVerdict): Extract<GoalVerdict, { ok: false }> {
  if (v.ok) throw new Error(`expected a rejection, got ${JSON.stringify(v)}`);
  return v;
}

describe("validateWorkerGoal — a stated, checkable goal", () => {
  it("accepts a goal that names an end state and returns it trimmed for persistence", () => {
    const v = validateWorkerGoal(`  ${GOOD_GOAL}  `, TASK);
    expect(v).toEqual({ ok: true, goal: GOOD_GOAL });
  });

  it("does NOT require an override when a real goal is present", () => {
    const v = validateWorkerGoal(GOOD_GOAL, TASK);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.override).toBeUndefined();
  });
});

describe("validateWorkerGoal — refusals", () => {
  it("refuses a missing goal, and says so as `goal-missing`", () => {
    for (const absent of [undefined, null, "", "   ", "\n\t "]) {
      expect(rejected(validateWorkerGoal(absent, TASK)).reason).toBe("goal-missing");
    }
  });

  it("refuses a goal too short to state an end state", () => {
    const v = rejected(validateWorkerGoal("ship it now", TASK));
    expect(v.reason).toBe("goal-too-short");
    // The message must name the threshold, or the caller cannot fix it without reading the source.
    expect(v.message).toContain(String(GOAL_MIN_LEN));
  });

  // The regression case. A real message the concierge sent an agent AS a goal: narrative prose
  // covering two unrelated topics. Every other rule passes it — well over GOAL_MIN_LEN, not filler,
  // not an echo of the task — so before GOAL_MAX_LEN existed the gate ACCEPTED exactly the shape
  // nothing can be held to. This asserts the cap is what catches it, by first proving the other
  // rules do not.
  it("refuses a narrative status report pasted in as a goal", () => {
    const narrative =
      "The mount is still only half-fixed. What's landed makes the mount visible and correct — the " +
      "concierge floods, the row bolds, Escape unmounts, no stale binding. It does not yet route: " +
      "engine/shellResolve.ts still contains zero references to wired, so a mounted message goes " +
      "wherever the cable-blind auto-router sends it. That's the next piece.";
    expect(narrative.length).toBeGreaterThan(GOAL_MAX_LEN);

    const v = rejected(validateWorkerGoal(narrative, TASK));
    expect(v.reason).toBe("goal-too-long");
    expect(v.message).toContain(String(GOAL_MAX_LEN));
  });

  it("still accepts a thorough multi-condition criterion under the cap", () => {
    // The cap targets narrative, not thoroughness. A criterion naming several checkable conditions
    // must survive, or the rule just punishes precision.
    const multi =
      "nested groups parse, parser.test.ts passes, and the CLI exits 0 on the fixture corpus";
    expect(multi.length).toBeLessThanOrEqual(GOAL_MAX_LEN);
    expect(validateWorkerGoal(multi, TASK)).toEqual({ ok: true, goal: multi });
  });

  it("refuses filler that is long enough to pass a length check but states nothing checkable", () => {
    // Each of these clears GOAL_MIN_LEN, so ONLY the filler rule can catch them. That is the point:
    // a length floor alone is not a gate.
    for (const filler of ["complete the task", "complete the work", "as described above", "implement the task"]) {
      expect(filler.length).toBeGreaterThanOrEqual(GOAL_MIN_LEN);
      expect(rejected(validateWorkerGoal(filler, TASK)).reason).toBe("goal-filler");
    }
  });

  it("sees through casing and punctuation when matching filler", () => {
    for (const dressed of ["Complete the task.", "  COMPLETE THE TASK  ", "*complete the task*"]) {
      expect(rejected(validateWorkerGoal(dressed, TASK)).reason).toBe("goal-filler");
    }
  });

  it("refuses a goal that merely echoes the task, however it is dressed up", () => {
    for (const echo of [TASK, `  ${TASK.toUpperCase()}.  `]) {
      expect(rejected(validateWorkerGoal(echo, TASK)).reason).toBe("goal-echoes-task");
    }
  });

  it("still accepts a goal that CONTAINS a filler word inside a real criterion", () => {
    // The filler rule is a whole-string match on purpose; substring matching would reject this.
    const v = validateWorkerGoal("the migration is complete and migrate.test.ts passes", TASK);
    expect(v).toEqual({ ok: true, goal: "the migration is complete and migrate.test.ts passes" });
  });
});

describe("validateWorkerGoal — the override is recorded, never silent", () => {
  it("accepts an absent goal ONLY with a substantive reason, and reports goal null", () => {
    const reason = "spike to reproduce a crash; no completion criterion exists yet";
    const v = validateWorkerGoal(undefined, TASK, { reason });
    expect(v).toEqual({ ok: true, goal: null, override: { reason } });
  });

  it("refuses an override whose reason is too thin to audit", () => {
    const v = rejected(validateWorkerGoal(undefined, TASK, { reason: "because" }));
    expect(v.reason).toBe("override-reason-missing");
    expect(v.message).toContain(String(OVERRIDE_REASON_MIN_LEN));
  });

  it("prefers a VALID GOAL over an override rather than discarding the goal", () => {
    // A caller supplying both meant to state a goal. Honouring the override here would mark a
    // worker goalless while a perfectly good criterion sat in the same call.
    const v = validateWorkerGoal(GOOD_GOAL, TASK, { reason: "a reason long enough to pass" });
    expect(v).toEqual({ ok: true, goal: GOOD_GOAL });
  });

  it("an override does NOT rescue a goal that was stated but bad", () => {
    // Otherwise every rejection is bypassable by attaching a reason, and the gate is decorative.
    const v = rejected(validateWorkerGoal("done", TASK, { reason: "a reason long enough to pass" }));
    expect(v.reason).toBe("goal-too-short");
  });
});
