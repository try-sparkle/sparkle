// EVERY PLACE THE APP MOVES THE CARET INTO A TERMINAL MUST SAY SO.
//
// Focus provenance works by marking the PROGRAMMATIC paths and treating everything else as the user
// (see `terminalFocusIntent`). That inversion is deliberate — enumerating the user's gestures is a list
// that goes stale — but it has one failure mode: an auto-focus site added without
// `markTerminalAutoFocus()` records a parked caret as deliberate.
//
// That is not a cosmetic slip. `SparkleAgentPane` was exactly this case, and the consequence was that
// the pane got the INVERSE Escape ladder from a builder pane — the first press did not release, and the
// row-clearing rung was unreachable while its terminal held the caret (roborev 55722). The module header
// had even claimed there was only one such site.
//
// ══ WHY A SOURCE SCAN RATHER THAN A RENDER TEST ═════════════════════════════════════════════════
// The thing to prevent is a FUTURE site, in a file this test cannot know about. Rendering the two panes
// we know about would pin today's behavior and say nothing about tomorrow's addition, which is the
// actual risk. This repo already reaches for structural checks where the invariant is "no call site
// anywhere may do X" (cf. the `no-cross-target-event-dispatch` lint rule).
//
// Scoped to calls that move the caret INTO A TERMINAL — a terminal-named focus ref, or `.focus()` on a
// terminal handle. It says nothing about focusing composers, buttons or dialogs, and it is a BACKSTOP
// rather than a proof: see the pattern's own note on what a text scan cannot see.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(__dirname, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * A call that hands the caret to a terminal.
 *
 * BROADER THAN THE FIRST VERSION, which matched only the literal `termFocusRef.current?.()`. A pane that
 * named its ref anything else — `focusRef`, `terminalRef` — or that focused through the `TerminalApi`
 * handle was invisible to the scan and would slip through unmarked, which is precisely the
 * `SparkleAgentPane` failure this exists to prevent. Now: any `.current?.()` on a ref whose name mentions
 * a terminal, plus a `.focus()` on a terminal-ish handle.
 *
 * STILL A TEXT SCAN, and therefore still a backstop rather than a proof — a call reached through an alias
 * or a helper is beyond it. The honest fix is a lint rule with type information; this catches the
 * regression that has now happened twice.
 */
const TERMINAL_FOCUS_CALL =
  /(\b\w*(?:[tT]erm|[tT]erminal)\w*Ref\s*\.\s*current\s*\??\.\s*\()|(\b\w*(?:[tT]erm|[tT]erminal)\w*(?:Api|Ref)?\s*\.\s*(?:current\s*\??\.\s*)?focus\s*\()/;

/**
 * The opt-out, for a focus call that follows a USER gesture rather than the app's own initiative.
 *
 * Such a site must NOT mark: the caret genuinely arrived because the user aimed at that terminal, and
 * marking it would record their intent as the app's. `focusTerminalForDrop` is the real case — dropping
 * a file onto a terminal is as deliberate as clicking into it.
 *
 * An explicit annotation rather than a hardcoded file list, so the decision lives at the site where the
 * next person reads it, and so a new user-driven site is a one-line declaration instead of a reason to
 * weaken the scan. Every use of it should say WHY on the same line.
 */
const DELIBERATE_OPT_OUT = "terminal-focus: user-driven";

/** Is this line pure prose? Line comments and JSDoc/block-comment continuations. */
function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

describe("terminal auto-focus sites", () => {
  it("every site that moves the caret into a terminal declares who put it there", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const src = readFileSync(file, "utf8");
      const lines = src.split("\n");
      lines.forEach((line, i) => {
        // Prose is not a call site. Modules that DOCUMENT this mechanism naturally quote `term.focus()`
        // in their headers, and counting those made the scan fire on its own explanation.
        if (isCommentLine(line)) return;
        if (!TERMINAL_FOCUS_CALL.test(line)) return;
        // The mark must appear in the same statement region — look back a few lines, which covers the
        // `markTerminalAutoFocus(); termFocusRef.current?.();` pairing and an intervening comment.
        const window = lines.slice(Math.max(0, i - 8), i + 1).join("\n");
        if (window.includes("markTerminalAutoFocus")) return; // app-placed, and it says so
        if (window.includes(DELIBERATE_OPT_OUT)) return; // user-driven, and it says so
        offenders.push(`${file.replace(SRC, "src")}:${i + 1}  ${line.trim()}`);
      });
    }
    expect(offenders, `unmarked terminal auto-focus site(s):\n${offenders.join("\n")}`).toEqual([]);
  });

  // The scan is worthless if its pattern matches nothing — a renamed ref would make the case above pass
  // by finding no sites at all. Pin that it still sees the ones we know about.
  it("actually finds the known auto-focus sites", () => {
    const found = walk(SRC).filter((f) =>
      readFileSync(f, "utf8")
        .split("\n")
        .some((l) => !isCommentLine(l) && TERMINAL_FOCUS_CALL.test(l)),
    );
    const names = found.map((f) => f.replace(SRC, "src"));
    expect(names.some((n) => n.includes("AgentPane"))).toBe(true);
    expect(names.some((n) => n.includes("SparkleAgentPane"))).toBe(true);
  });
});
