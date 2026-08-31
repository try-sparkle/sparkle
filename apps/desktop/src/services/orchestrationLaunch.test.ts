import { describe, it, expect, vi } from "vitest";

// orchestrationLaunch.ts imports `invoke` at the top level; provide a no-op mock so the module
// loads cleanly in the Node test environment. The tested function (assembleBuildSpawn) is pure
// and never calls invoke — this mock is infrastructure only.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { assembleBuildSpawn } from "./orchestrationLaunch";
import { RESUME_PROMPT_SUPPRESS_MINUTES, RESUME_PROMPT_SUPPRESS_TOKENS } from "./claudeSpawn";

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

  it("exports SPARKLE_INBOX_AGENT for the build agent's own claude (bead sparkle-ei7keg)", () => {
    // The Stop hook drains this agent's inbox only for a process carrying this proof. A build agent
    // spawned without it keeps its queue but loses turn-boundary delivery, silently.
    expect(assembleBuildSpawn({ ...base, agentId: "build-7" }).args[2]).toContain(
      "export SPARKLE_INBOX_AGENT='build-7'; ",
    );
  });

  it("takes the inbox id from agentId, NOT from the best-effort control wiring", () => {
    // `control` is optional — it is omitted whenever the control bridge failed to start. Deriving
    // the ownership proof from it would mean an MCP hiccup silently costs the agent its messages.
    const exec = assembleBuildSpawn({ ...base, agentId: "build-7" }).args[2];
    expect(exec).toContain("export SPARKLE_INBOX_AGENT='build-7'; ");
    expect(exec).not.toContain("SPARKLE_AGENT_ID"); // no control server in `base`
  });

  it("omits the export when no agentId is passed", () => {
    expect(assembleBuildSpawn(base).args[2]).not.toContain("SPARKLE_INBOX_AGENT");
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

  // bead sparkle-bucbkp: an UNATTENDED orchestrator/epic that --resumes an old, large session must
  // never stop on Claude Code's "resume from summary?" picker — nobody is watching its pane, so the
  // prompt escalates to the founder. The belt the worker path already sets (AgentPane.tsx) pushes
  // the gate's age/token thresholds out of reach so the picker never draws. This asserts the SIDE
  // EFFECT — the exec actually carries both env exports at their unreachable ceilings — not merely
  // that a flag was passed. Removing `suppressResumePrompt: true` from assembleBuildSpawn turns it
  // red (mutation-checked), which is the escalation the founder reported.
  it("suppresses the resume-from-summary picker for the unattended orchestrator (bead sparkle-bucbkp)", () => {
    const exec = assembleBuildSpawn({ ...base, resume: true }).args[2] ?? "";
    expect(exec).toContain(
      `export CLAUDE_CODE_RESUME_THRESHOLD_MINUTES=${RESUME_PROMPT_SUPPRESS_MINUTES}; `,
    );
    expect(exec).toContain(
      `export CLAUDE_CODE_RESUME_TOKEN_THRESHOLD=${RESUME_PROMPT_SUPPRESS_TOKENS}; `,
    );
    // The exports must precede the `exec claude …` they are meant to scope, or the child never sees
    // them — the same ordering the claudeSpawn suite pins for the worker path.
    expect(exec.indexOf("CLAUDE_CODE_RESUME_TOKEN_THRESHOLD")).toBeLessThan(exec.indexOf("exec "));
  });

  // PAIRED with the above: the belt is unconditional (harmless on a fresh spawn — the gate needs a
  // prior session to fire at all), so a NON-resumed orchestrator still carries it. This pins that
  // the suppression rides EVERY orchestrator launch and is not silently gated on `resume`, which
  // would reopen the wedge for the --resume path the bug is actually about.
  it("carries the resume-suppress belt even on a fresh (non-resumed) orchestrator spawn", () => {
    const exec = assembleBuildSpawn(base).args[2];
    expect(exec).toContain("export CLAUDE_CODE_RESUME_THRESHOLD_MINUTES=");
    expect(exec).toContain("export CLAUDE_CODE_RESUME_TOKEN_THRESHOLD=");
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

  it("merges the sparkle-control server into the SAME --mcp-config as the orchestrator (never drops it)", () => {
    const exec = assembleBuildSpawn({
      ...base,
      control: {
        bridge: { socketPath: "/tmp/control.sock", token: "ctltok" },
        paths: { nodePath: "/opt/homebrew/bin/node", serverPath: "/res/mcp-control-server.js" },
        agentId: "build-1",
      },
    }).args[2];
    // Both servers ride in one --mcp-config; the orchestrator is NOT dropped.
    expect(exec).toContain("sparkle-orchestrator");
    expect(exec).toContain("sparkle-control");
    expect(exec).toContain("/res/mcp-control-server.js");
    expect(exec).toContain("ctltok");
    expect(exec).toContain("build-1");
    // Still exactly one --mcp-config flag.
    expect(exec!.match(/--mcp-config/g)).toHaveLength(1);
  });

  it("emits only the orchestrator server when no control wiring is provided (back-compat)", () => {
    const exec = assembleBuildSpawn(base).args[2];
    expect(exec).toContain("sparkle-orchestrator");
    expect(exec).not.toContain("sparkle-control");
  });
});
