// @vitest-environment jsdom
//
// The concierge's half of epic goals. `../beads` is mocked at the two bd shell-outs only; the epic
// RESOLVER (`isEpic`) is kept REAL, because "a task cannot acquire an epic goal" is the claim this
// suite makes and a stubbed predicate would be a test of the stub.
import { describe, it, expect, vi, beforeEach } from "vitest";

const listBeads = vi.fn();
const beadShow = vi.fn();

vi.mock("../beads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../beads")>();
  return {
    ...actual,
    listBeads: (...a: unknown[]) => listBeads(...a),
    beadShow: (...a: unknown[]) => beadShow(...a),
  };
});

const requestEpicGoalMock = vi.fn();
vi.mock("../epicGoalGen", async (orig) => ({
  ...(await orig<typeof import("../epicGoalGen")>()),
  requestEpicGoal: (...a: unknown[]) => requestEpicGoalMock(...a),
}));

const { generatePlanGoal, readPlanGoal, setPlanGoal } = await import("./planGoals");
const { useProjectStore } = await import("../../stores/projectStore");
const { isBeadsUnavailable } = await import("../beads");

const OP = "set_plan_goal" as never;
const RISK = "routine" as never;
const OK = "every epic on the board shows a goal a human can read";
const PATH = "/tmp/p";

const epic = { id: "e1", title: "Epic one", description: "", status: "open", labels: [], type: "epic" };
const task = { id: "t1", title: "Task one", description: "", status: "open", labels: [], type: "task" };

