import type { SuggestionButton } from "./types";
// The picker-footer regex is owned by the engine's screenClassifier (the single retune point for
// Claude Code TUI drift) and re-exported here for approvalClassifier, so the option detector, the
// category classifier, and the red-vs-gray status check can never desync on what marks a picker.
import { PICKER_FOOTER } from "../../engine/screenClassifier";

export { PICKER_FOOTER };

// Only the last N non-empty lines are considered "live" — a prompt scrolled far up is stale.
export const TAIL_LINES = 12;

// `YN` matches "[y/n]" / "[yes/no]" case-insensitively (the bracket alternatives), plus bare
// "y/n" / "yes/no" word forms. (An earlier YN_DEFAULT regex was removed — it was fully subsumed
// by this one and added no behavior.)
/** Exported so the concierge's picker fingerprint can decide whether a screen with no option run is
 *  a y/n confirmation or simply a dialog it failed to locate — those must not be conflated, because
 *  the second one is unsafe to fingerprint at all (roborev 55182). One definition, not two. */
export const YN = /\b(y\/n|yes\/no)\b|\[y\/n\]|\[yes\/no\]/i;
/** Exported so the concierge's fingerprint can locate a generic menu's rows with the DETECTOR'S
 *  pattern rather than a wider one of its own — a locator that accepts a line the parser rejects
 *  breaks the run and produces a permanent refusal (roborev 55218). */
export const MENU_LINE = /^\s*[[(]?(\d{1,2})[\]).]\s+\S/; // "1) x", "2. x", "[3] x", "(4) x"

// A real choice prompt either names the action, or is a pure-punctuation prompt like "? " / ">"
// (a single-word label ending in ":" such as "Changes:"/"Results:" is a HEADER, not a prompt —
// excluding it kills the main false-positive class that would otherwise inject "1\n" into a PTY).
const CHOICE_KEYWORD = /(choice|choos|select|option|enter|pick|press|which)/i;

function tail(scrollback: string, n: number = TAIL_LINES): string[] {
  const lines = scrollback.replace(/\r/g, "").split("\n").filter((l) => l.trim().length > 0);
  return lines.slice(-n);
}

function btn(label: string, value: string): SuggestionButton {
  // id is unique WITHIN a set (labels are deduped: y/n → Approve/Deny; menus → a contiguous
  // 1..N run). Consumers that pool across agents key click-back by (agentId, buttonId).
  return { id: `heur:${label}`, label, value, kind: "terminal", source: "heuristic" };
}

