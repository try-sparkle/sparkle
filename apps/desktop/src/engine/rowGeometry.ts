// THE SELECTED ROW'S BOX — WHICH END OPENS INTO WHAT, AS A PURE RULE.
//
// The cockpit is `TERM │ BUILD │ EPICS │ CONCIERGE │ EPICS │ BUILD │ TERM`, so a row has TWO ends and which one is
// which flips with the pair:
//
//     left  pair = TERM │ BUILD │ concierge   → the terminal is to the row's LEFT
//     right pair = concierge │ BUILD │ TERM   → the terminal is to the row's RIGHT
//
// Every number below was previously written once, inline, for a right-hand pair — `marginRight`,
// a right-heavy padding, a `10px 0 0 10px` radius and two fillets anchored `right: 0`. That was
// correct while the app had one pair on the right. With the left pair shipped it draws that pair
// BACKWARDS: the row bleeds into the concierge instead of into its own terminal, the leading radius
// sits on the terminal end, and both mouths open away from the pane. Hence one rule, in one place,
// parameterised by the side.
//
// ── THE TWO ENDS ───────────────────────────────────────────────────────────────────────────────
//
//   PANE end — always open. The selected row is always joined to its own terminal; that is prod's
//   behaviour and it does not depend on the cable. The row is painted the terminal's colour and
//   runs into it, so selecting a row already says "this pane is showing that agent."
//
//   JOINT end (the concierge) — open only while THIS pair holds the cable. Patching in extends the
//   same row the opposite way, completing concierge ← row → terminal, and the row reads as a length
//   of cable seated in two sockets (MAPPING.md's wired table: wired = all four corners are mouths).
//   Unplugged, that end is a plain `--r-lead` radius: one end plugged in, one end not.
//
// ── GEOMETRY BELONGS TO EVERY ROW, NEVER ONLY THE SELECTED ONE ─────────────────────────────────
//
// `margin` and `padding` here depend ONLY on the pair's side and on whether the cable is patched —
// both properties of the COLUMN, never of which row is selected. Keying them off selection is the
// list-twitch bug: the row's content box would narrow the instant you clicked it, so the title
// under the pointer jumps and jumps back on the next row. `isActive` may change only what is
// PAINTED (the radius and the fillets), which is exactly MAPPING.md's "Row geometry belongs to
// `.row`, never to `.row.on`".
//
// The compensation is what makes that safe: an end that bleeds by `LIST_PAD_X` pays the same
// `LIST_PAD_X` back in padding, so the INK sits at a constant inset from the column's edge in every
// state — unselected, selected, and wired.

// ONE definition of the side, from the cable — a second `"left" | "right"` here would be a place for
// the two to disagree about what "left" means, which is precisely the confusion this file fixes.
import type { PairSide } from "./cable";
export type { PairSide };

/** The row box's own horizontal padding — the ink's inset from the row's edge. */
export const ROW_PAD_X = 10;

/** The agent list's horizontal padding, and therefore exactly how far a row reaches BACK to touch
 *  the column's edge. Named because the row's margin and its compensating padding both depend on
 *  it and must move together. */
export const LIST_PAD_X = 8;

/** An end that bleeds through the column's edge pays the bleed back in padding, so the ink does not
 *  move. See the compensation note above. */
export const ROW_PAD_COMPENSATED = ROW_PAD_X + LIST_PAD_X;

/** The row box's own vertical padding. Named because the hover card has to reproduce it EXACTLY
 *  (minus its own border) to stand over a row without anything jumping — see the card strip's
 *  padding. */
export const ROW_PAD_Y = 4;

// ── THE ROW ANATOMY, SHARED BY EVERY ROW TYPE ─────────────────────────────────────────────────
// Improve Sparkle is not a project agent — it has no AgentTab, so it cannot go through AgentRow —
// but it IS a row in this column and has to read as one. It used to be styled by hand, and drifted:
// a bigger disc, a different left inset, its own font size, its own progress bar. These constants
// are the contract. AgentSidebar.sparkleRow.test.tsx asserts the two rows agree on every one of
// them by measuring BOTH rows in a rendered sidebar, so a change here that lands in only one of
// the two call sites goes red.
//
// They live HERE, next to `rowBox`, rather than module-private inside AgentSidebar.tsx, because a
// row type in its OWN file cannot honour a rule it cannot import — see components/rowAnatomy.tsx.
//
// Width of the leading disc slot on a build/worker row (a shell row's ▶ takes a narrower one). The
// disc is CENTERED in it, so this — not the padding alone — is what fixes the disc's left edge.
export const DOT_SLOT_W = 24;
/** Diameter of the status disc on a row (StatusDot's own default 9 is for the TopBar cluster). */
export const DOT_SIZE = 12;

