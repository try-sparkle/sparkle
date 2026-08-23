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
// ── THE BOX BORDER IS ONE CLASS, SHARED (bead sparkle-67xxw) ──────────────────────────────────
// Claude Code draws its dialogs inside a box, so an option row is `│ ❯ 1. Yes, and auto-accept …`.
// This class and `heuristics.PICKER_OPTION` are two guards over the SAME row, and they drifted: the
// parser admitted no border at all (so a boxed dialog parsed to nothing and could not be answered),
// and this one admitted `│` but not the heavy `┃`. Exported so heuristics builds its matchers from
// the same string — the two cannot disagree about what a border is again.
export const OPTION_ROW_BORDER = "[\\u2502\\u2503]"; // │ ┃
// The ASCII `|` is admitted HERE and nowhere else, and the asymmetry is deliberate: this pattern
// additionally requires a `❯` POINTING AT the row, which prose does not draw, so it cannot mistake
// "Options: 1. yes | 2. no" for an option row the way a border-only test would.
//
// A LITERAL, NOT BUILT FROM `OPTION_ROW_BORDER` — and that is not an oversight to tidy up later.
// `src-tauri/src/nudge_gate.rs` PORTS this regex into Rust and pins it BYTE-FOR-BYTE, so that the
// half of the app which actually presses a key can never disagree with the half that classifies the
// screen. Composing it from a template made the port's needle unpinnable and turned that guard red
// (`ported_typescript_patterns_have_not_drifted`). Sharing the STRING would buy a guarantee this
// file cannot keep anyway, since the Rust copy is a separate transcription either way.
//
// What keeps the two in step instead is a TEST — `heuristics.test.ts`'s "the option-row guards
// agree" — which drives one boxed cursored row through this pattern, `RENDERED_OPTION_ROW` and the
// parser, and fails if any of them stops seeing it. So: change this class, and port the change into
// `nudge_gate.rs` as its own comment instructs.
export const SELECTION_CURSOR = /^\s*[│|┃]?\s*[❯›]\s*\d+\.\s/m;

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
  "enter to (?:select|confirm|submit)\\b.*(?:navigate|cancel)|\\besc to cancel\\b.*\\bctrl\\+e to explain\\b";
// The same pairs, but WHOLE-LINE. Used only when testing a two-line JOIN — see `pickerFooterSpan`.
const FOOTER_LEGACY_WHOLE_LINE =
  `^(?![^\\n\\r]*\\bto interrupt\\b)[ \\t]*[│|┃]?[ \\t]*(?:${FOOTER_LEGACY})[ \\t]*[│|┃]?[ \\t\\r]*$`;
export const PICKER_FOOTER = new RegExp(`${FOOTER_LEGACY}|${FOOTER_BAR}`, "im");

// ── A FOOTER SPLIT ACROSS TWO LINES (bead sparkle-99o9a) ──────────────────────────────────────
// `PICKER_FOOTER` is anchored to ONE rendered line, and the footer is 59 characters. In a narrow
// agent column it does not fit, and the split arrives here by EITHER of two routes:
//
//   • the TERMINAL wrapped it — handled upstream now, because `engine/rejoinWrapped` puts the row
//     run back together before any matcher sees it;
//   • INK wrapped it, emitting a real newline of its own. There is no `isWrapped` to consult in
//     that case, so the reader cannot help and the matcher has to.
//
// The two are indistinguishable from the rendered text — at 35 columns the break falls exactly at
// the width AND at a word boundary — so this covers the second rather than guessing between them.
//
// ══ THE JOIN IS TESTED AGAINST THE ANCHORED ARM ONLY (roborev 61827) ═══════════════════════════
// The first cut tested the join against the whole of `PICKER_FOOTER`, and that was unsafe in a way
// worth recording. `FOOTER_LEGACY` is an UNANCHORED substring match, so a join can manufacture a
// match neither line had, out of ordinary prose:
//
//   "Press Enter to select the model, then hit Esc to" + "cancel out of the dialog."
//
// Neither line matches (line 1's `.*` finds no `navigate|cancel`; line 2 has no `enter to select`).
// The JOIN matches `FOOTER_LEGACY`. `parsePickerOptionsWithBounds` would then treat a prose line as
// a footer and walk up for a 1…N run, and a numbered list in the agent's own output above it yields
// a FABRICATED picker — which feeds `pickerBlockBounds` → `pickerFingerprint` → the
// `verifiedPickerPress` exemption. That is the roborev 55245/55258 failure class exactly.
//
// So the join is tested against `FOOTER_BAR`, which is whole-line-anchored and requires every
// segment to be a key hint. The legacy arm keeps matching a whole line and is never joined: it
// exists for pre-2.1.220 builds, whose footers are single-line, so there is nothing to widen it for.
//
// ANCHORING, NOT ARM-DROPPING, IS WHAT MAKES THE JOIN SAFE. The obvious repair — test the join
// against `FOOTER_BAR` alone — was tried and is WRONG, in a way only a test caught: the real
// 2.1.220 footer does not match `FOOTER_BAR` at all. "Tab/Arrow keys to navigate" is not a key
// hint by that grammar ("Arrow" and "keys" are not key atoms), so the live AskUserQuestion footer
// matches ONLY through the legacy arm. Dropping that arm from the join would have left the feature
// matching nothing while every negative test passed.
//
// So the join is tested against the bar OR a WHOLE-LINE legacy footer. Anchoring is what removes
// the hazard: the prose above starts with "Press", so it can never satisfy `^…enter to select`.
const FOOTER_JOINED = new RegExp(`${FOOTER_BAR}|${FOOTER_LEGACY_WHOLE_LINE}`, "im");
// THERE IS NO "DOES IT LOOK UNFINISHED?" PREFILTER, and that is deliberate (roborev 61836). A
// `\bto\s*$` test was tried twice and is wrong in BOTH directions: it rejects real footers (the
// 2.1.220 bar wraps after "navigate", "navigate ·", "· Esc" and "Esc to" depending on width) while
// still admitting prose that merely ends in "to". `FOOTER_JOINED` is fully anchored, so it is the
// guard on its own and a prefilter can only subtract correctness.

