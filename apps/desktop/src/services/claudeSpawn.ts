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
  /**
   * Start the agent in PLAN mode (`--permission-mode plan`) — it researches and proposes before it
   * edits anything, the same state a human reaches with shift+tab.
   *
   * Only `"plan"` is modelled. "Build" is the ABSENCE of the flag, not a value to pass: the normal
   * mode is whatever the user's own Claude Code config says, and emitting an explicit
   * `--permission-mode default` here would override a user who set something else — turning "I
   * didn't ask for plan mode" into "force everyone back to the stock setting".
   *
   * Mutually exclusive with {@link dangerouslySkipPermissions} by construction: skip-permissions
   * means "approve everything unattended" and plan mode means "change nothing until I say so", so a
   * spawn asking for both is a caller bug. {@link buildClaudeExec} refuses that combination rather
   * than silently letting claude's own precedence decide which one wins.
   */
  permissionMode?: "plan";
  /** Per-spawn `CLAUDE_CONFIG_DIR` for multi Claude Max account support (design spec
   *  docs/superpowers/specs/2026-06-26-multi-max-account-design.md). When set, the exec exports it
   *  so the child `claude` authenticates from that account's isolated config dir — confined to the
   *  child process, never Sparkle's own env. Absent → claude uses its default (`~/.claude` or the
   *  inherited `$CLAUDE_CONFIG_DIR`), preserving today's behavior for users who never set this up. */
  configDir?: string;
  /** Export `BD_READONLY=1` into the child so every `bd` (beads) call it makes is read-only — bd
   *  refuses close/update/create/label with "operation '…' is not allowed in read-only mode" (exit
   *  1) while `bd show`/`bd list` still work. Confined to the child, like the PATH/CLAUDE_CONFIG_DIR
   *  exports — never leaked into Sparkle's own env.
   *
   *  CURRENTLY UNUSED IN PRODUCTION, DELIBERATELY. Do NOT set it for worker agents — that is what
   *  this doc used to say, and it was wrong (roborev 62900, High; bead sparkle-x5xn0).
   *
   *  The motivation is sound: every worktree shares one Dolt beads DB, so an unrestricted worker CAN
   *  close or supersede a bead another agent is working on. But "workers don't own bead state" is
   *  false for two writes their own personas MANDATE, and this flag refuses both:
   *    1. Retro filing — `workerPersona()` requires `file-retro-pain-point.sh` per pain point, which
   *       writes via `retro-beads.sh` (`bd create`/`comment`/`update`). That script has no read-only
   *       awareness, so a refusal reports `parked-create`/`unfiled:lost`, and the persona then tells
   *       the worker those are DEFERRED and will be re-filed — false when every retry is refused.
   *    2. Peer coordination — AGENTS.md names `bd comment <id> "taking <files>"` as THE cross-agent
   *       channel, because SendMessage cannot reach a peer agent.
   *
   *  Carve those two writes out first (see sparkle-x5xn0), and land the re-enabling WITH the test
   *  the design spec already mandates: spawn a worker, assert `BD_READONLY=1` is in its env,
   *  mutation-checked to red when the flag is removed. */
  beadsReadonly?: boolean;
  /**
   * This agent's AgentTab.id, exported as `SPARKLE_INBOX_AGENT` so the Stop hook can tell THIS
   * `claude` process apart from every other one running in the same worktree.
   *
   * WITHOUT IT THE FOUNDER'S MESSAGES ARE LOST (bead sparkle-ei7keg, a P0 trust bug). The hook
   * (`src-tauri/resources/sparkle-hook.mjs`) is registered once per WORKTREE, and it derives the
   * agent id from the event-log path — so every background one-shot `claude` in that worktree
   * drains the SAME per-agent inbox. Measured: a roborev post-commit reviewer (`claude -p`) hit
   * `Stop`, drained and acked four of the founder's queued instructions, and exited; the real
   * agent's own `Stop` 54s later found an empty queue. The drain is destructive and exactly-once
   * (an `O_EXCL` claim, then an ack), so the loser never sees the message at all.
   *
   * Must be the SAME id used for {@link ControlMcpOpts.agentId} / `SPARKLE_AGENT_ID` — that is the
   * id the hook-events log and the inbox are both keyed by (`hooks.rs::event_log_path` takes the
   * worktree basename, which is the AgentTab.id).
   *
   * Exported alongside PATH/CLAUDE_CONFIG_DIR, confined to the child `claude` and never Sparkle's
   * own env. Absent → the hook refuses to drain, which is SAFE rather than a regression: an
   * unclaimed message stays `pending`, and the app-side idle path (`services/fleetWatch` →
   * `inbox_claim_for_idle`) still delivers it over the agent's own PTY.
   */
  inboxAgentId?: string;
  /**
   * Suppress Claude Code's interactive "This session is Xh old and Nk tokens — resume from summary?"
   * prompt for this spawn. Set for UNATTENDED WORKERS: on `--continue`/`--resume` of an OLD, LARGE
   * session that prompt blocks a headless worker forever — nobody is there to press "1. Resume from
   * summary" — so the worker sits RED and its orchestrator blocks in wait_for_workers. This is the
   * second half of the restart-wedge (the first is the folder-trust dialog, seeded server-side).
   *
   * Mechanism (verified against the Claude Code 2.1.235 bundle): the gate reads two env vars,
   * `CLAUDE_CODE_RESUME_THRESHOLD_MINUTES` (default 70) and `CLAUDE_CODE_RESUME_TOKEN_THRESHOLD`
   * (default 100000), and shows the prompt only when the session is older AND larger than those. We
   * export both at an unreachable ceiling so the gate always takes its "no prompt" branch — the
   * session is never old/large ENOUGH — for THIS child only. Deliberately NOT the config-file
   * mechanism (`resumeReturnDismissed` in `~/.claude.json`, what "Don't ask me again" writes): that
   * is global and would silence the prompt in the human's OWN interactive Claude Code too. An env
   * export is confined to the worker's own process, exactly like {@link configDir}/{@link
   * inboxAgentId}, so it changes nothing the user sees. Harmless on a fresh (non-resumed) spawn: the
   * gate needs a prior session to fire at all.
   */
  suppressResumePrompt?: boolean;
}

