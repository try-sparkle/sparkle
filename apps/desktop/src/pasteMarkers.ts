// The bracketed-paste markers and the filter that neutralizes them, in a LEAF module.
//
// These live here rather than in `pty.ts` — which re-exports them, so every existing importer is
// unchanged — for one reason: `pty.ts` is the module every terminal-adjacent suite stubs, and 45
// test files do it with a WHOLESALE `vi.mock("../pty", () => ({ ...three fns... }))`. Any code that
// reached `stripPasteMarkers` through `pty.ts` therefore got `undefined` inside those suites. For
// an ordinary helper that is a loud TypeError; for a SECURITY FILTER it is the quiet kind of hole
// this file's own comments are about — the guard disappears exactly where the PTY is faked, and
// nothing says so.
//
// A leaf with no imports cannot be collaterally stubbed, so a caller that wants the filter gets the
// real one no matter what its test does to the PTY layer.

// ESC is char code 27 — constructed rather than written literally so this source contains no raw
// ESC byte.
const ESC = String.fromCharCode(27);

/** Bracketed-paste wrappers: ESC[200~ … ESC[201~. Pasting (vs. raw typing) lets the CLI treat a
 *  multi-line prompt as one atomic block. */
export const PASTE_START = `${ESC}[200~`;
export const PASTE_END = `${ESC}[201~`;

/**
 * Neutralize bracketed-paste markers embedded in text we are about to wrap in a paste, so the
 * content can't terminate paste mode early and have its tail interpreted as KEYSTROKES by the
 * running CLI (roborev 2197). Applies to anything the user didn't type at the terminal themselves —
 * a terminal selection, a dropped file's path, a phone-relayed payload.
 *
 * A single split/join pass is insufficient: removing a marker can reconstitute a new one from its
 * neighbors (e.g. "\x1b[20\x1b[201~1~" → "\x1b[201~" after one pass). Loop until stable so no marker
 * survives regardless of how deeply it is interleaved (roborev 2210).
 *
 * Lives beside the markers it strips rather than beside any one caller: it is a property of the
 * paste framing, and a second private copy is how one call site quietly loses the guard.
 */
export function stripPasteMarkers(s: string): string {
  let t = s;
  while (t.includes(PASTE_START) || t.includes(PASTE_END)) {
    t = t.split(PASTE_START).join("").split(PASTE_END).join("");
  }
  return t;
}
