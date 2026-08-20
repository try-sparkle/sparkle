import { describe, it, expect } from "vitest";

import { DEFAULT_GOAL_TTL_MS, type AgentGoal } from "./agentGoal";
import { rollUpEpicGoal, type RollupAgent, type RollupBead } from "./epicGoalRollup";

const NOW = 1_700_000_000_000;

const bead = (id: string, status: RollupBead["status"] = "open"): RollupBead => ({
  id,
  title: `slice ${id}`,
  status,
});

const liveGoal = (over: Partial<AgentGoal> = {}): AgentGoal => ({
  text: "the thing is done and verifiable",
  setAt: NOW - 60_000,
  ttlMs: DEFAULT_GOAL_TTL_MS,
  continues: 0,
  totalContinues: 0,
  ...over,
});

const agentOn = (beadId: string, goal: AgentGoal | undefined = liveGoal()): RollupAgent => ({
  id: `a-${beadId}`,
  beadId,
  goal,
});

/** THE HARD SLICE. Three children, an agent on each, all three still open. Every test below is this
 *  situation minus exactly one difference, so a pass can never come from a state it did not name. */
const THREE = [bead("t1"), bead("t2"), bead("t3")];
const THREE_STAFFED = [agentOn("t1"), agentOn("t2"), agentOn("t3")];

