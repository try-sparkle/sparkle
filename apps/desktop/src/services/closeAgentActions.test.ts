import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./branchStatus", () => ({
  landAgentBranch: vi.fn(),
  pushAgentBranch: vi.fn(),
  openAgentPr: vi.fn(),
  deleteAgentBranch: vi.fn(),
}));
vi.mock("./beads", () => ({
  closeBead: vi.fn(),
  markBeadDelivered: vi.fn(),
  deleteBead: vi.fn(),
}));
vi.mock("./worktree", () => ({ removeAgentWorkspace: vi.fn() }));

import { shipAgent, saveAgent, discardAgentGit } from "./closeAgentActions";
import * as branch from "./branchStatus";
import * as beads from "./beads";
import * as worktree from "./worktree";

beforeEach(() => {
  vi.resetAllMocks();
  // Sensible resolved defaults (the code .catch()es these); individual tests override as needed.
  vi.mocked(branch.pushAgentBranch).mockResolvedValue("pushed");
  vi.mocked(branch.openAgentPr).mockResolvedValue("https://pr/default");
  vi.mocked(branch.landAgentBranch).mockResolvedValue({ ok: true, target: "main" });
  vi.mocked(branch.deleteAgentBranch).mockResolvedValue(undefined);
  vi.mocked(beads.closeBead).mockResolvedValue(undefined);
  vi.mocked(beads.markBeadDelivered).mockResolvedValue(undefined);
  vi.mocked(beads.deleteBead).mockResolvedValue(undefined);
  vi.mocked(worktree.removeAgentWorkspace).mockResolvedValue(undefined);
});

describe("shipAgent", () => {
  it("pushed → opens a PR and closes the bead (submitted for review)", async () => {
    vi.mocked(branch.pushAgentBranch).mockResolvedValue("pushed");
    vi.mocked(branch.openAgentPr).mockResolvedValue("https://pr/1");
    await shipAgent({ root: "/r", agentId: "a", targetBranch: "main", prTitle: "T", beadId: "bd-1" });
    expect(branch.openAgentPr).toHaveBeenCalledWith("/r", "a", "main", "T");
    expect(beads.closeBead).toHaveBeenCalledWith("/r", "bd-1");
    expect(branch.landAgentBranch).not.toHaveBeenCalled();
    expect(beads.markBeadDelivered).not.toHaveBeenCalled();
  });

  it("pushed but PR open FAILS (no gh/auth) → does NOT close the bead (not under review)", async () => {
    vi.mocked(branch.pushAgentBranch).mockResolvedValue("pushed");
    vi.mocked(branch.openAgentPr).mockRejectedValue(new Error("gh: not found"));
    await shipAgent({ root: "/r", agentId: "a", targetBranch: "main", prTitle: "T", beadId: "bd-1" });
    expect(beads.closeBead).not.toHaveBeenCalled();
  });

  it("no remote → lands locally and marks the bead delivered on success", async () => {
    vi.mocked(branch.pushAgentBranch).mockResolvedValue("no-remote");
    vi.mocked(branch.landAgentBranch).mockResolvedValue({ ok: true, target: "main" });
    await shipAgent({ root: "/r", agentId: "a", targetBranch: "main", prTitle: "T", beadId: "bd-1" });
    expect(branch.landAgentBranch).toHaveBeenCalled();
    expect(beads.markBeadDelivered).toHaveBeenCalledWith("/r", "bd-1");
    expect(branch.openAgentPr).not.toHaveBeenCalled();
  });

  it("no remote + land FAILS → does not touch the bead (work didn't land)", async () => {
    vi.mocked(branch.pushAgentBranch).mockResolvedValue("no-remote");
    vi.mocked(branch.landAgentBranch).mockResolvedValue({ ok: false, reason: "conflict", files: [] });
    await shipAgent({ root: "/r", agentId: "a", targetBranch: "main", prTitle: "T", beadId: "bd-1" });
    expect(beads.markBeadDelivered).not.toHaveBeenCalled();
    expect(beads.closeBead).not.toHaveBeenCalled();
  });
});

describe("saveAgent", () => {
  it("pushes the branch (best-effort backup) and swallows a push error", async () => {
    vi.mocked(branch.pushAgentBranch).mockRejectedValue(new Error("offline"));
    await expect(saveAgent("/r", "a")).resolves.toBeUndefined();
    expect(branch.pushAgentBranch).toHaveBeenCalledWith("/r", "a");
  });
});

describe("discardAgentGit", () => {
  it("removes each worktree before deleting its branch, then deletes ALL beads (incl. workers')", async () => {
    const order: string[] = [];
    vi.mocked(worktree.removeAgentWorkspace).mockImplementation(async (_r, _p, id) => {
      order.push(`rm:${id}`);
    });
    vi.mocked(branch.deleteAgentBranch).mockImplementation(async (_r, id) => {
      order.push(`del:${id}`);
    });
    await discardAgentGit({
      root: "/r",
      projectId: "p",
      ids: ["parent", "w1"],
      beadIds: ["bd-parent", "bd-w1"],
    });
    // worktree removal precedes branch delete for each id (git can't delete a checked-out branch).
    expect(order).toEqual(["rm:parent", "del:parent", "rm:w1", "del:w1"]);
    expect(beads.deleteBead).toHaveBeenCalledWith("/r", "bd-parent");
    expect(beads.deleteBead).toHaveBeenCalledWith("/r", "bd-w1");
  });
});