/**
 * How many lines the picker footer starting at `lines[i]` occupies — 0 when there is none.
 *
 * THE SPAN, NOT A BOOLEAN, because a caller that finds a footer usually needs to know where it ENDS
 * (roborev 61827): `screenAnswerable` asks whether anything unrecognised sits BELOW the footer, and
 * given only the first of two lines it sees the footer's own continuation down there and calls the
 * screen unanswerable — denying the one-tap Approve relay for exactly the narrow-pane picker this
 * work exists to fix.
 */
export function pickerFooterSpan(lines: readonly string[], i: number): 0 | 1 | 2 {
  const line = lines[i] ?? "";
  const next = lines[i + 1];
  // ══ THE JOIN IS TRIED FIRST, EVEN WHEN THE LINE MATCHES ALONE (roborev 61836) ═════════════════
  // A self-match cannot be taken as "the footer ends here", because `FOOTER_LEGACY` is a SUBSTRING
  // match: a PREFIX of the real 2.1.220 bar satisfies it the moment it reaches "navigate". Measured
  // over the bar's word-wrap points, every Ink width from 44 to 58 produces a first row that
  // self-matches ("…keys to navigate", "…navigate ·", "…navigate · Esc", "…navigate · Esc to"),
  // stranding "· Esc to cancel" / "Esc to cancel" / "to cancel" / "cancel" BELOW `footerLast`.
  // Those leftovers are not blank, not a border and not ambient chrome, so
  // `nothingUnrecognizedBelowFooter` reads them as fresh output and denies the one-tap Approve
  // relay — the precise symptom `footerLast` was added to fix, still broken for 15 of the 29 widths
  // where the bar wraps at all. Returning 1 early was therefore only correct for widths 34-42.
  //
  // The `next` guard is what stops a join swallowing a line that stands on its own: if the line
  // below is ITSELF a whole footer, these are two footers, not one wrapped one.
  if (next !== undefined && !PICKER_FOOTER.test(next)) {
    // Ink consumed a space when it wrapped, so the join restores one. Anchored forms only.
    if (FOOTER_JOINED.test(`${line.trimEnd()} ${next.trimStart()}`)) return 2;
  }
  return PICKER_FOOTER.test(line) ? 1 : 0;
}

/** Does a picker footer START at `lines[i]` — either whole, or split onto the line below it? */
export function pickerFooterAt(lines: readonly string[], i: number): boolean {
  return pickerFooterSpan(lines, i) > 0;
}

/** Does any line of `text` start a picker footer? The multi-line twin of {@link pickerFooterAt}, so
 *  `screenAwaitsInput` and the option detector cannot disagree about what marks a picker — the
 *  desync `heuristics.ts`'s import comment says must never happen (roborev 61827). */
