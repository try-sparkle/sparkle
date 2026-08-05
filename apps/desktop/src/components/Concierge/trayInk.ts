// WHAT THE SEND TRAY PAINTS, AS DATA — the wash percentages and the label-ink token for each of the
// pill's three paint states. A leaf module with no React and no store, for the same reason
// ./trayGeometry is one: a NODE-environment contrast test can read these constants without pulling
// the component (and its Tauri/store graph) in behind them.
//
// THE POINT OF THE INDIRECTION IS THAT THE GUARD CANNOT DRIFT. theme/sendModeTrayContrast.test.ts
// composites the real stack — plane → tray strip → pill fill — and asserts the label's WCAG ratio on
// it. If that test re-spelled `22` and `"cream"` as its own literals it would be a copy of the
// component, and copies go stale while staying green (the lesson ./trayGeometry records as roborev
// 56213). Both sides read THESE names instead, so changing a wash or an ink here re-measures the
// guard rather than quietly invalidating it.
//
// The tokens are NAMES, not values, because the component paints through `C` (var()-based, so a
// `data-theme` flip re-themes with no React render) while the test needs the resolved hex from
// THEME_HEX. A name is the one thing both can agree on.

/** The tray strip's own background: this much of its edge colour over whatever plane it sits on. */
export const TRAY_STRIP_TINT_PCT = 8;

/**
 * The SELECTED-BUT-IDLE pill's fill: this much of the position's identity colour over the strip.
 *
 * It is a WASH, not a solid — "fill differs from stroke" is the founder's rule for *selected but not
 * acting*, and the solid version of the same colour is what `acting` paints. See SendModeTray.
 */
export const TRAY_SELECTED_FILL_PCT = 22;

/**
 * The countdown SWEEP's wash — this much `successInk` over the tray, while Speak is counting.
 *
 * IT IS A THIRD LAYER UNDER EVERY LABEL, which is easy to miss and was: the sweep spans the whole
 * tray at `zIndex: 0` and the pills sit above it at `zIndex: 1` with a TRANSPARENT background when
 * unselected, so during a countdown the unselected labels are read on strip+sweep rather than on the
 * bare strip. The contrast guard composites it for that reason (roborev 59015).
 */
export const TRAY_SWEEP_TINT_PCT = 18;

/** The sweep's own colour, as a token — Speak's identity green, because the sweep is Speak's clock.
 *  Tokenized for the same reason the percentages are: the component painting `C.successInk` while
 *  the guard composited a hard-coded `"successInk"` is the identical drift hole one field over. */
export const TRAY_SWEEP_INK_TOKEN = "successInk" as const;

/** The three ways a pill can be painted. `acting` is a held Push-to-talk or a firing Speak/Send. */
export type PillPaintState = "unselected" | "selectedIdle" | "acting";

/** Token names in `C` / `THEME_HEX` — see the header for why these are names rather than values. */
export type InkToken = "conciergeMuted" | "cream" | "onGoldFill";

/**
 * WHICH INK THE LABEL IS DRAWN IN, per paint state.
 *
 * `selectedIdle` is `cream` — the plane's PRIMARY text ink — and deliberately NOT the position's
 * identity colour. Painting the label in the same hue as its own fill is what made the selected pill
 * the hardest of the three to read (amber-on-amber measured 1.95 in light mode, a WCAG AA failure);
 * it is also not fixed by copying `conciergeMuted`, because the fill moves the plate under the text
 * and a mid-tone ink loses contrast against it. Selection is carried by the fill and the border.
 *
 * `acting` inverts onto the solid fill, which is the one state that genuinely needs its own pairing.
 */
export const PILL_LABEL_TOKEN: Record<PillPaintState, InkToken> = {
  unselected: "conciergeMuted",
  selectedIdle: "cream",
  acting: "onGoldFill",
};

/** Token names for each position's identity colour — the border, and the base of the fill wash.
 *  Mirrors SendModeTray's `MODE_INK`, which reads this map. `amber` is brand-constant (not themed),
 *  which the contrast guard resolves via BRAND rather than THEME_HEX. */
export const MODE_INK_TOKEN = {
  send: "goldFill",
  ptt: "amber",
  speak: "successInk",
} as const;