function asksChoice(lastLine: string): boolean {
  if (CHOICE_KEYWORD.test(lastLine)) return true;
  // Pure-punctuation prompt: ends in ?/:/>/# and contains no letters.
  return /[?:>#»]\s*$/.test(lastLine) && !/[a-z]/i.test(lastLine);
}

// ── Claude Code's interactive option picker (AskUserQuestion / permission dialogs) ──
// An Ink raw-mode dialog: numbered options (the highlighted one prefixed with a `❯` pointer),
// closed by a footer like "Enter to select · ↑/↓ to navigate · Esc to cancel". Two things defeat
// the generic menu heuristic below: the pointer stops option 1's line from matching, and the Ink
// screen keeps rendering content (e.g. the task checklist) BELOW the dialog, so the footer is
// never the last line. So this detector searches a wider window for the footer, then parses the
// option block immediately above it.
//
// Claude Code's Bash-command approval prompt renders a DIFFERENT footer — "Esc to cancel · [Tab to
// amend ·] ctrl+e to explain" — that lacks the "Enter to select …" text (and drops "Tab to amend"
// whenever the highlighted option isn't the amendable "Yes"). PICKER_FOOTER (imported above from
// screenClassifier) anchors on the always-present "esc to cancel … ctrl+e to explain" pair, which
// sits BELOW the option block in the same structural position as the standard footer, so the upward
// option walk works identically.
export const PICKER_WINDOW = 50; // non-empty lines to search for the footer
export const PICKER_SPAN = 30; // non-empty lines above the footer the option block may span
const PICKER_OPTION = /^\s*(?:[❯›>]\s*)?(\d{1,2})\.\s+(\S.*)/;
const PICKER_LABEL_MAX = 40;
const PICKER_MAX_BUTTONS = 6;

function truncateLabel(s: string): string {
  const t = s.trim();
  return t.length <= PICKER_LABEL_MAX ? t : `${t.slice(0, PICKER_LABEL_MAX - 1)}…`;
}

/** Parse Claude Code's option picker out of scrollback into `{ n, label }` options in ascending
 *  order (1..N), or `[]` when no valid picker is present. Shared by {@link detectClaudeCodePicker}
 *  (renders every option as a button) and {@link detectResumePrompt} (looks for two specific
 *  options), so the footer-search + count-down parse lives in exactly one place. */
/** The region a successful picker parse actually used, in NON-EMPTY line indices relative to the
 *  window `tail(scrollback, PICKER_WINDOW)` returns. Exported so the concierge's fingerprint can
 *  hash the block THE DETECTOR PARSED rather than re-deriving it with a stricter rule of its own —
 *  every re-derivation so far has disagreed with this one in some way (roborev 55166/55172/55195),
 *  and a locator that disagrees with the parser that produced its input is the whole bug class. */
export interface PickerBounds {
  /** Index of the first option row (option "1"). */
  first: number;
  /** Index of the footer line, which sits just below the last option row. */
  footer: number;
}

/** Where the last successful picker parse found its block, or null if there is no valid picker.
 *  Indices are into `tail(scrollback, PICKER_WINDOW)` — see {@link pickerWindow}. */
export function pickerBlockBounds(scrollback: string): PickerBounds | null {
  const r = parsePickerOptionsWithBounds(scrollback);
  return r.opts.length > 0 ? r.bounds : null;
}

/** The exact window the picker parse reads, so a caller can index into the same array. */
export function pickerWindow(scrollback: string): string[] {
  return tail(scrollback, PICKER_WINDOW);
}

/** The winning generic-menu run: its option NUMBERS and where its rows sit in `tail(scrollback)`.
 *
 *  Exported with indices so the concierge's fingerprint can hash the block the detector actually
 *  chose. Sharing the PATTERN was not enough: the selection rule is a second definition, and the two
 *  disagreed — this keeps the LONGEST run (first-wins on ties) while a locator that kept the run
 *  nearest the end picked a different block, so the buttons and the fingerprinted question described
 *  different menus and nothing could catch it (roborev 55245). One definition, indices included. */
export interface GenericMenuRun {
  numbers: number[];
  /** Index of the run's first option row in `tail(scrollback)`. */
  first: number;
  /** Index of its last option row. */
  last: number;
}

export function genericMenuRun(lines: readonly string[]): GenericMenuRun | null {
  const hits: { index: number; n: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(MENU_LINE);
    if (m?.[1]) hits.push({ index: i, n: parseInt(m[1], 10) });
  }
  // THE RUN NEAREST THE END, not the longest.
  //
  // This used to keep the longest run anywhere in the tail, which was chosen to survive a stray
  // earlier numbered log line. But a menu is only a menu when the LAST line asks a choice (see
  // `asksChoice` below), so the live dialog is by construction the run closest to that prompt — and
  // "longest" picks the wrong one whenever a numbered plan or checklist is printed above a shorter
  // live menu. That is not a cosmetic mis-pick: it offered the PLAN's buttons for a menu that does
  // not have them, and it excluded the live question from the concierge's fingerprint, turning a
  // press that should be refused into one that matches (roborev 55245, 55258; bead sparkle-x8nm).
  //
  // The stray-log-line robustness is preserved by the >= 2 requirement below: a single stray
  // numbered line never forms a run, and two consecutive strays counting 1,2 BELOW a real menu
  // would have to sit between it and the choice prompt.
  let best: { index: number; n: number }[] = [];
  let cur: { index: number; n: number }[] = [];
  let expected = 1;
  for (const hit of hits) {
    if (hit.n === 1) {
      cur = [hit];
      expected = 2;
    } else if (hit.n === expected) {
      cur.push(hit);
      expected += 1;
    } else {
      cur = [];
      expected = 1;
    }
    // >=, so a LATER run of the same or greater length replaces an earlier one.
    if (cur.length >= 2 && cur.length >= 1) best = cur.slice();
  }
  if (best.length < 2) return null;
  return {
    numbers: best.map((h) => h.n),
    first: best[0]!.index,
    last: best[best.length - 1]!.index,
  };
}

/** The tail window the generic menu path reads, so a caller can index into the same array. */
export function genericMenuWindow(scrollback: string): string[] {
  return tail(scrollback);
}

function parsePickerOptions(scrollback: string): { n: number; label: string }[] {
  return parsePickerOptionsWithBounds(scrollback).opts;
}

function parsePickerOptionsWithBounds(scrollback: string): {
  opts: { n: number; label: string }[];
  bounds: PickerBounds | null;
} {
  const lines = tail(scrollback, PICKER_WINDOW);
  // The LAST footer wins — an earlier, answered picker higher in the window is stale.
  let footerIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (PICKER_FOOTER.test(lines[i] ?? "")) {
      footerIdx = i;
      break;
    }
  }
  if (footerIdx < 0) return { opts: [], bounds: null };

  // Walk the block above the footer bottom-up, collecting options while the numbers count DOWN
  // to 1. Most wrapped description lines don't match PICKER_OPTION and are skipped; one that
  // DOES (a body line starting with a numbered-list fragment like "2. do that") is handled by
  // the anchor rules: walking upward a real picker only ever counts down, so a HIGHER number
  // than expected means the current anchor was junk below the true last option — restart the
  // run from this line. A LOWER number than expected is junk inside the block — skip it.
  let opts: { n: number; label: string }[] = [];
  let firstIdx = -1;
  let expected = -1; // the next number we accept walking upward (-1 = any to start)
  for (let i = footerIdx - 1; i >= Math.max(0, footerIdx - PICKER_SPAN); i--) {
    const m = (lines[i] ?? "").match(PICKER_OPTION);
    if (!m?.[1] || m[2] === undefined) continue;
    const n = parseInt(m[1], 10);
    if (expected !== -1 && n < expected) continue;
    if (expected !== -1 && n > expected) {
      opts = []; // bad anchor: this is the true bottom of the option run
    }
    opts.unshift({ n, label: m[2] });
    firstIdx = i;
    if (n === 1) break;
    expected = n - 1;
  }
  if (opts.length < 2 || opts[0]?.n !== 1) return { opts: [], bounds: null };
  return { opts, bounds: { first: firstIdx, footer: footerIdx } };
}

