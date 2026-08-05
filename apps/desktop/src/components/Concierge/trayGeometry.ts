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
import { SPACE } from "../../theme/scale";
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
  /** Padding in the TIGHT word tier — a step spent to keep whole words rather than truncate. */
  pillPadXTight: 3,
  /** Padding at the FLOOR tier, where the pills stack. Two px rather than three so a whole word
   *  still clears its box at a 50px column: "Speak" is 31.7px at `TYPE.micro`, and 31.7 + 4 + 3 =
   *  38.7 fits the ~40px the composer has there, where 3px padding would need 40.7 and cut it fine. */
  pillPadXFloor: 2,
  /** The same padding in the ICON tier. Tighter, because at that point the padding is competing
   *  with the glyph for a column that may be 50px wide — and 8px per side across three pills is
   *  48px of the ~30px the composer actually has there. Only reached below
   *  `TRAY_ICON_ONLY_MAX_PX`, where there is no text for the padding to breathe around anyway. */
  pillPadXIcon: 2,
  /** Each pill's border, per side. Counts toward width under `box-sizing: border-box`. */
  pillBorder: 1.5,
  /**
   * A pill's VERTICAL padding, above and below the word — and the only thing that sets the tray's
   * height (see `SendModeTray`, which declares no height of its own).
   *
   * ── WHY THE TRAY MUST NOT STATE ITS OWN HEIGHT ────────────────────────────────────────────────
   * It used to: `minHeight: 42` on the tray, `height: "100%"` on the pills. Those are two
   * independent claims about one measurement, and they disagreed — a percentage height against an
   * auto-height flex parent is not a stretch instruction, so the pills sized to their content while
   * the tray held itself open at 42, leaving the dead band under the words the founder reported
   * three times: "the tray should be the same height as the button. There shouldn't be space below
   * the button. It looks weird that way."
   *
   * The fix he asked for, twice, and in this direction specifically: "let's just make the buttons
   * taller inside the container and keep the container about the same size." So the pill's padding
   * is the ONE input, the tray hugs it, and there is no second number that can drift out of step
   * with the first. A tray that cannot name a height cannot be taller than what it contains.
   *
   * `SPACE.nav` is 10 — the founder's own figure ("10 pixels above and 10 pixels below the word")
   * and an existing value in the approved spec (`--sp-navitem` axis 2), not a number invented here.
   */
  pillPadY: SPACE.nav,
  /** Gap between a pill's label and its keycap slot. */
  pillGap: 6,
  /** The keycap slot, reserved in BOTH states so nothing shifts when the chiclet appears. */
  chicletSlot: 30,
  /** The tray's own border, per side. Part of its chrome, alongside `trayPad`. */
  trayBorder: 1,
} as const;

/**
 * The horizontal room a CENTRED label must leave free on EACH side for the keycap to sit clear.
 *
 * The chiclet is justified right and drawn OUT OF FLOW (see `SendModeTray`), so it costs the label
 * no width — but a label centred in the whole pill grows toward BOTH edges at once, and it is the
 * right-hand edge that meets the keycap. Hence the doubling in `fullLabelsFitAtPx`: clearance on the
 * right is what the founder asked for ("some distance between the word and the keyboard shortcut
 * chiclet"), and the matching space on the left is not spare — it is what centring the word costs.
 */
export const chicletClearancePx = TRAY_GEOMETRY.chicletSlot + TRAY_GEOMETRY.pillGap;

/**
 * The widest full label's rendered width, in px, at `TYPE.small`.
 *
 * MEASURED, not estimated. This was 86 — the larger of two eyeballed readings, taken as the
 * "pessimistic" choice — and the pessimism had a cost: every threshold derived from it sat ~15px
 * high, pushing the user into a lower tier at widths where the words actually fit. Measured in real
 * WebKit (the WKWebView engine) at 12px: "Push to talk" is 69.7px semibold and **71.3px bold** —
 * bold being the selected state, i.e. the wider one. Rounded up to 72.
 *
 * jsdom cannot lay out, so this cannot be measured by the unit suite — but it CAN be measured, with
 * a headless WebKit page. Re-measure that way rather than guessing if the font or the scale moves.
 */
export const WIDEST_LABEL_PX = 72;

