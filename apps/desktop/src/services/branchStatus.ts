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
