// screenClassifier — decides, from a plain-text snapshot of the *rendered* terminal
// screen, whether the agent is blocked on a specific answer from the user.
//
// Why a separate, pure function: the engine owns the GREEN (working) signal via Claude's
// live "esc to interrupt" spinner, which is reliable on the raw stream. The hard call is
// the settle-time RED-vs-GRAY decision — and the raw byte stream is a poor surface for it
// (ANSI escapes, in-place redraws with no newlines). The fully rendered xterm screen is
// clean: it shows the actual permission box / question menu Claude drew. This function
// takes that snapshot and returns true only when the user is genuinely on the hook.
//
// Bias toward FALSE (gray). A false RED nags the user about a finished turn; a missed RED
// just shows gray on a real question, which the user notices anyway when they look. So we
// key off INTERACTIVE markers (Claude's ❯ selection cursor, classic shell prompts) rather
// than prose. Claude's own conversational "Do you want…?" text is deliberately NOT a
// trigger — its permission UI always pairs that text with the ❯ menu, which we do catch.
//
// Retrainable: Claude's TUI drifts between versions. If these markers ever stop matching,
// this is the one place to retune (or swap in a model call) without touching the engine.

// Claude Code's interactive selection cursor at the start of a numbered choice, e.g. "❯ 1. Yes".
// The highlighted-option glyph drifts between builds/fonts (U+276F ❯ or U+203A ›), so we accept
// both. We deliberately do NOT accept a bare ">" here: unlike heuristics.PICKER_OPTION (whose match
// only becomes an auto-answer after the looksLikePermission "No"-option gate), a bare "> 1. …" would
// flip status RED off any markdown blockquote in scrollback. The footer check below is the
// glyph-independent catch-all, so ">"-cursor prompts are still caught — via their footer.
const SELECTION_CURSOR = /^\s*[│|]?\s*[❯›]\s*\d+\.\s/m;

// Claude Code's interactive picker FOOTER — the closing hint line every menu/permission dialog
// draws below its options. It is a glyph-independent "a menu is open, waiting on you" marker, so it
// catches a prompt even when the highlighted-option cursor renders as a glyph we don't expect. Two
// shapes co-occur, matched as one source of truth (heuristics.ts + approvalClassifier.ts import
// THIS regex so the option detector, the category classifier, and this status check can never
// desync on what marks a picker):
//   - the standard selection menu: "Enter to select · ↑/↓ to navigate · Esc to cancel"
//   - the command-approval dialog:  "Esc to cancel · [Tab to amend ·] ctrl+e to explain"
// The approval footer DROPS "Tab to amend" whenever the highlighted option isn't the amendable
// "Yes" (i.e. option 2/3), so we anchor on the always-present "esc to cancel … ctrl+e to explain"
// pair, NOT on "tab to amend" (which silently missed those frames — the auto-approve/red-status
// bug this fixes). Requiring BOTH phrases on the one line keeps an incidental prose mention of
// either from being read as a picker footer. None of these phrases occur in Claude's own prose.
export const PICKER_FOOTER =
  /enter to (select|confirm|submit)\b.*(navigate|cancel)|\besc to cancel\b.*\bctrl\+e to explain\b/i;

// Classic shell / CLI prompts. These don't appear in Claude's prose, so they're safe to
// match anywhere in the snapshot. The `/i` flag case-folds, so one delimiter-agnostic
// pattern covers `(y/n)`, `[Y/n]`, `[y/N]` etc. (It also matches mismatched delimiters
// like `(y/n]` — harmless: such strings never occur in prose and are still prompt-like.)
const SHELL_PROMPTS: RegExp[] = [
  /[([]y\/n[)\]]/i,
  /press enter to continue/i,
  /\boverwrite\?/i,
  /(^|\s)password:\s*$/im,
  /enter passphrase/i,
];

/**
 * True when the rendered screen shows the agent blocked on a specific answer from the
 * user (a Claude selection menu or a shell prompt). False for a finished turn at the idle
 * input box, conversational prose, or an empty screen.
 */
export function screenAwaitsInput(snapshot: string): boolean {
  if (!snapshot.trim()) return false;
  if (SELECTION_CURSOR.test(snapshot)) return true;
  // The footer is scanned across the WHOLE snapshot, intentionally — the same whole-snapshot scan
  // SELECTION_CURSOR has always used, and it inherits that exact staleness profile (no worse). This
  // is safe on both call paths: (a) ingest() tests one freshly-streamed line at a time, so a footer
  // only ever matches as it arrives, never a stale one re-read from scrollback; (b) settle() tests
  // the RENDERED viewport, where a live Ink picker is the bottom-most frame and its footer is
  // cleared by the redraw when the menu is dismissed. A menu answered mid-turn also resumes the
  // spinner, which routes to `working` before settle re-checks the screen. Bias here is toward RED
  // (a blocked agent needs a human) — the founder-reported failure was the opposite, a false gray.
  if (PICKER_FOOTER.test(snapshot)) return true;
  return SHELL_PROMPTS.some((re) => re.test(snapshot));
}
