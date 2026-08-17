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
  /** Scopes the durable PR→agent record written when the PR opens, so the PR stays resolvable to
   *  this agent no matter what its branch is called (or is later renamed to). */
  projectId: string;
  agentId: string;
  targetBranch: string;
  prTitle: string;
  beadId?: string;
}

/**
 * What a ship actually DID. Returned rather than swallowed because only ONE of these four outcomes
 * is "shipped, PR opened", and three of them used to be indistinguishable from it at the call site:
 * a `gh` failure and a failed local land both returned normally, so a caller that inferred success
 * from the absence of a throw reported a PR that does not exist (roborev 54175).
 *
 * `pushed` / `prOpened` / `landed` are spelled out alongside `kind` so a caller can ask the flat
 * question ("is the work safe off this machine?" → `pushed || landed`) without re-deriving it from
 * the tag.
 */
export type ShipOutcome =
  /** Pushed to the remote and a PR is open — the full outcome; the bead is closed. */
  | { kind: "pr-opened"; pushed: true; prOpened: true; landed: false; prUrl: string | null }
  /** Pushed, but `gh` refused (missing/unauthed, or a PR already exists). The BRANCH is safe on the
   *  remote; nothing is under review. */
  | { kind: "pushed-no-pr"; pushed: true; prOpened: false; landed: false; reason: string }
  /** No remote, so the branch was merged locally onto `targetBranch`; the bead is delivered. */
  | { kind: "landed"; pushed: false; prOpened: false; landed: true; mergeSha: string | null }
  /** No remote AND the local land failed (conflict / dirty / target not checked out). NOTHING
   *  happened: the branch is kept and the bead is untouched. */
  | { kind: "land-failed"; pushed: false; prOpened: false; landed: false; reason: string };

/** Ship the agent's work for review: push the branch + open a PR (so it goes through roborev, not
 *  straight to main). No remote ⇒ fall back to a local land onto `targetBranch`. The bead is updated
 *  only on a real outcome: `closed` when submitted via PR, `delivered` when it actually landed
 *  locally — and NOT touched if the local land failed (a conflict/dirty land keeps the branch but
 *  must not mark the work done). Best-effort: PR/bead errors are swallowed (the branch is safe) — but
 *  they are REPORTED in the returned {@link ShipOutcome}, so a caller can say what really happened
 *  instead of assuming. Only a push failure still throws. Does NOT tear down the agent — the caller
 *  does that after. */
export async function shipAgent(p: ShipParams): Promise<ShipOutcome> {
  const pushed = await pushAgentBranch(p.root, p.agentId);
  if (pushed === "no-remote") {
    const r = await landAgentBranch(p.root, p.agentId, p.targetBranch, false);
    if (!r.ok) {
      console.warn("ship-on-close: local land failed (branch kept):", r.reason);
      // do NOT close/deliver the bead — the work didn't land
      return { kind: "land-failed", pushed: false, prOpened: false, landed: false, reason: r.reason };
    }
    if (p.beadId) {
      // Record the exact commit the branch landed as BEFORE marking delivered, so the delivery
      // monitor can test that SHA for release containment (Task B). The PR path can't do this — its
      // merge happens later on GitHub — so only a local land carries a SHA (honest).
      await recordBeadMergeSha(p.root, p.beadId, r.mergeSha).catch(() => {});
      await markBeadDelivered(p.root, p.beadId).catch(() => {}); // landed on main
    }
    return {
      kind: "landed",
      pushed: false,
      prOpened: false,
      landed: true,
      mergeSha: r.mergeSha ?? null,
    };
  }
  // Pushed to the remote → open a PR for review. Only mark the bead closed (submitted for review) if
  // the PR actually opened: a hard gh failure (missing/unauthed) leaves the work merely pushed, not
  // under review, so the board must not show it closed. (Trade-off: a pre-existing PR makes gh error,
  // so that rare case leaves the bead in_progress rather than falsely-closed — under-report, not
  // over-report.) The branch is safe on the remote either way, so the caller still tears the agent
  // down — but it is told `prOpened: false` so it doesn't announce a review that isn't happening.
  const pr = await openAgentPr(p.root, p.projectId, p.agentId, p.targetBranch, p.prTitle)
    .then((url) => ({ ok: true as const, url }))
    .catch((e: unknown) => ({ ok: false as const, reason: e instanceof Error ? e.message : String(e) }));
  if (!pr.ok) {
    return { kind: "pushed-no-pr", pushed: true, prOpened: false, landed: false, reason: pr.reason };
  }
  if (p.beadId) await closeBead(p.root, p.beadId).catch(() => {});
  return { kind: "pr-opened", pushed: true, prOpened: true, landed: false, prUrl: pr.url ?? null };
}

