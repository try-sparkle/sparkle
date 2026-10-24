// THE GOAL PARK — an agent's own declaration that its goal is one the resume ladder cannot move
// (epic sparkle-5i7e8x). One mechanism, three kinds, and BOTH directions pinned:
//
//   • a parked goal is NOT resumed and NOT escalated (the ladder used to re-fire these to the
//     20-continue ceiling, re-billing a whole context each time, then page a false alarm), and
//   • an agent that has NOT parked — or whose timed park has lapsed, or whose park belongs to an
//     earlier goal — is still resumed exactly as before. A stalled agent never calls a tool, so it
//     never parks; that is what keeps this from becoming a hole in the ladder.
import { describe, expect, it } from "vitest";
import {
  type AgentGoal,
  MAX_GOAL_WAIT_PARK_MS,
  MAX_WAIT_PARKS,
  activeParkOf,
  chargeGoalDebt,
  escalateGoal,
  goalDebtOf,
  newGoal,
  parkGoal,
  resetGoalRetries,
  unparkGoal,
} from "./agentGoal";
import {
  IDLE_SETTLE_MS,
  MAX_CONTINUES_TOTAL,
  MAX_CONTINUES_WITHOUT_PROGRESS,
  continuePrompt,
  decideContinuation,
  type ContinuationInput,
} from "./goalContinuation";

const T0 = 1_700_000_000_000;
const NOW = T0 + IDLE_SETTLE_MS + 1_000;

function ready(goal: AgentGoal, over: Partial<ContinuationInput> = {}): ContinuationInput {
  return {
    goal,
    status: "idle",
    now: NOW,
    idleSince: T0,
    hasTurnEndAuthority: true,
    canAcceptInput: true,
    mark: "m0",
    processAlive: undefined,
    runtime: "local",
    cloud: undefined,
    ...over,
  };
}

function parked(
  goal: AgentGoal,
  req: Parameters<typeof parkGoal>[1],
  at = T0 + 1_000,
): AgentGoal {
  const r = parkGoal(goal, req, at);
  if (!r.ok) throw new Error(`park refused: ${r.code} ${r.message}`);
  return r.goal;
}

const base = () => newGoal("Ship the auto-continue PR", T0);

describe("the baseline continues (so every `none` below is caused by the park)", () => {
  it("an unparked idle agent with an unmet goal is resumed", () => {
    expect(decideContinuation(ready(base())).action).toBe("continue");
  });
});

describe("awaiting-human (sparkle-ndmgv3, -0vp0xm, -7ynzky, -pvyeiw, -17g4ph)", () => {
  const g = () =>
    parked(base(), { kind: "awaiting-human", reason: "only the founder can raise the GCP quota" });

  it("is neither resumed nor escalated", () => {
    const d = decideContinuation(ready(g()));
    expect(d).toMatchObject({ action: "none", reason: "goal-awaiting-human" });
  });

  it("carries a remedy naming the blocker, for the human the row is surfaced to", () => {
    const d = decideContinuation(ready(g()));
    if (d.action !== "none") throw new Error("expected none");
    expect(d.remedy).toContain("only the founder can raise the GCP quota");
  });

  it("holds even past the streak AND the total ceiling — the bounds never fire on a park", () => {
    const spent = { ...g(), continues: MAX_CONTINUES_WITHOUT_PROGRESS, totalContinues: MAX_CONTINUES_TOTAL, mark: "m0" };
    expect(decideContinuation(ready(spent)).action).toBe("none");
  });

  it("an un-park puts the agent straight back on the ladder", () => {
    expect(decideContinuation(ready(unparkGoal(g()))).action).toBe("continue");
  });
});

describe("superseded (sparkle-eqrxwy, -tnm3tl, -q498nd)", () => {
  it("is refused without a ref — 'someone else did it' must name what did it", () => {
    const r = parkGoal(base(), { kind: "superseded", reason: "a sibling commit landed it" }, T0);
    expect(r).toMatchObject({ ok: false, code: "park_needs_ref" });
  });

  it("with a ref, stops the ladder and names the ref in the remedy", () => {
    const g = parked(base(), { kind: "superseded", reason: "sibling landed it", ref: "PR #3100" });
    const d = decideContinuation(ready(g));
    expect(d).toMatchObject({ action: "none", reason: "goal-superseded" });
    if (d.action !== "none") throw new Error("expected none");
    expect(d.remedy).toContain("PR #3100");
  });
});

