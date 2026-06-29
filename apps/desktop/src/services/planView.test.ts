import { describe, it, expect } from "vitest";
import { rollupEpicStatus, epicStatus, workersForBead, beadLabel, epicForBuild } from "./planView";
import type { Bead, BeadStatus } from "./beads";
import type { AgentTab } from "../types";

const bead = (id: string, status: BeadStatus, parent: string | null = null, title = id): Bead => ({
  id,
  title,
  description: "",
  status,
  labels: [],
  parent,
});

const worker = (
  name: string,
  beadId: string | undefined,
  kind: AgentTab["kind"] = "worker",
): Pick<AgentTab, "name" | "kind" | "beadId"> => ({ name, kind, beadId });

describe("rollupEpicStatus", () => {
  it("is not_started with no children", () => {
    expect(rollupEpicStatus([])).toBe("not_started");
  });
  it("is not_started when every child is open", () => {
    expect(rollupEpicStatus(["open", "open"])).toBe("not_started");
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
  it("is not_started for an epic with no children", () => {
    expect(epicStatus([bead("e3", "open")], "e3")).toBe("not_started");
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