/**
 * What a save actually DID with the branch, in the same spirit as {@link ShipOutcome} (roborev
 * 54225). A save's sentence to the human — "backed the branch up to the remote and kept it" — is a
 * claim about the NETWORK, and it is made after the worktree has already been removed. The push was
 * previously `.catch(() => {})`d, so offline / unauthed / rejected all returned exactly like a
 * successful backup and the claim was made anyway.
 *
 * None of these is a failure of the save: the branch and the bead survive on this machine in every
 * case, which is what save promises. What changes is only what the caller may SAY. `pushed` is
 * spelled out alongside `kind` so a caller can ask the flat question ("is a copy off this machine?")
 * without re-deriving it from the tag.
 */
export type SaveOutcome =
  /** The branch reached the remote — a real backup exists. */
  | { kind: "pushed"; pushed: true }
  /** The repo has no remote, so there was nowhere to back it up TO. Not an error. */
  | { kind: "no-remote"; pushed: false }
  /** A remote exists but the push failed (offline, auth, rejected). Nothing left the machine. */
  | { kind: "push-failed"; pushed: false; reason: string };

/** Save for later: back the branch up to the remote when one exists (best-effort); the caller keeps
 *  the branch + bead and removes the worktree. Never throws — a failed push is REPORTED in the
 *  returned {@link SaveOutcome} rather than swallowed, so the caller can say whether the backup
 *  actually happened instead of assuming it from the absence of an exception. */
export async function saveAgent(root: string, agentId: string): Promise<SaveOutcome> {
  try {
    const pushed = await pushAgentBranch(root, agentId);
    return pushed === "no-remote" ? { kind: "no-remote", pushed: false } : { kind: "pushed", pushed: true };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.warn("save-on-close: backup push failed (branch kept locally):", reason);
    return { kind: "push-failed", pushed: false, reason };
  }
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
  /** The agent's AND its workers' beads — all CLOSED (not deleted; close is reversible). Optional
   *  because an agent that never reached `building_unsaved` never got a bead. */
  beadIds?: string[];
  deleteBranch: boolean; // safe-delete each merged branch after its worktree is gone
}

/** Git teardown for closing a shipped build agent: remove each worktree, and (when configured)
 *  SAFELY delete each now-merged branch — `deleteAgentBranchIfMerged` KEEPS a branch whose work
 *  isn't on the default branch (it tests ancestry OR merge-equivalence, so a squash merge counts,
 *  unlike `git branch -d`), so this can never lose work. Worktree-then-branch ordering matters (git
 *  refuses to delete a checked-out branch). Each step is best-effort — the resolved
 *  `BranchDeleteOutcome` is deliberately ignored HERE (nothing acts on it), which is not licence for
 *  a caller that reports the result to a human to do the same. Does NOT touch the stores — the
 *  caller removes the agents.
 *
 *  Also CLOSES every bead, which is the fix for the orphan leak: the caller drops the agent from the
 *  store immediately after this, and `syncBeadLifecycle` only ever runs for agents still IN the
 *  store — so this is the last moment anything can advance the bead. Skipping it left 74 beads
 *  parked at `in_progress` forever (86% of the board's "Being built" column, cleaned up 2026-07-29).
 *  Closed, not DELETED: `bd reopen` makes a wrong call recoverable, and unlike Discard this path is
 *  not a "throw the work away" gesture. Unmerged branches close their bead too — the agent is gone
 *  either way, so an open bead would just be an orphan nobody can act on. Best-effort like the rest,
 *  so a project without a beads DB (bd is optional) never breaks the git teardown. */
export async function spinDownAgentGit(p: SpinDownGitParams): Promise<void> {
  for (const cid of p.ids) {
    // `snapshotWip` — this path KEEPS every branch (that is what distinguishes it from discard), so
    // an uncommitted edit in any of these worktrees is about to be destroyed with nothing left to
    // recover it. `p.ids` is the build agent AND its workers, and a worker is the likeliest holder
    // of uncommitted work here: closing a build agent with the × tears down workers that were never
    // spun down individually, which reproduced bead sparkle-ovzoj through this path unchanged
    // (roborev 64446).
    await removeAgentWorkspace(p.root, p.projectId, cid, { snapshotWip: true }).catch(() => {});
    if (p.deleteBranch) await deleteAgentBranchIfMerged(p.root, cid).catch(() => {});
  }
  for (const bid of p.beadIds ?? []) await closeBead(p.root, bid).catch(() => {});
}
