// The scrubber rail's CONTENT-AXIS geometry: pure numbers, no React and no DOM.
//
// ── WHY THIS MODULE EXISTS, AND WHY IT IS NOT `scrubberGeometry.ts` ─────────────────────────────
// `scrubberGeometry.ts` places dots on a TIME axis: fraction 0 is `now - scope` and fraction 1 is
// `now`, regardless of what is on screen. That was the right axis for a rail whose only committed
// action was "jump to this prompt" — and it is the WRONG axis for the rail the founder actually
// asked for on 2026-08-22:
//
//   *"I start to scroll up and down, it actually moves the chat in real time. It replaces the
//    scroll. So I don't have the scroll anymore. I just have this draggable handle."*
//
// A control that REPLACES the scrollbar has to be measured in the same units the scrollbar is: the
// scroller's own scrollable range. Two axes cannot both be the rail — a rail whose handle sits at
// "three days ago" while the thread sits at 40% of its content is a control fighting its reader, and
// no amount of interpolation makes the two agree at the ends (a quiet week is a third of a 3d time
// axis and zero pixels of content).
//
// So the axis here is CONTENT: fraction 0 is the top of everything loaded, fraction 1 the bottom.
// The scope selector still means what it always meant — it decides HOW FAR BACK the thread is
// loaded — so "one week at the top of the slider takes me all the way back to one week ago" is still
// true, it is simply realised by paging a week of turns in rather than by rescaling an empty ruler.
//
// ── WHY IT IS A SEPARATE FILE AT ALL ───────────────────────────────────────────────────────────
// jsdom has no layout engine, so `getBoundingClientRect`, `scrollHeight` and `offsetTop` all read 0
// and a test that tried to prove "the handle sits 40% down" by measuring would pass vacuously
// against a rail that painted nothing (docs/jsdom-test-caveats.md). The honest coverage for a rail
// is NUMERIC, and numeric coverage needs a module a node-environment test can import without
// dragging React, the theme or the concierge stores in behind it.

/** One prompt as the rail draws it: a position on the time axis and enough text for the card. */
export interface RailMark {
  /** The concierge message id — what a pick scrolls to. */
  id: string;
  /**
   * WHERE THE RAIL DRAWS IT: 0..1 down the SELECTED TIME WINDOW. 0 = `now - scope`, 1 = `now`.
   *
   * This was the content fraction until 2026-08-24, and that is the whole of the bug the founder
   * reported — a pixel offset cannot be moved by a dropdown, so widening 1h → 12h relabelled the
   * control and left every mark exactly where it was. `contentFraction` below keeps the pixel
   * reading, which the rail still needs to SCROLL to a mark; it is simply no longer where the mark
   * is painted.
   */
  fraction: number;
  /**
   * Where the prompt sits in the transcript: 0..1 down the scroller's SCROLLABLE range.
   *
   * Optional because only a MEASURED mark has one — a prompt known solely from SQLite (paged in but
   * not yet rendered) has a time and no pixels. Pairs with `fraction` to form an {@link AxisAnchor}.
   */
  contentFraction?: number;
  /** First ~160 chars of the prompt. Truncated by the caller; this module never touches text. */
  textPrefix: string;
  /** 1-based ordinal within the loaded thread, oldest first — the card's "Prompt N". */
  index: number;
  /** Epoch ms, when it is known. A live bubble the history table has not answered for yet has
   *  none, and the card simply omits the age rather than inventing one. */
  createdAt?: number;
}

