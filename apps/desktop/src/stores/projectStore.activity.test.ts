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

describe("projectStore.setAgentActivity", () => {
  beforeEach(seed);

  it("sets the agent's live activity line", () => {
    useProjectStore.getState().setAgentActivity("p1", "a1", "Wiring the control listener");
    expect(agent().activity).toBe("Wiring the control listener");
  });

  it("trims surrounding whitespace", () => {
    useProjectStore.getState().setAgentActivity("p1", "a1", "  Running tests  ");
    expect(agent().activity).toBe("Running tests");
  });

  it("clears the line when given whitespace-only text", () => {
    useProjectStore.getState().setAgentActivity("p1", "a1", "Building");
    useProjectStore.getState().setAgentActivity("p1", "a1", "   ");
    expect(agent().activity).toBe("");
  });

  it("does NOT pin the name or clear auto-name variants (unlike renameAgent)", () => {
    const variants = { title: "Auto Title", description: "some work" };
    useProjectStore.setState({
      projects: [
        { ...useProjectStore.getState().projects[0]!, agents: [{ ...mkAgent(), autoNameVariants: variants }] },
      ],
    } as never);
    useProjectStore.getState().setAgentActivity("p1", "a1", "Now doing X");
    expect(agent().namePinned).toBe(false);
    expect(agent().autoNameVariants).toEqual(variants);
    expect(agent().name).toBe("A1");
  });

  it("only touches the targeted agent", () => {
    useProjectStore.setState({
      projects: [
        {
          ...useProjectStore.getState().projects[0]!,
          agents: [mkAgent(), { ...mkAgent(), id: "a2", name: "A2" }],
        },
      ],
    } as never);
    useProjectStore.getState().setAgentActivity("p1", "a2", "sibling work");
    const agents = useProjectStore.getState().projects[0]!.agents;
    expect(agents.find((a) => a.id === "a1")!.activity).toBeUndefined();
    expect(agents.find((a) => a.id === "a2")!.activity).toBe("sibling work");
  });
});
