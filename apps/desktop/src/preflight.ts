import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

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

/** Clear the cached claude/node/git paths so the next preflight re-probes — e.g. after the user
 *  installs Claude Code (or Node/git) while the app is running. */
export function refreshPreflight(): Promise<void> {
  return invoke("refresh_preflight");
}

// ── First-run install-readiness (setup checklist) ─────────────────────────────────────────────

/** Generic install status for a runtime prerequisite (node/git). Mirrors Rust `PrereqStatus`. */
export interface PrereqStatus {
  installed: boolean;
  path: string | null;
}

/** Combined first-run probe for all three prerequisites in one round-trip (Rust `prereqs_preflight`). */
export interface PrereqsReport {
  claude: PrereqStatus;
  node: PrereqStatus;
  git: PrereqStatus;
}

/** Detect claude + node + git in a single IPC call — drives the setup checklist's initial pass. */
export function checkPrereqs(): Promise<PrereqsReport> {
  return invoke<PrereqsReport>("prereqs_preflight");
}

/** Re-probe just node. Provided for parity with {@link checkGit} and future poll-after-install use;
 *  the setup checklist currently resolves node via {@link installNode}'s returned path directly. */
export function checkNode(): Promise<PrereqStatus> {
  return invoke<PrereqStatus>("node_preflight");
}

/** Whether the user has actually completed `claude login` for the default config dir — checks that
 *  Claude Code recorded an authenticated identity (`oauthAccount.emailAddress` in `.claude.json`),
 *  NOT merely that the `claude` binary exists. Drives real sign-in detection in the setup checklist. */
export function checkClaudeSignedIn(configDir?: string): Promise<boolean> {
  return invoke<boolean>("claude_signed_in", { configDir });
}

/** Re-probe just git (used to POLL for CLT-install completion, which is user-driven and slow). */
export function checkGit(): Promise<PrereqStatus> {
  return invoke<PrereqStatus>("git_preflight");
}

/** Auto-install Node.js (official nodejs.org tarball → ~/.local, no sudo). Resolves to the absolute
 *  `node` path; rejects with a guidance string on failure. Streams via {@link onSetupProgress}. */
export function installNode(): Promise<string> {
  return invoke<string>("install_node");
}

/** Auto-install Claude Code via the official `curl … | bash` installer (~/.local/bin, no sudo).
 *  Resolves to the absolute `claude` path; rejects with guidance on failure. */
export function installClaudeCode(): Promise<string> {
  return invoke<string>("install_claude_code");
}

/** Outcome of triggering the git install (Rust `GitInstallResult`). */
export interface GitInstallResult {
  /** "already-installed" | "triggered" | (guidance error rejects the promise). */
  status: string;
  path: string | null;
}

/** Trigger a non-sudo git install. On macOS this opens Apple's Command Line Tools GUI installer and
 *  returns `{status:"triggered"}` — the caller then polls {@link checkGit} until git resolves. */
export function installGit(): Promise<GitInstallResult> {
  return invoke<GitInstallResult>("install_git");
}

/** A streamed installer status line (Rust `setup:progress` event payload). */
export interface SetupProgress {
  /** "claude" | "node" | "git". */
  prereq: string;
  message: string;
}

/** Subscribe to install progress lines. Returns an unlisten fn. */
export function onSetupProgress(cb: (p: SetupProgress) => void): Promise<UnlistenFn> {
  return listen<SetupProgress>("setup:progress", (ev) => cb(ev.payload));
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
