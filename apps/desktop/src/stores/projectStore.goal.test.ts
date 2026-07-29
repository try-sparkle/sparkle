import { beforeEach, describe, expect, it } from "vitest";
import { migratePersisted, mergePreservingLiveWorkers, useProjectStore } from "./projectStore";
import { goalStateOf } from "../engine/agentGoal";
import { MAX_CONTINUES_WITHOUT_PROGRESS, decideContinuation } from "../engine/goalContinuation";
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

/** Spend N auto-continues at an unchanged mark, as a stuck agent's runner would. */
function burn(n: number, mark = "stuck") {
  for (let i = 0; i < n; i++) store().noteAgentGoalContinue("p1", "a1", mark);
}

describe("setAgentGoal", () => {
  beforeEach(seed);

  it("sets a goal that reads as unmet", () => {
    store().setAgentGoal("p1", "a1", "Land the PR");
    expect(agent().goal?.text).toBe("Land the PR");
    expect(goalStateOf(agent().goal, Date.now())).toBe("unmet");
  });

  it("trims the text", () => {
    store().setAgentGoal("p1", "a1", "  Land the PR  ");
    expect(agent().goal?.text).toBe("Land the PR");
  });

  it("empty text DROPS the goal key entirely — the documented opt-out", () => {
    store().setAgentGoal("p1", "a1", "something");
    store().setAgentGoal("p1", "a1", "   ");
    expect(agent().goal).toBeUndefined();
    expect("goal" in agent()).toBe(false);
  });

  it("re-asserting the SAME text keeps the retry counters", () => {
    // A restarted agent re-asserts its objective routinely. Refilling the budget on that would
    // quietly defeat the escalation bound.
    store().setAgentGoal("p1", "a1", "same");
    burn(2);
    store().setAgentGoal("p1", "a1", "same");
    expect(agent().goal?.continues).toBe(2);
    expect(agent().goal?.totalContinues).toBe(2);
  });

  it("NEW text starts a fresh budget — it is different work", () => {
    store().setAgentGoal("p1", "a1", "first");
    burn(3);
    store().setAgentGoal("p1", "a1", "second");
    expect(agent().goal?.continues).toBe(0);
    expect(agent().goal?.totalContinues).toBe(0);
  });

  it("re-asserting the same text RE-ARMS a met goal", () => {
    // It used to preserve `metAt`, so an agent that met "keep the build green" and re-asserted it
    // for the next round kept the goal `met` forever and the row read "done" (roborev 55254).
    store().setAgentGoal("p1", "a1", "keep the build green");
    store().setAgentGoalMet("p1", "a1", true);
    expect(goalStateOf(agent().goal, Date.now())).toBe("met");

    store().setAgentGoal("p1", "a1", "keep the build green");
    expect(goalStateOf(agent().goal, Date.now())).toBe("unmet");
  });

  it("re-asserting the same text REVIVES an expired goal", () => {
    // `setAt` never moved before, so expiry recurred immediately and re-typing could never revive it.
    store().setAgentGoal("p1", "a1", "long job", 1);
    const expiredAt = Date.now() + 1_000;
    expect(goalStateOf(agent().goal, expiredAt)).toBe("expired");

    store().setAgentGoal("p1", "a1", "long job", 60_000);
    expect(goalStateOf(agent().goal, Date.now())).toBe("unmet");
  });

  it("re-asserting does NOT clear an escalation — that is the human's call", () => {
    store().setAgentGoal("p1", "a1", "hard");
    store().escalateAgentGoal("p1", "a1", "gave up");
    store().setAgentGoal("p1", "a1", "hard");
    expect(goalStateOf(agent().goal, Date.now())).toBe("escalated");
  });
});

