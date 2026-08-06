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
//
// THE ONE IMPORT. `services/sessionLimitScreen.ts` is dependency-free and is deliberately the
// shared source of truth for the session-limit picker's option labels and anchoring budget, because
// `src-tauri/src/nudge_gate.rs` transcribes it and a `cargo test` reads it back. Keeping those
// literals out of this file is what lets the Rust twin be pinned to the same bytes the TypeScript
// classifier uses. See `isSessionLimitPicker` below.
import {
  MAX_OPTION_FOOTER_GAP,
  MAX_CHROME_BELOW_FOOTER,
  AMBIENT_CHROME_LINE,
  hasSessionLimitOptions,
  isSessionLimitOptionLine,
} from "../services/sessionLimitScreen";

// Claude Code's interactive selection cursor at the start of a numbered choice, e.g. "❯ 1. Yes".
// The highlighted-option glyph drifts between builds/fonts (U+276F ❯ or U+203A ›), so we accept
// both. We deliberately do NOT accept a bare ">" here: unlike heuristics.PICKER_OPTION (whose match
// only becomes an auto-answer after the looksLikePermission "No"-option gate), a bare "> 1. …" would
// flip status RED off any markdown blockquote in scrollback. The footer check below is the
// glyph-independent catch-all, so ">"-cursor prompts are still caught — via their footer.
export const SELECTION_CURSOR = /^\s*[│|]?\s*[❯›]\s*\d+\.\s/m;

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
export const SHELL_PROMPTS: RegExp[] = [
  /[([]y\/n[)\]]/i,
  /press enter to continue/i,
  /\boverwrite\?/i,
  /(^|\s)password:\s*$/im,
  /enter passphrase/i,
];

// ── The SESSION-LIMIT picker ────────────────────────────────────────────────────────────────────
//
// Claude Code draws this when the account's session window runs out MID-TURN:
//
//   What do you want to do?
//   > 1. Stop and wait for limit to rese&#8203;t
//     2. Switch to usage credit&#8203;s
//     3. Switch to Team pla&#8203;n
//   [confirm-key] to confirm / [cancel-key] to cancel
//
// DE-FANGED, exactly as PRD §6 de-fangs the same reproduction — do not "fix" the glyphs.
//
// WHAT ACTUALLY PROTECTS THIS FILE, measured rather than assumed: the `//` comment prefix. Every
// option pattern in `services/sessionLimitScreen.ts` is anchored with `^\s*[│|]?\s*[❯›]?\s*\d+\.`,
// and `//` is none of those, so a commented reproduction cannot match however live its glyphs are.
// Restoring `❯` and the real footer here was tried against the test below and it stayed GREEN.
//
// The de-fanging is therefore defence in depth, and it is worth keeping for one specific reason:
// the failure mode this file is exposed to is the block being LIFTED OUT of the comment — into a
// fixture, a template literal, a doc example — where the prefix no longer protects it. That
// mutation DOES turn the test below red (verified: injected as a template literal, "viewport ending
// at line 116 classifies as the picker"). Keeping the copy here already de-fanged means the lift is
// harmless too. `>` is not in SELECTION_CURSOR's glyph class, the labels carry a zero-width space
// (written as an HTML entity so it survives a whitespace-trimming editor), and the footer is
// rewritten so no footer matcher fires.
//
// `screenAwaitsInput` already returns true for it (both arms match) — that is not the problem. The
// problem is that the answer is DISCARDED downstream: a session limit lands mid-turn, so no `Stop`
// hook ever fires, `lastHook` freezes at `working`, and statusRouter's screen escalation only ever
// lifts a hook-IDLE turn. The row stays green while the agent is wedged on a dialog nobody sees.
// So the router needs to know not just "a prompt is on screen" but "it is THIS prompt", which is
// the one screen state that outranks a frozen hook. See PRD/sparkle/claude-account-identity-truth.md §6.
//
// FALSE POSITIVES ARE THE HARD PART, and the bias is the opposite of PICKER_FOOTER's: a missed
// session-limit picker costs a green row on a stuck agent (the bug we already have), while a false
// one pins a HEALTHY agent red *and* — because the reason code this drives is W-RESUME's trigger —
// invites a machine keystroke at a dialog nobody read. So this function is deliberately hard to
// satisfy. Three independent gates, all required:
//
//   1. CO-PRESENCE, in the same rendered frame — the numbered option lines AND `SELECTION_CURSOR`
//      AND `PICKER_FOOTER`. Those two matchers are reused, never re-spelled as literals, so this
//      cannot drift away from what the rest of the file calls a picker.
//   2. BOTTOM-ANCHORED. A live Ink dialog is the last thing on the grid: its footer must be the
//      final non-blank line of the snapshot. This is what keeps the function off PROSE — a design
//      doc, a diff, or a `cat` of this repo that happens to quote the screen keeps printing after
//      it, so the footer is never last. (The one document that reproduces this screen verbatim,
//      §6 of the PRD above, is de-fanged as well — belt and braces, and a test reads it out of the
//      file to keep it that way.)
//   3. THE OPTION LABELS THEMSELVES, which live in `services/sessionLimitScreen.ts` and NOT here.
//      That module is the ONE place this predicate and its Rust twin agree on, and the agreement is
//      enforced: `nudge_gate.rs`'s `ported_typescript_patterns_have_not_drifted` reads that file at
//      `cargo test` time. A second matcher spelled out in this file would be invisible to that
//      test, so a widening here could exempt screens the Rust gate has never heard of — and the
//      Rust gate is what licenses the keystroke. Hence delegation, not duplication.
//
// SCOPE — the settle-time VIEWPORT only (`getScreen()`), never streamed scrollback. statusEngine
// calls this from settle/recheck, never from `ingest`, which is why quoting the screen into a
// terminal cannot trip it: the quote scrolls, and rule 2 needs the footer to be the last line.

