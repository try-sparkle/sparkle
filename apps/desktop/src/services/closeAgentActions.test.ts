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
    await shipAgent({ root: "/r", projectId: "p1", agentId: "a", targetBranch: "main", prTitle: "T", beadId: "bd-1" });
    expect(branch.openAgentPr).toHaveBeenCalledWith("/r", "p1", "a", "main", "T");
    expect(beads.closeBead).toHaveBeenCalledWith("/r", "bd-1");
    expect(branch.landAgentBranch).not.toHaveBeenCalled();
    expect(beads.markBeadDelivered).not.toHaveBeenCalled();
  });

  it("pushed but PR open FAILS (no gh/auth) → does NOT close the bead (not under review)", async () => {
    vi.mocked(branch.pushAgentBranch).mockResolvedValue("pushed");
    vi.mocked(branch.openAgentPr).mockRejectedValue(new Error("gh: not found"));
    await shipAgent({ root: "/r", projectId: "p1", agentId: "a", targetBranch: "main", prTitle: "T", beadId: "bd-1" });
    expect(beads.closeBead).not.toHaveBeenCalled();
  });

  it("no remote → lands locally, records the merge SHA, then marks the bead delivered", async () => {
    vi.mocked(branch.pushAgentBranch).mockResolvedValue("no-remote");
    vi.mocked(branch.landAgentBranch).mockResolvedValue({ ok: true, target: "main", mergeSha: "abc123" });
    await shipAgent({ root: "/r", projectId: "p1", agentId: "a", targetBranch: "main", prTitle: "T", beadId: "bd-1" });
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
    await shipAgent({ root: "/r", projectId: "p1", agentId: "a", targetBranch: "main", prTitle: "T", beadId: "bd-1" });
    // We still call through (the helper itself no-ops on a blank SHA — honesty lives in one place).
    expect(beads.recordBeadMergeSha).toHaveBeenCalledWith("/r", "bd-1", undefined);
    expect(beads.markBeadDelivered).toHaveBeenCalledWith("/r", "bd-1");
  });

  it("pushed (PR path) → never records a merge SHA (the GitHub merge is uncapturable here)", async () => {
    vi.mocked(branch.pushAgentBranch).mockResolvedValue("pushed");
    vi.mocked(branch.openAgentPr).mockResolvedValue("https://pr/1");
    await shipAgent({ root: "/r", projectId: "p1", agentId: "a", targetBranch: "main", prTitle: "T", beadId: "bd-1" });
    expect(beads.recordBeadMergeSha).not.toHaveBeenCalled();
  });

  it("no remote + land FAILS → does not touch the bead (work didn't land)", async () => {
    vi.mocked(branch.pushAgentBranch).mockResolvedValue("no-remote");
    vi.mocked(branch.landAgentBranch).mockResolvedValue({ ok: false, reason: "conflict", files: [] });
    await shipAgent({ root: "/r", projectId: "p1", agentId: "a", targetBranch: "main", prTitle: "T", beadId: "bd-1" });
    expect(beads.markBeadDelivered).not.toHaveBeenCalled();
    expect(beads.closeBead).not.toHaveBeenCalled();
  });
});

// roborev 54175-1: the caller cannot tell "shipped, PR opened" from "nothing landed at all" if the
// only signal is the absence of a throw. Every path now RETURNS what happened.
describe("shipAgent → ShipOutcome", () => {
  it("pushed + PR opened → kind 'pr-opened', carrying the PR url", async () => {
    vi.mocked(branch.pushAgentBranch).mockResolvedValue("pushed");
    vi.mocked(branch.openAgentPr).mockResolvedValue("https://pr/7");
    const r = await shipAgent({ root: "/r", projectId: "p1", agentId: "a", targetBranch: "main", prTitle: "T" });
    expect(r).toEqual({
      kind: "pr-opened",
      pushed: true,
      prOpened: true,
      landed: false,
      prUrl: "https://pr/7",
    });
  });

  it("pushed but `gh` failed → kind 'pushed-no-pr' with the reason (NOT a silent success)", async () => {
    vi.mocked(branch.pushAgentBranch).mockResolvedValue("pushed");
    vi.mocked(branch.openAgentPr).mockRejectedValue(new Error("gh: not found"));
    const r = await shipAgent({ root: "/r", projectId: "p1", agentId: "a", targetBranch: "main", prTitle: "T" });
    expect(r).toMatchObject({ kind: "pushed-no-pr", pushed: true, prOpened: false, landed: false });
    expect(r.kind === "pushed-no-pr" && r.reason).toMatch(/gh: not found/);
  });

  it("no remote + land ok → kind 'landed' with the merge SHA", async () => {
    vi.mocked(branch.pushAgentBranch).mockResolvedValue("no-remote");
    vi.mocked(branch.landAgentBranch).mockResolvedValue({ ok: true, target: "main", mergeSha: "abc123" });
    const r = await shipAgent({ root: "/r", projectId: "p1", agentId: "a", targetBranch: "main", prTitle: "T" });
    expect(r).toEqual({
      kind: "landed",
      pushed: false,
      prOpened: false,
      landed: true,
      mergeSha: "abc123",
    });
  });

  it("no remote + land FAILED → kind 'land-failed' carrying git's reason", async () => {
    vi.mocked(branch.pushAgentBranch).mockResolvedValue("no-remote");
    vi.mocked(branch.landAgentBranch).mockResolvedValue({ ok: false, reason: "conflict", files: ["a.ts"] });
    const r = await shipAgent({ root: "/r", projectId: "p1", agentId: "a", targetBranch: "main", prTitle: "T" });
    expect(r).toMatchObject({ kind: "land-failed", pushed: false, prOpened: false, landed: false });
    expect(r.kind === "land-failed" && r.reason).toMatch(/conflict/);
  });
});