/** The unreachable ceilings exported for {@link ClaudeExecOpts.suppressResumePrompt}. A session is
 *  never this old (in minutes) or this large (in tokens), so Claude Code's resume-summary gate always
 *  takes its "no prompt" branch. Exported so a test pins the SAME values the exec emits. */
export const RESUME_PROMPT_SUPPRESS_MINUTES = "525600000"; // ~1000 years
export const RESUME_PROMPT_SUPPRESS_TOKENS = "1000000000000"; // 1e12 tokens

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
  // Plan mode — FRESH SPAWNS ONLY, for the same reason `initialPrompt` is (see below): it is a
  // request made when the agent was created, not a permanent property of it. The human leaves plan
  // mode with shift+tab once they have approved the plan, and that happens inside the session, where
  // this launcher cannot see it. Re-emitting the flag on every relaunch would silently drag the
  // agent back into plan mode after it had been let out — a "why won't it edit anything" bug whose
  // cause is invisible from the UI.
  //
  // Refused alongside skip-permissions rather than resolved: the two express opposite intentions
  // ("approve everything unattended" vs "change nothing until I approve"), so a caller asking for
  // both has a bug, and letting claude's own flag precedence pick a winner would hide it behind
  // whichever behaviour happened to result. Thrown, not logged — the spawn paths that reach this can
  // still refuse cleanly, and a WORKER silently launched in plan mode would sit RED forever while
  // its orchestrator blocks in wait_for_workers.
  if (opts.permissionMode && opts.dangerouslySkipPermissions) {
    throw new Error(
      "buildClaudeExec: permissionMode 'plan' and dangerouslySkipPermissions are mutually " +
        "exclusive — plan mode waits for approval, skip-permissions grants it automatically.",
    );
  }
  if (!resume && opts.permissionMode) {
    cmd += ` --permission-mode ${shellQuote(opts.permissionMode)}`;
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
  // BD_READONLY confines the child's `bd` to reads. NO caller sets it today — see the option's JSDoc
  // above (withdrawn from worker spawns; bead sparkle-x5xn0) before wiring it anywhere. Exported
  // alongside PATH/config so it applies to the child `claude` and everything it shells out to,
  // never to Sparkle's own env.
  const beadsReadonlyExport = opts.beadsReadonly ? `export BD_READONLY=1; ` : "";
  // SPARKLE_INBOX_AGENT is the Stop hook's ownership proof — see the option's JSDoc (bead
  // sparkle-ei7keg). Exported into the child `claude` alongside the two above, so it reaches this
  // agent's own process tree and NOTHING PARENTED ELSEWHERE: the roborev reviewers that consumed the
  // founder's messages are forked by `roborev daemon run`, itself parented by launchd (PPID 1), so
  // they inherit the daemon's environment and never this PTY's, and the hook refuses to drain for
  // them. Note the limit of that claim — an env var is INHERITED, so this proves "descendant of this
  // PTY", not "is this agent's own claude"; a nested `claude -p` the agent runs itself does inherit
  // it. `mayDrain` in sparkle-hook.mjs documents that residual and how to close it.
  // Written as an explicit `!== ""` rather than a truthiness ternary so the gate is one mutable
  // comparison a mutation check can invert — a spawn that silently stops exporting this is the
  // exact regression that costs the founder messages, and it must be provable that a test sees it.
  const inboxAgentId = opts.inboxAgentId ?? "";
  const inboxAgentExport =
    inboxAgentId !== "" ? `export SPARKLE_INBOX_AGENT=${shellQuote(inboxAgentId)}; ` : "";
  // Push the resume-summary prompt's age/token thresholds out of reach so an unattended worker
  // resuming an old, large session never stops on it (see suppressResumePrompt's JSDoc). Child-scoped
  // like the exports above — never Sparkle's own env, never the user's config file. Written as an
  // explicit `=== true` so a mutation check can invert the gate: a worker that silently stops
  // exporting these re-opens the exact restart-wedge this closes.
  const resumeThresholdExport =
    opts.suppressResumePrompt === true
      ? `export CLAUDE_CODE_RESUME_THRESHOLD_MINUTES=${RESUME_PROMPT_SUPPRESS_MINUTES}; ` +
        `export CLAUDE_CODE_RESUME_TOKEN_THRESHOLD=${RESUME_PROMPT_SUPPRESS_TOKENS}; `
      : "";
  return `${configExport}${beadsReadonlyExport}${inboxAgentExport}${resumeThresholdExport}${PAGER_ENV_EXPORT}export PATH="$HOME/.local/bin:$PATH"; ${cmd}`;
}

