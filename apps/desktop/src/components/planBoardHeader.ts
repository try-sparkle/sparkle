// THE PLAN BOARD HEADER ROW'S HORIZONTAL GAP — declared once, because that row has TWO HOSTS.
//
// `Workspace.tsx`'s `plan-board-header` and `SatelliteApp.tsx`'s copy of it are the same band, and
// BoardFilterBar.tsx's own header already records that a change made in only one of them DRIFTS —
// they had drifted on the inset before, and `Workspace.planBoardSpansPair.test.tsx` /
// `SatelliteApp.test.tsx` exist to pin the halves together. A second hand-typed `16` would be the
// next drift, so the value lives here and both hosts read it.
//
// WHY IT IS A COLUMN GAP AND NOT `gap`. The founder, 2026-08-20: *"Let's have a little bit more
// space between closed planning board and the filter."* That seam is horizontal. The row is
// `flexWrap: "wrap"`, so a plain `gap` would spend the same value on the VERTICAL rhythm when
// BoardFilterBar drops to a second line — widening a gap he did not ask about and that already
// matches the band's 8px `marginBottom`. Splitting the axes buys the ask and nothing else.
export const PLAN_BOARD_HEADER_COLUMN_GAP = 16;

/** The wrapped-row vertical gap, unchanged at the band's own 8px rhythm. */
export const PLAN_BOARD_HEADER_ROW_GAP = 8;
