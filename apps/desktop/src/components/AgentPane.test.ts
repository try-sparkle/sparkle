// apps/desktop/src/components/AgentPane.test.ts
// Unit tests for pure helpers extracted from AgentPane — kept thin and dependency-free
// so they can run in the node env without mocking any Tauri/React machinery.
import { describe, it, expect } from "vitest";
import { buildShellSpawnArgs } from "./AgentPane";

describe("buildShellSpawnArgs — injection-safety invariant", () => {
  it("the command is passed strictly as a positional arg (args[4]), never interpolated into the script string (args[2])", () => {
    const cmd = 'npm run build && echo "done"';
    const args = buildShellSpawnArgs("/bin/zsh", cmd);
    // The command must be the last (positional) element, verbatim.
    expect(args[4]).toBe(cmd);
    // The script string must contain the $1 placeholder, NOT the literal command.
    expect(args[2]).toContain("$1");
    expect(args[2]).not.toContain(cmd);
  });

  it("a command with shell-injection characters stays in the positional slot without escaping", () => {
    // A selection ending in a backslash or containing quotes must not break the script string.
    const cmd = '"; rm -rf / #';
    const args = buildShellSpawnArgs("/bin/zsh", cmd);
    expect(args[4]).toBe(cmd);
    expect(args[2]).not.toContain(cmd);
  });

  it("the shell path is passed as $0 (args[3]), not concatenated into the script", () => {
    const shell = "/bin/zsh";
    const args = buildShellSpawnArgs(shell, "ls");
    expect(args[3]).toBe(shell);
    // args[2] is the script; the shell path must not be interpolated there.
    expect(args[2]).not.toContain(shell);
  });
});
