// @vitest-environment jsdom
//
// jsdom, not node, for ONE reason: `attentionHold()` (engine/attentionGuard) reads the live caret,
// and without a document it can only ever answer "nothing is held" — which would make the
// attention-hold cases at the bottom of this file vacuous by construction. Everything else here is
// store-level and indifferent to the environment.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock the two stores so we can assert the exact store calls sendToBuild makes without spinning up
// real zustand state. beadsProtocol (from ./buildAgent) is left REAL so the seed prompt genuinely
// embeds the epic id the orchestrator will act on.
const addAgentMock = vi.fn();
const appendPromptMock = vi.fn();
const setAgentEpicIdMock = vi.fn();
const setAgentBeadIdMock = vi.fn();
const selectAgentMock = vi.fn();
const setAgentGoalMock = vi.fn();
const markAgentGoalFromEpicMock = vi.fn();
let projects: Array<{
  id: string;
  rootPath?: string;
  // `goal` and `epicGoals` are the two fields the epic-goal ladder reads. Typed loosely on purpose —
  // these fixtures assert on the STRING the handoff produces, not on the store's own shape.
  agents: Array<{
    id: string;
    kind: string;
    epicId?: string;
    /** `setAt` and `fromEpicGoalAt` are read by the re-sync rule (roborev 65868/65882). */
    goal?: { text: string; setAt?: number; fromEpicGoalAt?: number; verify?: unknown };
  }>;
  epicGoals?: Record<string, { text: string; setAt: number; source: string }>;
}> = [];

// `labelBead` is how an epic-mode handoff stamps the epic sweep's durable watch marker. Mocked at
// the module boundary so a test can assert the WRITE happened — the read side of that marker lives
// in `epicSweepRunner`, and asserting only there would leave the production write untested.
const labelBeadMock = vi.fn(async () => {});
vi.mock("./beads", async (orig) => ({
  ...(await orig<typeof import("./beads")>()),
  labelBead: (...a: unknown[]) => labelBeadMock(...(a as [])),
}));

vi.mock("../stores/projectStore", () => ({
  useProjectStore: {
    getState: () => ({
      projects,
      addAgent: addAgentMock,
      appendPrompt: appendPromptMock,
      setAgentEpicId: setAgentEpicIdMock,
      setAgentBeadId: setAgentBeadIdMock,
      setAgentGoal: setAgentGoalMock,
      markAgentGoalFromEpic: markAgentGoalFromEpicMock,
      selectAgent: selectAgentMock,
    }),
  },
}));

