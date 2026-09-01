// The REMEDY half of the TCC home-walk refusal (bead sparkle-x1bg6t).
//
// WHY THIS FILE EXISTS. AGENTS.md: "a refusal or remedy message is an instruction the user will
// follow, so the alternative it suggests must be safe under the SAME conditions that triggered the
// refusal, or the refusal accomplished nothing." Under `bypassPermissions` there is no approval
// path around this rule, so the remedy is the ONLY way forward — and it shipped in two broken
// shapes at once:
//
//   1. EMPTY for seven of the eight binaries it could fire on. The builder was a ternary,
//      `v.bin === "find" ? "<a prune example>" : ""`, so `rg`, `fd`, `fdfind`, `du`, `ncdu`,
//      `tree`, `ls` and recursive `grep` all rendered "prune the protected set:" followed by
//      nothing, then a find-only `-not -path` footnote naming no alternative for any of them.
//   2. DEAD for `find` itself. Its five hand-written `-path` globs pruned five of the twelve
//      entries in PROTECTED_APP_DATA, so feeding the suggested command back through this very
//      guard produced another refusal naming the other seven.
//
// Both survived because nothing tested the message. So the assertion that matters here is not
// "the string is non-empty" — it is the ROUND TRIP: every command a remedy hands back is fed
// through `blocksProtectedAppDataWalk` again and must be ACCEPTED. A remedy this guard would
// itself refuse is a dead instruction, and that exact shape has shipped here before.
//
// The sweep is driven off the exported `WALKERS` table rather than a hardcoded list, so a walker
// added later is covered automatically — with a FLOOR on the count, because a table that failed
// to load would otherwise report a green sweep over zero binaries.
import { describe, it, expect } from "vitest";
import {
  WALKERS,
  blocksProtectedAppDataWalk,
  protectedAppDataWalkMessage,
  protectedAppDataWalkRemedy,
  walkRemedyBinaries,
} from "../../src-tauri/resources/worktree-guard.mjs";

/** A fixed home, so the corpus reads the same on every machine. */
const HOME = "/Users/tester";

/** Every binary this rule can refuse: the walker table, plus the two whose recursion is opt-in via
 *  a flag (`ls -R`, `grep -r`) and so are recognised outside it. */
const REFUSABLE = [...Object.keys(WALKERS), "ls", "grep"];

/** A command that WILL be refused, in the operand shape the binary actually takes. `patternFirst`
 *  tools (`rg foo ~/`) need a pattern before the root or the root extractor eats it. */
function walkCommandFor(bin: string, root: string): string {
  if (bin === "ls") return `ls -R ${root}`;
  if (bin === "grep") return `grep -r yourpattern ${root}`;
  return WALKERS[bin]?.patternFirst ? `${bin} yourpattern ${root}` : `${bin} ${root}`;
}

