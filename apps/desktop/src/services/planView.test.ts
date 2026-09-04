import { describe, it, expect } from "vitest";
import {
  rollupEpicStatus,
  epicStatus,
  workersForBead,
  beadLabel,
  epicForBuild,
  epicPillFor,
  epicChildViews,
  orchestratorNameForEpic,
  beadStage,
} from "./planView";
import { bucketBeads, type Bead, type BeadStatus, type Board } from "./beads";
import type { AgentTab } from "../types";

const bead = (id: string, status: BeadStatus, parent: string | null = null, title = id): Bead => ({
  id,
  title,
  description: "",
  status,
  labels: [],
  parent,
  commentCount: 0,
});

const worker = (
  name: string,
  beadId: string | undefined,
  kind: AgentTab["kind"] = "worker",
): Pick<AgentTab, "name" | "kind" | "beadId"> => ({ name, kind, beadId });

describe("rollupEpicStatus", () => {
  // THE SPLIT IS THE POINT OF THESE TWO CASES. Both returned "not_started" until this change, and
  // the pair is asserted together deliberately: a test that only checked one of them would stay
  // green if the two words were ever collapsed back into one, which is the regression that matters.
  // "no plan at all" and "a finished plan nobody started" must never be the same word again.
  it("is unplanned with no children — a title, nothing decided", () => {
    expect(rollupEpicStatus([])).toBe("unplanned");
  });
  it("is planning when every child is open — the plan exists and nobody picked it up", () => {
    expect(rollupEpicStatus(["open", "open"])).toBe("planning");
  });
  it("distinguishes no-plan from planned-not-started", () => {
    expect(rollupEpicStatus([])).not.toBe(rollupEpicStatus(["open"]));
  });
  // An empty array satisfies `every(open)` VACUOUSLY, so the childless case has to be answered
  // first. Written as its own assertion because reordering those two lines is a silent change: the
  // suite would still pass every other case here while the sweeper started spawning agents at
  // epics that hold no plan to build.
  it("does not let a childless epic fall through to planning", () => {
    expect(["open"].every((s) => s === "open")).toBe(true); // the trap, stated
    expect([].every((s) => s === "open")).toBe(true); // ...and it is vacuously true when empty
    expect(rollupEpicStatus([])).toBe("unplanned"); // ...so order, not the predicate, decides
  });
  it("is done when every child is closed", () => {
    expect(rollupEpicStatus(["closed", "closed"])).toBe("done");
  });
  it("is in_progress when any child is in_progress", () => {
    expect(rollupEpicStatus(["open", "in_progress"])).toBe("in_progress");
  });
  it("is in_progress on a mix of open and closed (work has started)", () => {
    expect(rollupEpicStatus(["open", "closed"])).toBe("in_progress");
  });
});

describe("epicStatus", () => {
  it("rolls up the epic's children by parent link", () => {
    const beads = [
      bead("e1", "open"),
      bead("e1.1", "closed", "e1"),
      bead("e1.2", "open", "e1"),
      bead("other", "in_progress"), // unrelated — must not affect the epic
    ];
    expect(epicStatus(beads, "e1")).toBe("in_progress");
  });
  it("is done when all children are closed", () => {
    const beads = [bead("e2", "open"), bead("e2.1", "closed", "e2"), bead("e2.2", "closed", "e2")];
    expect(epicStatus(beads, "e2")).toBe("done");
  });
  it("is unplanned for an epic with no children", () => {
    expect(epicStatus([bead("e3", "open")], "e3")).toBe("unplanned");
  });
  it("is planning for an epic whose children are all still open", () => {
    const beads = [bead("e4", "open"), bead("e4.1", "open", "e4"), bead("e4.2", "open", "e4")];
    expect(epicStatus(beads, "e4")).toBe("planning");
  });
});

describe("workersForBead", () => {
  const agents = [
    worker("Scaffold worker", "e1.1"),
    worker("Auth worker", "e1.2"),
    worker("Second auth worker", "e1.2"),
    worker("Orchestrator", undefined, "build"), // not a worker — ignored
    worker("Unrelated worker", "z9"),
  ];
  it("returns the names of workers assigned to the bead", () => {
    expect(workersForBead(agents, "e1.2")).toEqual(["Auth worker", "Second auth worker"]);
  });
  it("returns one name for a singly-assigned bead", () => {
    expect(workersForBead(agents, "e1.1")).toEqual(["Scaffold worker"]);
  });
  it("returns [] for a bead with no workers", () => {
    expect(workersForBead(agents, "nope")).toEqual([]);
  });
});

