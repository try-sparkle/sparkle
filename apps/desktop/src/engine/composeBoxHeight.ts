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

/** The compose textarea's TYPE RAMP — the one source for both the glyphs and the height cap.
 *
 *  Exported and spread into ComposeBox's `COMPOSE_TEXT_METRICS` rather than written out a second
 *  time there. The cap is expressed in LINES, and a line only means something against the metrics
 *  the text is actually set in — so two hand-kept copies is not a tidiness problem, it is the cap
 *  silently describing a box nobody renders. That is what it had become: the component set 13px ×
 *  1.4 while this file rounded a line to `19`, so the "ten line" cap really resolved to 10.4 lines,
 *  and retuning the type would have moved the text without moving the cap. */
export const COMPOSE_FONT_SIZE = 13;
export const COMPOSE_LINE_HEIGHT = 1.4;

/** One RENDERED line of the compose textarea, in px.
 *
 *  FRACTIONAL, AND IT MUST STAY FRACTIONAL. 13 × 1.4 is 18.2 — rounding it here multiplies the
 *  error by `COMPOSE_CAP_LINES`, which is exactly how a ten-line cap turns into a nine- or an
 *  eleven-line one. The cap below rounds ONCE, after multiplying. */
export const COMPOSE_LINE_PX = COMPOSE_FONT_SIZE * COMPOSE_LINE_HEIGHT;

/** The resting one-line box's text height, rounded UP so a single line is never a hair short. */
export const COMPOSE_LINE_H = Math.ceil(COMPOSE_LINE_PX);

/** The textarea's vertical padding, per edge. Shared with ComposeBox for the reason the type ramp
 *  is: `scrollHeight` counts this padding, so the chrome below has to be the padding that is
 *  actually applied or every measurement is off by the difference. */
export const COMPOSE_PAD_Y = 10;

/** Vertical padding + borders around the text, in px (10px top + 10px bottom + 1px × 2 border). */
export const COMPOSE_CHROME_H = COMPOSE_PAD_Y * 2 + 2;

/** Just the borders (1px × 2). What a `scrollHeight` reading is missing: it includes the padding
 *  and excludes the border, so anything measured that way is this much short of the box it needs. */
export const COMPOSE_BORDER_H = 2;

/** The resting height: one line of text plus its chrome. */
export const COMPOSE_MIN_H = COMPOSE_LINE_H + COMPOSE_CHROME_H;

/** Auto-grow stops here. Past ten lines the box would eat the conversation it belongs to, so it
 *  scrolls internally instead — and if you want more than this you drag, which is explicit.
 *
 *  ══ TEN WRAPPED LINES AT ANY COLUMN WIDTH, WHICH A PIXEL CAP GENUINELY DELIVERS ═══════════════
 *  The founder's constraint on this was *"no matter what the width is … show the first 10 lines of
 *  text"*, and the intuitive reading of it — that a pixel cap must therefore be wrong, because the
 *  concierge column is resizable — is worth answering here, because it is the reading that sends
 *  someone to re-derive this from a measured wrap count.
 *
 *  WRAPPING CHANGES HOW MANY LINES THE CONTENT OCCUPIES. IT DOES NOT CHANGE HOW TALL A LINE IS.
 *  Narrow the column and the same paragraph wraps to more lines, each still `COMPOSE_LINE_PX`
 *  tall — so `10 × COMPOSE_LINE_PX + chrome` is ten RENDERED lines at 200px wide and at 900px
 *  wide alike. The box then fits ten of however many lines the text now wraps to, and scrolls the
 *  rest, which is the ask.
 *
 *  A pixel cap only breaks that promise two ways, and both are closed above rather than by
 *  measuring: an arbitrary number that was never derived from a line height (what `19` was), and a
 *  type ramp that varies with width or mode while the cap does not (the terminal-aimed face swaps
 *  the family, not the size — and it now takes `COMPOSE_FONT_SIZE` from here, so it cannot drift
 *  into varying it without moving the cap too).
 *
 *  What DOES have to follow the width is the CONTENT measurement — `contentH` is a wrap-dependent
 *  `scrollHeight`, so a column resize must re-measure it. That is ComposeBox's layout effect, and
 *  `columnWidth` is one of its dependencies for exactly this reason. */
export const COMPOSE_CAP_LINES = 10;
/** Rounded ONCE, after multiplying — see `COMPOSE_LINE_PX`. Ten lines of 18.2px is 182px, so the
 *  cap is 204px and the eleventh line is fully out, rather than the 212px (10.4 lines) that
 *  rounding per-line produced. */
