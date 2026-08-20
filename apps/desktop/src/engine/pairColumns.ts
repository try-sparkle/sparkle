// WHICH COLUMN A PROJECT TAB SITS ABOVE — the geometry behind "shade the tab by where it sits".
//
// ── THE RULE, AND WHY IT NEEDS GEOMETRY AT ALL ─────────────────────────────────────────────────
//
// *"So you need to be aware of where the tab sits and shade it the correct color based on where it
// sits."* — the founder, on an active tab that read a visibly different colour from the build
// column directly beneath it, in BOTH themes.
//
// A pair is `[build, terminal]` under ONE tab strip (`Pair`, Workspace.tsx), and the strip spans the
// whole pair. So the tabs begin above the BUILD column and, once there are enough of them, run on
// above the TERMINAL — which is why the founder saw the bug on one tab and not on another, and why
// the answer cannot be a constant. The tab's own x position is the input.
//
// It is genuinely both orders, too: the cockpit is `TERM │ BUILD │ EPICS │ CONCIERGE │ EPICS │ BUILD │ TERM`, and
// the left pair mirrors its flow (`flexDirection: row-reverse`), so "build is the left column" is
// false for half the shell. Deciding from CLIENT RECTS rather than from a child index is what makes
// one rule correct on both sides — the same reasoning `ProjectTabs`' own expansion anchor follows.
//
// ── WHY THE TAB READS THE COLUMN'S BACKGROUND INSTEAD OF PICKING A TOKEN ───────────────────────
//
// The bug this replaces was ONE hard-coded token: the active tab's face was `C.forest`, the TERMINAL
// plane, whatever it sat above. Over the terminal that is right by accident; over the build column
// it is a plane too dark (light: tab #d9e3f3 against a #f2f6fd column; dark: #030913 against
// #091426). Swapping one constant for a two-way `isBuild ? C.deepForest : C.forest` would fix the
// screenshots and re-create the same class of bug the moment either column is restyled or moved.
//
// So the caller resolves an ELEMENT here and then reads that element's own computed background. The
// tab cannot disagree with the column because it is not holding an opinion about the colour.
//
// This module is the pure half — spans in, index out — so the rule is testable without a layout
// engine. The DOM half lives at `ProjectTabs`' `useColumnFill`.

/** The attribute marking an element as one of a pair's COLUMNS — the planes a tab can sit above.
 *
 *  Carried by the build column (`AgentSidebar`) and the terminal stage (`Workspace`). It answers
 *  only WHICH elements are columns; it says nothing about what colour either one is, which is the
 *  whole point (see the header). The pair's Plan board is deliberately NOT marked: it is an
 *  absolutely-positioned overlay across both columns rather than a column, so marking it would make
 *  "the column under this tab" ambiguous exactly when the board is up. */
export const PAIR_COLUMN_ATTR = "data-pair-column";

/** A horizontal extent in client space. Only the x axis matters: every column in a pair shares the
 *  strip's full height, so which one a tab is above is purely a question of left/right. */
export interface Span {
  left: number;
  right: number;
}

/** Is this a real measurement? A zero-width span is an unlaid-out element (first paint, a hidden
 *  pane, every rect in jsdom) — never a column that happens to be very narrow. */
function measured(s: Span): boolean {
  return s.right > s.left;
}

/**
 * The index in `columns` of the column `tab` sits above, or -1 when nothing can be said.
 *
 * MIDPOINT FIRST, WIDEST OVERLAP SECOND. The midpoint is the rule the founder described — a tab is
 * "above" whichever column its middle is over — and it is the one that keeps a tab straddling the
 * seam from flipping colour on a sub-pixel layout change. The overlap fallback covers the midpoint
 * landing in a gap between columns (a resize rail, a border), where there IS a right answer and
 * refusing to give one would drop the tab back to its fallback fill for a frame mid-drag.
 *
 * RETURNS -1 RATHER THAN GUESSING when the tab or every column is unmeasured. The caller's fallback
 * is the pre-existing fill, so failing to resolve leaves the tab exactly as it shipped rather than
 * painting it a colour derived from a rect nobody has laid out — the same fail-open discipline as
 * `tabMinWidth` and the expansion's zero-rect refusal.
 */
export function columnUnder(tab: Span, columns: readonly Span[]): number {
  if (!measured(tab)) return -1;
  const mid = (tab.left + tab.right) / 2;
  let best = -1;
  let bestOverlap = 0;
  for (let i = 0; i < columns.length; i++) {
    const c = columns[i];
    if (!c || !measured(c)) continue;
    // A half-open test, so a tab whose midpoint lands exactly on the seam between two abutting
    // columns resolves to the RIGHT-hand one instead of matching both and taking DOM order.
    if (mid >= c.left && mid < c.right) return i;
    const overlap = Math.min(tab.right, c.right) - Math.max(tab.left, c.left);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = i;
    }
  }
  return best;
}
