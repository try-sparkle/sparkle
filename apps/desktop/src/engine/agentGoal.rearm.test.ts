/**
 * The CONCIERGE's re-arm lever, as pure reducers.
 *
 * Every test here pins a SAFETY PROPERTY, not a field shape: that the concierge's lever is strictly
 * weaker than the human's, that its bound cannot be reset by anything it or the agent can call, and
 * that undoing its own raise buys it no retry budget. The store-level and control-socket halves live
 * in `stores/projectStore.goal.test.ts` and `services/controlListener.test.ts`; this file is the
 * arithmetic those two rely on.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_CONCIERGE_REARMS,
  REARM_GRANT,
  chargeGoalDebt,
  escalateGoal,
  goalDebtOf,
  goalStateOf,
  mayRearmGoal,
  newGoal,
  noteContinue,
  conciergeRearmGoal,
  rearmsRemaining,
  resetGoalRetries,
  unraiseGoal,
  type AgentGoal,
} from "./agentGoal";

const T0 = 1_000_000;

/** A goal that has spent `spent` auto-continues and then escalated the way the ENGINE escalates. */
function escalated(spent: number, by: "auto" | "concierge" = "auto"): AgentGoal {
  let g = newGoal("land the retry PR", T0);
  for (let i = 0; i < spent; i++) g = noteContinue(g, `mark-${i}`);
  return escalateGoal(g, T0 + 1, "auto-continue gave up", by);
}

describe("conciergeRearmGoal — the concierge's bounded lever", () => {
  it("clears the escalation, so the goal is LIVE again and auto-continue can pick it up", () => {
    const before = escalated(20);
    expect(goalStateOf(before, T0 + 2)).toBe("escalated");

    const after = conciergeRearmGoal(before, T0 + 2, "unblocked the permission dialog");

    // The state flip is the thing the whole feature exists for.
    expect(goalStateOf(after, T0 + 2)).toBe("unmet");
    expect(after.escalatedAt).toBeUndefined();
    expect(after.escalationReason).toBeUndefined();
  });

  it("hands back a SLICE of budget, not the ceiling — the human's lever stays stronger", () => {
    const before = escalated(20);
    const rearmed = conciergeRearmGoal(before, T0 + 2, "why");
    const humanReleased = resetGoalRetries(before);

    // The concierge tops up by exactly REARM_GRANT...
    expect(rearmed.totalContinues).toBe(20 - REARM_GRANT);
    // ...while the human zeroes it outright. If these two were equal the bound would be vacuous.
    expect(humanReleased.totalContinues).toBe(0);
    expect(rearmed.totalContinues).toBeGreaterThan(humanReleased.totalContinues);
  });

  it("does NOT leave the goal looking 'clean' to goalDebtOf — the counter survives a clear", () => {
    // A goal escalated by the NO-PROGRESS bound has spent only 3, so the top-up floors to 0 and
    // every emptiness predicate would read it as owing nothing. `conciergeRearms` is what keeps the
    // debt alive, and this is the case that proves the subtraction alone is not enough.
    const rearmed = conciergeRearmGoal(escalated(3), T0 + 2, "why");
    expect(rearmed.totalContinues).toBe(0);
    expect(rearmed.escalatedAt).toBeUndefined();

    const debt = goalDebtOf(rearmed);
    expect(debt).toBeDefined();
    expect(debt!.conciergeRearms).toBe(1);
  });

  it("SPENDS a re-arm each time, and the allowance runs out", () => {
    let g = escalated(20);
    expect(mayRearmGoal(g)).toBe(true);
    expect(rearmsRemaining(g)).toBe(MAX_CONCIERGE_REARMS);

    for (let i = 1; i <= MAX_CONCIERGE_REARMS; i++) {
      g = conciergeRearmGoal(g, T0 + i, `attempt ${i}`);
      expect(g.conciergeRearms).toBe(i);
      g = escalateGoal(g, T0 + 100 + i, "gave up again");
    }

    // Allowance spent: the escalation is the human's again.
    expect(mayRearmGoal(g)).toBe(false);
    expect(rearmsRemaining(g)).toBe(0);
    expect(goalStateOf(g, T0 + 200)).toBe("escalated");
  });

  it("records WHO, WHEN and WHY so the human can see a machine put the agent back to work", () => {
    const after = conciergeRearmGoal(escalated(20), T0 + 42, "cleared the blocking prompt");
    expect(after.conciergeRearmedAt).toBe(T0 + 42);
    expect(after.conciergeRearmReason).toBe("cleared the blocking prompt");
  });

  it("a re-arm cannot refill its OWN allowance — only a human release does", () => {
    const rearmed = conciergeRearmGoal(escalated(20), T0 + 2, "why");
    expect(rearmed.conciergeRearms).toBe(1);

    // Re-arming again spends more, never less. (The refusal at the ceiling is the caller's job.)
    const twice = conciergeRearmGoal(escalateGoal(rearmed, T0 + 3, "again"), T0 + 4, "why again");
    expect(twice.conciergeRearms).toBe(2);

    // The HUMAN's lever is the only thing that refills it.
    const released = resetGoalRetries(twice);
    expect(released.conciergeRearms).toBeUndefined();
    expect(rearmsRemaining(released)).toBe(MAX_CONCIERGE_REARMS);
    expect(mayRearmGoal(released)).toBe(true);
  });
});

