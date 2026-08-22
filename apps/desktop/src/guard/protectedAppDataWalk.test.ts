// The TCC home-walk guard, driven by the SHARED contract (bead sparkle-cj4sl7).
//
// WHAT IS BEING GUARDED. macOS makes the spawning app the TCC "responsible process" for every
// descendant, so when an AGENT runs `find ~ …` the resulting "would like to access data from other
// apps" dialog is attributed to Sparkle. It fires once PER PROTECTED CONTAINER touched, which is why
// one stray sweep reads to the user as a storm of dialogs. Nothing in Sparkle's own code walks that
// broadly; the walks came from agent behaviour, so the durable fix is a guardrail on the command.
//
// WHY NOT JUST DISCLAIM RESPONSIBILITY (the obvious fix, measured and rejected): a disclaimed child
// is judged on its OWN identity, which for `/bin/zsh` is a platform binary — and tccd's policy there
// is "prompting is 'Deny'". The access is refused with no dialog and no System Settings entry to
// grant it back, so agents would silently lose ~/Desktop, ~/Documents and ~/Downloads.
//
// `mustAllowAppDataWalk` is the half that matters most. Under `bypassPermissions` a refusal has NO
// approval path, so a false positive here is a hard wall in front of a read-only diagnostic.
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { blocksProtectedAppDataWalk } from "../../src-tauri/resources/worktree-guard.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const guard = join(here, "..", "..", "src-tauri", "resources", "worktree-guard.mjs");
const fixture = JSON.parse(
  readFileSync(join(here, "..", "..", "shared", "destructive-commands.json"), "utf8"),
) as {
  mustBlockAppDataWalk: { command: string; why: string }[];
  mustAllowAppDataWalk: { command: string; why: string }[];
};

/** The corpus is written against a fixed home so it reads the same on every machine. */
const HOME = "/Users/tester";

describe("blocksProtectedAppDataWalk — the shared corpus", () => {
  it("the fixture actually has entries (an empty corpus makes every `it.each` case vacuous)", () => {
    expect(fixture.mustBlockAppDataWalk.length).toBeGreaterThan(10);
    expect(fixture.mustAllowAppDataWalk.length).toBeGreaterThan(10);
  });

  it.each(fixture.mustBlockAppDataWalk)("blocks `$command` — $why", ({ command }) => {
    const verdict = blocksProtectedAppDataWalk(command, HOME);
    expect(verdict, `expected a refusal for: ${command}`).not.toBeNull();
    expect(verdict!.rule).toBe("protected-app-data-walk");
    // The refusal must NAME what it reached, or the remedy cannot be acted on.
    expect(verdict!.reached.length).toBeGreaterThan(0);
    for (const p of verdict!.reached) expect(p.startsWith(HOME)).toBe(true);
  });

  it.each(fixture.mustAllowAppDataWalk)("allows `$command` — $why", ({ command }) => {
    expect(
      blocksProtectedAppDataWalk(command, HOME),
      `unexpected refusal for: ${command}`,
    ).toBeNull();
  });
});

