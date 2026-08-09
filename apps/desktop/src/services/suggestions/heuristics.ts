import type { SuggestionButton } from "./types";
// The picker-footer regex is owned by the engine's screenClassifier (the single retune point for
// Claude Code TUI drift) and re-exported here for approvalClassifier, so the option detector, the
// category classifier, and the red-vs-gray status check can never desync on what marks a picker.
import { PICKER_FOOTER, pickerFooterSpan } from "../../engine/screenClassifier";

export { PICKER_FOOTER };

// Only the last N non-empty lines are considered "live" — a prompt scrolled far up is stale.
export const TAIL_LINES = 12;

// `YN` matches "[y/n]" / "[yes/no]" case-insensitively (the bracket alternatives), plus bare
// "y/n" / "yes/no" word forms. (An earlier YN_DEFAULT regex was removed — it was fully subsumed
// by this one and added no behavior.)
/** Exported so the concierge's picker fingerprint can decide whether a screen with no option run is
 *  a y/n confirmation or simply a dialog it failed to locate — those must not be conflated, because
 *  the second one is unsafe to fingerprint at all (roborev 55182). One definition, not two.
 *
 *  ══ A WRITE GUARD KEYS OFF THIS SAME SHAPE — CHANGE BOTH OR NEITHER ═══════════════════════════
 *  `voice/dictationTerminalRoute`'s `WRITE_BLOCKING_PROMPTS` carries its own `(yes/no)` pattern,
 *  because a confirmation is both "a picker the dispatcher ANSWERS" and "a prompt free text must not
 *  be pasted into". `services/conciergeDispatch` resolves that overlap: it refuses the prompt unless
 *  THIS detector reports the y/n pair, in which case it answers instead.
 *
 *  So the two are coupled, and the coupling is invisible from either file alone. It cost SIX review
 *  rounds (roborev 58512 → 58575), every one the same shape: the guard and the detector disagreeing
 *  about what was on screen — different regions, different sources, or a shape one matched and the
 *  other did not. Widening or narrowing `YN` here silently moves what that guard refuses.
 *
 *  If you change this pattern, or the branch order below that decides whether `YN` is reached at
 *  all, read `dictationTerminalRoute`'s `matchesBlockingPrompt` and `conciergeDispatch`'s credential
 *  arm in the same sitting. */
export const YN = /\by\s*\/\s*n\b|\byes\s*\/\s*no\b/i;
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
// The option-row shape as RENDERED, for callers that must ask "is this line an option row?" without
// running the whole footer-anchored parse. Border class is BOX-DRAWING ONLY — a literal ASCII `|`
// would make one prose line ("Options: 1. yes | 2. no") read as two rows.
export const RENDERED_OPTION_ROW = /(?:^|[\u2502\u2503])[ \t]*(?:[\u276f\u203a>][ \t]*)?\d{1,2}\.[ \t]+\S/;
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
  /** Index of the footer's FIRST line, which sits just below the last option row. */
  footer: number;
  /** Index of the footer's LAST line — the same as `footer` unless the footer wrapped onto a second
   *  line (bead sparkle-99o9a). A caller asking what sits BELOW the footer must use this one, or it
   *  reads the footer's own continuation as unrecognised content and calls the screen unanswerable
   *  (roborev 61827). */
  footerLast: number;
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
 *  THE RULE: the run NEAREST THE END of the window wins, whatever its length.
 *
 *  Exported with indices so the concierge's fingerprint can hash the block the detector actually
 *  chose. Sharing the PATTERN was not enough: the selection rule is a second definition, and the two
 *  disagreed — this USED TO keep the longest run (first-wins on ties) while a locator that kept the
 *  run nearest the end picked a different block, so the buttons and the fingerprinted question
 *  described different menus and nothing could catch it (roborev 55245). Making them agree was only
 *  half the fix: longest-wins is itself wrong, because a numbered plan printed above a live menu is
 *  longer than the menu (roborev 55258). One definition, and it is the nearest-the-end one. */
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
    // NO COMPARISON AGAINST `best` — that is the whole rule. Every run that reaches two options
    // overwrites the previous winner regardless of length, so the LAST such run is what survives.
    // Re-introducing a `cur.length >= best.length` guard here silently restores longest-wins: the
    // live 2-option menu never beats a 3-item plan above it, which is exactly the mismatch that let
    // a stale fingerprint authorise a press into a menu lacking the option pressed (roborev 55258).
    if (cur.length >= 2) best = cur.slice();
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
  /** Where the footer was, or -1. Reported even on a FAILED parse, because "there was a footer and
   *  the option block did not parse" and "there was no footer at all" are different diagnoses and
   *  `pickerParseDiagnosis` must not re-derive the answer with a second footer scan of its own. */
  footerIdx: number;
} {
  const lines = tail(scrollback, PICKER_WINDOW);
  // The LAST footer wins — an earlier, answered picker higher in the window is stale.
  // `pickerFooterSpan` rather than `PICKER_FOOTER.test`, so a footer Ink split across two lines at a
  // narrow pane width is still found — and `footerIdx` is the FIRST of those lines, which is what
  // keeps the option block above it intact (bead sparkle-99o9a).
  let footerIdx = -1;
  let footerSpan = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const span = pickerFooterSpan(lines, i);
    if (span > 0) {
      footerIdx = i;
      footerSpan = span;
      break;
    }
  }
  if (footerIdx < 0) return { opts: [], bounds: null, footerIdx };

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
  if (opts.length < 2 || opts[0]?.n !== 1) return { opts: [], bounds: null, footerIdx };
  return { opts, bounds: { first: firstIdx, footer: footerIdx, footerLast: footerIdx + footerSpan - 1 }, footerIdx };
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

