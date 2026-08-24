import { describe, it, expect } from "vitest";
import {
  buildClaudeExec,
  buildClaudeLoginExec,
  claudeSignInPtyId,
  CLAUDE_LOGIN_ARGV,
  CLAUDE_LOGIN_COMMAND,
  shellQuote,
  buildOrchestratorMcpConfig,
  buildControlMcpConfig,
  buildMergedMcpConfig,
  controlMcpServers,
  orchestratorMcpServers,
  RESUME_PROMPT_SUPPRESS_MINUTES,
  RESUME_PROMPT_SUPPRESS_TOKENS,
} from "./claudeSpawn";

/** Mirrors PAGER_ENV_EXPORT in claudeSpawn.ts. Every agent spawn must force a non-interactive
 *  pager: an agent that opens one enters the alternate screen, where every automated route to it
 *  (concierge writes, auto-resume) refuses and only a human pressing `q` can free it
 *  (bead sparkle-w11lll). */
const PAGER_PREFIX =
  "export PAGER=cat GIT_PAGER=cat GH_PAGER=cat SYSTEMD_PAGER=cat MANPAGER=cat LESS=FRX; ";
const PATH_PREFIX = `export PATH="$HOME/.local/bin:$PATH"; `;
/** Mirrors ANTHROPIC_ENV_UNSET in claudeSpawn.ts — the login must write the same credential the
 *  Rust-side auth probe reads. */
const UNSET_PREFIX =
  "unset ANTHROPIC_API_KEY ANTHROPIC_API ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL " +
  "ANTHROPIC_CUSTOM_HEADERS CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX; ";

describe("buildClaudeLoginExec (first-run setup)", () => {
  // THE BUG THIS PINS. This built `claude login`, which is NOT a subcommand — `claude --help` lists
  // `auth`, and `login` lives under it. Commander therefore read `login` as the POSITIONAL PROMPT,
  // so the embedded setup terminal opened a Claude REPL and asked it the word "login". No OAuth ever
  // ran, and the founder reported the onboarding sign-in window as simply not working. The assertion
  // is on the exact argv, so a revert to the bare `login` form fails here.
  // The exported constants exist so USER-FACING COPY quotes the same string the spawn runs — a
  // message naming a command is an instruction the user will follow, so it has to be the real one.
  //
  // WHAT THIS ACTUALLY GUARANTEES, stated honestly because the first version of this comment did
  // not: the constants are pinned to INDEPENDENTLY-WRITTEN literals. That is all. An earlier draft
  // also asserted `CLAUDE_LOGIN_COMMAND === \`claude ${CLAUDE_LOGIN_ARGV}\`` and that the exec ends
  // with CLAUDE_LOGIN_ARGV — both tautologies, since the source DEFINES the command that way and
  // INTERPOLATES the argv into the exec. They hold for any value and cannot fail, so a reader would
  // have believed derivation drift was mechanically guarded when it was not (roborev 58151).
  // Drift is prevented structurally instead: `configActions.ts` and the setup copy import
  // CLAUDE_LOGIN_COMMAND rather than hand-typing it, so there is one string to get wrong.
  it("pins the login argv and the human-facing command to literals", () => {
    expect(CLAUDE_LOGIN_ARGV).toBe("auth login");
    expect(CLAUDE_LOGIN_COMMAND).toBe("claude auth login");
  });

  it("runs `claude auth login` — NOT `claude login`, which is a prompt, not a command", () => {
    expect(buildClaudeLoginExec("/usr/local/bin/claude")).toBe(
      `${UNSET_PREFIX}${PAGER_PREFIX}${PATH_PREFIX}exec '/usr/local/bin/claude' auth login`,
    );
  });

  it("single-quotes a claude path containing a space", () => {
    expect(buildClaudeLoginExec("/path with space/claude")).toBe(
      `${UNSET_PREFIX}${PAGER_PREFIX}${PATH_PREFIX}exec '/path with space/claude' auth login`,
    );
  });

  it("exports CLAUDE_CONFIG_DIR before login when a config dir is given", () => {
    expect(buildClaudeLoginExec("/bin/claude", { configDir: "/acc/dir" })).toBe(
      `export CLAUDE_CONFIG_DIR='/acc/dir'; ${UNSET_PREFIX}${PAGER_PREFIX}${PATH_PREFIX}exec '/bin/claude' auth login`,
    );
  });

  // SYMMETRY WITH THE PROBE. `accounts::claude_auth_status` runs scrubbed, so it reports on the
  // subscription OAuth credential. A login that ran UNSCRUBBED would write a different one — and the
  // user would loop: sign in, be told to sign in again, with nothing explaining why (roborev 58006).
  //
  // WHAT THIS DOES AND DOES NOT PROVE. It pins that the shell string unsets each name BEFORE the
  // exec, which is what makes the unset effective. It canNOT detect drift from the canonical Rust
  // list: these names, UNSET_PREFIX, and ANTHROPIC_ENV_UNSET all live on this side, so appending an
  // eighth name to `claude_oneshot::ANTHROPIC_ENV_OVERRIDES` fails nothing here. An earlier version
  // of this comment claimed it did, which is worse than no check — it tells the reader the drift is
  // impossible (roborev 58033). The real cross-language guard is the Rust test
  // `every_scrubbed_name_is_also_unset_before_the_typescript_login_spawn`, which reads this file.
  it.each([
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_API",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_CUSTOM_HEADERS",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
  ])("unsets %s before login, matching the Rust-side probe scrub", (name) => {
    const exec = buildClaudeLoginExec("/bin/claude");
    expect(exec).toMatch(new RegExp(`unset[^;]*\\b${name}\\b`));
    // And it must happen BEFORE the exec, or it accomplishes nothing.
    expect(exec.indexOf(name)).toBeLessThan(exec.indexOf("exec "));
  });
});