describe("epicForBuild", () => {
  const beads = [
    bead("e1", "open", null, "Build the mobile app"),
    bead("e1.1", "closed", "e1"),
    bead("e1.2", "open", "e1"),
  ];
  it("derives the epic from a build agent's workers' beads", () => {
    const agents = [
      worker("Scaffold worker", "e1.1"),
      worker("Auth worker", "e1.2"),
    ].map((w) => ({ ...w, parentId: "build1" })) as Pick<AgentTab, "kind" | "parentId" | "beadId">[];
    expect(epicForBuild(beads, agents, "build1")).toBe("e1 · Build the mobile app");
  });
  it("is null when no worker of that build agent is bound to a bead", () => {
    const agents = [{ kind: "worker" as const, parentId: "build1", beadId: undefined }];
    expect(epicForBuild(beads, agents, "build1")).toBeNull();
  });
});

describe("beadLabel", () => {
  const beads = [bead("e1.2", "open", "e1", "Auth screen")];
  it("formats a known bead as 'id · title'", () => {
    expect(beadLabel(beads, "e1.2")).toBe("e1.2 · Auth screen");
  });
  it("falls back to the bare id when the bead isn't in the snapshot", () => {
    expect(beadLabel(beads, "ghost")).toBe("ghost");
  });
  it("is null when the worker has no bead", () => {
    expect(beadLabel(beads, null)).toBeNull();
    expect(beadLabel(beads, undefined)).toBeNull();
  });
});

describe("beadStage — unified stage for a Plan card", () => {
  it("delivered closed → Shipped to Production", () => {
    expect(beadStage("closed", true, [])).toBe("shipped");
  });
  it("closed (not delivered) → Merged with Main", () => {
    expect(beadStage("closed", false, [])).toBe("merged");
  });
  it("open → Planned", () => {
    expect(beadStage("open", false, [])).toBe("planned");
  });
  it("in_progress with no live worker stage → Building (Unsaved)", () => {
    expect(beadStage("in_progress", false, [])).toBe("building_unsaved");
  });
  it("prefers live worker progress (least-advanced) over the status mapping", () => {
    expect(beadStage("in_progress", false, ["building_saved", "pull_request"])).toBe(
      "building_saved",
    );
  });
  it("delivered wins even over a live worker stage", () => {
    expect(beadStage("closed", true, ["merged"])).toBe("shipped");
  });
  it("a closed bead reads Merged even if a stale worker still reports an earlier stage", () => {
    expect(beadStage("closed", false, ["building_saved"])).toBe("merged");
  });
});

describe("epicPillFor — the orchestrator row's epic pill", () => {
  const board: Board = bucketBeads([
    bead("e1", "open", null, "Build the mobile app"),
    bead("e1.1", "in_progress", "e1"),
    bead("e1.2", "open", "e1"),
  ]);
  const buildAgent = (epicId?: string): Pick<AgentTab, "id" | "kind" | "epicId"> => ({
    id: "build1",
    kind: "build",
    epicId,
  });

  it("prefers the agent's own epicId, resolving the title from the board", () => {
    expect(epicPillFor(buildAgent("e1"), board, [])).toEqual({
      id: "e1",
      title: "Build the mobile app",
    });
  });
  it("falls back to the bare id as the title when the epic isn't on the board yet", () => {
    expect(epicPillFor(buildAgent("ghost"), board, [])).toEqual({ id: "ghost", title: "ghost" });
    // epicId is set at handoff time — the pill must show even before the first board poll lands.
    expect(epicPillFor(buildAgent("e1"), null, [])).toEqual({ id: "e1", title: "e1" });
  });
  it("epicId wins over a conflicting worker-derived epic (fallback order)", () => {
    // Workers still bound to beads under the OLD epic e1, but the orchestrator was re-handed e2:
    // the handoff-time epicId is authoritative, the worker derivation is only the fallback.
    const twoEpics: Board = bucketBeads([
      bead("e1", "open", null, "Old epic"),
      bead("e1.1", "in_progress", "e1"),
      bead("e2", "open", null, "New epic"),
    ]);
    const agents = [{ kind: "worker" as const, parentId: "build1", beadId: "e1.1" }];
    expect(epicPillFor(buildAgent("e2"), twoEpics, agents)).toEqual({
      id: "e2",
      title: "New epic",
    });
  });
  it("derives the epic from bound workers when the agent has no epicId", () => {
    const agents = [
      { kind: "worker" as const, parentId: "build1", beadId: "e1.1" },
      { kind: "worker" as const, parentId: "build1", beadId: "e1.2" },
    ];
    expect(epicPillFor(buildAgent(undefined), board, agents)).toEqual({
      id: "e1",
      title: "Build the mobile app",
    });
  });
  it("is null with no epicId and no worker-derived epic", () => {
    const agents = [{ kind: "worker" as const, parentId: "build1", beadId: undefined }];
    expect(epicPillFor(buildAgent(undefined), board, agents)).toBeNull();
    expect(epicPillFor(buildAgent(undefined), null, [])).toBeNull();
  });
});

