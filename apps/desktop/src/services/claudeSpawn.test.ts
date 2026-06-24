import { describe, it, expect } from "vitest";
import { buildClaudeExec, shellQuote } from "./claudeSpawn";

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
