import { describe, it, expect, vi, beforeEach } from "vitest";

const close = vi.fn();
const removeAgent = vi.fn();
const spinDownAgentGit = vi.fn().mockResolvedValue(undefined);
const deleteCloudSession = vi.fn().mockResolvedValue(undefined);
let deleteMergedBranch = true;

// Mutable so a test can flip an agent to `runtime: "cloud"` (the DELETE path) without a second
// module-level mock.
type TestAgent = { id: string; parentId?: string; runtime?: "local" | "cloud" };
let agents: TestAgent[] = [];
const defaultAgents = (): TestAgent[] => [
  { id: "build1" },
  { id: "w1", parentId: "build1" },
  { id: "w2", parentId: "build1" },
  { id: "other" }, // a different build agent — must NOT be touched
  { id: "wOther", parentId: "other" },
];

vi.mock("../stores/projectStore", () => ({
  useProjectStore: {
    getState: () => ({
      projects: [{ id: "p1", rootPath: "/r", agents }],
      removeAgent,
    }),
  },
}));
vi.mock("../stores/runtimeStore", () => ({ useRuntimeStore: { getState: () => ({ close }) } }));
vi.mock("../stores/settingsStore", () => ({
  useSettingsStore: { getState: () => ({ deleteMergedBranch }) },
}));
vi.mock("./closeAgentActions", () => ({ spinDownAgentGit: (...a: unknown[]) => spinDownAgentGit(...a) }));
vi.mock("./agentTransport", () => ({ deleteCloudSession: (id: string) => deleteCloudSession(id) }));

import { closeBuildAgent } from "./closeBuildAgent";

beforeEach(() => {
  vi.clearAllMocks();
  deleteMergedBranch = true;
  agents = defaultAgents();
  deleteCloudSession.mockResolvedValue(undefined);
});

describe("closeBuildAgent", () => {
  it("closes the build agent + only its workers, git-teardown per setting, removeAgent last", async () => {
    const order: string[] = [];
    close.mockImplementation((id: string) => order.push(`close:${id}`));
    spinDownAgentGit.mockImplementation(async (p: { ids: string[]; deleteBranch: boolean }) =>
      order.push(`git:[${p.ids.join(",")}]:del=${p.deleteBranch}`),
    );
    removeAgent.mockImplementation((pid: string, id: string) => order.push(`remove:${pid}/${id}`));

    await closeBuildAgent("build1");

    expect(order).toEqual([
      "close:build1",
      "close:w1",
      "close:w2",
      "git:[build1,w1,w2]:del=true", // ids = build + only ITS workers; deleteBranch from the setting
      "remove:p1/build1", // removeAgent runs last (after worktrees are gone)
    ]);
  });

  it("threads deleteBranch=false from the setting", async () => {
    deleteMergedBranch = false;
    await closeBuildAgent("build1");
    expect(spinDownAgentGit).toHaveBeenCalledWith(expect.objectContaining({ deleteBranch: false }));
  });

  it("no-ops when the agent isn't in any project", async () => {
    await closeBuildAgent("ghost");
    expect(close).not.toHaveBeenCalled();
    expect(spinDownAgentGit).not.toHaveBeenCalled();
    expect(removeAgent).not.toHaveBeenCalled();
  });

  // The deliberate close is the ONLY gesture that terminates a cloud sandbox — the pane's unmount
  // detaches by design, so a missing DELETE here leaves it metering until idle-pause and lets
  // re-attach resurrect the tab on the next project open (roborev 46339).
  it("a CLOUD agent's close deletes the server session BEFORE tearing the stores down", async () => {
    agents = [{ id: "build1", runtime: "cloud" }];
    const order: string[] = [];
    deleteCloudSession.mockImplementation(async (id: string) => void order.push(`delete:${id}`));
    close.mockImplementation((id: string) => order.push(`close:${id}`));
    removeAgent.mockImplementation((pid: string, id: string) => order.push(`remove:${pid}/${id}`));

    await closeBuildAgent("build1");

    expect(order).toEqual(["delete:build1", "close:build1", "remove:p1/build1"]);
  });

  it("a LOCAL agent's close never calls the cloud DELETE", async () => {
    await closeBuildAgent("build1");
    expect(deleteCloudSession).not.toHaveBeenCalled();
  });

  // Best-effort: an offline close must still remove the tab (the server's idle-pause bounds the
  // cost, and re-attach surfaces a still-live session honestly).
  it("still completes the teardown when the cloud DELETE fails", async () => {
    agents = [{ id: "build1", runtime: "cloud" }];
    deleteCloudSession.mockRejectedValue(new Error("offline"));

    await expect(closeBuildAgent("build1")).resolves.toBeUndefined();

    expect(close).toHaveBeenCalledWith("build1");
    expect(spinDownAgentGit).toHaveBeenCalled();
    expect(removeAgent).toHaveBeenCalledWith("p1", "build1");
  });
});
