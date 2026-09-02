// WHICH ROW IS HIGHLIGHTED, AND IS THIS PICKER A MULTI-SELECT — bead sparkle-xkf6yl.
//
// `select_picker_option` answers a menu by writing the option's own keystroke ("2\r"). On a
// SINGLE-SELECT numbered picker the digit is what does the work: it jumps to that option and the
// carriage return commits it. On a MULTI-SELECT CHECKBOX picker the digit is INERT and the carriage
// return TOGGLES THE HIGHLIGHTED ROW — so the index the caller asked for was thrown away and some
// other row flipped, while the op reported the requested option's label back as if it had been
// chosen. Measured twice in the field; the transcript is in the bead and in
// `terminal.multiSelectPicker.test.ts`'s header, which is also the spec for that suite's fake.
//
// The remedy needs two facts the option list alone does not carry: whether this is that shape, and
// WHERE THE HIGHLIGHT IS, so the cursor can be walked to the requested row before the press. Both
// are read here.
//
// ══ BUILT FROM THE SHARED ROW GUARDS, NEVER FROM A PRIVATE COPY ═══════════════════════════════
// `SELECTION_CURSOR` and `RENDERED_OPTION_ROW` are the two patterns this repo already keeps in step
// (heuristics.ts's "the option-row guards agree" test, and the Rust port pinned in
// `nudge_gate.rs`). A third hand-rolled "cursored option row" regex here is exactly the drift that
// produced sparkle-67xxw / sparkle-xgd1k — two guards over one row disagreeing about what a border
// is — so this module composes theirs and adds no row shape of its own. The only new pattern is the
// CHECKBOX, which neither of them describes.
import { SELECTION_CURSOR } from "../../engine/screenClassifier";
import { RENDERED_OPTION_ROW, pickerBlockBounds, pickerWindow } from "../suggestions/heuristics";
import { ANSI } from "../promptTextNormalize";

/** A rendered checkbox at the head of an option's label: `[ ]`, `[x]`, `[✓]`. */
const CHECKBOX = /^\[[ xX✓✔]?\][ \t]/;
/** `detectClaudeCodePicker` renders each option as `N · label`; the checkbox follows that prefix. */
const OPTION_NUMBER_PREFIX = /^\d{1,2}[ \t]*[·.)][ \t]*/;

/**
 * Is this menu a multi-select checkbox list — the shape where a digit is inert and the press
 * toggles whatever row is highlighted?
 *
 * READ OFF THE LABELS THE TOOL ALREADY REPORTS, deliberately. `read_picker_options` hands the model
 * `1 · [ ] Local files`, so the checkbox is information the CALLER can already see; deciding on the
 * same material means the tool and the model cannot disagree about which shape they are looking at.
 *
 * EVERY option must carry one, and there must be at least two. One row with a bracketed label in a
 * single-select menu is ordinary prose ("1. [draft] Ship it"); a whole column of them is a widget.
 */
export function isMultiSelectPicker(options: readonly { label: string }[]): boolean {
  if (options.length < 2) return false;
  return options.every((o) => CHECKBOX.test(o.label.replace(OPTION_NUMBER_PREFIX, "")));
}

/**
 * The zero-based index of the option row carrying the selection cursor, or `null` when no row in
 * the parsed block does.
 *
 * ══ SEARCHED INSIDE THE PARSER'S OWN BOUNDS, NEVER OVER THE WHOLE SCROLLBACK (roborev 74100) ═══
 * `pickerBlockBounds` returns the exact indices the parse that produced the option list used, and
 * `pickerWindow` returns the exact array those index into — so this asks the parser where the menu
 * is rather than re-deriving it, which is the rule `pickerFingerprint` and `PickerBounds` exist to
 * enforce and the same bound roborev 63244 required of `cursorAnchoredRunEnd`.
 *
 * A free scan is not merely unbounded, it is WRONG IN A SPECIFIC WAY: a Claude Code pane routinely
 * carries earlier, already-answered `❯ 1. Yes …` dialogs above the live one, so when the live menu's
 * own highlight cannot be read the walk keeps going and returns a row number belonging to a
 * different question. That turns the `cursor-unknown` refusal — which is the whole safety property
 * here — into something effectively unreachable, and computes the arrow walk from a stale row.
 *
 * ══ AND IT FAILS CLOSED ON THE WIDER CURSOR CLASS, DELIBERATELY ═══════════════════════════════
 * The parse accepts a bare `>` as a cursor (`OPTION_CURSOR`) where `SELECTION_CURSOR` does not, so a
 * dialog drawn that way parses as a menu whose highlight this cannot see. The answer is `null` —
 * i.e. the caller REFUSES — not a guess, and not a fourth private "cursored option row" pattern
 * here, which is the guards-disagree drift `SELECTION_CURSOR`'s own declaration records. Refusing a
 * shape we cannot read is the documented safe outcome; navigating from a row we are unsure of is
 * the defect.
 *
 * NULL IS NOT "ROW 0". A caller that defaulted a missing highlight to the top row would press blind
 * on exactly the screens this cannot read.
 *
 * The LAST cursored row inside the block wins, matching the parser's own "the last footer wins".
 */
export function highlightedOptionIndex(scrollback: string): number | null {
  const clean = scrollback.replace(ANSI, "");
  const bounds = pickerBlockBounds(clean);
  if (!bounds) return null;
  const lines = pickerWindow(clean);
  // `[bounds.first, bounds.footer)` — the option rows the parse collected, and nothing above or
  // below them. `footer` is the block's exclusive end on both the real-footer and the
  // cursor-anchored paths.
  for (let i = Math.min(bounds.footer, lines.length) - 1; i >= bounds.first; i--) {
    const line = lines[i] ?? "";
    if (!SELECTION_CURSOR.test(line)) continue;
    // The NUMBER comes from `RENDERED_OPTION_ROW`'s own capture rather than from a second regex, so
    // "is this an option row" and "which option is it" can never answer about different rows.
    const n = Number.parseInt(line.match(RENDERED_OPTION_ROW)?.[1] ?? "", 10);
    if (Number.isInteger(n) && n >= 1) return n - 1;
  }
  return null;
}