describe("buildClaudeExec ()", () => {
  it("appends --continue when a prior session exists", () => {
    expect(buildClaudeExec("/usr/local/bin/claude", true)).toBe(
      `${PAGER_PREFIX}${PATH_PREFIX}exec '/usr/local/bin/claude' --continue`,
    );
  });

  it("spawns plain claude when there is no session", () => {
    expect(buildClaudeExec("/usr/local/bin/claude", false)).toBe(
      `${PAGER_PREFIX}${PATH_PREFIX}exec '/usr/local/bin/claude'`,
    );
  });

  it("prepends ~/.local/bin to PATH so agents find user-local tools like roborev ()", () => {
    // zsh -l -c is non-interactive and skips .zshrc, so the spawn must export PATH itself.
    expect(buildClaudeExec("/usr/local/bin/claude", false)).toContain(
      `export PATH="$HOME/.local/bin:$PATH";`,
    );
  });

  it("single-quotes paths with awkward characters", () => {
    expect(buildClaudeExec("/path with space/claude", false)).toBe(
      `${PAGER_PREFIX}${PATH_PREFIX}exec '/path with space/claude'`,
    );
    // An embedded single quote is escaped, not left to break the shell string.
    expect(shellQuote("/a'b")).toBe("'/a'\\''b'");
  });

  // Special-agent opts (Sparkle self-improvement agent): persona, extra read dirs, mission prompt.
  it("adds --append-system-prompt and --add-dir, and the mission prompt on a FRESH session", () => {
    const cmd = buildClaudeExec("/bin/claude", false, {
      appendSystemPrompt: "be helpful",
      addDirs: ["/logs"],
      initialPrompt: "start now",
    });
    // `--` terminates the variadic `--add-dir` so the positional prompt isn't swallowed as a
    // directory (which made `claude` stat the prompt as a path → ENAMETOOLONG; bead ).
    expect(cmd).toBe(
      `${PAGER_PREFIX}${PATH_PREFIX}exec '/bin/claude' --append-system-prompt 'be helpful' --add-dir '/logs' -- 'start now'`,
    );
  });

  it("separates the mission prompt from a variadic --add-dir with `--` so it isn't stat'd as a dir", () => {
    const cmd = buildClaudeExec("/bin/claude", false, {
      addDirs: ["/a", "/b"],
      initialPrompt: "go do the thing",
    });
    // The prompt must come after `--`; otherwise commander's variadic --add-dir consumes it.
    expect(cmd).toContain("--add-dir '/a' --add-dir '/b' -- 'go do the thing'");
  });

  it("still emits `--` before a prompt even with no --add-dir, guarding prompts that start with '-'", () => {
    const cmd = buildClaudeExec("/bin/claude", false, { initialPrompt: "-oops looks like a flag" });
    expect(cmd).toBe(`${PAGER_PREFIX}${PATH_PREFIX}exec '/bin/claude' -- '-oops looks like a flag'`);
  });

  // Unattended workers auto-approve tool calls so an approval prompt can't silently deadlock them.
  it("emits --dangerously-skip-permissions when dangerouslySkipPermissions is set (worker auto-approve)", () => {
    const cmd = buildClaudeExec("/bin/claude", false, { dangerouslySkipPermissions: true });
    expect(cmd).toBe(`${PAGER_PREFIX}${PATH_PREFIX}exec '/bin/claude' --dangerously-skip-permissions`);
  });

  it("omits --dangerously-skip-permissions by default (Think/Build agents keep permission prompts)", () => {
    expect(buildClaudeExec("/bin/claude", false)).not.toContain("--dangerously-skip-permissions");
    expect(buildClaudeExec("/bin/claude", false, { dangerouslySkipPermissions: false })).not.toContain(
      "--dangerously-skip-permissions",
    );
  });

  it("keeps auto-approve on a resumed worker (after --continue, before the prompt)", () => {
    const cmd = buildClaudeExec("/bin/claude", true, { dangerouslySkipPermissions: true });
    expect(cmd).toBe(`${PAGER_PREFIX}${PATH_PREFIX}exec '/bin/claude' --continue --dangerously-skip-permissions`);
  });

  // suppressResumePrompt (restart-wedge, second half). On `--continue`/`--resume` of an OLD, LARGE
  // session Claude Code shows an interactive "resume from summary?" prompt that a headless worker
  // can never answer. The gate reads CLAUDE_CODE_RESUME_THRESHOLD_MINUTES / _TOKEN_THRESHOLD; we
  // export both at an unreachable ceiling for the child so it never fires. Asserting the exports are
  // PRESENT is the side effect — a worker that stops emitting them re-opens the wedge (mutation: flip
  // the `=== true` gate and this goes red).
  it("exports the unreachable resume-prompt thresholds when suppressResumePrompt is set", () => {
    const cmd = buildClaudeExec("/bin/claude", true, {
      dangerouslySkipPermissions: true,
      suppressResumePrompt: true,
    });
    expect(cmd).toContain(
      `export CLAUDE_CODE_RESUME_THRESHOLD_MINUTES=${RESUME_PROMPT_SUPPRESS_MINUTES}; `,
    );
    expect(cmd).toContain(
      `export CLAUDE_CODE_RESUME_TOKEN_THRESHOLD=${RESUME_PROMPT_SUPPRESS_TOKENS}; `,
    );
    // Both exports precede `exec` (they must reach the child claude), like every other child export.
    expect(cmd.indexOf("CLAUDE_CODE_RESUME_TOKEN_THRESHOLD")).toBeLessThan(cmd.indexOf("exec "));
    // The ceilings are truly unreachable, so the gate's "no prompt" branch always wins.
    expect(Number(RESUME_PROMPT_SUPPRESS_MINUTES)).toBeGreaterThan(70); // default threshold
    expect(Number(RESUME_PROMPT_SUPPRESS_TOKENS)).toBeGreaterThan(100000); // default threshold
  });

  it("omits the resume-prompt threshold exports by default (interactive agents keep the prompt)", () => {
    expect(buildClaudeExec("/bin/claude", true)).not.toContain("CLAUDE_CODE_RESUME_");
    expect(
      buildClaudeExec("/bin/claude", true, { suppressResumePrompt: false }),
    ).not.toContain("CLAUDE_CODE_RESUME_");
  });

  // CLAUDE_CONFIG_DIR injection for multi Claude Max account support (design spec
  // 2026-06-26-multi-max-account-design). The chosen account's config dir must be exported into the
  // child's env, never leak when no account is chosen, and be safely shell-quoted.
  it("exports CLAUDE_CONFIG_DIR before PATH when a configDir is given", () => {
    const cmd = buildClaudeExec("/bin/claude", false, { configDir: "/data/accounts/ab12" });
    expect(cmd).toBe(
      `export CLAUDE_CONFIG_DIR='/data/accounts/ab12'; ${PAGER_PREFIX}${PATH_PREFIX}exec '/bin/claude'`,
    );
  });

  it("omits the CLAUDE_CONFIG_DIR export entirely when no configDir is given (default behavior)", () => {
    const cmd = buildClaudeExec("/bin/claude", false);
    expect(cmd).not.toContain("CLAUDE_CONFIG_DIR");
    expect(cmd).toBe(`${PAGER_PREFIX}${PATH_PREFIX}exec '/bin/claude'`);
  });

  it("treats an empty-string configDir as no account (omits the export)", () => {
    // Pins the truthiness gate: `configDir: ""` must behave like unset, not emit `=''`. Guards
    // against a later refactor to `!== undefined` that would export an empty (relative) config dir.
    const cmd = buildClaudeExec("/bin/claude", false, { configDir: "" });
    expect(cmd).not.toContain("CLAUDE_CONFIG_DIR");
    expect(cmd).toBe(`${PAGER_PREFIX}${PATH_PREFIX}exec '/bin/claude'`);
  });

  it("single-quotes a configDir with awkward characters and combines with other opts", () => {
    const cmd = buildClaudeExec("/bin/claude", true, {
      configDir: "/path with space/.claude",
      appendSystemPrompt: "persona",
    });
    expect(cmd).toBe(
      `export CLAUDE_CONFIG_DIR='/path with space/.claude'; ${PAGER_PREFIX}${PATH_PREFIX}exec '/bin/claude' --continue --append-system-prompt 'persona'`,
    );
  });

  it("skips the initial mission prompt on resume so it doesn't re-run every relaunch", () => {
    const cmd = buildClaudeExec("/bin/claude", true, {
      appendSystemPrompt: "persona",
      initialPrompt: "start now",
    });
    // --continue + persona, but NO trailing positional prompt.
    expect(cmd).toBe(`${PAGER_PREFIX}${PATH_PREFIX}exec '/bin/claude' --continue --append-system-prompt 'persona'`);
    expect(cmd).not.toContain("start now");
  });

  // Resume-by-id so the prior conversation is visibly REDRAWN on reopen (bead sparkle-wwg7).
  it("uses --resume <id> instead of --continue when a session id is present", () => {
    const cmd = buildClaudeExec("/bin/claude", true, {
      resumeSessionId: "4b2a247c-ed39-4abc-9f01-deadbeef0000",
    });
    expect(cmd).toBe(
      `${PAGER_PREFIX}${PATH_PREFIX}exec '/bin/claude' --resume '4b2a247c-ed39-4abc-9f01-deadbeef0000'`,
    );
    expect(cmd).not.toContain("--continue");
  });

  it("falls back to --continue when resume is true but no session id is available", () => {
    const cmd = buildClaudeExec("/bin/claude", true, { resumeSessionId: undefined });
    expect(cmd).toBe(`${PAGER_PREFIX}${PATH_PREFIX}exec '/bin/claude' --continue`);
    // An empty-string id is treated as absent (falsy) → still --continue, never `--resume ''`.
    expect(buildClaudeExec("/bin/claude", true, { resumeSessionId: "" })).toBe(
      `${PAGER_PREFIX}${PATH_PREFIX}exec '/bin/claude' --continue`,
    );
  });

  it("ignores resumeSessionId on a FRESH session (no --resume, plain claude + prompt)", () => {
    const cmd = buildClaudeExec("/bin/claude", false, {
      resumeSessionId: "should-be-ignored",
      initialPrompt: "start now",
    });
    expect(cmd).toBe(`${PAGER_PREFIX}${PATH_PREFIX}exec '/bin/claude' -- 'start now'`);
    expect(cmd).not.toContain("--resume");
  });

  it("still suppresses the initial mission prompt when resuming by id", () => {
    const cmd = buildClaudeExec("/bin/claude", true, {
      resumeSessionId: "sess-123",
      appendSystemPrompt: "persona",
      initialPrompt: "start now",
    });
    expect(cmd).toBe(
      `${PAGER_PREFIX}${PATH_PREFIX}exec '/bin/claude' --resume 'sess-123' --append-system-prompt 'persona'`,
    );
    expect(cmd).not.toContain("start now");
  });

  it("shell-quotes a session id (defense in depth, though ids are uuids)", () => {
    const cmd = buildClaudeExec("/bin/claude", true, { resumeSessionId: "a'b" });
    expect(cmd).toBe(`${PAGER_PREFIX}${PATH_PREFIX}exec '/bin/claude' --resume 'a'\\''b'`);
  });

  // Per-agent model selection (bead sparkle-i6rw).
  it("emits --model <id>, shell-quoted, when a model is set", () => {
    const cmd = buildClaudeExec("/bin/claude", false, { model: "claude-opus-4-8" });
    expect(cmd).toBe(`${PAGER_PREFIX}${PATH_PREFIX}exec '/bin/claude' --model 'claude-opus-4-8'`);
  });

  it("omits --model when the model is undefined or the 'default' sentinel", () => {
    expect(buildClaudeExec("/bin/claude", false)).not.toContain("--model");
    expect(buildClaudeExec("/bin/claude", false, { model: undefined })).not.toContain("--model");
    expect(buildClaudeExec("/bin/claude", false, { model: "default" })).not.toContain("--model");
    // Empty string behaves like unset — never emit `--model ''`.
    expect(buildClaudeExec("/bin/claude", false, { model: "" })).not.toContain("--model");
  });

  it("keeps --model on a resumed session and orders it before the persona/prompt opts", () => {
    const cmd = buildClaudeExec("/bin/claude", true, {
      model: "claude-haiku-4-5",
      appendSystemPrompt: "persona",
    });
    expect(cmd).toBe(
      `${PAGER_PREFIX}${PATH_PREFIX}exec '/bin/claude' --continue --model 'claude-haiku-4-5' --append-system-prompt 'persona'`,
    );
  });

  it("combines --model with a fresh initial prompt (worker spawn shape)", () => {
    const cmd = buildClaudeExec("/bin/claude", false, {
      model: "claude-sonnet-5",
      initialPrompt: "go",
    });
    expect(cmd).toBe(`${PAGER_PREFIX}${PATH_PREFIX}exec '/bin/claude' --model 'claude-sonnet-5' -- 'go'`);
  });

  // BD_READONLY makes a child's `bd` read-only: bd refuses close/update/create/label (exit 1) while
  // reads still work, confined to the child like the PATH/config exports.
  //
  // NOTE: the option has NO production call site today. It was wired for worker spawns and WITHDRAWN
  // (roborev 62900, High; bead sparkle-x5xn0) because it also refuses two writes a worker's own
  // persona mandates — retro filing via retro-beads.sh, and the `bd comment` peer channel AGENTS.md
  // names as the only way to reach a peer agent. These tests therefore pin STRING ASSEMBLY only; they
  // cannot observe a call site, and none exists. See the option's JSDoc in claudeSpawn.ts before
  // re-enabling it.
  it("exports BD_READONLY=1 before PATH when beadsReadonly is set", () => {
    const cmd = buildClaudeExec("/bin/claude", false, { beadsReadonly: true });
    expect(cmd).toBe(`export BD_READONLY=1; ${PAGER_PREFIX}${PATH_PREFIX}exec '/bin/claude'`);
  });

  it("omits the BD_READONLY export by default (every agent keeps beads write access today)", () => {
    expect(buildClaudeExec("/bin/claude", false)).not.toContain("BD_READONLY");
    expect(buildClaudeExec("/bin/claude", false, { beadsReadonly: false })).not.toContain("BD_READONLY");
  });

  it("orders BD_READONLY after CLAUDE_CONFIG_DIR and combines with the worker spawn shape", () => {
    // Shape a worker spawn WOULD have used (configDir + auto-approve + mission prompt alongside
    // beadsReadonly). Written in the conditional deliberately: no production caller passes
    // beadsReadonly today. What this pins is the ORDER of the exported prefix, so a later reorder of
    // the export block is caught whenever the option is used again.
    const cmd = buildClaudeExec("/bin/claude", false, {
      configDir: "/acc/dir",
      beadsReadonly: true,
      dangerouslySkipPermissions: true,
      initialPrompt: "do the task",
    });
    expect(cmd).toBe(
      `export CLAUDE_CONFIG_DIR='/acc/dir'; export BD_READONLY=1; ${PAGER_PREFIX}${PATH_PREFIX}exec '/bin/claude' --dangerously-skip-permissions -- 'do the task'`,
    );
  });
});