/**
 * The claude ARGV that opens the interactive browser sign-in.
 *
 * IT IS `auth login`, AND THE `auth` IS THE WHOLE BUG. Every caller used to build `claude login`,
 * which is not a subcommand — `claude --help` lists `agents`, `auth`, `auto-mode`, `doctor`,
 * `gateway`, `install`, `mcp`, `plugin`, `project`, `setup-token`, `ultrareview`, `update`, and
 * nothing else. Commander therefore parsed `login` as the POSITIONAL PROMPT, so the embedded
 * terminal opened an ordinary Claude REPL and sent it the word "login". OAuth never ran.
 *
 * Measured directly rather than inferred: `CLAUDE_CONFIG_DIR=<tmp> claude login </dev/null` prints
 * `Not logged in · Please run /login` and exits 1, leaving a config dir whose `.claude.json` has NO
 * `oauthAccount` — byte-for-byte the state of a half-registered Sparkle account. So the broken path
 * did not merely fail; it MANUFACTURED the accounts whose nicknames the pill was showing as
 * identities (bead sparkle-gwkui). The founder hit the same defect from the other side as "the
 * little login window in onboarding isn't working" — not a rendering or PTY fault; the command
 * simply did not exist. `claude auth --help` is the authority:
 *
 *     Commands:  login [options]   Sign in to your Anthropic account
 *                logout            Log out from your Anthropic account
 *                status [options]  Show authentication status
 *
 * Exported so user-facing copy quotes the SAME string the spawn actually runs: a message that
 * names a command is an instruction the user will follow, so it has to be the real one.
 */