/**
 * The tray width at which the `full` tier fits — full labels, CENTRED, with the keycap clear of them.
 *
 * ── ONE COORDINATE SYSTEM: contentRect ──────────────────────────────────────────────────────────
 * The measured quantity this is compared against is the ResizeObserver's `contentRect.width`, which
 * EXCLUDES the tray's own padding. So `trayPad` must NOT appear here. An earlier version added
 * `2 * trayPad` (+6) while omitting `2 * pillBorder` per pill (−9); the two errors partially
 * cancelled, which is precisely why the result still landed on a plausible-looking 428 and the guard
 * stayed green. Mixing boxes is not a rounding error — it is two bugs hiding each other.
 *
 * ── WHY THE CLEARANCE IS DOUBLED (and why this number GREW from 389 to 497) ─────────────────────
 * The keycap used to be an in-flow sibling of the label: `[label][gap][30px slot]`, the pair centred
 * together. That is precisely the defect the founder diagnosed himself — the word and the chiclet
 * were "what is centering", which pushes the WORD left of centre by half the slot, and at rest,
 * with no chiclet drawn, the word is the only thing on the pill. So the slot left the flow and the
 * label is now centred alone.
 *
 * Out of flow, the slot costs the label no width — but centring changes which inequality binds. A
 * centred label spends its free space symmetrically, so keeping the keycap clear of the word's RIGHT
 * edge means reserving the same distance on the LEFT, whether or not anything is drawn there. Hence
 * `2 *`. Getting this wrong is not cosmetic: with the old one-sided budget the widest label ("Push
 * to talk", 72px) overruns the keycap by ~3px at the bottom of this tier — a word touching the chip
 * it is supposed to sit clear of, in the one state the founder is looking at when he hovers.
 */
export function fullLabelsFitAtPx(): number {
  const g = TRAY_GEOMETRY;
  const perPill = 2 * g.pillPadX + 2 * g.pillBorder + 2 * chicletClearancePx;
  // `(n - 1)` gaps, never a hardcoded 2, so the pill count and the gap count cannot disagree.
  return TRAY_PILL_COUNT * (WIDEST_LABEL_PX + perPill) + (TRAY_PILL_COUNT - 1) * g.trayGap;
}

/**
 * The CLEAR SPACE between the widest centred label and the keycap beside it, at a given tray width.
 * Negative means they overlap.
 *
 * Exported rather than left as arithmetic in a test, for this module's documented reason: a test
 * that re-spells the geometry is a copy that goes stale while staying green (roborev 56213). It
 * takes the ResizeObserver's `contentRect.width` — the same coordinate system as every threshold
 * above — and works back to one pill: the pills are `flex: 1`, so they share the width evenly minus
 * the inter-pill gaps, and a centred label leaves half the remainder on each side.
 *
 * The founder asked for this space by name — the keycap should have "some distance between the word
 * and the keyboard shortcut chiclet" — so it is a quantity worth being able to state, not just a
 * by-product of a threshold. At `fullLabelsFitAtPx()` it comes out to exactly `pillGap`.
 */
export function wordToKeycapGapPx(trayContentWidthPx: number): number {
  const g = TRAY_GEOMETRY;
  const pillOuter =
    (trayContentWidthPx - (TRAY_PILL_COUNT - 1) * g.trayGap) / TRAY_PILL_COUNT;
  const pillContent = pillOuter - 2 * g.pillPadX - 2 * g.pillBorder;
  return (pillContent - WIDEST_LABEL_PX) / 2 - g.chicletSlot;
}

/**
 * The widest SHORT label's rendered width, in px, at `TYPE.small`.
 *
 * "Speak" is the longest of `SEND_MODE_LABEL_SHORT` at five characters. Derived from
 * `WIDEST_LABEL_PX` rather than guessed independently, so the two estimates cannot drift: that is a
 * 12-character string ("Push to talk") measured pessimistically at 86px, i.e. ~7.2px per character,
 * and 5 characters at that rate is ~36px. Rounded UP to 38 for the same reason `WIDEST_LABEL_PX`
 * takes the larger of its two readings — erring wide costs an icon shown a notch early, erring
 * narrow costs a silently clipped word, which is the exact defect this tier exists to delete.
 */
export const WIDEST_SHORT_LABEL_PX = 38;

/** An icon-only pill's glyph box, in px. RETAINED ONLY FOR THE MIC/CHICLET SLOTS — the tray itself
 *  no longer has an icon tier; see `wordPillMinPx`. */
export const TRAY_ICON_PX = 16;

/** "Speak" at the FLOOR tier's smaller type: 31.7px measured in WebKit at 10px bold, rounded up. */
export const WIDEST_SHORT_LABEL_TIGHT_PX = 32;