describe("SPARKLE_INBOX_AGENT — the Stop hook's ownership proof (bead sparkle-ei7keg)", () => {
  // The hook is registered once per WORKTREE, so every `claude` in that worktree used to drain the
  // same per-agent inbox — destructively and exactly-once. This export is what lets the hook tell
  // the agent's OWN process from a roborev reviewer or any other background one-shot sharing the
  // worktree. A spawn that omits it silently loses turn-boundary delivery for that agent, so these
  // pin the string the hook's `mayDrain` compares against.

  it("exports SPARKLE_INBOX_AGENT when inboxAgentId is set", () => {
    const cmd = buildClaudeExec("/bin/claude", false, { inboxAgentId: "3ab86d6b-9ff7" });
    expect(cmd).toBe(`export SPARKLE_INBOX_AGENT='3ab86d6b-9ff7'; ${PAGER_PREFIX}${PATH_PREFIX}exec '/bin/claude'`);
  });

  it("omits the export entirely when no inboxAgentId is given", () => {
    expect(buildClaudeExec("/bin/claude", false)).not.toContain("SPARKLE_INBOX_AGENT");
    // "" is not an identity — an unset shell var expands to it, and `mayDrain` refuses it too.
    expect(buildClaudeExec("/bin/claude", false, { inboxAgentId: "" })).not.toContain(
      "SPARKLE_INBOX_AGENT",
    );
  });

  it("shell-quotes an id containing a single quote, so the exec string cannot be broken out of", () => {
    const cmd = buildClaudeExec("/bin/claude", false, { inboxAgentId: "a'b; rm -rf /" });
    expect(cmd).toContain(`export SPARKLE_INBOX_AGENT='a'\\''b; rm -rf /'; `);
  });

  it("is exported on BOTH the fresh and the --resume paths", () => {
    // A resumed agent is the SAME agent and has the same inbox. Emitting this only on a fresh spawn
    // would mean every reopened pane silently stopped receiving messages at its turn boundaries —
    // and reopening is the common case, so the bug would be near-permanent rather than rare.
    const fresh = buildClaudeExec("/bin/claude", false, { inboxAgentId: "agent-1" });
    const resumed = buildClaudeExec("/bin/claude", true, {
      inboxAgentId: "agent-1",
      resumeSessionId: "sess-9",
    });
    const cont = buildClaudeExec("/bin/claude", true, { inboxAgentId: "agent-1" });
    for (const cmd of [fresh, resumed, cont]) {
      expect(cmd).toContain("export SPARKLE_INBOX_AGENT='agent-1'; ");
    }
    expect(resumed).toContain("--resume 'sess-9'");
    expect(cont).toContain("--continue");
  });

  it("SURVIVES AN ACCOUNT SWITCH: still exported alongside a per-account CLAUDE_CONFIG_DIR", () => {
    // Switching Claude Max accounts only changes CLAUDE_CONFIG_DIR. The inbox is keyed by agent id
    // under Sparkle's own app-data dir, so the ownership proof must ride along unchanged — if the
    // account export displaced it, every message queued for that agent would sit undelivered at its
    // turn boundaries from the switch onwards.
    const a = buildClaudeExec("/bin/claude", false, {
      inboxAgentId: "agent-1",
      configDir: "/accounts/A",
    });
    const b = buildClaudeExec("/bin/claude", false, {
      inboxAgentId: "agent-1",
      configDir: "/accounts/B",
    });
    expect(a).toBe(
      `export CLAUDE_CONFIG_DIR='/accounts/A'; export SPARKLE_INBOX_AGENT='agent-1'; ${PAGER_PREFIX}${PATH_PREFIX}exec '/bin/claude'`,
    );
    // The SAME agent id under a different account — the id is not re-keyed by the account.
    expect(b).toContain("export SPARKLE_INBOX_AGENT='agent-1'; ");
    expect(a.replace("/accounts/A", "/accounts/B")).toBe(b);
  });

  it("orders after CLAUDE_CONFIG_DIR and BD_READONLY, and combines with a full worker spawn", () => {
    const cmd = buildClaudeExec("/bin/claude", false, {
      configDir: "/acc/dir",
      beadsReadonly: true,
      inboxAgentId: "agent-1",
      dangerouslySkipPermissions: true,
      initialPrompt: "do the task",
    });
    expect(cmd).toBe(
      `export CLAUDE_CONFIG_DIR='/acc/dir'; export BD_READONLY=1; export SPARKLE_INBOX_AGENT='agent-1'; ` +
        `${PAGER_PREFIX}${PATH_PREFIX}exec '/bin/claude' --dangerously-skip-permissions -- 'do the task'`,
    );
  });
});

