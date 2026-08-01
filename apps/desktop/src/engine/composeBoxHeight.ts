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

/** Just the borders (1px × 2). What a `scrollHeight` reading is missing: it includes the padding
 *  and excludes the border, so anything measured that way is this much short of the box it needs. */
export const COMPOSE_BORDER_H = 2;

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
  /** Natural height of the RICH PLACEHOLDER overlay currently painted over the textarea, or
   *  null/0 when none is (the box has text in it, or the host paints no overlay).
   *
   *  The concierge box replaced its native `placeholder=` with a styled overlay — a SIBLING of the
   *  textarea, not its content — so `contentH` cannot see it: an empty box measures one line while
   *  the copy over it runs three. Feeding it in here is what keeps "the box is as tall as what it
   *  displays" true for the empty state too. It matters most for the voice-error notice, which is
   *  the tallest copy in the slot AND the only one carrying controls (Dismiss / Open System
   *  Settings) — clipping those out of reach would strand the user at a broken mic. */
  placeholderH?: number | null;
  /** How much taller the LIVE DICTATION PREVIEW makes the box's content — the mention mirror's
   *  collapsed scrollHeight MINUS the textarea's own — while a Deepgram phrase is still provisional.
   *  Null/0 when nothing is being spoken into the box.
   *
   *  A THIRD input rather than part of `contentH`, because it has to survive the dragged branch. The
   *  interim is painted in a layer behind the textarea and is deliberately NOT in the textarea's
   *  value, so `contentH` is blind to it — and a box at a persisted drag height ignores `contentH`
   *  entirely. Folding it in there fixed the auto-grow path and left a user who had once dragged the
   *  box short with a preview clipped exactly as before, with no scrollbar and no caret to reach it
   *  (roborev 57333). Spoken words are the one content that cannot be scrolled to.
   *
   *  AN INCREMENT, NOT THE MIRROR'S TOTAL, and the distinction is load-bearing in the dragged branch
   *  (roborev 57354). The mirror paints the whole draft plus the provisional suffix, so passing its
   *  total made the TYPED DRAFT outrank the drag for as long as anyone was speaking: a two-line box
   *  holding a fifteen-line draft jumped to the cap on the first partial and snapped back on every
   *  settle, several times an utterance — the "text jumps" class this whole branch exists to remove.
   *  Only the pixels the interim adds PAST the textarea's own content are unreachable, so only those
   *  are what a drag has to yield to. */
  interimH?: number | null;
}

/**
 * The extra height the words still being spoken need, on top of what the box already needs.
 *
 * AN INCREMENT — it is added to a height, never compared against one. That is the whole difference
 * from `composePlaceholderFloorH` below, which returns a complete floor: an overlay stands in for
 * the box's entire content, whereas the interim rides on top of a draft that is already accounted
 * for. Treating it as a total is what let a long typed draft override a drag height (roborev 57354).
 *
 * NO BORDERS ADDED. Both call sites add them exactly once already — the auto branch through
 * `contentH + COMPOSE_BORDER_H`, the dragged branch because `userH` is a rendered height that
 * includes them — so adding them here would count them twice and creep the box a little taller on
 * every utterance.
 *
 * Not capped here either; the callers clamp, because the two branches have different ceilings (the
 * auto cap vs the drag ceiling).
 */
export function composeInterimExtraH(interimH: number | null | undefined): number {
  if (interimH == null || interimH <= 0) return 0;
  return interimH;
}

/**
 * The floor auto-grow may not go below: whatever the placeholder overlay needs, in the same units
 * the height is spent in (its natural content height plus the textarea's own chrome).
 *
 * Capped at COMPOSE_CAP_H so a pathologically long notice still can't eat the conversation — past
 * that it clips at the box's edge exactly as a native placeholder would.
 */
export function composePlaceholderFloorH(placeholderH: number | null | undefined): number {
  if (placeholderH == null || placeholderH <= 0) return COMPOSE_MIN_H;
  return clamp(placeholderH + COMPOSE_CHROME_H, COMPOSE_MIN_H, COMPOSE_CAP_H);
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
 * - No drag yet → auto-grow to fit what the box DISPLAYS — the typed content, or the placeholder
 *   overlay when there is none — clamped to [MIN, CAP]. Past the cap the textarea scrolls its own
 *   overflow.
 * - Dragged → the user's height wins, clamped to [MIN, ceiling]. It may exceed the auto cap; that
 *   is the point of the handle. It does NOT shrink to fit less content, because a box that
 *   collapsed under you as you deleted a line would fight the size you just chose — and for the
 *   same reason an explicit drag outranks the placeholder floor below. Dragging back down to
 *   resting releases the box to auto-grow, which is where that floor reappears.
 *
 * A live dictation preview is ADDED to whichever height wins — never compared against it, and only
 * the pixels the phrase adds PAST the textarea's own content. That distinction is not a nicety: as a
 * `Math.max(userH, …)` it made the typed draft outrank the drag for as long as anyone was speaking,
 * so the box jumped to fit the whole draft on every partial and snapped back on every settle
 * (roborev 57354). Do not restore that shape.
 *
 * Why speech gets a lift at all, when nothing else does: everything a short box hides is still
 * reachable — you scroll the textarea, or the caret takes you there. Provisional speech is not in
 * the textarea at all, so a box too short for it doesn't hide the words, it DELETES them from the
 * screen. The lift lasts exactly as long as the phrase is provisional (roborev 57333).
 *
 * The lift is ALLOCATION only. Making those pixels reachable when the textarea overflows is
 * ComposeBox's job, not this function's — see the dictation spacer there (roborev 57397).
 */
export function composeRenderH({
  contentH,
  userH,
  availableH,
  placeholderH,
  interimH,
}: ComposeHeightInput): number {
  const max = composeMaxH(availableH);
  // ADDED to whichever height wins, never compared against it — see `composeInterimExtraH`. Zero
  // unless a phrase is actually provisional, so a typed draft reaches neither branch changed.
  const speaking = composeInterimExtraH(interimH);
  // A DRAG HEIGHT OUTRANKS CONTENT, BUT NOT THE WORDS BEING SPOKEN INTO THE BOX.
  //
  // `userH` deliberately ignores `contentH`: a box that collapsed as you deleted a line would fight
  // the size you just chose, and typed text a short box hides is still reachable by scrolling or by
  // the caret. Provisional speech is in neither the value nor the scroll, so a box too short for it
  // does not hide those words — it erases them. Hence the increment, and only the increment: the
  // drag still decides how much of the DRAFT is on screen, and lends back exactly the lines the
  // live phrase adds. The moment it settles the height is the user's again.
  //
  // The lift stops at the auto cap (or at the user's own height, when they dragged past it): a
  // dragged box may exceed the cap because the user said so, and a spoken sentence may not decide
  // that on their behalf. `max` still bounds everything, so the drag ceiling is never crossed.
  if (userH != null) {
    return clamp(userH + speaking, COMPOSE_MIN_H, Math.min(max, Math.max(userH, COMPOSE_CAP_H)));
  }
  // `contentH` is the raw scrollHeight, which already includes the padding — but not the borders.
  const desired = (contentH == null ? COMPOSE_MIN_H : contentH + COMPOSE_BORDER_H) + speaking;
  // The floor, not a separate branch: a box holding BOTH a draft and (transiently) an overlay
  // takes whichever is taller, and neither can clip the other.
  return clamp(
    Math.max(desired, composePlaceholderFloorH(placeholderH)),
    COMPOSE_MIN_H,
    COMPOSE_CAP_H,
  );
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
