/**
 * The CONCIERGE's re-arm lever at the STORE layer.
 *
 * The pure arithmetic is pinned in `engine/agentGoal.rearm.test.ts`. What this file exists for is
 * the part that arithmetic cannot see: that a re-arm survives the two free-tier calls an AGENT can
 * make, that the debt stash cannot silently re-apply the escalation we just cleared, and that a
 * human's typed line is still strictly stronger than anything the concierge can call.
 *
 * Several of these guard failures that are SILENT AND LOOK SAFE — a re-armed goal already reads
 * `unmet`, so a test asserting only `goalStateOf` passes against a store that dropped the bound.
 * Every test here therefore asserts the counter or the resulting capability, never the state alone.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { useProjectStore } from "./projectStore";
import {
  MAX_CONCIERGE_REARMS,
  REARM_GRANT,
  goalStateOf,
  mayRearmGoal,
  rearmsRemaining,
} from "../engine/agentGoal";
import type { AgentTab, Project } from "../types";

function mkAgent(): AgentTab {
  return {
    id: "a1", name: "A1", kind: "build", parentId: null, runtime: "local",
    worktreePath: null, branch: null, baseBranch: null, lastPrompt: "",
    promptHistory: [], namePinned: false, autoNameBasis: null,
    autoNameVariants: null, shellCommand: null,
  };
}

function seed() {
  const project: Project = {
    id: "p1", name: "P", rootPath: "/tmp/p", defaultBranch: null,
    createdAt: new Date(0).toISOString(), selectedAgentId: null, agents: [mkAgent()],
  };
  useProjectStore.setState({ projects: [project] } as never);
}

const agent = () => useProjectStore.getState().projects[0]!.agents[0]!;
const store = () => useProjectStore.getState();

function burn(n: number, mark = "stuck") {
  for (let i = 0; i < n; i++) store().noteAgentGoalContinue("p1", "a1", mark);
}

/** Drive an agent to a real MACHINE escalation, the way the continuation runner does. */
function escalate(spent = 20) {
  store().setAgentGoal("p1", "a1", "land the retry PR");
  burn(spent);
  store().escalateAgentGoal("p1", "a1", "three continues, no progress", Date.now());
}

describe("conciergeRearmAgentGoal — the concierge clears a machine escalation", () => {
  beforeEach(seed);

  it("clears it and reports success, so the goal is live for the sweep again", () => {
    escalate();
    expect(goalStateOf(agent().goal, Date.now())).toBe("escalated");

    expect(store().conciergeRearmAgentGoal("p1", "a1", "unblocked the dialog", Date.now())).toBe(true);

    expect(goalStateOf(agent().goal, Date.now())).toBe("unmet");
    expect(agent().goal?.conciergeRearms).toBe(1);
    expect(agent().goal?.conciergeRearmReason).toBe("unblocked the dialog");
  });

  it("hands back only a SLICE of budget", () => {
    escalate(20);
    store().conciergeRearmAgentGoal("p1", "a1", "why", Date.now());
    expect(agent().goal?.totalContinues).toBe(20 - REARM_GRANT);
  });

  it("refuses once the allowance is spent, leaving the escalation latched for the human", () => {
    escalate();
    for (let i = 0; i < MAX_CONCIERGE_REARMS; i++) {
      expect(store().conciergeRearmAgentGoal("p1", "a1", `try ${i}`, Date.now())).toBe(true);
      store().escalateAgentGoal("p1", "a1", "gave up again", Date.now());
    }

    // THE BOUND: the third clear is refused and the goal stays the human's.
    expect(store().conciergeRearmAgentGoal("p1", "a1", "one more", Date.now())).toBe(false);
    expect(goalStateOf(agent().goal, Date.now())).toBe("escalated");
    expect(mayRearmGoal(agent().goal)).toBe(false);
  });

  it("is a no-op on a goal that is not escalated — it cannot be used as a plain budget top-up", () => {
    store().setAgentGoal("p1", "a1", "land the retry PR");
    burn(10);

    expect(store().conciergeRearmAgentGoal("p1", "a1", "free budget please", Date.now())).toBe(false);
    expect(agent().goal?.totalContinues).toBe(10);
    expect(agent().goal?.conciergeRearms).toBeUndefined();
  });

  it("refuses a MET-but-latched goal, so a stale clear cannot spend a re-arm on finished work", () => {
    // `markGoalMet` does not clear `escalatedAt`, so a resolved escalation keeps the latch after
    // the work is done (sparkle-0qq4hx). Without the metAt guard this clear would fall through to
    // the CHARGED branch: strip the latch, refund REARM_GRANT off totalContinues and burn one of
    // the finite allowance. Assert the SIDE EFFECT that would happen without the guard is absent —
    // the counter, not the state (a re-armed goal already reads `unmet`, so state alone is vacuous).
    escalate(20);
    store().setAgentGoalMet("p1", "a1", true);
    expect(agent().goal?.metAt).toEqual(expect.any(Number));
    expect(agent().goal?.escalatedAt).toEqual(expect.any(Number)); // the latch outlived being met

    expect(store().conciergeRearmAgentGoal("p1", "a1", "sweeping a stale notification", Date.now())).toBe(
      false,
    );

    expect(agent().goal?.conciergeRearms).toBeUndefined(); // no allowance spent
    expect(agent().goal?.totalContinues).toBe(20); // no REARM_GRANT refund
    expect(rearmsRemaining(agent().goal)).toBe(MAX_CONCIERGE_REARMS); // full allowance intact

    // PAIRED: the SAME escalation setup, not marked met, IS re-armed — proving the refusal above is
    // caused by `metAt` and not by some earlier gate short-circuiting the path.
    seed();
    escalate(20);
    expect(store().conciergeRearmAgentGoal("p1", "a1", "genuinely unblocked", Date.now())).toBe(true);
    expect(agent().goal?.conciergeRearms).toBe(1);
  });
});

