// Calm is a TERMINAL THEME, not a CSS filter over the pane (roborev 46254-M2/M3). These pin the
// two properties that made the change worth making: the calm palette actually flattens the text
// colors, and nothing about the calm state touches the background — the pane's chrome, the
// onboarding empty states and the fixed overlays inside the stage are no longer collateral.
import { describe, expect, it } from "vitest";
import {
  CALM_MIN_CONTRAST,
  CALM_MIN_SPLIT,
  TERM_ANSI_INKS,
  TERM_ANSI_MIN_CONTRAST,
  TERM_ANSI_MIN_SPLIT,
  TERM_ANSI_PAPER,
  TERM_PAPER_MIN_SPLIT,
  THEME_HEX,
  termMinContrastRatio,
  xtermTheme,
} from "./colors";

/** The sixteen ANSI slots, and the eight normal↔bright pairs they form. */
const ANSI_PAIRS = [
  ["black", "brightBlack"],
  ["red", "brightRed"],
  ["green", "brightGreen"],
  ["yellow", "brightYellow"],
  ["blue", "brightBlue"],
  ["magenta", "brightMagenta"],
  ["cyan", "brightCyan"],
  ["white", "brightWhite"],
] as const;
const ANSI_SLOTS = ANSI_PAIRS.flat();

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

  it("wins over the light-mode ANSI legibility palette", () => {
    // The palette exists so a TUI's coloured tokens stay readable on the light plane; while calm,
    // every one of them is flattened. Order in the object literal is what enforces this.
    const t = xtermTheme("light", true);
    for (const slot of ANSI_SLOTS) {
      expect(t[slot], `calm must flatten light.${slot}`).not.toBe(xtermTheme("light")[slot]);
    }
  });

  it("never changes the background — calm recedes the TEXT, it does not gray the pane", () => {
    for (const mode of ["light", "dark"] as const) {
      expect(xtermTheme(mode, true).background).toBe(xtermTheme(mode).background);
      expect(xtermTheme(mode, true).selectionBackground).toBe(xtermTheme(mode).selectionBackground);
    }
  });
});