describe("buildClaudeExec --mcp-config (orchestrator launch)", () => {
  it("emits --mcp-config then --strict-mcp-config before --append-system-prompt", () => {
    const cmd = buildClaudeExec("/bin/claude", false, {
      mcpConfig: '{"mcpServers":{}}',
      strictMcpConfig: true,
      appendSystemPrompt: "be an orchestrator",
    });
    expect(cmd).toBe(
      `${PAGER_PREFIX}${PATH_PREFIX}exec '/bin/claude' --mcp-config '{"mcpServers":{}}' --strict-mcp-config --append-system-prompt 'be an orchestrator'`,
    );
  });

  it("orders --mcp-config after --continue on a resumed session", () => {
    const cmd = buildClaudeExec("/bin/claude", true, {
      mcpConfig: "{}",
      strictMcpConfig: true,
      appendSystemPrompt: "persona",
    });
    expect(cmd).toBe(
      `${PAGER_PREFIX}${PATH_PREFIX}exec '/bin/claude' --continue --mcp-config '{}' --strict-mcp-config --append-system-prompt 'persona'`,
    );
  });

  it("omits --strict-mcp-config when not requested", () => {
    const cmd = buildClaudeExec("/bin/claude", false, { mcpConfig: "{}" });
    expect(cmd).toBe(`${PAGER_PREFIX}${PATH_PREFIX}exec '/bin/claude' --mcp-config '{}'`);
  });

  it("initialPrompt is separated by `--` even when mcpConfig is present, so it isn't swallowed", () => {
    // `--strict-mcp-config` terminates the MCP config list; the `--` separator (added by the
    // initialPrompt path) terminates option parsing entirely so the prompt is never swallowed as
    // another MCP config file or `--add-dir` path.
    const cmd = buildClaudeExec("/bin/claude", false, { mcpConfig: "{}", initialPrompt: "go" });
    expect(cmd).toBe(`${PAGER_PREFIX}${PATH_PREFIX}exec '/bin/claude' --mcp-config '{}' -- 'go'`);
  });
});

