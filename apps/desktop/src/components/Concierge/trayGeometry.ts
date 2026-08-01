// The send tray's HORIZONTAL GEOMETRY, and the two decisions derived from it.
//
// ── WHY THIS IS ITS OWN MODULE ──────────────────────────────────────────────────────────────────
// These numbers decide `TRAY_SHORT_LABEL_MAX_PX` (voice/sendMode) — the width below which the pills
// switch to short labels — and that threshold's whole correctness argument is arithmetic over them.
// The argument has now been got wrong three times in three different ways:
//
//   1. The test COPIED the numbers into another file, so changing one here left the bound comparing
//      against a stale constant and passing (roborev 56213).
//   2. Exporting them from SendModeTray.tsx fixed that but routed a NODE-environment unit test
//      through the app's heaviest component module — 61 top-level imports, Tauri APIs, seven zustand
//      stores, ConciergeHost — to read a handful of integers. Any module-scope `document` added
//      anywhere in that graph would turn a pure logic test red for reasons unrelated to send modes
//      (roborev 56223).
//   3. The derivation itself mixed coordinate systems and omitted a contributor — see
//      `fullLabelsFitAtPx` (roborev 56223).
//
// So: a leaf module with no React, which both the component and the tests can read. Its ONE import
// is voice/sendMode, itself a runtime leaf (type-only component imports, and `confidence` imports
// nothing) — the pill count must come from `SEND_MODES`, not from a copy of its length.
// The component MUST use these for its styles rather than re-typing the values, or the derivation
// goes back to describing a tray that no longer exists.

import { SEND_MODES } from "../../voice/sendMode";
/**
 * How many positions the tray draws — READ FROM `SEND_MODES`, never spelled out.
 *
 * An earlier revision of this module hand-wrote `3` here, justified as "keeps this module a leaf".
 * That justification was FALSE: `voice/sendMode` imports only two TYPES (erased at compile time)
 * plus `thresholdMs` from `./confidence`, which itself imports nothing — so it is already a
 * React-free runtime leaf and importing it costs nothing.
 *
 * The literal also re-introduced the very defect this module exists to prevent, at the one input
 * nothing pinned. Adding a fourth position is a supported change (`stepSendMode` walks the array,
 * the component maps over it), and with a hardcoded 3 `fullLabelsFitAtPx()` would keep returning 431
 * against a true requirement of 576 — the guard staying green while every width in between clipped
 * mid-word — and `DEFAULT_SPEAK_LEFT_FRAC` would stay 2/3 instead of 3/4, stopping the sweep ~8%
 * short of Speak's edge. The same stale-literal failure as `CHICLET_SLOT` and `pillBorder`,
 * relocated once more (roborev 56301).
 */
export const TRAY_PILL_COUNT = SEND_MODES.length;

/**
 * Every horizontal contributor to a pill's width, in px.
 *
 * `pillBorder` is the one that was missing, and its absence is instructive: with
 * `* { box-sizing: border-box }` (index.css) a flex item's border still counts toward its
 * max-content size, so 1.5px on each side of three pills is 9px the full labels genuinely need.
 * Leaving it out made the derivation OPTIMISTIC while it was documented as pessimistic.
 */
export const TRAY_GEOMETRY = {
  /** The tray's own `padding`, per side. NOT part of the fit calculation — see `fullLabelsFitAtPx`. */
  trayPad: 3,
  /** Gap between adjacent pills. There are `TRAY_PILL_COUNT - 1` of them. */
  trayGap: 4,
  /** Each pill's horizontal `padding: "0 Npx"`, per side. */
  pillPadX: 8,
  /** The same padding in the ICON tier. Tighter, because at that point the padding is competing
   *  with the glyph for a column that may be 50px wide — and 8px per side across three pills is
   *  48px of the ~30px the composer actually has there. Only reached below
   *  `TRAY_ICON_ONLY_MAX_PX`, where there is no text for the padding to breathe around anyway. */
  pillPadXIcon: 2,
  /** Each pill's border, per side. Counts toward width under `box-sizing: border-box`. */
  pillBorder: 1.5,
  /** Gap between a pill's label and its keycap slot. */
  pillGap: 6,
  /** The keycap slot, reserved in BOTH states so nothing shifts when the chiclet appears. */
  chicletSlot: 30,
} as const;