export const CLAUDE_LOGIN_ARGV = "auth login";

/** `claude auth login` — the full command, for user-facing copy and error remedies. Derived from
 *  {@link CLAUDE_LOGIN_ARGV} so a string shown to a human cannot drift from the one we spawn. */
export const CLAUDE_LOGIN_COMMAND = `claude ${CLAUDE_LOGIN_ARGV}`;

/** Build the `zsh -l -c` exec string that runs `claude auth login` — the interactive sign-in used
 *  by the auth gate, the first-run setup checklist, and the per-account login modal. Like
 *  {@link buildClaudeExec} it prepends `~/.local/bin` to PATH so the `#!/usr/bin/env node` shebang
 *  in a freshly-installed `claude` resolves node. `configDir` (optional) targets a specific
 *  account's config dir — that export is what makes the login land in a named account's folder
 *  instead of the user's system-wide `~/.claude`. */
export function buildClaudeLoginExec(claudePath: string, opts: { configDir?: string } = {}): string {
  const configExport = opts.configDir
    ? `export CLAUDE_CONFIG_DIR=${shellQuote(opts.configDir)}; `
    : "";
  // ANTHROPIC_ENV_UNSET is load-bearing and came from the parallel auth-gate fix: with an API-key
  // env var set, `claude` authenticates with THAT instead of running the OAuth browser flow, so the
  // sign-in silently does nothing. Both halves of this bug had to be fixed for a login to work.
  return `${configExport}${ANTHROPIC_ENV_UNSET}${PAGER_ENV_EXPORT}export PATH="$HOME/.local/bin:$PATH"; exec ${shellQuote(claudePath)} ${CLAUDE_LOGIN_ARGV}`;
}

/** FNV-1a 32-bit, hex. Not a security hash — just a short, stable, collision-resistant token for a
 *  path, so a PTY id can carry WHICH config dir it belongs to without embedding the path itself. */