/** Detect Claude Code's option picker; returns one button per option ("N · label" → "N\n"). */
export function detectClaudeCodePicker(scrollback: string): SuggestionButton[] {
  return parsePickerOptions(scrollback)
    .slice(0, PICKER_MAX_BUTTONS)
    .map((o) => btn(`${o.n} · ${truncateLabel(o.label)}`, `${o.n}\n`));
}

// ── Claude Code's session-resume prompt ──
// A specialization of the picker above, shown when resuming a large session:
//   ❯ 1. Resume from summary (recommended)
//     2. Resume full session as-is
//     3. Don't ask me again
// We match it ONLY when BOTH the "summary" and "full session" options are present, and we read the
// real option numbers off the parsed picker rather than assuming 1/2 — Claude Code may renumber or
// reorder these. If either option is missing we return null and never guess a digit (fail safe).
const RESUME_SUMMARY_LABEL = /resume\s+from\s+summary/i;
const RESUME_FULL_LABEL = /resume\s+(?:the\s+)?full\s+session/i;

/** Detect the session-resume prompt; returns the keystrokes for each mode, or null if it isn't one
 *  (or is missing either option). `summaryOption`/`fullOption` are ready to `writePty` (e.g. "1\n"). */
export function detectResumePrompt(
  scrollback: string,
): { summaryOption: string; fullOption: string } | null {
  const opts = parsePickerOptions(scrollback);
  if (opts.length === 0) return null;
  const summary = opts.find((o) => RESUME_SUMMARY_LABEL.test(o.label));
  const full = opts.find((o) => RESUME_FULL_LABEL.test(o.label));
  if (!summary || !full) return null;
  return { summaryOption: `${summary.n}\n`, fullOption: `${full.n}\n` };
}

export function detectTerminalPrompts(scrollback: string): SuggestionButton[] {
  // The Claude Code picker is the most specific (and most common) prompt — try it first.
  const picker = detectClaudeCodePicker(scrollback);
  if (picker.length > 0) return picker;

  const lines = tail(scrollback);
  if (lines.length === 0) return [];

  // Numbered menu: parse option numbers in tail order, then take the CONTIGUOUS 1,2,3,… run
  // NEAREST THE END (see `genericMenuRun`). This rejects scattered/duplicate/non-1-based numbers
  // from ordinary logs (e.g. "7) x" / "9) y") via the >= 2 requirement, and picks the LIVE dialog
  // rather than a numbered plan printed above it. Require >= 2 options AND a genuine choice prompt
  // on the last line.
  const lastLine = lines[lines.length - 1] ?? "";
  const run = genericMenuRun(lines);
  if (run && asksChoice(lastLine)) {
    return run.numbers.slice(0, 3).map((n) => btn(String(n), `${n}\n`));
  }

  // Yes/No confirmation: must be asked in the last 2 lines.
  const lastTwo = lines.slice(-2).join("\n");
  if (YN.test(lastTwo)) {
    return [btn("Approve", "y\n"), btn("Deny", "n\n")];
  }

  return [];
}