describe("undoing the concierge's OWN raise", () => {
  beforeEach(seed);

  it("costs no allowance and refills no budget", () => {
    // The bypass this guards: if raise-then-clear reset the counters, two calls would refill
    // MAX_CONTINUES_TOTAL and auto-escalation could never fire again.
    store().setAgentGoal("p1", "a1", "land the retry PR");
    burn(18);
    store().conciergeEscalateAgentGoal("p1", "a1", "a person should look at this", Date.now());
    expect(goalStateOf(agent().goal, Date.now())).toBe("escalated");

    expect(store().conciergeRearmAgentGoal("p1", "a1", "never mind", Date.now())).toBe(true);

    expect(goalStateOf(agent().goal, Date.now())).toBe("unmet");
    expect(agent().goal?.totalContinues).toBe(18);
    expect(rearmsRemaining(agent().goal)).toBe(MAX_CONCIERGE_REARMS);
  });

  it("a concierge raise cannot re-stamp a MACHINE escalation and launder it into the free path", () => {
    escalate(20);
    store().conciergeEscalateAgentGoal("p1", "a1", "mine now", Date.now());

    // The latch held: still an auto escalation, so clearing it is CHARGED.
    expect(agent().goal?.escalatedBy).toBe("auto");
    expect(store().conciergeRearmAgentGoal("p1", "a1", "clear it", Date.now())).toBe(true);
    expect(agent().goal?.conciergeRearms).toBe(1);
    expect(agent().goal?.totalContinues).toBe(20 - REARM_GRANT);
  });
});

describe("the allowance survives everything an AGENT can call", () => {
  beforeEach(seed);

  it("clear-then-set does not launder it (the two free-tier calls)", () => {
    escalate();
    store().conciergeRearmAgentGoal("p1", "a1", "one", Date.now());
    store().escalateAgentGoal("p1", "a1", "again", Date.now());
    store().conciergeRearmAgentGoal("p1", "a1", "two", Date.now());
    expect(agent().goal?.conciergeRearms).toBe(MAX_CONCIERGE_REARMS);

    // `set_agent_goal {goal: ""}` then `set_agent_goal {goal: "…"}`, both as the AGENT.
    store().setAgentGoal("p1", "a1", "", undefined, "agent");
    expect(agent().goal).toBeUndefined();
    store().setAgentGoal("p1", "a1", "land the retry PR, take two", undefined, "agent");

    expect(agent().goal?.conciergeRearms).toBe(MAX_CONCIERGE_REARMS);
    expect(mayRearmGoal(agent().goal)).toBe(false);
  });

  it("a re-arm does not leave the stash able to re-apply the escalation one call later", () => {
    // Without clearing the stash, `chargeGoalDebt` re-latches on the next goal text and the clear
    // silently undoes itself — it would look like it worked, then stop working.
    store().setAgentGoal("p1", "a1", "land the retry PR");
    burn(20);
    store().escalateAgentGoal("p1", "a1", "gave up", Date.now());
    store().setAgentGoal("p1", "a1", "", undefined, "agent"); // escalation now lives in goalDebt
    store().setAgentGoal("p1", "a1", "restated goal", undefined, "agent");
    expect(goalStateOf(agent().goal, Date.now())).toBe("escalated");

    expect(store().conciergeRearmAgentGoal("p1", "a1", "cleared it", Date.now())).toBe(true);
    store().setAgentGoal("p1", "a1", "restated again", undefined, "agent");

    expect(goalStateOf(agent().goal, Date.now())).toBe("unmet");
  });

  it("clears an escalation that outlived its goal record — the state nothing could recover", () => {
    store().setAgentGoal("p1", "a1", "land the retry PR");
    burn(20);
    store().escalateAgentGoal("p1", "a1", "gave up", Date.now());
    store().setAgentGoal("p1", "a1", "", undefined, "agent");
    expect(agent().goal).toBeUndefined();
    expect(agent().goalDebt?.escalatedAt).toEqual(expect.any(Number));

    expect(store().conciergeRearmAgentGoal("p1", "a1", "unblocked", Date.now())).toBe(true);
    expect(agent().goalDebt?.escalatedAt).toBeUndefined();

    // A new goal is genuinely live rather than born escalated.
    store().setAgentGoal("p1", "a1", "a fresh goal", undefined, "agent");
    expect(goalStateOf(agent().goal, Date.now())).toBe("unmet");
  });
});