/**
 * WHAT EACH RUNG ACTUALLY NEEDS — derived, so the ladder cannot disagree with the pills again.
 *
 * ── THE BUG THIS CLOSES ────────────────────────────────────────────────────────────────────────
 * The ladder's thresholds shipped as bare literals in voice/sendMode (281 / 179 / 131), computed by
 * hand from label widths that were RE-MEASURED at the same time — but only the thresholds were
 * ported, not the measurements. Main kept `WIDEST_LABEL_PX = 86` and `WIDEST_SHORT_LABEL_PX = 44`
 * (eyeballed, deliberately pessimistic), against which `fullTight` really needs 323 and `short`
 * really needs 197. Both were set BELOW that, so between 281–323px and 179–197px the ladder selected
 * a label that does not fit and the founder's "Se… Pu… Sp…" was still reachable.
 *
 * Two things went wrong and both are fixed here: the measured widths are now the ones that ship
 * (71.3px and 37.4px in WebKit at 12px bold, rounded up), and the thresholds are DERIVED from them
 * rather than restated, so a change to any pill constant moves the ladder with it. A hand-copied
 * bound going stale while its guard stays green is this module's documented recurring failure
 * (roborev 56213/56223/56301) — this was the same shape, one file over.
 */
export function trayFullNoChicletMinPx(): number {
  const g = TRAY_GEOMETRY;
  return (
    TRAY_PILL_COUNT * (WIDEST_LABEL_PX + 2 * g.pillPadX + 2 * g.pillBorder) +
    (TRAY_PILL_COUNT - 1) * g.trayGap
  );
}

export function trayShortNoChicletMinPx(): number {
  const g = TRAY_GEOMETRY;
  return (
    TRAY_PILL_COUNT * (WIDEST_SHORT_LABEL_PX + 2 * g.pillPadX + 2 * g.pillBorder) +
    (TRAY_PILL_COUNT - 1) * g.trayGap
  );
}

export function trayShortTightMinPx(): number {
  const g = TRAY_GEOMETRY;
  return (
    TRAY_PILL_COUNT * (WIDEST_SHORT_LABEL_TIGHT_PX + 2 * g.pillPadXTight + 2 * g.pillBorder) +
    (TRAY_PILL_COUNT - 1) * g.trayGap
  );
}

/** What the tray needs for the SHORT words once the keycap slot is dropped. Measured: 179. */
export function shortLabelsNoChicletFitAtPx(): number {
  const g = TRAY_GEOMETRY;
  const perPill = 2 * g.pillPadX + 2 * g.pillBorder;
  return TRAY_PILL_COUNT * (WIDEST_SHORT_LABEL_PX + perPill) + (TRAY_PILL_COUNT - 1) * g.trayGap;
}

/** …and with tighter padding plus one on-scale type step down. Measured: 131. */
export function shortLabelsTightFitAtPx(): number {
  const g = TRAY_GEOMETRY;
  const perPill = 2 * g.pillPadXTight + 2 * g.pillBorder;
  return (
    TRAY_PILL_COUNT * (WIDEST_SHORT_LABEL_TIGHT_PX + perPill) + (TRAY_PILL_COUNT - 1) * g.trayGap
  );
}

/**
 * The width of ONE floor-tier pill — the point below which the tray WRAPS rather than squeezing.
 *
 * ── THE WORDS NEVER GIVE WAY ───────────────────────────────────────────────────────────────────
 * The founder, after seeing the icon tier: "I don't see the words Send, Push, and Speak. It just
 * says Se..., Pu..., Sp.... I want to see the entire words Send, Push, Speak when the column is not
 * in its very wide open state."
 *
 * Measured in WebKit, they always fit: at every column from 500px down to the 50px floor, three
 * WHOLE words render with zero truncation and zero overflow — because the tray WRAPS them onto two
 * rows and then three instead of squeezing them onto one. So there is no icon tier at all.
 *
 * Giving the pills this as a floor is the mechanism: a flex item may shrink to its `min-width` and
 * no further, so once three cannot share a line, ONE DROPS TO THE NEXT ROW instead of every label
 * ellipsising together.
 */
export function wordPillMinPx(): number {
  const g = TRAY_GEOMETRY;
  return WIDEST_SHORT_LABEL_TIGHT_PX + 2 * g.pillPadXFloor + 2 * g.pillBorder;
}

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
