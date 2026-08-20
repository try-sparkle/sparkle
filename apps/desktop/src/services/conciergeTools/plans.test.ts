// @vitest-environment jsdom
//
// The plans domain. `../beads` and `../sendToBuild` are mocked (the bd shell-out and the handoff's
// store/PTY side effects); `../planView` is kept REAL, because reusing its derivations instead of
// re-implementing them is the whole design claim of this module and a stub would hide a drift.
import { describe, it, expect, vi, beforeEach } from "vitest";

const listBeads = vi.fn();
const beadShow = vi.fn();
const blockedBeadIds = vi.fn();
const createBeadFull = vi.fn();
const capacityMock = vi.fn(() => ({ atCapacity: false, used: 1, limit: 8, live: 1, basis: "test" }));

vi.mock("../beads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../beads")>();
  return {
    ...actual,
    listBeads: (...a: unknown[]) => listBeads(...a),
    beadShow: (...a: unknown[]) => beadShow(...a),
    blockedBeadIds: (...a: unknown[]) => blockedBeadIds(...a),
  };
});

vi.mock("../tasks", () => ({ createBeadFull: (...a: unknown[]) => createBeadFull(...a) }));
vi.mock("../agentCapacity", async (orig) => ({
  ...(await orig<typeof import("../agentCapacity")>()),
  localAgentCapacity: () => capacityMock(),
}));

const sendToBuildMock = vi.fn(() => "agent-new");
vi.mock("../sendToBuild", async (orig) => ({
  ...(await orig<typeof import("../sendToBuild")>()),
  sendToBuild: (...a: unknown[]) => sendToBuildMock(...(a as [])),
}));

const { PLANS_OPS, PLANS_RISK, listPlans, getPlan, createPlan, promotePlanToBuild } = await import(
  "./plans"
);
const { useProjectStore } = await import("../../stores/projectStore");
const { AtCapacityError } = await import("../sendToBuild");

const ROOT = "/repo";

function bead(id: string, over: Partial<import("../beads").Bead> = {}): import("../beads").Bead {
  return {
    id,
    title: `title ${id}`,
    description: "",
    status: "open",
    labels: [],
    parent: null,
    ...over,
  };
}

const epic = (id: string, over = {}) => bead(id, { type: "epic", ...over });
const child = (id: string, parent: string, over = {}) => bead(id, { parent, ...over });

function seedProject(): string {
  return useProjectStore.getState().addProject("Demo", ROOT);
}

beforeEach(() => {
  vi.clearAllMocks();
  useProjectStore.setState({ projects: [], selectedProjectId: null } as never);
  listBeads.mockResolvedValue([]);
  beadShow.mockResolvedValue(null);
  blockedBeadIds.mockResolvedValue(new Set<string>());
  createBeadFull.mockResolvedValue("sparkle-plan");
  capacityMock.mockReturnValue({ atCapacity: false, used: 1, limit: 8, live: 1, basis: "test" });
  sendToBuildMock.mockReturnValue("agent-new");
});

describe("classification", () => {
  it("classifies every op", () => {
    for (const op of PLANS_OPS) expect(PLANS_RISK[op]).toBeTruthy();
  });

  // Promotion starts an agent, which costs a slot but destroys nothing — the same shape as
  // spawn_build_agent, and equally undoable by closing the agent.
  it("rates promotion routine and the reads read-only", () => {
    expect(PLANS_RISK.promote_plan_to_build).toBe("routine");
    expect(PLANS_RISK.list_plans).toBe("read-only");
    expect(PLANS_RISK.get_plan).toBe("read-only");
  });
});

