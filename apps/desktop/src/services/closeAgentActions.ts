// Side-effecting orchestration for the close-agent Ship / Save / Discard flow. Kept OUT of the
// AgentSidebar component so the branching (push vs no-remote land, conditional bead close/deliver,
// worktree-before-branch delete ordering) is unit-testable by mocking these service imports. None of
// these touch the zustand stores — the caller does store teardown (close/removeAgent) around them.
import {
  landAgentBranch,
  pushAgentBranch,
  openAgentPr,
  deleteAgentBranch,
  deleteAgentBranchIfMerged,
} from "./branchStatus";
import { closeBead, markBeadDelivered, recordBeadMergeSha, deleteBead } from "./beads";
import { removeAgentWorkspace } from "./worktree";

export interface ShipParams {
  root: string;
  agentId: string;
  targetBranch: string;
  prTitle: string;
  beadId?: string;
}

/** Ship the agent's work for review: push the branch + open a PR (so it goes through roborev, not
 *  straight to main). No remote ⇒ fall back to a local land onto `targetBranch`. The bead is updated
 *  only on a real outcome: `closed` when submitted via PR, `delivered` when it actually landed
 *  locally — and NOT touched if the local land failed (a conflict/dirty land keeps the branch but
 *  must not mark the work done). Best-effort: PR/bead errors are swallowed (the branch is safe). Does
 *  NOT tear down the agent — the caller does that after. */
export async function shipAgent(p: ShipParams): Promise<void> {
  const pushed = await pushAgentBranch(p.root, p.agentId);
  if (pushed === "no-remote") {
    const r = await landAgentBranch(p.root, p.agentId, p.targetBranch, false);
    if (!r.ok) {
      console.warn("ship-on-close: local land failed (branch kept):", r.reason);
      return; // do NOT close/deliver the bead — the work didn't land
    }
    if (p.beadId) {
      // Record the exact commit the branch landed as BEFORE marking delivered, so the delivery
      // monitor can test that SHA for release containment (Task B). The PR path can't do this — its
      // merge happens later on GitHub — so only a local land carries a SHA (honest).
      await recordBeadMergeSha(p.root, p.beadId, r.mergeSha).catch(() => {});
      await markBeadDelivered(p.root, p.beadId).catch(() => {}); // landed on main
    }
    return;
  }
  // Pushed to the remote → open a PR for review. Only mark the bead closed (submitted for review) if
  // the PR actually opened: a hard gh failure (missing/unauthed) leaves the work merely pushed, not
  // under review, so the board must not show it closed. (Trade-off: a pre-existing PR makes gh error,
  // so that rare case leaves the bead in_progress rather than falsely-closed — under-report, not
  // over-report.) The branch is safe on the remote either way, so we still tear the agent down.
  const prOpened = await openAgentPr(p.root, p.agentId, p.targetBranch, p.prTitle)
    .then(() => true)
    .catch(() => false);
  if (prOpened && p.beadId) await closeBead(p.root, p.beadId).catch(() => {});
}

/** Save for later: back the branch up to the remote when one exists (best-effort); the caller keeps
 *  the branch + bead and removes the worktree. */
export async function saveAgent(root: string, agentId: string): Promise<void> {
  await pushAgentBranch(root, agentId).catch(() => {});
}

export interface DiscardParams {
  root: string;
  projectId: string;
  ids: string[]; // the agent + its workers — every worktree/branch to remove
  beadIds: string[]; // the agent's AND its workers' beads — all deleted (workers carry their own)
}

/** Discard git + bead state permanently: remove each worktree, THEN delete each branch (git refuses
 *  to delete a checked-out branch, so order matters), then delete every bead — the parent's and its
 *  workers'. Each step is best-effort. Does NOT touch the store — the caller removes the agents. */
export async function discardAgentGit(p: DiscardParams): Promise<void> {
  for (const cid of p.ids) {
    await removeAgentWorkspace(p.root, p.projectId, cid).catch(() => {});
    await deleteAgentBranch(p.root, cid).catch(() => {});
  }
  for (const bid of p.beadIds) await deleteBead(p.root, bid).catch(() => {});
}

export interface SpinDownGitParams {
  root: string;
  projectId: string;
  ids: string[]; // the build agent + its workers — every worktree to remove
  deleteBranch: boolean; // safe-delete each merged branch after its worktree is gone
}

/** Git teardown for closing a shipped build agent: remove each worktree, and (when configured)
 *  SAFELY delete each now-merged branch — `deleteAgentBranchIfMerged` uses `git branch -d`, which
 *  refuses to delete an unmerged branch, so this can never lose work. Worktree-then-branch ordering
 *  matters (git refuses to delete a checked-out branch). Each step is best-effort; does NOT touch
 *  the stores — the caller removes the agents. */
export async function spinDownAgentGit(p: SpinDownGitParams): Promise<void> {
  for (const cid of p.ids) {
    await removeAgentWorkspace(p.root, p.projectId, cid).catch(() => {});
    if (p.deleteBranch) await deleteAgentBranchIfMerged(p.root, cid).catch(() => {});
  }
}
