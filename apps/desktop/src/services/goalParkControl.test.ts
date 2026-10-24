// The control op an agent reaches for when the resume ladder cannot move its goal. These assert the
// WRITE — what the store's goal record holds after the call — never just the reply.
import { beforeEach, describe, expect, it } from "vitest";
import { useProjectStore } from "../stores/projectStore";
import { decideContinuation } from "../engine/goalContinuation";
import { IDLE_SETTLE_MS } from "../engine/goalContinuation";
import { handleSetGoalParked } from "./goalParkControl";

let projectId: string;
let me: string;
let peer: string;
const NOW = Date.now();

function goalOf(id: string) {
  return useProjectStore.getState().projects.find((p) => p.id === projectId)?.agents.find((a) => a.id === id)?.goal;
}

beforeEach(() => {
  useProjectStore.setState({ projects: [], selectedProjectId: null } as never);
  const s = useProjectStore.getState();
  projectId = s.addProject("Demo", "/tmp/demo");
  me = s.addAgent(projectId, { kind: "build" })!;
  peer = s.addAgent(projectId, { kind: "build" })!;
  s.setAgentGoal(projectId, me, "Get the founder's sign-off", undefined, "agent", { kind: "human" });
  s.setAgentGoal(projectId, peer, "Ship the parser", undefined, "agent");
});

describe("set_agent_goal_parked", () => {
  it("parks the CALLER's goal, and the ladder then declines to resume it", () => {
    const reply = handleSetGoalParked(
      { callerAgentId: me, payload: { kind: "awaiting-human", reason: "founder must approve the design" } },
      NOW,
    );
    expect(reply).toMatchObject({ ok: true, parked: { kind: "awaiting-human" } });
    const goal = goalOf(me)!;
    expect(goal.park?.reason).toBe("founder must approve the design");
    const d = decideContinuation({
      goal,
      status: "idle",
      now: NOW + IDLE_SETTLE_MS + 1,
      idleSince: NOW,
      hasTurnEndAuthority: true,
      canAcceptInput: true,
      mark: "m",
      processAlive: undefined,
      runtime: "local",
      cloud: undefined,
    });
    expect(d).toMatchObject({ action: "none", reason: "goal-awaiting-human" });
  });

  it("refuses to park a PEER and writes nothing to it", () => {
    const reply = handleSetGoalParked(
      { callerAgentId: me, payload: { targetAgentId: peer, kind: "awaiting-human", reason: "x" } },
      NOW,
    );
    expect(reply).toMatchObject({ ok: false, code: "target_refused" });
    expect(goalOf(peer)?.park).toBeUndefined();
    expect(goalOf(me)?.park).toBeUndefined();
  });

  it("refuses a caller with no agent row (the concierge, an unstamped connection)", () => {
    expect(handleSetGoalParked({ callerAgentId: "sparkle:concierge", payload: { kind: "awaiting-human", reason: "x" } }, NOW))
      .toMatchObject({ ok: false, code: "caller_unidentified" });
  });

  it("passes the engine's refusal through and writes nothing", () => {
    const reply = handleSetGoalParked({ callerAgentId: me, payload: { kind: "superseded", reason: "done elsewhere" } }, NOW);
    expect(reply).toMatchObject({ ok: false, code: "park_needs_ref" });
    expect(goalOf(me)?.park).toBeUndefined();
  });

  it("rejects an unknown kind", () => {
    expect(handleSetGoalParked({ callerAgentId: me, payload: { kind: "done", reason: "x" } }, NOW)).toMatchObject({
      ok: false,
      code: "bad_kind",
    });
  });

  it("kind 'none' lifts the park", () => {
    handleSetGoalParked({ callerAgentId: me, payload: { kind: "waiting-on", reason: "ci", untilMs: NOW + 60_000 } }, NOW);
    expect(goalOf(me)?.park?.kind).toBe("waiting-on");
    expect(handleSetGoalParked({ callerAgentId: me, payload: { kind: "none" } }, NOW)).toMatchObject({ ok: true, parked: null });
    expect(goalOf(me)?.park).toBeUndefined();
  });
});
