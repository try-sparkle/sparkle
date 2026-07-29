import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the two stores so we can assert the exact store calls sendToBuild makes without spinning up
// real zustand state. beadsProtocol (from ./buildAgent) is left REAL so the seed prompt genuinely
// embeds the epic id the orchestrator will act on.
const addAgentMock = vi.fn();
const appendPromptMock = vi.fn();
const setAgentEpicIdMock = vi.fn();
const setAgentBeadIdMock = vi.fn();
const selectAgentMock = vi.fn();
let projects: Array<{ id: string; agents: Array<{ id: string; kind: string; epicId?: string }> }> =
  [];

vi.mock("../stores/projectStore", () => ({
  useProjectStore: {
    getState: () => ({
      projects,
      addAgent: addAgentMock,
      appendPrompt: appendPromptMock,
      setAgentEpicId: setAgentEpicIdMock,
      setAgentBeadId: setAgentBeadIdMock,
      selectAgent: selectAgentMock,
    }),
  },
}));

const openMock = vi.fn();
vi.mock("../stores/runtimeStore", () => ({
  useRuntimeStore: { getState: () => ({ open: openMock }) },
}));

// sendToBuild reaches these through services/landInAgent, which is left REAL so these tests prove
// the real hand-off (not a mock of it) does all four steps.
const setActiveSpecialMock = vi.fn();
const requestRevealAgentMock = vi.fn();
const requestComposeFocusMock = vi.fn();
vi.mock("../stores/uiStore", () => ({
  useUiStore: {
    getState: () => ({
      setActiveSpecial: setActiveSpecialMock,
      requestRevealAgent: requestRevealAgentMock,
      requestComposeFocus: requestComposeFocusMock,
    }),
  },
}));

import { sendToBuild } from "./sendToBuild";

describe("sendToBuild", () => {
  beforeEach(() => {
    addAgentMock.mockReset();
    appendPromptMock.mockReset();
    setAgentEpicIdMock.mockReset();
    setAgentBeadIdMock.mockReset();
    selectAgentMock.mockReset();
    openMock.mockReset();
    setActiveSpecialMock.mockReset();
    requestRevealAgentMock.mockReset();
    requestComposeFocusMock.mockReset();
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
    // …and bound that SAME human-filed bead as the orchestrator's beadId (bead sparkle-0bhr) — the
    // linkage that lets `shipAgent` mark the human bead delivered on land so it reaches "Shipped".
    expect(setAgentBeadIdMock).toHaveBeenCalledWith("proj1", "build-new", "epic-42");
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
    // The human bead is linked on the reuse path too, so a re-hit Build It still routes delivery.
    expect(setAgentBeadIdMock).toHaveBeenCalledWith("proj1", "build1", "epic-7");
  });

  // §13 — "Start"/"Build It" must LAND the user in the orchestrator. These four steps are the
  // whole point: `open()` alone (what this used to do) mounts the pane BEHIND the Plan board and
  // changes nothing the user can see, which is why hitting Build It read as "nothing happened".
  describe("lands the user in the orchestrator", () => {
    it("leaves the Plan board, selects, opens, and reveals the row on the CREATE path", () => {
      projects = [{ id: "proj1", agents: [] }];
      addAgentMock.mockReturnValue("build-new");

      sendToBuild({ projectId: "proj1", epicId: "epic-42", prdPath: "PRD/feature.md" });

      // Both Build It handlers are clicked FROM the board, so activeSpecial is "board" and the
      // board owns the pane. Without this the selection below is invisible.
      expect(setActiveSpecialMock).toHaveBeenCalledWith(null);
      expect(selectAgentMock).toHaveBeenCalledWith("proj1", "build-new");
      expect(openMock).toHaveBeenCalledWith("build-new");
      expect(requestRevealAgentMock).toHaveBeenCalledWith("build-new");
    });

    // The REUSE path was strictly worse than the create path and is the one a user hits second:
    // with an existing orchestrator `addAgent` is never called, so not even its default
    // `select: true` fired. Re-hitting Build It on an epic did nothing observable at all.
    it("does the same on the REUSE path, where addAgent's default selection never fires", () => {
      projects = [
        { id: "proj1", agents: [{ id: "build1", kind: "build", epicId: "epic-7" }] },
      ];

      sendToBuild({ projectId: "proj1", epicId: "epic-7", prdPath: "PRD/x.md" });

      expect(addAgentMock).not.toHaveBeenCalled();
      expect(setActiveSpecialMock).toHaveBeenCalledWith(null);
      expect(selectAgentMock).toHaveBeenCalledWith("proj1", "build1");
      expect(requestRevealAgentMock).toHaveBeenCalledWith("build1");
    });

    // The orchestrator arrives with a seeded prompt, so there is nothing for the user to type and
    // the caret is not ours to take — it belongs to whatever they were doing on the board.
    it("does NOT steal the caret — the seed prompt means there is nothing to type", () => {
      projects = [{ id: "proj1", agents: [] }];
      addAgentMock.mockReturnValue("build-new");

      sendToBuild({ projectId: "proj1", epicId: "epic-42", prdPath: null });

      expect(requestComposeFocusMock).not.toHaveBeenCalled();
    });
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

  // bead sparkle-0bhr — the "Shipped" column was structurally unreachable for hand-filed beads: a
  // build agent's beadId was only ever set by the AUTO path (which stamps `sparkle-auto`, HIDDEN
  // from the board), so a bead a human filed and worked had no agent linkage and `shipAgent` had no
  // beadId to mark delivered. sendToBuild is the human handoff, so this is where the link is made.
  it("links the human-filed bead as the orchestrator's beadId in TASK mode (Build this one bead)", () => {
    projects = [{ id: "proj1", agents: [] }];
    addAgentMock.mockReturnValue("build-new");

    sendToBuild({ projectId: "proj1", epicId: "human-bead-1", prdPath: null, mode: "task" });

    // The single human bead is bound as the agent's beadId → shipAgent will mark IT delivered on
    // land (not a hidden auto-bead), so it lands in "Shipped". Removing the setAgentBeadId call in
    // sendToBuild makes this fail — the human bead would again have no ship-path linkage.
    expect(setAgentBeadIdMock).toHaveBeenCalledWith("proj1", "build-new", "human-bead-1");
  });

  it("throws for an unknown project", () => {
    projects = [];
    expect(() => sendToBuild({ projectId: "ghost", epicId: "e", prdPath: "p" })).toThrow(/unknown project/);
    expect(addAgentMock).not.toHaveBeenCalled();
    expect(openMock).not.toHaveBeenCalled();
    expect(setAgentEpicIdMock).not.toHaveBeenCalled();
    expect(setAgentBeadIdMock).not.toHaveBeenCalled();
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