// A test that only proves ABSENCE is ambiguous — it passes just as well when the rule is keyed to
// nothing at all. Each pair below shows the SAME walk flipping on the one property under test, so
// the allowed half cannot go green by the rule being inert.
describe("the discriminator actually discriminates (paired cases)", () => {
  it("-prune is honoured, and its absence is what makes the same walk a refusal", () => {
    const pruned =
      "find ~ \\( -path '*/Library' -o -path '*/.walletwasabi' \\) -prune -o -name x -print";
    const unpruned = "find ~ -name x";
    expect(blocksProtectedAppDataWalk(pruned, HOME)).toBeNull();
    expect(blocksProtectedAppDataWalk(unpruned, HOME)).not.toBeNull();
  });

  it("`-not -path` does NOT count as pruning — it filters output but still descends", () => {
    // The two halves must carry the SAME patterns, covering EVERY protected container, so the only
    // variable left is the spelling. An earlier version used `-not -path '*/Library/*'`, which left
    // `~/.walletwasabi` (not under Library) unmatched — so the refusal came from that leftover
    // container and the case stayed green even when `-not` was wrongly treated as a prune. It
    // asserted the right verdict for the wrong reason; a mutant proved it.
    const patterns = "-path '*/Library' -o -path '*/.walletwasabi'";
    const notPath = "find ~ -not -path '*/Library' -not -path '*/.walletwasabi' -name x";
    const prune = `find ~ \\( ${patterns} \\) -prune -o -name x -print`;
    expect(blocksProtectedAppDataWalk(notPath, HOME)).not.toBeNull();
    expect(blocksProtectedAppDataWalk(prune, HOME)).toBeNull();
  });

  it("a depth flag bounds traversal for find but NOT for du", () => {
    expect(blocksProtectedAppDataWalk("find ~ -maxdepth 1 -name x", HOME)).toBeNull();
    // Same depth, same root — du still stats the whole tree, so it stays a refusal.
    expect(blocksProtectedAppDataWalk("du -d 1 ~", HOME)).not.toBeNull();
  });

  it("the root is what matters, not the binary", () => {
    expect(blocksProtectedAppDataWalk("find ~/Projects -name x", HOME)).toBeNull();
    expect(blocksProtectedAppDataWalk("find ~/Library -name x", HOME)).not.toBeNull();
  });
});

