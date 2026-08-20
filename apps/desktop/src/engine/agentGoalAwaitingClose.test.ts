// agentGoal — the `awaiting_close` state.
//
// WHAT IT IS FOR. Agent `d5d7056e` had merged work (PR #2188) and a `{kind:"human"}` goal check. It
// could not close the goal itself (correctly — `canSelfMarkMet` refuses `human` unconditionally, and
// `handleSetGoalMet` deliberately withholds `landed` evidence from human-kind goals so ancestry can
// never launder a sign-off), so the goal stayed unmet, auto-continue kept resuming it, and the row
// escalated and read as blocked on a human. The founder: *"this is not a blocked on human issue. The
// issue is that it's in the wrong status and you're nudging it in a way that it's saying that it's
// blocked on a human."*
//
// ⚠️ EVERY TEST HERE ASSERTS THE STATE, WHICH IS THE SIDE EFFECT — never the evidence that was fed
// in. And each refusal case is written as a PAIR against a positive one differing in exactly one
// field, because "it did not reach awaiting_close" is ambiguous on its own: an unrelated gate ahead
// of the rule produces the same absence (AGENTS.md, `sparkle-rvf6n`).
import { describe, it, expect } from "vitest";
import { goalStateOf, newGoal, escalateGoal, markGoalMet, type AgentGoal } from "./agentGoal";

const T0 = 1_700_000_000_000;
const SHIPPED = { landed: true, shippedAfterGoalSet: true } as const;

/** A live goal with a human-only check — the shape the measured row held. */
const humanGoal = (): AgentGoal => newGoal("PR #2188 is reviewed and merged", T0, 4 * 3_600_000, { kind: "human" });

