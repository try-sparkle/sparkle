import type { SuggestionButton } from "./types";

// Only the last N non-empty lines are considered "live" — a prompt scrolled far up is stale.
const TAIL_LINES = 12;

// `YN` matches "[y/n]" / "[yes/no]" case-insensitively (the bracket alternatives), plus bare
// "y/n" / "yes/no" word forms. (An earlier YN_DEFAULT regex was removed — it was fully subsumed
// by this one and added no behavior.)
const YN = /\b(y\/n|yes\/no)\b|\[y\/n\]|\[yes\/no\]/i;
const MENU_LINE = /^\s*[\[(]?(\d{1,2})[\]).]\s+\S/; // "1) x", "2. x", "[3] x", "(4) x"

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
// Claude Code's Bash-command approval prompt renders a DIFFERENT footer — "Esc to cancel · Tab to
// amend · ctrl+e to explain" — that lacks the "Enter to select …" text. We anchor on its unique
// "Tab to amend … ctrl+e to explain" phrasing, which sits BELOW the option block in the same
// structural position as the standard footer, so the upward option walk works identically. Both
// phrases must co-occur on the ONE line (not either alone) so an incidental scrollback line that
// merely mentions "tab to amend" or "ctrl+e to explain" can't be mistaken for a picker footer.
const PICKER_WINDOW = 50; // non-empty lines to search for the footer
const PICKER_SPAN = 30; // non-empty lines above the footer the option block may span
// Exported as the single source of truth: approvalClassifier.ts imports this exact regex for its
// header-region scan, so the option detector and the category classifier can never desync on which
// footer marks a prompt (they must agree byte-for-byte — see the classifier's headerRegion).
export const PICKER_FOOTER =
  /enter to (select|confirm|submit)\b.*(navigate|cancel)|\btab to amend\b.*ctrl\+e to explain/i;
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
function parsePickerOptions(scrollback: string): { n: number; label: string }[] {
  const lines = tail(scrollback, PICKER_WINDOW);
  // The LAST footer wins — an earlier, answered picker higher in the window is stale.
  let footerIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (PICKER_FOOTER.test(lines[i] ?? "")) {
      footerIdx = i;
      break;
    }
  }
  if (footerIdx < 0) return [];

  // Walk the block above the footer bottom-up, collecting options while the numbers count DOWN
  // to 1. Most wrapped description lines don't match PICKER_OPTION and are skipped; one that
  // DOES (a body line starting with a numbered-list fragment like "2. do that") is handled by
  // the anchor rules: walking upward a real picker only ever counts down, so a HIGHER number
  // than expected means the current anchor was junk below the true last option — restart the
  // run from this line. A LOWER number than expected is junk inside the block — skip it.
  let opts: { n: number; label: string }[] = [];
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
    if (n === 1) break;
    expected = n - 1;
  }
  if (opts.length < 2 || opts[0]?.n !== 1) return [];
  return opts;
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

  // Numbered menu: parse option numbers in tail order, then find the longest CONTIGUOUS run
  // 1,2,3,… anywhere in that sequence (restarting whenever a "1" appears). This rejects
  // scattered/duplicate/non-1-based numbers from ordinary logs (e.g. "7) x" / "9) y", or "1) a"
  // appearing twice) yet still finds a real menu even when a stray earlier numbered log line
  // precedes it in the tail. Require >= 2 options AND a genuine choice prompt on the last line.
  const lastLine = lines[lines.length - 1] ?? "";
  const nums: number[] = [];
  for (const l of lines) {
    const m = l.match(MENU_LINE);
    if (m?.[1]) nums.push(parseInt(m[1], 10));
  }
  let best: number[] = [];
  let cur: number[] = [];
  let expected = 1;
  for (const n of nums) {
    if (n === 1) {
      cur = [1];
      expected = 2;
    } else if (n === expected) {
      cur.push(n);
      expected += 1;
    } else {
      cur = [];
      expected = 1;
    }
    if (cur.length > best.length) best = cur.slice();
  }
  if (best.length >= 2 && asksChoice(lastLine)) {
    return best.slice(0, 3).map((n) => btn(String(n), `${n}\n`));
  }

  // Yes/No confirmation: must be asked in the last 2 lines.
  const lastTwo = lines.slice(-2).join("\n");
  if (YN.test(lastTwo)) {
    return [btn("Approve", "y\n"), btn("Deny", "n\n")];
  }

  return [];
}