describe("setAgentGoalMet", () => {
  beforeEach(seed);

  it("marks the goal met, which is what stops auto-continue", () => {
    store().setAgentGoal("p1", "a1", "ship it");
    store().setAgentGoalMet("p1", "a1", true);
    expect(goalStateOf(agent().goal, Date.now())).toBe("met");
  });

  it("un-marking does NOT refill the total budget", () => {
    // THE HOLE THIS CLOSES (roborev 55254). This is the AGENT's own surface, so the actor holding
    // the lever is exactly the one MAX_CONTINUES_TOTAL defends the fleet against: mark met, un-mark,
    // and the twenty-restart ceiling resets — repeatable forever.
    store().setAgentGoal("p1", "a1", "g");
    burn(5);
    store().setAgentGoalMet("p1", "a1", true);
    store().setAgentGoalMet("p1", "a1", false);
    expect(agent().goal?.totalContinues).toBe(5);
    // The consecutive streak DOES clear — the agent is going back to work.
    expect(agent().goal?.continues).toBe(0);
  });

  it("un-marking does NOT un-latch an escalation", () => {
    // Otherwise an agent could take back a goal a human had already been handed.
    store().setAgentGoal("p1", "a1", "g");
    store().escalateAgentGoal("p1", "a1", "gave up");
    store().setAgentGoalMet("p1", "a1", true);
    store().setAgentGoalMet("p1", "a1", false);
    expect(goalStateOf(agent().goal, Date.now())).toBe("escalated");
  });

  it("un-marking a goal that was never met is a no-op, not a budget reset", () => {
    store().setAgentGoal("p1", "a1", "g");
    burn(3);
    store().setAgentGoalMet("p1", "a1", false);
    expect(agent().goal?.continues).toBe(3);
    expect(agent().goal?.totalContinues).toBe(3);
  });
});

describe("escalation and the human's reset", () => {
  beforeEach(seed);

  it("escalate latches, keeping the first reason", () => {
    store().setAgentGoal("p1", "a1", "g");
    store().escalateAgentGoal("p1", "a1", "first reason");
    store().escalateAgentGoal("p1", "a1", "second reason");
    expect(agent().goal?.escalationReason).toBe("first reason");
  });

  it("resetAgentGoalRetries — the HUMAN's lever — clears everything and re-enables continues", () => {
    store().setAgentGoal("p1", "a1", "g");
    burn(MAX_CONTINUES_WITHOUT_PROGRESS);
    store().escalateAgentGoal("p1", "a1", "gave up");
    store().resetAgentGoalRetries("p1", "a1");

    expect(agent().goal?.continues).toBe(0);
    expect(agent().goal?.totalContinues).toBe(0);
    expect(goalStateOf(agent().goal, Date.now())).toBe("unmet");
    // And the agent is genuinely eligible again — asserting the side effect, not just the fields.
    const d = decideContinuation({
      goal: agent().goal,
      status: "idle",
      now: Date.now() + 60_000,
      idleSince: Date.now(),
      hasTurnEndAuthority: true,
      canAcceptInput: true,
      mark: "stuck",
      // `idle` witnesses its own liveness, but the field is required-but-nullable so a caller has to
      // say what it knows — CI caught this exact omission here, which is the gate working.
      processAlive: undefined,
    });
    expect(d.action).toBe("continue");
  });

  it("the three counter actions no-op on an agent with no goal", () => {
    store().noteAgentGoalContinue("p1", "a1", "m");
    store().escalateAgentGoal("p1", "a1", "why");
    store().setAgentGoalMet("p1", "a1", true);
    expect(agent().goal).toBeUndefined();
  });
});

describe("persistence", () => {
  beforeEach(seed);

  it("the goal survives the real rehydrate path — serialize, migrate, merge", () => {
    // The claim the original commit message rested on and never verified (roborev 55254), and the
    // one that matters most: a relaunch is itself a common way a turn ends with work remaining, so
    // a goal that did not survive one would disable auto-continue exactly when it is needed.
    //
    // This drives the store's OWN rehydrate functions rather than a hand-built object. The store
    // has no `partialize`, so the JSON round-trip is the whole of the serialization step — which is
    // the real risk here, since a field holding anything non-JSON (a Date, a Map) would be silently
    // mangled by it.
    store().setAgentGoal("p1", "a1", "survive the relaunch", 60_000);
    burn(2);

    const onDisk = JSON.parse(JSON.stringify({ projects: useProjectStore.getState().projects }));
    const migrated = migratePersisted(onDisk, 12) as { projects: Project[] };
    // ...and through the cross-window merge, against a live store that has the same agent.
    const merged = mergePreservingLiveWorkers(migrated, useProjectStore.getState());

    const revived = merged.projects[0]!.agents.find((a) => a.id === "a1")!;
    expect(revived.goal?.text).toBe("survive the relaunch");
    expect(revived.goal?.totalContinues).toBe(2);
    expect(goalStateOf(revived.goal, Date.now())).toBe("unmet");
  });
});
