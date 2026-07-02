// Pure helpers for building the `claude` launch command. Kept separate from
// AgentPane so the resume/fresh branching (bead ) is unit-testable
// without rendering the component.

import { DEFAULT_MODEL_ID } from "./models";

/** macOS login shell we launch `claude` (and shell commands) through, as `zsh -l -c 'exec …'`: a
 *  login but NON-interactive shell, so it sources `.zprofile`/`.zlogin` for the user's real PATH/env
 *  but not `.zshrc`. Shared by every spawn path (AgentPane, orchestrationLaunch, the account-login
 *  modal) so the launcher can't silently diverge between them. */
export const SHELL = "/bin/zsh";

/** Single-quote a path for safe use inside a `zsh -c '…'` string. */
export function shellQuote(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

/** Extra launch knobs used by special agents (e.g. the Sparkle self-improvement agent). All
 *  optional so the common path — `buildClaudeExec(path, resume)` — is unchanged. */
export interface ClaudeExecOpts {
  /** Persona/instructions merged into Claude's system prompt (`--append-system-prompt`). */
  appendSystemPrompt?: string;
  /** Extra directories Claude may read outside its worktree (`--add-dir`), e.g. the log dir. */
  addDirs?: string[];
  /** A one-shot prompt submitted on launch so the agent starts working immediately. Only
   *  passed on a FRESH session — on `--continue` the prior conversation resumes instead. */
  initialPrompt?: string;
  /** The worktree's most-recent Claude session id. When `resume` is true and this is set, we spawn
   *  `--resume <id>` instead of `--continue` so Claude visibly REDRAWS the prior conversation on
   *  reopen (bead sparkle-wwg7). Same session `--continue` would resume — just invoked so the
   *  transcript is painted. Empty/absent → fall back to `--continue` (e.g. the lookup failed or the
   *  transcript was cleaned up after a long gap). */
  resumeSessionId?: string;
  /** Inline JSON passed to `claude --mcp-config` (an MCP servers config). Variadic flag, so it is
   *  always followed by `--strict-mcp-config` (a flag) before any positional prompt. */
  mcpConfig?: string;
  /** Emit `--strict-mcp-config` so ONLY the --mcp-config servers load (ignore user/global MCP). */
  strictMcpConfig?: boolean;
  /** Emit `--dangerously-skip-permissions` so the agent auto-approves every tool call instead of
   *  pausing on a permission prompt. Used for WORKER agents: they run unattended in a throwaway
   *  worktree with no human watching, so an approval prompt is a silent deadlock (the worker blocks
   *  RED, its orchestrator blocks in wait_for_workers). We deliberately do NOT set this for Think or
   *  orchestrator/Build agents — those are interactive and a human is present to approve. */
  dangerouslySkipPermissions?: boolean;
  /** The Claude model this agent runs (`--model <id>`, a services/models.ts id). Absent or the
   *  "default" sentinel → no flag, so the agent inherits the user's own Claude Code default. */
  model?: string;
  /** Per-spawn `CLAUDE_CONFIG_DIR` for multi Claude Max account support (design spec
   *  docs/superpowers/specs/2026-06-26-multi-max-account-design.md). When set, the exec exports it
   *  so the child `claude` authenticates from that account's isolated config dir — confined to the
   *  child process, never Sparkle's own env. Absent → claude uses its default (`~/.claude` or the
   *  inherited `$CLAUDE_CONFIG_DIR`), preserving today's behavior for users who never set this up. */
  configDir?: string;
}

/** Build the `exec …` string passed to `zsh -l -c`. Appends `--continue` only
 *  when a prior session exists for this worktree, so a fresh worktree (where
 *  `claude --continue` would error) starts plain `claude`.
 *
 *  We launch via `zsh -l -c`, which is a login but NON-interactive shell: it
 *  sources `.zprofile`/`.zlogin` but NOT `.zshrc`, where user tools are commonly
 *  added to PATH (e.g. `export PATH="$HOME/.local/bin:$PATH"`). Without that,
 *  the agent — and any git hooks the agent's commits trigger — can't find
 *  user-local tools like `roborev`. Prepend `~/.local/bin` so they can. */
export function buildClaudeExec(
  claudePath: string,
  resume: boolean,
  opts: ClaudeExecOpts = {},
): string {
  let cmd = `exec ${shellQuote(claudePath)}`;
  // Resume the prior conversation. Prefer `--resume <id>` so Claude REDRAWS the transcript on
  // reopen (the visible-history goal, bead sparkle-wwg7); fall back to `--continue` (resumes
  // context but lands on a blank prompt) when no session id is available — e.g. the lookup failed
  // or the transcript aged out. Both resume the same session; only the redraw differs.
  if (resume) {
    cmd += opts.resumeSessionId
      ? ` --resume ${shellQuote(opts.resumeSessionId)}`
      : " --continue";
  }
  // Auto-approve mode for unattended workers — placed right after resume so it applies whether the
  // worker is fresh or resumed. A flag (no argument), so it can sit anywhere in the option list.
  if (opts.dangerouslySkipPermissions) {
    cmd += " --dangerously-skip-permissions";
  }
  // Per-agent model selection (bead sparkle-i6rw). The "default" sentinel means "no flag" so the
  // agent inherits whatever the user's own Claude Code config says — same as before the feature.
  if (opts.model && opts.model !== DEFAULT_MODEL_ID) {
    cmd += ` --model ${shellQuote(opts.model)}`;
  }
  if (opts.mcpConfig) {
    cmd += ` --mcp-config ${shellQuote(opts.mcpConfig)}`;
    // --mcp-config is variadic (like --add-dir); a following flag terminates it. We always pair it
    // with --strict-mcp-config so a positional prompt can never be swallowed as another config.
    if (opts.strictMcpConfig) cmd += " --strict-mcp-config";
  }
  if (opts.appendSystemPrompt) {
    cmd += ` --append-system-prompt ${shellQuote(opts.appendSystemPrompt)}`;
  }
  for (const dir of opts.addDirs ?? []) {
    cmd += ` --add-dir ${shellQuote(dir)}`;
  }
  // The positional prompt auto-submits on launch. Skip it when resuming so we don't re-run
  // the mission on every relaunch — the resumed conversation already has the context.
  //
  // The leading `--` is load-bearing: `--add-dir` is a *variadic* claude flag, so commander
  // greedily consumes every following non-flag token as another directory. Without `--`, the
  // trailing prompt got swallowed as an `--add-dir` path and claude stat()'d it as a directory
  // — a ~370-char prompt blew past the 255-char filename limit → "ENAMETOOLONG … stat '<cwd>/
  // <prompt>'" and the agent never started. `--` ends option parsing so the prompt is read as
  // the positional it is (and, as a bonus, a prompt that happens to start with `-` is safe too).
  if (!resume && opts.initialPrompt) {
    cmd += ` -- ${shellQuote(opts.initialPrompt)}`;
  }
  // CLAUDE_CONFIG_DIR (when an account was chosen) is exported alongside PATH, before `exec`, so it
  // applies to the child `claude` only. Order doesn't matter to the shell, but we keep it first so a
  // reader sees the account selection up front.
  const configExport = opts.configDir
    ? `export CLAUDE_CONFIG_DIR=${shellQuote(opts.configDir)}; `
    : "";
  return `${configExport}export PATH="$HOME/.local/bin:$PATH"; ${cmd}`;
}

/** Build the `zsh -l -c` exec string that runs `claude login` — the interactive sign-in flow used
 *  by the first-run setup checklist. Like {@link buildClaudeExec} it prepends `~/.local/bin` to
 *  PATH so the `#!/usr/bin/env node` shebang in a freshly-installed `claude` resolves node. Kept
 *  here (not inline in the component) so the launcher stays consistent with every other spawn path
 *  and is unit-testable. `configDir` (optional) targets a specific account's config dir. */
export function buildClaudeLoginExec(claudePath: string, opts: { configDir?: string } = {}): string {
  const configExport = opts.configDir
    ? `export CLAUDE_CONFIG_DIR=${shellQuote(opts.configDir)}; `
    : "";
  return `${configExport}export PATH="$HOME/.local/bin:$PATH"; exec ${shellQuote(claudePath)} login`;
}

/** Build the inline JSON for `claude --mcp-config` that launches the Sparkle orchestrator MCP
 *  server (a stdio child) wired to this build agent's bridge. The bridge socket + token ride in
 *  the server's `env` block — confined to this child process, NOT exported into the build agent's
 *  shell (which would leak the token to every tool/subagent it runs). The server name
 *  ("sparkle-orchestrator") matches the McpServer name in apps/mcp-orchestrator.
 *
 *  Security note: the JSON (including the bridge token) is passed as a command-line argument to
 *  `claude`, so it is transiently visible in `ps aux` to other processes on the same host. For the
 *  local single-user desktop this is acceptable risk; a future hardening pass could write the
 *  config to a restrictive-mode temp file and pass the path instead (if `claude --mcp-config`
 *  accepts a file argument). */
export function buildOrchestratorMcpConfig(opts: {
  nodePath: string;
  serverPath: string;
  socketPath: string;
  token: string;
}): string {
  return JSON.stringify({
    mcpServers: {
      "sparkle-orchestrator": {
        command: opts.nodePath,
        args: [opts.serverPath],
        env: {
          SPARKLE_BRIDGE_SOCKET: opts.socketPath,
          SPARKLE_BRIDGE_TOKEN: opts.token,
        },
      },
    },
  });
}