// ── WHY THERE IS NOTHING TO PRESS (bead sparkle-99o9a) ────────────────────────────────────────
// `read_picker_options` used to answer an unreadable menu and an agent that is simply working with
// the SAME `{options: [], present: false, fingerprint: ""}`. That is safe — it refuses either way —
// but it is SILENT, and silence is what made the incident take four hand-observed occurrences to
// characterise: the concierge could not say which agent needed a human and why, and nothing was
// recorded for anyone to count afterwards.
//
// This does not decide anything and must never be used to decide anything. It reports.
//
// IT ASKS THE PARSER RATHER THAN RE-DERIVING. Every previous locator written alongside this parser
// disagreed with it in some way (roborev 55166/55172/55195/55218), and a diagnosis that disagrees
// with the parse it is explaining is worse than none — it would name the wrong cause confidently.
// So the footer index comes back FROM the parse.

/** Why a picker parse came back empty. Reported, never acted on. */
export type PickerBlindness =
  /** Nothing on screen resolves to a menu. The overwhelmingly common case: the agent is working. */
  | "no-menu"
  /** A footer IS there and the option block above it did not parse — the block scrolled out of
   *  `PICKER_SPAN`, or the rows never matched. This is the `approvalDeadEnd` shape (its
   *  `FOOTER_ONLY_SCREEN` fixture lands here, and a test pins that): a RED row with nothing
   *  pressable, and the residual case the wrap fix does not cover. */
  | "footer-without-options";

/**
 * Explain an empty picker parse. Only meaningful when the detector returned no options.
 *
 * TWO VALUES, NOT THREE (roborev 61832). There was a `no-footer` arm — "option rows are on screen
 * and no footer closes them" — and it had to go, because nothing available here can tell that from
 * an agent PRINTING A NUMBERED LIST. Its test was "two lines in the window match
 * `RENDERED_OPTION_ROW`", which any plan or todo output satisfies; asking the parser's own
 * question instead (a contiguous 1..N run) does not save it either, since `1. Read the file` /
 * `2. Patch it` is exactly such a run. The detector needs a footer or a choice prompt to call
 * something a menu precisely because the rows alone do not carry the answer.
 *
 * That mattered because of what the value CLAIMS: the tool description tells the model a
 * non-`no-menu` cause means something is on screen that a human should be asked to answer. A
 * numbered plan is the most common thing an agent prints, so the arm would have escalated calm
 * agents to the founder far more often than it named a real dialog — the exact noise `blind` exists
 * to remove. Reporting `no-menu` there is not a loss of signal; it is the honest answer.
 */
export function pickerParseDiagnosis(scrollback: string): PickerBlindness {
  const { footerIdx } = parsePickerOptionsWithBounds(scrollback);
  return footerIdx >= 0 ? "footer-without-options" : "no-menu";
}
