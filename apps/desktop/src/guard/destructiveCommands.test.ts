// The destructive-command guard, driven by the SHARED contract.
//
// `apps/desktop/shared/destructive-commands.json` is read here and by `worktree.rs`'s
// `deny_rules_match_the_shared_fixture`. That is the anti-drift device: the Rust half writes
// `permissions.deny` into every agent worktree and this half implements the compound-aware guard,
// and neither can quietly diverge from the other because both suites fail on the same file.
//
// `mustAllow` is the half that matters most. Every entry in it is a verbatim refusal an agent hit
// BEFORE this change — re-blocking one would rebuild the wall this work exists to tear down, and
// this time with no approval path through it.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { blocksDestructiveCommand } from "../../src-tauri/resources/worktree-guard.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(here, "..", "..", "shared", "destructive-commands.json"), "utf8"),
) as {
  denyRules: string[];
  mustBlock: { command: string; why: string; guardOnly?: boolean }[];
  // Multi-line attack shapes, in their own list because a command carrying a newline is something
  // the prefix-matched deny layer can never see — and because every entry here was a bypass whose
  // SINGLE-LINE sibling passed while missing it entirely (a here-string swallowing the next line,
  // a quoted `<<EOF` opening a body). A one-line corpus cannot pin a multi-line defect.
  mustBlockMultiline: { command: string; why: string }[];
  mustAllow: { command: string; why: string }[];
};

describe("blocksDestructiveCommand — the mustBlock corpus", () => {
  it("the fixture actually has entries (a silently empty corpus would make every case vacuous)", () => {
    expect(fixture.mustBlock.length).toBeGreaterThan(20);
    expect(fixture.mustAllow.length).toBeGreaterThan(20);
    // `it.each([])` produces ZERO tests and a silently green suite — the exact vacuity the two
    // assertions above exist to prevent, which the multi-line list shipped without.
    expect(fixture.mustBlockMultiline.length).toBeGreaterThan(0);
  });

  it("every mustBlockMultiline entry is actually multi-line", () => {
    // The list earns its separate existence only if its entries carry a newline: a single-line case
    // belongs in `mustBlock`, where the deny layer's coverage test can see it too. Four entries had
    // drifted in here with no newline at all, contradicting the list's own documented contract.
    for (const { command } of fixture.mustBlockMultiline) {
      expect(command, `not multi-line: ${command}`).toContain("\n");
    }
  });

  it.each(fixture.mustBlockMultiline)("blocks a MULTI-LINE command — $why", ({ command }) => {
    const verdict = blocksDestructiveCommand(command);
    expect(verdict, `expected a refusal for:\n${command}`).not.toBeNull();
  });

  it.each(fixture.mustBlock)("blocks `$command` — $why", ({ command }) => {
    const verdict = blocksDestructiveCommand(command);
    expect(verdict, `expected a refusal for: ${command}`).not.toBeNull();
    expect(typeof verdict!.rule).toBe("string");
    expect(verdict!.why.length).toBeGreaterThan(0);
  });
});

describe("blocksDestructiveCommand — the mustAllow corpus", () => {
  it.each(fixture.mustAllow)("allows `$command` — $why", ({ command }) => {
    expect(blocksDestructiveCommand(command), `expected NO refusal for: ${command}`).toBeNull();
  });
});

describe("blocksDestructiveCommand — command-position anchoring", () => {
  // The difference between a guard and a substring search. Both of these CONTAIN a denied command.
  it("a denied command inside a quoted string is not an invocation", () => {
    expect(blocksDestructiveCommand(`echo "about to rm -rf / — just kidding"`)).toBeNull();
    expect(blocksDestructiveCommand(`git commit -m "stop calling sudo in scripts"`)).toBeNull();
  });
  it("a word that merely contains a denied binary's name is a different command", () => {
    expect(blocksDestructiveCommand("sudoku --solve puzzle.txt")).toBeNull();
    expect(blocksDestructiveCommand("./scripts/rm-stale-branches.sh")).toBeNull();
  });
  it("but the same command in command position IS blocked", () => {
    expect(blocksDestructiveCommand("rm -rf /")).not.toBeNull();
    expect(blocksDestructiveCommand("sudo -n true")).not.toBeNull();
  });
});

describe("blocksDestructiveCommand — compound laundering", () => {
  // `permissions.deny` is prefix-matched and cannot see past the first word; this guard is the
  // layer that can, which is the entire reason it exists.
  it.each([
    "cd /tmp && rm -rf ~",
    "cd repo; git push origin main",
    "echo starting && cd x && git clean -fdx",
    "true || sudo reboot",
  ])("sees the destructive segment in `%s`", (command) => {
    expect(blocksDestructiveCommand(command)).not.toBeNull();
  });
});

describe("blocksDestructiveCommand — the rm depth rule", () => {
  // Sparkle's OWN worktrees live deep under $HOME, so a blanket "under $HOME" rule would refuse
  // ordinary cleanup inside an agent's own lane. Home itself and one level below it are the line.
  it("blocks the home directory and its immediate children", () => {
    expect(blocksDestructiveCommand("rm -rf ~")).not.toBeNull();
    expect(blocksDestructiveCommand("rm -rf $HOME/Projects")).not.toBeNull();
    expect(blocksDestructiveCommand("rm -rf ${HOME}/Documents")).not.toBeNull();
    expect(blocksDestructiveCommand("rm -rf /Users/alice/Projects")).not.toBeNull();
  });
  it("allows cleanup deep inside an agent's own worktree", () => {
    expect(
      blocksDestructiveCommand(
        'rm -rf "$HOME/Library/Application Support/ai.sparkle.desktop/worktrees/p/a/node_modules"',
      ),
    ).toBeNull();
    expect(blocksDestructiveCommand("rm -rf /Users/alice/dev/myrepo/dist")).toBeNull();
  });
  it("only the pairing of recursive AND a catastrophic root is denied", () => {
    expect(blocksDestructiveCommand("rm -f /Users/alice")).toBeNull(); // not recursive
    expect(blocksDestructiveCommand("rm -rf build")).toBeNull(); // not catastrophic
  });
});

describe("blocksDestructiveCommand — git push", () => {
  it("allows the safe force variant but not the unsafe one", () => {
    expect(blocksDestructiveCommand("git push --force-with-lease origin my-feature")).toBeNull();
    expect(blocksDestructiveCommand("git push --force origin my-feature")).not.toBeNull();
  });
  it("catches every spelling of the default branch", () => {
    for (const c of [
      "git push origin main",
      "git push origin master",
      "git push origin HEAD:main",
      "git push origin +refs/heads/main",
      "git push origin --delete main",
    ]) {
      expect(blocksDestructiveCommand(c), c).not.toBeNull();
    }
  });
  it("leaves an agent's own branch alone", () => {
    expect(blocksDestructiveCommand("git push origin sparkle/agent-2d2a12f9")).toBeNull();
    expect(blocksDestructiveCommand("git push -u origin maintenance-notes")).toBeNull();
  });
});

describe("blocksDestructiveCommand — input handling", () => {
  it("allows anything it cannot read as a command", () => {
    expect(blocksDestructiveCommand("")).toBeNull();
    expect(blocksDestructiveCommand(undefined)).toBeNull();
    expect(blocksDestructiveCommand(null)).toBeNull();
    expect(blocksDestructiveCommand(42)).toBeNull();
    expect(blocksDestructiveCommand({ command: "rm -rf /" })).toBeNull();
  });
});