export function textHasPickerFooter(text: string): boolean {
  const lines = text.split("\n");
  return lines.some((_, i) => pickerFooterSpan(lines, i) > 0);
}

// Classic shell / CLI prompts. These don't appear in Claude's PROSE, so they're safe to
// match anywhere in a line. The `/i` flag case-folds, so one delimiter-agnostic
// pattern covers `(y/n)`, `[Y/n]`, `[y/N]` etc. (It also matches mismatched delimiters
// like `(y/n]` — harmless: such strings never occur in prose and are still prompt-like.)
const YES_NO_INLINE = /[([]y\/n[)\]]/i;
const PRESS_ENTER = /press enter to continue/i;
const OVERWRITE = /\boverwrite\?/i;

export const SHELL_PROMPTS: RegExp[] = [
  YES_NO_INLINE,
  PRESS_ENTER,
  OVERWRITE,
  /(^|\s)password:\s*$/im,
  /enter passphrase/i,
];

/**
 * The SHELL_PROMPTS arms a pane can merely DISPLAY rather than be blocked by — so a caller scanning
 * a WHOLE SNAPSHOT (rather than a line, or the live tail) must bound these to the region where
 * "the screen is waiting" actually means something.
 *
 * ══ WHY THE LIST IS EXPORTED RATHER THAN RE-DERIVED (roborev 63208) ══════════════════════════════
 * `voice/dictationTerminalRoute.screenBlocksWrite` scanned all five whole-snapshot and re-opened the
 * over-block that roborev 58540 / 58562 / 58575 removed three separate times: a `--help`, a README,
 * or a `git show` of the source file that mentions `(y/n)` refused every write to that agent, with
 * no override, until it scrolled off. That gate also serves `services/conciergeDispatch` for every
 * screen where Claude Code holds the alternate buffer — the most common state in the product.
 *
 * The complement (`password:`, `enter passphrase`) deliberately stays whole-snapshot everywhere: a
 * pane does not incidentally display a password line the way it displays documentation, and a miss
 * there types a spoken sentence into a concealed field. Membership is by IDENTITY, so an arm added
 * to SHELL_PROMPTS without being listed here defaults to the blocking side.
 */
export const DISPLAY_AMBIGUOUS_SHELL_PROMPTS: readonly RegExp[] = [
  YES_NO_INLINE,
  PRESS_ENTER,
  OVERWRITE,
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
  return nothingUnrecognizedBelowFooter(lines, footerAt);
}

/**
 * Rule 2b, EXTRACTED so there is one implementation rather than a copy per caller.
 *
 * True when everything below `footerIdx` is recognized as belonging to a still-open dialog: blanks
 * (unbounded), up to {@link MAX_CHROME_BELOW_FOOTER} {@link AMBIENT_CHROME_LINE} rows, and exactly
 * ONE closing border — the bordered dialog's own bottom edge. An OPENING border is never free: a
 * new frame starting below is positive evidence this footer belongs to an earlier one.
 *
 * Extracted for `engine/screenAnswerable`, which asks the same question ("is this footer the bottom
 * of a LIVE dialog, or one the human already answered?") and shipped a partial copy that omitted the
 * closing-border allowance — so it rejected a bordered dialog whose box closes beneath its footer,
 * i.e. it was STRICTER than this rule while claiming to mirror it, and it silently drifted from the
 * `nudge_gate.rs` twin these bytes are pinned to (roborev 59690).
 *
 * `lines` may be split with or without empty entries: blanks are skipped either way.
 *
 * DELIBERATELY NOT PARAMETERIZED. A caller wanting a narrower vocabulary composes an extra
 * predicate beside this one rather than passing one in — see `screenAnswerable`. Threading an
 * `isChrome` callback through here was tried and reverted: it rewrote the very line
 * `nudge_gate.rs::ported_typescript_patterns_have_not_drifted` pins byte-for-byte, and that guard is
 * the only thing keeping the Rust twin honest. Composition gets the same semantics and leaves the
 * ported rule untouched, so the guard keeps working for the reason it exists.
 */