// ── THE LIGHT-MODE ANSI PALETTE ────────────────────────────────────────────────────────────────
//
// The regression this replaces shipped for as long as light mode has existed: the theme handed
// xterm.js its DEFAULT (Tango, dark-tuned) palette and overrode two of the sixteen slots. Eleven
// defaults failed AA on the light terminal background and so did the override — brightWhite at
// 1.11:1, brightYellow 1.04:1, brightCyan 1.24:1, brightGreen 1.25:1, white 1.13:1, brightBlue
// 2.14:1, and the `blue`/`brightBlue` "fix" itself at 3.48:1. That is a TUI's paths, filenames and
// table cells rendered near-invisible.
//
// These assertions are NUMERIC and computed from the shipped hex, per the note in colors.ts: the
// previous generation of this guard asserted inequalities ("bright is lighter than dim"), and an
// inequality is exactly what a washed-out palette satisfies. A test that only checked hex values
// would also be worthless here — the hex can be correct against the wrong background, and the
// background is the whole point.
//
// AND THE BACKGROUND IS NOT ONLY THE PLANE. The first cut of this palette measured every slot as a
// foreground on the terminal plane, passed all four of its assertions, and shipped `\e[44;37m`
// (blue bg / white fg) at 1.00:1 — because `\e[4Xm` makes a slot a CELL FILL and nothing here
// looked at that direction. Both directions are measured now, and the ink/paper split those
// measurements forced is described in colors.ts.
describe("xtermTheme light-mode ANSI palette", () => {
  const light = xtermTheme("light");
  const bg = THEME_HEX.light.forest;
  const paper = TERM_ANSI_PAPER.map((s) => light[s]!);

  it("sets EVERY one of the sixteen slots — not the two the old override patched", () => {
    for (const slot of ANSI_SLOTS) {
      expect(light[slot], `light.${slot} must be pinned, not left to xterm's dark-tuned default`)
        .toMatch(/^#[0-9a-f]{6}$/);
    }
    // The two registers together are exactly the sixteen — no slot silently ungoverned.
    expect([...TERM_ANSI_INKS, ...TERM_ANSI_PAPER].sort()).toEqual([...ANSI_SLOTS].sort());
  });

  it("INK slots clear AA as text on the terminal plane and on the selection fill", () => {
    // The selection matters separately: a slot measured only against the plane can still vanish the
    // moment the user drags a selection over it, because the fill is a different surface.
    for (const slot of TERM_ANSI_INKS) {
      const ink = light[slot]!;
      expect(
        contrast(ink, bg),
        `light.${slot} (${ink}) as text on the terminal background ${bg}`,
      ).toBeGreaterThanOrEqual(TERM_ANSI_MIN_CONTRAST);
      expect(
        contrast(ink, light.selectionBackground),
        `light.${slot} (${ink}) as text on the selection fill ${light.selectionBackground}`,
      ).toBeGreaterThanOrEqual(TERM_ANSI_MIN_CONTRAST);
    }
  });

  it("INK slots work as CELL FILLS — paper stays readable on top (`\\e[44;37m`)", () => {
    // THE 1.00:1 REGRESSION. A TUI paints a coloured background and puts its light foreground on
    // top: selected rows, status bars, diff hunks. Every ink slot must therefore carry both paper
    // tones, not merely read well on the plane.
    for (const slot of TERM_ANSI_INKS) {
      for (const p of paper) {
        expect(
          contrast(p, light[slot]!),
          `paper ${p} on a light.${slot} (${light[slot]}) cell fill`,
        ).toBeGreaterThanOrEqual(TERM_ANSI_MIN_CONTRAST);
      }
    }
  });

  it("PAPER slots work as CELL FILLS — dark ink stays readable on top (`\\e[47;30m`)", () => {
    // The other half of the same idiom, and the one that caught `white` at 1.71:1. `black` is what
    // a TUI pairs with a white background; `theme.foreground` is what an unstyled cell uses.
    for (const slot of TERM_ANSI_PAPER) {
      for (const ink of [light.black!, light.foreground]) {
        expect(
          contrast(ink, light[slot]!),
          `${ink} on a light.${slot} (${light[slot]}) paper fill`,
        ).toBeGreaterThanOrEqual(TERM_ANSI_MIN_CONTRAST);
      }
    }
  });

  it("the FILL contract is PAPER-on-ink — and black-on-hue provably cannot join it", () => {
    // THE THIRD DIRECTION. `\e[3Xm` over `\e[4Xm` is an ink on an ink, and the two assertions above
    // (paper-on-ink, ink-on-paper) do not cover it: `\e[42;30m` measures 1.71:1 on this palette.
    // That is a real idiom (`chalk.bgGreen.black`), so it is recorded rather than left to be found.
    //
    // It is the same forced choice the paper pair faces. Rather than assert a hardcoded "this is
    // 1.71:1" — which pins a symptom and would have to be re-typed on every retune — this
    // RE-DERIVES the impossibility from the shipped plane. If the terminal plane ever darkens
    // enough that a hue could both read as text AND carry black, this fails and the decision gets
    // re-made deliberately instead of silently inherited.
    const needed = TERM_ANSI_MIN_CONTRAST * (luminance(light.black!) + 0.05) - 0.05;
    const allowed = (luminance(bg) + 0.05) / TERM_ANSI_MIN_CONTRAST - 0.05;
    expect(
      needed,
      `a hue needs luminance >= ${needed.toFixed(4)} to carry black at AA but <= ${allowed.toFixed(4)} to read on the plane — if this ever inverts, re-decide whether the hues are inks or fills`,
    ).toBeGreaterThan(allowed);

    // Given that, the contract the palette DOES keep: every ink fill carries a paper foreground.
    // (Asserted above too; restated here as the positive half of this decision, so a reader of
    // this test sees what black-on-hue is being traded FOR.)
    for (const slot of TERM_ANSI_INKS) {
      const best = Math.max(...paper.map((p) => contrast(p, light[slot]!)));
      expect(best, `light.${slot} must carry at least one paper tone`).toBeGreaterThanOrEqual(
        TERM_ANSI_MIN_CONTRAST,
      );
    }
  });

  it("PAPER is actually paper — lighter than the plane, so a `\\e[47m` cell reads as a page", () => {
    // Without this, "paper" could satisfy every fill assertion above by being pure white on a pure
    // white plane, i.e. an invisible cell. It also pins the direction: paper is the LIGHT register.
    for (const slot of TERM_ANSI_PAPER) {
      expect(
        luminance(light[slot]!),
        `light.${slot} (${light[slot]}) must be lighter than the plane ${bg}`,
      ).toBeGreaterThan(luminance(bg));
    }
  });

  it("keeps each slot tellable from its bright counterpart", () => {
    // Both halves clearing the same floor is what makes this necessary: satisfying AA alone would
    // be satisfied by sixteen identical inks, which is not a palette. The paper pair gets the
    // looser floor for the reason stated in colors.ts — both are paper by construction.
    for (const [normal, bright] of ANSI_PAIRS) {
      const floor = normal === "white" ? TERM_PAPER_MIN_SPLIT : TERM_ANSI_MIN_SPLIT;
      expect(
        contrast(light[normal]!, light[bright]!),
        `light.${normal} (${light[normal]}) vs light.${bright} (${light[bright]})`,
      ).toBeGreaterThanOrEqual(floor);
    }
  });

  it("makes `bright` the lighter half in every one of the eight pairs", () => {
    // No exception any more. The first cut inverted `white`/`brightWhite` to keep sixteen readable
    // INKS; once the paper pair stopped being ink, the inversion it required went away with it.
    for (const [normal, bright] of ANSI_PAIRS) {
      expect(
        luminance(light[bright]!),
        `light.${bright} should be the lighter of the ${normal} pair`,
      ).toBeGreaterThan(luminance(light[normal]!));
    }
  });

  it("light mode asks xterm to enforce AA on colours the palette cannot name", () => {
    // THE SECOND REPORT. Pinning the sixteen slots fixed `\e[3Xm` colours, but a terminal LINK — a
    // path, a URL, an OSC 8 word — is drawn in whatever colour the emitter picked, and xterm has no
    // link colour to override. When that colour comes from the 256-colour CUBE this palette never
    // sees it: `\e[38;5;215m` is 1.41:1 and `\e[38;5;242m` is 4.06:1 on this plane, and the TUI in
    // this app emits both. `minimumContrastRatio` is xterm's own per-cell fix and covers the cube
    // AND truecolor while leaving backgrounds alone. It defaults to 1 ("do nothing") — which is
    // exactly what it was, silently, so this pins the value rather than trusting the default.
    expect(termMinContrastRatio("light")).toBe(TERM_ANSI_MIN_CONTRAST);
    // Dark keeps xterm's untouched behaviour: not the report, and its defaults already clear AA.
    expect(termMinContrastRatio("dark")).toBe(1);
    expect(termMinContrastRatio("dark", true)).toBe(1);
  });

  it("never rewrites a calm relationship the palette was TUNED for", () => {
    // roborev 56210-M1. The first cut indexed on the theme alone, and light mode has a SECOND
    // palette: CALM is built below AA deliberately (CALM_MIN_CONTRAST 3, CALM_MIN_SPLIT 2) so a
    // recessive agent's output stays flat. A blanket 4.5 would have dragged calm's `bright` up from
    // 2.14:1 over a `dim`-painted cell — and `calmAnsi` points black…brightBlack at `dim`, so every
    // diff hunk and selected row a TUI paints while calm, which is the DEFAULT state for a working
    // agent. This measures the actual hex: a DESIGNED calm pair under the floor is one xterm
    // rewrites, i.e. a calm colour silently overridden.
    //
    // LIGHT ONLY, on purpose (roborev 56774-M2): dark's calm floor is 1, and `contrast()` is ≥ 1
    // by construction, so a dark iteration here asserts nothing — it would pass for two identical
    // hexes. Dark's calm palette is floored by the CALM_MIN_CONTRAST / CALM_MIN_SPLIT tests above,
    // which are the ones that can actually fail.
    const floor = termMinContrastRatio("light", true);
    const t = xtermTheme("light", true);
    const plane = THEME_HEX.light.forest;
    // Exactly the two contracts the CALM block states, plus the selection ink's own one.
    const designed: Array<[string, string, string]> = [
      ["foreground on the plane", t.foreground, plane],
      ["dim on the plane", t.red!, plane],
      ["bright on the plane", t.brightRed!, plane],
      ["bright over a dim-painted cell", t.brightRed!, t.red!],
      ["selection ink over the selection fill", t.selectionForeground!, t.selectionBackground],
    ];
    for (const [what, fg, bg] of designed) {
      expect(
        contrast(fg, bg),
        `light calm: ${what} (${fg} on ${bg}) must clear the ${floor}:1 handed to xterm, or the adjuster rewrites a tuned colour`,
      ).toBeGreaterThanOrEqual(floor);
    }
  });

  it("DOES lift the calm combinations the palette never designed — that is its job", () => {
    // roborev 56774-M1: an earlier comment claimed the adjuster never fires while calm. False, and
    // the claim mattered — two grays across sixteen slots necessarily produce pairs nobody tuned,
    // and the worst are degenerate. Pinning them from BELOW is what makes the rule above honest:
    // these are under the floor, so xterm lifts them, and that is the net doing the job it exists
    // for rather than overriding calm.
    const floor = termMinContrastRatio("light", true);
    const t = xtermTheme("light", true);
    const undesigned: Array<[string, string, string]> = [
      // A TUI paints a status bar from a BRIGHT slot and leaves the foreground default.
      ["default ink over a bright-painted cell", t.foreground, t.brightRed!],
      // `\e[44m\e[37m` — white on blue. Both collapse onto `dim`, so fg IS bg: invisible.
      ["a dark slot on a dark-slot fill", t.white!, t.blue!],
      ["a bright slot on a bright-slot fill", t.brightWhite!, t.brightBlue!],
    ];
    for (const [what, fg, bg] of undesigned) {
      expect(
        contrast(fg, bg),
        `light calm: ${what} (${fg} on ${bg}) is a pair calm never tuned — it should sit UNDER the ${floor}:1 floor so xterm rescues it`,
      ).toBeLessThan(floor);
    }
    // The degenerate ones really are fg == bg, which is what makes them unreadable rather than dim.
    expect(t.white).toBe(t.blue);
    expect(t.brightWhite).toBe(t.brightBlue);
  });

  it("still nets the cube while CALM — flattening the sixteen does not reach it", () => {
    // The other half of the same decision: the calm floor is LOWER, not off. `calmAnsi` rewrites
    // only the sixteen NAMED slots, so a calm terminal still emits `\e[38;5;215m` at its own value
    // (1.41:1 on this plane) — turning the net off while calm would leave the founder's report
    // unfixed in the state the app spends most of its time in.
    expect(termMinContrastRatio("light", true)).toBe(CALM_MIN_SPLIT);
    expect(termMinContrastRatio("light", true)).toBeGreaterThan(1);
    // …and it is genuinely gentler than the non-calm net, which is the whole point of splitting it.
    expect(termMinContrastRatio("light", true)).toBeLessThan(termMinContrastRatio("light"));
  });

  it("leaves DARK mode on xterm's defaults — this change never reaches it", () => {
    // The founder's report was light-mode-only, and dark is the ground the Tango defaults were
    // designed for. An unset slot is xterm's own value; that is the contract being pinned.
    const dark = xtermTheme("dark");
    for (const slot of ANSI_SLOTS) {
      expect(dark[slot], `dark.${slot} must stay xterm's default`).toBeUndefined();
    }
  });
});
