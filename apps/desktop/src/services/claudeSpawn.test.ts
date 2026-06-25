import { describe, it, expect } from "vitest";
import { buildClaudeExec, shellQuote, buildOrchestratorMcpConfig } from "./claudeSpawn";

const PATH_PREFIX = `export PATH="$HOME/.local/bin:$PATH"; `;

describe("buildClaudeExec ()", () => {
  it("appends --continue when a prior session exists", () => {
    expect(buildClaudeExec("/usr/local/bin/claude", true)).toBe(
      `${PATH_PREFIX}exec '/usr/local/bin/claude' --continue`,
    );
  });

  it("spawns plain claude when there is no session", () => {
    expect(buildClaudeExec("/usr/local/bin/claude", false)).toBe(
      `${PATH_PREFIX}exec '/usr/local/bin/claude'`,
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
      `${PATH_PREFIX}exec '/path with space/claude'`,
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
      `${PATH_PREFIX}exec '/bin/claude' --append-system-prompt 'be helpful' --add-dir '/logs' -- 'start now'`,
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
    expect(cmd).toBe(`${PATH_PREFIX}exec '/bin/claude' -- '-oops looks like a flag'`);
  });

  it("skips the initial mission prompt on resume so it doesn't re-run every relaunch", () => {
    const cmd = buildClaudeExec("/bin/claude", true, {
      appendSystemPrompt: "persona",
      initialPrompt: "start now",
    });
    // --continue + persona, but NO trailing positional prompt.
    expect(cmd).toBe(`${PATH_PREFIX}exec '/bin/claude' --continue --append-system-prompt 'persona'`);
    expect(cmd).not.toContain("start now");
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
      `${PATH_PREFIX}exec '/bin/claude' --mcp-config '{"mcpServers":{}}' --strict-mcp-config --append-system-prompt 'be an orchestrator'`,
    );
  });

  it("orders --mcp-config after --continue on a resumed session", () => {
    const cmd = buildClaudeExec("/bin/claude", true, {
      mcpConfig: "{}",
      strictMcpConfig: true,
      appendSystemPrompt: "persona",
    });
    expect(cmd).toBe(
      `${PATH_PREFIX}exec '/bin/claude' --continue --mcp-config '{}' --strict-mcp-config --append-system-prompt 'persona'`,
    );
  });

  it("omits --strict-mcp-config when not requested", () => {
    const cmd = buildClaudeExec("/bin/claude", false, { mcpConfig: "{}" });
    expect(cmd).toBe(`${PATH_PREFIX}exec '/bin/claude' --mcp-config '{}'`);
  });

  it("initialPrompt is separated by `--` even when mcpConfig is present, so it isn't swallowed", () => {
    // `--strict-mcp-config` terminates the MCP config list; the `--` separator (added by the
    // initialPrompt path) terminates option parsing entirely so the prompt is never swallowed as
    // another MCP config file or `--add-dir` path.
    const cmd = buildClaudeExec("/bin/claude", false, { mcpConfig: "{}", initialPrompt: "go" });
    expect(cmd).toBe(`${PATH_PREFIX}exec '/bin/claude' --mcp-config '{}' -- 'go'`);
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
