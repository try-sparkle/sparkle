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

// selfNameAgent — the sparkle-control rename_agent path. It makes the name authoritative WITHOUT
// pinning the row (regression sparkle-pel7: agents self-naming looked pinned and couldn't be unpinned).
describe("projectStore selfNameAgent", () => {
  beforeEach(seed);

  it("sets the name + selfNamed but NEVER namePinned or pinnedIndex", () => {
    useProjectStore.getState().selfNameAgent("p1", "a1", "Parser Builder");
    expect(agent().name).toBe("Parser Builder");
    expect(agent().selfNamed).toBe(true);
    expect(agent().namePinned).toBe(false); // no pin chip
    expect(agent().pinnedIndex).toBeNull(); // no row anchor
  });

  it("clears autoNameVariants so the chosen label shows verbatim", () => {
    useProjectStore.setState({
      projects: [
        {
          ...useProjectStore.getState().projects[0]!,
          agents: [{ ...mkAgent(), autoNameVariants: { short: "S", medium: "M", long: "Stale Auto Name" } }],
        },
      ],
    } as never);
    useProjectStore.getState().selfNameAgent("p1", "a1", "Chosen Name");
    expect(agent().autoNameVariants).toBeNull();
  });

  it("freezes the name against the background auto-namer", () => {
    useProjectStore.getState().selfNameAgent("p1", "a1", "Chosen Name");
    useProjectStore.getState().autoRenameAgent("p1", "a1", "Auto Guess", "some prompt");
    expect(agent().name).toBe("Chosen Name"); // auto-namer must not clobber a self-name
  });

  it("is a no-op over a human pin (namePinned wins)", () => {
    useProjectStore.getState().renameAgent("p1", "a1", "Human Choice", 0);
    useProjectStore.getState().selfNameAgent("p1", "a1", "Agent Choice");
    expect(agent().name).toBe("Human Choice");
    expect(agent().namePinned).toBe(true);
  });

  it("ignores a blank name", () => {
    useProjectStore.getState().selfNameAgent("p1", "a1", "   ");
    expect(agent().name).toBe("A1");
    expect(agent().selfNamed).toBeFalsy();
  });
});
