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

/** True if this worktree already has a prior `claude` conversation we can resume
 * (drives `claude --continue` vs a fresh `claude` when (re)opening an agent).
 *
 * `configDir` is the chosen account's CLAUDE_CONFIG_DIR (multi Claude Max support). Because the
 * spawn sets it on the child only — not Sparkle's own env — the resume check must look under the
 * SAME account, else it would miss (or falsely find) a session under the wrong config dir. Omit
 * it to fall back to Sparkle's process env (the pre-accounts behavior). */
export function claudeHasSession(worktreePath: string, configDir?: string): Promise<boolean> {
  return invoke<boolean>("claude_has_session", { worktreePath, configDir });
}