describe("list_plans", () => {
  it("returns only EPICS, with status rolled up from their children", async () => {
    const projectId = seedProject();
    listBeads.mockResolvedValue([
      epic("e1"),
      child("c1", "e1", { status: "closed" }),
      child("c2", "e1", { status: "closed" }),
      epic("e2"),
      child("c3", "e2"),
      bead("loose"), // a task with no epic — not a plan
    ]);

    const r = await listPlans(ROOT, projectId);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.map((p) => p.id)).toEqual(["e1", "e2"]);
    // Rolled up by the REAL planView.epicStatus: all children closed → done.
    expect(r.data.find((p) => p.id === "e1")?.status).toBe("done");
    // ...and e2's single child is still open, so it is PLANNING — a written plan nobody started,
    // which the concierge must be able to tell apart from an epic with no children at all.
    expect(r.data.find((p) => p.id === "e2")?.status).toBe("planning");
    expect(r.data.find((p) => p.id === "e1")?.childCount).toBe(2);
  });

  // The orchestrator link is what tells the human "somebody is already on this" — and it is the
  // state promote_plan_to_build changes, so a wrong answer here would produce a duplicate handoff.
  it("names the build agent bound to a plan, and null when nobody is on it", async () => {
    const projectId = seedProject();
    const store = useProjectStore.getState();
    const agentId = store.addAgent(projectId, { kind: "build", name: "Auth Work" })!;
    store.setAgentEpicId(projectId, agentId, "e1");
    listBeads.mockResolvedValue([epic("e1"), epic("e2")]);

    const r = await listPlans(ROOT, projectId);
    expect(r.ok && r.data.find((p) => p.id === "e1")?.orchestrator).toBe("Auth Work");
    expect(r.ok && r.data.find((p) => p.id === "e2")?.orchestrator).toBeNull();
  });

  // THE REGRESSION THIS CHANGE EXISTS FOR. Eight parents in the real store are typed
  // feature/bug/task and carry 2 to 19 children apiece; keying epic-ness on `type` made every one
  // of them invisible here while their children rendered as loose tasks. Asserting the SIDE EFFECT
  // — the plan is listed, with its children counted and its status rolled up — not merely that some
  // predicate returns true.
  it("lists a parent bead that is NOT typed 'epic' as a plan, with its children", async () => {
    const projectId = seedProject();
    listBeads.mockResolvedValue([
      bead("f1", { type: "feature" }), // a de-facto epic: never typed 'epic', but things point at it
      child("f1c1", "f1", { status: "closed" }),
      child("f1c2", "f1", { status: "in_progress" }),
      bead("b1", { type: "bug" }), // a bug that is also a parent
      child("b1c1", "b1"),
      bead("solo", { type: "task" }), // parentless and childless — NOT a plan, and that is normal
    ]);

    const r = await listPlans(ROOT, projectId);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.map((p) => p.id).sort()).toEqual(["b1", "f1"]);
    const f1 = r.data.find((p) => p.id === "f1");
    expect(f1?.childCount).toBe(2);
    // Rolled up by the REAL planView.epicStatus — a mix of closed and in_progress is in_progress.
    expect(f1?.status).toBe("in_progress");
  });

  // The dotted id is bd's display form of the same edge, so it must confer plan-hood identically.
  it("lists a parent whose children carry only dotted ids", async () => {
    const projectId = seedProject();
    listBeads.mockResolvedValue([bead("d1", { type: "chore" }), bead("d1.1"), bead("d1.2")]);

    const r = await listPlans(ROOT, projectId);
    expect(r.ok && r.data.map((p) => p.id)).toEqual(["d1"]);
    expect(r.ok && r.data.find((p) => p.id === "d1")?.childCount).toBe(2);
  });

  // C, in the founder's words: "Every bead doesn't absolutely need to have an epic." A backlog of
  // parentless tasks must produce NO plans rather than a board full of one-bead epics.
  it("returns no plans at all when nothing has children and nothing is typed 'epic'", async () => {
    const projectId = seedProject();
    listBeads.mockResolvedValue([bead("t1"), bead("t2", { type: "bug" }), bead("t3", { type: "feature" })]);

    const r = await listPlans(ROOT, projectId);
    expect(r.ok && r.data).toEqual([]);
  });

  it("reports a project without beads as a supported state", async () => {
    const projectId = seedProject();
    listBeads.mockRejectedValue(new Error("no beads database found for /repo"));

    const r = await listPlans(ROOT, projectId);
    expect(r.ok).toBe(false);
    if (!r.ok) expect([r.reason, /bd init/.test(r.message)]).toEqual(["beads-unavailable", true]);
  });
});

