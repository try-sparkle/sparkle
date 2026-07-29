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
// catches a prompt even when the highlighted-option cursor renders as a glyph we don't expect. It
// is ONE source of truth: heuristics.ts + approvalClassifier.ts import THIS regex, so the option
// detector, the category classifier, and this status check can never desync on what marks a picker.
//
// MATCHED BY SHAPE, NOT BY LITERALS — the same lesson isSpinnerFrame learned (statusEngine.ts:~90).
// Every picker footer is a KEY-HINT BAR: a line made of nothing but "<key> to <verb…>" segments
// separated by "·". The wording of the segments is Claude's to change, and it varies per dialog —
// three captured verbatim from 2.1.220 (see capturedScreens.fixture.ts), sharing no common phrase:
//   permission dialog     "Esc to cancel · Tab to amend · ctrl+e to explain"
//   AskUserQuestion menu  "Enter to select · ↑/↓ to navigate · Esc to cancel"
//   /model picker         "Enter to set as default · s to use this session only · Esc to cancel"
// The old marker anchored on the first two as literal pairs and so missed the third outright.
//
// The bias here is the opposite of this file's default: a picker we fail to recognize is an agent
// blocked on a human who is never told, which is strictly worse than a false red. Hence shape.
//
// SAFETY — the shape must not match ambient chrome, or every agent pins red forever (the mirror
// failure). Two rules keep it out:
//   1. WHOLE LINE, EVERY segment a key hint, at least TWO of them. Claude's persistent bars and
//      toasts always carry a non-hint segment ("▶▶ bypass permissions on (shift+tab to cycle) ·
//      PR #730 · esc to interrupt", "⏸ manual mode on · ? for shortcuts", "Update installed ·
//      Restart to apply"), and prose is a sentence, not a hint bar. Requiring two also keeps a
//      lone mention ("Tip: press esc to cancel…") out.
//   2. `to interrupt` disqualifies the line outright. That verb marks the always-present status
//      bar — "interrupt" means a turn is RUNNING, which is the opposite of blocked.
// NON_PICKER_HINT_LINES_2_1_220 in the fixture pins rule 1 and 2 against real chrome.
//
// Rule 2 is a literal denylist on a matcher whose whole thesis is that literals drift, so it is
// kept to the ONE verb that earns it. `to cycle` was in it and was removed (roborev 54749): the
// only real chrome carrying `to cycle` is the permission-mode bar above, which rule 1 rejects
// unaided on its leading "▶▶" — so the entry bought nothing — while "cycle" is a plausible verb for
// a genuine blocking footer (the sibling footers already say "to switch" / "to navigate" / "to
// adjust" for the same affordance), and ONE such segment blanks the WHOLE line. That is false calm
// on a dialog, which the header above calls strictly worse than a false red. Both halves of that
// trade are pinned by tests, so re-adding `to cycle` now goes red instead of passing silently.
const FOOTER_KEY_ATOM =
  "(?:(?:ctrl|control|cmd|command|alt|opt|option|shift|meta|fn)\\s*\\+\\s*\\w+" +
  "|enter|return|esc(?:ape)?|tab|space(?:bar)?|backspace|del(?:ete)?|home|end" +
  "|pg\\s?up|pg\\s?dn|page\\s?up|page\\s?down|up|down|left|right|[↑↓←→]|[a-z0-9])";
// A key, or a group of them: "↑/↓", "←/→", "← or →", "Enter/↓", "shift+tab".
const FOOTER_KEY = `${FOOTER_KEY_ATOM}(?:\\s*(?:/|,|\\bor\\b)\\s*${FOOTER_KEY_ATOM})*`;
// One hint: a key, "to", and a description running to the next separator.
const FOOTER_HINT = `${FOOTER_KEY}\\s+to\\s+[^·•∙]*[^\\s·•∙]`;
// The bar: optional box border, then >= 2 hints and NOTHING else, to end of line.
// The disqualifier is scoped to ONE RENDERED LINE — `[^\\n\\r]*`, not `[^\\n]*` (roborev 54749).
// `m` makes `^`/`$` break on `\r` as well as `\n`, but `[^\\n]*` scans happily across `\r`, and the
// ingest path feeds this classifier `\r`-framed chunks: statusEngine splits only on `\n` and passes
// `this.partial`, the unterminated in-place-redraw tail (see its "frame\rframe\rframe" tests). So a
// chunk whose FIRST frame is a real picker footer and whose LATER frame is a spinner redraw
// ("… esc to interrupt)") had the footer suppressed by text belonging to a DIFFERENT frame — a
// false GRAY on a blocked agent, the exact direction this matcher exists to eliminate. FOOTER_LEGACY
// never had the bug because `.` already excludes `\r`; it was specifically the shape arm, and so
// specifically the footers only the shape arm catches (/model, the diff/review bar), that leaked.
const FOOTER_BAR =
  `^(?![^\\n\\r]*\\bto interrupt\\b)[ \\t]*[│|┃]?[ \\t]*` +
  `${FOOTER_HINT}(?:[ \\t]*[·•∙][ \\t]*${FOOTER_HINT})+[ \\t]*[│|┃]?[ \\t\\r]*$`;
// The pre-2.1.220 literal pairs are kept as a first arm: they cost nothing, they still match the
// footers of older Claude builds, and they keep matching a footer that grows a non-hint segment
// (which rule 1 above would otherwise reject). `m` anchors FOOTER_BAR per line, so this works
// identically on a whole snapshot and on the single line heuristics.ts feeds it.
const FOOTER_LEGACY =
  "enter to (select|confirm|submit)\\b.*(navigate|cancel)|\\besc to cancel\\b.*\\bctrl\\+e to explain\\b";
export const PICKER_FOOTER = new RegExp(`${FOOTER_LEGACY}|${FOOTER_BAR}`, "im");

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