function pathToken(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * The PTY session id for a `claude auth login` running against `configDir`.
 *
 * THE CONFIG DIR IS LOAD-BEARING IN THE ID, and its absence was a live credential-crossing bug
 * (bead sparkle-znusx). The id used to be `claude-signin-<attempt>` — a retry counter and nothing
 * else — so EVERY account's sign-in shared the id `claude-signin-0`.
 *
 * `PtyManager.sessions` is a `HashMap<String, PtySession>` keyed by exactly this id, and `pty_spawn`
 * inserts with `sessions.insert`, which REPLACES silently. pty.rs says what that costs, in its own
 * words: "a second spawn for the same id drops the first `PtySession` on the floor — its child keeps
 * running … and is invisible to every surface in the app because nothing holds a handle to it any
 * more."
 *
 * For a sign-in, that orphan is not merely a leak. The dropped child is a live `claude auth login`
 * still holding `CLAUDE_CONFIG_DIR=<the PREVIOUS account's dir>` and still holding the loopback
 * OAuth callback listener. The browser redirect therefore lands in the ORPHAN, and the credential
 * the user just authorized is written into the account they signed in to LAST TIME.
 *
 * Measured on the founder's machine: every one of five accounts was registered with the correct
 * login, then three of them silently drifted onto one identity. `account-identity-log.json` records
 * "DROdio Gmail CHANGED-TO superadmin@storytell.ai" at the SAME SECOND that "FC SuperAdmin" was
 * created — 13 seconds BEFORE FC SuperAdmin's own dir received it. The orphan won the callback.
 *
 * Keying the id on the config dir makes two concurrent sign-ins two distinct sessions, so neither
 * can silently evict the other.
 */
export function claudeSignInPtyId(configDir: string | undefined, attempt: number): string {
  // The DEFAULT account (no configDir) is its own namespace, exactly as it is in Claude Code's
  // keychain: `T7()` hashes the config dir only when CLAUDE_CONFIG_DIR is set, and uses the bare
  // service name when it is not. "default" mirrors that rather than inventing a third state.
  const scope = configDir ? pathToken(configDir) : "default";
  return `claude-signin-${scope}-${attempt}`;
}

/**
 * The Anthropic env overrides, unset before the login runs — mirroring the Rust-side scrub that
 * `accounts::claude_auth_status` applies to its probe (`claude_oneshot::ANTHROPIC_ENV_OVERRIDES`).
 *
 * SYMMETRY IS THE POINT, and its absence was a real defect (roborev 58006). The probe that decides
 * whether the gate opens runs SCRUBBED, so it reports on the subscription OAuth credential. If the
 * login that is supposed to SATISFY that gate ran unscrubbed, the two would be talking about
 * different credentials: with `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_BASE_URL` exported, `claude auth
 * login` authenticates against a redirected endpoint or declines to change anything, the probe keeps
 * reporting the OAuth session dead, and the user is stuck in a loop — signing in, being told to sign
 * in again, with nothing on screen explaining why. Unsetting here makes the login write exactly the
 * credential the probe reads.
 *
 * `unset` rather than `env -u`, because this is a string handed to `zsh -l -c`: the login shell
 * sources the user's profile, which is itself a place these get exported, so the unset has to happen
 * INSIDE the shell after the profile has run. It is a no-op when the vars are absent.
 */
const ANTHROPIC_ENV_UNSET =
  "unset ANTHROPIC_API_KEY ANTHROPIC_API ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL " +
  "ANTHROPIC_CUSTOM_HEADERS CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX; ";

/**
 * Force a NON-INTERACTIVE PAGER on the spawned `claude` and everything it shells out to.
 *
 * THE INCIDENT (bead `sparkle-w11lll`). Two agents were found wedged on the ALTERNATE SCREEN, the
 * state a pager puts a terminal in. An agent parked there is unreachable by EVERY automated path
 * Sparkle has: `dispatchConciergeAnswer` refuses each write with `alternate-screen` (correctly —
 * typed text would execute as pager commands), auto-resume refuses identically and burns its retry
 * budget until it escalates to a human, and the only key that quits a pager is `q`, which
 * `send_control_key`'s named vocabulary could not send. A human had to press `q` in the pane, and
 * one of the two agents was holding five uncommitted files while it waited.
 *
 * WHY THIS EXISTS IN ADDITION TO THE RUST-SIDE ENV, which is the part worth reading before deleting
 * it as a duplicate. `pty.rs` sets these same pairs on the `CommandBuilder` — but this string is
 * handed to `zsh -l -c`, a LOGIN shell, which sources the user's `.zprofile`/`.zlogin` AFTER that
 * environment is applied. A profile line as ordinary as `export GIT_PAGER=less` therefore CLOBBERS
 * the Rust value, and the agent gets a pager anyway. Exporting here runs after the profile has run,
 * so it wins. Exactly the argument {@link ANTHROPIC_ENV_UNSET} makes for using `unset` inside the
 * script rather than `env -u` outside it — same shell, same ordering trap.
 *
 * WHY BOTH `PAGER` AND THE PER-TOOL NAMES: each tool reads its own variable FIRST and only falls
 * back to `PAGER`, so `PAGER=cat` alone is overridden by a user's `GIT_PAGER=less` — and by git's
 * `core.pager`, which `GIT_PAGER` outranks and `PAGER` does not.
 *
 * `LESS=FRX` IS THE BACKSTOP FOR A DIRECT EXEC — a tool that runs `less` itself and consults none
 * of the above. `X` is the load-bearing letter: it keeps `less` OFF the alternate screen, which is
 * the exact state that made the agent unreachable. `F` quits when the content fits one screen, `R`
 * keeps colour readable.
 */
const PAGER_ENV_EXPORT =
  "export PAGER=cat GIT_PAGER=cat GH_PAGER=cat SYSTEMD_PAGER=cat MANPAGER=cat LESS=FRX; ";

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
  return JSON.stringify({ mcpServers: orchestratorMcpServers(opts) });
}

