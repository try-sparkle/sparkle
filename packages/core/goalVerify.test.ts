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

  it("admits command and landed claims for CHECKING (not for trusting)", () => {
    expect(canSelfMarkMet({ kind: "command", cmd: "npm test" })).toBe(true);
    expect(canSelfMarkMet({ kind: "landed" })).toBe(true);
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
