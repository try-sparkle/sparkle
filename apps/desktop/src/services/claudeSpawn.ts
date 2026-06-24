// Pure helpers for building the `claude` launch command. Kept separate from
// AgentPane so the resume/fresh branching (bead ) is unit-testable
// without rendering the component.

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
  if (resume) cmd += " --continue";
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
  return `export PATH="$HOME/.local/bin:$PATH"; ${cmd}`;
}