describe("buildOrchestratorMcpConfig", () => {
  it("builds a sparkle-orchestrator stdio server with the bridge env in its env block", () => {
    const json = buildOrchestratorMcpConfig({
      nodePath: "/opt/homebrew/bin/node",
      serverPath: "/Applications/Sparkle.app/Contents/Resources/resources/mcp-orchestrator-server.js",
      socketPath: "/tmp/sparkle-orch-abc.sock",
      token: "deadbeef",
    });
    const parsed = JSON.parse(json);
    const srv = parsed.mcpServers["sparkle-orchestrator"];
    expect(srv.command).toBe("/opt/homebrew/bin/node");
    expect(srv.args).toEqual([
      "/Applications/Sparkle.app/Contents/Resources/resources/mcp-orchestrator-server.js",
    ]);
    expect(srv.env.SPARKLE_BRIDGE_SOCKET).toBe("/tmp/sparkle-orch-abc.sock");
    expect(srv.env.SPARKLE_BRIDGE_TOKEN).toBe("deadbeef");
  });

  it("produces a single-line JSON string (safe to single-quote into a zsh -c command)", () => {
    const json = buildOrchestratorMcpConfig({
      nodePath: "/n",
      serverPath: "/s",
      socketPath: "/sock",
      token: "t",
    });
    expect(json).not.toContain("\n");
    expect(json).not.toContain("'"); // no single quotes → shellQuote wraps cleanly
  });
});

