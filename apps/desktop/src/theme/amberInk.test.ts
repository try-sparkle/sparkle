// Amber as TEXT has to be themed, exactly as cyan/green/gray already are (accentInk, successInk,
// agentIdle). Brand amber #e0982f is a warm mid-tone, and the control that needs it — the presence
// slider's Away segment, the one thing telling the user the concierge may act alone — renders on
// the concierge composer's scrim, where the brand value clears AA in NEITHER theme (roborev
// 53631-M4, corrected by 53655-H).
//
// MEASURE THE PLATE THE CONTROL ACTUALLY SITS ON. That correction is the whole reason this file
// exists in its current form: the first cut measured the slider against `barSurface` — the
// BUILDER's chrome, a surface this component never touches — and certified AA for something that
// had it in neither theme. The stack is composited here from the SAME constants the components
// paint with (COMPOSE_SCRIM_PCT, CARD_WASH_PCT), so changing a wash re-measures these rows instead
// of leaving them quietly stale.
//
// The floor is WCAG AA for normal text. The slider's label is 11px and the recap card's project
// chip 9.5px — both far under the 18.66px "large text" threshold that would allow 3:1.
import { describe, expect, it } from "vitest";
import { C as BRAND } from "@sparkle/ui";
// COMPOSE_SCRIM_* are deliberately absent: the ComposeBox port landed, so the composer paints its
// own `--k-input` plate and there is no scrim left to composite. See `composerPlate` below, and
// note that pointing this at a token NOTHING paints is the mistake this file's header records —
// which is why the import went away only once the component actually moved.
import { CARD_WASH_PCT, PRESENCE_SEGMENT_TINT_PCT, THEME_HEX } from "./colors";

const AA_NORMAL = 4.5;