describe("epicChildViews — the live epic detail rows", () => {
  const beads = [
    bead("e1", "open", null, "Build the mobile app"),
    bead("e1.1", "in_progress", "e1", "Scaffold"),
    bead("e1.2", "open", "e1", "Auth screen"),
    bead("other", "open", null), // unrelated — must not appear
  ];
  it("pairs each child bead with the workers currently on it", () => {
    const agents = [
      worker("Scaffold worker", "e1.1"),
      worker("Auth worker", "e1.2"),
      worker("Second auth worker", "e1.2"),
      worker("Unrelated worker", "other"),
    ];
    const rows = epicChildViews(beads, agents, "e1");
    expect(rows.map((r) => r.bead.id)).toEqual(["e1.1", "e1.2"]);
    expect(rows.find((r) => r.bead.id === "e1.2")!.workers).toEqual([
      "Auth worker",
      "Second auth worker",
    ]);
    expect(rows.find((r) => r.bead.id === "e1.1")!.workers).toEqual(["Scaffold worker"]);
  });
  it("is empty for a childless epic (still decomposing)", () => {
    expect(epicChildViews(beads, [], "childless")).toEqual([]);
  });
});

describe("orchestratorNameForEpic — reverse §8 linkage for the live view", () => {
  const beads = [
    bead("e1", "open", null, "Build the mobile app"),
    bead("e1.1", "in_progress", "e1"),
  ];
  const buildAgent = (
    over: Partial<Pick<AgentTab, "id" | "name" | "epicId">>,
  ): Pick<AgentTab, "id" | "name" | "kind" | "epicId" | "parentId" | "beadId"> => ({
    id: "build1",
    name: "Orchestrator One",
    kind: "build",
    epicId: undefined,
    parentId: null,
    beadId: undefined,
    ...over,
  });

  it("prefers a build agent whose epicId matches (handoff-time binding)", () => {
    expect(orchestratorNameForEpic(beads, [buildAgent({ epicId: "e1" })], "e1")).toBe(
      "Orchestrator One",
    );
  });
  it("falls back to the build agent whose workers are on the epic's children", () => {
    const agents = [
      buildAgent({}),
      {
        kind: "worker" as const,
        parentId: "build1",
        beadId: "e1.1",
        id: "w1",
        name: "W",
        epicId: undefined,
      },
    ];
    expect(orchestratorNameForEpic(beads, agents, "e1")).toBe("Orchestrator One");
  });
  it("is null when no orchestrator is bound to the epic", () => {
    expect(orchestratorNameForEpic(beads, [buildAgent({})], "e1")).toBeNull();
    expect(orchestratorNameForEpic(beads, [], "e1")).toBeNull();
  });

  // ── THE LADDER ARM (bead `sparkle-n2feho.9`, part D) ───────────────────────────────────────
  // `sendToBuild` in `mode: "task"` stamps a TASK bead's id into `epicId`, so the direct arm's
  // `a.epicId === epicId` cannot see that agent on the EPIC, and the worker-derived arm cannot see
  // it until it has SPAWNED A WORKER. Between the handoff and the first worker the epic therefore
  // read `orchestrator: None` while an orchestrator was plainly on it.
  it("finds a TASK-LEVEL orchestrator that has spawned NO worker yet", () => {
    // Exactly what `prepareHandoff` writes in task mode: the same TASK id in BOTH fields.
    const taskOrch = buildAgent({ epicId: "e1.1" });
    expect(orchestratorNameForEpic(beads, [{ ...taskOrch, beadId: "e1.1" }], "e1")).toBe(
      "Orchestrator One",
    );
  });

  // THE PAIRED NEGATIVE: the arm must not drag in an agent from a DIFFERENT epic. Without this,
  // a ladder arm that returned the first build agent unconditionally would pass the case above.
  it("does not claim a task orchestrator bound under a different epic", () => {
    const otherEpic = [
      bead("e1", "open", null),
      bead("e1.1", "open", "e1"),
      bead("e2", "open", null),
      bead("e2.1", "open", "e2"),
    ];
    const onE2 = buildAgent({ id: "b2", name: "Other", epicId: "e2.1" });
    expect(orchestratorNameForEpic(otherEpic, [{ ...onE2, beadId: "e2.1" }], "e1")).toBeNull();
    expect(orchestratorNameForEpic(otherEpic, [{ ...onE2, beadId: "e2.1" }], "e2")).toBe("Other");
  });

  // PRECEDENCE: an orchestrator handed THIS epic outranks one handed a child of it. The ladder
  // resolves both to "e1", so only the arm ORDER separates them.
  it("prefers the orchestrator bound to the EPIC over one bound to a child task", () => {
    const onEpic = buildAgent({ id: "b-epic", name: "Epic Owner", epicId: "e1" });
    const onTask = buildAgent({ id: "b-task", name: "Task Owner", epicId: "e1.1" });
    expect(orchestratorNameForEpic(beads, [onTask, onEpic], "e1")).toBe("Epic Owner");
  });
});