describe("get_plan", () => {
  it("returns the plan with its children, workers and board columns", async () => {
    const projectId = seedProject();
    const store = useProjectStore.getState();
    const worker = store.addAgent(projectId, { kind: "worker", name: "W1", beadId: "c1" })!;
    expect(worker).toBeTruthy();

    beadShow.mockResolvedValue(epic("e1"));
    listBeads.mockResolvedValue([epic("e1"), child("c1", "e1"), child("c2", "e1")]);
    blockedBeadIds.mockResolvedValue(new Set(["c2"]));

    const r = await getPlan(ROOT, projectId, "e1");
    expect(r.ok).toBe(true);
    if (!r.ok || !r.data) return;
    expect(r.data.plan.id).toBe("e1");
    expect(r.data.children.map((c) => c.id)).toEqual(["c1", "c2"]);
    // Workers come from the REAL planView.epicChildViews.
    expect(r.data.children.find((c) => c.id === "c1")?.workers).toEqual(["W1"]);
    // …and the column agrees with the board domain, since both use columnFor.
    expect(r.data.children.find((c) => c.id === "c2")?.column).toBe("blocked");
    expect(r.data.children.find((c) => c.id === "c2")?.blocked).toBe(true);
  });

  it("returns null for an id the project does not hold", async () => {
    const projectId = seedProject();
    const r = await getPlan(ROOT, projectId, "nope");
    expect(r.ok && r.data).toBeNull();
  });

  // "I can't find it" and "that's a task, not a plan" are different mistakes, and a model deciding
  // whether to retry needs to tell them apart.
  it("refuses a bead that exists but is not a plan", async () => {
    const projectId = seedProject();
    beadShow.mockResolvedValue(bead("t1", { type: "task" }));

    const r = await getPlan(ROOT, projectId, "t1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect([r.reason, /board tools/.test(r.message)]).toEqual(["not-a-plan", true]);
  });
});

describe("create_plan", () => {
  // ASSERTS THE THING THAT RESULTS, not the input to a mock.
  //
  // The first version of this test checked `createBead` was called with (root, title, body) and
  // passed against a call that filed a TASK — `bd create` with no `-t` takes bd's default type, so
  // nothing create_plan produced was ever a plan: invisible to list_plans, refused as `not-a-plan`
  // by get_plan and promote. The whole create → inspect → promote workflow dead-ended at step one
  // and the suite was green (roborev 55131). So: pin the type, then round-trip the created id back
  // through list_plans and require it to show up.
  it("files an EPIC — and the result is visible as a plan", async () => {
    const r = await createPlan(ROOT, "Ship auth", "the body");
    expect(createBeadFull).toHaveBeenCalledWith(ROOT, "Ship auth", "the body", "epic", "", "", "");
    expect(r.ok && r.data).toEqual({ id: "sparkle-plan" });

    // Round-trip: a bead carrying the type the create path asked for IS listed as a plan.
    const projectId = seedProject();
    listBeads.mockResolvedValue([bead("sparkle-plan", { type: "epic", title: "Ship auth" })]);
    const listed = await listPlans(ROOT, projectId);
    expect(listed.ok && listed.data.map((p) => p.id)).toEqual(["sparkle-plan"]);
  });

  // Guards the inverse: had create_plan kept filing tasks, this is what the user would have seen.
  it("a TASK-typed bead is NOT a plan, which is why the type matters", async () => {
    const projectId = seedProject();
    listBeads.mockResolvedValue([bead("sparkle-plan", { type: "task", title: "Ship auth" })]);
    const listed = await listPlans(ROOT, projectId);
    expect(listed.ok && listed.data).toEqual([]);
  });

  // createBeadFull THROWS on a bd failure (it does not resolve null), so the failure arm is the
  // `attempt` catch rather than a null check.
  it("surfaces a bd failure as a refusal rather than a phantom success", async () => {
    createBeadFull.mockRejectedValue(new Error("bd exploded"));
    const r = await createPlan(ROOT, "Ship auth", "");
    expect(r.ok).toBe(false);
    if (!r.ok) expect([r.reason, r.message]).toEqual(["beads-failed", "bd exploded"]);
  });
});

describe("promote_plan_to_build", () => {
  // The point of the section: promoting must not produce a blank agent the human then has to
  // brief. sendToBuild owns building the seed prompt from the epic + PRD, so this delegates.
  it("delegates to sendToBuild, carrying the plan and its PRD", async () => {
    const projectId = seedProject();
    beadShow.mockResolvedValue(epic("e1"));

    const r = await promotePlanToBuild(ROOT, projectId, "e1", "PRD/thing.md");
    expect(sendToBuildMock).toHaveBeenCalledWith({
      projectId,
      epicId: "e1",
      prdPath: "PRD/thing.md",
      mode: "epic",
      // This is the concierge's TOOL layer, so the seed is machine-authored (roborev 55721). It bites
      // on the reuse path, where the seed would otherwise release a resumed orchestrator's goal debt.
      humanAuthored: false,
      // …and for the same reason it opts into being declined: an LLM promoting a plan must not pull
      // the founder out of a terminal he is typing in (engine/attentionGuard). Pinned in the EXACT
      // args rather than an objectContaining, so dropping the flag — which would silently restore
      // the steal on the one path that can cause it — fails here.
      attention: "auto",
    });
    expect(r.ok && r.data).toEqual({ agentId: "agent-new", epicId: "e1", reused: false });
  });

  it("passes a null PRD through rather than blocking on a file that isn't there", async () => {
    const projectId = seedProject();
    beadShow.mockResolvedValue(epic("e1"));
    await promotePlanToBuild(ROOT, projectId, "e1", null);
    expect(sendToBuildMock).toHaveBeenCalledWith(expect.objectContaining({ prdPath: null }));
  });

  // sendToBuild enforces ONE ORCHESTRATOR PER EPIC by reusing the bound agent. Reported so the
  // concierge can say "picking that back up" instead of implying it started something new — and
  // read BEFORE the handoff, since afterwards the two cases are indistinguishable.
  it("reports reuse when an orchestrator is already bound to the plan", async () => {
    const projectId = seedProject();
    const store = useProjectStore.getState();
    const agentId = store.addAgent(projectId, { kind: "build", name: "Auth Work" })!;
    store.setAgentEpicId(projectId, agentId, "e1");
    beadShow.mockResolvedValue(epic("e1"));
    sendToBuildMock.mockReturnValue(agentId);

    const r = await promotePlanToBuild(ROOT, projectId, "e1", null);
    expect(r.ok && r.data.reused).toBe(true);
  });

  it("refuses an unknown plan, and a bead that is not a plan, without handing anything off", async () => {
    const projectId = seedProject();

    const missing = await promotePlanToBuild(ROOT, projectId, "ghost", null);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toBe("unknown-plan");

    beadShow.mockResolvedValue(bead("t1", { type: "task" }));
    const notPlan = await promotePlanToBuild(ROOT, projectId, "t1", null);
    expect(notPlan.ok).toBe(false);
    if (!notPlan.ok) expect(notPlan.reason).toBe("not-a-plan");

    expect(sendToBuildMock).not.toHaveBeenCalled();
  });

  // sendToBuild reaches store.addAgent DIRECTLY, and addAgent has no capacity check — the
  // machine-wide gate lives in spawnBuildAgentInProject / spawn_build_agent, neither of which this
  // path touches. Without a gate here, a concierge refused spawn_build_agent at the ceiling could
  // create a build agent anyway by promoting any unbound plan (roborev 55131).
  it("translates sendToBuild's at-capacity throw into a typed refusal", async () => {
    const projectId = seedProject();
    beadShow.mockResolvedValue(epic("e1"));
    sendToBuildMock.mockImplementation(() => {
      throw new AtCapacityError("all slots taken");
    });

    const r = await promotePlanToBuild(ROOT, projectId, "e1", null);
    expect(r.ok).toBe(false);
    // `at-capacity`, NOT the generic `action-failed` — the concierge can reason about the first and
    // cannot about the second. The GATE itself lives in sendToBuild so every caller is covered; what
    // is tested here is the translation.
    if (!r.ok) expect([r.reason, r.message]).toEqual(["at-capacity", "all slots taken"]);
  });

  it("turns a sendToBuild throw into a refusal rather than propagating it", async () => {
    const projectId = seedProject();
    beadShow.mockResolvedValue(epic("e1"));
    sendToBuildMock.mockImplementation(() => {
      throw new Error("project vanished");
    });

    const r = await promotePlanToBuild(ROOT, projectId, "e1", null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect([r.reason, r.message]).toEqual(["action-failed", "project vanished"]);
  });
});
