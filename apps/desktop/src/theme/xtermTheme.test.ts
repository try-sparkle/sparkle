// Calm is a TERMINAL THEME, not a CSS filter over the pane (roborev 46254-M2/M3). These pin the
// two properties that made the change worth making: the calm palette actually flattens the text
// colors, and nothing about the calm state touches the background — the pane's chrome, the
// onboarding empty states and the fixed overlays inside the stage are no longer collateral.
import { describe, expect, it } from "vitest";
import { CALM_MIN_CONTRAST, CALM_MIN_SPLIT, THEME_HEX, xtermTheme } from "./colors";

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

// The floors live in colors.ts next to the palette they constrain, so the values and the rule
// can't drift apart (roborev 46485-L).

describe("xtermTheme calm", () => {
  it("keeps the ordinary palette when not calm", () => {
    const t = xtermTheme("dark");
    expect(t.foreground).not.toBe(xtermTheme("dark", true).foreground);
    // Un-calm leaves the ANSI slots to xterm's defaults (only the light-mode blue override sets any).
    expect(t.red).toBeUndefined();
  });

  it("flattens hue but PRESERVES luminance ordering (dark slots dark, bright slots light)", () => {
    // roborev 46341: collapsing all 16 slots onto one gray made colored-BACKGROUND cells
    // (diff hunks, selected rows) unreadable. Two grays per theme keep text-over-fill contrast.
    const t = xtermTheme("dark", true);
    const dim = new Set([t.black, t.red, t.green, t.yellow, t.blue, t.magenta, t.cyan, t.white]);
    const bright = new Set([t.brightRed, t.brightGreen, t.brightYellow, t.brightBlue]);
    expect(dim.size).toBe(1);
    expect(bright.size).toBe(1);
    expect([...dim][0]).not.toBe([...bright][0]);
  });

  it("calm inks are THEME-INDEXED: light mode gets its own grays, not the navy prototype's", () => {
    // roborev 46341: the prototype's grays were picked against navy; on light mode's white they
    // fall to ~3.9:1 and its bright slots worse.
    const dark = xtermTheme("dark", true);
    const light = xtermTheme("light", true);
    expect(light.foreground).not.toBe(dark.foreground);
    // A readable selection while calm, in both modes.
    expect(light.selectionForeground).toBeTruthy();
    expect(dark.selectionForeground).toBeTruthy();
  });

  it("EVERY calm ink clears 3:1 against its own theme's background (roborev 46485-M)", () => {
    // The regression this replaces: `dim` was chosen relative to the OTHER calm ink ("recede
    // toward the background") and reached 2.1:1 in dark; light's `bright` reached 2.05:1 on
    // white. Both were worse than the single #7d818e they replaced. Numeric, not inequality —
    // an inequality assertion is exactly what let it through.
    for (const mode of ["light", "dark"] as const) {
      const t = xtermTheme(mode, true);
      const bg = THEME_HEX[mode].forest;
      const inks: Record<string, string | undefined> = {
        foreground: t.foreground,
        cursor: t.cursor,
        dim: t.red, // stands for every dark ANSI slot (all one value — asserted above)
        bright: t.brightRed, // stands for every bright ANSI slot
      };
      for (const [name, ink] of Object.entries(inks)) {
        expect(ink, `${mode}.${name} is set`).toBeTruthy();
        expect(
          contrast(ink!, bg),
          `${mode}.${name} (${ink}) on ${bg} must clear ${CALM_MIN_CONTRAST}:1`,
        ).toBeGreaterThanOrEqual(CALM_MIN_CONTRAST);
      }
      // The selection ink has one job — contrast over the selection FILL, not over the terminal
      // background — so it is measured against that (roborev 46485-L: it had only toBeTruthy()).
      expect(
        contrast(t.selectionForeground!, t.selectionBackground),
        `${mode}.selectionForeground on the selection fill`,
      ).toBeGreaterThanOrEqual(CALM_MIN_CONTRAST);
    }
  });

  it("keeps the two calm LEVELS apart, which is why there are two (roborev 46485-M)", () => {
    // Anchoring both levels to the background is not enough on its own: raising `dim` to clear the
    // background floor once crushed bright↔dim to 1.78:1 (dark) / 1.53:1 (light), collapsing the
    // painted-fill legibility the split exists for — while the comment still claimed it held.
    // A numeric floor makes that trade-off a decision instead of a drift.
    for (const mode of ["light", "dark"] as const) {
      const t = xtermTheme(mode, true);
      expect(
        contrast(t.brightRed!, t.red!),
        `${mode} bright (${t.brightRed}) over a dim-painted cell (${t.red})`,
      ).toBeGreaterThanOrEqual(CALM_MIN_SPLIT);
      // Bright is the lighter of the pair in BOTH themes (in light mode the dark ANSI slots read
      // darker, so "dim" is the higher-contrast one — the ordering is by luminance, not contrast).
      expect(luminance(t.brightRed!)).toBeGreaterThan(luminance(t.red!));
    }
  });

  it("wins over the light-mode blue legibility override", () => {
    // The override exists so TUI headings stay readable on white; while calm, it is one of the
    // colors being flattened. Order in the object literal is what enforces this.
    const t = xtermTheme("light", true);
    expect(t.blue).not.toBe(xtermTheme("light").blue);
    expect(t.brightBlue).not.toBe(xtermTheme("light").brightBlue);
  });

  it("never changes the background — calm recedes the TEXT, it does not gray the pane", () => {
    for (const mode of ["light", "dark"] as const) {
      expect(xtermTheme(mode, true).background).toBe(xtermTheme(mode).background);
      expect(xtermTheme(mode, true).selectionBackground).toBe(xtermTheme(mode).selectionBackground);
    }
  });
});