/** One MCP server entry per `claude --mcp-config` — a partial `mcpServers` map. Split out from the
 *  wrapper so a Build agent can MERGE the orchestrator + control servers into a single --mcp-config
 *  (Object.assign the maps) rather than dropping one. */
export function orchestratorMcpServers(opts: {
  nodePath: string;
  serverPath: string;
  socketPath: string;
  token: string;
}): Record<string, unknown> {
  return {
    "sparkle-orchestrator": {
      command: opts.nodePath,
      args: [opts.serverPath],
      env: {
        SPARKLE_BRIDGE_SOCKET: opts.socketPath,
        SPARKLE_BRIDGE_TOKEN: opts.token,
      },
    },
  };
}

/** Args for the app-level `sparkle-control` MCP server. Unlike the orchestrator bridge (one socket
 *  per Build agent, identity derived from the socket), the control bridge is a SINGLETON shared by
 *  every agent kind — so the caller's identity is injected explicitly as `SPARKLE_AGENT_ID` (that
 *  agent's AgentTab.id), which the server stamps as `callerAgentId` on every op. The socket + token
 *  ride in the child's env only (never exported into the agent's shell), same as the orchestrator. */
export interface ControlMcpOpts {
  nodePath: string;
  serverPath: string;
  socketPath: string;
  token: string;
  /** The spawning agent's AgentTab.id — the anti-spoofing caller identity for per-agent ops. */
  agentId: string;
}

/** The `sparkle-control` MCP server entry (a partial `mcpServers` map). The server name
 *  ("sparkle-control") matches the McpServer name in apps/mcp-control. */
export function controlMcpServers(opts: ControlMcpOpts): Record<string, unknown> {
  return {
    "sparkle-control": {
      command: opts.nodePath,
      args: [opts.serverPath],
      env: {
        SPARKLE_CONTROL_SOCKET: opts.socketPath,
        SPARKLE_CONTROL_TOKEN: opts.token,
        SPARKLE_AGENT_ID: opts.agentId,
      },
    },
  };
}

/** Inline JSON for `claude --mcp-config` that launches ONLY the sparkle-control MCP server (a stdio
 *  child) wired to the app-level control bridge. Used for agent kinds that get no orchestrator MCP
 *  (Think/worker/generic). Mirrors {@link buildOrchestratorMcpConfig}; the same `ps aux` visibility
 *  caveat applies to the bridge token passed on the command line. */
export function buildControlMcpConfig(opts: ControlMcpOpts): string {
  return JSON.stringify({ mcpServers: controlMcpServers(opts) });
}

/** Merge several MCP server maps into one `claude --mcp-config` JSON string. A Build agent uses this
 *  to load BOTH the sparkle-orchestrator and the sparkle-control servers from a single --mcp-config,
 *  so neither is dropped. Later maps win on a name collision (there are none between our servers). */
export function buildMergedMcpConfig(servers: Array<Record<string, unknown>>): string {
  return JSON.stringify({ mcpServers: Object.assign({}, ...servers) });
}