/**
 * The widest full label's rendered width, in px, at `TYPE.small`.
 *
 * AN ESTIMATE, and deliberately the PESSIMISTIC end of one: "Push to talk" renders semibold when
 * unselected and BOLD when selected, and `TYPE.small` is a CSS variable a theme may enlarge. Two
 * independent readings put it at ~72px and ~86px; the larger is used, because erring wide costs a
 * needlessly-short label while erring narrow costs a silently clipped word.
 *
 * It cannot be measured in a test — jsdom has no layout engine — so it is stated here as the one
 * genuinely unverifiable input rather than buried inside the arithmetic.
 */
export const WIDEST_LABEL_PX = 86;

/**
 * The tray width at which the FULL labels stop fitting.
 *
 * ── ONE COORDINATE SYSTEM: contentRect ──────────────────────────────────────────────────────────
 * The measured quantity this is compared against is the ResizeObserver's `contentRect.width`, which
 * EXCLUDES the tray's own padding. So `trayPad` must NOT appear here. An earlier version added
 * `2 * trayPad` (+6) while omitting `2 * pillBorder` per pill (−9); the two errors partially
 * cancelled, which is precisely why the result still landed on a plausible-looking 428 and the guard
 * stayed green. Mixing boxes is not a rounding error — it is two bugs hiding each other.
 */
export function fullLabelsFitAtPx(): number {
  const g = TRAY_GEOMETRY;
  const perPill = 2 * g.pillPadX + 2 * g.pillBorder + g.pillGap + g.chicletSlot;
  // `(n - 1)` gaps, never a hardcoded 2, so the pill count and the gap count cannot disagree.
  return TRAY_PILL_COUNT * (WIDEST_LABEL_PX + perPill) + (TRAY_PILL_COUNT - 1) * g.trayGap;
}

/**
 * The widest SHORT label's rendered width, in px, at `TYPE.small`.
 *
 * "Speak" is the longest of `SEND_MODE_LABEL_SHORT` at five characters. Derived from
 * `WIDEST_LABEL_PX` rather than guessed independently, so the two estimates cannot drift: that is a
 * 12-character string ("Push to talk") measured pessimistically at 86px, i.e. ~7.2px per character,
 * and 5 characters at that rate is ~36px. Rounded UP to 44 for the same reason `WIDEST_LABEL_PX`
 * takes the larger of its two readings — erring wide costs an icon shown a notch early, erring
 * narrow costs a silently clipped word, which is the exact defect this tier exists to delete.
 */
export const WIDEST_SHORT_LABEL_PX = 44;

/** An icon-only pill's glyph box, in px. `FiSend` and friends are drawn at 14 and get a couple of
 *  px of optical slack so a pill never clips its own icon. */
export const TRAY_ICON_PX = 16;

/**
 * The tray width at which the SHORT labels stop fitting — below this the pills go icon-only.
 *
 * Same coordinate system and the same per-pill contributors as `fullLabelsFitAtPx`; only the label
 * term changes. The chiclet slot is still counted, because the short-label tier still draws it.
 */
export function shortLabelsFitAtPx(): number {
  const g = TRAY_GEOMETRY;
  const perPill = 2 * g.pillPadX + 2 * g.pillBorder + g.pillGap + g.chicletSlot;
  return TRAY_PILL_COUNT * (WIDEST_SHORT_LABEL_PX + perPill) + (TRAY_PILL_COUNT - 1) * g.trayGap;
}

