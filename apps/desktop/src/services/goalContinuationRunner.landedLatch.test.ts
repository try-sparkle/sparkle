// @vitest-environment jsdom
//
// (f) — A LANDED GOAL IS LATCHED FROM GIT AT THE MOMENT A RESUME WOULD BE SPENT (sparkle-aqd0xp,
// sparkle-v22kuv, sparkle-si8y1p, sparkle-gj72lg, sparkle-7go8pn, sparkle-fiyfrn).
//
// The measured failure: an agent whose work was merged kept being auto-continued on its
// `{kind:"landed"}` goal until the per-goal ceiling escalated it to a human, because the ONLY writer
// of `metAt` for that goal was the agent's own `set_agent_goal_met`. Both directions are pinned here
// as SIDE EFFECTS: a git-proven landing latches the goal and NO continue is typed; an unproven one
// sends the continue exactly as before and leaves the goal open.
import { beforeEach, describe, expect, it, vi } from "vitest";

import { noteHooksLive, resetTurnEndAuthority, trackAgent } from "../engine/turnEndAuthority";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";

/** What `agent_landed_probe` answers; every other command answers `undefined`. */
let probeReply: unknown = undefined;
const probeCalls: unknown[] = [];
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: unknown) => {
    if (cmd === "agent_landed_probe") {
      probeCalls.push(args);
      return probeReply;
    }
    return undefined;
  }),
}));

vi.mock("./conciergeDispatch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./conciergeDispatch")>();
  return {
    ...actual,
    dispatchConciergeAnswer: vi.fn(async (agentId: string, text: string) => ({
      ok: true,
      path: "free-text" as const,
      agentId,
      sent: text,
      display: text,
    })),
  };
});
vi.mock("./attention", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./attention")>();
  return { ...actual, notifyAttention: vi.fn() };
});

import { dispatchConciergeAnswer } from "./conciergeDispatch";
import {
  _resetGoalContinuationRunnerForTests,
  sweepGoalContinuations,
} from "./goalContinuationRunner";

const sendMock = vi.mocked(dispatchConciergeAnswer);
const ownsEverything = () => true;
const T0 = 1_000_000;
const SETTLED = T0 + 46_000;

function seedLandedGoal(): { projectId: string; agentId: string } {
  const projectId = useProjectStore.getState().addProject("Demo", "/tmp/demo");
  const agentId = useProjectStore.getState().addAgent(projectId, { kind: "build" })!;
  useProjectStore.setState({
    projects: useProjectStore.getState().projects.map((p) =>
      p.id === projectId
        ? { ...p, agents: p.agents.map((a) => (a.id === agentId ? { ...a, worktreePath: "/wt/a" } : a)) }
        : p,
    ),
  } as never);
  useProjectStore
    .getState()
    .setAgentGoal(projectId, agentId, "the fix is merged to origin/main", undefined, "agent", { kind: "landed" });
  useRuntimeStore.setState({ status: { [agentId]: "idle" }, openAgentIds: [agentId] } as never);
  trackAgent(agentId, "test-engine");
  noteHooksLive(agentId);
  return { projectId, agentId };
}

function goalOf(projectId: string, agentId: string) {
  return useProjectStore
    .getState()
    .projects.find((p) => p.id === projectId)!
    .agents.find((a) => a.id === agentId)!.goal;
}

const provenLanding = () => ({
  landed: true,
  authoredLanded: true,
  authoredLandedAt: Math.floor(goalOf(...ids)!.setAt / 1000) + 60,
  reason: "ok",
});
let ids: [string, string] = ["", ""];

beforeEach(() => {
  useProjectStore.setState({ projects: [], selectedProjectId: null } as never);
  useRuntimeStore.setState({
    status: {},
    openAgentIds: [],
    branchStatus: {},
    workflowStage: {},
    workflowState: {},
    agentMovement: {},
  } as never);
  resetTurnEndAuthority();
  _resetGoalContinuationRunnerForTests();
  sendMock.mockClear();
  probeReply = undefined;
  probeCalls.length = 0;
});

describe("the resume moment latches a git-proven landed goal instead of spending a continue", () => {
  it("LATCHES the goal met and types NOTHING when git proves the authored work is on origin/main", async () => {
    const { projectId, agentId } = seedLandedGoal();
    ids = [projectId, agentId];
    probeReply = provenLanding();

    await sweepGoalContinuations({ now: T0, ownsProject: ownsEverything });
    const outcomes = await sweepGoalContinuations({ now: SETTLED, ownsProject: ownsEverything });

    expect(probeCalls).toHaveLength(1);
    expect(sendMock).not.toHaveBeenCalled();
    expect(goalOf(projectId, agentId)!.metAt).toBeDefined();
    expect(goalOf(projectId, agentId)!.totalContinues ?? 0).toBe(0);
    expect(outcomes.find((o) => o.agentId === agentId)).toMatchObject({
      action: "none",
      detail: "goal-latched-from-git",
    });
  });

  it("still CONTINUES, and leaves the goal open, when git cannot prove authored work landed", async () => {
    const { projectId, agentId } = seedLandedGoal();
    ids = [projectId, agentId];
    probeReply = { ...provenLanding(), authoredLanded: false, authoredLandedAt: null };

    await sweepGoalContinuations({ now: T0, ownsProject: ownsEverything });
    await sweepGoalContinuations({ now: SETTLED, ownsProject: ownsEverything });

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(goalOf(projectId, agentId)!.metAt).toBeUndefined();
    expect(goalOf(projectId, agentId)!.totalContinues).toBe(1);
  });
});