describe("unraiseGoal — undoing the concierge's OWN raise is free, and buys nothing", () => {
  it("clears the latch and NOTHING else — raise/clear is not a budget refill", () => {
    // The exact bypass this guards: if undoing a raise reset the counters, two calls would refill
    // MAX_CONTINUES_TOTAL and auto-escalation could never fire again.
    const spent = escalated(20, "concierge");
    const after = unraiseGoal(spent);

    expect(goalStateOf(after, T0 + 2)).toBe("unmet");
    expect(after.totalContinues).toBe(20);
    expect(after.continues).toBe(spent.continues);
    expect(after.conciergeRearms).toBeUndefined();
    expect(rearmsRemaining(after)).toBe(MAX_CONCIERGE_REARMS);
  });
});

describe("escalateGoal — the latch is what makes `escalatedBy` trustworthy", () => {
  it("defaults to `auto`, so a legacy escalation never gets the free clear", () => {
    const g = escalateGoal(newGoal("x", T0), T0 + 1, "gave up");
    expect(g.escalatedBy).toBe("auto");
  });

  it("a concierge raise CANNOT re-stamp an existing auto escalation as its own", () => {
    // Without the latch this is a complete bypass: re-stamp, then clear for free under `unraiseGoal`.
    const auto = escalated(20, "auto");
    const restamped = escalateGoal(auto, T0 + 9, "mine now", "concierge");

    expect(restamped).toBe(auto);
    expect(restamped.escalatedBy).toBe("auto");
    expect(restamped.escalationReason).toBe("auto-continue gave up");
  });
});

describe("the debt carry — clear-then-set must not launder the allowance", () => {
  it("survives the AGENT's two free-tier calls (clear the goal, then set new text)", () => {
    // This is the roborev 55451 shape, applied to the newer counter: `set_agent_goal {goal:""}`
    // then `set_agent_goal {goal:"…"}`. Without the carry the concierge could re-arm forever.
    const rearmedTwice = conciergeRearmGoal(
      escalateGoal(conciergeRearmGoal(escalated(20), T0 + 2, "one"), T0 + 3, "again"),
      T0 + 4,
      "two",
    );
    expect(rearmedTwice.conciergeRearms).toBe(MAX_CONCIERGE_REARMS);

    const debt = goalDebtOf(rearmedTwice); // the goal record is dropped; this is all that remains
    const fresh = newGoal("land the retry PR, take two", T0 + 5);
    const charged = chargeGoalDebt(fresh, debt);

    expect(charged.conciergeRearms).toBe(MAX_CONCIERGE_REARMS);
    expect(mayRearmGoal(charged)).toBe(false);
  });

  it("carries WHO escalated, so a machine give-up cannot become a freely-undoable raise", () => {
    const debt = goalDebtOf(escalated(20, "auto"));
    const charged = chargeGoalDebt(newGoal("new text", T0 + 5), debt);
    expect(charged.escalatedBy).toBe("auto");
  });

  it("adds nothing to a clean goal — the common path stays absent from the persisted blob", () => {
    expect(goalDebtOf(newGoal("clean", T0))).toBeUndefined();
    expect(newGoal("clean", T0).conciergeRearms).toBeUndefined();
  });
});
