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
    // OPTIONS MAY FOLLOW POSITIONALS (ripgrep uses clap; GNU grep permutes too). A rule that
    // infers "the slice already removed the flag value" from operand ORDER eats the PATH here and
    // leaves one relative word, which `isAbsolute` skips — no roots, and no roots reads as
    // "reaches nothing" (roborev 67851). `-e PAT` is the most common spelling an agent types.
    "rg /Users/tester/Library -e Chrome",
    "grep -r /Users/tester/Library -e Chrome",
    "rg /Users/tester/Library -f pats.txt",
    // Everything after `--` is a positional, so the path is still a path. Dropping that tail
    // leaves no roots — the same "reaches nothing" reading, by a fourth route.
    "rg -e Chrome -- /Users/tester/Library",
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

  it("when a flag supplies the patterns, EVERY operand is a path — including the first", () => {
    // The mirror image of the allow cases, and the one the review got backwards. With `--file`
    // carrying the patterns there is no pattern operand at all, so BOTH words are roots and the
    // walk into Containers is real. Blocking it is the correct reading, not an over-block —
    // which is why it is asserted on its own root rather than folded into the list above.
    const verdict = blocksProtectedAppDataWalk(
      `grep -r --file pats.txt ${HOME}/Library/Containers ${HOME}/Projects`,
      HOME,
    );
    expect(verdict).not.toBeNull();
    expect(verdict!.root).toBe(`${HOME}/Library/Containers`);
  });

  it("a SEPARATED long pattern flag takes the next word, so that word is not a root", () => {
    // The long-flag half of the same asymmetry: the short form was corrected to require an
    // ATTACHED value, but the long form had no such requirement, so `--regexp <abs path>` promoted
    // the thing being searched FOR into a walk root — a false refusal with no way around it.
    expect(
      blocksProtectedAppDataWalk(`rg --regexp ${HOME}/Library/Containers ${HOME}/Projects`, HOME),
    ).toBeNull();
    // Attached, the pattern is inside the word, so the operand really is a root.
    expect(
      blocksProtectedAppDataWalk(`rg --regexp=Chrome ${HOME}/Library/Containers`, HOME),
    ).not.toBeNull();
  });

  it("an ORDINARY flag's separated value is consumed too, or it shifts what counts as the pattern", () => {
    // `-m 5` must swallow the `5` AT ITS POSITION. Leave it in the operand list and it becomes
    // "the pattern", which pushes the Containers string into the root slot and refuses an ordinary
    // search FOR that path — the same false-refusal shape as `-tdocker`, via the separated form.
    expect(
      blocksProtectedAppDataWalk(`rg -m 5 ${HOME}/Library/Containers ${HOME}/Projects`, HOME),
    ).toBeNull();
    // The LONG spelling of the same thing. The existing `--max-depth 1` case cannot show this:
    // the depth it sets makes the verdict null under both readings, so it is silent on the bug.
    expect(
      blocksProtectedAppDataWalk(
        `rg --max-count 5 ${HOME}/Library/Containers ${HOME}/Projects`,
        HOME,
      ),
    ).toBeNull();
    // Drop the flag and its value entirely and the first operand really is the pattern again —
    // same verdict, so the case above is not green merely because Containers is unreachable here.
    expect(
      blocksProtectedAppDataWalk(`rg ${HOME}/Library/Containers ${HOME}/Projects`, HOME),
    ).toBeNull();
    // …and with the pattern supplied by a flag, that same first operand IS a root.
    expect(
      blocksProtectedAppDataWalk(
        `rg -m 5 -e x ${HOME}/Library/Containers ${HOME}/Projects`,
        HOME,
      ),
    ).not.toBeNull();
  });

  it("an OPTIONAL-value flag never consumes the next word — that word is the pattern", () => {
    // The invariant the flag table's docstring rests on, made executable (roborev 67871). It had
    // no assertion anywhere, which is exactly how the `-C` regression got in: a later reader could
    // add `--color`/`--context` to the value table and nothing would go red.
    //
    // macOS ships BSD grep, whose `-C[num]` / `--context[=num]` take an argument that may NOT be
    // whitespace-separated. So in all four of these the next word is the PATTERN, and swallowing
    // it leaves the walk with no roots — the silent allow this whole file exists to close.
    for (const cmd of [
      `grep -rC pat ${HOME}/Library`,
      `grep -r --context pat ${HOME}/Library`,
      `grep -r --color pat ${HOME}/Library`,
      `grep -rC3 pat ${HOME}/Library`,
    ]) {
      const verdict = blocksProtectedAppDataWalk(cmd, HOME);
      expect(verdict, `expected a refusal for: ${cmd}`).not.toBeNull();
      expect(verdict!.root).toBe(`${HOME}/Library`);
    }
    // The paired half: a flag whose value IS mandatory and separated still consumes it, so the
    // cases above are not green merely because nothing consumes anything any more.
    expect(
      blocksProtectedAppDataWalk(`grep -r -m 5 ${HOME}/Library/Containers ${HOME}/Projects`, HOME),
    ).toBeNull();
  });

  it("a bare `-` is a POSITIONAL, so it occupies the pattern slot rather than vanishing", () => {
    // Skipping it would promote the PATH into the pattern slot and empty the root list. `-` is
    // never an absolute path, so keeping it as an operand costs nothing.
    const verdict = blocksProtectedAppDataWalk(`rg - ${HOME}/Library`, HOME);
    expect(verdict).not.toBeNull();
    expect(verdict!.root).toBe(`${HOME}/Library`);
  });

  it("a flag that NAMES a root is never subject to the pattern slice, in either order", () => {
    // `fd --search-path <path>` and `--base-directory <path>` supply the walk root themselves. Left
    // in the operand list they were removed as "the pattern" — and fd has no pattern flags at all,
    // so nothing else could keep a root alive. The bug was ORDER-DEPENDENT in exactly the way this
    // parser claims nothing is (roborev 67870), so both orders are asserted to the same root.
    const flagFirst = blocksProtectedAppDataWalk(`fd --search-path ${HOME}/Library cli.js`, HOME);
    const flagLast = blocksProtectedAppDataWalk(`fd cli.js --search-path ${HOME}/Library`, HOME);
    expect(flagFirst).not.toBeNull();
    expect(flagLast).not.toBeNull();
    expect(flagFirst!.root).toBe(`${HOME}/Library`);
    expect(flagLast!.root).toBe(flagFirst!.root);
    // The attached spelling, and fd's other root-naming flag.
    expect(
      blocksProtectedAppDataWalk(`fd --search-path=${HOME}/Library cli.js`, HOME),
    ).not.toBeNull();
    expect(blocksProtectedAppDataWalk(`fd --base-directory ${HOME} cli.js`, HOME)).not.toBeNull();
  });

  it("`--base-directory` is a PREFIX when a path survives, and a root only when none does", () => {
    // fd's help: a relative positional or `--search-path` "will also be resolved relative to this
    // directory". Folding it in with the root flags made an ordinary `~/Projects` walk a refusal
    // citing $HOME, and told the user to narrow a root they had already narrowed (roborev 67942).
    expect(
      blocksProtectedAppDataWalk(`fd --base-directory ${HOME} cli.js Projects`, HOME),
    ).toBeNull();
    // …but a relative survivor that DOES resolve into the protected set is still a walk of it.
    const resolved = blocksProtectedAppDataWalk(
      `fd --base-directory ${HOME} cli.js Library`,
      HOME,
    );
    expect(resolved).not.toBeNull();
    expect(resolved!.root).toBe(`${HOME}/Library`);
    // …and with NO path surviving there is nothing to resolve, so the base itself is the root.
    const bare = blocksProtectedAppDataWalk(`fd --base-directory ${HOME} cli.js`, HOME);
    expect(bare).not.toBeNull();
    expect(bare!.root).toBe(HOME);
  });

  it("the WIDENING direction is pinned — a non-root flag's value never becomes a root", () => {
    // Every other root-flag case here is a BLOCK assertion, so on their own they stay green under
    // any widening of the root table: add `--exclude` or `--extension` to it and an arbitrary flag
    // value is promoted to a walk root, turning ordinary fd invocations into refusals with nothing
    // red. That is the same asymmetry this file already fixed once for `-C`/`--color`.
    // NOT `--exclude`, deliberately. Its value is ALSO collected by `walkExcludePatterns`, so a
    // root manufactured from it is neutralised by its own flag and the case stays green under the
    // very mutation its comment names — vacuous in exactly the way this test exists to prevent
    // (roborev 67948). `--ignore-file` takes an absolute path and is not an exclusion.
    for (const cmd of [
      `fd --ignore-file ${HOME}/Library/Containers cli.js ${HOME}/Projects`,
      `fd --search-path ${HOME}/Projects cli.js`,
      `fd --base-directory ${HOME}/Projects cli.js`,
    ]) {
      expect(blocksProtectedAppDataWalk(cmd, HOME), `unexpected refusal for: ${cmd}`).toBeNull();
    }
    // The paired half: the flag that genuinely DOES name a root still refuses, so the three above
    // are not green merely because nothing is collected as a root any more.
    expect(blocksProtectedAppDataWalk(`fd --search-path ${HOME}/Library cli.js`, HOME)).not.toBeNull();
  });

  it("`fdfind` is `fd` — a binary with no table key parses as if no flag took a value", () => {
    // Debian's name for the same tool had no key in ANY of the five flag tables, so every lookup
    // fell through to the empty default. Asserted against the same command under both names.
    const fd = blocksProtectedAppDataWalk(`fd --search-path ${HOME}/Library x`, HOME);
    const fdfind = blocksProtectedAppDataWalk(`fdfind --search-path ${HOME}/Library x`, HOME);
    expect(fdfind).not.toBeNull();
    expect(fdfind!.root).toBe(fd!.root);
  });

  it("fd's verdicts are pinned in BOTH directions — the rewrite changed them silently", () => {
    // `-e` is fd's EXTENSION filter and consumes its value, so `cli.js` is the pattern and
    // `~/Library` is a real root…
    const withPath = blocksProtectedAppDataWalk(`fd -e ts cli.js ${HOME}/Library`, HOME);
    expect(withPath).not.toBeNull();
    expect(withPath!.root).toBe(`${HOME}/Library`);
    // …while a LONE positional is fd's pattern, not a path. This verdict FLIPPED in the rewrite
    // and nothing asserted it either way, so the next edit to fd's tables could flip it back.
    expect(
      blocksProtectedAppDataWalk(`fd -e ts ${HOME}/Library/Containers`, HOME),
    ).toBeNull();
  });

  it("argument ORDER changes nothing — the same walk, flags first or flags last", () => {
    // The pair that pins order-independence: identical commands, identical verdicts, and the root
    // must be NAMED in both, since a verdict built from an empty root list cannot exist.
    const leading = blocksProtectedAppDataWalk(`rg -e Chrome ${HOME}/Library`, HOME);
    const trailing = blocksProtectedAppDataWalk(`rg ${HOME}/Library -e Chrome`, HOME);
    expect(leading).not.toBeNull();
    expect(trailing).not.toBeNull();
    expect(trailing!.root).toBe(leading!.root);
    expect(trailing!.root).toBe(`${HOME}/Library`);
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
