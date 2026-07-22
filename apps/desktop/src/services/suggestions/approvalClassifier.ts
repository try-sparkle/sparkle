// Classify a detected Claude Code permission prompt into an ApprovalCategory + the keystroke that
// selects its plain "Yes" option. Returns null for anything that is NOT clearly a yes/no-style
// permission prompt (an AskUserQuestion clarifying picker, an ordinary numbered menu, junk) so the
// auto-answer executor can FAIL SAFE and never type into an unrecognized prompt.
//
// SECURITY: this is the ONLY source of an auto-answer keystroke. It runs on untrusted PTY scrollback
// but emits nothing except a bare option-number keystroke ("1\n") derived from an option the local
// heuristic detector already parsed — never anything from the AI/learned tier. See the design spec:
// docs/superpowers/specs/2026-07-10-sparkle-auto-approve-design.md §1.
import { PICKER_FOOTER, detectClaudeCodePicker } from "./heuristics";
import type { SuggestionButton } from "./types";
import type { ApprovalCategory } from "./approvalCategories";

export interface ApprovalClassification {
  category: ApprovalCategory;
  /** The keystroke that selects the plain-affirmative option, e.g. "1\n". */
  approveOption: string;
}

// Mirror the picker window used by detectClaudeCodePicker so the category is read from the SAME
// region the options were parsed from (the header text sits just above the option block).
const PICKER_WINDOW = 50;
const PICKER_SPAN = 30;
// PICKER_FOOTER is imported from heuristics.ts (the single source of truth) so header-region
// classification always reads the SAME footer the option detector parsed the options from — the two
// can never drift apart. It matches both the standard picker footer and the Bash-approval footer.

// The plain affirmative ("Yes", "Yes.") — the option we auto-select. Deliberately NOT the
// "Yes, and don't ask again / allow all edits this session" variants (those hand control to Claude
// Code's own allowlist, which the spec explicitly avoids so Sparkle's toggle stays authoritative).
const PLAIN_YES = /^\s*yes\b/i;
// A "Yes, and …" continuation or a native remember-my-answer option — marks an option as NOT the
// plain Yes (so findApproveOption skips it). The bare `\band\b` is fine here because it's only ever
// tested against options that ALREADY start with "Yes"; it must NOT be used to detect a permission
// dialog (an ordinary picker option like "Merge and rebase" would false-positive — see
// looksLikePermission, which keys on an explicit No option instead).
const YES_CONTINUATION = /\band\b|don'?t ask|allow all|allow any|for the rest|this session|automatically/i;
const NO_OPTION = /^\s*no\b/i;

// Category signals, checked in the spec's stated order (skill → bash → edit → mcp → fetch → other).
// The FIRST match wins, so more-specific classes are listed before broader ones.
const CATEGORY_RULES: Array<[ApprovalCategory, RegExp]> = [
  ["skill", /\buse skill\b|\bskill\b/i],
  ["bash", /\bbash\b|\brun (?:this |the )?command\b|\bshell command\b|\bexecute\b|(?:^|\s)\$\s|\bcommand\b/i],
  ["edit", /\bedit\b|\bwrite\b|\bcreate file\b|\bapply this edit\b|\bmodify\b|\bupdate (?:the )?file\b/i],
  ["mcp", /mcp__|\buse tool\b|\btool call\b|\bMCP\b/i],
  ["fetch", /\bweb\s?fetch\b|\bfetch\b|https?:\/\//i],
];

function tailLines(scrollback: string, n: number): string[] {
  const lines = scrollback.replace(/\r/g, "").split("\n").filter((l) => l.trim().length > 0);
  return lines.slice(-n);
}

// A numbered picker option line ("1. Yes", "❯ 2. …"). Category classification EXCLUDES these so an
// option's own text — e.g. a remember-option "Yes, and don't ask again for rm commands" — can't
// drive the category (which would misclassify an edit/mcp/other prompt as `bash` off the word
// "commands"). Only the header + action body (the lines above/around the options) classify.
const OPTION_LINE = /^\s*(?:[❯›>]\s*)?\d{1,2}\.\s+/;

/** The header/question region for the LATEST picker: the non-empty lines just above the last picker
 *  footer, with the numbered option lines removed (so option labels don't drive the category). Falls
 *  back to the whole tail window (minus option lines) when no footer is present. */
function headerRegion(scrollback: string): string {
  const lines = tailLines(scrollback, PICKER_WINDOW);
  let footerIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (PICKER_FOOTER.test(lines[i] ?? "")) {
      footerIdx = i;
      break;
    }
  }
  const region = footerIdx < 0 ? lines : lines.slice(Math.max(0, footerIdx - PICKER_SPAN), footerIdx);
  return region.filter((l) => !OPTION_LINE.test(l)).join("\n");
}

/** Strip the "N · " prefix detectClaudeCodePicker adds to a button label, leaving the raw option text. */
function optionText(b: SuggestionButton): string {
  return b.label.replace(/^\s*\d{1,2}\s*·\s*/, "");
}

/** The keystroke ("1\n") of the plain-Yes option, or null if none of the options is a plain Yes. */
function findApproveOption(buttons: SuggestionButton[]): string | null {
  for (const b of buttons) {
    const text = optionText(b);
    if (PLAIN_YES.test(text) && !YES_CONTINUATION.test(text)) return b.value;
  }
  return null;
}

/** True when the option set reads like a permission dialog: a plain "Yes" option AND an explicit
 *  "No…" option (Claude Code permission prompts always carry a "No, and tell Claude…" reject
 *  option). Requiring the No — rather than accepting any "…and…" continuation — is what keeps an
 *  ordinary picker whose option 1 is "Yes" and whose option 2 is e.g. "Merge and rebase" from being
 *  misread as a permission prompt and auto-answered (the fail-safe). */
function looksLikePermission(buttons: SuggestionButton[]): boolean {
  const texts = buttons.map(optionText);
  const hasPlainYes = texts.some((t) => PLAIN_YES.test(t) && !YES_CONTINUATION.test(t));
  const hasNo = texts.some((t) => NO_OPTION.test(t));
  return hasPlainYes && hasNo;
}

function classifyCategory(region: string): ApprovalCategory {
  for (const [cat, re] of CATEGORY_RULES) {
    if (re.test(region)) return cat;
  }
  return "other";
}

/**
 * Classify a permission prompt in `scrollback`. Returns `{ category, approveOption }` when it is a
 * clearly-classifiable yes/no permission dialog, else null (fail safe — the caller must never
 * auto-answer on null).
 */
export function classifyApproval(scrollback: string): ApprovalClassification | null {
  const buttons = detectClaudeCodePicker(scrollback);
  if (buttons.length < 2) return null;
  if (!looksLikePermission(buttons)) return null;
  const approveOption = findApproveOption(buttons);
  if (!approveOption) return null;
  return { category: classifyCategory(headerRegion(scrollback)), approveOption };
}