const openMock = vi.fn();
// `status` and `openAgentIds` are here because `sendToBuildAwaited`'s default `isLive` reads them
// through `processAliveFor`. Empty means "unobserved", which `mountAgentAwaited` treats as ALIVE —
// so every awaited case below passes `isLive` explicitly rather than relying on this.
let runtimeStatus: Record<string, unknown> = {};
let runtimeOpenIds: string[] = [];
vi.mock("../stores/runtimeStore", () => ({
  useRuntimeStore: {
    getState: () => ({ open: openMock, status: runtimeStatus, openAgentIds: runtimeOpenIds }),
  },
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

// The MOUNT primitives, mocked so the two routes are OBSERVABLE rather than assumed. The point of
// these assertions is that a machine-driven handoff RELAUNCHES something — asserting "we called a
// function named open" is what let a provable no-op ship twice.
const restartPaneMock = vi.fn((_id: string) => false);
// Route 2 now WAITS for Workspace to mount the pane it arranged, so the test controls whether one
// ever appears. `unmounted` is the honest default: these tests have no React render pass.
let paneStateValue = "unmounted";
vi.mock("./paneReadiness", async (orig) => ({
  ...(await orig<typeof import("./paneReadiness")>()),
  paneState: () => paneStateValue,
}));
const admitAgentMock = vi.fn();
vi.mock("./resurrectionAdmission", async (orig) => ({
  ...(await orig<typeof import("./resurrectionAdmission")>()),
  admitAgent: (id: string) => admitAgentMock(id),
}));

// THE AWAITED RESTART LEVER and THE DELIVERY CHANNEL — the two seams the machine path adds, both
// mocked so what actually happened is OBSERVABLE. These are not incidental: the whole reason
// `sendToBuildAwaited` exists is that the synchronous path reported a dispatch receipt and dropped
// the seed, and neither failure is visible unless the test can see these two calls.
const restartPaneAwaitedMock = vi.fn(async (_id: string) => "restarted" as string);
vi.mock("./paneControl", async (orig) => ({
  ...(await orig<typeof import("./paneControl")>()),
  restartPane: (id: string) => restartPaneMock(id),
  restartPaneAwaited: (id: string) => restartPaneAwaitedMock(id),
}));

const dispatchMock = vi.fn(async (_id: string, _text: string, _opts: unknown) => ({
  ok: true,
  path: "free-text",
  agentId: "a",
}));
vi.mock("./conciergeDispatch", async (orig) => ({
  ...(await orig<typeof import("./conciergeDispatch")>()),
  dispatchConciergeAnswer: (id: string, text: string, opts: unknown) => dispatchMock(id, text, opts),
}));

// THE DELEGATION LEDGER'S SEAM, mocked at `./history` rather than at `./dispatchLedger` so the row
// the tests at the bottom assert on is the one the REAL `formatDispatchText` produced — the text a
// recall query has to match is the whole point of the row, and stubbing the ledger would leave it
// untested. Nothing else in this file records history (`appendPrompt` is mocked), so this seam is
// exclusively the ledger's.
const recordHistoryMock = vi.fn(async (_e: unknown) => ({ inserted: true, collided: false }));
vi.mock("./history", () => ({
  recordHistory: (e: unknown) => recordHistoryMock(e),
}));

const capacityMock = vi.fn(() => ({ atCapacity: false, used: 1, limit: 8, live: 1, basis: "test" }));
vi.mock("./agentCapacity", async (orig) => ({
  ...(await orig<typeof import("./agentCapacity")>()),
  localAgentCapacity: () => capacityMock(),
}));

import {
  sendToBuild,
  sendToBuildAwaited,
  resumeInstruction,
  AtCapacityError,
  MountRefusedError,
  sendToBuildBlockedReason,
} from "./sendToBuild";
// LEFT REAL, deliberately. `briefForLaunch` is the exact function `AgentPane.prepare` calls to build
// the spawn's `initialPrompt`, so reading it here asserts the launch-side FACT rather than a mock of
// it. Mocking `./agentBrief` would reproduce the original bug's blind spot: the old suite asserted
// `appendPrompt` was called, which was true while every fresh orchestrator launched with no prompt.
import { briefForLaunch, briefRecord, hasUndeliveredBrief, resetAgentBriefs } from "./agentBrief";
// LEFT REAL, like `beadsProtocol` above it: the byte-identity cases below compose the expected seed
// from the same function production uses, so they pin what THIS module contributes without
// re-typing 30 lines of protocol prose that has its own byte-identity test in buildAgent.test.ts.
import { beadsProtocol } from "./buildAgent";
import { useBeadsStore } from "../stores/beadsStore";

describe("sendToBuild", () => {
  beforeEach(() => {
    addAgentMock.mockReset();
    appendPromptMock.mockReset();
    setAgentEpicIdMock.mockReset();
    setAgentBeadIdMock.mockReset();
    selectAgentMock.mockReset();
    openMock.mockReset();
    setActiveSpecialMock.mockReset();
    // WAS MISSING, and only a "must NOT have been called" assertion could reveal it: every other
    // case here asserts this spy WAS called, which a leaked call from the previous test satisfies
    // just as well as a real one. So the suite had a mock accumulating across all of its cases with
    // nothing able to notice.
    setWorkModeMock.mockReset();
    requestRevealAgentMock.mockReset();
    requestComposeFocusMock.mockReset();
    restartPaneMock.mockReset();
    restartPaneMock.mockReturnValue(false);
    admitAgentMock.mockReset();
    appendPromptMock.mockReturnValue("prompt-id");
    projects = [];
    labelBeadMock.mockClear();
    recordHistoryMock.mockClear();
  });

  // ── THE WATCH MARKER IS WRITTEN HERE, AND NOWHERE ELSE ON THE HANDOFF PATH ───────────────────
  // The epic sweep's watch gate reads a `promoted-to-build` label off the bead. Every test of that
  // gate hands it a bead with the label already on it, so without these two the production write
  // could be deleted outright and the whole suite would stay green — the vacuous shape this repo
  // treats as its top fleet-wide finding, and structurally the same "the production call site is
  // untested" gap that made the sweep inert in the first place.
  it("stamps the epic sweep's watch marker on an epic-mode handoff", () => {
    projects = [{ id: "proj1", rootPath: "/repo", agents: [] }];
    addAgentMock.mockReturnValue("build-new");

    sendToBuild({ projectId: "proj1", epicId: "epic-42", prdPath: "PRD/feature.md" });

    expect(labelBeadMock).toHaveBeenCalledWith("/repo", "add", "epic-42", "promoted-to-build");
  });

  it("does NOT stamp it for a single-task handoff", () => {
    // The paired negative, and it is a policy decision rather than an accident: "task" hands over
    // ONE bead to build on one worker, not a plan to be driven to completion. Stamping it would aim
    // the sweep at ordinary tasks.
    projects = [{ id: "proj1", rootPath: "/repo", agents: [] }];
    addAgentMock.mockReturnValue("build-new");

    sendToBuild({ projectId: "proj1", epicId: "task-9", prdPath: null, mode: "task" });

    expect(labelBeadMock).not.toHaveBeenCalled();
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

    // ── …AND NOT AT ALL FOR A HANDOFF NOBODY CLICKED ──────────────────────────────────────────
    // `landInAgent`'s own header says to call it ONLY for a hand-off the user actually asked for,
    // and names workerSpawn's `select: false` as the precedent. That held while every caller was a
    // click; `services/epicSweepRunner` now hands epics over on a TEN-MINUTE TIMER, and landing the
    // user in an agent from a timer yanks them off whatever they were reading with no gesture
    // behind it. Asserted on the REUSE path because that is the one the sweep always takes — the
    // watch gate guarantees a bound orchestrator already exists.
    it("does NOT take the view when reveal is false, on the path the sweep uses", () => {
      projects = [{ id: "proj1", agents: [{ id: "build1", kind: "build", epicId: "epic-7" }] }];

      sendToBuild({ projectId: "proj1", epicId: "epic-7", prdPath: null, reveal: false });

      expect(setActiveSpecialMock).not.toHaveBeenCalled();
      expect(setWorkModeMock).not.toHaveBeenCalled();
      expect(selectAgentMock).not.toHaveBeenCalled();
      expect(requestRevealAgentMock).not.toHaveBeenCalled();
    });

    // ── …BUT IT STILL MOUNTS, AND THAT IS THE WHOLE RECOVERY ──────────────────────────────────
    // REGRESSION. The first version of `reveal: false` skipped `landInAgent` WHOLESALE, and its
    // four steps are not all about the view: step 3 is `runtimeStore.open`, which mounts the pane
    // and drives the PTY launch. For a REUSED orchestrator whose process has died — the only case
    // the epic sweep ever hits, since its watch gate requires a bound agent — that mount IS the
    // recovery. Without it the sweep bound the epic, seeded a prompt, reported success and
    // relaunched nothing: the orchestrator stayed dead and the seed sat in a pane that was not
    // running. This is `resurrectionAdmission`'s "the whole side effect is letting the pane mount",
    // in another module.
    // ROUTE 1 — the state the epic sweep ACTUALLY reaches. A sweep can only conclude an agent is
    // dead from a `runtimeStore.status` entry, and only a MOUNTED pane writes one; so the pane is
    // still there, sitting on "Agent exited". `runtimeStore.open` is a provable NO-OP there (it
    // merges into `openAgentIds`, finds the set unchanged because nothing removes an id on a PTY
    // exit, and returns the same state). `restartPane` is the lever that works — the same one
    // "Start again" pulls. Asserting `open` was called is what let that no-op ship twice.
    it("RELAUNCHES via restartPane when the pane is still mounted (the swept state)", () => {
      projects = [{ id: "proj1", agents: [{ id: "build1", kind: "build", epicId: "epic-7" }] }];
      restartPaneMock.mockReturnValue(true);

      sendToBuild({ projectId: "proj1", epicId: "epic-7", prdPath: null, reveal: false });

      expect(restartPaneMock).toHaveBeenCalledWith("build1");
      // ...and route 2's writes are NOT made: a mounted pane has already cleared the visited gate,
      // and both writes are effectively permanent for the session.
      expect(admitAgentMock).not.toHaveBeenCalled();
      expect(openMock).not.toHaveBeenCalled();
    });

    // ROUTE 2 — no pane at all (the app-restart case). `restartPane` finds no registered lever, so
    // admission plus `open` are exactly right: together they are what makes Workspace mount a fresh
    // pane. BOTH, doing different jobs — admission unlocks the PROJECT's visited gate, `open` is the
    // AGENT's mount signal.
    it("falls back to admit + open when no pane exists", () => {
      projects = [{ id: "proj1", agents: [{ id: "build1", kind: "build", epicId: "epic-7" }] }];
      restartPaneMock.mockReturnValue(false);

      sendToBuild({ projectId: "proj1", epicId: "epic-7", prdPath: null, reveal: false });

      expect(admitAgentMock).toHaveBeenCalledWith("build1");
      expect(openMock).toHaveBeenCalledWith("build1");
    });

    // A REFUSED MOUNT THROWS rather than returning quietly, so no caller can report a relaunch that
    // did not happen. This is the shape that makes "reported success, relaunched nothing" — the
    // defect three separate review rounds each found a version of — unavailable.
    it("MOUNTS on the reveal:false path — the missing-row refusal was never reachable", () => {
      // ── WHAT CHANGED, AND WHY THE OLD TEST WAS THE PROBLEM ─────────────────────────────────
      // This case used to assert that `sendToBuild` THROWS `MountRefusedError` when no
      // `Project.agents` row names the id. That state cannot occur: the handoff either finds an
      // existing row or calls `addAgent`, which inserts one, so by the time the mount runs the row
      // is present by construction.
      //
      // The old test only produced it by MOCKING `addAgent` to return an id while leaving the fake
      // `projects` array untouched — a store that hands back an id it did not insert. So a guard
      // that could never fire in production looked covered, and three review rounds reasoned about
      // it as a live safety net. That is the shape the mutation-check caveat warns about: a test
      // with a perfect grip on behaviour nobody has.
      //
      // The refusal channel now covers the failures that DO occur (see `sendToBuildAwaited` below),
      // and this asserts what the sync path actually does: it mounts.
      projects = [{ id: "proj1", agents: [{ id: "build1", kind: "build", epicId: "epic-9" }] }];
      restartPaneMock.mockReturnValue(false); // no lever → route 2

      const id = sendToBuild({ projectId: "proj1", epicId: "epic-9", prdPath: null, reveal: false });

      expect(id).toBe("build1");
      // ROUTE 2's two writes, which together are what makes Workspace mount a pane. Asserting the
      // relaunch happened is the point — "we called something named open" is what let a provable
      // no-op ship twice.
      expect(admitAgentMock).toHaveBeenCalledWith("build1");
      expect(openMock).toHaveBeenCalledWith("build1");
      // …and the view was NOT taken, which is the other half of reveal:false.
      expect(setWorkModeMock).not.toHaveBeenCalled();
      expect(requestRevealAgentMock).not.toHaveBeenCalled();
    });

    // ...but the handoff still HAPPENS. `reveal` gates only the reveal — gating the binding or the
    // seed would turn a background restart into a no-op that reports success, which is worse than
    // stealing the view.
    it("still binds and seeds the orchestrator when reveal is false", () => {
      projects = [{ id: "proj1", agents: [{ id: "build1", kind: "build", epicId: "epic-7" }] }];

      const id = sendToBuild({ projectId: "proj1", epicId: "epic-7", prdPath: null, reveal: false });

      expect(id).toBe("build1");
      expect(setAgentEpicIdMock).toHaveBeenCalledWith("proj1", "build1", "epic-7");
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


// ══ THE MACHINE PATH ══════════════════════════════════════════════════════════════════════════
// `sendToBuildAwaited` is what the epic sweep calls. It differs from the click path in the only two
// ways that matter to a caller which spends a one-shot budget and then tells a human — and BOTH were
// live defects that a green suite was consistent with, because no test drove this seam at all.
describe("sendToBuildAwaited — the seed reaches the terminal on the RESUME path", () => {
  /** Every case declares the agent DEAD, because that is the state a sweep acts on — and because
   *  `mountAgentAwaited` deliberately treats an UNOBSERVED reading as alive (a wrong "dead" tears
   *  down a live PTY), so leaning on the default here would silently skip every restart. */
  const run = (args: Partial<Parameters<typeof sendToBuildAwaited>[0]> = {}, isLive = () => false) =>
    sendToBuildAwaited(
      { projectId: "p1", epicId: "e1", prdPath: null, reveal: false, ...args },
      { isLive },
    );

  beforeEach(() => {
    addAgentMock.mockReset();
    appendPromptMock.mockReset();
    appendPromptMock.mockReturnValue("prompt-id");
    setAgentEpicIdMock.mockReset();
    setAgentBeadIdMock.mockReset();
    openMock.mockReset();
    setWorkModeMock.mockReset();
    requestRevealAgentMock.mockReset();
    restartPaneMock.mockReset();
    restartPaneMock.mockReturnValue(false);
    restartPaneAwaitedMock.mockReset();
    restartPaneAwaitedMock.mockResolvedValue("restarted");
    admitAgentMock.mockReset();
    dispatchMock.mockReset();
    dispatchMock.mockResolvedValue({ ok: true, path: "free-text", agentId: "orch-1" });
    capacityMock.mockReturnValue({ atCapacity: false, used: 1, limit: 8, live: 1, basis: "test" });
    paneStateValue = "starting"; // a pane exists unless a case says otherwise
    // A REUSED orchestrator — the path a sweep always takes, because one agent is bound per epic and
    // the sweep only ever acts on an epic that already has one.
    projects = [{ id: "p1", agents: [{ id: "orch-1", kind: "build", epicId: "e1" }] }];
  });

  it("DELIVERS the instruction to the agent, not just into a draft box", async () => {
    // ── THE DEFECT THIS TEST EXISTS FOR ──────────────────────────────────────────────────────
    // A restart re-spawns a session that EXISTS, so the spawn resumes — and on a resume
    // `briefForLaunch` returns undefined BY DESIGN, so the appended draft is never read. The old
    // path therefore restarted a dead orchestrator, told it NOTHING, and reported success; the epic
    // sat exactly as before, which is the whole reason the feature was inert.
    //
    // ASSERTED ON THE SIDE EFFECT — text reaching the DISPATCH channel — rather than on
    // `appendPrompt` having been called. That distinction IS the finding: `appendPrompt` was called
    // in the broken version too, so a test asserting it would have passed against the bug.
    await run({ prdPath: "PRD/x.md" });

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const [agentId, text] = dispatchMock.mock.calls[0] as unknown as [string, string, unknown];
    expect(agentId).toBe("orch-1");
    expect(text).toContain("e1");
    expect(text).toContain("PRD/x.md");
  });

  it("names its OWN authority, so the audit line does not blame a goal continuation", async () => {
    await run();
    const opts = (dispatchMock.mock.calls[0] as unknown as [string, string, { authority: unknown }])[2];
    expect(opts.authority).toEqual({ kind: "epic-restart", agentId: "orch-1", epicId: "e1" });
  });

  it("WAITS for the pane, and refuses when the restart did not actually take", async () => {
    // `restartPane`'s boolean is a DISPATCH RECEIPT — measured on v0.107.0, three agents acked
    // `{ok:true}` and were all still errored on the next status read. A caller that reports to a
    // human must use the awaited verdict, and must not deliver into an agent that never came back.
    for (const verdict of ["spawn-failed", "no-claude", "timed-out", "nothing-to-restart"]) {
      dispatchMock.mockClear();
      restartPaneAwaitedMock.mockResolvedValue(verdict);
      await expect(run()).rejects.toBeInstanceOf(MountRefusedError);
      expect(dispatchMock).not.toHaveBeenCalled();
    }
  });

  it("refuses when the agent came back but the instruction did not arrive", async () => {
    // A relaunch with an undelivered instruction is the SAME inert state as no relaunch at all, so
    // it must not be reported as a handoff. The sweep turns this into `spawn-failed` and stays quiet
    // rather than telling the founder it handed the epic back.
    dispatchMock.mockResolvedValue({ ok: false, path: "queue-full", agentId: "orch-1" });
    await expect(run()).rejects.toBeInstanceOf(MountRefusedError);
  });

  it("treats an `ok` result on a NON-DELIVERING path as undelivered", async () => {
    // ── THE HOLE A MUTATION CHECK FOUND ──────────────────────────────────────────────────────
    // Every other case here pairs `ok: true` with a delivering path and `ok: false` with a refusing
    // one, so the path check was doing no work that `r.ok` was not already doing: inverting BOTH
    // comparisons (making `delivered` equal `r.ok`) left the whole suite green.
    //
    // These are the results that break that correlation — the dispatcher reports success for a
    // write that is not this instruction arriving:
    //   • `picker-option` matched a live prompt, so the text was consumed as a MENU KEYSTROKE. The
    //     agent pressed a button; it never read an instruction.
    //   • `cloud-agent` routed an ANSWER to an on-screen prompt rather than a prompt to the agent.
    // Reporting either as a handoff is the same false success the awaited path exists to remove.
    for (const path of ["picker-option", "cloud-agent"]) {
      dispatchMock.mockResolvedValue({ ok: true, path, agentId: "orch-1" });
      await expect(run()).rejects.toBeInstanceOf(MountRefusedError);
    }
  });

  it("accepts a QUEUED send — the PTY it just restarted is legitimately still coming up", async () => {
    // Deliberately divergent from `goalContinuationRunner`, which refuses `queued`. That caller
    // fires against an agent already meant to be running and retries in under a minute; this one
    // has just restarted the PTY and spends a ONE-SHOT budget, so a false failure costs the epic its
    // only automatic restart and tells the founder nothing.
    dispatchMock.mockResolvedValue({ ok: true, path: "queued", agentId: "orch-1" });
    await expect(run()).resolves.toMatchObject({ agentId: "orch-1" });
  });

  // ── THE PRODUCTION SEAM, DRIVEN ─────────────────────────────────────────────────────────────
  // Every case above injects `isLive`, so the DEFAULT — processAliveFor against the real store —
  // ran in no test. That gap hid a live bug: a brand-new id has no `runtimeStore.status` entry, so
  // the default returns `undefined` (UNOBSERVED), `mountAgentAwaited` correctly reads unobserved as
  // alive, and the two correct rules composed into "the fresh agent is already live" — never
  // admitted, never opened, never spawned, and reported as a SUCCESS. The old test passed only
  // because it injected `() => false`, a reading production cannot produce for a new id.
  it("SPAWNS a fresh orchestrator under the real liveness seam, not just an injected one", async () => {
    projects = [{ id: "p1", agents: [] }];
    addAgentMock.mockReturnValue("orch-new");
    restartPaneAwaitedMock.mockResolvedValue("no-pane"); // no pane → route 2
    runtimeStatus = {}; // exactly production's state for an id addAgent just minted
    runtimeOpenIds = [];
    paneStateValue = "starting"; // Workspace mounts it

    // isLive DELIBERATELY NOT INJECTED — that is the seam under test.
    const r = await sendToBuildAwaited({
      projectId: "p1",
      epicId: "e1",
      prdPath: null,
      reveal: false,
    });

    expect(r.agentId).toBe("orch-new");
    // The two writes that make Workspace mount a pane. Without the fix these never happened and the
    // call still resolved — a handoff that started nothing.
    expect(admitAgentMock).toHaveBeenCalledWith("orch-new");
    expect(openMock).toHaveBeenCalledWith("orch-new");
    expect(r.verdict).toBe("opened");
  });

  it("does NOT dispatch for a FRESH orchestrator — its spawn carries the brief", async () => {
    // The other half of the rule. A brand-new agent has no session to resume, so `briefForLaunch`
    // picks the appended draft up and carries it into the spawn. Dispatching on top of that would
    // deliver the mission twice.
    projects = [{ id: "p1", agents: [] }];
    addAgentMock.mockReturnValue("orch-new");
    restartPaneAwaitedMock.mockResolvedValue("no-pane"); // no pane → route 2

    await run();

    expect(appendPromptMock).toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("does NOT tear down an orchestrator that came back while the sweep was writing to bd", async () => {
    // The stamp before this call is an awaited `bd label` against a single-writer store shared by
    // every worktree, so it can queue for tens of seconds. An orchestrator that recovered inside
    // that window is ALIVE and possibly mid-turn; pulling the restart lever would destroy real work
    // to "recover" an agent that had already recovered.
    await run({}, () => true);

    expect(restartPaneAwaitedMock).not.toHaveBeenCalled();
    // …and it is still a real handoff: the agent is up and idle on a stalled epic, which is exactly
    // when telling it to resume is the entire point.
    expect(dispatchMock).toHaveBeenCalledTimes(1);
  });

  it("treats an UNOBSERVED agent as alive rather than restarting it on no evidence", async () => {
    // `undefined` means nobody took a reading — an agent the user closed reads that way. Restarting
    // on it would tear down a PTY on the strength of a measurement that was never made. Same
    // polarity as the sweep's own `alive(id) !== false` gate, which is why `isLive` is injected: two
    // copies answering differently is the failure this shares one predicate to avoid.
    await run({}, () => undefined as unknown as boolean);
    expect(restartPaneAwaitedMock).not.toHaveBeenCalled();
  });
});

describe("resumeInstruction", () => {
  it("points at the PRD by path when there is one", () => {
    const t = resumeInstruction({ projectId: "p", epicId: "sparkle-e1", prdPath: "PRD/plan.md" });
    expect(t).toContain("PRD/plan.md");
    expect(t).toContain("sparkle-e1");
  });

  it("falls back to `bd show` for a PRD-less epic rather than naming a file that does not exist", () => {
    const t = resumeInstruction({ projectId: "p", epicId: "sparkle-e1", prdPath: null });
    expect(t).toContain("bd show sparkle-e1");
    expect(t).not.toContain("PRD/");
  });

  it("stays TERSE — it must not re-send the whole build seed", () => {
    // The agent is resuming its OWN conversation, which already holds the epic, the PRD and the
    // beads protocol from its first brief. Re-sending `buildSeedPrompt` would spend thousands of
    // tokens restating context a few turns up. Pinned by length so a well-meaning expansion back
    // into the full protocol fails here rather than silently costing that on every restart.
    const t = resumeInstruction({ projectId: "p", epicId: "sparkle-e1", prdPath: "PRD/plan.md" });
    expect(t.length).toBeLessThan(700);
    expect(t).not.toContain("beads protocol");
  });
});

// ── ROUTE 2 + REUSE: the branch that had no test at all ─────────────────────────────────────────
describe("sendToBuildAwaited — a reused orchestrator with no pane in this window", () => {
  // The app-restart case: the agent row and its Claude session both exist, but this window has never
  // mounted a pane for it. `reused` is true, so the instruction MUST be delivered — and route 2 only
  // ARRANGES the mount, so nothing can be written until Workspace has actually rendered one.
  const run = () =>
    sendToBuildAwaited(
      { projectId: "p1", epicId: "e1", prdPath: null, reveal: false },
      { isLive: () => false, readyTimeoutMs: 300, pollMs: 10 },
    );

  beforeEach(() => {
    addAgentMock.mockReset();
    appendPromptMock.mockReset();
    appendPromptMock.mockReturnValue("prompt-id");
    setAgentEpicIdMock.mockReset();
    setAgentBeadIdMock.mockReset();
    openMock.mockReset();
    admitAgentMock.mockReset();
    restartPaneAwaitedMock.mockReset();
    restartPaneAwaitedMock.mockResolvedValue("no-pane"); // route 2
    dispatchMock.mockReset();
    dispatchMock.mockResolvedValue({ ok: true, path: "queued", agentId: "orch-1" });
    capacityMock.mockReturnValue({ atCapacity: false, used: 1, limit: 8, live: 1, basis: "test" });
    projects = [{ id: "p1", agents: [{ id: "orch-1", kind: "build", epicId: "e1" }] }];
  });

  it("waits for the pane to REGISTER before writing to it", async () => {
    // Dispatching into an `unmounted` pane does not queue — `conciergeDispatch` holds only on
    // `paneState === "starting"`, so an absent pane is refused outright as `pty-gone`. The epic
    // would lose its one-shot budget to a delivery that was never attemptable.
    paneStateValue = "unmounted";
    setTimeout(() => {
      paneStateValue = "starting";
    }, 50);

    const r = await run();

    expect(r.verdict).toBe("opened");
    expect(dispatchMock).toHaveBeenCalledTimes(1);
  });

  it("REFUSES rather than reporting a mount when the pane never appears", async () => {
    // Fails closed: a pane that never registers is a mount that never happened, and must not be
    // reported as one. Nothing is written to an agent that does not exist.
    paneStateValue = "unmounted";
    await expect(run()).rejects.toBeInstanceOf(MountRefusedError);
    expect(dispatchMock).not.toHaveBeenCalled();
  });
});

// ══ "DON'T TAKE ME OUT OF MY TERMINAL" ═══════════════════════════════════════════════════════════
//
// A board hand-off is a click, so it has earned the view — but not at the cost of yanking the
// founder out of a terminal he is typing in. This resolves to the SAME branch `reveal: false`
// already uses (relaunch, don't move him) rather than to a second, subtly-different quiet path.
//
// Both directions, because the hold assertions are all about something NOT happening, and "the
// guard held" is indistinguishable from "landInAgent was deleted" if you only ever assert absence.
describe("sendToBuild — the founder's caret is in a terminal", () => {
  beforeEach(() => {
    projects = [];
    selectAgentMock.mockReset();
    setActiveSpecialMock.mockReset();
    setWorkModeMock.mockReset();
    requestRevealAgentMock.mockReset();
    restartPaneMock.mockReset();
    restartPaneMock.mockReturnValue(true);
    admitAgentMock.mockReset();
    openMock.mockReset();
    appendPromptMock.mockReset();
    appendPromptMock.mockReturnValue("prompt-id");
    labelBeadMock.mockClear();
    document.body.innerHTML = "";
  });

  function focusATerminal(): void {
    const host = document.createElement("div");
    host.setAttribute("data-terminal-surface", "");
    host.innerHTML = `<textarea class="xterm-helper-textarea"></textarea>`;
    document.body.appendChild(host);
    host.querySelector<HTMLTextAreaElement>("textarea")!.focus();
  }

  it("does NOT take the view, and STILL relaunches the orchestrator", () => {
    projects = [{ id: "proj1", agents: [{ id: "build1", kind: "build", epicId: "epic-7" }] }];
    focusATerminal();

    sendToBuild({ projectId: "proj1", epicId: "epic-7", prdPath: null, attention: "auto" });

    // Nothing he can see moved…
    expect(selectAgentMock).not.toHaveBeenCalled();
    expect(setActiveSpecialMock).not.toHaveBeenCalled();
    expect(setWorkModeMock).not.toHaveBeenCalled();
    expect(requestRevealAgentMock).not.toHaveBeenCalled();
    // …and the hand-off still DID its work. This is the assertion that separates "held" from
    // "broken": a quiet hand-off that skipped the relaunch would bind the epic, seed a prompt,
    // report success and leave the orchestrator dead.
    expect(restartPaneMock).toHaveBeenCalledWith("build1");
    expect(appendPromptMock).toHaveBeenCalled();
  });

  it("PAIRED: with the caret nowhere, the hand-off takes the view exactly as before", () => {
    projects = [{ id: "proj1", agents: [{ id: "build1", kind: "build", epicId: "epic-7" }] }];

    sendToBuild({ projectId: "proj1", epicId: "epic-7", prdPath: null, attention: "auto" });

    expect(selectAgentMock).toHaveBeenCalledWith("proj1", "build1");
    expect(requestRevealAgentMock).toHaveBeenCalledWith("build1");
  });

  // ══ A BOARD CLICK IS NEVER DECLINED ═══════════════════════════════════════════════════════════
  // Three of this function's four callers are button handlers (BoardView, and both paths in
  // useBeadBuildActions). Declining one reinstates the exact regression `landInAgent` was written
  // to fix: "Build It" pressed, board still up, nothing visibly changed. `buildOne` makes it worse,
  // because it `await`s `claimBead` first — so the caret would be sampled at an arbitrary later
  // instant than the gesture, against a single-writer store shared by every worktree.
  it("takes the view for a CLICK even with a terminal focused (no `attention` declared)", () => {
    projects = [{ id: "proj1", agents: [{ id: "build1", kind: "build", epicId: "epic-7" }] }];
    focusATerminal();

    sendToBuild({ projectId: "proj1", epicId: "epic-7", prdPath: null });

    expect(selectAgentMock).toHaveBeenCalledWith("proj1", "build1");
    expect(requestRevealAgentMock).toHaveBeenCalledWith("build1");
  });

  it('is likewise never declined for an explicit `attention: "user"`', () => {
    projects = [{ id: "proj1", agents: [{ id: "build1", kind: "build", epicId: "epic-7" }] }];
    focusATerminal();

    sendToBuild({ projectId: "proj1", epicId: "epic-7", prdPath: null, attention: "user" });

    expect(selectAgentMock).toHaveBeenCalledWith("proj1", "build1");
  });
});

// ══ THE BRIEF ACTUALLY REACHES THE LAUNCH ═══════════════════════════════════════════════════════
//
// THE DEFECT THESE EXIST FOR. `seedDraft` called `appendPrompt` and nothing else, on the documented
// theory that "`briefForLaunch` picks the draft up and the spawn carries it into the session".
// `briefForLaunch` reads `agentBrief`'s `held` map, which only `attachBrief` writes — and no
// `sendToBuild*` path ever called it. So `AgentPane.tsx`'s `briefForLaunch(agent.id, resume)`
// returned `undefined` on the FRESH path too, `initialPrompt` was omitted, and claude was exec'd with
// an EMPTY PROMPT. Twelve orchestrators started by `epicSweepRunner` sat briefless; six epics burned
// their one-shot restart budget on one.
//
// WHY THE OLD SUITE MISSED IT, and what that dictates about these assertions: the existing
// fresh-path case asserts `expect(appendPromptMock).toHaveBeenCalled()`. That was true throughout the
// bug — it is the PRECONDITION (a store write), not the SIDE EFFECT (a launch that can read it). So
// every assertion below reads `briefForLaunch`, the function the pane actually calls. Delete the
// `attachBrief` line from `seedDraft` and each of these goes red; delete the `appendPrompt` line and
// none of them do, which is the right polarity for a test guarding DELIVERY.
describe("sendToBuild — the seed is DELIVERABLE as the launch's positional prompt", () => {
  beforeEach(() => {
    addAgentMock.mockReset();
    appendPromptMock.mockReset();
    appendPromptMock.mockReturnValue("prompt-id");
    setAgentEpicIdMock.mockReset();
    setAgentBeadIdMock.mockReset();
    selectAgentMock.mockReset();
    openMock.mockReset();
    setActiveSpecialMock.mockReset();
    setWorkModeMock.mockReset();
    requestRevealAgentMock.mockReset();
    requestComposeFocusMock.mockReset();
    restartPaneMock.mockReset();
    restartPaneMock.mockReturnValue(false);
    restartPaneAwaitedMock.mockReset();
    restartPaneAwaitedMock.mockResolvedValue("restarted");
    admitAgentMock.mockReset();
    dispatchMock.mockReset();
    dispatchMock.mockResolvedValue({ ok: true, path: "free-text", agentId: "orch-1" });
    capacityMock.mockReturnValue({ atCapacity: false, used: 1, limit: 8, live: 1, basis: "test" });
    paneStateValue = "starting";
    projects = [];
    labelBeadMock.mockClear();
    // Module-level state in the REAL agentBrief — without this a held brief leaks into the next case
    // and a later assertion passes on the previous test's attachment.
    resetAgentBriefs();
  });

  it("CLICK PATH: briefForLaunch returns the seed, so the spawn can carry it as argv", () => {
    projects = [{ id: "proj1", rootPath: "/repo", agents: [] }];
    addAgentMock.mockReturnValue("build-new");

    sendToBuild({ projectId: "proj1", epicId: "epic-42", prdPath: "PRD/feature.md" });

    // `false` is production's value for a brand-new orchestrator: `AgentPane.prepare` sets
    // `resume = info.hasSession` from a real session probe on the worktree, and a just-minted agent
    // has no session to resume.
    const brief = briefForLaunch("build-new", false);
    expect(brief).toBeDefined();
    expect(brief).toContain("epic-42");
    expect(brief).toContain("PRD/feature.md");
  });

  it("the DELIVERED brief and the composer bookkeeping are the same text", () => {
    // Cross-checks the two halves against each other rather than pinning the seed's prose. The store
    // write was never the problem — it always happened — so this fails only if the delivery half is
    // missing or drifts to a different string.
    projects = [{ id: "proj1", rootPath: "/repo", agents: [] }];
    addAgentMock.mockReturnValue("build-new");

    sendToBuild({ projectId: "proj1", epicId: "epic-42", prdPath: "PRD/feature.md" });

    const [, , seededText] = appendPromptMock.mock.calls[0] as unknown as [string, string, string];
    expect(briefForLaunch("build-new", false)).toBe(seededText);
  });

  it("attaches BEFORE the mount, so the launch it triggers cannot outrun the brief", () => {
    // `AgentPane.prepare` reads the brief during the mount. Attaching afterwards was safe only
    // because React cannot render inside a synchronous function — a real property today, and an
    // invisible one to change. Asserted at the mount seam so the ordering is pinned by construction.
    projects = [{ id: "proj1", rootPath: "/repo", agents: [] }];
    addAgentMock.mockReturnValue("build-new");
    let heldAtOpen: boolean | undefined;
    openMock.mockImplementation(() => {
      heldAtOpen = hasUndeliveredBrief("build-new");
    });

    sendToBuild({ projectId: "proj1", epicId: "epic-42", prdPath: null });

    expect(openMock).toHaveBeenCalled(); // the seam really ran; otherwise the next line is vacuous
    expect(heldAtOpen).toBe(true);
  });

  it("SWEEP PATH: a fresh orchestrator's brief is readable by its launch", async () => {
    // The machine path, and the one that burned six epics. `epicSweepRunner` calls this.
    projects = [{ id: "p1", agents: [] }];
    addAgentMock.mockReturnValue("orch-new");
    restartPaneAwaitedMock.mockResolvedValue("no-pane");
    runtimeStatus = {};
    runtimeOpenIds = [];

    const r = await sendToBuildAwaited({
      projectId: "p1",
      epicId: "sparkle-qogah",
      prdPath: "PRD/sweep.md",
      reveal: false,
    });

    expect(r.agentId).toBe("orch-new");
    const brief = briefForLaunch("orch-new", false);
    expect(brief).toBeDefined();
    expect(brief).toContain("sparkle-qogah");
    // The sweep does NOT dispatch on this branch (the spawn is meant to carry the mission), so if
    // the brief is not launch-readable the agent is told nothing at all — which is exactly what
    // happened. Pinned alongside, so a "fix" that merely started dispatching here still fails.
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("carries humanAuthored:false with the brief, so delivery cannot release goal debt", async () => {
    // ── THE GUARD THIS RESTORES ──────────────────────────────────────────────────────────────
    // epicSweepRunner and conciergeTools/plans pass humanAuthored:false precisely so a MACHINE
    // handoff cannot un-latch an escalation nothing spent. seedDraft honoured it for its own
    // appendPrompt — but the brief it attaches is delivered by AgentPane, which passed no flag and
    // so re-recorded the same mission as a HUMAN send, running releaseGoalDebt on a reused
    // orchestrator that really does carry goalDebt/escalatedAt. AgentPane's own comment named this
    // as the moment its default stopped being safe. The flag now rides the brief.
    projects = [{ id: "proj1", rootPath: "/repo", agents: [] }];
    addAgentMock.mockReturnValue("build-new");

    sendToBuild({ projectId: "proj1", epicId: "epic-42", prdPath: null, humanAuthored: false });

    expect(briefRecord("build-new")?.humanAuthored).toBe(false);
  });

  it("carries humanAuthored:true for a human click, so a real send still releases debt", async () => {
    // The paired positive — without it the fix could hard-code false and the case above would pass
    // while every board click stopped clearing its own goal debt.
    projects = [{ id: "proj1", rootPath: "/repo", agents: [] }];
    addAgentMock.mockReturnValue("build-new");

    sendToBuild({ projectId: "proj1", epicId: "epic-42", prdPath: null });

    expect(briefRecord("build-new")?.humanAuthored).toBe(true);
  });

  it("carries the promptId it just wrote, so delivery marks that row instead of appending another", async () => {
    projects = [{ id: "proj1", rootPath: "/repo", agents: [] }];
    addAgentMock.mockReturnValue("build-new");
    appendPromptMock.mockReturnValue("prompt-42");

    sendToBuild({ projectId: "proj1", epicId: "epic-42", prdPath: null });

    expect(appendPromptMock).toHaveBeenCalledTimes(1);
    expect(briefRecord("build-new")?.promptId).toBe("prompt-42");
  });

  it("RESUME PATH: attaching does not double-deliver on top of the resume instruction", async () => {
    // The safety half of attaching unconditionally. `briefForLaunch` returns undefined for
    // `resume: true` BEFORE it consults the held map, so a resuming agent cannot emit this as argv —
    // which is what keeps it from arriving twice alongside the dispatched `resumeInstruction`.
    projects = [{ id: "p1", agents: [{ id: "orch-1", kind: "build", epicId: "e1" }] }];

    await sendToBuildAwaited(
      { projectId: "p1", epicId: "e1", prdPath: null, reveal: false },
      { isLive: () => false },
    );

    expect(dispatchMock).toHaveBeenCalledTimes(1); // the resume instruction went out...
    expect(briefForLaunch("orch-1", true)).toBeUndefined(); // ...and the argv brief did not.
    // Held rather than dropped: a LATER fresh launch of this agent (session gone, "Start again")
    // then comes up with its mission instead of blank.
    expect(hasUndeliveredBrief("orch-1")).toBe(true);
  });
});

// ══ THE LADDER (bead sparkle-wab4lm) ═══════════════════════════════════════════════════════════
//
// The founder's requirement, in his words: "when build agents are dispatched specific tasks that
// have been created against that epic, those agents have the right flavor of that goal for the
// piece that they are working on."
//
// The narrowing itself is ALREADY done by a model with full context on the slice — `spawn_worker`
// requires a `goal` and `validateWorkerGoal` refuses the spawn without one. The only thing missing
// was that that model had never been told what the epic is FOR. So this is a prompt change, not a
// dispatch-time model call, and every assertion below is on the PRODUCED STRING: asserting that a
// goal was looked up would pass just as well for a handoff that looked it up and said nothing.
//
// EVERY EARLIER GATE IS SEEDED. `prepareHandoff` throws at an unknown project and at capacity long
// before it reaches the goal, so the absence cases below would pass for reasons unrelated to the
// rule if either were left to chance — the trap AGENTS.md names first. Each absence case is paired
// with a presence case on the identical setup.
describe("sendToBuild — epic goal laddering", () => {
  const EPIC_GOAL = "Every agent dispatched under an epic carries a slice of that epic's goal";
  const goalRecord = (text: string, over: Record<string, unknown> = {}) => ({
    text,
    setAt: 1,
    source: "human",
    ...over,
  });

  beforeEach(() => {
    addAgentMock.mockReset();
    appendPromptMock.mockReset();
    appendPromptMock.mockReturnValue("prompt-id");
    setAgentEpicIdMock.mockReset();
    setAgentBeadIdMock.mockReset();
    setAgentGoalMock.mockReset();
    markAgentGoalFromEpicMock.mockReset();
    labelBeadMock.mockClear();
    capacityMock.mockReturnValue({ atCapacity: false, used: 1, limit: 8, live: 1, basis: "test" });
    useBeadsStore.setState({ byProject: {} });
    projects = [];
    resetAgentBriefs();
  });

  afterEach(() => {
    // Module-scoped, like every other store here: a snapshot left behind would silently change what
    // a later suite's task-mode handoff resolves as its parent epic.
    useBeadsStore.setState({ byProject: {} });
  });

  const seed = () => appendPromptMock.mock.calls[0]![2] as string;

  it("EPIC MODE: states the epic's goal and the laddering rule", () => {
    projects = [
      { id: "proj1", rootPath: "/repo", agents: [], epicGoals: { "epic-42": goalRecord(EPIC_GOAL) } },
    ];
    addAgentMock.mockReturnValue("build-new");

    sendToBuild({ projectId: "proj1", epicId: "epic-42", prdPath: "PRD/feature.md" });

    // The goal VERBATIM — the founder's standing constraint is that his wording is never reworded
    // under him, and a paraphrase in the one place the orchestrator reads it is exactly that.
    expect(seed()).toContain(EPIC_GOAL);
    // …and the instruction that makes it a LADDER rather than a quote. Both halves, because the
    // quote alone is a decoration and the rule alone has no parent to narrow from.
    expect(seed()).toMatch(/NARROWED SLICE/);
    expect(seed()).toMatch(/spawn_worker/);
    expect(seed()).toMatch(/never a restatement of that\s+sentence/);
  });

  it("EPIC MODE, NO GOAL: the seed is byte-identical to what it produced before this feature", () => {
    // THE REGRESSION GUARD. Most epics have no goal, so this is the COMMON path — a feature that
    // silently reworded every brief already in flight would be a regression wearing a feature's
    // clothes. Compared against the literal, not against a `not.toContain`: a stray blank line or a
    // reordered clause breaks byte equality and breaks no phrase assertion.
    projects = [{ id: "proj1", rootPath: "/repo", agents: [] }];
    addAgentMock.mockReturnValue("build-new");

    sendToBuild({ projectId: "proj1", epicId: "epic-42", prdPath: "PRD/feature.md" });

    expect(seed()).toBe(
      [
        "Build epic epic-42.",
        "",
        "First, read the PRD at PRD/feature.md to understand the goal, constraints, and acceptance",
        "criteria. Then execute the epic's child tasks: decompose them across isolated worker agents,",
        "integrating each worker's branch into your build branch sequentially.",
        "",
        "Follow the beads protocol below to keep the work graph in sync as you go:",
        "",
        beadsProtocol({ epicId: "epic-42" }),
      ].join("\n"),
    );
  });

  it("TASK MODE: states the PARENT epic's goal, resolved through parentEpicOf", () => {
    // `args.epicId` names a TASK here (the field is misnamed on the args type), so the objective has
    // to be resolved UP the membership edge. `task-1` carries an explicit `parent`, which is the
    // edge `beads.parentEpicOf` reads from the child side.
    projects = [
      { id: "proj1", rootPath: "/repo", agents: [], epicGoals: { "epic-1": goalRecord(EPIC_GOAL) } },
    ];
    addAgentMock.mockReturnValue("build-new");
    useBeadsStore.setState({
      byProject: {
        proj1: {
          beads: [
            { id: "epic-1", title: "E", description: "", status: "open", type: "epic", labels: [] },
            { id: "task-1", title: "T", description: "", status: "open", parent: "epic-1", labels: [] },
          ] as never,
          board: null as never,
          loadedAt: 1,
        },
      },
    });

    sendToBuild({ projectId: "proj1", epicId: "task-1", prdPath: null, mode: "task" });

    expect(seed()).toContain(EPIC_GOAL);
    expect(seed()).toContain("THIS TASK LADDERS UP TO EPIC epic-1");
    expect(seed()).toMatch(/NARROWED SLICE/);
    // The goal on the epic reaches the prompt; the TASK id must not be labelled an epic goal, which
    // is why the beads-protocol addendum below it is left un-goaled in this mode.
    expect(seed()).not.toContain("The goal of epic task-1");
  });

  it("TASK MODE whose parent epic has NO goal: byte-identical to today's task prompt", () => {
    // The paired absence, on the SAME bead graph as the case above — only the epic's goal is gone.
    // So a failure here can only mean the rule fired with no parent objective, not that some
    // earlier gate swallowed the handoff.
    projects = [{ id: "proj1", rootPath: "/repo", agents: [] }];
    addAgentMock.mockReturnValue("build-new");
    useBeadsStore.setState({
      byProject: {
        proj1: {
          beads: [
            { id: "epic-1", title: "E", description: "", status: "open", type: "epic", labels: [] },
            { id: "task-1", title: "T", description: "", status: "open", parent: "epic-1", labels: [] },
          ] as never,
          board: null as never,
          loadedAt: 1,
        },
      },
    });

    sendToBuild({ projectId: "proj1", epicId: "task-1", prdPath: null, mode: "task" });

    expect(seed()).toBe(
      [
        "Build bead task-1 (a single task).",
        "",
        "Run `bd show task-1` to read it, then implement it on ONE isolated worker",
        "branch, verify it, and integrate that branch. Do not fan out into children — this is a single",
        "unit of work, not an epic.",
        "",
        "Follow the beads protocol below to keep the work graph in sync as you go:",
        "",
        beadsProtocol({ epicId: "task-1" }),
      ].join("\n"),
    );
  });

  it("TASK MODE with no board snapshot yet: degrades to today's prompt rather than guessing", () => {
    // The beads store is polled, so a handoff can land before the first successful read. An empty
    // snapshot must read as "no parent epic", never as an error and never as a stale one.
    projects = [
      { id: "proj1", rootPath: "/repo", agents: [], epicGoals: { "epic-1": goalRecord(EPIC_GOAL) } },
    ];
    addAgentMock.mockReturnValue("build-new");

    sendToBuild({ projectId: "proj1", epicId: "task-1", prdPath: null, mode: "task" });

    expect(seed()).not.toContain(EPIC_GOAL);
    expect(seed()).not.toMatch(/NARROWED SLICE/);
  });

  // ── THE ORCHESTRATOR'S OWN GOAL ─────────────────────────────────────────────────────────────
  it("sets the orchestrator's own goal to the epic goal, as the AGENT actor", () => {
    projects = [
      { id: "proj1", rootPath: "/repo", agents: [], epicGoals: { "epic-42": goalRecord(EPIC_GOAL) } },
    ];
    addAgentMock.mockReturnValue("build-new");

    sendToBuild({ projectId: "proj1", epicId: "epic-42", prdPath: null });

    // `"agent"`, NOT the `"human"` default. Every route into this function is machine-driven (a
    // click handler, the concierge's tool layer, the epic sweep's timer), and `setAgentGoal`'s own
    // docstring says `"human"` releases stashed goal debt — which would let a handoff launder an
    // escalation and refill the retry budget.
    // The sixth argument is the CHECK, and it is not optional here (roborev 65868). Passing none
    // left the copy self-markable — `canSelfMarkMet(undefined)` is true — so an orchestrator could
    // declare the EPIC's objective achieved on its own word and stop being auto-continued. An epic
    // goal that states no check still falls back to `human` rather than to nothing: an epic
    // objective is not one agent's to close, written down or not.
    // The sixth argument is the CHECK, and it is `undefined` when the epic goal states none
    // (roborev 65882). Manufacturing `{kind:"human"}` here was WORSE than dropping it: `newGoal`
    // records any verify it is handed as `verifyStated: true`, so a check nobody chose became
    // caller-chosen and BINDING — re-creating sparkle-vfkqz (sticky, undischargeable, escalates
    // forever) and firing `agentStall`'s red `human-verified-goal` cause for a sign-off nobody
    // asked for. Whether the EPIC is achieved is answered by the bead-counted rollup, which no
    // agent's claim can move, so a self-markable orchestrator goal is not a hole.
    expect(setAgentGoalMock).toHaveBeenCalledWith(
      "proj1",
      "build-new",
      EPIC_GOAL,
      undefined,
      "agent",
    );
  });

  it("NEVER copies the epic goal's check, even one the concierge stated", () => {
    // roborev 65892 settled this. `source: "human"` does not mean a PERSON chose the check: no
    // human-facing surface can attach one to an epic goal at all — the row calls `setEpicGoal` with
    // no verify — and the sole writer of human+verify is the concierge tool, where `verify` is a
    // MODEL-AUTHORED argument. So the label separates generator-model from concierge-model, never
    // model from person, and binding an agent to a model's suggestion is exactly the two paid-for
    // bugs (sticky via chargeGoalDebt's owedBinds; red via agentStall.chosenHere).
    projects = [
      {
        id: "proj1",
        rootPath: "/repo",
        agents: [],
        epicGoals: {
          "epic-42": goalRecord(EPIC_GOAL, { verify: { kind: "command", cmd: "pnpm verify" } }),
        },
      },
    ];
    addAgentMock.mockReturnValue("build-new");

    sendToBuild({ projectId: "proj1", epicId: "epic-42", prdPath: null });

    // FIVE arguments — no sixth.
    expect(setAgentGoalMock).toHaveBeenCalledWith(
      "proj1",
      "build-new",
      EPIC_GOAL,
      undefined,
      "agent",
    );
    expect(markAgentGoalFromEpicMock).toHaveBeenCalledWith("proj1", "build-new", 1);
  });

  it("a goal that has since GAINED a check is not re-armed by an unchanged epic goal", () => {
    // roborev 65892. While the ladder still reported a filtered check, `checkChanged` compared that
    // filtered value against the agent goal's ACTUAL one — and those diverge by construction, since
    // `chargeGoalDebt` and a concierge `set_agent_goal` can both put a check on the orchestrator's
    // goal that the ladder never wrote. The comparison was then permanently unequal, making `stale`
    // true on every later epic-goal write, whose ONLY effect is that `setAgentGoal`'s
    // unchanged-text branch strips `metAt` — reverting a met orchestrator to unmet and re-entering
    // auto-continue. No check travels now, so the asymmetry cannot arise; this pins that.
    projects = [
      {
        id: "proj1",
        rootPath: "/repo",
        agents: [
          {
            id: "build1",
            kind: "build",
            epicId: "epic-42",
            goal: { text: EPIC_GOAL, setAt: 1, fromEpicGoalAt: 1, verify: { kind: "human" } },
          },
        ],
        epicGoals: { "epic-42": goalRecord(EPIC_GOAL, { setAt: 50 }) },
      },
    ];

    sendToBuild({ projectId: "proj1", epicId: "epic-42", prdPath: null });

    expect(setAgentGoalMock).not.toHaveBeenCalled();
  });

  it("an epic goal RE-SAVED with identical text is not stale — a no-op must not un-mark met", () => {
    // roborev 65882. `setEpicGoal` re-stamps `setAt` on every write, so re-saving the same sentence
    // would call `setAgentGoal` with byte-identical text — which takes its unchanged-text branch and
    // STRIPS `metAt`. An orchestrator whose goal was legitimately met would silently revert to unmet
    // and re-enter auto-continue because someone re-saved a field they had not changed.
    projects = [
      {
        id: "proj1",
        rootPath: "/repo",
        agents: [
          { id: "build1", kind: "build", epicId: "epic-42", goal: { text: EPIC_GOAL, setAt: 1, fromEpicGoalAt: 1 } },
        ],
        epicGoals: { "epic-42": goalRecord(EPIC_GOAL, { setAt: 50 }) },
      },
    ];

    sendToBuild({ projectId: "proj1", epicId: "epic-42", prdPath: null });

    expect(setAgentGoalMock).not.toHaveBeenCalled();
  });

  it("…but a goal set AFTER the epic goal is left alone — it may be a deliberate rewording", () => {
    // The paired direction, and the reason the rule is safe. `setAgentGoal` re-stamps `setAt` on
    // every set, so an agent goal newer than the epic goal is one somebody chose after the epic
    // goal was last written. Without this the re-sync would silently overwrite it.
    projects = [
      {
        id: "proj1",
        rootPath: "/repo",
        agents: [
          {
            id: "build1",
            kind: "build",
            epicId: "epic-42",
            goal: { text: "a reworded objective", setAt: 9, fromEpicGoalAt: 9 },
          },
        ],
        epicGoals: { "epic-42": goalRecord(EPIC_GOAL, { setAt: 2 }) },
      },
    ];

    sendToBuild({ projectId: "proj1", epicId: "epic-42", prdPath: null });

    expect(setAgentGoalMock).not.toHaveBeenCalled();
  });

  it("does NOT set it in TASK mode — a parent epic's goal is not this orchestrator's to meet", () => {
    // The paired absence for the actor case. An epic goal is achieved by the whole epic; handing it
    // to an orchestrator building ONE task gives it an objective it can never mark met, which is the
    // "cannot be told apart from one that stopped" failure this whole feature exists to avoid. The
    // prompt still STATES that parent goal in task mode — reading it and being judged by it are
    // different things, which is why only this assertion is negative.
    projects = [
      { id: "proj1", rootPath: "/repo", agents: [], epicGoals: { "epic-1": goalRecord(EPIC_GOAL) } },
    ];
    addAgentMock.mockReturnValue("build-new");
    useBeadsStore.setState({
      byProject: {
        proj1: {
          beads: [
            { id: "epic-1", title: "E", description: "", status: "open", type: "epic", labels: [] },
            { id: "task-1", title: "T", description: "", status: "open", parent: "epic-1", labels: [] },
          ] as never,
          board: null as never,
          loadedAt: 1,
        },
      },
    });

    sendToBuild({ projectId: "proj1", epicId: "task-1", prdPath: null, mode: "task" });

    expect(setAgentGoalMock).not.toHaveBeenCalled();
    expect(seed()).toContain(EPIC_GOAL); // …and the prompt DID state it
  });

  it("ignores a goal record left behind by a FAILED generation", () => {
    // `hasEpicGoalText` is the guard: a failed generation writes a record with EMPTY text and a
    // reason, deliberately, so a failed attempt can be told apart from an untried one. Reading that
    // record's presence instead of its text would paint an empty "verbatim:" line into the brief.
    projects = [
      {
        id: "proj1",
        rootPath: "/repo",
        agents: [],
        epicGoals: { "epic-42": { text: "", setAt: 1, source: "auto" } },
      },
    ];
    addAgentMock.mockReturnValue("build-new");

    sendToBuild({ projectId: "proj1", epicId: "epic-42", prdPath: null });

    expect(setAgentGoalMock).not.toHaveBeenCalled();
    expect(seed()).not.toMatch(/NARROWED SLICE/);
  });
});

// ── THE DELEGATION LEDGER (services/dispatchLedger) ─────────────────────────────────────────────
//
// The Plan board's "Start"/"Build It" reaches `projectStore.addAgent` DIRECTLY and never passes
// through `spawnBuildAgentInProject`, where every other local build spawn is recorded. So this path
// needs — and has — its own write site, and these tests are what keep it from being deleted as
// redundant. They assert the ROW, not the handoff: a green suite that only proved an agent exists is
// exactly the vacuous shape that let the 2026-08-22 recall failure ship.
describe("sendToBuild records the delegation", () => {
  beforeEach(() => {
    projects = [];
    addAgentMock.mockReset();
    appendPromptMock.mockReset();
    appendPromptMock.mockReturnValue("prompt-id");
    setAgentEpicIdMock.mockReset();
    setAgentBeadIdMock.mockReset();
    setAgentGoalMock.mockReset();
    openMock.mockReset();
    recordHistoryMock.mockClear();
  });

  /** Only the ledger's rows — see the mock's own note for why this seam carries nothing else. */
  const rows = () =>
    recordHistoryMock.mock.calls
      .map((c) => c[0] as { source: string; agentId: string | null; text: string })
      .filter((e) => e.source === "dispatch");

  it("writes a `plan`-channel row naming the agent and the bead handed over", () => {
    projects = [{ id: "proj1", rootPath: "/repo", agents: [] }];
    addAgentMock.mockReturnValue("build-new");

    sendToBuild({ projectId: "proj1", epicId: "epic-42", prdPath: "PRD/feature.md" });

    expect(rows()).toHaveLength(1);
    const row = rows()[0]!;
    expect(row.agentId).toBe("build-new");
    // `plan` is its own channel rather than a synonym for `build`: this is a different provenance —
    // a board hand-off of existing planned work, not someone starting a fresh agent.
    expect(row.text).toContain("channel plan");
    // THE BEAD IS THE ASK on this path, and naming it is what makes the row findable by the work
    // rather than only by the agent that happened to get it.
    expect(row.text).toContain("BEADS: epic-42");
    expect(row.text).toContain("PRD/feature.md");
  });

  it("carries the EPIC GOAL into the row, which is the only part a person searches by", () => {
    // The seed prompt is mostly `beadsProtocol` boilerplate, identical on every hand-off, so it is
    // deliberately NOT what the row stores. The goal is the one sentence that says what this work
    // IS — and the founder asks "did we ever look at the inline preview cards", never "epic-42".
    projects = [
      {
        id: "proj1",
        rootPath: "/repo",
        agents: [],
        epicGoals: {
          "epic-42": { text: "preview cards render inline in chat", setAt: 5, source: "auto" },
        },
      },
    ];
    addAgentMock.mockReturnValue("build-new");

    sendToBuild({ projectId: "proj1", epicId: "epic-42", prdPath: null });

    expect(rows()[0]!.text).toContain("preview cards render inline in chat");
  });

  it("records a REUSED orchestrator too — the delegated act is the hand-off, not the row creation", () => {
    // `prepareHandoff` adopts the build agent already bound to this epic instead of creating one, so
    // `addAgent` never runs. A ledger keyed on creation would make every RESUMED epic invisible to
    // recall — and a resumed epic is the likeliest thing to be asked about twice, because it is the
    // work that has been going on longest.
    projects = [
      { id: "proj1", rootPath: "/repo", agents: [{ id: "build-old", kind: "build", epicId: "epic-42" }] },
    ];

    sendToBuild({ projectId: "proj1", epicId: "epic-42", prdPath: null });

    expect(addAgentMock).not.toHaveBeenCalled();
    expect(rows().map((r) => r.agentId)).toEqual(["build-old"]);
  });

  it("attributes a board click to the human and a machine-driven hand-off to the machine", () => {
    projects = [{ id: "proj1", rootPath: "/repo", agents: [] }];
    addAgentMock.mockReturnValue("build-new");

    sendToBuild({ projectId: "proj1", epicId: "epic-42", prdPath: null });
    expect(rows()[0]!.text).toContain("by human");

    recordHistoryMock.mockClear();
    projects = [{ id: "proj1", rootPath: "/repo", agents: [] }];
    // `humanAuthored: false` is this module's existing answer to "did a PERSON trigger this?" — the
    // concierge's `promote_plan_to_build` is the caller that passes it. Reusing it keeps ONE answer
    // to that question rather than a second one that can disagree with the goal-debt rule.
    sendToBuild({ projectId: "proj1", epicId: "epic-42", prdPath: null, humanAuthored: false });
    expect(rows()[0]!.text).toContain("by machine");
  });

  it("writes NOTHING when the hand-off is refused at capacity — paired with the same call succeeding", () => {
    // The refusal happens before `addAgent`, so no orchestrator exists. A row here would be a FALSE
    // POSITIVE on "did we ever start that", which is worse than the false negative the ledger fixes:
    // it reports work under way that nobody is doing.
    projects = [{ id: "proj1", rootPath: "/repo", agents: [] }];
    addAgentMock.mockReturnValue("build-new");
    capacityMock.mockReturnValueOnce({ atCapacity: true, used: 8, limit: 8, live: 8, basis: "test" });

    expect(() => sendToBuild({ projectId: "proj1", epicId: "epic-42", prdPath: null })).toThrow(
      AtCapacityError,
    );
    expect(rows()).toEqual([]);

    // The other half: without it this passes just as well against a build with no write site at all.
    sendToBuild({ projectId: "proj1", epicId: "epic-42", prdPath: null });
    expect(rows()).toHaveLength(1);
  });
});