/** Is this ONE rendered row a picker footer?
 *
 *  `PICKER_FOOTER` is shared with heuristics.ts / approvalClassifier.ts and is not this function's
 *  to change, so the extra `to interrupt` guard is applied HERE. `FOOTER_BAR` carries that
 *  disqualifier already but `FOOTER_LEGACY` does not, and the Rust port applies it to both arms —
 *  so without this line the two sides would disagree on a spinner frame that happens to contain the
 *  legacy wording, which is exactly the disagreement the sync test cannot see. */
function isPickerFooterLine(line: string): boolean {
  return !/\bto interrupt\b/i.test(line) && PICKER_FOOTER.test(line);
}

/**
 * True when the rendered viewport is Claude Code's SESSION-LIMIT picker specifically — the account
 * ran out of session window mid-turn and the agent is parked on an unanswered dialog.
 *
 * Read the header block above before loosening anything here: this is the one classifier whose
 * answer PIERCES hook authority, and whose reason code is a machine trigger.
 *
 * STRUCTURALLY IDENTICAL TO `nudge_gate::screen_is_session_limit_picker`, step for step, and it has
 * to be: that function is what permits a machine keystroke at a billing dialog, and it fails closed
 * whenever the two sides disagree. Change one, change the other, in the same commit.
 */
/** Pure SEPARATION — blank, or nothing but box decoration. Border-aware because every other matcher
 *  here tolerates a frame (`SELECTION_CURSOR` and the footer arms all carry `[│|┃]?`) and the
 *  fixtures pin Claude Code's `╭─ … ─╮` menu as a real screen; a literal emptiness test would treat
 *  a box spacer or bottom border as content and reject a genuinely bordered picker. Kept in step
 *  with `nudge_gate.rs::is_separator_row` (roborev 58539). */
const SEPARATOR_ROW = /^[\s│|┃╭╮╰╯┌┐└┘┏┓┗┛─━┄┈═]*$/;
function isSeparatorRow(line: string): boolean {
  return SEPARATOR_ROW.test(line);
}

/** An OPENING box border, and therefore NOT separation (roborev 58557).
 *
 *  `isSeparatorRow` answers "does this row carry content" and cannot tell a box CLOSING from one
 *  OPENING — which is the whole safety argument. `╰────╯` says the frame we matched ended; a
 *  `╭──────╮` says a DIFFERENT frame starts here, so what follows is that dialog's, not ours.
 *  Kept in step with `nudge_gate.rs::is_opening_border`. */
const OPENING_BORDER = /[╭╮┌┐┏┓]/;
function isOpeningBorder(line: string): boolean {
  return OPENING_BORDER.test(line);
}

/** A CLOSING box border — the only decoration the trailing budget may spend its one slot on.
 *
 *  `isSeparatorRow && !isOpeningBorder` is a LOOSER predicate: the separator class contains `─`,
 *  which is the full-width transcript divider the real TUI draws between segments. A divider
 *  beneath the footer is the same "different frame" evidence `isOpeningBorder` rejects, so it must
 *  not consume the slot (roborev 58571). Kept in step with `nudge_gate.rs::is_closing_border`. */
const CLOSING_BORDER = /[╰╯└┘┗┛]/;
function isClosingBorder(line: string): boolean {
  return CLOSING_BORDER.test(line);
}