describe("buildControlMcpConfig (sparkle-control MCP)", () => {
  it("builds a sparkle-control stdio server with socket/token/agent-id in its env block", () => {
    const json = buildControlMcpConfig({
      nodePath: "/opt/homebrew/bin/node",
      serverPath: "/res/resources/mcp-control-server.js",
      socketPath: "/tmp/sparkle-control.sock",
      token: "s3cr3t",
      agentId: "agent-42",
    });
    const srv = JSON.parse(json).mcpServers["sparkle-control"];
    expect(srv.command).toBe("/opt/homebrew/bin/node");
    expect(srv.args).toEqual(["/res/resources/mcp-control-server.js"]);
    expect(srv.env.SPARKLE_CONTROL_SOCKET).toBe("/tmp/sparkle-control.sock");
    expect(srv.env.SPARKLE_CONTROL_TOKEN).toBe("s3cr3t");
    expect(srv.env.SPARKLE_AGENT_ID).toBe("agent-42");
  });

  it("produces a single-line, single-quote-free JSON string", () => {
    const json = buildControlMcpConfig({
      nodePath: "/n", serverPath: "/s", socketPath: "/sock", token: "t", agentId: "a",
    });
    expect(json).not.toContain("\n");
    expect(json).not.toContain("'");
  });
});