/** The leading glyph slot is a fixed height so the glyph AND the title beside it sit at the exact
 *  same spot whether the card is collapsed or expanded — on hover the card only grows DOWNWARD, so
 *  the eye never sees the pickaxe or title jump. Shared so the elapsed timer can match it. */
export const GLYPH_SLOT_H = 20;

/** Depth indent (px) per nesting level. Set so a WORKER's status disc lands exactly where its
 *  parent's TITLE begins: a head row's title starts at padding-left(10) + disc slot(24) + gap(8) =
 *  42px, and a child at marginLeft(32) + its own padding-left(10) puts its disc at that same 42px.
 *  The subtree therefore reads as a hanging indent off the parent's text rather than as a second,
 *  arbitrary column. Changing the disc slot or the row padding means changing this too. */
export const DEPTH_INDENT = 32;

// ── GEOMETRY BELONGS TO EVERY ROW, NEVER ONLY THE SELECTED ONE ─────────────────────────────────
//
// `.row` in the mock carries the pane-side margin; `.row.on` changes only what is PAINTED. The
// version this replaces put `marginRight: isActive ? -8 : 0` on the row, which meant the row's
// CONTENT BOX narrowed by 8px the instant you selected it — so the title under the pointer jumped
// ~10px on click and jumped back on the next row. The founder reported the list twitching every
// time they changed agents; this is that bug, and it is a layout property masquerading as a
// selection style.
//
// The fix is the mock's: every row runs to the seam and every row pays the same padding back, so
// the ink sits at a constant inset from the column's edges in all states. See MAPPING.md,
// "Row geometry belongs to `.row`, never to `.row.on`" — `padding compensates margin one-for-one
// instead of just changing it` is the exact instruction, and it is why `ROW_PAD_COMPENSATED`
// exists rather than the row simply keeping `ROW_PAD_X` on both sides.
//
// Those numbers were written for a right-hand pair and read correctly for years because there was
// only one pair, on the right. See `rowBox`, which decides which END takes them.

// ── THE MOUTH IS 26 × 9, NOT 9 × 9 ─────────────────────────────────────────────────────────────
//
// `--r-delta` (9px) is the fillet's RISE and `--m-run` (26px) is its RUN. It is not a square, and
// the founder rejected the square: a circular 9×9 corner-round is 78% quarter-disc, so it packs the
// whole flare into the last ~4px before the seam. The near-white build column (`deepForest`, the
// spec's `--k-bridge`) therefore ran flush beside the row right up to the pane and stopped in a
// rounded stub — two pale claws pinching the row where it enters the terminal. That is the "white
// lines shouldn't be there when rounded" report: nothing stray, just a corner-round doing what a
// corner-round does.
//
// Stretched to 26 × 9 the same arc leaves the row's edge with a HORIZONTAL tangent (flush with the
// row) and meets the seam with a VERTICAL one (flush with the column boundary), so it is smooth at
// both ends and the bank sweeps out of frame instead of hooking back. Same colours, same anchor,
// same 9px rise — only the run is longer. 26 is `--grid-step`; the mock records that 38 reads melty.
export const ACTIVE_FILLET = 9;
export const ACTIVE_FILLET_RUN = 26;

/** The other side. */
export const oppositeSide = (side: PairSide): PairSide => (side === "left" ? "right" : "left");

export interface RowBoxInput {
  /** Which side of the row its terminal is on — the pair's own side. */
  paneSide: PairSide;
  /** Does THIS pair hold the live cable? Opens the concierge end. */
  jointOpen: boolean;
  /** Is this the selected row? Changes only what is PAINTED. */
  isActive: boolean;
  /** Hierarchy indent for a worker row, in px. Always on the left: the text runs left-to-right in
   *  both pairs, so the indent that expresses nesting does too. */
  depthIndent?: number;
  /** `--r-lead`, the radius on an unplugged concierge end. */
  leadRadius: number;
  /** The radius an unselected row carries on every corner. */
  idleRadius: number;
  /** The row's vertical padding, passed through so the caller has one shorthand to apply. */
  padY: number;
  /** PINNED rows (the Improve Sparkle footer) sit OUTSIDE the padded scroll container, so they
   *  already touch the column's edges: an open end needs no negative margin, and a shut end is held
   *  off by a POSITIVE one. The paint is identical — same corners, same mouths — which is why this
   *  is a flag on one rule rather than a second copy of it. Both baselines land the ink at the same
   *  `ROW_PAD_X + LIST_PAD_X` from the column edge, which is what makes the two rows read as one
   *  anatomy (AgentSidebar.sparkleRow.test.tsx measures exactly that). */
  pinned?: boolean;
}

