import { beforeEach, describe, expect, it } from "vitest";
import { useProjectStore } from "./projectStore";
import type { AgentTab, Project } from "../types";

function mkAgent(): AgentTab {
  return {
    id: "a1", name: "A1", kind: "build", parentId: null, runtime: "local",
    worktreePath: null, branch: null, baseBranch: null, lastPrompt: "",
    promptHistory: [], namePinned: false, autoNameBasis: null,
    autoNameVariants: null, shellCommand: null, pinnedIndex: null,
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

describe("projectStore pin mutators", () => {
  beforeEach(seed);

  it("pinAgentAt sets namePinned + pinnedIndex", () => {
    useProjectStore.getState().pinAgentAt("p1", "a1", 2);
    expect(agent().namePinned).toBe(true);
    expect(agent().pinnedIndex).toBe(2);
  });

  it("pinAgentAt preserves autoNameVariants (a drag-reorder must not change the label)", () => {
    const variants = { short: "S", medium: "M", long: "Long Name" };
    useProjectStore.setState({
      projects: [
        { ...useProjectStore.getState().projects[0]!, agents: [{ ...mkAgent(), autoNameVariants: variants }] },
      ],
    } as never);
    useProjectStore.getState().pinAgentAt("p1", "a1", 0);
    expect(agent().autoNameVariants).toEqual(variants);
  });

  it("unpinAgent clears both", () => {
    useProjectStore.getState().pinAgentAt("p1", "a1", 2);
    useProjectStore.getState().unpinAgent("p1", "a1");
    expect(agent().namePinned).toBe(false);
    expect(agent().pinnedIndex).toBeNull();
  });

  it("renameAgent with an index pins the name and anchors the row", () => {
    useProjectStore.getState().renameAgent("p1", "a1", "New", 1);
    expect(agent().name).toBe("New");
    expect(agent().namePinned).toBe(true);
    expect(agent().pinnedIndex).toBe(1);
  });

  it("renameAgent without an index leaves pinnedIndex unchanged", () => {
    useProjectStore.getState().pinAgentAt("p1", "a1", 3);
    useProjectStore.getState().renameAgent("p1", "a1", "New2");
    expect(agent().pinnedIndex).toBe(3);
  });
});