export function nothingUnrecognizedBelowFooter(
  lines: readonly string[],
  footerIdx: number,
): boolean {
  let chromeBelow = 0;
  let closingBorderBudget = 1;
  for (let i = footerIdx + 1; i < lines.length; i++) {
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

/** How far from the bottom a cursor / shell prompt must sit to count as LIVE rather than as
 *  scrollback. Owned here so `screenAnswerable` and this module cannot drift on what "live" means —
 *  it imports this rather than keeping a second copy (the direction is forced: screenAnswerable
 *  already depends on this module, so the constant cannot live there without a cycle). */
export const LIVE_TAIL_LINES = 12;

/** The last `n` NON-EMPTY rendered lines — the unit both bottom-anchored predicates reason in. */
export function tailContent(snapshot: string, n: number): string[] {
  return snapshot
    .replace(/\r/g, "\n")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .slice(-n);
}

/**
 * True when the rendered screen shows the agent blocked on a specific answer from the
 * user (a Claude selection menu or a shell prompt). False for a finished turn at the idle
 * input box, conversational prose, or an empty screen.
 *
 * ══ AWAITING IS A CLAIM ABOUT THE BOTTOM OF THE GRID, NOT ABOUT ANYWHERE ON IT ═══════════════════
 *
 * All three arms were once WHOLE-SNAPSHOT scans, and that is what made `waiting` — the RED "Needs
 * you" band — fire on agents that were plainly working. Measured 2026-08-12 on a live fleet: 31 of
 * 80 rows red, at most 4 addressed to a human, and 27 of them `waiting` while their own activity
 * line read "Fast-forwarding my parked branch to origin/main" or "Running claude doctor health
 * check". Any viewport that merely CONTAINED prompt-shaped text was red — a dialog the agent had
 * already answered and scrolled past, a `(y/n)` inside a file it read or a diff it printed, its own
 * prose quoting a menu. The founder: *"Why are all these agents showing as red when they're not
 * blocked by me? As a human."*
 *
 * `engine/screenAnswerable` had ALREADY learned this exact lesson for the `approval` band — "any
 * `❯ 1. …` anywhere on the grid … satisfied them" (roborev 58159) — and bottom-anchored its arms.
 * The band next door never got the same treatment, and it is the one painting the 27 rows. This is
 * that fix, not a new policy: the taxonomy (`bandOfStatus`, tokens.ts, stallEscalation) is
 * unchanged and deliberately so.
 *
 * ⚠️ THE FIX IS STRUCTURAL, NOT A LINE BUDGET, and `screenAnswerable` records why: on a real grid
 * the /model picker's cursor sits 13 non-empty lines from the bottom, so a naive tail window
 * REJECTS a live, fully-visible dialog. Hence arm 1 asks whether the footer is still LIVE — is
 * there nothing unrecognized below it — with the bottom-anchored arms as fallbacks for a menu whose
 * footer could not be found. Every captured live dialog still classifies TRUE, with and without the
 * five persistent chrome rows that render beneath one; that is pinned by test.
 *
 * ⚠️ THE OPPOSITE FAILURE IS STILL THE MORE EXPENSIVE ONE. An unrecognized prompt is a blocked
 * agent nobody is told about, which this file has always called strictly worse than a false red.
 * Nothing here weakens that: this narrows WHERE a prompt is looked for, never WHICH prompts count,
 * and the ingest() path is unaffected because it feeds one freshly-streamed line at a time — a
 * single line is its own tail.
 */
export function screenAwaitsInput(snapshot: string): boolean {
  if (!snapshot.trim()) return false;

  // ARM 1 — A PICKER FOOTER THAT IS STILL LIVE. Structural, never budgeted (see above). The
  // discriminator is WHAT is below the footer, not HOW MUCH: persistent chrome means the dialog is
  // still up, genuine new agent output means it has been answered. Same rule, same function, as
  // `screenOffersAnswer` arm 1 and `isSessionLimitPicker`.
  //
  // ⚠️ EVALUATED PER `\r`-FRAME, AND THAT IS NOT COSMETIC (roborev 63126). A rendered viewport has
  // no `\r`, so for `settle()` this loop runs once and behaves exactly as a whole-snapshot walk.
  // But `statusEngine.ts:1042` feeds `this.partial` — the unterminated in-place-redraw tail whose
  // shape is `frame\rframe\rframe`, up to MAX_PARTIAL = 4096 chars. Flattening `\r` to `\n` there
  // turns every LATER redraw frame into "a line below the footer", and `AMBIENT_CHROME_LINE`
  // recognizes only ✻ ✽ ✢ of the spinner glyph set — so one `· Thinking… (12s)` frame, or nine ✻
  // ones (MAX_CHROME_BELOW_FOOTER = 8), made arm 1 false. Arms 2 and 3 cannot backstop a footer
  // frame (no cursor, no shell prompt), so a genuinely BLOCKED agent read gray until the next
  // settle — the false-calm this file calls strictly worse than a false red. A frame is the unit a
  // liveness question is even meaningful in: "what is below the footer" means below it *on the
  // screen as drawn*, not below it in a concatenation of successive redraws.
  for (const frame of snapshot.split("\r")) {
    const lines = frame.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const span = pickerFooterSpan(lines, i);
      // `i + span - 1` is footerLast: a footer that wrapped onto a second line must not have its own
      // continuation counted as unrecognised content below it (roborev 61827).
      if (span > 0 && nothingUnrecognizedBelowFooter(lines, i + span - 1)) return true;
    }
  }

  const tail = tailContent(snapshot, LIVE_TAIL_LINES);
  // ARM 2 — a cursored option row near the bottom, for a live menu whose footer we could not match.
  if (tail.some(isCursoredOptionRow)) return true;
  // ARM 3 — a bare shell prompt near the bottom. Per line, so prose or a file's contents scrolled up
  // the grid ("Overwrite existing file? (y/n)" inside a diff) cannot arm the band.
  return tail.some(isShellPrompt);
}

// Arms 2 and 3 are NAMED PREDICATES rather than inline arrow bodies so each is independently
// mutable: `mutation-check --line` could not judge them inline (no comparison to invert, and
// commenting out an `if`/`return` broke parsing), which meant neither arm could be honestly
// claimed as covered. Both are now pinned per-site.
function isCursoredOptionRow(line: string): boolean {
  return SELECTION_CURSOR.test(line);
}

// `.filter(…).length > 0` rather than `.some(…)`: the nested arrow left no top-level expression for
// `mutation-check --line` to mutate, so this arm could not be judged at all. The comparison gives it
// one. Same meaning, and the arm is now pinned per-site like the other two.
function isShellPrompt(line: string): boolean {
  return SHELL_PROMPTS.filter((re) => re.test(line)).length > 0;
}

// ── THE GRACEFUL-EXIT RESUME BANNER (sparkle-tab3nm) ──────────────────────────────────────────────
//
// When Claude Code exits on its own it leaves its recovery affordance on the grid — the founder's P0
// screenshot: a "Terminal stopped" footer over `Resume this session with: claude --resume <id>`. The
// bead names this exact string as the signal: "The app already prints the exact recovery command on
// screen — that string is a reliable detector." It is the discriminator between a CLEAN, resumable
// stop (Claude wrote its own resume line before exiting) and a silent crash or kill (a segfault or
// `pty_kill` prints no such line), and that distinction is what makes fast auto-resume safe for the
// former while the latter stays on the conservative `unknown` slow rung — see
// `engine/resurrection.armsOnSlowestRung` and its `cleanResumableStop` input.
//
// BOTTOM-ANCHORED, exactly like `isSessionLimitPicker` and for the same reason its header gives: an
// agent that merely MENTIONED `claude --resume` mid-turn (this repo's own code, a doc, a shell
// history line) prints past it, so the banner is not in the live tail. Scrollback has no bottom.
//
// This is the SCREEN-TEXT half only. The liveness half — "and the PTY has actually exited" — is
// applied by the one caller (`StatusEngine.showsResumeBanner`, gated on `exited`), so a live agent
// that renders the string at the bottom for an instant is never read as stopped. Keeping the text
// matcher pure and the liveness gate at the caller mirrors how `screenAwaitsInput` is paired with
// the settle/exit state that decides what to do with it.

// `claude --resume <session-id>`, the command the founder is told to run. The id is a Claude session
// uuid; matched loosely (>= 8 id-ish chars) so a build/font-driven glyph drift in the id cannot drop
// the match. Case-folded because a copy of the line can be lower/upper-cased by the terminal font.
const RESUME_COMMAND = /\bclaude\s+--resume\s+[0-9A-Za-z][0-9A-Za-z-]{7,}/i;
// The header Claude prints directly above it. A second, independent witness: if a future Claude build
// wraps or reflows the command line, the header still anchors the state.
const RESUME_HEADER = /\bresume this session with\b/i;

/**
 * True when the rendered viewport carries Claude Code's graceful-exit resume affordance in its live
 * tail — `claude --resume <id>` (or the "Resume this session with" header above it). Pure and
 * bottom-anchored; see the header block. The caller supplies the liveness gate.
 */
export function isStoppedResumeBanner(snapshot: string): boolean {
  if (!snapshot.trim()) return false;
  const tail = tailContent(snapshot, LIVE_TAIL_LINES);
  return tail.some((l) => RESUME_COMMAND.test(l) || RESUME_HEADER.test(l));
}
