import { invoke } from "@tauri-apps/api/core";

export interface ClaudeStatus {
  installed: boolean;
  /** Absolute path to the claude binary — pass to spawnPty to avoid PATH issues. */
  path: string | null;
  version: string | null;
}

/** Check whether the user's own Claude Code is installed (resolved via login shell). */
export function checkClaude(): Promise<ClaudeStatus> {
  return invoke<ClaudeStatus>("claude_preflight");
}