/** WCAG relative luminance of a #rrggbb string. */
function luminance(hex: string): number {
  const ch = (i: number) => {
    const v = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(0) + 0.7152 * ch(1) + 0.0722 * ch(2);
}

/** WCAG contrast ratio between two #rrggbb strings (1..21). */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** What an alpha wash — `color-mix(… n%, transparent)` or an `rgba()` scrim — actually LOOKS like
 *  once painted over an opaque surface: plain source-over compositing. */
function over(tint: string, pct: number, surface: string): string {
  const a = pct / 100;
  const part = (i: number) => {
    const t = parseInt(tint.slice(1 + i * 2, 3 + i * 2), 16);
    const s = parseInt(surface.slice(1 + i * 2, 3 + i * 2), 16);
    return Math.round(a * t + (1 - a) * s)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${part(0)}${part(1)}${part(2)}`;
}

type Theme = "dark" | "light";

/** ComposeBox has TWO plates, and modelling only one is how this file's own headline mistake comes
 *  back — measuring a control against a surface it may not be sitting on.
 *
 *  UNWIRED (`false`) the box is an inset `--k-input` box. It USED to be a 16% black scrim over the
 *  concierge column, which in light mode dropped `conciergeMuted` to 4.23 — under AA — on the box
 *  you type into. The approved direction does not scrim the composer at all: it gives the input its
 *  own surface (`--k-input`, white in light) with an `--k-input-edge` rule around it.
 *
 *  WIRED (`true`) the concierge is patched to a terminal and has FLOODED to the terminal's plane,
 *  so the composer goes transparent and every control in the row is read on `--k-term` instead —
 *  a completely different surface, and in light a considerably darker one. That state is
 *  reachable at the current operating point (`ConciergeColumn`'s `data-wired`), so both plates are
 *  measured below rather than one being assumed. */
const composerPlate = (t: Theme, wired = false) =>
  wired ? THEME_HEX[t].forest : THEME_HEX[t].inputSurface;

/** The Away segment when ACTIVE: the brand-amber segment tint on top of that plate. Every layer
 *  here comes from the constant the component paints with — including this one, which was the
 *  topmost and most influential wash and was still a literal in both places (roborev 53665-M). */
const awayFill = (t: Theme, wired = false) =>
  over(BRAND.amber, PRESENCE_SEGMENT_TINT_PCT, composerPlate(t, wired));

/** A concierge card's plate: its accent wash over the same column. */
const cardPlate = (t: Theme) => over(THEME_HEX[t].accentInk, CARD_WASH_PCT, THEME_HEX[t].conciergeSurface);

describe("amberInk — brand amber, made legible as text on the surface it is used on", () => {
  for (const theme of ["dark", "light"] as const) {
    it(`clears AA on the active Away segment in ${theme} mode`, () => {
      expect(contrast(THEME_HEX[theme].amberInk, awayFill(theme))).toBeGreaterThanOrEqual(
        AA_NORMAL,
      );
    });

  }

  // WHY THIS TOKEN STILL EXISTS, RESTATED AFTER THE BLACK-AND-GOLD REPAINT. It originally existed
  // because brand amber failed in BOTH themes (~3.6:1 dark, ~1.3:1 light) on the old mid-navy
  // concierge column. The repaint took `conciergeSurface` dark from #33477a to near-black #191d2d,
  // which lifted the dark plate's contrast with a warm mid-tone enough that brand amber now clears
  // AA there on its own. Light was untouched and is unchanged.
  //
  // So the justification is now LIGHT-ONLY — and it is emphatic (1.34:1, nowhere near the floor),
  // which is exactly why the token is kept rather than reverted: a single value cannot serve both
  // ends, and light has no margin to argue about. Asserted per-theme rather than as one blanket
  // claim, because a blanket claim is what went stale here.
  it("is REQUIRED in light: brand amber is nowhere near the floor there", () => {
    expect(contrast(BRAND.amber, awayFill("light"))).toBeLessThan(3);
  });

  it("is HEADROOM in dark: brand amber now clears AA there since the repaint", () => {
    // Bounded on both sides on purpose. The lower bound records that the repaint fixed dark; the
    // comparison records that the themed ink is still the better value, so if a future palette move
    // pushes brand back under the floor this row keeps its meaning instead of silently inverting.
    expect(contrast(BRAND.amber, awayFill("dark"))).toBeGreaterThanOrEqual(AA_NORMAL);
    expect(contrast(THEME_HEX.dark.amberInk, awayFill("dark"))).toBeGreaterThan(
      contrast(BRAND.amber, awayFill("dark")),
    );
  });

  it("stays in the amber family: lighter than brand in dark, darker in light", () => {
    // Away being AMBER is the point of the control — it is the state with consequences. The fix is
    // a luminance move within the hue, not a different color.
    expect(luminance(THEME_HEX.dark.amberInk)).toBeGreaterThan(luminance(BRAND.amber));
    expect(luminance(THEME_HEX.light.amberInk)).toBeLessThan(luminance(BRAND.amber));
  });
});

describe("the OTHER ink on the composer plate — muted text, no tint under it", () => {
  // Modelling the plate correctly for amber exposed a bigger miss on the same control: the INACTIVE
  // presence segment, the attach-row buttons and the attachment remove control are all
  // `conciergeMuted` with nothing tinting the plate under them. On the bare `conciergeSurface` that
  // ink clears AA (4.60:1 light / 5.83:1 dark) — which is why the column's ink was thought safe —
  // but the composer's scrim moves the surface out from under it in light mode.
  for (const theme of ["dark", "light"] as const) {
    it(`measures conciergeMuted on the composer plate in ${theme} mode`, () => {
      const ratio = contrast(THEME_HEX[theme].conciergeMuted, composerPlate(theme, false));
      // THE RESIDUAL IS CLOSED. It was bounded from above precisely so this row would go red
      // "the day someone fixes it properly" — the Blueprint repaint is that day. Light's planes
      // were re-derived so the column is the LIGHTEST plane rather than a mid grey, and the ink
      // moved with them, so `conciergeMuted` now clears AA on the composer's scrimmed plate in
      // both themes. The exception, and its upper bound, are gone rather than re-tuned.
      expect(ratio).toBeGreaterThanOrEqual(AA_NORMAL);
    });
  }
});

// ── THE COMPOSER'S OTHER PLATE: THE FLOOD ───────────────────────────────────────────────────────
// When the concierge is wired to a terminal it takes that terminal's colour, the composer goes
// transparent, and every control in the row is suddenly read on `--k-term`. The column sets the
// terminal INK register on itself, so anything inheriting follows — but the controls that name a
// concierge-register ink explicitly do not, and those are the ones measured here:
//
//   • `conciergeMuted` — the attach buttons, the attachment chips' ✕, the inactive presence segment
//   • `muted`          — the live interim dictation line
//   • `cream`          — a staged attachment chip's filename
//   • the ACTIVE Away segment's amber, composited over the flood instead of over `--k-input`
//
// None of these were measured when the wired state landed: `composerPlate` was unconditionally
// `inputSurface`, so the suite modelled one plate while the component could paint another. That is
// this file's own headline mistake, one state over, and the reason it is caught here rather than
// left to a screenshot is that a flood is a whole-surface change — every ink in the row moves at
// once, and none of it throws.
describe("every ink in the composer row, measured on the FLOOD it is read on when wired", () => {
  const INKS = ["conciergeMuted", "muted", "cream"] as const;

  for (const theme of ["dark", "light"] as const) {
    for (const ink of INKS) {
      it(`${ink} clears AA on the wired composer in ${theme} mode`, () => {
        expect(
          contrast(THEME_HEX[theme][ink], composerPlate(theme, true)),
          `${theme}: ${ink} is unreadable once the concierge floods to the terminal plane`,
        ).toBeGreaterThanOrEqual(AA_NORMAL);
      });
    }

    it(`the active Away segment clears AA on the wired composer in ${theme} mode`, () => {
      expect(contrast(THEME_HEX[theme].amberInk, awayFill(theme, true))).toBeGreaterThanOrEqual(
        AA_NORMAL,
      );
    });
  }

  // WHY THE ROWS ABOVE ARE NOT A DUPLICATE — and this corrects a claim I wrote from assumption a
  // moment before running it. I asserted the flood was "a genuinely different surface at both
  // ends"; in DARK it measures 1.111, which is no more of a step than any other pair in this
  // design. The asymmetry is the same one blueprintSpec.test.ts already records for bridge→term:
  // light steps a real amount onto the terminal, dark barely does.
  //
  // So the justification for the wired rows is LIGHT-ONLY, and it is emphatic there: the plate goes
  // from #ffffff to a mid blue-grey, which is a surface every ink in the row has to be re-measured
  // against. Dark's rows are near-neighbours of the unwired ones and are kept as regression guards
  // rather than as an independent claim. Stated per-theme, because a blanket claim is exactly what
  // went stale here.
  it("moves the plate FAR in light, which is what the wired rows are for", () => {
    expect(contrast(composerPlate("light", false), composerPlate("light", true))).toBeGreaterThan(
      1.15,
    );
  });

  it("…and barely moves it in dark, so those rows are a regression guard, not a new claim", () => {
    expect(contrast(composerPlate("dark", false), composerPlate("dark", true))).toBeLessThan(
      contrast(composerPlate("light", false), composerPlate("light", true)),
    );
  });
});

describe("the recap card's project chip", () => {
  for (const theme of ["dark", "light"] as const) {
    // THE RESIDUAL THIS ROW USED TO RECORD IS CLOSED. It previously bounded `conciergeMuted` on the
    // card between 4:1 and the AA floor (4.34 dark / 4.08 light) and stated the fix belonged to the
    // card's surface or the column's ink. The repaint did exactly that: `conciergeSurface` and
    // `conciergeMuted` both moved, and the chip now clears AA in both themes with no change here.
    // The row is kept as a REGRESSION guard rather than deleted — this chip is 9.5px, the smallest
    // ink the column paints, so it is the first thing a future palette nudge will push back under.
    it(`clears AA in ${theme} mode as conciergeMuted`, () => {
      expect(contrast(THEME_HEX[theme].conciergeMuted, cardPlate(theme))).toBeGreaterThanOrEqual(
        AA_NORMAL,
      );
    });
  }

  // The chip is NOT brand amber, and the reason is now light-only — the same asymmetry the Away
  // segment has. In dark the repaint left brand amber comfortably legible on the card (better than
  // the muted ink, in fact); in light it is 1.84:1. One constant cannot serve both, so the chip
  // takes the themed muted ink and amber stays on the border, where it is a fill rather than ink.
  it("would fail in light as brand amber, which is why the chip is not amber", () => {
    expect(contrast(BRAND.amber, cardPlate("light"))).toBeLessThan(3);
  });
});
