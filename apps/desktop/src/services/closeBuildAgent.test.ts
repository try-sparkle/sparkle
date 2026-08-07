import { describe, it, expect, vi, beforeEach } from "vitest";

const close = vi.fn();
const removeAgent = vi.fn();
const spinDownAgentGit = vi.fn().mockResolvedValue(undefined);
const deleteCloudSession = vi.fn().mockResolvedValue(undefined);
let deleteMergedBranch = true;

// Mutable so a test can flip an agent to `runtime: "cloud"` (the DELETE path) without a second
// module-level mock.
type TestAgent = { id: string; kind?: string; parentId?: string; runtime?: "local" | "cloud" };
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
// Mutable so the retirement-gate block can put an agent on a LANDED stage. Everything else leaves
// these empty, which resolves to a pre-merge stage and keeps the old teardown tests unaffected.
let branchStatus: Record<string, unknown> = {};
let workflowStage: Record<string, unknown> = {};
vi.mock("../stores/runtimeStore", () => ({
  useRuntimeStore: { getState: () => ({ close, branchStatus, workflowStage }) },
}));
vi.mock("../stores/settingsStore", () => ({
  useSettingsStore: { getState: () => ({ deleteMergedBranch }) },
}));
vi.mock("./closeAgentActions", () => ({ spinDownAgentGit: (...a: unknown[]) => spinDownAgentGit(...a) }));
vi.mock("./agentTransport", () => ({ deleteCloudSession: (id: string) => deleteCloudSession(id) }));

import { closeBuildAgent } from "./closeBuildAgent";
import { __resetRetroReceiptsForTest } from "./retroReceipts";

beforeEach(() => {
  vi.clearAllMocks();
  deleteMergedBranch = true;
  agents = defaultAgents();
  branchStatus = {};
  workflowStage = {};
  __resetRetroReceiptsForTest();
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

    await closeBuildAgent("build1", true);

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
    await closeBuildAgent("build1", true);
    expect(spinDownAgentGit).toHaveBeenCalledWith(expect.objectContaining({ deleteBranch: false }));
  });

  it("no-ops when the agent isn't in any project", async () => {
    await closeBuildAgent("ghost", true);
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

    await closeBuildAgent("build1", true);

    expect(order).toEqual(["delete:build1", "close:build1", "remove:p1/build1"]);
  });

  it("a LOCAL agent's close never calls the cloud DELETE", async () => {
    await closeBuildAgent("build1", true);
    expect(deleteCloudSession).not.toHaveBeenCalled();
  });

  // Best-effort: an offline close must still remove the tab (the server's idle-pause bounds the
  // cost, and re-attach surfaces a still-live session honestly).
  it("still completes the teardown when the cloud DELETE fails", async () => {
    agents = [{ id: "build1", runtime: "cloud" }];
    deleteCloudSession.mockRejectedValue(new Error("offline"));

    await expect(closeBuildAgent("build1", true)).resolves.toEqual({ ok: true });

    expect(close).toHaveBeenCalledWith("build1");
    expect(spinDownAgentGit).toHaveBeenCalled();
    expect(removeAgent).toHaveBeenCalledWith("p1", "build1");
  });
});

// ── The retirement gate (bead sparkle-0l9xk) ────────────────────────────────────────────────────
// This is the choke point for every MACHINE close — the concierge, the phone, the green suggestion
// button. The × in the sidebar does NOT come through here (it calls teardownAgent directly, after
// its own dialog), which is exactly why the gate has to live in this function: a check wired only
// into the sidebar would leave all three machine paths open.
describe("a LANDED build agent may only be closed by a human", () => {
  const landed = () => {
    workflowStage = { build1: "merged" };
  };

  it("REFUSES an unconfirmed close and tears down NOTHING", async () => {
    landed();
    const r = await closeBuildAgent("build1", false);

    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe("needs-human-confirm");
    // The whole point: not one of these ran. A refusal that still killed the panes or removed the
    // worktrees would be a teardown with an apology attached.
    expect(close).not.toHaveBeenCalled();
    expect(spinDownAgentGit).not.toHaveBeenCalled();
    expect(removeAgent).not.toHaveBeenCalled();
  });

  it("names the agent and the ONE thing that clears the refusal", async () => {
    landed();
    agents = [{ id: "build1" }];
    const r = await closeBuildAgent("build1", false);

    // A refusal whose remedy is vague reads as a malfunction. The message has to be sayable by the
    // concierge as-is, so it must name the row and point at where the confirm lives.
    expect(!r.ok && r.message).toMatch(/build1/);
    expect(!r.ok && r.message).toMatch(/row/i);
  });

  it("closes normally once the human HAS confirmed", async () => {
    landed();
    const r = await closeBuildAgent("build1", true);

    expect(r).toEqual({ ok: true });
    expect(removeAgent).toHaveBeenCalledWith("p1", "build1");
  });

  it("leaves an UNLANDED agent alone — the gate is about landed work, not about closing", async () => {
    // Nothing landed, so nothing is owed and no confirmation is required. If this ever starts
    // refusing, every ordinary machine close in the app has been broken by the gate.
    const r = await closeBuildAgent("build1", false);

    expect(r).toEqual({ ok: true });
    expect(removeAgent).toHaveBeenCalledWith("p1", "build1");
  });

  it("does not gate a WORKER, whatever its stage", async () => {
    // Workers report to their orchestrator and are spun down by it in bulk. Gating them would put a
    // dialog in front of every worker teardown and the 60s orphan reaper.
    agents = [{ id: "w1", kind: "worker", parentId: "build1" }, { id: "build1" }];
    workflowStage = { w1: "shipped" };
    const r = await closeBuildAgent("w1", false);

    expect(r).toEqual({ ok: true });
  });
});
