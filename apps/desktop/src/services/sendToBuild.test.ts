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
const setWorkModeMock = vi.fn();
const setActiveSpecialMock = vi.fn();
const requestRevealAgentMock = vi.fn();
const requestComposeFocusMock = vi.fn();
vi.mock("../stores/uiStore", () => ({
  useUiStore: {
    getState: () => ({
      setActiveSpecial: setActiveSpecialMock,
      requestRevealAgent: requestRevealAgentMock,
      requestComposeFocus: requestComposeFocusMock,
      // LEAVING THE BOARD IS `setWorkMode` NOW, not `setActiveSpecial`. The board is per-column
      // state (uiStore.workModeBySide), so landInAgent resolves the project's pair from the
      // assignment map — a mock missing either of these throws inside sideOf rather than failing
      // an assertion, which is a far more confusing way to learn the mock went stale.
      setWorkMode: setWorkModeMock,
      pairAssignment: {},
    }),
  },
}));

const capacityMock = vi.fn(() => ({ atCapacity: false, used: 1, limit: 8, live: 1, basis: "test" }));
vi.mock("./agentCapacity", async (orig) => ({
  ...(await orig<typeof import("./agentCapacity")>()),
  localAgentCapacity: () => capacityMock(),
}));

import { sendToBuild, AtCapacityError, sendToBuildBlockedReason } from "./sendToBuild";

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
    expect(appendPromptMock).toHaveBeenCalledWith(
      "proj1",
      "build1",
      expect.stringContaining("epic-7"),
      "composer",
      // A board click IS a person, so the reuse seed releases this orchestrator's goal debt. This is
      // the HUMAN sibling of the machine case below — without it, that one would pass against a flag
      // hardcoded to `false`, which would silently break the human release instead.
      true,
    );
    expect(setAgentEpicIdMock).toHaveBeenCalledWith("proj1", "build1", "epic-7");
    // The human bead is linked on the reuse path too, so a re-hit Build It still routes delivery.
    expect(setAgentBeadIdMock).toHaveBeenCalledWith("proj1", "build1", "epic-7");
  });

  // ── THE FOURTH AUTHORSHIP HOLE (roborev 55721) ──────────────────────────────────────────────────
  it("does not report a MACHINE-driven handoff as human-authored on the REUSE path", () => {
    // Reuse is the only path where this can matter — a brand-new orchestrator owes no goal debt —
    // and it is precisely the path a machine can drive: `promotePlanToBuild` is the concierge's tool
    // layer, and its own docstring advertises that a plan already bound to an orchestrator RESUMES
    // that agent. Seeding a reused orchestrator goes through `appendPrompt`, so with the default an
    // LLM promoting an epic whose orchestrator was ESCALATED un-latched that escalation and refilled
    // `totalContinues` — the bound `projectStore.releaseGoalDebt` documents as unreachable from a
    // machine dispatch.
    projects = [
      {
        id: "proj1",
        agents: [
          { id: "think1", kind: "think" },
          { id: "build1", kind: "build", epicId: "epic-7" },
        ],
      },
    ];

    sendToBuild({ projectId: "proj1", epicId: "epic-7", prdPath: "PRD/x.md", humanAuthored: false });

    expect(appendPromptMock).toHaveBeenCalledWith(
      "proj1",
      "build1",
      expect.any(String),
      "composer",
      false,
    );
  });

  // §13 — "Start"/"Build It" must LAND the user in the orchestrator. These four steps are the
  // whole point: `open()` alone (what this used to do) mounts the pane BEHIND the Plan board and
  // changes nothing the user can see, which is why hitting Build It read as "nothing happened".
  describe("lands the user in the orchestrator", () => {
    it("leaves the Plan board, selects, opens, and reveals the row on the CREATE path", () => {
      projects = [{ id: "proj1", agents: [] }];
      addAgentMock.mockReturnValue("build-new");

      sendToBuild({ projectId: "proj1", epicId: "epic-42", prdPath: "PRD/feature.md" });

      // Both Build It handlers are clicked FROM the board, which owns that column's pane. Without
      // leaving it the selection below is invisible. TWO calls, because the board and the
      // Improve-Sparkle pane are separate state now: the pane is `activeSpecial`, and the board is
      // the project's own column dropping out of Plan.
      expect(setActiveSpecialMock).toHaveBeenCalledWith(null);
      expect(setWorkModeMock).toHaveBeenCalledWith("right", "build");
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

// THE MACHINE-WIDE CAP LIVES HERE, on the shared path — not in the callers.
//
// This function reaches store.addAgent directly, and addAgent has no capacity check. Gating only
// the concierge's promote_plan_to_build left the four Plan-board handoffs ("Start", "Build It",
// "Build It (task)", the epic-row button) sailing past it — a cap enforced on some callers is not a
// cap (roborev 55135). These tests pin it at the one place every caller goes through.
describe("the machine-wide agent cap", () => {
  beforeEach(() => {
    // This describe is a SIBLING of the one above, so its beforeEach does not run here — without
    // these resets the "created nothing" assertions would see calls left by earlier tests.
    addAgentMock.mockReset();
    appendPromptMock.mockReset();
    setAgentEpicIdMock.mockReset();
    capacityMock.mockReturnValue({ atCapacity: false, used: 1, limit: 8, live: 1, basis: "test" });
  });

  it("refuses a handoff that would need a NEW agent, creating nothing", () => {
    projects = [{ id: "p1", agents: [] }];
    capacityMock.mockReturnValue({ atCapacity: true, used: 8, limit: 8, live: 3, basis: "CPU-bound" });

    expect(() => sendToBuild({ projectId: "p1", epicId: "e1", prdPath: null })).toThrow(
      AtCapacityError,
    );
    expect(addAgentMock).not.toHaveBeenCalled();
    expect(appendPromptMock).not.toHaveBeenCalled();
  });

  it("says how many of the taken slots are actually showing here, and why the ceiling is what it is", () => {
    projects = [{ id: "p1", agents: [] }];
    capacityMock.mockReturnValue({ atCapacity: true, used: 8, limit: 8, live: 3, basis: "CPU-bound" });

    try {
      sendToBuild({ projectId: "p1", epicId: "e1", prdPath: null });
      throw new Error("expected a refusal");
    } catch (e) {
      const msg = (e as Error).message;
      // The `live` clause exists because omitting it "sent a human looking for agents that would
      // start later when they were already running" (roborev 54225).
      expect(msg).toMatch(/3 of them showing in this window/);
      // …and the ceiling is never asserted as RAM when it isn't (roborev 54175).
      expect(msg).toMatch(/CPU-bound/);
    }
  });

  // Reusing the orchestrator already bound to this epic consumes no slot, so refusing it would
  // leave an at-capacity machine unable to resume work it had already started.
  it("still RESUMES an orchestrator already bound to the epic at capacity", () => {
    projects = [{ id: "p1", agents: [{ id: "a1", kind: "build", epicId: "e1" }] }];
    capacityMock.mockReturnValue({ atCapacity: true, used: 8, limit: 8, live: 8, basis: "test" });

    expect(sendToBuild({ projectId: "p1", epicId: "e1", prdPath: null })).toBe("a1");
    expect(addAgentMock).not.toHaveBeenCalled();
    // …and it is genuinely re-seeded, not merely selected.
    expect(appendPromptMock).toHaveBeenCalled();
  });
});

// The PREFLIGHT the board handoffs use before they claimBead. Every one of them marks the epic
// in_progress BEFORE handing off; claiming and then failing would leave it in progress with no
// orchestrator, and for a backlog card it also moves the card out of the column that renders the
// Start button — hiding the affordance the user just pressed (roborev 55139).
describe("sendToBuildBlockedReason (preflight)", () => {
  beforeEach(() => {
    capacityMock.mockReturnValue({ atCapacity: false, used: 1, limit: 8, live: 1, basis: "test" });
  });

  it("returns null when the handoff would proceed", () => {
    projects = [{ id: "p1", agents: [] }];
    expect(sendToBuildBlockedReason("p1", "e1")).toBeNull();
  });

  it("returns the SAME sentence the gate throws, so the two cannot disagree", () => {
    projects = [{ id: "p1", agents: [] }];
    capacityMock.mockReturnValue({ atCapacity: true, used: 8, limit: 8, live: 3, basis: "CPU-bound" });

    const reason = sendToBuildBlockedReason("p1", "e1");
    expect(reason).toBeTruthy();
    let thrown = "";
    try {
      sendToBuild({ projectId: "p1", epicId: "e1", prdPath: null });
    } catch (e) {
      thrown = (e as Error).message;
    }
    expect(reason).toBe(thrown);
  });

  // Resuming a bound orchestrator consumes no slot, so the preflight must not block it — otherwise
  // an at-capacity machine could not pick up work it had already started.
  it("does not block resuming an orchestrator already bound to the epic", () => {
    projects = [{ id: "p1", agents: [{ id: "a1", kind: "build", epicId: "e1" }] }];
    capacityMock.mockReturnValue({ atCapacity: true, used: 8, limit: 8, live: 8, basis: "test" });
    expect(sendToBuildBlockedReason("p1", "e1")).toBeNull();
  });

  // It is a PREFLIGHT, not a second policy: a caller that skips it is still refused by the gate.
  it("is advisory only — the gate still refuses a caller that ignores it", () => {
    projects = [{ id: "p1", agents: [] }];
    capacityMock.mockReturnValue({ atCapacity: true, used: 8, limit: 8, live: 8, basis: "test" });
    expect(() => sendToBuild({ projectId: "p1", epicId: "e1", prdPath: null })).toThrow(
      AtCapacityError,
    );
  });
});

// The lead clause must describe what was ACTUALLY asked for. "Build It" on a single task builds one
// bead on one worker branch — there is no plan in it — and the sentence is rendered verbatim in the
// overlay, so calling it a plan describes something the user did not ask for (roborev 55143).
describe("the refusal names the right thing", () => {
  beforeEach(() => {
    projects = [{ id: "p1", agents: [] }];
    capacityMock.mockReturnValue({ atCapacity: true, used: 8, limit: 8, live: 8, basis: "test" });
  });

  it("says PLAN for an epic handoff and TASK for a single-task one", () => {
    expect(sendToBuildBlockedReason("p1", "e1")).toMatch(/Starting this plan/);
    expect(sendToBuildBlockedReason("p1", "e1", "task")).toMatch(/Building this task/);
    expect(sendToBuildBlockedReason("p1", "e1", "task")).not.toMatch(/plan/i);
  });

  it("the thrown gate agrees with the preflight on both modes", () => {
    for (const mode of ["epic", "task"] as const) {
      const preflight = sendToBuildBlockedReason("p1", "e1", mode);
      let thrown = "";
      try {
        sendToBuild({ projectId: "p1", epicId: "e1", prdPath: null, mode });
      } catch (e) {
        thrown = (e as Error).message;
      }
      expect(thrown).toBe(preflight);
    }
  });
});
