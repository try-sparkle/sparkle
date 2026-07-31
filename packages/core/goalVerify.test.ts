// The ONE property: a goal's check is explicit, and a `human`-verified goal cannot be closed by the
// agent that claimed it.
//
// SCOPE, stated honestly because the first version of this header got it wrong: `canSelfMarkMet` is
// the rule `set_agent_goal_met` is INTENDED to gate on, and at the time of writing nothing outside
// this module calls it (roborev 55842 — the header claimed the wiring in the present tense while
// `.claude/commands/goal.md` in the same commit said the opposite). These tests pin the RULE. The
// commit that wires it is what makes the gate real; until then this is a rule with no enforcer.
import { describe, it, expect } from "vitest";
import {
  parseGoalVerify,
  canSelfMarkMet,
  selfMarkRefusal,
  describeGoalVerify,
  GOAL_VERIFY_KINDS,
  type GoalVerify,
  type VerifyVerdict,
} from "./goalVerify";

function rejected(v: VerifyVerdict): Extract<VerifyVerdict, { ok: false }> {
  if (v.ok) throw new Error(`expected a rejection, got ${JSON.stringify(v)}`);
  return v;
}

describe("parseGoalVerify", () => {
  it("accepts each of the three kinds", () => {
    expect(parseGoalVerify({ kind: "landed" })).toEqual({ ok: true, verify: { kind: "landed" } });
    expect(parseGoalVerify({ kind: "human" })).toEqual({ ok: true, verify: { kind: "human" } });
    expect(parseGoalVerify({ kind: "command", cmd: "pnpm vitest run x.test.ts" })).toEqual({
      ok: true,
      verify: { kind: "command", cmd: "pnpm vitest run x.test.ts" },
    });
  });

  it("trims a command rather than persisting the caller's whitespace", () => {
    const v = parseGoalVerify({ kind: "command", cmd: "  cargo test goal  " });
    expect(v).toEqual({ ok: true, verify: { kind: "command", cmd: "cargo test goal" } });
  });

  it("refuses a MISSING verify rather than defaulting to one", () => {
    // A default would be a lie in either direction: `human` silently routes work to the founder,
    // `landed` claims a git proof nobody asked for. The caller must say which.
    for (const absent of [undefined, null]) {
      expect(rejected(parseGoalVerify(absent)).reason).toBe("verify-missing");
    }
    // The message must name all three options, or the caller cannot fix the call.
    const msg = rejected(parseGoalVerify(undefined)).message;
    for (const kind of GOAL_VERIFY_KINDS) expect(msg).toContain(kind);
  });

  it("refuses an unknown kind and names the legal ones", () => {
    const v = rejected(parseGoalVerify({ kind: "vibes" }));
    expect(v.reason).toBe("verify-unknown-kind");
    for (const kind of GOAL_VERIFY_KINDS) expect(v.message).toContain(kind);
    // A non-string kind is the same refusal, not a crash.
    expect(rejected(parseGoalVerify({ kind: 7 })).reason).toBe("verify-unknown-kind");
    expect(rejected(parseGoalVerify({})).reason).toBe("verify-unknown-kind");
  });

  it("refuses a command kind with no cmd", () => {
    expect(rejected(parseGoalVerify({ kind: "command" })).reason).toBe("verify-cmd-missing");
    expect(rejected(parseGoalVerify({ kind: "command", cmd: "   " })).reason).toBe("verify-cmd-missing");
  });

  it("refuses a NON-OBJECT with a message that says an object is required", () => {
    // `parseGoalVerify("human")` is what a caller following the `check: human` shorthand tries first.
    // The old code read `.kind` off the string, got undefined, and reported "unknown verify kind
    // undefined" — naming a value the caller never passed (roborev 55842).
    for (const bad of ["human", 7, true, ["human"]]) {
      const v = rejected(parseGoalVerify(bad));
      expect(v.reason).toBe("verify-not-an-object");
      expect(v.message).toMatch(/object/i);
      expect(v.message).not.toContain("undefined");
    }
  });

  it("accepts any non-blank command, including prose-shaped ones, by design", () => {
    // There is deliberately NO prose heuristic: no cheap rule separates "npm test" from "all tests
    // are green" without rejecting real two-word commands, and a false rejection blocks a legitimate
    // goal. A non-runnable cmd fails loudly at execution, which is better feedback than a guess.
    for (const cmd of [
      "pnpm --filter @sparkle/desktop exec vitest run src/x.test.ts",
      "cargo test goal_gate",
      "npm test",
      "make check",
      "make sure the tests pass",
    ]) {
      expect(parseGoalVerify({ kind: "command", cmd }).ok).toBe(true);
    }
  });
});

