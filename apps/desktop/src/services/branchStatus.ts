// Frontend bridge to the Rust base/status/refresh commands. The `busy` pre-check lives here
// (Rust can't see the PTY) so a click that races the disabled button still can't rebase under
// a live agent. Per-agent ops carry `projectId` because the worktree lives OUTSIDE the project
// (in app-data) and is keyed by project id.
import { invoke } from "@tauri-apps/api/core";

export interface BranchStatus {
  ahead: number;
  behind: number;
  // Uncommitted changes present in the agent's worktree — the RAW reading, deliberately not
  // filtered by `worktreeOnBranch`. See that field for who must filter it and who must not.
  dirty: boolean;
  filesChanged: number;
  insertions: number;
  deletions: number;
  // Is the worktree actually on `sparkle/agent-<id>`? Normally true. False when something moved
  // it off its own branch — the old `land.sh` checked `main` out into agent worktrees
  // (sparkle-rhgm), and a manual checkout does it too. Optional so a Rust build predating the
  // field deserializes to undefined (same back-compat shape as WorkflowState's optionals).
  //
  // Every other field here is derived from the branch REF and is immune to this. `dirty` is the
  // sole exception, and the two consumers need OPPOSITE things from it:
  //   - ATTRIBUTION (stage, bead lifecycle): a parked tree's dirt is some other branch's, so it
  //     must not count as this agent's work — gate on `worktreeOnBranch !== false`.
  //   - SAFETY (close prompt): parking CARRIES uncommitted files along, so they are still there
  //     and still the user's. Never suppress dirty here; treat a parked tree as work-at-risk.
  // Read `false` as "not this branch's tree", and `undefined` as "unknown" — neither is
  // evidence the tree is clean.
  worktreeOnBranch?: boolean;
  // WHICH files are uncommitted — porcelain paths, capped at Rust's STATUS_DIRTY_FILES_CAP (5),
  // already .gitignore-filtered by `git status --porcelain` itself. Empty whenever `dirty` is false.
  //
  // WHY IT EXISTS (sparkle-biezi): "Local: Uncommitted" told the founder an agent was holding unsaved
  // work and named no file, so a forgotten fix and a leftover build artifact read identically and the
  // row could not be acted on without opening a terminal. A row that claims uncommitted work must be
  // able to say which.
  //
  // Optional so a Rust build predating the field deserializes to undefined — and `undefined` means
  // "this build cannot tell you", NOT "no files". Only an empty array on a `dirty: true` reading
  // means "dirty but the names were capped away", which cannot happen (the cap is >= 1).
  //
  // SAME `worktreeOnBranch` CAVEAT AS `dirty`, and it bites harder here: a parked tree's files belong
  // to whatever branch got checked out into it, so naming them on this row attributes another
  // branch's work to this agent BY NAME. Filter on `worktreeOnBranch !== false` wherever you would
  // have filtered `dirty`.
  dirtyFiles?: string[];
  // The TRUE number of uncommitted paths, which may exceed `dirtyFiles.length`. A "+N more"
  // affordance must count from THIS; `dirtyFiles` is a preview, not an inventory.
  dirtyCount?: number;
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
  // The agent branch has been PUSHED to origin (its remote-tracking ref exists) — drives the "Pushed"
  // stage LIVE even before any PR. Local/offline; reflects a push made from this repo. Optional so a
  // Rust build predating the field deserializes to falsy (see Rust `branch_pushed`).
  pushed?: boolean;
  // The agent's work is SHIPPED — its tip is contained in a published release tag — drives the top
  // "Shipped to Production" stage LIVE (previously unreachable). Optional for the same back-compat
  // reason. Tip-relative, so a squash-landed branch reads false here (see Rust `tip_in_release`).
  //
  // Rust suppresses this (and the tip-relative PR probe behind `prState`) for a branch that has
  // authored NOTHING — otherwise both describe the commit it was cut from, i.e. main's history, and
  // a seconds-old agent reads as shipped/merged. See `branch_carries_no_own_work` in worktree.rs.
  shipped?: boolean;
  // The repo has an `origin` remote. Gated on `probePrState` in Rust (like the PR probe), so a
  // fast/local poll reports false. Optional for the same back-compat reason as landed/pushed/shipped
  // (a Rust build predating the field → falsy).
  //
  // ONLY `true` CARRIES INFORMATION. `false` is ambiguous and is NOT evidence of a remoteless repo:
  // Rust sends false both for "probed, no origin" and "didn't probe", and those are indistinguishable
  // at this boundary — so no amount of store-side bookkeeping can recover the difference. Read it as
  // "not known to have a remote". runtimeStore latches an observed true for exactly this reason, and
  // deriveCta requires `=== true` before asking for a push, failing safe to Close otherwise.
  hasRemote?: boolean;
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
  /** The agent's project. Rust needs it to locate the worktree, which is what lets a RENAMED
   *  branch resolve at all (see Rust `resolve_agent_branch`). Omitting it falls back to the minted
   *  `sparkle/agent-<id>` name — which reads as "no branch yet" for a renamed branch, i.e. the
   *  zeroed state that renders committed work as "Unsaved". Pass it whenever you have it. */
  projectId?: string,
): Promise<WorkflowState> {
  return invoke<WorkflowState>("agent_workflow_state", {
    root,
    projectId: projectId ?? null,
    agentId,
    parentBranch,
    probePrState,
  });
}

/** Outcome of a local Land (merge an agent's branch into its integration target). On failure,
 *  `reason` is one of: no-target | no-branch | nothing-to-land | target-not-checked-out | dirty |
 *  conflict; `files` lists conflicted paths for the conflict case. */
