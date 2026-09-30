import { describe, it, expect, vi, beforeEach } from "vitest";

const close = vi.fn();
const removeAgent = vi.fn();
const spinDownAgentGit = vi.fn().mockResolvedValue(undefined);
const deleteCloudSession = vi.fn().mockResolvedValue(undefined);
let deleteMergedBranch = true;

// Mutable so a test can flip an agent to `runtime: "cloud"` (the DELETE path) without a second
// module-level mock.
type TestAgent = {
  id: string;
  kind?: string;
  parentId?: string;
  runtime?: "local" | "cloud";
  beadId?: string;
};
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
// The FRESH per-bead read the teardown judges status and telemetry from. A bead absent from this
// map rejects, i.e. "could not read".
let boardBeads: { id: string; status: string; labels: string[] }[] | undefined;
let inFlightReads = 0;
let maxInFlightReads = 0;
const beadShow = vi.fn(async (_root: string, id: string) => {
  inFlightReads++;
  maxInFlightReads = Math.max(maxInFlightReads, inFlightReads);
  await Promise.resolve();
  inFlightReads--;
  const hit = boardBeads?.find((b) => b.id === id);
  if (!hit) throw new Error("database is locked");
  return hit;
});
vi.mock("./beads", async (orig) => ({
  ...(await orig<typeof import("./beads")>()),
  beadShow: (r: string, id: string) => beadShow(r, id),
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
  boardBeads = undefined;
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

// ── Beads left behind by a teardown (bead sparkle-aoqzzo) ───────────────────────────────────────
// Three of an epic's four children landed; the fourth was bound to a worker that never landed it.
// Closing the build agent used to close all four, and the unaddressed finding left the board
// looking fixed. Each bead is now judged on its OWN agent's stage.
describe("closeBuildAgent — what happens to each bound bead", () => {
  it("closes the landed child and RELEASES the unlanded sibling, never closing it", async () => {
    agents = [
      { id: "build1" },
      { id: "w1", parentId: "build1", beadId: "child-A" },
      { id: "w2", parentId: "build1", beadId: "child-B" },
    ];
    workflowStage = { w1: "merged", w2: "building_unsaved" };
    boardBeads = [
      { id: "child-A", status: "in_progress", labels: [] },
      { id: "child-B", status: "in_progress", labels: [] },
    ];

    await closeBuildAgent("build1", true);

    expect(spinDownAgentGit).toHaveBeenCalledWith(
      expect.objectContaining({ beadIds: ["child-A"], releaseBeadIds: ["child-B"] }),
    );
  });

  it("still closes an unlanded app telemetry bead, as before", async () => {
    agents = [{ id: "build1", beadId: "auto-1" }];
    workflowStage = { build1: "building_unsaved" };
    boardBeads = [{ id: "auto-1", status: "in_progress", labels: ["sparkle-auto"] }];

    await closeBuildAgent("build1", true);

    expect(spinDownAgentGit).toHaveBeenCalledWith(
      expect.objectContaining({ beadIds: ["auto-1"], releaseBeadIds: [] }),
    );
  });

  // roborev 83232: the old version read the cached board, so an unviewed project (no snapshot) left
  // unlanded beads untouched — the orphaned-in_progress leak — and a stale snapshot could reopen a
  // bead closed since the last poll. Both are decided from a fresh read now.
  // roborev 83346: closing an unreadable bead is the aoqzzo defect, and reads time out routinely
  // under the store lock. An unlanded bead that cannot be read gets NO write.
  it("never closes an unlanded bead whose read failed — only the landed one closes", async () => {
    agents = [
      { id: "build1" },
      { id: "w1", parentId: "build1", beadId: "child-A" },
      { id: "w2", parentId: "build1", beadId: "child-B" },
    ];
    workflowStage = { w1: "shipped" };
    boardBeads = undefined; // every read rejects

    await closeBuildAgent("build1", true);

    expect(beadShow).toHaveBeenCalledWith("/r", "child-B");
    expect(spinDownAgentGit).toHaveBeenCalledWith(
      expect.objectContaining({ beadIds: ["child-A"], releaseBeadIds: [] }),
    );
  });

  // roborev 83352: the serial reads ran BEFORE the visible teardown, so a busy store held panes and
  // PTYs open for N x the read bound. Close first; never read a bead whose agent landed.
  it("tears the panes down BEFORE any bead read, and never reads a landed bead", async () => {
    agents = [
      { id: "build1" },
      { id: "w1", parentId: "build1", beadId: "landed-A" },
      { id: "w2", parentId: "build1", beadId: "open-B" },
    ];
    workflowStage = { w1: "merged", w2: "building_unsaved" };
    boardBeads = [{ id: "open-B", status: "in_progress", labels: [] }];

    await closeBuildAgent("build1", true);

    expect(beadShow).not.toHaveBeenCalledWith("/r", "landed-A");
    expect(beadShow).toHaveBeenCalledWith("/r", "open-B");
    const lastClose = Math.max(...close.mock.invocationCallOrder);
    const firstRead = Math.min(...beadShow.mock.invocationCallOrder);
    expect(lastClose).toBeLessThan(firstRead);
    expect(spinDownAgentGit).toHaveBeenCalledWith(
      expect.objectContaining({ beadIds: ["landed-A"], releaseBeadIds: ["open-B"] }),
    );
  });

  it("reads the bound beads ONE AT A TIME, never in parallel against the single-writer store", async () => {
    maxInFlightReads = 0;
    agents = [
      { id: "build1" },
      { id: "w1", parentId: "build1", beadId: "b1" },
      { id: "w2", parentId: "build1", beadId: "b2" },
      { id: "w3", parentId: "build1", beadId: "b3" },
    ];
    boardBeads = ["b1", "b2", "b3"].map((id) => ({ id, status: "in_progress", labels: [] }));

    await closeBuildAgent("build1", true);

    expect(beadShow).toHaveBeenCalledTimes(3);
    expect(maxInFlightReads).toBe(1);
  });

  it("never releases (reopens) a bead the fresh read shows was closed since the last board poll", async () => {
    agents = [{ id: "build1" }, { id: "w2", parentId: "build1", beadId: "child-B" }];
    workflowStage = { w2: "building_unsaved" };
    boardBeads = [{ id: "child-B", status: "closed", labels: [] }];

    await closeBuildAgent("build1", true);

    expect(spinDownAgentGit).toHaveBeenCalledWith(
      expect.objectContaining({ beadIds: [], releaseBeadIds: [] }),
    );
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
