import { describe, it, expect, beforeEach, vi } from "vitest";

// bead sparkle-0bhr — END-TO-END proof of the fix: a bead a HUMAN files by hand, hands to Build, and
// ships must reach the board's "Shipped" (delivered) column. This exercises the WHOLE seam with both
// real functions (sendToBuild + shipAgent) wired together, so it fails if EITHER half regresses:
//   • sendToBuild must LINK the human bead as the orchestrator's beadId, and
//   • shipAgent must mark THAT beadId delivered when the branch lands.
// Only `beads`, `branchStatus`, `worktree`, and the zustand stores are mocked; the two units under
// test run for real, so the linkage between them is genuinely covered (not hand-wired by the test).

vi.mock("./branchStatus", () => ({
  projectAgentsStatus: vi.fn(() => Promise.resolve([])),
  landAgentBranch: vi.fn(),
  pushAgentBranch: vi.fn(),
  openAgentPr: vi.fn(),
  deleteAgentBranch: vi.fn(),
  deleteAgentBranchIfMerged: vi.fn(),
}));
vi.mock("./beads", () => ({
  closeBead: vi.fn(),
  markBeadDelivered: vi.fn(),
  recordBeadMergeSha: vi.fn(),
  deleteBead: vi.fn(),
}));
vi.mock("./worktree", () => ({ removeAgentWorkspace: vi.fn() }));

// A minimal but REAL-behaving projectStore: addAgent appends an agent, and setAgentBeadId /
// setAgentEpicId actually write the fields — so `sendToBuild` reads back state it produced itself
// and the test can inspect the linkage it made, exactly as the real store would.
interface Agent { id: string; kind: string; epicId?: string; beadId?: string }
let projects: Array<{ id: string; rootPath: string; agents: Agent[] }> = [];
let spawnCount = 0;
const projectStoreState = {
  get projects() {
    return projects;
  },
  addAgent: (_projectId: string, opts: { kind: string }) => {
    const id = `build-${++spawnCount}`;
    projects[0]!.agents.push({ id, kind: opts.kind });
    return id;
  },
  appendPrompt: vi.fn(),
  selectAgent: vi.fn(),
  setAgentEpicId: (_p: string, agentId: string, epicId: string) => {
    const a = projects[0]!.agents.find((x) => x.id === agentId);
    if (a) a.epicId = epicId;
  },
  setAgentBeadId: (_p: string, agentId: string, beadId: string) => {
    const a = projects[0]!.agents.find((x) => x.id === agentId);
    if (a) a.beadId = beadId;
  },
};
vi.mock("../stores/projectStore", () => ({
  useProjectStore: { getState: () => projectStoreState },
}));
vi.mock("../stores/runtimeStore", () => ({
  useRuntimeStore: { getState: () => ({ open: vi.fn() }) },
}));
vi.mock("../stores/uiStore", () => ({
  useUiStore: {
    getState: () => ({
      setActiveSpecial: vi.fn(),
      requestRevealAgent: vi.fn(),
      requestComposeFocus: vi.fn(),
      // landInAgent leaves the board by switching the project's own column out of Plan, so it
      // needs both of these — see the note in sendToBuild.test.ts.
      setWorkMode: vi.fn(),
      pairAssignment: {},
    }),
  },
}));

import { sendToBuild } from "./sendToBuild";
import { shipAgent } from "./closeAgentActions";
import * as branch from "./branchStatus";
import * as beads from "./beads";

beforeEach(() => {
  vi.clearAllMocks();
  spawnCount = 0;
  projects = [{ id: "proj1", rootPath: "/repo", agents: [] }];
  vi.mocked(branch.pushAgentBranch).mockResolvedValue("no-remote");
  vi.mocked(branch.landAgentBranch).mockResolvedValue({ ok: true, target: "main", mergeSha: "sha-1" });
  vi.mocked(beads.markBeadDelivered).mockResolvedValue(undefined);
  vi.mocked(beads.recordBeadMergeSha).mockResolvedValue(undefined);
  vi.mocked(beads.closeBead).mockResolvedValue(undefined);
});

describe("human-filed bead → Build → land → Shipped (bead sparkle-0bhr)", () => {
  it("marks the HUMAN bead delivered when the orchestrator's branch lands (reaches Shipped)", async () => {
    // 1. A human filed "human-42" and hits "Build this bead" (task mode).
    const agentId = sendToBuild({ projectId: "proj1", epicId: "human-42", prdPath: null, mode: "task" });
    const agent = projects[0]!.agents.find((a) => a.id === agentId)!;
    // The linkage sendToBuild must make: the agent now carries the HUMAN bead.
    expect(agent.beadId).toBe("human-42");

    // 2. The human ships the orchestrator; no remote, so it lands locally.
    const outcome = await shipAgent({
      root: projects[0]!.rootPath,
      projectId: projects[0]!.id,
      agentId,
      targetBranch: "main",
      prTitle: agent.epicId ?? "",
      beadId: agent.beadId,
    });

    // 3. The HUMAN bead — not a hidden `sparkle-auto` telemetry bead — is marked delivered.
    expect(outcome.kind).toBe("landed");
    expect(beads.markBeadDelivered).toHaveBeenCalledWith("/repo", "human-42");
  });

  it("does not regress the AUTO path: an agent carrying an auto-created beadId still delivers on land", async () => {
    // The auto-lifecycle path already sets agent.beadId (buildAgentSpawn / syncBeadLifecycle); ship
    // still marks it delivered. Same shared shipAgent mechanism — this guards it stayed intact.
    await shipAgent({ root: "/repo", projectId: "p1", agentId: "auto-agent", targetBranch: "main", prTitle: "T", beadId: "auto-9" });
    expect(beads.markBeadDelivered).toHaveBeenCalledWith("/repo", "auto-9");
  });
});