describe("goalStateOf — awaiting_close", () => {
  it("a LANDED human-checked goal reads awaiting_close instead of unmet", () => {
    const goal = humanGoal();
    // THE PAIR. Same goal, same clock, same call — only the evidence differs. Without it the state
    // is `unmet`, which is what keeps auto-continue resuming a finished agent.
    expect(goalStateOf(goal, T0 + 60_000)).toBe("unmet");
    expect(goalStateOf(goal, T0 + 60_000, SHIPPED)).toBe("awaiting_close");
  });

  it("an ESCALATED human-checked goal reads awaiting_close — the measured row's own state", () => {
    // This is the motivating case rather than an edge: auto-continue had already spent its budget
    // and handed the row back BEFORE anyone noticed the work was merged. If the escalated latch won
    // here, the fix would not reach the row it was written for.
    const goal = escalateGoal(humanGoal(), T0 + 60_000, "The goal is still unmet");
    expect(goalStateOf(goal, T0 + 120_000)).toBe("escalated");
    expect(goalStateOf(goal, T0 + 120_000, SHIPPED)).toBe("awaiting_close");
  });

  it("does NOT write to the record — the escalation latch survives, so the reading is reversible", () => {
    // A state that erased `escalatedAt` would be a one-way door: a row whose evidence later goes
    // stale (a new goal, a reverted merge) could never fall back to what it actually is.
    const goal = escalateGoal(humanGoal(), T0 + 60_000, "The goal is still unmet");
    expect(goalStateOf(goal, T0 + 120_000, SHIPPED)).toBe("awaiting_close");
    expect(goal.escalatedAt).toBe(T0 + 60_000);
    expect(goalStateOf(goal, T0 + 120_000, { landed: true, shippedAfterGoalSet: false })).toBe("escalated");
  });

  // ── EACH CONDITION, ONE AT A TIME, EACH PAIRED WITH ITS POSITIVE ─────────────────────────────
  it("refuses when git has not been read — `undefined` is 'nobody looked', never 'landed'", () => {
    const goal = humanGoal();
    expect(goalStateOf(goal, T0 + 60_000, { landed: undefined, shippedAfterGoalSet: true })).toBe("unmet");
    expect(goalStateOf(goal, T0 + 60_000, { landed: true, shippedAfterGoalSet: true })).toBe("awaiting_close");
  });

  it("refuses when git says NOT landed", () => {
    const goal = humanGoal();
    expect(goalStateOf(goal, T0 + 60_000, { landed: false, shippedAfterGoalSet: true })).toBe("unmet");
    expect(goalStateOf(goal, T0 + 60_000, { landed: true, shippedAfterGoalSet: true })).toBe("awaiting_close");
  });

  it("refuses when the landing PREDATES the goal — the watermark is monotonic across goals", () => {
    // The new-work cycle: an agent that landed PR #1 and was then handed a fresh objective still
    // reads `landed: true` forever. Without this term it would read finished the moment it went
    // quiet, over work that predates the thing it is supposed to be doing.
    const goal = humanGoal();
    expect(goalStateOf(goal, T0 + 60_000, { landed: true, shippedAfterGoalSet: false })).toBe("unmet");
    expect(goalStateOf(goal, T0 + 60_000, { landed: true, shippedAfterGoalSet: true })).toBe("awaiting_close");
  });

  it("refuses an AGENT-CLOSABLE check — there is nobody to wait for", () => {
    // A `{kind:"landed"}` goal on landed work can be closed by the agent itself, so the honest state
    // is `unmet`: it simply has not called the tool yet. Reading it as "awaiting your close" would
    // ask the founder for a click nobody needs.
    const landedKind = newGoal("the work is on origin/main", T0, 4 * 3_600_000, { kind: "landed" });
    expect(goalStateOf(landedKind, T0 + 60_000, SHIPPED)).toBe("unmet");
    expect(goalStateOf(humanGoal(), T0 + 60_000, SHIPPED)).toBe("awaiting_close");
  });

  it("refuses a goal with NO stated check — nobody has to answer anything", () => {
    const bare = newGoal("ship the thing", T0, 4 * 3_600_000);
    expect(goalStateOf(bare, T0 + 60_000, SHIPPED)).toBe("unmet");
    expect(goalStateOf(humanGoal(), T0 + 60_000, SHIPPED)).toBe("awaiting_close");
  });

  // ── THE PROVENANCE TERM (roborev 65987) — AN INHERITED CHECK IS NOT A CHOSEN ONE ────────────
  //
  // `chargeGoalDebt` MANUFACTURES `{kind:"human"}` for any goal whose text is not landing-shaped and
  // which inherited a binding obligation, so an ORDINARY WORK GOAL ends up carrying a sign-off
  // nobody asked for. Reaching `awaiting_close` there would permanently stop auto-continue for that
  // agent — it is stranded, labelled done, waiting on a verdict no person knows is owed. That is a
  // far worse error than the miss it costs, so the term is required.
  it("refuses an INHERITED human check, and takes a chosen one on identical evidence", () => {
    const chosen = humanGoal();
    const inherited: AgentGoal = { ...chosen, verifyInherited: true };
    expect(goalStateOf(inherited, T0 + 60_000, SHIPPED)).toBe("unmet");
    expect(goalStateOf(chosen, T0 + 60_000, SHIPPED)).toBe("awaiting_close");
  });

  it("refuses a LEGACY goal whose check nobody ever stated", () => {
    // `verifyStated` absent identifies a record that predates the flag. Fail-closed here for the same
    // reason: an obligation nobody can show was chosen must not end continuation forever.
    const chosen = humanGoal();
    const legacy: AgentGoal = { ...chosen, verifyStated: undefined };
    expect(goalStateOf(legacy, T0 + 60_000, SHIPPED)).toBe("unmet");
    expect(goalStateOf(chosen, T0 + 60_000, SHIPPED)).toBe("awaiting_close");
  });

  // ── PRECEDENCE: WHAT IT MAY NOT REACH PAST ──────────────────────────────────────────────────
  it("never reaches past an existing metAt — a closed goal stays closed", () => {
    const met = markGoalMet(humanGoal(), T0 + 30_000);
    expect(goalStateOf(met, T0 + 60_000, SHIPPED)).toBe("met");
    expect(goalStateOf(humanGoal(), T0 + 60_000, SHIPPED)).toBe("awaiting_close");
  });

  it("never reaches past `discharged` — git already closed that one, nobody is waiting", () => {
    const goal = humanGoal();
    const discharged: AgentGoal = { ...goal, dischargedAt: T0 + 30_000, dischargedSha: "abc1234" };
    expect(goalStateOf(discharged, T0 + 60_000, SHIPPED)).toBe("discharged");
    expect(goalStateOf(goal, T0 + 60_000, SHIPPED)).toBe("awaiting_close");
  });

  it("never reaches past `expired` — a lapsed mandate is not a row awaiting a click", () => {
    const goal = humanGoal();
    const past = T0 + 4 * 3_600_000 + 1;
    expect(goalStateOf(goal, past, SHIPPED)).toBe("expired");
    expect(goalStateOf(goal, past - 2, SHIPPED)).toBe("awaiting_close");
  });

  it("answers `none` for no goal at all, whatever the evidence says", () => {
    expect(goalStateOf(undefined, T0, SHIPPED)).toBe("none");
  });
});