// The corpus injects `home`, so the predicate's `home = homedir()` default is a DEFAULTED SEAM that
// no corpus entry can cover: delete that default and the suite above stays green while the shipped
// hook stops resolving anyone's home. These two drive the REAL hook as a process — the production
// entry point, with the default in play — and assert the side effect that matters, exit code 2.
describe("the shipped hook blocks the walk end-to-end", () => {
  const run = (command: string) => {
    try {
      execFileSync("node", [guard, process.cwd()], {
        input: JSON.stringify({ tool_input: { command }, cwd: process.cwd() }),
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      return { status: 0, stderr: "" };
    } catch (e) {
      const err = e as { status: number; stderr: string };
      return { status: err.status, stderr: err.stderr };
    }
  };

  it("exits 2 and names the containers for a real home walk", () => {
    // Built from the REAL home on purpose: this is the case the injected-home corpus cannot reach.
    const { status, stderr } = run(`find ${homedir()} -maxdepth 5 -name cli.js`);
    expect(status).toBe(2); // only exit 2 makes Claude Code block the tool call
    expect(stderr).toContain("TCC-protected app data");
    expect(stderr).toContain("Library/CloudStorage");
    // The remedy has to be present, or the refusal is a dead end.
    expect(stderr).toContain("-prune");
  });

  it("exits 0 for a walk that reaches nothing protected", () => {
    expect(run(`find ${join(homedir(), ".claude")} -name x`).status).toBe(0);
  });
});

// A RELATIVE root is the one place the predicate's purity leaks: `relative()` resolves a relative
// path against `process.cwd()`, so without the explicit `isAbsolute` bail the verdict for
// `find Library -name x` would depend on where the agent happens to be standing — and an agent
// standing in a worktree under home would have every ordinary relative search refused. Every other
// case in this file runs from the worktree, where a relative root resolves clear of the fixed home
// and the guard cannot be seen to do anything; only chdir'ing INTO the home under test exposes it.
describe("a relative root is never a home-tree root, wherever the agent is standing", () => {
  it("stays allowed even when cwd IS the home the walk is judged against", () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "walkguard-")));
    const before = process.cwd();
    try {
      process.chdir(home);
      // Relative: the cwd is an agent worktree by contract, not the home tree — allowed.
      expect(blocksProtectedAppDataWalk("find Library -name x", home)).toBeNull();
      // The SAME walk spelled absolutely, from the SAME cwd, is a refusal — so the case above is
      // green because the root is relative, not because the rule is inert here.
      expect(blocksProtectedAppDataWalk(`find ${join(home, "Library")} -name x`, home)).not.toBeNull();
    } finally {
      process.chdir(before);
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// A recursion test written only against SHORT flag bundles is a bypass, not a narrowing: after the
// first dash of `--recursive` comes another dash, so `^-[A-Za-z]*R` never matches it. The pair
// below flips ONLY the spelling — same binary, same root, same recursion — so it cannot go green by
// the rule being keyed to the root alone. The third case is the other half of the mistake: a
// pattern loose enough to catch `--recursive` also catches `--reverse`, which does not recurse.
describe("recursion is detected in BOTH spellings, and only where it is real", () => {
  it.each([
    ["ls", "-R"],
    ["ls", "--recursive"],
    ["grep pat", "-r"],
    ["grep pat", "-R"],
    ["grep pat", "--recursive"],
    ["grep pat", "--dereference-recursive"],
  ])("`%s %s ~/Library` is a refusal", (head, flag) => {
    expect(blocksProtectedAppDataWalk(`${head} ${flag} ${HOME}/Library`, HOME)).not.toBeNull();
  });

  it.each([
    ["ls", "--reverse"],
    ["ls", "--almost-all"],
    ["grep pat", "--regexp=x"],
    ["grep pat", "--color"],
  ])("`%s %s ~/Library` is allowed — it does not recurse", (head, flag) => {
    expect(blocksProtectedAppDataWalk(`${head} ${flag} ${HOME}/Library`, HOME)).toBeNull();
  });
});

// Two bypasses roborev 67769 found in the --recursive fix, both of which FAIL SILENTLY rather than
// loudly: neither produces a wrong refusal you could notice, they just make the walk invisible.
describe("the pattern operand is recognised in every spelling, so the PATH is never eaten", () => {
  // When the pattern comes from a flag, EVERY operand is a path. If an attached spelling
  // (`--regexp=X`, `-eX`) is not recognised, the lone remaining operand — the path — is consumed
  // as the pattern, the walk is judged with NO ROOTS, and "no roots" reads as "reaches nothing".
  // That is the worst possible failure shape for a guard: a clean allow with nothing to see.
  it.each([
    "grep -r -e Chrome /Users/tester/Library",
    "grep -r --regexp=Chrome /Users/tester/Library",
    "grep -r -eChrome /Users/tester/Library",
    "rg --regexp=foo /Users/tester/Library",
    "rg -efoo /Users/tester/Library",
    "rg --file=pats.txt /Users/tester/Library",
    // BUNDLED short flags carrying the value on the last one — ordinary POSIX/GNU/BSD syntax, and
    // the half a prefix-anchored `startsWith("-e")` misses (roborev 67805). `rg` needs no
    // recursion flag at all, so for it the bundle is the entire bypass.
    "grep -reChrome /Users/tester/Library",
    "grep -rfpats.txt /Users/tester/Library",
    "rg -ieChrome /Users/tester/Library",
    "rg -ifpats.txt /Users/tester/Library",
    // The SEPARATED bundle survives by a different route — `Chrome` stays its own operand, so the
    // slice drops it and the path lives. Asserting it here pins BOTH routes to the same verdict.
    "grep -re Chrome /Users/tester/Library",
    // `--files` takes NO pattern at all: it recursively lists every file under the root. Nothing
    // may slice an operand off as "the pattern", or the walk is judged with no roots (roborev
    // 67812) — the same silent allow, on a command that raises a dialog per container.
    "rg --files /Users/tester/Library",
  ])("`%s` is a refusal — the operand left is a PATH, not a pattern", (command) => {
    const verdict = blocksProtectedAppDataWalk(command, HOME);
    expect(verdict, `expected a refusal for: ${command}`).not.toBeNull();
    // Naming the root is what proves the path was READ rather than swallowed: a verdict built
    // from an empty root list cannot exist, so this assertion cannot pass by accident.
    expect(verdict!.root).toBe(`${HOME}/Library`);
  });

  it("a bundle whose value is in the NEXT word does not supply the pattern — the trailing dot", () => {
    // The over-match half, and it took two tries to write honestly: `-A5` was the obvious guess and
    // proves NOTHING, because it fails `[ef]` with or without the trailing `.`. The character that
    // the dot actually decides is a bundle ENDING in `e`/`f`, whose value is the next word.
    //
    // `grep -re <string> ~/Projects` SEARCHES FOR a protected path as a literal; it does not walk
    // one. Drop the dot and `-re` reads as pattern-supplying, so the first operand stops being a
    // pattern and becomes a ROOT — the Containers string is then refused as a walk that never
    // happened. Under bypassPermissions that false refusal has no way around it, which is why the
    // over-match half is asserted as hard as the under-match half.
    expect(
      blocksProtectedAppDataWalk(
        `grep -re ${HOME}/Library/Containers ${HOME}/Projects`,
        HOME,
      ),
    ).toBeNull();
    // Same binary, same operands, ONE character different — the value is now attached, so every
    // operand really is a path and the Containers root is real.
    expect(
      blocksProtectedAppDataWalk(
        `grep -rex ${HOME}/Library/Containers ${HOME}/Projects`,
        HOME,
      ),
    ).not.toBeNull();
  });

  it("a letter inside ANOTHER flag's value is not a flag — `-tdocker` carries no `-e`", () => {
    // The regression roborev 67812 caught, and the reason the flag table exists. A scan that hunts
    // the whole word for an `e`/`f` fires on ripgrep's TYPE NAMES: `-tdocker` ends `ck|e|r` and
    // `-tswift` ends `wi|f|t`. Neither supplies a pattern, so promoting their operand to a root
    // refuses an ORDINARY search for a protected path as a literal string — a false refusal, which
    // under bypassPermissions has no approval path around it.
    for (const flag of ["-tdocker", "-tswift", "-rfoo", "-gfoo.rs", "-A5", "-m2"]) {
      expect(
        blocksProtectedAppDataWalk(
          `rg ${flag} ${HOME}/Library/Containers ${HOME}/Projects`,
          HOME,
        ),
        `expected no refusal for rg ${flag}`,
      ).toBeNull();
    }
    // …and the pattern flag in the SAME position still fires, so the scan is not simply inert.
    expect(
      blocksProtectedAppDataWalk(`rg -edocker ${HOME}/Library/Containers ${HOME}/Projects`, HOME),
    ).not.toBeNull();
  });

  it("grep is judged with GREP's flag table, not ripgrep's", () => {
    // A recursive grep borrows ripgrep's OPERAND SHAPE, but its flags are grep's — and rg's `-r`
    // takes a value while grep's does not. Borrow the wrong table and the bundle scan stops at the
    // `r`, never reaches the `e`, and `grep -reChrome` goes dark again.
    expect(blocksProtectedAppDataWalk(`grep -reChrome ${HOME}/Library`, HOME)).not.toBeNull();
    // The same word means something else to ripgrep: `-r` is the replacement flag, so `eChrome` is
    // its value and there is no pattern flag — the operand really is the pattern.
    expect(
      blocksProtectedAppDataWalk(`rg -reChrome ${HOME}/Library/Containers ${HOME}/Projects`, HOME),
    ).toBeNull();
  });

  it("a long flag cannot glue its value on, so `--files` is not `--file` plus an `s`", () => {
    // The paired half: over-matching here would make ripgrep's ordinary --files listing a refusal.
    expect(blocksProtectedAppDataWalk(`rg --files ${HOME}/Library/Logs`, HOME)).toBeNull();
    // …while the genuine attached spelling of the same flag family still refuses.
    expect(blocksProtectedAppDataWalk(`rg --file=p.txt ${HOME}/Library`, HOME)).not.toBeNull();
  });
});

describe("recursion selected by a flag's VALUE is still recursion", () => {
  // `-d recurse` / `--directories=recurse` spell recursion with no r or R in the flag name at all,
  // so a test that matches flag NAMES is structurally blind to them.
  it.each(["grep --directories=recurse pat", "grep -d recurse pat", "grep --directories recurse pat"])(
    "`%s ~/Library` is a refusal",
    (head) => {
      expect(blocksProtectedAppDataWalk(`${head} ${HOME}/Library`, HOME)).not.toBeNull();
    },
  );

  it("only the value `recurse` counts — `-d skip` is the opposite instruction", () => {
    expect(blocksProtectedAppDataWalk(`grep -d skip pat ${HOME}/Library`, HOME)).toBeNull();
    expect(blocksProtectedAppDataWalk(`grep -d recurse pat ${HOME}/Library`, HOME)).not.toBeNull();
  });
});
