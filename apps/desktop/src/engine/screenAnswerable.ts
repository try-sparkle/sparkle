// IS THERE ANYTHING TO PRESS? — the predicate that gates the `approval` status band.
//
// `approval` renders as "Approve?" and offers a one-tap relay. `screenAwaitsInput` cannot support
// that claim on its own: it is true on the `❯` cursor, the picker FOOTER ALONE, or a bare shell
// prompt, and only some of those imply an affordance. A footer whose option block has scrolled away
// satisfies it while there is provably nothing to press — the founder's screen.
//
// WHY THIS IS ITS OWN MODULE. It needs the REAL option parser (`services/suggestions/heuristics`),
// and heuristics imports `PICKER_FOOTER` from `screenClassifier` — so putting it in screenClassifier
// would be an import cycle. Here, both are plain dependencies: screenAnswerable → {screenClassifier,
// heuristics} → screenClassifier. That is also what lets it reuse ONE definition of "these rows are
// a menu" instead of writing a second walk, which is the mistake the first draft made: it `break`ed
// on the first non-option line where `parsePickerOptions` `continue`s, so real menus with
// description rows or a `───` separator between their options (AskUserQuestion, /model) counted as
// zero rows and survived only via the cursor short-circuit — the one fallback this family says
// cannot be relied on, since PICKER_FOOTER exists precisely for when the cursor glyph drifts.
import { SELECTION_CURSOR, SHELL_PROMPTS } from "./screenClassifier";
import {
  RENDERED_OPTION_ROW,
  pickerBlockBounds,
  pickerWindow,
} from "../services/suggestions/heuristics";

// How far from the bottom a cursor/shell prompt must sit to count as LIVE. Both arms below were
// once whole-snapshot scans, which short-circuited past every bit of anchoring: any `❯ 1. …`
// anywhere on the grid — the agent's own prose quoting a menu, an already-answered dialog still
// visible, a typed line — satisfied them. `isSessionLimitPicker` learned this exact lesson and now
// tests per option row (roborev 58159); re-adopting the rejected form re-opened the hole.
const LIVE_TAIL_LINES = 12;

function tailContent(snapshot: string, n: number): string[] {
  return snapshot
    .replace(/\r/g, "\n")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .slice(-n);
}

/**
 * True when the screen offers the human a keystroke that answers it.
 *
 * Three arms, in order of how much they prove:
 *
 * 1. A PARSED OPTION BLOCK that is genuinely this footer's. The parser is deliberately permissive —
 *    it skips interleaved lines so long as the numbers count down to 1 — which is right for its own
 *    job but wrong here: it happily accepts the agent's markdown plan ("1. Read the file / 2. Patch
 *    it") sitting above a stranded footer. So the parsed run must ALSO either carry the selection
 *    cursor or sit IMMEDIATELY above its footer. A real dialog does one or the other; a prose list
 *    separated from the footer by other output does neither.
 * 2. A CURSORED OPTION ROW near the bottom — for a live menu whose footer the parser could not find.
 * 3. A SHELL PROMPT near the bottom (`(y/n)`, "press enter to continue", a password ask). No menu
 *    and never will be, but answerable by typing — and it is exactly what follows a destructive
 *    command, so demoting it would strip the one-tap relay from the riskiest prompts there are.
 */
export function screenOffersAnswer(snapshot: string): boolean {
  if (!snapshot.trim()) return false;

  // ARM 1 — the canonical parser, plus the two checks it does not make: that the block belongs to
  // this footer, and that the whole thing is still LIVE.
  const bounds = pickerBlockBounds(snapshot);
  if (bounds) {
    const lines = pickerWindow(snapshot);
    const block = lines.slice(bounds.first, bounds.footer);
    const cursored = block.some((l) => SELECTION_CURSOR.test(l));
    // "Immediately above" in NON-EMPTY line terms, which is the unit the parser's own bounds use.
    const abutsFooter = RENDERED_OPTION_ROW.test(lines[bounds.footer - 1] ?? "");
    // LIVE, not merely present. `pickerBlockBounds` searches the last 50 non-empty lines, so a
    // dialog the human ALREADY ANSWERED still satisfies it while output keeps streaming below —
    // which is the same "already-answered dialog still on the grid" case arms 2 and 3 are anchored
    // against, and arm 1 runs first and is the most permissive. Requiring the footer to sit in the
    // live tail is the same anchor, applied to the same question.
    const footerIsLive = bounds.footer >= lines.length - LIVE_TAIL_LINES;
    if (footerIsLive && (cursored || abutsFooter)) return true;
  }

  const tail = tailContent(snapshot, LIVE_TAIL_LINES);
  // ARM 2 — per line, never against the whole snapshot (see LIVE_TAIL_LINES).
  if (tail.some((l) => SELECTION_CURSOR.test(l))) return true;
  // ARM 3 — likewise bottom-anchored, so prose ("Overwrite? I'd rather not") scrolled up the grid
  // cannot arm the band.
  return tail.some((l) => SHELL_PROMPTS.some((re) => re.test(l)));
}

/** The STREAM form: ingested lines arrive one at a time, so a viewport-style block parse is
 *  unreachable there. Requires the CURSOR shape rather than any numbered row, so an ordinary
 *  markdown list item streaming past cannot arm the approval band. */
export function streamOffersAnswer(text: string): boolean {
  return SELECTION_CURSOR.test(text);
}