export interface RowBox {
  /** `padding` shorthand, ready to apply. */
  padding: string;
  /** The horizontal paddings as NUMBERS, because one consumer is not a CSS box: the hover card
   *  stands in for the row at the row's own rect and has to reproduce its content offset exactly,
   *  minus its own border. It used to hard-code `ROW_PAD_X`, which was right only while the row's
   *  left padding was always that — it is `ROW_PAD_COMPENSATED` on any open end now, i.e. for every
   *  row in a left pair and every row in either pair once the cable is patched. Reading the number
   *  from the same rule the row used is what stops the card sliding 8px on open. */
  padLeft: number;
  padRight: number;
  marginLeft: number;
  marginRight: number;
  /** `border-radius`: a shorthand while selected, a single number while idle. */
  borderRadius: string | number;
  /** Which ends carry a concave fillet. Empty unless selected; the pane end always, plus the joint
   *  end while the cable is patched into this pair. */
  filletEnds: PairSide[];
}

/**
 * The row's box for a pair on `paneSide`.
 *
 * Read the result as two independent decisions: the LAYOUT (padding/margin) answers "which edges
 * does this column's row reach through", and the PAINT (radius/fillets) answers "which of those
 * ends is drawn as an opening". Only the second one knows about selection.
 */
export function rowBox({
  paneSide,
  jointOpen,
  isActive,
  depthIndent = 0,
  leadRadius,
  idleRadius,
  padY,
  pinned = false,
}: RowBoxInput): RowBox {
  const jointSide = oppositeSide(paneSide);

  // LAYOUT — selection-independent, by construction. An END is either OPEN (it reaches the column's
  // edge and pays the reach back in padding) or SHUT (it is held off by the list's own inset). The
  // pane end is always open; the joint end opens when the cable is patched into this pair.
  const openMargin = pinned ? 0 : -LIST_PAD_X;
  const shutMargin = pinned ? LIST_PAD_X : 0;
  const marginFor = (open: boolean) => (open ? openMargin : shutMargin);
  const padFor = (open: boolean) => (open ? ROW_PAD_COMPENSATED : ROW_PAD_X);

  const leftOpen = paneSide === "left" || jointOpen;
  const rightOpen = paneSide === "right" || jointOpen;

  // THE INDENT MUST NOT CANCEL A BLEED, and it did. It used to be added to `marginLeft`
  // unconditionally — the same margin that carries the open/shut decision — so on a left end that
  // is OPEN it ate the bleed and then some: a depth-1 worker in a LEFT pair got `-8 + 32 = 24`,
  // positive, so the selected worker row stopped reaching its terminal at all and its concave
  // mouths (absolutely positioned at the row's edge) hung in mid-air, opening onto the column
  // instead of onto the pane. The right pair hit the identical thing the moment the cable was
  // patched, since `jointOpen` opens its left end too — and because the indent lands on the SHUT
  // side in the right pair unwired, the one configuration that used to exist looked correct.
  //
  // So: an OPEN end pays the indent in PADDING (the box still reaches the column's edge, the
  // content moves in), a SHUT end pays it in MARGIN as before. Either way the end that is open
  // reaches the edge regardless of depth, which is the invariant — not the arithmetic.
  const padLeft = padFor(leftOpen) + (leftOpen ? depthIndent : 0);
  const padRight = padFor(rightOpen);
  const marginLeft = marginFor(leftOpen) + (leftOpen ? 0 : depthIndent);
  const marginRight = marginFor(rightOpen);

  // PAINT — the pane end is NEVER a radius (a radius necks the row down as it reaches the pane,
  // which is the opposite operation); the joint end is a radius until the cable opens it.
  // Zeros stay UNITLESS, which is both how CSS is conventionally written and what the existing
  // geometry tests read: `6px 0 0 6px`, not `6px 0px 0px 6px`.
  const j = jointOpen ? "0" : `${leadRadius}px`;
  const corners =
    paneSide === "right"
      ? // TL TR BR BL — joint on the left
        `${j} 0 0 ${j}`
      : // joint on the right
        `0 ${j} ${j} 0`;

  return {
    padding: `${padY}px ${padRight}px ${padY}px ${padLeft}px`,
    padLeft,
    padRight,
    marginLeft,
    marginRight,
    borderRadius: isActive ? corners : idleRadius,
    filletEnds: isActive ? (jointOpen ? [paneSide, jointSide] : [paneSide]) : [],
  };
}
