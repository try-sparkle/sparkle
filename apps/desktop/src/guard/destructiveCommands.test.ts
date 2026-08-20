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

// The corpus can only assert THAT a command was refused — it has no expected-rule field. For the
// `env` reading budget that is not enough: the whole point of the budget is fail-CLOSED refusal, and
// a corpus entry goes green if ANY rule refuses it, so a future rule (or an `envParse` change that
// resolves one reading to a denied binary) would keep the fixture passing while the budget itself
// became deletable. These assert the budget specifically.
describe("blocksDestructiveCommand — the env reading budget refuses, and resets", () => {
  // Each alt's command word is literally `env`, so readings multiply per nesting level and pass the
  // budget, while EVERY individual reading resolves to the harmless `echo hi` and fires no rule.
  // Without the budget this is ALLOW; with it, refused BY THE BUDGET.
  const exhausting = "env " + "-u env ".repeat(16) + "echo hi";

  it("refuses by the budget, naming the budget — not merely 'something refused'", () => {
    const verdict = blocksDestructiveCommand(exhausting);
    expect(verdict).not.toBeNull();
    expect(verdict?.rule).toBe("env");
    expect(verdict?.why).toMatch(/too many option-arity readings/);
  });

  it("resets the budget between top-level commands, independent of test ordering", () => {
    // Exhaust, then immediately judge ordinary commands IN THE SAME TEST. Relying on a later
    // `describe` to catch a leaked counter makes the coverage an artifact of file order — move the
    // blocks, split the file, or isolate modules per test and it silently disappears.
    expect(blocksDestructiveCommand(exhausting)).not.toBeNull();
    expect(blocksDestructiveCommand("env -u NODE_OPTIONS pnpm test")).toBeNull();
    expect(blocksDestructiveCommand("env -S 'echo hi'")).toBeNull();
    expect(blocksDestructiveCommand("env --unset FOO ls -la")).toBeNull();
  });

  it("refuses the next deleter ON ITS OWN MERITS, not on a leaked budget", () => {
    // `not.toBeNull()` is NOT enough here, and asserting it was this test's own bug: with the reset
    // removed the counter is already exhausted on entry, so this command is refused by the BUDGET
    // rather than by the rm rule — non-null either way, green with and without the thing it claims
    // to guard. Naming the expected rule is what makes the two outcomes distinguishable.
    blocksDestructiveCommand(exhausting);
    const rm = blocksDestructiveCommand("env -uSHELL rm -rf /");
    expect(rm?.rule).toBe("rm -r");
    expect(rm?.why).not.toMatch(/too many option-arity readings/);

    const find = blocksDestructiveCommand("find / -type f -exec rm {} +");
    expect(find?.rule).toBe("find -exec rm");
    expect(find?.why).not.toMatch(/too many option-arity readings/);
  });
});