/**
 * The narrowest the tray can be while still drawing three readable icons.
 *
 * Below this the pills keep shrinking — they are `flex: 1 1 0` against the column, so the tray can
 * never OVERFLOW no matter how narrow the column gets, which is requirement 1. What it stops being
 * below this width is comfortable, not correct. Stated so the icon tier's own floor is a number
 * someone can check rather than an assumption.
 *
 * NO chiclet slot and no label gap here: the keycap hint is dropped with the words, because a
 * reserved 30px slot per pill is the single largest thing standing between three icons and a narrow
 * column.
 */
export function iconsFitAtPx(): number {
  const g = TRAY_GEOMETRY;
  const perPill = 2 * g.pillPadXIcon + 2 * g.pillBorder + TRAY_ICON_PX;
  return TRAY_PILL_COUNT * perPill + (TRAY_PILL_COUNT - 1) * g.trayGap;
}

/**
 * The width of ONE icon pill — the point below which three of them cannot share a line.
 *
 * Below this the tray WRAPS rather than overflowing: the pills are `flex: 1 1 auto` with this as
 * their floor, so a column too narrow for a row of three becomes two rows, then three. That is what
 * makes the 50px column floor (engine/columnResize) survivable — at ~30px of composer content width
 * a single 21px pill still fits, where a row of three never could.
 *
 * Wrapping rather than clipping is the founder's requirement 1 restated: nothing may overflow the
 * column, at any width the user can drag to.
 */
export function iconPillMinPx(): number {
  const g = TRAY_GEOMETRY;
  return 2 * g.pillPadXIcon + 2 * g.pillBorder + TRAY_ICON_PX;
}

/**
 * The geometric answer for evenly-shared pills, used until a real measurement lands.
 *
 * Correct in jsdom (where nothing can be measured) and within a few px of the measured value in the
 * app, so the sweep is never a no-op and never boots from a visibly wrong frame.
 *
 * ── DERIVED FROM SPEAK'S POSITION, NOT FROM THE PILL COUNT (roborev 56312) ──────────────────────
 * This was `(TRAY_PILL_COUNT - 1) / TRAY_PILL_COUNT`, which is not a derivation at all — it silently
 * encodes "Speak is the LAST entry of SEND_MODES". The value's actual contract is *where the Speak
 * pill's left edge sits*, and the two agree only while that assumption holds. Append a fourth
 * position — the very scenario the pill-count fix was about — and Speak sits at index 2 of 4: this
 * would have returned 3/4 while its real left edge is at 2/4, booting the sweep a quarter of the
 * tray past its stop point on every frame before the first measurement.
 *
 * `indexOf` is equal to `(n-1)/n` today and stays correct for any ordering.
 */
export const DEFAULT_SPEAK_LEFT_FRAC = SEND_MODES.indexOf("speak") / SEND_MODES.length;

/**
 * Where the Speak pill's left edge sits, as a fraction of the box the sweep's `width: X%` resolves
 * against. **Both arguments must be in the SAME coordinate system.**
 *
 * The bug this replaces: the fraction was `offsetLeft / contentRect.width`. Those are different
 * boxes. `contentRect.width` EXCLUDES the tray's padding; `offsetLeft` is measured from the
 * offsetParent's PADDING EDGE, so it includes it; and an absolutely-positioned child's percentage
 * width resolves against the padding box too. The fraction came out inflated by
 * `(w + 2·pad)/w`, landing the leading edge a constant ~4px right of Speak's border edge at every
 * tray width — a visible sliver of the pill left unfilled at the one instant the geometry was
 * supposed to be exact (roborev 56219).
 *
 * Pure and exported because the measuring branch itself is unreachable in jsdom (`offsetLeft` is
 * always 0 there), so this is the only part of that path a test can pin.
 */
export function speakLeftFraction(offsetLeftPx: number, paddingBoxWidthPx: number): number {
  if (!(paddingBoxWidthPx > 0) || !(offsetLeftPx > 0)) return DEFAULT_SPEAK_LEFT_FRAC;
  return Math.min(1, offsetLeftPx / paddingBoxWidthPx);
}
