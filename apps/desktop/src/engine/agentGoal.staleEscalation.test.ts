// BUG A — the escalation SENTENCE freezes the goal text; the goal OBJECT does not.
//
// `decideContinuation` interpolates the live goal text into "…The goal is still unmet: "<text>"…"
// at the instant it decides to escalate, and `escalateGoal` latches that sentence forever. When the
// agent later calls `set_agent_goal` with new text, `chargeGoalDebt` DELIBERATELY carries the old
// `escalatedAt`/`escalationReason` onto the new goal object (anti-gaming: an agent must not launder
// away an escalation by rewording its goal). Nothing regenerates the sentence, so the roster shows
// the live goal while the escalation quotes a superseded one — on the same record, forever.
//
// Measured live: an agent's own goal read back as `state: "escalated"` with an `escalationReason`
// quoting the goal it held two goals ago, and a founder acted on three such escalations as if they
// were live claims.
//
// The fix does NOT rewrite the sentence — the frozen text is the record of what the agent was
// actually stuck on when auto-continue gave up, and rewriting it destroys that. It records the text
// the sentence QUOTED (`escalatedGoalText`) so any reader can tell a live quote from a stale one.
//
// WHY EVERY STRIP IS TESTED: `escalatedGoalText` must die wherever `escalationReason` dies. A quote
// that outlives its sentence makes the NEXT escalation compare against a dead string — which is the
// stale-read bug reintroduced one field over.
import { describe, expect, it } from "vitest";

import type { AgentGoal } from "./agentGoal";
import {
  chargeGoalDebt,
  conciergeRearmGoal,
  escalateGoal,
  escalationQuotesStaleText,
  goalDebtOf,
  newGoal,
  resetGoalRetries,
  unraiseGoal,
} from "./agentGoal";

const T0 = 1_000_000;

/** A goal that auto-continue has given up on, quoting the text it held at that moment. */
function escalatedOn(text: string, reason?: string) {
  const g = newGoal(text, T0, 4 * 60 * 60 * 1000);
  return escalateGoal(
    { ...g, totalContinues: 6 },
    T0 + 1000,
    reason ?? `Auto-continued 3 times with no sign of progress. The goal is still unmet: "${text}".`,
  );
}

describe("escalateGoal records the text its sentence quoted", () => {
  it("stamps escalatedGoalText from the goal's text at escalation time", () => {
    const g = escalatedOn("land PR #1861");
    expect(g.escalatedGoalText).toBe("land PR #1861");
  });

  it("does not read as stale while the goal still holds that text", () => {
    expect(escalationQuotesStaleText(escalatedOn("land PR #1861"))).toBe(false);
  });

  it("leaves the field absent on a goal that was never escalated", () => {
    const g = newGoal("land PR #1861", T0, 1000);
    expect(g.escalatedGoalText).toBeUndefined();
    expect(escalationQuotesStaleText(g)).toBe(false);
  });

  // FAIL-CLOSED. A goal escalated before this field existed carries no quote, so nothing can be
  // compared — and "I cannot tell" must read as NOT stale. Reporting the entire installed base's
  // escalations as stale would discredit the very marker this adds.
  it("reads a pre-field escalation as not-stale rather than guessing", () => {
    // The text HAS moved on — so this is the exact shape that would report stale if the predicate
    // guessed from the sentence instead of the recorded quote. Without the divergence the
    // assertion would pass against any implementation and prove nothing.
    const legacy: AgentGoal = { ...escalatedOn("land PR #1861"), text: "drain roborev findings" };
    delete legacy.escalatedGoalText;
    expect(legacy.escalationReason).toContain("land PR #1861");
    expect(escalationQuotesStaleText(legacy)).toBe(false);
  });
});

describe("the stale quote is detectable after the goal text moves on", () => {
  // THE BUG, reproduced end to end through the real carry path.
  it("reports stale once chargeGoalDebt grafts the escalation onto new text", () => {
    const stuck = escalatedOn("land PR #1861");
    const debt = goalDebtOf(stuck);
    const next = chargeGoalDebt(newGoal("drain roborev findings", T0 + 5000, 1000), debt);

    // The escalation survived onto the new goal — that carry is deliberate, not the bug.
    expect(next.escalatedAt).toBeDefined();
    // …and its sentence still quotes the goal the agent no longer holds. This is what a founder
    // reads as a live claim.
    expect(next.escalationReason).toContain("land PR #1861");
    expect(next.text).toBe("drain roborev findings");

    expect(escalationQuotesStaleText(next)).toBe(true);
  });

  it("carries escalatedGoalText through chargeGoalDebt so the comparison survives the graft", () => {
    const debt = goalDebtOf(escalatedOn("land PR #1861"));
    const next = chargeGoalDebt(newGoal("drain roborev findings", T0 + 5000, 1000), debt);
    expect(next.escalatedGoalText).toBe("land PR #1861");
  });

  it("copies escalatedGoalText into the debt stash when the goal record is dropped", () => {
    expect(goalDebtOf(escalatedOn("land PR #1861"))?.escalatedGoalText).toBe("land PR #1861");
  });

  // The agent re-stating the SAME text must not manufacture staleness.
  it("stays not-stale when new goal text is identical to the quoted text", () => {
    const debt = goalDebtOf(escalatedOn("land PR #1861"));
    const next = chargeGoalDebt(newGoal("land PR #1861", T0 + 5000, 1000), debt);
    expect(escalationQuotesStaleText(next)).toBe(false);
  });
});

describe("the quote dies wherever the sentence dies", () => {
  it("conciergeRearmGoal drops it with the escalation it belonged to", () => {
    const cleared = conciergeRearmGoal(escalatedOn("land PR #1861"), T0 + 2000, "unblocked its PR");
    expect(cleared.escalationReason).toBeUndefined();
    expect(cleared.escalatedGoalText).toBeUndefined();
  });

  it("unraiseGoal drops it", () => {
    const cleared = unraiseGoal(escalatedOn("land PR #1861"));
    expect(cleared.escalationReason).toBeUndefined();
    expect(cleared.escalatedGoalText).toBeUndefined();
  });

  it("resetGoalRetries drops it", () => {
    const cleared = resetGoalRetries(escalatedOn("land PR #1861"));
    expect(cleared.escalationReason).toBeUndefined();
    expect(cleared.escalatedGoalText).toBeUndefined();
  });

  // THE ANTI-LOOP PROPERTY, and the reason the three strips above are not merely tidy. After a
  // concierge re-arm the agent works on, restates its goal, and stalls again. If the dead quote had
  // survived the clear, the fresh escalation would be compared against text from the PREVIOUS
  // escalation and reported stale on arrival — a true escalation dismissed as false, which is worse
  // than the bug being fixed.
  it("a re-armed goal that escalates again on new text reads as a LIVE quote", () => {
    const cleared = conciergeRearmGoal(escalatedOn("land PR #1861"), T0 + 2000, "unblocked its PR");
    const moved = chargeGoalDebt(newGoal("drain roborev findings", T0 + 3000, 1000), goalDebtOf(cleared));
    const again = escalateGoal(
      moved,
      T0 + 9000,
      'Auto-continued 3 times with no sign of progress. The goal is still unmet: "drain roborev findings".',
    );

    expect(again.escalatedGoalText).toBe("drain roborev findings");
    expect(escalationQuotesStaleText(again)).toBe(false);
  });
});
