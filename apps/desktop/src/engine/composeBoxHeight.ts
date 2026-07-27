// How tall the concierge compose box is: it grows with what you type, up to a cap, and you can drag
// it past that cap yourself.
//
// The box was a hard-coded 42px — about two lines — with `resize: none`. Type a paragraph and it
// scrolled internally with no scrollbar and no hint, so the text you were writing went invisible
// above the caret. This module is the policy half of the fix, kept DOM-free so the cap, the floor
// and the drag arithmetic are unit-tested without rendering anything (the measuring and the pointer
// handling live in ComposeBox.tsx).
//
// NOTE this is deliberately NOT `engine/composerDrag.ts`. That module serves the OTHER composer —
// the one in the agent pane — and its `resolveComposerRenderHeight` clamps a user-dragged height to
// the cap. Here the drag must be able to EXCEED the cap: the whole reason to grab the handle is to
// see more than ten lines at once. Same idea, opposite rule at the one point that matters, so they
// stay separate rather than growing a flag.

/** The thread scroller's test id, shared with the ComposeBox that measures against it.
 *
 *  A constant rather than a string literal in two files: the compose box sizes its drag ceiling
 *  from the thread's height, and if that attribute is renamed (or the column gains a wrapper) a
 *  literal would silently miss, fall back to window sizing, and quietly restore the very bug this
 *  module exists to fix — with nothing failing. */
export const CONCIERGE_THREAD_TESTID = "concierge-thread";

/** One line of the compose textarea, in px: 13px font × ~1.45 line-height, rounded. Keep in step
 *  with ComposeBox's `fontSize` — the cap is expressed in LINES because that is how the ask was
 *  phrased ("about ten lines tall"), and lines only mean something against this. */
export const COMPOSE_LINE_H = 19;

/** Vertical padding + borders around the text, in px (10px top + 10px bottom + 1px × 2 border). */
export const COMPOSE_CHROME_H = 22;

/** The resting height: one line of text plus its chrome. */
export const COMPOSE_MIN_H = COMPOSE_LINE_H + COMPOSE_CHROME_H;

/** Auto-grow stops here. Past ten lines the box would eat the conversation it belongs to, so it
 *  scrolls internally instead — and if you want more than this you drag, which is explicit. */
export const COMPOSE_CAP_LINES = 10;
export const COMPOSE_CAP_H = COMPOSE_LINE_H * COMPOSE_CAP_LINES + COMPOSE_CHROME_H;

/** A dragged box still leaves this much of the thread visible. Without a ceiling the handle could
 *  swallow the entire column, leaving a compose box and no conversation — and no obvious way back,
 *  since the thread you would drag against is gone. */
export const COMPOSE_MIN_THREAD_H = 120;

export interface ComposeHeightInput {
  /** Measured content height (textarea scrollHeight), or null before the first measurement. */
  contentH: number | null;
  /** The height the user dragged to, or null when they never have (auto-grow owns it). */
  userH: number | null;
  /** See `composeMaxH`. */
  availableH: number;
}

/**
 * The tallest the box may be — the drag ceiling.
 *
 * `availableH` is the space the compose box and the THREAD SHARE, not the window height. That
 * distinction is the whole point: the concierge column also carries a fixed header (wordmark, spend
 * pill, scope vitals — roughly 150-200px) and a suggestions slot, none of which can compress. Sizing
 * against `window.innerHeight` over-allocates by exactly that chrome, so the thread (`flex: 1`)
 * collapses to zero and the overflow then clips the Send row off the bottom of the window — and
 * since the dragged height is persisted, the broken layout survives a relaunch (roborev 53572).
 *
 * Never below the auto cap, so a short window can't make the ordinary ten-line growth unreachable.
 */
export function composeMaxH(availableH: number): number {
  return Math.max(COMPOSE_CAP_H, availableH - COMPOSE_MIN_THREAD_H);
}

/**
 * The height to render at.
 *
 * - No drag yet → auto-grow with the content, clamped to [MIN, CAP]. Past the cap the textarea
 *   scrolls its own overflow.
 * - Dragged → the user's height wins, clamped to [MIN, ceiling]. It may exceed the auto cap; that
 *   is the point of the handle. It does NOT shrink to fit less content, because a box that
 *   collapsed under you as you deleted a line would fight the size you just chose.
 */
export function composeRenderH({ contentH, userH, availableH }: ComposeHeightInput): number {
  const max = composeMaxH(availableH);
  if (userH != null) return clamp(userH, COMPOSE_MIN_H, max);
  // `contentH` is the raw scrollHeight, which already includes the padding — but not the borders.
  const desired = contentH == null ? COMPOSE_MIN_H : contentH + 2;
  return clamp(desired, COMPOSE_MIN_H, COMPOSE_CAP_H);
}

/**
 * Where a drag lands: the height at grab time plus how far the pointer moved.
 *
 * `dy` is screen-space delta, so dragging UP (negative dy) must make the box TALLER — the handle
 * sits on the box's top edge. Getting that sign backwards is the classic resize bug, hence the
 * explicit subtraction and its test.
 */
export function composeDragH(startH: number, dy: number, availableH: number): number {
  return clamp(startH - dy, COMPOSE_MIN_H, composeMaxH(availableH));
}

/**
 * Should this drag RELEASE the manual height and hand the box back to auto-grow?
 *
 * True when the user drags back down to (or below) the resting height — the natural "put it back"
 * gesture. Without this, one accidental drag would freeze the box at a manual height for the rest
 * of the session with no way to undo it short of dragging to exactly the right pixel.
 */
export function composeDragReleasesManual(h: number): boolean {
  return h <= COMPOSE_MIN_H;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