describe("buildMergedMcpConfig (Build agent: orchestrator + control in one --mcp-config)", () => {
  it("keeps BOTH servers when merging the orchestrator and control maps", () => {
    const merged = buildMergedMcpConfig([
      orchestratorMcpServers({ nodePath: "/n", serverPath: "/orch.js", socketPath: "/o.sock", token: "ot" }),
      controlMcpServers({ nodePath: "/n", serverPath: "/ctl.js", socketPath: "/c.sock", token: "ct", agentId: "a1" }),
    ]);
    const servers = JSON.parse(merged).mcpServers;
    expect(Object.keys(servers).sort()).toEqual(["sparkle-control", "sparkle-orchestrator"]);
    expect(servers["sparkle-orchestrator"].env.SPARKLE_BRIDGE_TOKEN).toBe("ot");
    expect(servers["sparkle-control"].env.SPARKLE_AGENT_ID).toBe("a1");
  });
});

describe("plan mode (--permission-mode)", () => {
  it("emits the flag on a FRESH spawn", () => {
    const cmd = buildClaudeExec("/bin/claude", false, { permissionMode: "plan" });
    expect(cmd).toContain("--permission-mode 'plan'");
  });

  // The mode was a request made when the agent was CREATED, not a property of it. A human leaves
  // plan mode with shift+tab inside the session — invisible from here — so re-emitting the flag on
  // relaunch would silently drag them back into it, producing a "why won't it edit anything?" bug
  // with no visible cause.
  it("does NOT re-apply it on resume", () => {
    const cmd = buildClaudeExec("/bin/claude", true, { permissionMode: "plan" });
    expect(cmd).not.toContain("--permission-mode");
  });

  // "build" is the ABSENCE of the flag, never `--permission-mode default`: emitting an explicit
  // default would override a user who configured a different one in their own Claude Code settings.
  it("emits nothing when no mode was asked for", () => {
    expect(buildClaudeExec("/bin/claude", false, {})).not.toContain("--permission-mode");
  });

  // Opposite intentions — "approve everything unattended" vs "change nothing until I approve". A
  // caller asking for both has a bug; letting claude's flag precedence pick a winner would hide it.
  // Refused loudly because a WORKER launched in plan mode sits RED forever while its orchestrator
  // blocks in wait_for_workers.
  it("refuses plan mode combined with skip-permissions, on fresh AND resumed spawns", () => {
    for (const resume of [false, true]) {
      expect(() =>
        buildClaudeExec("/bin/claude", resume, {
          permissionMode: "plan",
          dangerouslySkipPermissions: true,
        }),
      ).toThrow(/mutually exclusive/);
    }
  });
});

// THE CREDENTIAL NAMESPACE IS THE RAW PATH STRING, so two spellings of one directory are two
// different Claude logins (bead sparkle-znusx). Claude Code v2.1.226 builds its keychain service
// name as `Claude Code-credentials-${sha256(CLAUDE_CONFIG_DIR).slice(0, 8)}` — over the path AS
// GIVEN, with no realpath and no separator normalization. Measured on the founder's machine, same
// directory, same second:
//
//     loggedIn=True    CLAUDE_CONFIG_DIR=…/accounts/5b0a0788de0c3754
//     loggedIn=False   CLAUDE_CONFIG_DIR=…/accounts/5b0a0788de0c3754/     ← trailing slash
//     loggedIn=False   CLAUDE_CONFIG_DIR=…/accounts/./5b0a0788de0c3754
//
// A trailing slash does not report an error. It reports NOT SIGNED IN — which the app reads as an
// account that needs logging in again, and a fresh login there writes a SECOND credential the first
// spelling can never see. So the invariant is not "the paths are equivalent" (the OS says they are;
// the keychain does not). It is that every spawn path emits the SAME BYTES.
describe("CLAUDE_CONFIG_DIR is emitted byte-identically by every spawn path", () => {
  const DIR = "/Users/x/Library/Application Support/ai.sparkle.desktop/accounts/5b0a0788de0c3754";
  // THROWS rather than returning undefined. A `\S+` capture here silently returned undefined for
  // every real account path (they all contain "Application Support"), which made `expect(login)
  // .toBe(spawn)` pass as undefined === undefined — a vacuous green over the exact assertion this
  // suite exists to make. A non-match is a broken test, not a passing one.
  const configExport = (cmd: string) => {
    const m = /export CLAUDE_CONFIG_DIR=(.*?); /.exec(cmd);
    if (!m) throw new Error(`no CLAUDE_CONFIG_DIR export in: ${cmd}`);
    return m[1];
  };

  // The login WRITES the credential and the agent spawn READS it. If these two ever disagree by one
  // byte, the account signs in successfully and every agent launched under it is logged out.
  it("the login and the agent spawn target the same string", () => {
    const login = configExport(buildClaudeLoginExec("/bin/claude", { configDir: DIR }));
    const spawn = configExport(buildClaudeExec("/bin/claude", false, { configDir: DIR }));
    expect(login).toBe(spawn);
    expect(login).toBe(shellQuote(DIR));
  });

  // Neither builder may "tidy" the path — no trailing-slash trim, no `.` collapse, no realpath. A
  // normalization that looks harmless here silently re-points the account at a different keychain
  // entry, and the account reads as signed out with no error anywhere.
  it("passes the caller's exact bytes through, including spellings that differ", () => {
    for (const dir of [DIR, `${DIR}/`, "/a/./b", "/a//b", "/tmp/dir with spaces"]) {
      for (const cmd of [
        buildClaudeLoginExec("/bin/claude", { configDir: dir }),
        buildClaudeExec("/bin/claude", false, { configDir: dir }),
      ]) {
        expect(configExport(cmd)).toBe(shellQuote(dir));
      }
    }
  });

  // The PTY session id is derived from that same string, so a sign-in can never be filed under an
  // account other than the one its exec targets.
  it("derives the sign-in PTY id from the same string, and never collides across accounts", () => {
    expect(claudeSignInPtyId(DIR, 0)).toBe(claudeSignInPtyId(DIR, 0));
    expect(claudeSignInPtyId(DIR, 0)).not.toBe(claudeSignInPtyId(DIR, 1));
    expect(claudeSignInPtyId(DIR, 0)).not.toBe(claudeSignInPtyId(`${DIR}-other`, 0));
    expect(claudeSignInPtyId(undefined, 0)).not.toBe(claudeSignInPtyId(DIR, 0));
    // Two spellings ARE two credentials, so they must be two sessions too — collapsing them here
    // would re-introduce the orphaned-PTY crossover through the back door.
    expect(claudeSignInPtyId(DIR, 0)).not.toBe(claudeSignInPtyId(`${DIR}/`, 0));
    // Usable as a session key and a React key: no separators, no quoting hazards.
    expect(claudeSignInPtyId(DIR, 0)).toMatch(/^claude-signin-[0-9a-f]{8}-0$/);
    expect(claudeSignInPtyId(undefined, 0)).toBe("claude-signin-default-0");
  });
});

