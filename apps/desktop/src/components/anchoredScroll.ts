// Land a revealed row AT THE READER'S CURSOR, not at the top of the list and not wherever
// `scrollIntoView` felt like putting it.
//
// The builder column runs well past a screenful. Clicking an agent pill in the transcript selects
// the right agent, but the row answering the click could be anywhere in that column — including off
// screen — so the reader who just clicked has to hunt for the thing they asked for. `scrollIntoView`
// does not help: `block: "nearest"` moves nothing when the row is already visible (however far from
// the eye) and slams it to an edge when it is not.
//
// The eye is already at the cursor. So the target is the cursor's viewport Y, per click, and the
// row is brought to it.
//
// PURE ON PURPOSE. jsdom has no layout — no `getBoundingClientRect` worth reading, no scrolling — so
// a DOM-level test of this can only assert that something was called, which is the vacuous-test
// shape this repo's own guidance calls its #1 fleet-wide finding. The arithmetic that decides
// whether to scroll, how far, and what to do at the ends of the range is all here, where it can be
// tested against real numbers and made to fail.

/** How far off target the row may already be before a scroll is considered not worth it.
 *
 *  Scrolling the column moves EVERY row, so a two-pixel correction costs the reader the stability of
 *  the whole list to buy nothing. Roughly a third of a row's height: close enough that the eye reads
 *  the row as "at the cursor", far enough that a real miss still gets corrected. */
export const ANCHOR_TOLERANCE_PX = 12;

export interface AnchoredScrollInput {
  /** The row's current top edge, in viewport coordinates (`getBoundingClientRect().top`). */
  rowTop: number;
  /** The row's height, so the row can be centred on the cursor rather than hung from it. */
  rowHeight: number;
  /** The click's viewport Y (`MouseEvent.clientY`) — where the reader is actually looking. */
  anchorY: number;
  /** The scroll container's current offset. */
  scrollTop: number;
  /** `scrollHeight - clientHeight`: the largest offset the container can reach. */
  maxScroll: number;
  /** The container's own top edge in viewport coordinates, and its visible height.
   *
   *  REQUIRED, and the reason is the whole correctness of this function. `anchorY` is a click in the
   *  CONCIERGE COLUMN, whose coordinate space starts just under the title bar; the row lives in the
   *  builder column's scroll container, whose visible band starts well below 0 and ends above the
   *  viewport's bottom. Clamping only against `[0, maxScroll]` bounds the CONTENT range, not the
   *  VISIBLE one — so a pill clicked high in the transcript would scroll its row to a viewport Y
   *  above the container's top edge, where it is clipped and invisible. That is strictly worse than
   *  the `scrollIntoView` it replaces, and it consumes the one-shot reveal on the way out, so
   *  nothing corrects it afterwards. */
  containerTop: number;
  containerHeight: number;
  /** Override for tests; defaults to `ANCHOR_TOLERANCE_PX`. */
  tolerancePx?: number;
}

/**
 * The offset to scroll the container to, or `null` when it should not scroll at all.
 *
 * `null` covers three genuinely different situations that all have the same right answer — leave the
 * column alone:
 *   • the row is already at the cursor's height (within tolerance);
 *   • the row is near an end of the list and the clamp leaves nothing to move — this is the
 *     "as close as the range allows" case, and it resolves to "already as close as possible";
 *   • the container cannot scroll at all (`maxScroll <= 0`), i.e. the whole list fits.
 *
 * Returning one value for all three is deliberate: the caller's only decision is whether to write
 * `scrollTop`, and a caller that could tell them apart would be tempted to report them differently.
 */
export function anchoredScrollTop(input: AnchoredScrollInput): number | null {
  const { rowTop, rowHeight, anchorY, scrollTop, maxScroll, containerTop, containerHeight } = input;
  const tolerance = input.tolerancePx ?? ANCHOR_TOLERANCE_PX;

  // A container with nothing to scroll cannot honour any anchor; the row is wherever it is.
  if (!(maxScroll > 0)) return null;

  // ── THE ANCHOR IS CLAMPED INTO THE CONTAINER'S VISIBLE BAND FIRST ────────────────────────────
  // The cursor and the row are in the same viewport but not the same box: a click near the top of
  // the transcript can name a Y that is ABOVE the builder column's first visible pixel. Honouring
  // it literally would park the row in the container's clipped region — on screen by the content
  // maths, invisible to the reader. Half a row of margin at each end, so the whole row lands inside
  // the band rather than straddling its edge.
  const half = rowHeight / 2;
  const bandTop = containerTop + half;
  const bandBottom = containerTop + containerHeight - half;
  // A container shorter than one row cannot satisfy both margins; its own centre is the best
  // available answer, and is what the reader would call "in view".
  const effectiveAnchor =
    bandBottom < bandTop
      ? containerTop + containerHeight / 2
      : Math.min(Math.max(anchorY, bandTop), bandBottom);

  // Centre the row on the cursor. Hanging the row's TOP at the cursor would put the words the
  // reader wants just below where they are looking, which is the same half-miss at a smaller scale.
  const rowCentre = rowTop + rowHeight / 2;
  const desiredDelta = rowCentre - effectiveAnchor;

  // Clamp into the container's real range. This is the graceful-at-the-ends requirement: a row two
  // from the top cannot be centred on a cursor near the bottom of the screen, so it goes as far as
  // the range allows instead of overscrolling or refusing.
  const target = Math.min(Math.max(scrollTop + desiredDelta, 0), maxScroll);

  // The comparison that matters is against the ACHIEVABLE target, not the desired one: at the ends
  // of the list those differ, and testing the desired delta would scroll by a pixel forever while
  // reporting a miss it structurally cannot fix.
  if (Math.abs(target - scrollTop) <= tolerance) return null;
  return target;
}
