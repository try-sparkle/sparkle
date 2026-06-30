// Frontend bridge to the Rust base/status/refresh commands. The `busy` pre-check lives here
// (Rust can't see the PTY) so a click that races the disabled button still can't rebase under
// a live agent. Per-agent ops carry `projectId` because the worktree lives OUTSIDE the project
// (in app-data) and is keyed by project id.
import { invoke } from "@tauri-apps/api/core";

export interface BranchStatus {
  ahead: number;
  behind: number;
  dirty: boolean;
  filesChanged: number;
  insertions: number;
  deletions: number;
}

/** Land-to-green workflow signals for an agent branch (see Rust `agent_workflow_state`). All
 *  reachability is computed from LOCAL refs (no fetch); `prState` is a best-effort GitHub probe. */
export interface WorkflowState {
  inLocalMain: boolean; // agent tip contained in the local default branch
  inOriginMain: boolean; // …in origin/<default> as of the last fetch
  inParent: boolean; // …in the parent/orchestrator branch (workers only)
  aheadOfBase: number; // commits the agent authored, vs the ref it was cut from — origin/<default> when present, else local (>0 ⇒ real unlanded work)
  // The branch's WORK has landed via a SQUASH/REBASE merge: its tip commit isn't an ancestor of the
  // integration branch (so inLocalMain/inOriginMain are both false), but merging it in would add
  // nothing — its work is already there. Squash-merge defeats ancestor reachability; this catches it
  // and survives an advancing default (see Rust `merge_adds_nothing`). Gated by committedSeen
  // downstream so a no-op branch (also trivially adds nothing) can't claim it landed. Optional in the
  // type so a Rust build that predates the field deserializes to falsy.
  landed?: boolean;
  prState: "open" | "merged" | "closed" | null; // GitHub PR state for the branch, if any
  prNumber: number | null;
  prUrl: string | null;
}

/** Live workflow-state signals for an agent. `parentBranch` is the orchestrator's branch for
 *  workers (empty string otherwise). `probePrState` gates the gh network probe — pass false on a
 *  remoteless project or a fast poll to stay purely local. Best-effort: never throws on a missing
 *  branch (returns an all-empty state). Reachability is keyed off the in-repo branch ref, so no
 *  projectId/worktree path is needed. */
export function agentWorkflowState(
  root: string,
  agentId: string,
  parentBranch: string,
  probePrState: boolean,
): Promise<WorkflowState> {
  return invoke<WorkflowState>("agent_workflow_state", {
    root,
    agentId,
    parentBranch,
    probePrState,
  });
}

/** Outcome of a local Land (merge an agent's branch into its integration target). On failure,
 *  `reason` is one of: no-target | no-branch | nothing-to-land | target-not-checked-out | dirty |
 *  conflict; `files` lists conflicted paths for the conflict case. */
export type LandResult =
  | { ok: true; target: string }
  | {
      ok: false;
      reason:
        | "busy" // frontend gate: a live PTY on the target tree
        | "no-target"
        | "no-branch"
        | "nothing-to-land"
        | "target-not-checked-out"
        | "dirty"
        | "conflict"
        | "merge-failed"; // non-conflict merge failure (git errored / failed to spawn)
      files: string[];
    };

/** Merge an agent's branch into its integration target LOCALLY (worker → orchestrator branch;
 *  build → project default). Refuses a dirty target and aborts cleanly on conflict. `isBusy` is the
 *  caller's PTY-busy gate for the TARGET agent (e.g. a worker's orchestrator) — a live agent on the
 *  target tree must not be merged under. */
export async function landAgentBranch(
  root: string,
  agentId: string,
  targetBranch: string,
  isBusy: boolean,
): Promise<LandResult> {
  if (isBusy) return { ok: false, reason: "busy", files: [] };
  return invoke<LandResult>("land_agent_branch", { root, agentId, targetBranch });
}

/** Push an agent's branch to origin (close-agent Ship/Save). Resolves "pushed" | "no-remote";
 *  rejects with git's message on auth/network failure. */
export function pushAgentBranch(root: string, agentId: string): Promise<string> {
  return invoke<string>("push_agent_branch", { root, agentId });
}

/** Delete an agent's local branch (close-agent Discard). Idempotent. The worktree must be removed
 *  first (git refuses to delete a checked-out branch). */
export function deleteAgentBranch(root: string, agentId: string): Promise<void> {
  return invoke<void>("delete_agent_branch", { root, agentId });
}

/** SAFELY delete an agent's merged branch (close a shipped agent). Uses `git branch -d`, which
 *  refuses to delete a branch that isn't actually merged, so this can never lose unmerged work —
 *  an unmerged branch is simply kept. Idempotent; remove the worktree first. */
export function deleteAgentBranchIfMerged(root: string, agentId: string): Promise<void> {
  return invoke<void>("delete_agent_branch_if_merged", { root, agentId });
}

/** Open a GitHub PR for an agent's branch (close-agent Ship). Resolves the PR URL; rejects when gh
 *  is missing/unauthed, there's no remote, or a PR already exists. Push first. */
export function openAgentPr(
  root: string,
  agentId: string,
  targetBranch: string,
  title: string,
): Promise<string> {
  return invoke<string>("open_agent_pr", { root, agentId, targetBranch, title });
}

export type RefreshResult =
  | { ok: true; ahead: number; behind: number }
  | { ok: false; reason: "dirty" | "busy" | "conflict"; files?: string[] };

/** Auto-detect the project's integration branch (logical name). */
export function resolveDefaultBranch(root: string): Promise<string> {
  return invoke<string>("project_default_branch", { root });
}

/** Live ahead/behind/dirty/size for an agent vs its own baseBranch (no network). */
export function agentBranchStatus(
  root: string,
  projectId: string,
  agentId: string,
  baseBranch: string,
): Promise<BranchStatus> {
  return invoke<BranchStatus>("agent_branch_status", { root, projectId, agentId, baseBranch });
}

/** Rebase the agent branch onto its fresh base. Refuses when the agent is busy (frontend gate). */
export async function refreshAgentBranch(
  root: string,
  projectId: string,
  agentId: string,
  baseBranch: string,
  isBusy: boolean,
): Promise<RefreshResult> {
  if (isBusy) return { ok: false, reason: "busy" };
  return invoke<RefreshResult>("refresh_agent_branch", { root, projectId, agentId, baseBranch });
}
