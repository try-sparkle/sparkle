import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./branchStatus", () => ({
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

import { shipAgent, saveAgent, discardAgentGit, spinDownAgentGit } from "./closeAgentActions";
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
  vi.mocked(beads.recordBeadMergeSha).mockResolvedValue(undefined);
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

  it("no remote → lands locally, records the merge SHA, then marks the bead delivered", async () => {
    vi.mocked(branch.pushAgentBranch).mockResolvedValue("no-remote");
    vi.mocked(branch.landAgentBranch).mockResolvedValue({ ok: true, target: "main", mergeSha: "abc123" });
    await shipAgent({ root: "/r", agentId: "a", targetBranch: "main", prTitle: "T", beadId: "bd-1" });
    expect(branch.landAgentBranch).toHaveBeenCalled();
    // The landed SHA is recorded (Task B) BEFORE delivered, so the monitor can test it for release
    // containment. Ordering matters: capture the commit before the bead moves.
    expect(beads.recordBeadMergeSha).toHaveBeenCalledWith("/r", "bd-1", "abc123");
    const recordOrder = vi.mocked(beads.recordBeadMergeSha).mock.invocationCallOrder[0]!;
    const deliverOrder = vi.mocked(beads.markBeadDelivered).mock.invocationCallOrder[0]!;
    expect(recordOrder).toBeLessThan(deliverOrder);
    expect(beads.markBeadDelivered).toHaveBeenCalledWith("/r", "bd-1");
    expect(branch.openAgentPr).not.toHaveBeenCalled();
  });

  it("no remote, land returns no SHA (older Rust) → still delivers; recordBeadMergeSha no-ops on undefined", async () => {
    vi.mocked(branch.pushAgentBranch).mockResolvedValue("no-remote");
    vi.mocked(branch.landAgentBranch).mockResolvedValue({ ok: true, target: "main" });
    await shipAgent({ root: "/r", agentId: "a", targetBranch: "main", prTitle: "T", beadId: "bd-1" });
    // We still call through (the helper itself no-ops on a blank SHA — honesty lives in one place).
    expect(beads.recordBeadMergeSha).toHaveBeenCalledWith("/r", "bd-1", undefined);
    expect(beads.markBeadDelivered).toHaveBeenCalledWith("/r", "bd-1");
  });

  it("pushed (PR path) → never records a merge SHA (the GitHub merge is uncapturable here)", async () => {
    vi.mocked(branch.pushAgentBranch).mockResolvedValue("pushed");
    vi.mocked(branch.openAgentPr).mockResolvedValue("https://pr/1");
    await shipAgent({ root: "/r", agentId: "a", targetBranch: "main", prTitle: "T", beadId: "bd-1" });
    expect(beads.recordBeadMergeSha).not.toHaveBeenCalled();
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

describe("spinDownAgentGit (close a shipped build agent)", () => {
  it("removes each worktree then SAFE-deletes each branch when deleteBranch=true", async () => {
    const order: string[] = [];
    vi.mocked(worktree.removeAgentWorkspace).mockImplementation(async (_r, _p, id) => {
      order.push(`rm:${id}`);
    });
    vi.mocked(branch.deleteAgentBranchIfMerged).mockImplementation(async (_r, id) => {
      order.push(`del:${id}`);
    });
    await spinDownAgentGit({ root: "/r", projectId: "p1", ids: ["parent", "w1"], deleteBranch: true });
    expect(order).toEqual(["rm:parent", "del:parent", "rm:w1", "del:w1"]);
    expect(branch.deleteAgentBranch).not.toHaveBeenCalled(); // never the FORCE delete
  });

  it("removes worktrees but keeps branches when deleteBranch=false", async () => {
    await spinDownAgentGit({ root: "/r", projectId: "p1", ids: ["parent"], deleteBranch: false });
    expect(worktree.removeAgentWorkspace).toHaveBeenCalledWith("/r", "p1", "parent");
    expect(branch.deleteAgentBranchIfMerged).not.toHaveBeenCalled();
  });
});
