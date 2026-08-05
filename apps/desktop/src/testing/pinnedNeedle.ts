// A guard for SOURCE-PINNING tests — the ones that read another file's text and assert a needle is
// still in it, to catch drift between two implementations of the same rule.
//
// ══ WHY THIS FILE EXISTS ════════════════════════════════════════════════════════════════════════
// A cross-language drift test pinned bare IDENTIFIER names as its needles. The target file IMPORTS
// those same identifiers, so every needle matched the import statement rather than any use of it.
// The assertion was vacuous: the rule bodies the test existed to protect could be deleted outright
// and the suite stayed green.
//
// That is the repo's #1 test defect — an assertion that was already true before the change — wearing
// a new hat. The identifier is in the file either way, so `toContain` cannot tell the two apart, and
// neither a typecheck nor a reviewer skimming the needle list can either.
//
// The rule enforced here is narrow: a pinned needle must appear on at least one line of the target
// that is NOT an import (or `use`) line and NOT a whole-line comment. Both are places an identifier
// shows up without anything DOING it, which is exactly the gap the pin was supposed to close.
//
// Usage — replace `expect(src).toContain(needle)` with:
//
//     assertPinnedNeedle(src, "for (const check of CHECKS)", "conciergeLint.ts");
//
// and prefer pinning an EXPRESSION from the use site (a full comparison, a call, a loop header) over
// a bare identifier. An identifier alone appears in the import block of every file that consumes it.

/** Lines that mention a name without using it. Covers TS/JS `import`/`export … from`/`require`, and
 *  Rust `use`/`pub use` — the two sides of the cross-language pins this guard was written for. */
const IMPORT_START = /^(?:import\b|export\b[^=]*\bfrom\b|(?:pub\s+)?use\b|(?:const|let|var)\s+.*\brequire\s*\()/;

/** A line that is nothing but a comment. `*` catches the continuation lines of a block comment. */
const WHOLE_LINE_COMMENT = /^(?:\/\/|#(?!\[)|\/\*|\*)/;

/** Classify every line of `source` as "can satisfy a pin" or not.
 *
 *  Import statements span lines (`import {\n  A,\n} from "x";`, `use foo::{\n  A,\n};`), so this
 *  tracks whether we are still inside one rather than testing each line in isolation — a needle on
 *  the third line of a six-line import block is the exact case that started this. */
function usableLines(source: string): string[] {
  const usable: string[] = [];
  let insideImport = false;

  for (const raw of source.split("\n")) {
    const line = raw.trim();

    if (insideImport) {
      // An import ends at the `;` that closes it. Bare-specifier lines have no `;`, so they stay in.
      if (line.includes(";")) insideImport = false;
      continue;
    }

    if (IMPORT_START.test(line)) {
      // Single-line imports terminate on the same line; multi-line ones keep the flag set.
      if (!line.includes(";")) insideImport = true;
      continue;
    }

    if (line === "" || WHOLE_LINE_COMMENT.test(line)) continue;

    usable.push(raw);
  }

  return usable;
}

/** True when `needle` appears somewhere in `source` that actually uses it. */
export function needleIsUsed(source: string, needle: string): boolean {
  return usableLines(source).some((line) => line.includes(needle));
}

/** Assert that `source` still contains `needle` AND that the match is a real use of it.
 *
 *  Throws with a message that names which of the two failed, because they call for opposite fixes:
 *  a missing needle means the target drifted (update the pin, or restore the code), while an
 *  import-only needle means the PIN is wrong and always was (pin an expression instead). */
export function assertPinnedNeedle(source: string, needle: string, label = "target"): void {
  if (!source.includes(needle)) {
    throw new Error(
      `pinned needle not found in ${label}: ${JSON.stringify(needle)}\n` +
        `The target drifted — restore the code it pins, or update the pin to match.`,
    );
  }

  if (!needleIsUsed(source, needle)) {
    throw new Error(
      `pinned needle is VACUOUS in ${label}: ${JSON.stringify(needle)}\n` +
        `It appears only on import/comment lines, so it would still match with the code deleted.\n` +
        `Pin an expression from the use site (a call, comparison, or loop header), not a bare identifier.`,
    );
  }
}