describe("blocksDestructiveCommand — git clean, the ignored-file flag in both cases", () => {
  // `-X` removes ONLY ignored files, which is precisely .env and credentials — strictly worse than
  // `-x`, which at least sweeps untracked junk alongside them. The corpus above drives the
  // spellings; these assert the two PROPERTIES that make the fix correct rather than merely green.

  it("names the same rule for `-X` as for `-x` (one rule, not a bolted-on second one)", () => {
    const lower = blocksDestructiveCommand("git clean -fdx");
    const upper = blocksDestructiveCommand("git clean -fdX");
    expect(lower).not.toBeNull();
    expect(upper).not.toBeNull();
    expect(upper!.rule).toBe(lower!.rule);
  });

  // THE `-e` VALUE SCAN, IN BOTH CASES. `-e` takes a value that may be ATTACHED, so the cluster
  // scan must stop there: in `git clean -fde'*.XZ'` the lexer yields one token whose `X` belongs to
  // the user's exclude PATTERN. Adding `X` to the flag test without preserving that scan turns an
  // ordinary clean into a false refusal with no approval path — the thing this posture exists to
  // remove. Asserting only the lowercase case would have passed the broken fix.
  it("stops the cluster scan at `-e`, so an exclude PATTERN is never read as a flag", () => {
    for (const cmd of [
      "git clean -fde'*.xz'",
      "git clean -fde'*.XZ'",
      "git clean -fd -e '*.x'",
      "git clean -fd -e '*.X'",
      "git clean -fde'*.X'",
      "git clean -e'*.X' -fd",
    ]) {
      expect(blocksDestructiveCommand(cmd), `expected NO refusal for: ${cmd}`).toBeNull();
    }
  });

  // WHY THERE IS NO LONG-OPTION SPELLING TO CATCH — pinned so the next reader does not re-derive it
  // and, worse, invent one. git-clean's synopsis is
  //   git clean [-d] [-f] [-i] [-n] [-q] [-e <pattern>] [-x | -X] [--] [<pathspec>...]
  // and its ONLY long forms are --force, --interactive, --dry-run, --quiet and --exclude=<pattern>.
  // `-x`/`-X` have no long spelling at all: `--ignored`, `--ignored-only` and `--exclude-ignored`
  // are all rejected by git with "unknown option". So the cluster scan skipping `--`-prefixed words
  // is complete, not a gap — there is nothing for a long-option branch to catch.
  it("skips long options because git cannot express -x/-X as one", () => {
    // A long option is not a flag cluster, so it contributes no `x`/`X` — and an invented one must
    // not be treated as if it removed ignored files.
    expect(blocksDestructiveCommand("git clean -fd --force")).toBeNull();
    expect(blocksDestructiveCommand("git clean -fd --quiet")).toBeNull();
    expect(blocksDestructiveCommand("git clean -fd --exclude='*.x'")).toBeNull();
    expect(blocksDestructiveCommand("git clean -fd --exclude='*.X'")).toBeNull();
    // …but a long option must not SHADOW a real short flag sitting beside it.
    expect(blocksDestructiveCommand("git clean -fd --force -X")).not.toBeNull();
    expect(blocksDestructiveCommand("git clean --quiet -x")).not.toBeNull();
  });

  // THERE IS DELIBERATELY NO DRY-RUN EXEMPTION, and this test exists because one was briefly added
  // on this branch and had to be removed. The reasoning FOR it is genuinely sound — git-clean(1)
  // says "-n, --dry-run  Don't actually remove anything… clean.requireForce is ignored, as nothing
  // will be deleted anyway" — which is exactly what makes the hole it opens so easy to miss.
  //
  // `-e`/`--exclude` take a REQUIRED value, and git's parse-options consumes the next argv for one
  // unconditionally, without checking whether it looks like a flag. So in `git clean -fdx -e -n`
  // the exclude PATTERN is the literal string `-n`, git performs a REAL destructive `-x` clean, and
  // any scan that reads that trailing `-n` as `--dry-run` hands it through. Four spellings reach it.
  //
  // The asymmetry is the whole point: misreading a pathspec as a FLAG is a harmless false refusal,
  // but misreading a VALUE as `--dry-run` turns the guard off on the one path whose job is to stop
  // a credential deletion. So the scan stays a pure `-x`/`-X` test.
  // WHAT CLOSING `-X` COSTS, stated plainly rather than waved past (roborev 66236 asked for exactly
  // this). At origin/main `git clean -nx` was REFUSED but `git clean -nX` / `-ndX` /
  // `--dry-run -X` were ALLOWED — not as a considered dry-run exemption, but purely because the
  // scan missed `-X` altogether. So the uppercase dry-run spellings are NEWLY refused by the `-X`
  // fix, and the falsely-refused set does strictly grow. That is the accepted price of closing a
  // credential-deletion hole, and it makes the two cases consistent instead of accidentally split.
  it("has no dry-run exemption — every dry-run spelling with -x/-X is still refused", () => {
    for (const cmd of [
      "git clean -nx",
      "git clean -nX",
      "git clean -ndX",
      "git clean -n -x",
      "git clean -fdnx",
      "git clean --dry-run -x",
      "git clean --dry-run -X",
      "git clean -fd --dry-run -X",
      "git clean -fdx --dry-run",
      "git clean -fdx -n",
    ]) {
      expect(
        blocksDestructiveCommand(cmd),
        `no dry-run exemption exists, so this must still be refused: ${cmd}`,
      ).not.toBeNull();
    }
  });

  // THE REGRESSION CONTROL. Each of these was refused at origin/main, ALLOWED by the dry-run
  // exemption, and is refused again now. If a dry-run exemption is ever reintroduced, these are the
  // cases it has to handle before it is safe — a detached value is not visible to a per-token scan.
  it("pins the PATHSPEC and exclude-VALUE cases any future dry-run exemption must handle", () => {
    // NOTE: nothing in the guard reads anything as the dry-run flag today, so these pass because
    // the cluster carries `x`/`X` — not because a `--` stop or a value-skip exists. They are here as
    // the cases a future exemption has to get right, and they would go red the moment one is added
    // naively. Everything after `--` is a pathspec: a file literally named `-n` is not the flag.
    expect(blocksDestructiveCommand("git clean -fdx -- -n")).not.toBeNull();
    expect(blocksDestructiveCommand("git clean -fdX -- -n --dry-run")).not.toBeNull();
    // An `n` inside an ATTACHED exclude pattern is not the flag.
    expect(blocksDestructiveCommand("git clean -fdxe'*.n'")).not.toBeNull();
    expect(blocksDestructiveCommand("git clean -fdXe'no-such'")).not.toBeNull();
    // …and the DETACHED value, which is the one the removed exemption got wrong. git really does
    // delete here: `-n` is the pattern, not the flag.
    for (const cmd of [
      "git clean -fdx -e -n",
      "git clean -fdxe -n",
      "git clean -fdx --exclude -n",
      "git clean -fdx --exclude --dry-run",
      "git clean -fdx -e --dry-run",
    ]) {
      expect(
        blocksDestructiveCommand(cmd),
        `the exclude VALUE is not a flag — git performs a real -x clean here: ${cmd}`,
      ).not.toBeNull();
    }
  });
});