describe("waiting-on — an external clock (sparkle-1n6o5u, -yy9jub)", () => {
  const until = T0 + 40 * 60_000;
  const g = () =>
    parked(base(), { kind: "waiting-on", reason: "worker verify run", ref: "worker w-7", untilMs: until });

  it("parks while the clock has not run out", () => {
    expect(decideContinuation(ready(g(), { now: until - 1 }))).toMatchObject({
      action: "none",
      reason: "goal-waiting-on",
    });
  });

  it("RESUMES once the stated time passes — a timed park can never strand an agent", () => {
    const d = decideContinuation(ready(g(), { now: until + 1, idleSince: T0 }));
    expect(d.action).toBe("continue");
    if (d.action !== "continue") throw new Error("expected continue");
    // ...and the resume names the gate back, instead of asking the agent to re-derive it.
    expect(d.prompt).toContain("worker verify run");
    expect(d.prompt).toContain("worker w-7");
  });

  it("is refused without a deadline, or with one in the past", () => {
    expect(parkGoal(base(), { kind: "waiting-on", reason: "ci" }, T0)).toMatchObject({ ok: false, code: "park_needs_until" });
    expect(parkGoal(base(), { kind: "waiting-on", reason: "ci", untilMs: T0 }, T0)).toMatchObject({
      ok: false,
      code: "park_needs_until",
    });
  });

  it("is refused past the maximum wait — the park is bounded by construction", () => {
    const r = parkGoal(base(), { kind: "waiting-on", reason: "ci", untilMs: T0 + MAX_GOAL_WAIT_PARK_MS + 1 }, T0);
    expect(r).toMatchObject({ ok: false, code: "park_too_long" });
    expect(parkGoal(base(), { kind: "waiting-on", reason: "ci", untilMs: T0 + MAX_GOAL_WAIT_PARK_MS }, T0).ok).toBe(true);
  });

  it("can be re-parked only a bounded number of times per goal", () => {
    let goal = base();
    for (let i = 0; i < MAX_WAIT_PARKS; i++) {
      goal = parked(goal, { kind: "waiting-on", reason: "ci", untilMs: T0 + 60_000 }, T0);
    }
    const r = parkGoal(goal, { kind: "waiting-on", reason: "ci", untilMs: T0 + 60_000 }, T0);
    expect(r).toMatchObject({ ok: false, code: "park_budget_spent" });
    // An un-park does not refill it — the agent is the party the bound defends against.
    expect(parkGoal(unparkGoal(goal), { kind: "waiting-on", reason: "ci", untilMs: T0 + 60_000 }, T0)).toMatchObject({
      ok: false,
      code: "park_budget_spent",
    });
  });

  it("activeParkOf drops a lapsed timed park and keeps an untimed one", () => {
    expect(activeParkOf(g(), until + 1)).toBeUndefined();
    expect(activeParkOf(g(), until - 1)?.kind).toBe("waiting-on");
    const h = parked(base(), { kind: "awaiting-human", reason: "x" });
    expect(activeParkOf(h, T0 + 10 * MAX_GOAL_WAIT_PARK_MS)?.kind).toBe("awaiting-human");
  });
});

describe("what a park may NOT do", () => {
  it("is refused on an empty reason", () => {
    expect(parkGoal(base(), { kind: "awaiting-human", reason: "   " }, T0)).toMatchObject({
      ok: false,
      code: "park_needs_reason",
    });
  });

  it("is refused on an escalated goal — that row already belongs to a human", () => {
    const esc = escalateGoal(base(), T0, "gave up");
    expect(parkGoal(esc, { kind: "awaiting-human", reason: "x" }, T0)).toMatchObject({
      ok: false,
      code: "goal_not_parkable",
    });
  });

  it("is refused with no goal at all", () => {
    expect(parkGoal(undefined, { kind: "awaiting-human", reason: "x" }, T0)).toMatchObject({
      ok: false,
      code: "goal_not_parkable",
    });
  });

  it("does not carry onto a NEW goal — new work is resumed as usual", () => {
    const old = parked(base(), { kind: "awaiting-human", reason: "x" });
    // The store's own new-goal path: a fresh record charged with whatever the old one owed.
    const next = chargeGoalDebt(newGoal("Do the next thing", T0 + 2_000), goalDebtOf(old));
    expect(next.park).toBeUndefined();
    expect(old.park).toBeDefined();
    expect(decideContinuation(ready(next)).action).toBe("continue");
  });

  it("a human release (resetGoalRetries) clears the park", () => {
    const g = parked(base(), { kind: "awaiting-human", reason: "x" });
    expect(resetGoalRetries(g).park).toBeUndefined();
  });
});

describe("the resume banner offers the exit that actually works (sparkle-ndmgv3)", () => {
  it("a human-verified goal is told to park awaiting-human, NOT to self-mark it met", () => {
    const g = newGoal("Get the founder's sign-off on the design", T0, undefined, { kind: "human" });
    const p = continuePrompt(g);
    expect(p).toContain("set_agent_goal_parked");
    expect(p).toContain("awaiting-human");
    expect(p).not.toContain("set_agent_goal_met with met: true");
  });

  it("a self-closable goal is still told to mark itself met, and offered the park too", () => {
    const p = continuePrompt(base());
    expect(p).toContain("set_agent_goal_met");
    expect(p).toContain("set_agent_goal_parked");
  });
});