// ══ NO SPAWNED AGENT MAY BE ABLE TO OPEN A PAGER (bead sparkle-w11lll) ═══════════════════════════
//
// THE INCIDENT. Two agents were found wedged on the ALTERNATE SCREEN — the state a pager puts a
// terminal in. An agent parked there is unreachable by EVERY automated path this app has:
// `dispatchConciergeAnswer` refuses each write with `alternate-screen`, auto-resume refuses
// identically and burns its retry budget until it escalates to a human, and the one key that quits
// a pager (`q`) was not in `send_control_key`'s vocabulary. A human had to press it by hand, while
// one of the two agents sat on five uncommitted files.
//
// WHAT THESE ASSERT, and why it is the side effect rather than a precondition: the exported STRING
// the login shell will run. That is the artifact — nothing else in this process decides whether the
// child gets a pager. Deleting PAGER_ENV_EXPORT from either builder turns every case below red.
describe("non-interactive pager (bead sparkle-w11lll)", () => {
  const PAGER_VARS = [
    ["PAGER", "cat"],
    ["GIT_PAGER", "cat"],
    ["GH_PAGER", "cat"],
    ["SYSTEMD_PAGER", "cat"],
    ["MANPAGER", "cat"],
    // FRX, and `X` is the letter that matters: it keeps `less` OFF the alternate screen even when
    // some tool execs it directly, ignoring every variable above. `F` quits when the content fits
    // one screen; `R` keeps colour readable.
    ["LESS", "FRX"],
  ] as const;

  it.each(PAGER_VARS)("exports %s=%s before the agent exec", (name, value) => {
    const exec = buildClaudeExec("/bin/claude", false);
    expect(exec).toContain(`${name}=${value}`);
    // BEFORE the exec, or it accomplishes nothing — the same ordering requirement the ANTHROPIC
    // unset has, for the same reason.
    expect(exec.indexOf(`${name}=${value}`)).toBeLessThan(exec.indexOf("exec "));
  });

  it.each(PAGER_VARS)("exports %s=%s before the login exec too", (name, value) => {
    const exec = buildClaudeLoginExec("/bin/claude");
    expect(exec).toContain(`${name}=${value}`);
    expect(exec.indexOf(`${name}=${value}`)).toBeLessThan(exec.indexOf("exec "));
  });

  // THE ORDERING THIS REALLY PINS, and the reason the Rust-side `pty.rs` env is NOT enough on its
  // own. This string is handed to `zsh -l -c` — a LOGIN shell, which sources the user's
  // `.zprofile`/`.zlogin` AFTER `pty.rs` has applied its environment. A profile line as ordinary as
  // `export GIT_PAGER=less` therefore clobbers the Rust value. The export has to happen INSIDE the
  // script, after the profile has run, which is what this asserts.
  it("exports the pager vars inside the script, so a login profile cannot clobber them", () => {
    const exec = buildClaudeExec("/bin/claude", false);
    expect(exec).toMatch(/export [^;]*\bGIT_PAGER=cat\b/);
  });

  // A resumed agent is exactly as capable of running `git log` as a fresh one, and resume is the
  // path a wedged agent is most likely to be on.
  it("forces the pager on a RESUMED agent too", () => {
    expect(buildClaudeExec("/bin/claude", true)).toContain("GIT_PAGER=cat");
  });

  // The unattended worker is the case that actually cost work: it auto-approves its own tool calls,
  // so nothing stands between it and a `git diff` that pages.
  it("forces the pager on an unattended --dangerously-skip-permissions worker", () => {
    const exec = buildClaudeExec("/bin/claude", false, { dangerouslySkipPermissions: true });
    expect(exec).toContain("PAGER=cat");
    expect(exec.indexOf("PAGER=cat")).toBeLessThan(exec.indexOf("exec "));
  });
});
