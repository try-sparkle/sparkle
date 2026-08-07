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
import {
  SELECTION_CURSOR,
  SHELL_PROMPTS,
  nothingUnrecognizedBelowFooter,
} from "./screenClassifier";
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

// A NOTE ON WHAT THIS DELIBERATELY DOES NOT DO — an accepted residual, not an oversight.
//
// `AMBIENT_CHROME_LINE`'s status-glyph alternative is UNANCHORED, so it recognizes any prose behind
// a glyph. Below a footer that admits a resumed turn's own output (the fixture's IDLE_AFTER_TURN
// carries "\u273b Churned for 3s" as TURN OUTPUT), which keeps arm 1 alive on a dialog the human
// already answered. roborev 59690 flagged that, and rejecting the glyph class was tried — and
// REVERTED, because it costs strictly more than it buys:
//
//   Claude's live grid ENDS in five chrome rows, two of which are status bars ("\u26a0 Transcript
//   saving is off", "\u23f8 manual mode on \u00b7 ? for shortcuts" — verbatim in
//   capturedScreens.fixture.ts). Rejecting the class makes arm 1 false for a LIVE, fully-visible,
//   pressable dialog, and arm 2 cannot backstop it: on a real grid the /model picker's cursor sits
//   13 non-empty lines from the bottom, outside LIVE_TAIL_LINES. The result is a live menu that
//   loses its one-tap Approve relay — the SAME false negative the line-budget version caused, which
//   is what this module was fixing (roborev 59920).
//
// So the trade is deliberate: the residual costs a stale `approval` on an already-answered dialog
// that is still fully on screen; the alternative costs the relay on a live one. The founder's actual
// dead end — a footer with NO option block — is unaffected either way, since `pickerBlockBounds`
// finds nothing to parse there. Fixing the residual properly means separating a persistent status
// BAR from turn prose by shape, which belongs in AMBIENT_CHROME_LINE and its Rust twin, not in a
// call-site denylist. Tracked in sparkle-7js2c.

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
    // LIVE, not merely present — but anchored STRUCTURALLY, never by a line budget.
    //
    // `pickerBlockBounds` searches the last 50 non-empty lines, so a dialog the human ALREADY
    // ANSWERED still satisfies it while output streams below. A bottom-anchor is the wrong way to
    // exclude that, and it was tried and reverted: Ink KEEPS RENDERING BELOW A LIVE DIALOG — "the
    // footer is never the last line" (heuristics.ts:63-67, capturedScreens.fixture.ts:154-158),
    // which is precisely why the parser was given PICKER_WINDOW/PICKER_SPAN rather than a bottom
    // anchor. A fixed budget therefore rejects live, fully-visible, pressable dialogs, and arms 2
    // and 3 cannot rescue them (the cursor sits ABOVE the footer, so it is further from the bottom
    // still). That loses the one-tap Approve relay on a real menu and re-creates the very
    // two-detectors-disagree bug this module exists to close.
    //
    // The discriminator is WHAT is below the footer, not HOW MUCH: persistent chrome and a task
    // checklist mean the dialog is still up; genuine new agent output means it has been answered.
    // That is exactly `isSessionLimitPicker`'s rule, so this calls THE SAME FUNCTION rather than a
    // copy. A first version copied only the constants and re-wrote the loop, which read as reuse but
    // was a second implementation — and it drifted immediately, omitting the one-closing-border
    // allowance and so REJECTING a bordered dialog whose box closes beneath its footer (roborev
    // 59690). Sharing constants while rewriting the walk is not sharing the rule.
    if (
      nothingUnrecognizedBelowFooter(lines, bounds.footer) &&
      (cursored || abutsFooter)
    )
      return true;
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