export const COMPOSE_CAP_H = Math.ceil(COMPOSE_LINE_PX * COMPOSE_CAP_LINES) + COMPOSE_CHROME_H;

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
 * - Dragged → the user's height is a FLOOR, clamped to [MIN, ceiling]. It may exceed the auto cap;
 *   that is the point of the handle. It does NOT shrink to fit less content, because a box that
 *   collapsed under you as you deleted a line would fight the size you just chose. But it no longer
 *   BLOCKS growth either: content still grows a dragged box up to the same ten-line cap an undragged
 *   one gets. It used to win outright, which made the cap permanently unreachable for anyone who had
 *   touched the handle once — and since the height is persisted, for every session after. See the
 *   branch body for the founder's measured 59px (two-line) box. Dragging back down to resting still
 *   releases the box to auto-grow entirely.
 *
 * A live dictation preview is ADDED to whichever height wins — never compared against it, and only
 * the pixels the phrase adds PAST the textarea's own content. That distinction is not a nicety: as a
 * `Math.max(userH, …)` it made the typed draft outrank the drag for as long as anyone was speaking,
 * so the box jumped to fit the whole draft on every partial and snapped back on every settle
 * (roborev 57354). It is still an increment, but the oscillation it caused is now gone at the
 * source: the draft's height applies whether or not anyone is speaking, so there is no settle for
 * such a box to snap back to.
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
  // `contentH` is the raw scrollHeight, which already includes the padding — but not the borders.
  const desired = (contentH == null ? COMPOSE_MIN_H : contentH + COMPOSE_BORDER_H) + speaking;
  // What an UNDRAGGED box would be. Computed before the branch because a dragged box now takes it
  // as a floor rather than ignoring it — see below.
  //
  // The placeholder overlay is a floor here, not a separate branch: a box holding BOTH a draft and
  // (transiently) an overlay takes whichever is taller, and neither can clip the other.
  const autoH = clamp(
    Math.max(desired, composePlaceholderFloorH(placeholderH)),
    COMPOSE_MIN_H,
    COMPOSE_CAP_H,
  );
  if (userH != null) {
    // ══ A DRAG IS A FLOOR, NOT A FREEZE ═══════════════════════════════════════════════════════
    // It used to be a freeze: this branch returned `userH` and ignored `contentH` outright, so the
    // ten-line cap was UNREACHABLE for anyone who had ever touched the handle. And because the
    // height is persisted, one drag froze the box for every later session.
    //
    // That is not a hypothetical. The founder reported the box "scrolling after way less than ten
    // lines" and then, more precisely, that he did not see it "changing height at all" — and his
    // persisted `conciergeComposeH` read 59.13px, which is two lines. He had never once reached a
    // cap that has said ten since the day it was written. The fractional value is the tell: it came
    // off a pointer drag (`composeDragH`), and 59 is above the ≤ MIN release threshold, so it stuck.
    //
    // The half of the old rule that was right is KEPT, and it is the `Math.max`: the box still does
    // not shrink as content is deleted, because a box collapsing under you would fight the size you
    // just chose. What changes is the other direction — content may now grow the box PAST the
    // dragged height, up to the same ten-line cap an undragged box gets. Dragging remains the way
    // to exceed that cap, which is still the point of the handle.
    //
    // A NOTE ON WHAT THIS RETIRES. The old branch carried three bounds against a long typed draft
    // riding in on a spoken phrase and overriding the drag (roborev 57354: a two-line box holding a
    // fifteen-line draft jumped to the cap on the first partial and snapped back on every settle).
    // The oscillation needed the draft's height to apply only WHILE speaking; now `autoH` applies
    // whether or not anyone is talking, so such a box sits at the cap and stays there. The defect is
    // removed by construction rather than guarded against — there is nothing left to snap back to.
    //
    // ── THE OLD DRAGGED RULE IS KEPT WHOLE, AND `autoH` IS ADDED UNDER IT AS A FLOOR ───────────
    // `lifted` below is the previous branch verbatim, three bounds and all, and it must stay that
    // way. Replacing it with a plain `userH + lift` looks equivalent and is not — it drops the
    // "grow only as far as NEEDED" bound, so every dragged box with room to spare grows on each
    // partial and snaps back on each settle. That is the roborev 57354 overshoot, re-entering
    // through the door this change opens; the engine's own suite caught it on the first run.
    //
    //   Math.max(userH, needed)  GROW ONLY AS FAR AS NEEDED. Nothing is clipped in a roomy box —
    //                            the mirror is `inset: 0`, so it already fills it.
    //   userH + lift             NEVER BY MORE THAN THE SPOKEN LINES ADD.
    //   lift ≤ CAP - MIN         NEVER MORE THAN A CAPFUL OF GROWTH — a bound on the GROWTH, not on
    //                            the absolute height. As a `Math.max(userH, CAP)` ceiling it would
    //                            make `userH` its own ceiling for a box dragged past the cap, which
    //                            does not bound dictation growth, it disables it.
    //
    // The `Math.max` with `autoH` is the whole of the new behaviour: content may now raise a
    // dragged box to the ten-line cap. Everything above still decides what the DRAG plus a live
    // phrase is worth; this only refuses to go below what an undragged box would have been.
    //
    // ONE SIDE EFFECT WORTH NAMING, because it reverses a sentence this docstring used to carry.
    // `autoH` includes `composePlaceholderFloorH`, so a dragged box now respects that floor too —
    // an explicit drag used to outrank it. The direction is the safe one: the floor can only make
    // the box TALLER, and the copy it exists for is the voice-error notice, the tallest in the slot
    // and the only one carrying controls (Dismiss / Open System Settings). Under the old rule a box
    // dragged short clipped those out of reach, stranding the user at a broken mic with the fix
    // sitting just below the visible edge. That is no longer reachable.
    const needed = desired;
    const lift = Math.min(speaking, COMPOSE_CAP_H - COMPOSE_MIN_H);
    const lifted = Math.min(Math.max(userH, needed), userH + lift);
    return clamp(Math.max(lifted, autoH), COMPOSE_MIN_H, max);
  }
  return autoH;
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