export type LandResult =
  | {
      ok: true;
      target: string;
      // The merge commit this land created on `target`. Recorded on the bead so the delivery
      // monitor can test that exact commit for release containment (Task B). Optional so a Rust
      // build predating the field deserializes to undefined (treated as "no SHA yet" — honest).
      mergeSha?: string;
    }
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

/**
 * WHAT A DELETE ACTUALLY DID (Rust `BranchDeleteOutcome`). Both delete commands RESOLVE in cases
 * where the branch is still on disk — the merged-only one keeps an unlanded branch by design, and
 * both are idempotent for a branch that was already gone — so "the promise resolved" is not evidence
 * the ref was destroyed. Read this, never the fact that it resolved.
 *
 * A Rust build predating the field resolves `undefined` here; treat that as UNKNOWN, not as a
 * delete (the type says so via `| undefined` at the call sites that care).
 */
export type BranchDeleteOutcome = "deleted" | "already-absent" | "kept-not-merged";

/** Delete an agent's local branch (close-agent Discard). Force-deletes (`git branch -D`) — that is
 *  what Discard means. Idempotent: an already-absent branch resolves `"already-absent"` rather than
 *  claiming a delete. The worktree must be removed first (git refuses to delete a checked-out
 *  branch). */
export function deleteAgentBranch(
  root: string,
  agentId: string,
): Promise<BranchDeleteOutcome | undefined> {
  return invoke<BranchDeleteOutcome | undefined>("delete_agent_branch", { root, agentId });
}

/** SAFELY delete an agent's merged branch (close a shipped agent). NOT `git branch -d`: it tests
 *  ancestry OR merge-equivalence against the project's default branch (so a squash/rebase merge is
 *  recognized, which `-d` refuses) and then force-deletes. An unlanded branch is simply KEPT, and
 *  resolves `"kept-not-merged"` — a success, but a different one from `"deleted"`, and the caller
 *  must not conflate them. Idempotent; remove the worktree first. */
export function deleteAgentBranchIfMerged(
  root: string,
  agentId: string,
): Promise<BranchDeleteOutcome | undefined> {
  return invoke<BranchDeleteOutcome | undefined>("delete_agent_branch_if_merged", {
    root,
    agentId,
  });
}

/** Open a GitHub PR for an agent's branch (close-agent Ship). Resolves the PR URL; rejects when gh
 *  is missing/unauthed, there's no remote, or a PR already exists. Push first.
 *
 *  `projectId` is what makes the resulting PR resolvable back to this agent later: Rust records the
 *  (project, PR number) → agent mapping the moment `gh` returns a URL, and embeds the same pair as a
 *  marker in the PR body. Without it the PR would be owner-less the instant its branch is renamed. */
export function openAgentPr(
  root: string,
  projectId: string,
  agentId: string,
  targetBranch: string,
  title: string,
): Promise<string> {
  return invoke<string>("open_agent_pr", { root, projectId, agentId, targetBranch, title });
}

export type RefreshResult =
  | { ok: true; ahead: number; behind: number }
  | { ok: false; reason: "dirty" | "busy" | "conflict"; files?: string[] };

/** Auto-detect the project's integration branch (logical name). */
export function resolveDefaultBranch(root: string): Promise<string> {
  return invoke<string>("project_default_branch", { root });
}

/**
 * Reconcile a project's persisted integration branch against the repo: keep `recorded` when it
 * still resolves (a deliberate choice is preserved), otherwise return the repo's actual default so
 * a drifted/renamed/empty value can be re-persisted. Pass "" for an unset default.
 */
export function reconcileDefaultBranch(root: string, recorded: string): Promise<string> {
  return invoke<string>("reconcile_default_branch", { root, recorded });
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

/** One agent's inputs for the batched project poll (sparkle-zlic). `parentBranch` is the
 *  orchestrator branch for a worker (empty otherwise); `force` tells Rust to always recompute this
 *  agent (set true while it's actively working so dirty/ahead stay fresh) rather than skip it. */
export interface AgentStatusInput {
  agentId: string;
  baseBranch: string;
  parentBranch: string;
  kind: string;
  force: boolean;
}

/** One agent's result from the batched poll. `changed === false` means nothing moved since the last
 *  tick and the caller should keep its prior store values (branch/workflow are then null). */
export interface AgentStatusResult {
  agentId: string;
  changed: boolean;
  branch: BranchStatus | null;
  workflow: WorkflowState | null;
  /** true ⇒ this agent's worktree directory is GONE / no longer a git repo (a permanent condition).
   *  The caller latches it into the dead-worktree skip-set and stops polling it, so the batch stops
   *  re-shelling `git status` against a dead path every tick (). */
  gone?: boolean;
}

/** Branch + workflow status for ALL of a project's agents in ONE Rust call (sparkle-zlic): shared
 *  repo discovery, memoized base resolution, and fingerprint-skip of unchanged idle agents, instead
 *  of fanning out ~3-4 subprocesses per agent every tick. `probePrState` gates the origin fetch + gh
 *  PR probe (pass false on a fast/local poll). Never throws on a per-agent git error — that agent is
 *  reported `changed:false`. */
export function projectAgentsStatus(
  root: string,
  projectId: string,
  agents: AgentStatusInput[],
  probePrState: boolean,
): Promise<AgentStatusResult[]> {
  return invoke<AgentStatusResult[]>("project_agents_status", {
    root,
    projectId,
    agents,
    probePrState,
  });
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
