// ── THE EPIC CARD'S THREE TOKENS, MEASURED ─────────────────────────────────────────────────────
// The founder asked directly: "confirm the gold passes contrast against both card backgrounds."
// This is that confirmation, as an assertion rather than a claim in a PR body.
//
// It exists as its own file because the numbers here are the whole justification for the values
// chosen, and two of them are counter-intuitive enough that a future repaint will otherwise undo
// them believing it is tidying up:
//   1. The light epic card is NOT darker than an ordinary card. It cannot be — see below.
//   2. The pill is NOT `goldFill`, even though the founder said "gold", because that token is blue.
import { describe, expect, it } from "vitest";
import { C as BRAND } from "@sparkle/ui";
import { CONTROL_MIN_CONTRAST, INK_MIN_CONTRAST, CHROME_MIN_CONTRAST, THEME_HEX } from "./colors";

function luminance(hex: string): number {
  const ch = (i: number) => {
    const v = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(0) + 0.7152 * ch(1) + 0.0722 * ch(2);
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
/** CIE76 ΔE — the measure that CAN see a hue difference at equal lightness, which is exactly the
 *  thing a WCAG contrast RATIO is blind to and the thing light mode's epic card depends on. */
function deltaE(a: string, b: string): number {
  const lab = (hex: string): [number, number, number] => {
    const s = [0, 1, 2].map((i) => {
      const v = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    const [r, g, b] = s;
    const X = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
    const Y = r * 0.2126 + g * 0.7152 + b * 0.0722;
    const Z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
    const f = (t: number) => (t > (6 / 29) ** 3 ? Math.cbrt(t) : t / (3 * (6 / 29) ** 2) + 4 / 29);
    const [fx, fy, fz] = [f(X), f(Y), f(Z)];
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
  };
  const [A, B] = [lab(a), lab(b)];
  return Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2]);
}

const MODES = ["light", "dark"] as const;

describe("the epic card is legible and distinguishable in BOTH themes", () => {
  // The founder's actual ask, and the one an accessibility review would check first.
  it("the EPIC pill clears the control floor on the epic card it sits on", () => {
    for (const mode of MODES) {
      const hex = THEME_HEX[mode];
      expect(
        contrast(hex.epicPillFill, hex.epicCardFill),
        `${mode}: the EPIC pill does not survive its own card`,
      ).toBeGreaterThanOrEqual(CONTROL_MIN_CONTRAST);
    }
  });

  it("the pill's own ink clears the AA ink floor on the pill", () => {
    for (const mode of MODES) {
      const hex = THEME_HEX[mode];
      expect(
        contrast(hex.onEpicPillFill, hex.epicPillFill),
        `${mode}: EPIC label unreadable on its pill`,
      ).toBeGreaterThanOrEqual(INK_MIN_CONTRAST);
    }
  });

  // The card carries the SAME inks an ordinary card does — title in `cream`, description preview and
  // id in `muted`. A new fill that quietly costs `muted` its AA margin would make every epic card's
  // body text fail, which is the real risk of "just darken it a bit".
  it.each(["cream", "muted"] as const)("%s still clears AA on the epic card", (ink) => {
    for (const mode of MODES) {
      const hex = THEME_HEX[mode];
      expect(
        contrast(hex[ink], hex.epicCardFill),
        `${mode}: ${ink} fails AA on the epic card`,
      ).toBeGreaterThanOrEqual(INK_MIN_CONTRAST);
    }
  });

  // ── THE TWO MODES ARE HELD TO DIFFERENT MEASURES, ON PURPOSE ────────────────────────────────
  // Dark had luminance headroom, so it is held to the chrome step — a real guarantee.
  it("dark's epic card is a genuine LUMINANCE step off an ordinary card", () => {
    const hex = THEME_HEX.dark;
    expect(contrast(hex.epicCardFill, hex.forest)).toBeGreaterThanOrEqual(CHROME_MIN_CONTRAST);
  });

  // Light has none: `muted` on the ORDINARY light card measures ~4.76:1, a hair over AA. Darkening
  // the card at all pushes it under; lightening collapses it into the near-white column. So light
  // differentiates by HUE AT MATCHED LIGHTNESS and is held to ΔE instead. This assertion is the
  // reason the light value must not be "fixed" to look like the dark one.
  it("light's epic card differentiates by HUE, and a contrast ratio cannot see it", () => {
    const hex = THEME_HEX.light;
    expect(deltaE(hex.epicCardFill, hex.forest)).toBeGreaterThanOrEqual(6);
    expect(deltaE(hex.epicCardFill, hex.deepForest)).toBeGreaterThanOrEqual(6);
    // Stated so the next reader does not treat the low ratio as a defect: it is expected, and it is
    // WHY the ΔE assertion above is the one carrying the contract in this mode.
    expect(contrast(hex.epicCardFill, hex.forest)).toBeLessThan(CHROME_MIN_CONTRAST);
  });

  // Whatever else changes, the two card fills may never converge.
  it("the epic fill is never equal to the ordinary card fill", () => {
    for (const mode of MODES) {
      expect(THEME_HEX[mode].epicCardFill).not.toBe(THEME_HEX[mode].forest);
    }
  });

  // ── THE PILL IS WARM, AND THAT IS THE POINT ────────────────────────────────────────────────
  // The founder asked for GOLD. `goldFill` carries BLUE (Blueprint retired gold; chromeContrast
  // asserts those four tokens are blue-dominant). Pinning warmth here is what stops someone
  // "correcting" this pill onto the accent token and making it blue-on-blue against the epic card.
  it("the EPIC pill is WARM, not the blue that the `gold*` tokens now carry", () => {
    for (const mode of MODES) {
      const v = THEME_HEX[mode].epicPillFill;
      const [r, , b] = [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16)) as [number, number, number];
      expect(r, `${mode}.epicPillFill (${v}) is not warm`).toBeGreaterThan(b);
      expect(v.toLowerCase()).not.toBe(THEME_HEX[mode].goldFill.toLowerCase());
    }
  });

  // The measurement that forced the pill to be a themed PAIR rather than one constant: the brand
  // amber that works on dark FAILS the control floor on light's pale card. If this ever stops being
  // true the split can be revisited — until then, deleting it re-breaks light mode.
  it("a single constant amber could NOT have served both themes", () => {
    expect(contrast(BRAND.amber, THEME_HEX.dark.epicCardFill)).toBeGreaterThanOrEqual(
      CONTROL_MIN_CONTRAST,
    );
    expect(contrast(BRAND.amber, THEME_HEX.light.epicCardFill)).toBeLessThan(CONTROL_MIN_CONTRAST);
  });
});
