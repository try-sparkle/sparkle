import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the two stores so we can assert the exact store calls sendToBuild makes without spinning up
// real zustand state. beadsProtocol (from ./buildAgent) is left REAL so the seed prompt genuinely
// embeds the epic id the orchestrator will act on.
const addAgentMock = vi.fn();
const appendPromptMock = vi.fn();
let projects: Array<{ id: string; agents: Array<{ id: string; kind: string }> }> = [];

vi.mock("../stores/projectStore", () => ({
  useProjectStore: {
    getState: () => ({ projects, addAgent: addAgentMock, appendPrompt: appendPromptMock }),
  },
}));

const openMock = vi.fn();
vi.mock("../stores/runtimeStore", () => ({
  useRuntimeStore: { getState: () => ({ open: openMock }) },
}));

import { sendToBuild } from "./sendToBuild";

describe("sendToBuild", () => {
  beforeEach(() => {
    addAgentMock.mockReset();
    appendPromptMock.mockReset();
    openMock.mockReset();
    appendPromptMock.mockReturnValue("prompt-id");
    projects = [];
  });

  it("creates a build agent when the project has none, opens it, and seeds the prompt", () => {
    projects = [{ id: "proj1", agents: [] }];
    addAgentMock.mockReturnValue("build-new");

    const id = sendToBuild({ projectId: "proj1", epicId: "epic-42", prdPath: "PRD/feature.md" });

    expect(id).toBe("build-new");
    // Created a build agent (mirrors AgentSidebar's Build button: addAgent kind "build").
    expect(addAgentMock).toHaveBeenCalledWith("proj1", { kind: "build" });
    // Opened the new agent (mounts pane / drives PTY launch).
    expect(openMock).toHaveBeenCalledWith("build-new");
    // Seeded the orchestrator's first message.
    expect(appendPromptMock).toHaveBeenCalledTimes(1);
    const [projectId, agentId, seed] = appendPromptMock.mock.calls[0]!;
    expect(projectId).toBe("proj1");
    expect(agentId).toBe("build-new");
    expect(seed).toContain("epic-42"); // the epic id
    expect(seed).toContain("PRD/feature.md"); // the PRD path
  });

  it("reuses the project's existing build agent instead of creating a new one", () => {
    projects = [
      {
        id: "proj1",
        agents: [
          { id: "think1", kind: "think" },
          { id: "build1", kind: "build" },
        ],
      },
    ];

    const id = sendToBuild({ projectId: "proj1", epicId: "epic-7", prdPath: "PRD/x.md" });

    expect(id).toBe("build1");
    expect(addAgentMock).not.toHaveBeenCalled(); // reused, not created
    expect(openMock).toHaveBeenCalledWith("build1");
    expect(appendPromptMock).toHaveBeenCalledWith("proj1", "build1", expect.stringContaining("epic-7"));
  });

  it("throws for an unknown project", () => {
    projects = [];
    expect(() => sendToBuild({ projectId: "ghost", epicId: "e", prdPath: "p" })).toThrow(/unknown project/);
    expect(addAgentMock).not.toHaveBeenCalled();
    expect(openMock).not.toHaveBeenCalled();
  });

  it("seeds a prompt that instructs reading the PRD and following the beads protocol", () => {
    projects = [{ id: "proj1", agents: [{ id: "build1", kind: "build" }] }];

    sendToBuild({ projectId: "proj1", epicId: "epic-99", prdPath: "PRD/big.md" });

    const seed = appendPromptMock.mock.calls[0]![2] as string;
    expect(seed).toMatch(/read the PRD/i);
    expect(seed).toContain("BEADS PROTOCOL"); // the protocol addendum is embedded
    expect(seed).toContain("bd update"); // claim-before-spawn instruction
    expect(seed).toContain("bd close"); // close-after-merge instruction
    expect(seed).toContain("delivered"); // label-on-ship instruction
  });
});
