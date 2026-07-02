import { describe, it, expect, vi } from "vitest";

// orchestrationLaunch.ts imports `invoke` at the top level; provide a no-op mock so the module
// loads cleanly in the Node test environment. The tested function (assembleBuildSpawn) is pure
// and never calls invoke — this mock is infrastructure only.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { assembleBuildSpawn } from "./orchestrationLaunch";

describe("assembleBuildSpawn", () => {
  const base = {
    claudePath: "/usr/local/bin/claude",
    resume: false,
    cwd: "/wt/build",
    persona: "ORCHESTRATOR persona text",
    bridge: { socketPath: "/tmp/sparkle-orch-abc.sock", token: "deadbeef" },
    paths: { nodePath: "/opt/homebrew/bin/node", serverPath: "/res/mcp-orchestrator-server.js" },
  };

  it("spawns /bin/zsh -l -c with the orchestrator launch", () => {
    const s = assembleBuildSpawn(base);
    expect(s.command).toBe("/bin/zsh");
    expect(s.args[0]).toBe("-l");
    expect(s.args[1]).toBe("-c");
    expect(s.cwd).toBe("/wt/build");
  });

  it("includes --mcp-config (with bridge socket+token+server), --strict-mcp-config, and the persona", () => {
    const exec = assembleBuildSpawn(base).args[2];
    expect(exec).toContain("--mcp-config");
    expect(exec).toContain("--strict-mcp-config");
    expect(exec).toContain("--append-system-prompt 'ORCHESTRATOR persona text'");
    expect(exec).toContain("/tmp/sparkle-orch-abc.sock");
    expect(exec).toContain("deadbeef");
    expect(exec).toContain("/res/mcp-orchestrator-server.js");
    expect(exec).toContain("/opt/homebrew/bin/node");
  });

  it("adds --continue on a resumed session", () => {
    const exec = assembleBuildSpawn({ ...base, resume: true }).args[2];
    expect(exec).toContain("--continue");
  });

  it("propagates a chosen account's configDir into the exec (multi Claude Max support)", () => {
    const exec = assembleBuildSpawn({ ...base, configDir: "/data/accounts/ab12" }).args[2];
    expect(exec).toContain("export CLAUDE_CONFIG_DIR='/data/accounts/ab12';");
  });

  it("omits the CLAUDE_CONFIG_DIR export when no account is chosen (default behavior)", () => {
    const exec = assembleBuildSpawn(base).args[2];
    expect(exec).not.toContain("CLAUDE_CONFIG_DIR");
  });

  // Per-agent model selection (sparkle-i6rw): the pass-through into buildClaudeExec.
  it("carries the agent's model into the exec as --model <id>", () => {
    const exec = assembleBuildSpawn({ ...base, model: "claude-opus-4-8" }).args[2];
    expect(exec).toContain("--model 'claude-opus-4-8'");
  });

  it("omits --model for the 'default' sentinel and when no model is set", () => {
    expect(assembleBuildSpawn(base).args[2]).not.toContain("--model");
    expect(assembleBuildSpawn({ ...base, model: "default" }).args[2]).not.toContain("--model");
  });
});