describe("canSelfMarkMet — the self-report gate", () => {
  it("REFUSES a human-verified goal to its own claimant", () => {
    // The whole reason the `human` kind exists. If this returns true the kind is decorative.
    expect(canSelfMarkMet({ kind: "human" })).toBe(false);
  });

  it("REFUSES command and landed to their own claimant too, not just human", () => {
    // These returned `true` in the first version, on the theory that such a claim was "admissible
    // pending a check". That does not survive contact with what it gates: set_agent_goal_met LATCHES
    // metAt and nothing re-verifies it, so an agent allowed to call it has self-reported "done"
    // whatever the kind said. "I ran the command and it passed" IS the self-report being replaced.
    expect(canSelfMarkMet({ kind: "command", cmd: "npm test" })).toBe(false);
    expect(canSelfMarkMet({ kind: "landed" })).toBe(false);
  });

  it("names the specific check in each refusal, so the agent knows what would satisfy it", () => {
    // A generic "you cannot mark this met" leaves the agent with no next action — the refusal has to
    // say what WOULD close the goal.
    expect(selfMarkRefusal({ kind: "command", cmd: "cargo test goal_gate" })).toContain("cargo test goal_gate");
    expect(selfMarkRefusal({ kind: "landed" })).toContain("origin/main");
    expect(selfMarkRefusal({ kind: "human" })).toMatch(/person|human/i);
  });

  it("names a PERSON as the closer, never an automated proof that does not exist", () => {
    // THIS IS THE COPY AN AGENT READS WHILE BLOCKED, which makes it the worst place to promise an
    // automation that is not there (roborev 56154). These arms used to end "let the check … close the
    // goal" and "the proof closes the goal, not your say-so" — but no executor exists: `verify` is
    // read only by canSelfMarkMet/selfMarkRefusal, carried by chargeGoalDebt and rendered by
    // describeGoalVerify. An agent that states `command`, finishes, is refused, and reads "the proof
    // closes the goal" waits for a proof that never arrives — and since `verify: null` is
    // concierge-only it stays un-closable and auto-resumed until a person notices.
    const cmd = selfMarkRefusal({ kind: "command", cmd: "cargo test goal_gate" });
    const landed = selfMarkRefusal({ kind: "landed" });
    for (const msg of [cmd, landed]) {
      expect(msg).toMatch(/a person closes the goal/i);
    }
    expect(cmd).toMatch(/nothing runs the check for you today/i);
    expect(landed).toMatch(/no code computes `landed` today/i);
    // The promise of an automated closer must be GONE, not merely accompanied by the caveat.
    expect(landed).not.toMatch(/computed from git/);
    expect(landed).not.toMatch(/the proof closes the goal/);
    expect(cmd).not.toMatch(/let the check .* close the goal/);
  });

  it("leaves legacy goals with no verify exactly as they were", () => {
    // Every goal that existed before this module has no `verify`. Refusing those would break
    // set_agent_goal_met for the whole installed base to enforce a rule they never opted into.
    expect(canSelfMarkMet(undefined)).toBe(true);
  });

  it("has a refusal sentence for every kind it refuses", () => {
    const msg = selfMarkRefusal({ kind: "human" });
    expect(msg).toMatch(/cannot mark it met/i);
    // Total, not partial: no kind yields an empty string a UI would render as a blank refusal.
    for (const kind of GOAL_VERIFY_KINDS) {
      const v: GoalVerify = kind === "command" ? { kind, cmd: "npm test" } : ({ kind } as GoalVerify);
      expect(selfMarkRefusal(v).length).toBeGreaterThan(0);
    }
  });
});

describe("describeGoalVerify", () => {
  it("renders every kind, and says so when no check was stated", () => {
    expect(describeGoalVerify({ kind: "command", cmd: "npm test" })).toContain("npm test");
    expect(describeGoalVerify({ kind: "landed" })).toContain("origin/main");
    expect(describeGoalVerify({ kind: "human" })).toContain("person");
    // ABSENT must read as absent, never as a check that exists.
    expect(describeGoalVerify(undefined)).toBe("no check stated");
  });
});