export function isSessionLimitPicker(snapshot: string): boolean {
  if (!snapshot.trim()) return false;

  // The LABEL half — the mandatory "stop and wait for limit to reset" plus at least one of the two
  // "Switch to …" remedies. Delegated whole; this file spells out no option literal of its own.
  if (!hasSessionLimitOptions(snapshot)) return false;

  // SPLIT ON `\n` AND `\r` SEPARATELY, exactly as `nudge_gate::lines` does — `text.split(['\n','\r'])`.
  // Not `/\r?\n/`, and not `/\r\n|\r|\n/` either: the PTY redraws in place, so a chunk can carry
  // several frames separated by carriage returns ALONE. `/\r?\n/` collapses such a chunk into one
  // array element, and since every rule below is now line-INDEX arithmetic, the footer search from
  // `lastOption + 1` would find nothing and this side would answer false while Rust answered true —
  // a disagreement that grants the Esc exemption off a screen the classifier never recognised. The
  // character class also reproduces Rust's empty element for `\r\n`, so the indices match too.
  const lines = snapshot.split(/[\n\r]/);

  // Rule 1 — the selection cursor, ON AN OPTION ROW OF THIS DIALOG.
  //
  // Tested per option line rather than against the whole snapshot (roborev 58159). Against the
  // snapshot, any `❯ 1. …` anywhere in the visible scrollback satisfied it — including a permission
  // menu hundreds of rows above — so "a menu nobody is sitting on cannot qualify" was false, and the
  // widening was in the dangerous direction: this predicate's reason code arms a machine keystroke.
  // Where the dialog's own options END is computed in the same pass, since the footer must belong
  // to THESE options rather than to some earlier frame still on the grid.
  let lastOption = -1;
  let cursorOnOption = false;
  for (let i = 0; i < lines.length; i++) {
    if (!isSessionLimitOptionLine(lines[i]!)) continue;
    lastOption = i;
    if (SELECTION_CURSOR.test(lines[i]!)) cursorOnOption = true;
  }
  if (lastOption < 0 || !cursorOnOption) return false;

  // Rule 2a — a picker footer, and it must sit BELOW the options and WITHIN the same frame. A
  // footer above them belongs to a different dialog; one far below them belongs to a live prompt
  // whose options scrolled off ages ago.
  let footerAt = -1;
  for (let i = lastOption + 1; i < lines.length; i++) {
    if (isPickerFooterLine(lines[i]!)) {
      footerAt = i;
      break;
    }
  }
  if (footerAt < 0 || footerAt - lastOption > MAX_OPTION_FOOTER_GAP) return false;

  // Rule 2a-bis — the footer must BELONG to this option block. Positive ownership, not a
  // blocklist: only BLANK rows may separate the last option from its footer. Keying on an
  // intervening cursored NUMBERED row closed one shape and left the class open — a live slider or
  // switcher footer carries no numbered row, so it slipped through and the distance bound was again
  // the only defence, holding on height alone. The genuine article renders its footer immediately
  // beneath option 3. Kept in step with `nudge_gate.rs` (roborev 58527).
  // An OPENING border in that span is content however box-drawn it looks: a new frame began there,
  // so the footer beneath it is that frame's, not ours (roborev 58557).
  for (let i = lastOption + 1; i < footerAt; i++) {
    if (!isSeparatorRow(lines[i]!) || isOpeningBorder(lines[i]!)) return false;
  }

  // Rule 2b — bottom-anchored: nothing UNRECOGNIZED may follow the footer.
  //
  // This was "nothing but a blank and one closing border", and that rejected the real screen. The
  // session-limit picker renders with five rows of persistent chrome stacked beneath it; the four
  // captured screens the old bound was measured against are all OTHER dialogs. See the doc block on
  // MAX_CHROME_BELOW_FOOTER. Free below the footer, in any order: blanks; up to
  // MAX_CHROME_BELOW_FOOTER ambient-chrome rows; and ONE closing border, which is not chrome (a
  // corner is outside the chrome class) but is the bordered dialog's own bottom edge. An OPENING
  // border is never free — a new frame starting below is what would arm Esc at a live dialog.
  let chromeBelow = 0;
  let closingBorderBudget = 1;
  for (let i = footerAt + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim()) continue;
    if (isOpeningBorder(line)) return false;
    if (isSeparatorRow(line) && isClosingBorder(line) && closingBorderBudget > 0) {
      closingBorderBudget--;
      continue;
    }
    if (!AMBIENT_CHROME_LINE.test(line) || chromeBelow >= MAX_CHROME_BELOW_FOOTER) return false;
    chromeBelow++;
  }
  return true;
}

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