describe("rollUpEpicGoal — completion", () => {
  it("is ready to close only when EVERY child bead is closed", () => {
    const all = THREE.map((b) => ({ ...b, status: "closed" as const }));
    const r = rollUpEpicGoal(all, THREE_STAFFED, NOW);
    expect(r.readyToClose).toBe(true);
    expect(r.done).toBe(3);
    expect(r.open).toBe(0);
  });

  it("is NOT ready while one child bead is still open", () => {
    const twoClosed = [
      { ...bead("t1"), status: "closed" as const },
      { ...bead("t2"), status: "closed" as const },
      bead("t3"),
    ];
    const r = rollUpEpicGoal(twoClosed, THREE_STAFFED, NOW);
    expect(r.readyToClose).toBe(false);
    expect(r.done).toBe(2);
    expect(r.open).toBe(1);
  });

  it("an epic with NO children is not ready to close — undecomposed is not achieved", () => {
    expect(rollUpEpicGoal([], [], NOW).readyToClose).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE INVARIANT THE FEATURE EXISTS FOR. Both directions are asserted from the SAME mounted state —
// every slice present, every slice staffed — because absence in a slice that was never mounted
// proves nothing about the rule.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("rollUpEpicGoal — the epic must not become satisfiable by dropping the hard parts", () => {
  it("retiring the agent on the hardest slice leaves the epic UNCLOSABLE and names the drop", () => {
    // t3 is the hard one. Its agent gave up: escalated to a human with the bead still open.
    const gaveUp = agentOn(
      "t3",
      liveGoal({ escalatedAt: NOW - 1_000, escalationReason: "the migration cannot be verified" }),
    );
    const twoClosed = [
      { ...bead("t1"), status: "closed" as const },
      { ...bead("t2"), status: "closed" as const },
      bead("t3"),
    ];
    const r = rollUpEpicGoal(twoClosed, [agentOn("t1"), agentOn("t2"), gaveUp], NOW);

    expect(r.readyToClose).toBe(false);
    expect(r.dropped).toBe(1);
    expect(r.slices.find((s) => s.beadId === "t3")).toMatchObject({
      state: "dropped",
      reason: "the migration cannot be verified",
    });
  });

  it("…and the SAME shape with that slice actually finished IS closable", () => {
    const allClosed = THREE.map((b) => ({ ...b, status: "closed" as const }));
    const r = rollUpEpicGoal(allClosed, THREE_STAFFED, NOW);
    expect(r.readyToClose).toBe(true);
    expect(r.dropped).toBe(0);
  });

  it("DISPOSING OF AN AGENT CANNOT MOVE readyToClose IN EITHER DIRECTION", () => {
    // The attack, stated as a property: for every arrangement of the beads, the verdict computed
    // with a full roster must equal the verdict computed with the roster emptied. If any agent-side
    // fact could reach `readyToClose`, one of these pairs would disagree.
    const arrangements: RollupBead[][] = [
      THREE,
      [{ ...bead("t1"), status: "closed" }, bead("t2"), bead("t3")],
      [{ ...bead("t1"), status: "closed" }, { ...bead("t2"), status: "closed" }, bead("t3")],
      THREE.map((b) => ({ ...b, status: "closed" as const })),
    ];
    const abandoned = THREE_STAFFED.map((a) => ({
      ...a,
      goal: liveGoal({ abandonedAt: NOW - 5, abandonedEvidence: "nothing was ever landed" }),
    }));
    for (const beads of arrangements) {
      const staffed = rollUpEpicGoal(beads, THREE_STAFFED, NOW).readyToClose;
      const retired = rollUpEpicGoal(beads, [], NOW).readyToClose;
      const collapsed = rollUpEpicGoal(beads, abandoned, NOW).readyToClose;
      expect([retired, collapsed]).toEqual([staffed, staffed]);
    }
  });
});

describe("rollUpEpicGoal — why a slice is still open", () => {
  it("an expired goal counts as dropped", () => {
    const expired = agentOn("t1", liveGoal({ setAt: NOW - DEFAULT_GOAL_TTL_MS - 1 }));
    const r = rollUpEpicGoal([bead("t1")], [expired], NOW);
    expect(r.slices[0]).toMatchObject({ state: "dropped" });
    expect(r.dropped).toBe(1);
  });

  it("an abandoned goal reports the evidence git supplied", () => {
    const abandoned = agentOn(
      "t1",
      liveGoal({ abandonedAt: NOW - 10, abandonedEvidence: "8 commits, nothing pushed" }),
    );
    expect(rollUpEpicGoal([bead("t1")], [abandoned], NOW).slices[0]).toMatchObject({
      state: "dropped",
      reason: "8 commits, nothing pushed",
    });
  });

  it("ONE live agent on a slice keeps it merely open, however many earlier attempts failed", () => {
    const failed = { ...agentOn("t1", liveGoal({ escalatedAt: NOW - 1 })), id: "a-old" };
    const live = agentOn("t1");
    const r = rollUpEpicGoal([bead("t1")], [failed, live], NOW);
    expect(r.slices[0]?.state).toBe("open");
    expect(r.dropped).toBe(0);
  });

  it("an open slice nobody carries is STRANDED once a bead has actually moved", () => {
    // The evidence is the BEAD, not the roster (roborev 65849, then 65885). An agent's presence
    // says nothing about any individual slice — an epic's own orchestrator matches none of them —
    // so counting it painted every child of a freshly-dispatched epic as abandoned.
    const r = rollUpEpicGoal(
      [{ ...bead("t1"), status: "closed" as const }, bead("t2")],
      [agentOn("t1")],
      NOW,
    );
    expect(r.slices.find((s) => s.beadId === "t2")).toMatchObject({ state: "stranded" });
    expect(r.stranded).toBe(1);
  });

  it("…and NOT while every bead is still untouched, however many agents are on it", () => {
    // The paired direction, and the false alarm 65885 measured: this is the ordinary state between
    // dispatching an orchestrator and its first worker existing.
    const r = rollUpEpicGoal([bead("t1"), bead("t2")], [agentOn("t1")], NOW);
    expect(r.stranded).toBe(0);
    expect(r.slices.find((s) => s.beadId === "t2")?.state).toBe("open");
  });

  it("STAYS stranded once the LAST agent is retired — the roster is not the evidence", () => {
    // roborev 65849. The two tests around this one were jointly satisfied by a roster-only rule:
    // one kept an agent alive, the other had zero agents AND zero prior work. This is the state
    // neither mounted — work provably happened (t1 is closed) and NOBODY is left — which is the
    // exact shape a retired agent leaves behind, i.e. the case `stranded` is named for.
    const r = rollUpEpicGoal([{ ...bead("t1"), status: "closed" }, bead("t2")], [], NOW);
    expect(r.slices.find((s) => s.beadId === "t2")).toMatchObject({ state: "stranded" });
    expect(r.stranded).toBe(1);
  });

  it("an in_progress sibling is enough evidence that work started", () => {
    const r = rollUpEpicGoal([{ ...bead("t1"), status: "in_progress" }, bead("t2")], [], NOW);
    expect(r.slices.find((s) => s.beadId === "t2")?.state).toBe("stranded");
  });

  it("a child that is itself a SUB-EPIC is owned by its orchestrator, not reported stranded", () => {
    // The agent shape is the one `sendToBuild.prepareHandoff` ACTUALLY stamps (roborev 65856): it
    // writes the epic id to setAgentEpicId AND setAgentBeadId, so a real orchestrator carries both.
    // The earlier version built `{ epicId: "sub" }` with no beadId — a shape production never
    // produces — which is how it green-lit a matching rule that could not fire. Whether that agent
    // REACHES this function is `epicLadder.agentsForEpicSlices`'s job, pinned in its own suite;
    // this pins that the rule here recognises it once it arrives.
    const orch = { id: "orch", epicId: "sub", beadId: "sub", goal: liveGoal() };
    const r = rollUpEpicGoal([bead("t1"), bead("sub")], [agentOn("t1"), orch], NOW);
    expect(r.slices.find((s) => s.beadId === "sub")).toMatchObject({ state: "open" });
    expect(r.stranded).toBe(0);
  });

  it("…and a sub-epic child whose orchestrator gave up is DROPPED, not merely open", () => {
    const r = rollUpEpicGoal(
      [bead("sub")],
      [
        {
          id: "orch",
          epicId: "sub",
          beadId: "sub",
          goal: liveGoal({ escalatedAt: NOW - 1, escalationReason: "stuck" }),
        },
      ],
      NOW,
    );
    expect(r.slices[0]).toMatchObject({ state: "dropped", reason: "stuck" });
  });

  it("…but an untouched backlog epic is merely OPEN, not stranded", () => {
    const r = rollUpEpicGoal([bead("t1"), bead("t2")], [], NOW);
    expect(r.slices.every((s) => s.state === "open")).toBe(true);
    expect(r.stranded).toBe(0);
  });

  it("a met goal on an open bead does NOT count the slice done — the bead is the evidence", () => {
    const claimsDone = agentOn("t1", liveGoal({ metAt: NOW - 5 }));
    const r = rollUpEpicGoal([bead("t1")], [claimsDone], NOW);
    expect(r.slices[0]?.state).toBe("open");
    expect(r.readyToClose).toBe(false);
  });
});