describe("the HUMAN's lever stays strictly stronger", () => {
  beforeEach(seed);

  /**
   * Escalate at the NO-PROGRESS bound rather than the total one.
   *
   * THIS IS THE WHOLE POINT OF THESE TESTS, and getting it wrong makes every one of them vacuous.
   * A goal escalated at 20 still has `totalContinues: 15` after a top-up, so the three "nothing
   * owed" predicates are already decided by that field and the `conciergeRearms` clause never gets a
   * vote — a mutation-check confirmed all three clauses could be deleted with the suite still
   * green. Escalating at 3 makes the top-up floor `totalContinues` to 0, which — with the
   * escalation and mark also dropped by the re-arm — is EXACTLY the "clean" shape those predicates
   * key on. Only then does the clause decide anything.
   */
  function escalateCheap() {
    store().setAgentGoal("p1", "a1", "land the retry PR");
    burn(3);
    store().escalateAgentGoal("p1", "a1", "three continues, no progress", Date.now());
  }

  it("refills the allowance even when the re-arm left the goal looking CLEAN", () => {
    escalateCheap();
    expect(store().conciergeRearmAgentGoal("p1", "a1", "unblocked it", Date.now())).toBe(true);

    // The shape that defeats a predicate which only asks about continues and escalation.
    expect(agent().goal?.totalContinues).toBe(0);
    expect(agent().goal?.continues).toBe(0);
    expect(agent().goal?.escalatedAt).toBeUndefined();
    expect(agent().goal?.mark).toBeUndefined();
    expect(agent().goal?.conciergeRearms).toBe(1);

    store().appendPrompt("p1", "a1", "here, try this instead", "composer", true);

    expect(agent().goal?.conciergeRearms).toBeUndefined();
    expect(rearmsRemaining(agent().goal)).toBe(MAX_CONCIERGE_REARMS);
  });

  it("refills it when the allowance survives only in the STASH, with no goal record at all", () => {
    escalateCheap();
    store().conciergeRearmAgentGoal("p1", "a1", "unblocked it", Date.now());
    store().setAgentGoal("p1", "a1", "", undefined, "agent"); // agent clears; debt is all that is left
    expect(agent().goal).toBeUndefined();
    expect(agent().goalDebt?.conciergeRearms).toBe(1);
    expect(agent().goalDebt?.totalContinues).toBe(0);

    store().appendPrompt("p1", "a1", "here, try this instead", "composer", true);
    expect(agent().goalDebt).toBeUndefined();

    // The refill is only real if the NEXT goal actually starts with a full allowance.
    store().setAgentGoal("p1", "a1", "a fresh goal", undefined, "agent");
    expect(agent().goal?.conciergeRearms).toBeUndefined();
    expect(mayRearmGoal(agent().goal)).toBe(true);
  });

  it("a MACHINE-authored line does NOT refill it — that bound is the whole feature", () => {
    escalateCheap();
    store().conciergeRearmAgentGoal("p1", "a1", "one", Date.now());
    store().escalateAgentGoal("p1", "a1", "again", Date.now());
    store().conciergeRearmAgentGoal("p1", "a1", "two", Date.now());
    expect(mayRearmGoal(agent().goal)).toBe(false);

    store().appendPrompt("p1", "a1", "LLM-composed nudge", "composer", false);

    expect(agent().goal?.conciergeRearms).toBe(MAX_CONCIERGE_REARMS);
    expect(mayRearmGoal(agent().goal)).toBe(false);
  });

  it("a verify take-back is not a re-arm refill — two levers, kept separate", () => {
    // `stripVerify` drops the CHECK from the stash. It must not also drop the allowance, or the
    // concierge's own `verify: null` becomes a way to hand itself unlimited re-arms.
    store().setAgentGoal("p1", "a1", "land the retry PR", undefined, "agent", { kind: "human" });
    burn(3);
    store().escalateAgentGoal("p1", "a1", "no progress", Date.now());
    store().conciergeRearmAgentGoal("p1", "a1", "unblocked it", Date.now());
    store().setAgentGoal("p1", "a1", "", undefined, "agent", null);

    expect(agent().goalDebt?.verify).toBeUndefined();
    expect(agent().goalDebt?.conciergeRearms).toBe(1);

    store().setAgentGoal("p1", "a1", "restated", undefined, "agent");
    expect(agent().goal?.conciergeRearms).toBe(1);
  });
});