describe("protectedAppDataWalkRemedy — every refusable walker", () => {
  it("the WALKERS table loaded (a sweep over zero binaries is a vacuous green)", () => {
    expect(
      REFUSABLE.length,
      "WALKERS looks empty or unexported — the sweep below would pass over nothing",
    ).toBeGreaterThanOrEqual(9);
    expect(Object.keys(WALKERS)).toEqual(
      expect.arrayContaining(["find", "fd", "fdfind", "du", "ncdu", "tree", "rg"]),
    );
  });

  it("every refusable binary has an EXPLICIT remedy, not the generic fallback", () => {
    // The fallback exists so production can never emit an empty remedy for a walker added without
    // one. This assertion is what makes that a safety net rather than a place to stop thinking:
    // adding a binary to WALKERS reds this test until someone writes it a real, tool-correct remedy.
    for (const bin of REFUSABLE) {
      expect(
        walkRemedyBinaries(),
        `${bin} is refusable but has no entry in WALK_REMEDIES — write it one (naming a flag the ` +
          `tool really has, or saying in words that it has none and the root is the only lever)`,
      ).toContain(bin);
    }
  });

  it.each(REFUSABLE)("`%s` — the refusal hands back a remedy the guard itself accepts", (bin) => {
    const command = walkCommandFor(bin, HOME);
    const v = blocksProtectedAppDataWalk(command, HOME);
    expect(v, `expected a refusal for: ${command}`).not.toBeNull();
    expect(v!.bin, `the violation should name the real binary, not the operand-shape stand-in`).toBe(
      bin,
    );

    const remedy = protectedAppDataWalkRemedy(v!);
    const message = protectedAppDataWalkMessage(v!);

    // (a) NON-EMPTY. The defect was an empty string, so this is the floor, not the point.
    expect(remedy.commands.length, `${bin}: the remedy names no runnable command`).toBeGreaterThan(0);
    for (const c of remedy.commands) {
      expect(c.trim().length, `${bin}: an empty command in the remedy`).toBeGreaterThan(0);
    }
    expect(remedy.text.trim().length, `${bin}: the remedy text is empty`).toBeGreaterThan(0);

    // …and the refusal the user actually reads must CARRY them. A remedy the message drops is as
    // useless as an empty one.
    for (const c of remedy.commands) {
      expect(message, `${bin}: the refusal text omits its own remedy command`).toContain(c);
    }
    expect(
      message,
      `${bin}: the refusal promises a remedy and then shows no indented command line`,
    ).toMatch(/:\n\n {2}\S/);

    // (b) SAFE UNDER THE SAME CONDITIONS — the assertion this file exists for.
    for (const c of remedy.commands) {
      expect(
        blocksProtectedAppDataWalk(c, HOME),
        `${bin}: this guard REFUSES its own suggested remedy, so the instruction is dead:\n  ${c}`,
      ).toBeNull();
    }
  });

  it.each(REFUSABLE)(
    "`%s` — the remedy still holds when the walk starts below home, not at it",
    (bin) => {
      // The exclusion remedies embed `v.root`, so a root other than `~` is a different string and a
      // different set of reached containers. `~/Library` reaches Containers/CloudStorage/… but not
      // `.walletwasabi`, which is the case most likely to expose a hardcoded home in the remedy.
      const command = walkCommandFor(bin, `${HOME}/Library`);
      const v = blocksProtectedAppDataWalk(command, HOME);
      expect(v, `expected a refusal for: ${command}`).not.toBeNull();
      const remedy = protectedAppDataWalkRemedy(v!);
      expect(remedy.commands.length).toBeGreaterThan(0);
      for (const c of remedy.commands) {
        expect(
          blocksProtectedAppDataWalk(c, HOME),
          `${bin}: remedy refused for a non-home root:\n  ${c}`,
        ).toBeNull();
      }
    },
  );

  it("a walker with NO table entry still gets a non-empty, accepted remedy", () => {
    // The structural guarantee: the lookup has no empty fallback. This is the shape a future
    // WALKERS addition lands in before anyone writes it a real remedy, and it must not be `""`.
    const remedy = protectedAppDataWalkRemedy({
      bin: "someFutureWalker",
      root: HOME,
      home: HOME,
    });
    expect(remedy.commands.length).toBeGreaterThan(0);
    expect(remedy.text.trim().length).toBeGreaterThan(0);
    for (const c of remedy.commands) {
      expect(blocksProtectedAppDataWalk(c, HOME)).toBeNull();
    }
  });

  it("the remedy prunes EVERY protected container, not the handful someone typed out", () => {
    // The original find remedy pruned 5 of 12 and the guard refused it. This pins the round trip
    // at the level of the reached list: the pruned command must reach nothing at all.
    const v = blocksProtectedAppDataWalk(`find ${HOME}`, HOME);
    expect(v!.reached.length, "the unpruned walk should reach the whole protected set").toBe(12);
    const pruned = protectedAppDataWalkRemedy(v!).commands.at(-1)!;
    expect(pruned, "the find remedy should be the -prune form").toContain("-prune");
    expect(blocksProtectedAppDataWalk(pruned, HOME)).toBeNull();
  });

  it("names the right glob dialect per tool — `find` one star, `rg`/`fd` two", () => {
    // Not cosmetic: ripgrep and fd use gitignore/globset semantics where `*` does not cross `/`, so
    // a `*/Library/…` glob copied from the find remedy matches NOTHING and the dialogs still fire.
    // This guard's own matcher is permissive enough to accept either, so the round trip above
    // cannot see the difference — only the real tools can, and they are not on the test runner.
    const findCmd = protectedAppDataWalkRemedy(
      blocksProtectedAppDataWalk(`find ${HOME}`, HOME)!,
    ).commands.at(-1)!;
    expect(findCmd).toContain("-path '*/Library/Containers'");
    expect(findCmd).not.toContain("**/");

    const rgCmd = protectedAppDataWalkRemedy(
      blocksProtectedAppDataWalk(`rg yourpattern ${HOME}`, HOME)!,
    ).commands.at(-1)!;
    expect(rgCmd).toContain("--glob '!**/Library/Containers'");

    const fdCmd = protectedAppDataWalkRemedy(
      blocksProtectedAppDataWalk(`fd yourpattern ${HOME}`, HOME)!,
    ).commands.at(-1)!;
    expect(fdCmd).toContain("--exclude '**/Library/Containers'");
  });

  it("a binary with no exclusion flag SAYS SO rather than inventing one", () => {
    // The dishonest failure mode is worse than the empty string it replaced: a named flag reads as
    // authoritative, so the user runs it, the exclusion silently does nothing, and the dialogs
    // fire anyway. `du`/`ncdu`/`tree`/`ls`/`grep` each have to state that the root is the lever.
    for (const bin of ["du", "ncdu", "tree", "ls", "grep"]) {
      const v = blocksProtectedAppDataWalk(walkCommandFor(bin, HOME), HOME)!;
      const { text, commands } = protectedAppDataWalkRemedy(v);
      expect(text, `${bin}: the remedy should lead with narrowing the root`).toContain(
        "Narrow the ROOT",
      );
      // Every command it hands back starts BELOW the protected set — none of them relies on a
      // flag, which is the whole claim being made.
      for (const c of commands) {
        expect(blocksProtectedAppDataWalk(c, HOME)).toBeNull();
      }
    }
  });
});