/** Several marks drawn as ONE line because they would otherwise overlap. */
export interface MarkBand {
  key: string;
  /** Mean of the members' fractions — so the line sits where its members are. */
  fraction: number;
  marks: RailMark[];
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/**
 * Where a scroll offset sits on the content axis.
 *
 * A scroller with nothing to scroll (`scrollHeight <= clientHeight`) is entirely visible, so every
 * offset in it IS the top: 0, not a division by zero and not 1. The rail then draws a handle parked
 * at the top of a track with nowhere to go, which is exactly what a native scrollbar does.
 */
export function fractionForScrollTop(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
): number {
  const range = scrollHeight - clientHeight;
  if (range <= 0) return 0;
  return clamp01(scrollTop / range);
}

/** Inverse of {@link fractionForScrollTop}. Clamped, so a drag off the end of the rail parks. */
export function scrollTopForFraction(
  fraction: number,
  scrollHeight: number,
  clientHeight: number,
): number {
  const range = scrollHeight - clientHeight;
  if (range <= 0) return 0;
  return clamp01(fraction) * range;
}

/** The spec's figure, carried over from the time rail: marks closer than ~6px merge into one. */
export const DEFAULT_MIN_GAP_PX = 6;

/**
 * Marks closer together than `minGapPx` merge into ONE band.
 *
 * ── THE MERGE IS ANCHORED, NOT CHAINED ─────────────────────────────────────────────────────────
 * Each band measures from the pixel of its FIRST member, never from the last one added. Chaining
 * ("merge with the previous if it is within the gap") lets an evenly-spaced ramp `minGapPx - 1`
 * apart collapse into a single band spanning the whole rail, whose line would then be drawn in the
 * middle of a run that actually covers everything. Anchoring bounds every band to strictly less than
 * `minGapPx`, so a band's line always sits where its members are.
 *
 * ── AND IT NEVER DROPS A MARK ──────────────────────────────────────────────────────────────────
 * The founder's complaint that opened this work was *"it's definitely not giving me all of them"*.
 * Merging is the only compression here and it is LOSSLESS: every input mark is a member of exactly
 * one output band, so `bands.flatMap(b => b.marks).length === marks.length` for any input. The band
 * carries its own `marks.length`, which is what lets the rail vary the mark rather than lie by
 * omission. There is no sampling and no cap anywhere in this file — deliberately, and a test asserts
 * the total is conserved.
 *
 * Ordering guarantees callers may rely on: `marks` inside a band is ascending by `fraction`, and
 * bands are ascending by `fraction`.
 */
export function mergeMarks(
  marks: RailMark[],
  railHeightPx: number,
  minGapPx = DEFAULT_MIN_GAP_PX,
): MarkBand[] {
  const sorted = [...marks].sort((a, b) => a.fraction - b.fraction || a.index - b.index);
  if (sorted.length === 0) return [];

  // With no measured height (or no gap) there is no pixel distance to compare, so nothing may be
  // merged. Failing toward MORE marks is the safe direction: a rail that draws every prompt is busy
  // at worst, whereas one that merged everything into a single line on a 0px measurement would have
  // silently thrown the founder's history away — the exact failure this rail is being fixed for.
  const canMerge = railHeightPx > 0 && minGapPx > 0;

  const out: MarkBand[] = [];
  let group: RailMark[] = [];
  let anchorPx = 0;

  const flush = () => {
    if (group.length === 0) return;
    const first = group[0]!;
    const mean = group.reduce((sum, m) => sum + m.fraction, 0) / group.length;
    // Keyed on the first member's id: unique (a mark belongs to exactly one band) and stable across
    // a re-render that only appends newer prompts, so React does not tear down a line under the
    // pointer that is hovering it.
    out.push({ key: first.id, fraction: mean, marks: group });
    group = [];
  };

  for (const m of sorted) {
    const px = m.fraction * railHeightPx;
    if (group.length === 0) {
      group = [m];
      anchorPx = px;
      continue;
    }
    if (canMerge && px - anchorPx < minGapPx) {
      group.push(m);
      continue;
    }
    flush();
    group = [m];
    anchorPx = px;
  }
  flush();
  return out;
}

/**
 * The band nearest a rail fraction, or null when there are none.
 *
 * Ties break toward the OLDER band (lower fraction = higher on the rail): the reader is scrubbing
 * back through the conversation, and the older of two equidistant bands is the one further in the
 * direction they are travelling. Any rule would do so long as it is DETERMINISTIC — what must not
 * happen is a drag sitting exactly between two lines flickering between them as the pointer jitters
 * by a sub-pixel.
 */
export function nearestBand(fraction: number, bands: MarkBand[]): MarkBand | null {
  let best: MarkBand | null = null;
  let bestDist = Infinity;
  for (const b of bands) {
    const dist = Math.abs(b.fraction - fraction);
    if (dist < bestDist || (best !== null && dist === bestDist && b.fraction < best.fraction)) {
      best = b;
      bestDist = dist;
    }
  }
  return best;
}

/**
 * Which prompt a click on a merged band jumps to: the NEWEST one in it.
 *
 * Because that is the one the card just showed. `RailHoverCard` prints the newest member's text, so
 * jumping anywhere else would land the reader somewhere other than the words on screen — the single
 * most confusing thing a navigation control can do. Identical rule to the time rail's
 * `pickFromCluster`, kept identical on purpose.
 */
export function pickFromBand(band: MarkBand): RailMark {
  return band.marks[band.marks.length - 1]!;
}

// ══ THE TWO AXES, AND THE MAP BETWEEN THEM ══════════════════════════════════════════════════════
//
// On 2026-08-24 the founder ruled that the MARKS go back onto the TIME axis: *"when i change from
// 1h to 12h it doesn't change the previous prompt horizontal lines at all., but it should be"*. A
// mark's position is therefore `fractionFor(createdAt, scopeWindow)` again, and a wider scope
// redistributes every mark whether or not more history loads.
//
// That alone would break the thing he asked for two days earlier — *"It replaces the scroll... I
// just have this draggable handle"* — because a handle measured in content pixels and marks measured
// in time do not name the same place, so dragging to a mark would land somewhere else. The rail
// would be a control fighting its reader, which is the exact failure `railGeometry.ts`'s own header
// warned about when it moved OFF the time axis.
//
// So both live at once, joined here. The loaded prompts are ANCHORS: each one knows where it sits in
// the transcript (content) and when it happened (time), and between two anchors we interpolate. The
// handle is drawn on the TIME axis with the marks, and a drag converts back to content to write
// `scrollTop` — so the gesture still scrolls the thread in real time, and it still lands on the mark
// it was dragged to.
//
// WHY INTERPOLATION AND NOT A FORMULA: there is no closed-form relation between the two. A quiet
// hour occupies a third of a 3h ruler and zero pixels of transcript; a burst of long replies is the
// reverse. The anchors are the only place the two axes are known to agree, and between them a
// straight line is the honest guess — it is monotonic, it is exact AT every prompt (which is where
// every pick and every mark actually is), and it degrades to "park at the top" when there is nothing
// to interpolate from rather than dividing by zero.

/** One prompt's position on BOTH axes — the only instants where content and time are known to agree. */
export interface AxisAnchor {
  /** 0..1 down the scroller's scrollable range. */
  contentFraction: number;
  /** 0..1 down the selected time window. */
  timeFraction: number;
}

/**
 * Sort anchors and drop the ones that cannot define a segment.
 *
 * Both axes must be ASCENDING together for interpolation to be monotonic. Prompts are appended in
 * time order and rendered in that order, so they normally are — but a mark whose history row has not
 * landed, or a backlog page inserted above the live thread mid-measurement, can briefly present a
 * pair that disagrees. Dropping the offender is better than interpolating across an inversion, which
 * would make the handle run backwards as the reader scrolls forwards.
 */
function usableAnchors(anchors: AxisAnchor[]): AxisAnchor[] {
  const sorted = [...anchors].sort(
    (a, b) => a.contentFraction - b.contentFraction || a.timeFraction - b.timeFraction,
  );
  const out: AxisAnchor[] = [];
  for (const a of sorted) {
    const last = out[out.length - 1];
    if (last && a.timeFraction < last.timeFraction) continue;
    out.push(a);
  }
  return out;
}

/**
 * Piecewise-linear map along one axis of the anchor list.
 *
 * `pick` reads the axis being searched, `read` the axis being produced, so ONE implementation serves
 * both directions and they cannot drift apart — a hand-written inverse is exactly the kind of
 * duplicate that goes subtly non-invertible and puts the handle a few pixels off every mark.
 *
 * ── THE ENDS ARE CLAMPED, NOT EXTRAPOLATED ─────────────────────────────────────────────────────
 * Outside the anchors there is no evidence about the relationship at all, and extrapolating a slope
 * measured between two prompts across an empty week produces positions that are confidently wrong.
 * Clamping says the honest thing: above the oldest loaded prompt the rail is at its top.
 */
function interpolate(
  value: number,
  anchors: AxisAnchor[],
  pick: (a: AxisAnchor) => number,
  read: (a: AxisAnchor) => number,
): number {
  const pts = usableAnchors(anchors);
  // NOTHING TO MAP. Zero anchors is a thread with no prompt in the window; one anchor fixes a point
  // but no slope. Both collapse to the top of the track, which is what a scrollbar with nowhere to
  // go does, rather than to a fabricated midpoint.
  if (pts.length === 0) return 0;
  if (pts.length === 1) return clamp01(read(pts[0]!));
  const first = pts[0]!;
  const last = pts[pts.length - 1]!;
  if (value <= pick(first)) return clamp01(read(first));
  if (value >= pick(last)) return clamp01(read(last));
  for (let i = 1; i < pts.length; i++) {
    const lo = pts[i - 1]!;
    const hi = pts[i]!;
    if (value > pick(hi)) continue;
    const span = pick(hi) - pick(lo);
    // A DEGENERATE SEGMENT IS NOT A DIVISION BY ZERO. Two prompts in the same millisecond share a
    // time fraction, and two in one un-scrollable thread share a content fraction; either way the
    // segment has no interior, so its far end is the answer.
    if (span <= 0) return clamp01(read(hi));
    return clamp01(read(lo) + ((value - pick(lo)) / span) * (read(hi) - read(lo)));
  }
  return clamp01(read(last));
}

/** Where a scroll position sits on the TIME axis — what the handle is drawn at. */
export function contentToTime(contentFraction: number, anchors: AxisAnchor[]): number {
  return interpolate(
    clamp01(contentFraction),
    anchors,
    (a) => a.contentFraction,
    (a) => a.timeFraction,
  );
}

/** Where a point on the TIME axis sits in the transcript — what a drag writes as `scrollTop`. */
export function timeToContent(timeFraction: number, anchors: AxisAnchor[]): number {
  return interpolate(
    clamp01(timeFraction),
    anchors,
    (a) => a.timeFraction,
    (a) => a.contentFraction,
  );
}