// roborev 54225-2. These used to assert `resolves.toBeUndefined()` for a REJECTED push — i.e. they
// pinned the swallow. That assertion encoded the wrong behaviour (the caller then told the human the
// branch was "backed up to the remote" when nothing left the machine, with the worktree already
// gone), so it is deliberately replaced: save now reports what the push actually did, exactly as
// ship reports its ShipOutcome. The BRANCH is kept locally in every case, so a failed push is a
// reportable outcome, never a refusal.
describe("saveAgent", () => {
  it("reports the backup push it actually performed", async () => {
    await expect(saveAgent("/r", "a")).resolves.toMatchObject({ kind: "pushed", pushed: true });
    expect(branch.pushAgentBranch).toHaveBeenCalledWith("/r", "a");
  });

  it("reports a FAILED push instead of swallowing it — nothing reached the remote", async () => {
    vi.mocked(branch.pushAgentBranch).mockRejectedValue(new Error("offline"));
    await expect(saveAgent("/r", "a")).resolves.toMatchObject({
      kind: "push-failed",
      pushed: false,
      reason: expect.stringContaining("offline"),
    });
  });

  it("distinguishes 'no remote to back up to' from a push that failed", async () => {
    vi.mocked(branch.pushAgentBranch).mockResolvedValue("no-remote");
    await expect(saveAgent("/r", "a")).resolves.toMatchObject({
      kind: "no-remote",
      pushed: false,
    });
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
      return "deleted";
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
      return "deleted";
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

  // THE LEAK (2026-07-29 backlog cleanup): spin-down removed the worktree and branch but left the
  // bead untouched. Because the caller then drops the agent from the store, `syncBeadLifecycle` is
  // never invoked for it again — so the bead is unreachable by the ONLY code that could advance it
  // and sits at `in_progress` forever. That produced 74 orphaned beads (86% of the board's "Being
  // built" column). Closing here is the sole point where the agent is known to be going away.
  it("CLOSES each bead so spin-down can't orphan one at in_progress", async () => {
    vi.mocked(branch.deleteAgentBranchIfMerged).mockResolvedValue("deleted");
    await spinDownAgentGit({
      root: "/r",
      projectId: "p1",
      ids: ["parent", "w1"],
      beadIds: ["bd-parent", "bd-w1"],
      deleteBranch: true,
    });
    expect(beads.closeBead).toHaveBeenCalledWith("/r", "bd-parent");
    expect(beads.closeBead).toHaveBeenCalledWith("/r", "bd-w1");
    expect(beads.deleteBead).not.toHaveBeenCalled(); // close is reversible; delete is not
  });

  // An UNMERGED branch still closes its bead. The agent is gone either way, so nothing can ever
  // advance the bead again — leaving it open is not "preserving work", it is the orphan bug.
  it("closes the bead even when the branch was kept (not merged)", async () => {
    vi.mocked(branch.deleteAgentBranchIfMerged).mockResolvedValue("kept-not-merged");
    await spinDownAgentGit({
      root: "/r",
      projectId: "p1",
      ids: ["parent"],
      beadIds: ["bd-parent"],
      deleteBranch: true,
    });
    expect(beads.closeBead).toHaveBeenCalledWith("/r", "bd-parent");
  });

  it("is best-effort: a bead close failure never breaks the git teardown", async () => {
    vi.mocked(beads.closeBead).mockRejectedValue(new Error("no beads database found"));
    await expect(
      spinDownAgentGit({
        root: "/r",
        projectId: "p1",
        ids: ["parent"],
        beadIds: ["bd-parent"],
        deleteBranch: false,
      }),
    ).resolves.toBeUndefined();
    expect(worktree.removeAgentWorkspace).toHaveBeenCalledWith("/r", "p1", "parent");
  });

  it("tolerates a caller that passes no beadIds (agent never got a bead)", async () => {
    await spinDownAgentGit({ root: "/r", projectId: "p1", ids: ["parent"], deleteBranch: false });
    expect(beads.closeBead).not.toHaveBeenCalled();
  });
});