function seed() {
  useProjectStore.setState({
    projects: [
      {
        id: "p1",
        name: "P",
        rootPath: PATH,
        defaultBranch: null,
        createdAt: new Date(0).toISOString(),
        selectedAgentId: null,
        agents: [],
      },
    ],
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  seed();
  listBeads.mockResolvedValue([epic, task]);
  beadShow.mockImplementation(async (_p: string, id: string) =>
    id === "e1" ? epic : id === "t1" ? task : null,
  );
});

const call = (id: string, goal: string, verify?: never) =>
  setPlanGoal(OP, RISK, PATH, "p1", id, goal, verify);

describe("setPlanGoal — the happy path", () => {
  it("writes the goal and reports it back", async () => {
    const r = await call("e1", OK);
    expect(r.ok).toBe(true);
    expect(r.ok && r.data).toMatchObject({ epicId: "e1", title: "Epic one", goal: OK });
  });

  it("writes it as HUMAN — the concierge is relaying a person's instruction, not its own opinion", async () => {
    // The side effect, not the reply: the LATCH is the thing that must be stamped, because it is
    // what stops the generator from silently rewriting his wording later.
    await call("e1", OK);
    const rec = useProjectStore.getState().projects[0]?.epicGoals?.e1;
    expect(rec?.source).toBe("human");
    expect(rec?.humanEditedAt).toEqual(expect.any(Number));
    expect(useProjectStore.getState().mayGenerateEpicGoal("p1", "e1")).toBe(false);
  });

  it("an EMPTY goal clears it, and the latch survives the clear", async () => {
    await call("e1", OK);
    const r = await call("e1", "   ");
    expect(r.ok && r.data.goal).toBeNull();
    expect(useProjectStore.getState().projects[0]?.epicGoals?.e1?.humanEditedAt).toEqual(
      expect.any(Number),
    );
  });

  it("REFUSES a `command` verify with no cmd, and writes nothing", async () => {
    // roborev 65867. `epicVerifyOf` checks only the KIND, so this used to be stored verbatim as an
    // unrunnable check — and this is the ONLY entry point where that could happen: the generator
    // path runs `parseGoalVerify` first. The registry cast is what silenced the type error.
    const r = await setPlanGoal(OP, RISK, PATH, "p1", "e1", OK, { kind: "command" } as never);
    expect(!r.ok && r.reason).toBe("unusable-verify");
    expect(useProjectStore.getState().projects[0]?.epicGoals?.e1).toBeUndefined();
  });

  it("…and a blank cmd is refused too, not stored as whitespace", async () => {
    const r = await setPlanGoal(OP, RISK, PATH, "p1", "e1", OK, { kind: "command", cmd: "  " });
    expect(!r.ok && r.reason).toBe("unusable-verify");
  });

  it("…while a REAL command verify lands", async () => {
    // The paired direction, so the rule above cannot pass by refusing every command verify.
    const r = await setPlanGoal(OP, RISK, PATH, "p1", "e1", OK, {
      kind: "command",
      cmd: "pnpm verify",
    });
    expect(r.ok && r.data.verify).toEqual({ kind: "command", cmd: "pnpm verify" });
  });

  it("narrows a `landed` check to `human` rather than refusing it", async () => {
    // An epic is not a branch, so ancestry could never answer `landed`. Refusing would make the
    // concierge retry a check that can never apply; narrowing is the one rule, in one place.
    const r = await setPlanGoal(OP, RISK, PATH, "p1", "e1", OK, { kind: "landed" });
    expect(r.ok && r.data.verify).toEqual({ kind: "human" });
  });
});

describe("setPlanGoal — refusals", () => {
  it("REFUSES a task id, and writes nothing", async () => {
    const r = await call("t1", OK);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe("not-a-plan");
    expect(useProjectStore.getState().projects[0]?.epicGoals?.t1).toBeUndefined();
  });

  it("refuses an id that is not in the store at all", async () => {
    const r = await call("nope", OK);
    expect(!r.ok && r.reason).toBe("no-such-plan");
  });

  it("refuses unusable goal text with a sentence the concierge can relay, and writes nothing", async () => {
    const r = await call("e1", "tiny");
    expect(!r.ok && r.reason).toBe("unusable-goal");
    expect(!r.ok && r.message).toMatch(/OBSERVABLE END STATE/);
    expect(useProjectStore.getState().projects[0]?.epicGoals?.e1).toBeUndefined();
  });

  it("reports a project with no beads database as a supported state, not an internal error", async () => {
    // roborev 65853. This used to assert `isBeadsUnavailable(err) ? … : …` over the fixture
    // "bd: no such workspace" — which the classifier does NOT match, so the ternary resolved to
    // `beads-failed` and the test green-lit the generic arm while claiming to cover this one.
    // Computing the expected value FROM the function under test is what made the two arms
    // indistinguishable; the literal is asserted now, and the fixture is the string the classifier
    // actually recognises.
    const err = new Error("no beads database found");
    expect(isBeadsUnavailable(err)).toBe(true);
    beadShow.mockRejectedValue(err);
    listBeads.mockRejectedValue(err);
    const r = await call("e1", OK);
    expect(!r.ok && r.reason).toBe("beads-unavailable");
    expect(!r.ok && r.message).toMatch(/bd init|beads database/i);
  });

  it("…and a GENUINE bd failure is the other arm, not this one", async () => {
    const err = new Error("bd: no such workspace");
    expect(isBeadsUnavailable(err)).toBe(false);
    beadShow.mockRejectedValue(err);
    listBeads.mockRejectedValue(err);
    const r = await call("e1", OK);
    expect(!r.ok && r.reason).toBe("beads-failed");
  });

  it("CLEARING an epic that has no goal does not latch it (a no-op is not an opinion)", async () => {
    // roborev 65853. A model blanking the argument, or a UI clear on an empty field, used to write
    // a record whose only effect was `humanEditedAt` — silently disabling auto-generation for that
    // epic forever, with nothing on screen to explain why and no exit but an explicit force.
    const r = await call("e1", "");
    expect(r.ok).toBe(true);
    expect(useProjectStore.getState().mayGenerateEpicGoal("p1", "e1")).toBe(true);
    expect(useProjectStore.getState().projects[0]?.epicGoals?.e1).toBeUndefined();
  });
});

describe("readPlanGoal", () => {
  it("reports no goal as nulls, not as an empty string", async () => {
    expect(readPlanGoal("p1", "e1", "Epic one")).toMatchObject({
      goal: null,
      source: null,
      verify: null,
      humanEdited: false,
    });
  });

  it("reports a machine-written goal as auto and NOT human-edited", async () => {
    useProjectStore.getState().setEpicGoal("p1", "e1", OK, "auto");
    expect(readPlanGoal("p1", "e1", "Epic one")).toMatchObject({
      goal: OK,
      source: "auto",
      humanEdited: false,
    });
  });
});

describe("generatePlanGoal — the only shipped way back from a failed generation", () => {
  const gen = (id: string) => generatePlanGoal(OP, RISK, PATH, "p1", id);

  it("ALWAYS passes force — without it the op is a silent no-op on the epics people ask about", async () => {
    // The whole reason this op exists is that a person asked. The latch's contract is that an
    // explicit human ask is the one thing that beats it, so an unforced call would do nothing on
    // precisely the epics someone bothers to name — a goal already filled, or one they wrote and
    // now want redone — and a tool that quietly does nothing is worse than one that refuses.
    requestEpicGoalMock.mockResolvedValue("generated");
    await gen("e1");
    expect(requestEpicGoalMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ projectId: "p1", epicId: "e1", force: true }),
    );
  });

  it("recovers an epic whose earlier generation FAILED", async () => {
    // The state roborev 65858 named as unrecoverable: a transient blip at create time records
    // `generationFailedAt`, and `mayAutoGenerate` then refuses that epic forever.
    useProjectStore.getState().noteEpicGoalFailure("p1", "e1", "the model call timed out");
    expect(useProjectStore.getState().mayGenerateEpicGoal("p1", "e1")).toBe(false);
    requestEpicGoalMock.mockImplementation(async () => {
      useProjectStore.getState().setEpicGoal("p1", "e1", OK, "auto");
      return "generated";
    });
    const r = await gen("e1");
    expect(r.ok && r.data).toMatchObject({ goal: OK, source: "auto" });
  });

  it("reports the goal as AUTO — the person spent the call, they did not write the words", async () => {
    requestEpicGoalMock.mockImplementation(async () => {
      useProjectStore.getState().setEpicGoal("p1", "e1", OK, "auto");
      return "generated";
    });
    const r = await gen("e1");
    expect(r.ok && r.data.source).toBe("auto");
    expect(r.ok && r.data.humanEdited).toBe(false);
  });

  it("refuses a task id before spending anything", async () => {
    const r = await gen("t1");
    expect(!r.ok && r.reason).toBe("not-a-plan");
    expect(requestEpicGoalMock).not.toHaveBeenCalled();
  });

  it.each([
    ["ai-off", "ai-off", /switched off/i],
    ["in-flight", "already-generating", /already being written/i],
    ["latched", "latched", /shouldn't be overwritten/i],
    ["failed", "generation-failed", /left it empty rather than guess/i],
  ])("maps outcome %s to a refusal the concierge can relay", async (outcome, reason, copy) => {
    // Each outcome is a REFUSAL, never an error: none of them is a fault, they are the safety rules
    // working, and each needs something different said back. Collapsing them would make a model
    // timeout indistinguishable from AI being switched off.
    requestEpicGoalMock.mockResolvedValue(outcome);
    const r = await gen("e1");
    expect(!r.ok && r.reason).toBe(reason);
    expect(!r.ok && r.message).toMatch(copy);
  });

  it("a THROW out of the generator is still a refusal, and still writes no goal", async () => {
    requestEpicGoalMock.mockRejectedValue(new Error("bridge died"));
    const r = await gen("e1");
    expect(!r.ok && r.reason).toBe("generation-failed");
    expect(useProjectStore.getState().projects[0]?.epicGoals?.e1).toBeUndefined();
  });
});
