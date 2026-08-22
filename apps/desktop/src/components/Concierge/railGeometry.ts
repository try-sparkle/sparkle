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

/** One prompt as the rail draws it: a position on the content axis and enough text for the card. */
export interface RailMark {
  /** The concierge message id — what a pick scrolls to. */
  id: string;
  /** 0..1 down the scroller's SCROLLABLE range. 0 = top of the loaded thread. */
  fraction: number;
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
