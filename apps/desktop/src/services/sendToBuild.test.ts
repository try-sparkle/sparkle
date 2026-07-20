import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the two stores so we can assert the exact store calls sendToBuild makes without spinning up
// real zustand state. beadsProtocol (from ./buildAgent) is left REAL so the seed prompt genuinely
// embeds the epic id the orchestrator will act on.
const addAgentMock = vi.fn();
const appendPromptMock = vi.fn();
const setAgentEpicIdMock = vi.fn();
let projects: Array<{ id: string; agents: Array<{ id: string; kind: string; epicId?: string }> }> =
  [];

vi.mock("../stores/projectStore", () => ({
  useProjectStore: {
    getState: () => ({
      projects,
      addAgent: addAgentMock,
      appendPrompt: appendPromptMock,
      setAgentEpicId: setAgentEpicIdMock,
    }),
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
    setAgentEpicIdMock.mockReset();
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
    // Bound the epic to the new orchestrator (drives the sidebar epic pill — spec §8).
    expect(setAgentEpicIdMock).toHaveBeenCalledWith("proj1", "build-new", "epic-42");
    // Seeded the orchestrator's first message.
    expect(appendPromptMock).toHaveBeenCalledTimes(1);
    const [projectId, agentId, seed] = appendPromptMock.mock.calls[0]!;
    expect(projectId).toBe("proj1");
    expect(agentId).toBe("build-new");
    expect(seed).toContain("epic-42"); // the epic id
    expect(seed).toContain("PRD/feature.md"); // the PRD path
  });

  it("reuses the orchestrator already bound to THIS epic (re-hitting Build It is idempotent)", () => {
    projects = [
      {
        id: "proj1",
        agents: [
          { id: "think1", kind: "think" },
          { id: "build1", kind: "build", epicId: "epic-7" },
        ],
      },
    ];

    const id = sendToBuild({ projectId: "proj1", epicId: "epic-7", prdPath: "PRD/x.md" });

    expect(id).toBe("build1");
    expect(addAgentMock).not.toHaveBeenCalled(); // reused: it's already this epic's orchestrator
    expect(openMock).toHaveBeenCalledWith("build1");
    expect(appendPromptMock).toHaveBeenCalledWith("proj1", "build1", expect.stringContaining("epic-7"));
    expect(setAgentEpicIdMock).toHaveBeenCalledWith("proj1", "build1", "epic-7");
  });

  it("spawns a FRESH orchestrator when the only build agent is bound to a DIFFERENT epic", () => {
    // The reported bug: `find((a) => a.kind === "build")` handed epic-8 to epic-7's orchestrator.
    projects = [
      { id: "proj1", agents: [{ id: "build1", kind: "build", epicId: "epic-7" }] },
    ];
    addAgentMock.mockReturnValue("build-new");

    const id = sendToBuild({ projectId: "proj1", epicId: "epic-8", prdPath: "PRD/x.md" });

    expect(id).toBe("build-new");
    expect(addAgentMock).toHaveBeenCalledWith("proj1", { kind: "build" });
    // epic-7's orchestrator is left alone — its binding is NOT clobbered.
    expect(setAgentEpicIdMock).not.toHaveBeenCalledWith("proj1", "build1", "epic-8");
    expect(setAgentEpicIdMock).toHaveBeenCalledWith("proj1", "build-new", "epic-8");
    expect(openMock).toHaveBeenCalledWith("build-new");
  });

  it("spawns a FRESH orchestrator rather than reusing an unbound build agent", () => {
    // An orchestrator with no epicId is not "free" — it may be a hand-started Build agent the user
    // is talking to. Only an explicit epic match earns reuse.
    projects = [{ id: "proj1", agents: [{ id: "build1", kind: "build" }] }];
    addAgentMock.mockReturnValue("build-new");

    const id = sendToBuild({ projectId: "proj1", epicId: "epic-9", prdPath: null });

    expect(id).toBe("build-new");
    expect(addAgentMock).toHaveBeenCalledWith("proj1", { kind: "build" });
  });

  it("never reuses a landed/merged orchestrator bound to other work", () => {
    // The exact founder repro: the "DROdio.com PRD" row was 89% complete and ✓Landed when a new
    // epic was handed to it. A finished orchestrator on another epic must not be recycled.
    projects = [
      {
        id: "proj1",
        agents: [{ id: "landed-build", kind: "build", epicId: "drodio-website-old" }],
      },
    ];
    addAgentMock.mockReturnValue("build-new");

    const id = sendToBuild({
      projectId: "proj1",
      epicId: "drodio-website-di3",
      prdPath: "PRD/drodio.md",
    });

    expect(id).toBe("build-new");
    expect(appendPromptMock).not.toHaveBeenCalledWith("proj1", "landed-build", expect.anything());
  });

  it("gives each epic its own orchestrator when several epics are built in turn", () => {
    // Guards BoardView's "Build all N epics in this PRD" loop, which calls sendToBuild per epic.
    projects = [{ id: "proj1", agents: [] }];
    let spawnCount = 0;
    // Make the mock store behave like the real one: addAgent appends the agent, and setAgentEpicId
    // actually writes the binding. The reuse predicate then reads state that sendToBuild itself
    // produced, so this test fails if the setAgentEpicId call is ever dropped — rather than passing
    // on a binding the test hand-wrote.
    addAgentMock.mockImplementation((_projectId: string, opts: { kind: string }) => {
      const id = `build-${++spawnCount}`;
      projects[0]!.agents.push({ id, kind: opts.kind });
      return id;
    });
    setAgentEpicIdMock.mockImplementation((_projectId: string, agentId: string, epicId: string) => {
      const agent = projects[0]!.agents.find((x) => x.id === agentId);
      if (agent) agent.epicId = epicId;
    });

    const a = sendToBuild({ projectId: "proj1", epicId: "epic-a", prdPath: "PRD/shared.md" });
    const b = sendToBuild({ projectId: "proj1", epicId: "epic-b", prdPath: "PRD/shared.md" });
    const c = sendToBuild({ projectId: "proj1", epicId: "epic-c", prdPath: "PRD/shared.md" });

    expect(new Set([a, b, c]).size).toBe(3); // three distinct orchestrators
    expect(addAgentMock).toHaveBeenCalledTimes(3);
    // Each orchestrator ends up bound to its OWN epic — no clobbering.
    expect(projects[0]!.agents.map((x) => x.epicId)).toEqual(["epic-a", "epic-b", "epic-c"]);

    // And re-hitting Build It on an already-built epic returns that epic's orchestrator.
    expect(sendToBuild({ projectId: "proj1", epicId: "epic-b", prdPath: "PRD/shared.md" })).toBe(b);
    expect(addAgentMock).toHaveBeenCalledTimes(3); // no fourth spawn
  });

  it("throws for an unknown project", () => {
    projects = [];
    expect(() => sendToBuild({ projectId: "ghost", epicId: "e", prdPath: "p" })).toThrow(/unknown project/);
    expect(addAgentMock).not.toHaveBeenCalled();
    expect(openMock).not.toHaveBeenCalled();
    expect(setAgentEpicIdMock).not.toHaveBeenCalled();
  });

  it("omits the PRD instruction for a PRD-less epic (prdPath null) instead of blocking", () => {
    // Bound to this same epic so the call reuses build1 and the assertions stay on the seed text.
    projects = [{ id: "proj1", agents: [{ id: "build1", kind: "build", epicId: "epic-1" }] }];

    sendToBuild({ projectId: "proj1", epicId: "epic-1", prdPath: null });

    const seed = appendPromptMock.mock.calls[0]![2] as string;
    expect(seed).not.toMatch(/read the PRD/i);
    expect(seed).toContain("epic-1");
    expect(seed).toContain("BEADS PROTOCOL"); // protocol still embedded
    expect(seed).toMatch(/bd show/i); // the epic bead itself is the spec now
  });

  it("seeds a prompt that instructs reading the PRD and following the beads protocol", () => {
    projects = [{ id: "proj1", agents: [{ id: "build1", kind: "build", epicId: "epic-99" }] }];

    sendToBuild({ projectId: "proj1", epicId: "epic-99", prdPath: "PRD/big.md" });

    const seed = appendPromptMock.mock.calls[0]![2] as string;
    expect(seed).toMatch(/read the PRD/i);
    expect(seed).toContain("BEADS PROTOCOL"); // the protocol addendum is embedded
    expect(seed).toContain("bd update"); // claim-before-spawn instruction
    expect(seed).toContain("bd close"); // close-after-merge instruction
    expect(seed).toContain("delivered"); // label-on-ship instruction
  });
});
