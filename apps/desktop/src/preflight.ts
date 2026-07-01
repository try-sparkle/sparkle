import { invoke } from "@tauri-apps/api/core";

export interface ClaudeStatus {
  installed: boolean;
  /** Absolute path to the claude binary — pass to spawnPty to avoid PATH issues. */
  path: string | null;
  version: string | null;
}

/** Check whether the user's own Claude Code is installed (resolved via login shell). The path is
 *  cached per app session and resolved off the main thread. `version` is intentionally null on this
 *  hot path — use {@link claudeVersion} where a version is actually needed. */
export function checkClaude(): Promise<ClaudeStatus> {
  return invoke<ClaudeStatus>("claude_preflight");
}

/** Resolve the installed Claude Code version lazily (kept off the spawn hot path because it
 *  cold-boots node just to print a version). Null when not installed or the probe fails. */
export function claudeVersion(): Promise<string | null> {
  return invoke<string | null>("claude_version");
}

/** Clear the cached claude/node paths so the next preflight re-probes — e.g. after the user
 *  installs Claude Code (or Node) while the app is running. */
export function refreshPreflight(): Promise<void> {
  return invoke("refresh_preflight");
}

export interface ClaudeSessionInfo {
  hasSession: boolean;
  latestSessionId: string | null;
}

/** Combined session probe (single round-trip, off the main thread): whether this worktree already
 *  has a resumable `claude` conversation AND its newest session id. Both share ONE transcript-dir
 *  scan — this replaces awaiting {@link claudeHasSession} then {@link claudeLatestSessionId}
 *  serially on the spawn path. `configDir` resolves the account exactly like {@link claudeHasSession}. */
export function claudeSessionInfo(
  worktreePath: string,
  configDir?: string,
): Promise<ClaudeSessionInfo> {
  return invoke<ClaudeSessionInfo>("claude_session_info", { worktreePath, configDir });
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

/** The worktree's most-recent Claude session id (newest `<id>.jsonl` transcript stem), or null when
 * there is none. Used to spawn `claude --resume <id>` so the prior conversation is visibly redrawn
 * on app reopen instead of `--continue`'s blank prompt (bead sparkle-wwg7).
 *
 * `configDir` resolves the account exactly like {@link claudeHasSession} — pass the SAME value used
 * for the session check so the id is read from the right account's config dir. */
export function claudeLatestSessionId(
  worktreePath: string,
  configDir?: string,
): Promise<string | null> {
  return invoke<string | null>("claude_latest_session_id", { worktreePath, configDir });
}
