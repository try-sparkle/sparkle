// NUMERIC FLOORS FOR THE SHELL'S CHROME, in both themes, computed from the actual hex.
//
// The regression this exists to prevent has already happened once, on the first cut of the
// black-and-gold repaint. That cut moved DARK onto the prototype's four near-black planes and left
// every chrome value that had been chosen against the OLD mid-navy exactly where it was:
//
//   • `forest`↔`deepForest` fell from 1.50:1 to 1.08:1. Dozens of components painted
//     `border: 1px solid ${C.forest}` on a `deepForest` panel and several painted
//     `background: C.forest` filled pills — modals lost their outline, pills stopped reading as
//     pills, and the credit badge landed at 1.20:1 on the column it sits in.
//   • the nudge badge's ink passed BRAND.sienna through unthemed under a comment asserting it was
//     legible in both themes; it clears neither end.
//   • opaque BRAND.gold — Send button, palette selection, chiclets — is a literal constant and
//     measured 1.19–1.64:1 on light mode's near-white surfaces.
//
// Every one of those shipped under a COMMENT claiming the separation held. So, exactly as
// xtermTheme.test.ts learned for the calm palette (roborev 46485-M / 46897): the floors are
// numbers in colors.ts, the comments state no ratios, and inequality assertions ("lighter than")
// are banned here — an inequality is precisely what let the 1.08:1 pair through.
import { describe, expect, it } from "vitest";
import { AGENT_STATUS } from "@sparkle/ui";
// The BRAND literals the tinted fills below composite. Imported, never re-typed: the gold hex had
// already been copied into three places (packages/ui/tokens.ts, THEME_HEX's goldInk/goldFill, and
// this file's `over()` calls), so retuning a brand token could leave this guard measuring a stale
// colour and still reporting green — a guard measuring the wrong input is the failure mode this
// whole file exists to prevent.
import { C as BRAND } from "@sparkle/ui";
import {
  BADGE_EDGE_PCT,
  C,
  CHAT_SENT_FILL,
  CHAT_SENT_INK,
  CHAT_SENT_MUTED,
  CHROME_MIN_CONTRAST,
  EDGE_MIN_CONTRAST,
  CONTROL_MIN_CONTRAST,
  DANGER,
  INK_MIN_CONTRAST,
  RAMP_MIN_SPLIT,
  THEME_HEX,
} from "./colors";
import { BLUEPRINT } from "./blueprintSpec";

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

/** Composite a translucent color over an opaque one, the way `color-mix(… N%, transparent)` does
 *  over its backdrop — sRGB, which is the space the app's color-mix()es name. */
function over(fg: string, bg: string, pct: number): string {
  const ch = (h: string, i: number) => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16);
  const mix = (i: number) => Math.round(ch(fg, i) * pct + ch(bg, i) * (1 - pct));
  return "#" + [0, 1, 2].map((i) => mix(i).toString(16).padStart(2, "0")).join("");
}

const MODES = ["light", "dark"] as const;

/** The four depth planes. A chrome token has to hold its floor on ALL of them: a modal is a
 *  `deepForest` panel, the composer is `barSurface`, the concierge column is `conciergeSurface`,
 *  and an embedded terminal well is `forest` — the same border style draws on each. */
const PLANES = ["forest", "deepForest", "barSurface", "conciergeSurface"] as const;

/** The chrome slots. THIS IS NOT A LADDER ANY MORE, and calling it one was the bug.
 *
 *  The array was ordered "each one step further from the planes than the last", and on the shipped
 *  palette that ordering is FALSE in both themes — slots 2 and 3 are swapped:
 *    light luminance  .8657 → .6775 → .8339 → .6292   (should decrease monotonically)
 *    dark  luminance  .0223 → .0402 → .0242 → .0508   (should increase monotonically)
 *
 *  It does not sort because these are two different FAMILIES, not four rungs of one ramp:
 *    FILLS — `chatBubble` (hovered) and `chatBubbleActive` (selected): a deliberately shallow hover
 *            ramp, 1.035:1 apart, sitting close to their ground.
 *    EDGES — `pillFill` and `hairline`: rules, which must read AGAINST the planes rather than sit
 *            near them, and are therefore much further from the fills by construction.
 *  Interleaving a fill family with an edge family by distance-from-plane can only produce a
 *  zig-zag. Each family is checked for what it actually has to do, below and in the EDGES sweep. */
const CHROME_FILLS = ["chatBubble", "chatBubbleActive"] as const;

/* The chrome pairs a component actually composites — DragVisionHintPill's `hairline` border over
 * its `pillFill` chip, AgentSidebar's "Improve Sparkle" `hairline` top rule over the row's own
 * `chatBubble` fill, and the hovered-vs-current row ramp — are recorded here as prose rather than
 * as an array. They are real sites and worth knowing, but under this direction they are separated
 * by line weight, not by a contrast floor, so there is no assertion for the array to feed. */

// ── SEPARATION IS BY LINE, NOT BY FILL — THE WHOLE BLOCK BELOW WAS INVERTED ───────────────────
// What stood here was ~510 lines enforcing the opposite of the approved design: a `PLANE_MIN_SPLIT`
// floor demanding every adjacent surface differ by ≥1.2 in fill, a chrome ladder ordered by
// "distance from the plane mass", and a rule that the sidebar seam should carry NO line because the
// plane step carried it.
//
// The direction says the reverse, in its own words: *structure is drawn, not filled — hairlines on
// a faint grid, panels are outlines, and the registers separate by LINE WEIGHT.* Measured from the
// spec: in light the assistant column and the ground are BOTH #ffffff, and assist→bridge is 1.084.
// Every one of the design's steps sits UNDER the floor this file used to enforce. The old guards
// would reject the design they were written to protect, which is why the app could pass all of them
// and still look nothing like it (blueprintSpec.test.ts now pins that structural claim directly).
//
// So the contract here is the one the design actually has:
//   1. EDGES must be visible on the surfaces they are drawn on — that is what separates registers.
//   2. INK must be legible on every surface it is read on — non-negotiable, and unchanged.
// Fill-vs-fill floors are gone. They were a different design.
describe("edges do the separating — every rule is visible on what it is drawn on", () => {
  // `hairline` is the column seam; `pillFill` is the interior rule/chip tone. Both are drawn ON the
  // planes, so both have to survive against them. This is the replacement for the old chrome floor:
  // same rigour, aimed at the mechanism the design uses.
  // EDGES ARE PAIRED TO THE PLANES THEY ARE ACTUALLY DRAWN ON. A flat cross-product demanded one
// rule token read on every surface, which is precisely what the approved direction rejects: the
// spec draws `seam` through the chrome and a DIFFERENT, darker `termHair` where a rule meets the
// terminal plane. Under the cross-product, light `hairline` on `forest` measured 1.195 against a
// 1.2 floor — a failure produced by the guard's model, not by the palette.
const EDGES = ["hairline", "pillFill"] as const;
/** The terminal plane has its own rule token; neither chrome edge is drawn on it. The spec is
 *  explicit about this — a stage chip sitting on a selected (terminal-coloured) row takes its own
 *  border, not the chrome hairline. */
const TERM_PLANE = "forest" as const;

  it("every edge token reads against EVERY plane, in both themes", () => {
    for (const mode of MODES) {
      const hex = THEME_HEX[mode];
      for (const edge of EDGES) {
        for (const plane of PLANES) {
          if (plane === TERM_PLANE) continue; // covered by termHairline, asserted below
          expect(
            contrast(hex[edge], hex[plane]),
            `${mode}: ${edge} (${hex[edge]}) is invisible on ${plane} (${hex[plane]}) — the boundary would not exist`,
          ).toBeGreaterThan(EDGE_MIN_CONTRAST);
        }
      }
    }
  });

  // ── THE COMPOSER'S BOX IS DRAWN ON `inputSurface`, WHICH IS NOT ONE OF THE PLANES ─────────────
  // The concierge composer (`.cmp`) is an inset box on `--k-input` with a `hairline` rule around
  // it. `inputSurface` is a FIELD ground, not a depth plane, so the `EDGES × PLANES` sweep above
  // never measures that pair — and this is the one place where missing it would be fatal rather
  // than untidy: in LIGHT, `inputSurface` and `conciergeSurface` are the SAME value (both `#ffffff`,
  // straight from `--k-input` / `--k-assist`), so the rule is the only thing that makes the composer
  // a box at all. The "change of surface" the component relies on does not exist at that end.
  //
  // Not folded into PLANES: that would demand every edge token read on a field ground, which is the
  // flat-cross-product model the block above was rewritten to stop using. This is the pairing that
  // is actually painted.
  it("the composer's seam reads on the input ground it is drawn on, in both themes", () => {
    for (const mode of MODES) {
      const hex = THEME_HEX[mode];
      expect(
        contrast(hex.hairline, hex.inputSurface),
        `${mode}: hairline (${hex.hairline}) is invisible on inputSurface (${hex.inputSurface}) — in light that rule is the ONLY thing making the composer a box`,
      ).toBeGreaterThan(EDGE_MIN_CONTRAST);
    }
  });

  it("the terminal plane's own rule token reads on it, in both themes", () => {
    // The other half of the pairing above: `hairline` is excused from `forest` only because
    // `termHairline` covers it. Without this row that exclusion would be a hole, not a model.
    for (const mode of MODES) {
      const hex = THEME_HEX[mode];
      expect(
        contrast(hex.termHairline, hex[TERM_PLANE]),
        `${mode}: termHairline (${hex.termHairline}) is invisible on the terminal plane (${hex[TERM_PLANE]})`,
      ).toBeGreaterThan(EDGE_MIN_CONTRAST);
    }
  });

  // ── THE ASSISTANT↔BUILDER SEAM IS NO LONGER A DRAWN RULE. FOUNDER CALL, 2026-07-31. ─────────
  // This case used to assert the opposite — that the fills do NOT separate the two columns and a
  // visible `hairline` therefore must. That was true and load-bearing for a long time (a previous
  // pass deleted the rule on the theory that the plane step carried it; it did not). The founder
  // then asked, three times, for the vertical line at this boundary to go, and on the third asked
  // for it removed outright rather than only while mounted.
  //
  // WHY THIS CASE HAD TO BE REWRITTEN RATHER THAN LEFT GREEN: it only ever compared TOKENS, never
  // asserted that anything painted, so deleting the rule from both sides of the seam left it
  // passing while describing a mechanism the app no longer has. A guard that cannot notice the
  // change it is named for reads to the next contributor as the live invariant.
  //
  // BE HONEST ABOUT WHAT REPLACED IT. The unwired column measures 1.107:1 against `deepForest` —
  // still under `EDGE_MIN_CONTRAST`, so "separation by fill" is NOT what carries this boundary
  // now, whatever the CSS comment says. What carries it is `lift`, the elevation shadow. The fill
  // step only has to be big enough that the column does not read as the SAME plane, which is the
  // direction's own claim about these two columns; the shadow does the separating.
  it("the assistant↔builder boundary is carried by elevation, not by a rule or a fill step", () => {
    for (const mode of MODES) {
      const hex = THEME_HEX[mode];
      // Unchanged and still true: these two columns are near-identical planes by design.
      expect(
        contrast(hex.conciergeSurface, hex.deepForest),
        `${mode}: the columns are separated by FILL — that is the superseded design`,
      ).toBeLessThan(1.2);
      // The lifted (unwired) plane does not close that gap either. Pinned so nobody "fixes" the
      // boundary by quietly pushing `assistLift` up until it separates on its own — the founder
      // asked for a lighter column, not a re-drawn seam.
      expect(
        contrast(hex.conciergeSurfaceLifted, hex.deepForest),
        `${mode}: assistLift has grown into a fill-step boundary`,
      ).toBeLessThan(1.2);
      // …and the elevation that actually carries it is present in both themes.
      expect(BLUEPRINT[mode].lift, `${mode}: no lift to carry the boundary`).toMatch(/rgba?\(/);
    }
  });

  // ── HOVER AND SELECTED ARE NOT SEPARATED BY FILL, AND THAT IS THE DESIGN ────────────────────
  // This row used to assert `chatBubble !== chatBubbleActive` — a STRING-IDENTITY check, which the
  // header of this file explicitly bans, because an inequality is exactly what let a 1.08:1 pair
  // through once before. Measured on this palette the two fills are 1.035:1 apart in light, so the
  // assertion was green while hovered and selected were indistinguishable.
  //
  // The honest conclusion is not "tighten the floor" — it is that the direction does not signal
  // SELECTION with a bubble fill at all. `--k-bubble` and `--k-sel` are a hover ramp, deliberately
  // near their ground, and the selected row is signalled by the terminal FLOOD: it takes the pane's
  // colour and bleeds into it. A floor forcing these two fills apart would reintroduce the
  // separate-by-fill model this port exists to remove.
  //
  // So the pair is PINNED to the spec rather than floored. A palette edit that pulls them apart —
  // or collapses them to one value — fails here and has to come argue with this comment.
  it("the hover ramp stays a ramp: close to its ground, and pinned to the spec", () => {
    for (const mode of MODES) {
      const hex = THEME_HEX[mode];
      // PINNED, which is what this title has always promised. It rested on `.not.toBe` — the
      // string-identity check this file's preamble bans — so `#e8f0fd` → `#e8f0fe` collapsed the
      // ramp to 1.001:1 and passed green. A pin is the honest guard because these values are
      // PORTED, not tuned: there is no range for them to be inside. (roborev 54746, and 54832 for
      // the fact that the fix first landed on a DUPLICATE of this row instead of on this one.)
      expect(hex.chatBubble, `${mode}: chatBubble drifted from the spec's --k-bubble`).toBe(
        BLUEPRINT[mode].bubble,
      );
      expect(hex.chatBubbleActive, `${mode}: chatBubbleActive drifted from the spec's --k-sel`).toBe(
        BLUEPRINT[mode].sel,
      );
      // …and it stays a RAMP rather than becoming a fill separation.
      expect(
        contrast(hex.chatBubble, hex.chatBubbleActive),
        `${mode}: the hover ramp has become a fill separation`,
      ).toBeLessThan(1.2);
    }
  });

  // ── THE INK FLOORS THAT WENT OUT WITH THE FILL FLOORS ────────────────────────────────────────
  // The ~510 lines deleted here enforced separation by FILL, which the direction rejects — but the
  // sweep that went with them also carried the INK floors, and those are not superseded by
  // anything. "Ink must be legible on every surface it is read on" was stated as unchanged while
  // its coverage was removed. The only thing left guarding those sites was component tests pinning
  // token STRINGS (`var(--c-bar-surface)`), which is the exact substitute that cannot catch a
  // palette edit. These sweeps put the floors back.
  it("primary ink clears AA on every chrome fill it is read on", () => {
    for (const mode of MODES) {
      const hex = THEME_HEX[mode];
      for (const fill of ["chatBubble", "chatBubbleActive", "pillFill"] as const) {
        expect(
          contrast(hex.cream, hex[fill]),
          `${mode}: cream on ${fill} (${hex[fill]})`,
        ).toBeGreaterThanOrEqual(INK_MIN_CONTRAST);
      }
    }
  });

  it("the sidebar hover-card inks clear AA on both card grounds", () => {
    // AgentSidebar's hover card renders over `barSurface` docked and over `forest` on the pane.
    for (const mode of MODES) {
      const hex = THEME_HEX[mode];
      for (const ground of ["barSurface", "forest"] as const) {
        for (const ink of ["muted", "successInk", "accentInk"] as const) {
          expect(
            contrast(hex[ink], hex[ground]),
            `${mode}: ${ink} on the hover card's ${ground} ground`,
          ).toBeGreaterThanOrEqual(INK_MIN_CONTRAST);
        }
      }
    }
  });
});
describe("the concierge column's themed INKS clear AA where they are read", () => {
  // Scoped to `conciergeSurface` ON PURPOSE. These are the concierge column's inks — the scope
  // line, the vitals, a nudge's badge and project chip — and that column is the surface they are
  // read on. Sweeping them across all four planes instead would assert a contract they were never
  // given and would fold in a PRE-EXISTING light-mode gap that is not this change's to close
  // (light `muted`/`conciergeMuted` #5b6b8c measures 3.89:1 on the light SIDEBAR, #d9dce1) — a
  // test that fails for something you are not fixing gets weakened, and then it guards nothing.
  const INKS = ["conciergeMuted", "dangerInk", "goldInk", "goldHotInk"] as const;

  // BOTH concierge planes, because there are two now. `conciergeSurface` is the token these inks
  // were specified against; `conciergeSurfaceLifted` is what the column ACTUALLY paints while
  // unwired, and in dark it is the lighter of the two.
  //
  // LIGHTENING A DARK PLANE REDUCES CONTRAST for the light ink on it — dark `conciergeMuted` goes
  // 6.71 → 6.48, `faint` 4.07 → 3.93 — so the lifted plane is the STRICTER of the two in the only
  // theme where they differ, and a sweep that measured only `conciergeSurface` would license an ink
  // (or an `assistLift`) edit that passes here and fails on the surface actually rendered.
  const CONCIERGE_PLANES = ["conciergeSurface", "conciergeSurfaceLifted"] as const;

  it("every concierge ink on both concierge planes, both themes", () => {
    for (const mode of MODES) {
      const hex = THEME_HEX[mode];
      for (const plane of CONCIERGE_PLANES) {
        for (const ink of INKS) {
          expect(
            contrast(hex[ink], hex[plane]),
            `${mode}: ${ink} (${hex[ink]}) on ${plane} (${hex[plane]})`,
          ).toBeGreaterThanOrEqual(INK_MIN_CONTRAST);
        }
      }
    }
  });

  // ── THE COLUMN HAS A SECOND PLANE NOW: THE FLOOD ──────────────────────────────────────────────
  // Wired to a terminal (`ConciergeColumn`'s `data-wired`), the concierge takes the TERMINAL's
  // colour — so every ink above is suddenly read on `--k-term` instead of on `conciergeSurface`.
  // The column sets the terminal ink register on itself and anything inheriting follows, but the
  // controls that NAME a concierge-register ink do not: the grip dots, the header pills' default
  // and pressed labels, a nudge's badge and chip.
  //
  // None of that was measured when the wired state landed — the same disagreement `amberInk`'s
  // `composerPlate` closed for the composer, reopened one level up, on a whole column rather than a
  // 90px strip (roborev 54712). Light `conciergeMuted` on the flood is the tightest at 4.76, which
  // is 0.26 of margin with nothing holding it there.
  //
  // `forest` IS the flooded plane — it is `BLUEPRINT[mode].term`, the same token the column reads
  // through `BLUEPRINT` because it has no CSS var of its own. Sweeping these inks over it is
  // therefore not the "assert a contract they were never given" mistake the note above warns about:
  // the wired column gives them exactly this contract.
  it("every concierge ink ALSO clears AA on the flooded column, both themes", () => {
    for (const mode of MODES) {
      const hex = THEME_HEX[mode];
      for (const ink of INKS) {
        expect(
          contrast(hex[ink], hex.forest),
          `${mode}: ${ink} (${hex[ink]}) is unreadable once the concierge floods to the terminal plane (${hex.forest})`,
        ).toBeGreaterThanOrEqual(INK_MIN_CONTRAST);
      }
    }
  });

  // ── THE PRESSED NEEDS-YOU PILL IS A FILL CARRYING TEXT, ON BOTH OF THE COLUMN'S PLANES ────────
  // It shipped as `onGoldFill` on `bandColor("needs_you")` — white on brand sienna #e0533f in
  // light, which measures 3.83:1 on a 10px bold label. Under AA, and unreachable from that hue:
  // nothing lighter than near-black clears 4.5 on a mid red, and white is the only light end
  // available. So the pressed fill is the THEMED alarm ink instead (a deep red in light, a light
  // salmon in dark), which crosses that token's documented fill/ink split deliberately — the
  // split's rationale is legibility, and here it is the fill that has to carry the text.
  //
  // Opaque, so the plane under it does not enter the ratio — but it is asserted on both column
  // planes anyway, because the pill is what the WIRED header paints too and "it's opaque" is
  // exactly the reasoning that would stop someone re-checking after a future tint.
  it("the pressed needs-you pill's fill and its ink clear AA, both themes", () => {
    for (const mode of MODES) {
      const hex = THEME_HEX[mode];
      expect(
        contrast(hex.onGoldFill, hex.dangerInk),
        `${mode}: the pressed needs-you pill's label is unreadable on its own fill`,
      ).toBeGreaterThanOrEqual(INK_MIN_CONTRAST);
    }
  });

  it("…and the band colour it REPLACED would not have, which is why it is not that", () => {
    // Recorded rather than merely fixed: brand sienna as a filled plate under white is the shape
    // this pill was built in, and "just use the band colour, it is the tier's own hue" is the
    // obvious thing for the next person to try.
    expect(contrast(THEME_HEX.light.onGoldFill, BRAND.sienna)).toBeLessThan(INK_MIN_CONTRAST);
  });

  // ── MEASURE THE STACK THE LABEL IS ACTUALLY READ ON ───────────────────────────────────────────
  // A nudge's inks are not read on the bare column, and the first cut of these assertions did not
  // composite far enough. NudgeCard paints, from the bottom up:
  //
  //   conciergeSurface
  //     └─ the CARD: linear-gradient(color-mix(sienna 9%) → color-mix(sienna 3%))
  //          ├─ the BADGE:   its own color-mix(sienna 16%) fill  → label is `dangerInk`
  //          ├─ the CHIP:    NO fill of its own (border only)    → label is `goldInk`
  //          └─ the PRIMARY: its own color-mix(gold 16%) fill    → label is `goldHotInk`
  //
  // Every tint LIFTS the backdrop in dark and DARKENS it in light, so which gradient stop is the
  // worst case flips between themes — both stops are measured rather than guessing at one.
  const gradient = (mode: (typeof MODES)[number], stop: number) =>
    over(BRAND.sienna, THEME_HEX[mode].conciergeSurface, stop);
  const GRADIENT_STOPS = [0.09, 0.03] as const; // the card's two `linear-gradient(180deg, …)` ends

  // The badge is the pair that made BRAND.sienna's "legible in both themes" claim false, and it
  // stayed wrong one layer deeper: the guard composited ONLY the card's gradient while the badge
  // paints its own 16% sienna on top of that, and the label sits on THAT. Measured properly,
  // `dangerInk` did not clear AA at either end — which is precisely how a "the guard covers it"
  // claim keeps a sub-floor value shipping.
  it("`dangerInk` clears AA on the badge's OWN fill — the card's gradient AND the badge's tint", () => {
    for (const mode of MODES) {
      const hex = THEME_HEX[mode];
      for (const stop of GRADIENT_STOPS) {
        const badgeFill = over(BRAND.sienna, gradient(mode, stop), 0.16);
        expect(
          contrast(hex.dangerInk, badgeFill),
          `${mode}: dangerInk (${hex.dangerInk}) on the badge fill (${badgeFill}) at gradient ${stop}`,
        ).toBeGreaterThanOrEqual(INK_MIN_CONTRAST);
      }
    }
  });

  // The project chip. Its comment named this surface while the assertion measured a 16% gold tint
  // the chip never paints — the chip is a bordered label with NO background, so what it is read on
  // is the card gradient itself.
  it("`goldInk` clears AA on the project chip's real backdrop — the card gradient, no fill", () => {
    for (const mode of MODES) {
      const hex = THEME_HEX[mode];
      for (const stop of GRADIENT_STOPS) {
        expect(
          contrast(hex.goldInk, gradient(mode, stop)),
          `${mode}: goldInk (${hex.goldInk}) on the card gradient (${gradient(mode, stop)}) at ${stop}`,
        ).toBeGreaterThanOrEqual(INK_MIN_CONTRAST);
      }
    }
  });

  // THE FOURTH INK, which the pass that introduced the three above did not measure — and it was the
  // one that failed. `NudgeCard.tsx` paints `color: C.conciergeMuted` on the card's META ROW (the
  // agent name beside the band badge) and on its ghost action, both directly on the card's gradient
  // with no fill of their own. Measuring three of a card's four inks on their real stack and
  // skipping the fourth leaves the reader with a file that looks exhaustive and is not; light mode
  // was under the floor at both gradient stops until `conciergeMuted` moved for it.
  it("`conciergeMuted` clears AA on the card gradient it is read on — the meta row and the ghost action", () => {
    for (const mode of MODES) {
      const hex = THEME_HEX[mode];
      for (const stop of GRADIENT_STOPS) {
        expect(
          contrast(hex.conciergeMuted, gradient(mode, stop)),
          `${mode}: conciergeMuted (${hex.conciergeMuted}) on the card gradient (${gradient(mode, stop)}) at ${stop}`,
        ).toBeGreaterThanOrEqual(INK_MIN_CONTRAST);
      }
    }
  });

  // The 16% gold tint the old `goldInk` case was measuring DOES exist — it is the primary action
  // button. But that button's label is `goldHotInk`, not `goldInk`, and the tint composites over
  // the card gradient rather than the bare column. So the surface is kept and pointed at the ink
  // that is actually painted on it.
  it("the primary action button's own ink clears AA on its own fill", () => {
    for (const mode of MODES) {
      const hex = THEME_HEX[mode];
      // The button is OPAQUE now (NudgeCard), so there is no card gradient under it to composite
      // and no stop to pick a worst case from. It is the spec's primary pair, measured directly.
      expect(
        contrast(hex.onGoldFill, hex.goldFill),
        `${mode}: onGoldFill (${hex.onGoldFill}) on the primary button (${hex.goldFill})`,
      ).toBeGreaterThanOrEqual(INK_MIN_CONTRAST);
    }
  });

  // ── THE BADGE GUARD MEASURED A PAIRING THE COMPONENT HAD STOPPED USING ────────────────────────
  // This asserted `goldInk` and `accentInk` on 14% BRAND tints. `kindBadge` uses neither: `goldInk`
  // left when gold was retired, and the 14% wash left when the kind treatment changed. So the only
  // guard on this component measured something that does not render, while every composite that
  // DOES ship went unmeasured — which is exactly how a light-mode regression shipped green, twice
  // (roborev 54253). The badge's edge had fallen to 1.079 against the panel in light: no visible
  // boundary at all, with the suite passing.
  //
  // It measures what ships now: the themed edge at both weights, on both surfaces the badge renders
  // on, in both themes. And the LABEL is measured on the ground it actually sits on — the badge
  // has no fill, precisely because a tint of `accentInk` under `accentInk` text is self-defeating
  // (the label drops under AA at a 14% fill and keeps falling), which is the constraint that chose
  // edge weight as the signal in the first place.
  //
  // THE WEIGHTS ARE IMPORTED FROM THE COMPONENT, not re-declared here (roborev 54263). A local copy
  // meant this guard could not observe the value an edit would change: dropping the weak edge back
  // to 32% — which is what produced the invisible light-mode edge — would have left the test still
  // measuring its own 45% and still passing. A guard that cannot see the thing it guards is the
  // failure this whole block is a record of.
  it("`kindBadge`'s edges clear the chrome floor at BOTH weights, on both rows and both themes", () => {
    for (const mode of MODES) {
      const hex = THEME_HEX[mode];
      // The selected result row washes 8% over the panel FIRST, so the badge edge composites over
      // that, not over the bare panel. Both are measured — the badge renders on either.
      const rows = [hex.deepForest, over(BRAND.gold, hex.deepForest, 0.08)];
      for (const row of rows) {
        for (const [kind, pctWhole] of Object.entries(BADGE_EDGE_PCT)) {
          const pct = pctWhole / 100;
          const edge = over(hex.accentInk, row, pct);
          expect(
            contrast(edge, row),
            `${mode}: the ${kind} badge's ${pct * 100}% accentInk edge (${edge}) over row ${row}`,
          ).toBeGreaterThanOrEqual(CHROME_MIN_CONTRAST);
        }
        // …and the two weights must still be told apart, or the kind is carried by nothing.
        expect(
          contrast(over(hex.accentInk, row, BADGE_EDGE_PCT.prompt / 100), over(hex.accentInk, row, BADGE_EDGE_PCT.other / 100)),
          `${mode}: the two badge edge weights are indistinguishable over row ${row}`,
        ).toBeGreaterThanOrEqual(RAMP_MIN_SPLIT);
        // the label sits on the row itself, since the badge paints no fill
        expect(
          contrast(hex.accentInk, row),
          `${mode}: the badge label (${hex.accentInk}) on row ${row}`,
        ).toBeGreaterThanOrEqual(INK_MIN_CONTRAST);
      }
    }
  });
});

describe("`mixedInk` — the orchestrator's mixed-workers disc", () => {
  // A 12px disc with no border, so this contrast IS its edge — same reasoning as the Send button
  // below, and the same 3:1 non-text floor. It is swept over all four planes rather than just the
  // build column's `deepForest`, because a status disc is rendered in the TopBar cluster and the
  // concierge digest too, and those sit on different surfaces.
  it("clears the non-text control floor on every plane, in both themes", () => {
    for (const mode of MODES) {
      const hex = THEME_HEX[mode];
      for (const plane of PLANES) {
        expect(
          contrast(hex.mixedInk, hex[plane]),
          `${mode}: mixedInk (${hex.mixedInk}) on ${plane} (${hex[plane]})`,
        ).toBeGreaterThanOrEqual(CONTROL_MIN_CONTRAST);
      }
    }
  });

  // The whole point of the color is that it is neither of the two it sits between. If it drifts
  // close enough to red or green to be mistaken for one, the row silently reports a state it isn't
  // in — worse than having no mixed color at all, because it looks definite.
  it("stays distinguishable from the red and green it summarizes", () => {
    for (const mode of MODES) {
      const hex = THEME_HEX[mode];
      for (const [name, other] of [
        ["red", AGENT_STATUS.waiting.color],
        ["green", AGENT_STATUS.working.color],
      ] as const) {
        expect(
          contrast(hex.mixedInk, other),
          `${mode}: mixedInk (${hex.mixedInk}) vs the ${name} dot (${other})`,
        ).toBeGreaterThanOrEqual(RAMP_MIN_SPLIT);
      }
    }
  });
});

// ── THE REST OF THE ACCENT FAMILY, THEMED ───────────────────────────────────────────────────────
// `accent`, `success`, `amber` and `sienna` each already had an ink twin; `teal` and `violet` did not, and
// passed through as brand literals on every plane in both themes. That is the same defect the four
// existing splits were each created to fix, so it is measured the same way rather than argued.
describe("`tealInk` / `violetInk` — the two brand accents that had no ink twin", () => {
  const NEW_INKS = ["tealInk", "violetInk"] as const;
  /** The brand literal each ink replaced, so a regression records WHAT it regressed to. */
  const BRAND_OF = { tealInk: BRAND.teal, violetInk: BRAND.violet } as const;

  it("each new ink clears AA on EVERY plane, in both themes", () => {
    for (const mode of MODES) {
      const hex = THEME_HEX[mode];
      for (const ink of NEW_INKS) {
        for (const plane of PLANES) {
          expect(
            contrast(hex[ink], hex[plane]),
            `${mode}: ${ink} (${hex[ink]}) on ${plane} (${hex[plane]})`,
          ).toBeGreaterThanOrEqual(INK_MIN_CONTRAST);
        }
      }
    }
  });

  it("the brand literals they replaced do NOT — which is why both tokens exist", () => {
    // Asserted as a FAILING measurement, in both themes, so neither token can be reverted to "the
    // brand colour is fine here". Note this is not a light-mode-only story the way `goldFill` was:
    // the black-and-gold repaint took dark's `forest` to near-black, and a saturated mid blue is
    // under the floor against THAT too.
    for (const mode of MODES) {
      const hex = THEME_HEX[mode];
      for (const ink of NEW_INKS) {
        const worst = Math.min(...PLANES.map((p) => contrast(BRAND_OF[ink], hex[p])));
        expect(
          worst,
          `${mode}: brand ${ink.replace("Ink", "")} (${BRAND_OF[ink]}) at its worst plane`,
        ).toBeLessThan(INK_MIN_CONTRAST);
      }
    }
  });
});

describe("opaque gold is a themed PAIR — fill and the ink that sits on it", () => {
  it("`goldFill` clears the non-text control floor on every plane, in both themes", () => {
    // The Send button has no border; this contrast IS its edge. Held to WCAG 1.4.11's 3:1 rather
    // than the softer divider floor for that reason.
    for (const mode of MODES) {
      const hex = THEME_HEX[mode];
      for (const plane of PLANES) {
        expect(
          contrast(hex.goldFill, hex[plane]),
          `${mode}: goldFill (${hex.goldFill}) on ${plane} (${hex[plane]})`,
        ).toBeGreaterThanOrEqual(CONTROL_MIN_CONTRAST);
      }
    }
  });

  it("`onGoldFill` clears AA on `goldFill` — pick one and you have picked both", () => {
    for (const mode of MODES) {
      const hex = THEME_HEX[mode];
      expect(
        contrast(hex.onGoldFill, hex.goldFill),
        `${mode}: onGoldFill (${hex.onGoldFill}) on goldFill (${hex.goldFill})`,
      ).toBeGreaterThanOrEqual(INK_MIN_CONTRAST);
    }
  });

  // ── THE INACTIVE CHEVRON IS A SECOND FILL, AND IT WAS UNMEASURED ────────────────────────────────
  // PlanBuildToggle paints ONE `goldFill` and desaturates the inactive mode with `filter:
  // grayscale(1)`. The pair above measures the ACTIVE fill only, so the state the user is looking at
  // half the time had no floor at all (roborev 54002) — and the 0.9 opacity that used to ride along
  // with the filter made it worse, because opacity composites the label too: 5.17:1 became 4.28:1 in
  // light. The opacity is gone; this is the guard that keeps it gone.
  //
  // `grayscale(1)` is the CSS filter's own luminance matrix, not an average of the channels — the
  // difference is large enough here (#6d6d6d vs #567a7f-ish) that averaging would measure a colour
  // the browser never paints.
  //
  // BOTH SIDES GO THROUGH IT, because `filter` applies to the whole button — the LABEL as much as
  // the fill. It happens not to matter today (light's ink is #ffffff and dark's #090b14, both
  // near-neutral), but measuring an unfiltered ink against a filtered fill would be the exact
  // failure the paragraph above warns about, one token edit away (roborev 54025).
  const grayscale = (h: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
    const y = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
    return `#${[y, y, y].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  };

  it("the GRAYSCALED chevron still clears AA against its label, in both themes", () => {
    for (const mode of MODES) {
      const hex = THEME_HEX[mode];
      const inactive = grayscale(hex.goldFill);
      const ink = grayscale(hex.onGoldFill);
      expect(
        contrast(ink, inactive),
        `${mode}: the grayscaled label (${ink}) on the grayscaled chevron (${inactive})`,
      ).toBeGreaterThanOrEqual(INK_MIN_CONTRAST);
    }
  });

  // ── `DANGER` IS THEMED NOW, AND THAT IS WHY THESE TWO ASSERTIONS INVERTED ───────────────────────
  // The two tests that stood here pinned `DANGER` as a SHAPE colour: an unthemed brand red that
  // failed the ink floor on every light plane, and cleared the control floor on exactly one of
  // them. Both recorded a real defect — a dozen sites passed the constant straight to `color:` —
  // and both have been overtaken rather than deleted.
  //
  // The reason the old framing could not survive Blueprint: light `forest` stopped being white and
  // became the mid blue-grey TERMINAL plane, and `forest` is what roughly thirty dialogs and cards
  // paint. The constant measured 2.461 there, under the control floor, at every one of those sites
  // simultaneously — including `DefineStageModal`'s `1px solid DANGER` banner, whose own comment
  // claimed it cleared 3:1. The previous round "fixed" that by re-aiming the assertion at
  // `conciergeSurface`, a plane no DANGER border is drawn on, which turned the guard green while
  // the only real call site regressed. That is the failure this file's header exists to prevent,
  // and it is why the fix here is to the TOKEN, not to the assertion.
  //
  // `DANGER` is now `C.dangerInk` — the themed twin that already existed for this job. One change
  // fixed every call site, and the sweep below is what keeps it fixed: a future plane move is
  // caught by a measurement rather than by a reviewer reading thirty components.
  it("`DANGER` IS the themed ink — not a constant that call sites have to work around", () => {
    expect(DANGER).toBe(C.dangerInk);
    // and it resolves through the CSS layer rather than being a literal anyone can measure wrong
    expect(DANGER.startsWith("var(")).toBe(true);
  });

  it("`dangerInk` clears the INK floor on EVERY plane, in BOTH themes — the sweep DANGER now inherits", () => {
    for (const mode of MODES) {
      const hex = THEME_HEX[mode];
      for (const plane of PLANES) {
        expect(
          contrast(hex.dangerInk, hex[plane]),
          `${mode}: dangerInk (${hex.dangerInk}) on ${plane} (${hex[plane]})`,
        ).toBeGreaterThanOrEqual(INK_MIN_CONTRAST);
      }
    }
  });

  it("the retired DANGER literal would still FAIL on the terminal plane — why the token had to move", () => {
    // Kept as a measurement, not a memory. If someone reintroduces `#e5484d` as alert ink because
    // "it used to be the brand red", these are the numbers that say no.
    //
    // THE ABSOLUTE BOUND HERE WENT STALE AND HAD TO BE REPLACED RATHER THAN RETUNED. It asserted
    // the literal measured under 3:1 on the light terminal plane — true when that plane was a dark
    // green, false now that the Blueprint made it `#d9e3f3`, where the literal scrapes past at
    // 3.03. A bound that flips sign when a plane moves is not a guard, and loosening it to 3.1
    // would just move the same trap. What is actually claimed — and what stays true through a
    // repaint — is that the THEMED token beats the literal by a wide margin on the plane the
    // control is drawn on. That is a relative claim, so it survives the planes moving under it.
    const literal = contrast("#e5484d", THEME_HEX.light.forest);
    const themed = contrast(THEME_HEX.light.dangerInk, THEME_HEX.light.forest);
    expect(themed).toBeGreaterThan(literal * 2);
    expect(themed).toBeGreaterThanOrEqual(CONTROL_MIN_CONTRAST);
  });

  // `dangerInk`'s own floor is NOT restated here. It is already swept — deliberately scoped to the
  // surface it is read on by "the concierge column's themed INKS" above, whose comment explains at
  // length why an all-planes sweep for those tokens would assert a contract they were never given.
  // A second, broader copy here would supersede that decision silently and leave its rationale
  // paragraph standing as the stale advice the next reader acts on (roborev 54038). The modal
  // banner this pass repointed sits on `forest`, and OnePasswordPane's status pill and 12px error
  // text sit on `deepForest` — two planes that sweep does not reach (it is also read on
  // `conciergeSurface`, by NudgeCard, which is exactly what that sweep covers). Those two are measured
  // below, by the same rule it follows: the surfaces the ink is actually READ on, named. `forest`
  // alone would leave `deepForest` — the tightest of the four at 5.33:1 light — guarded nowhere
  // (roborev 54045), which is how a re-point that keeps the white modal comfortable slides the
  // settings dialog under the floor with the suite green.

  it("`dangerInk` clears AA on the two planes the concierge sweep does not reach", () => {
    for (const mode of MODES) {
      const hex = THEME_HEX[mode];
      for (const plane of ["forest", "deepForest"] as const) {
        expect(
          contrast(hex.dangerInk, hex[plane]),
          `${mode}: dangerInk (${hex.dangerInk}) on ${plane} (${hex[plane]})`,
        ).toBeGreaterThanOrEqual(INK_MIN_CONTRAST);
      }
    }
  });

  // ── GOLD IS RETIRED. THE TOKENS ARE NOT. ──────────────────────────────────────────────────────
  // This test used to pin the four gold tokens to the prototype's literals and was named "the
  // repaint's whole point". That point has been reversed by the founder: Blueprint has ONE accent
  // and it is blue, so gold is gone from the shell entirely.
  //
  // The four token NAMES survive on purpose. They are threaded through a dozen call sites with a
  // documented three-role split (translucent tint / themed ink / opaque fill + its partner ink),
  // and that split is still exactly right — it is the HUE that changed, not the structure. Renaming
  // them is a mechanical sweep that would bury this behavioural change in a hundred-file diff.
  //
  // So the contract asserted here inverts: no gold anywhere, and the pair still holds its floors.
  //
  // TWO WAYS THIS GUARD USED TO BE WEAKER THAN ITS OWN STATED CONTRACT (roborev 54169), both fixed
  // below. It claimed to "fail loudly if someone reaches for warm again, in either direction", but:
  //   1. the retired-literal check was an exact, lowercase string match, so `#F5C26B` walked past
  //      it — and hex case is not something anyone thinks about while pasting a colour;
  //   2. the BRAND half pinned two dead literals with `not.toBe`, which `BRAND.gold = "#e0982f"`
  //      (or any other warm value) satisfies happily. BRAND.gold is what the translucent tints,
  //      the palette wash and the canvas sprites actually read, so it was the half most worth
  //      generalising and the only half that wasn't.
  // The blue-dominance check is the assertion that generalises, so it now covers BRAND too.
  const isBlue = (v: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16)) as [number, number, number];
    return b > r && b > g;
  };
  it("the accent tokens carry BLUE, not gold — one accent, and it is not warm", () => {
    const RETIRED = ["#f5c26b", "#ffe9b8", "#090b14"];
    for (const mode of MODES) {
      for (const token of ["goldFill", "goldInk", "goldHotInk", "onGoldFill"] as const) {
        expect(
          RETIRED,
          `${mode}.${token} still carries a retired gold literal`,
        ).not.toContain(THEME_HEX[mode][token].toLowerCase());
      }
      // Blue means blue: the accent's blue channel dominates BOTH red and green at every end.
      for (const token of ["goldFill", "goldInk", "goldHotInk"] as const) {
        const v = THEME_HEX[mode][token];
        expect(isBlue(v), `${mode}.${token} (${v}) is not a blue`).toBe(true);
      }
    }
    // BRAND's own literals went with them — they are what the canvas star field reads. Held to the
    // same generalising check as the themed tokens, not to two dead literals.
    for (const [name, v] of [["gold", BRAND.gold], ["goldHot", BRAND.goldHot]] as const) {
      expect(RETIRED, `BRAND.${name} is back on a retired literal`).not.toContain(v.toLowerCase());
      expect(isBlue(v), `BRAND.${name} (${v}) is not a blue`).toBe(true);
    }
  });
});

// ── THE CHROME LADDER STILL HAS TO HOLD WHERE COMPONENTS COMPOSITE IT ────────────────────────
// `CHROME` and `COMPOSITED_PAIRS` outlived the ~510 lines that used to consume them — the block
// that enforced `PLANE_MIN_SPLIT`, i.e. separation by FILL, which is the opposite of what the
// approved direction does. Deleting the assertions but keeping the arrays left the ordering
// contract and the list of real composite sites documented and unenforced, which is how a claim
// goes stale without anyone noticing.
//
// ONLY THE ORDERING ROW CAME BACK, AND THE MEASUREMENT IS WHY. Re-asserting CHROME_MIN_CONTRAST
// over COMPOSITED_PAIRS fails immediately: light `hairline` on `pillFill` is 1.07, nowhere near
// 1.5. That is not a regression — `seam` #c3d1e6 and `hairSolid` #cbd8ea are ADJACENT BY DESIGN,
// because the direction separates by LINE WEIGHT and not by fill. A floor demanding those two
// pull apart would force the exact repaint this whole port exists to undo, so the composited-pair
// floor stays deleted and this comment records the number, rather than leaving the next reader to
// rediscover it and "fix" the palette.
describe("the neutral ladder, where it is composited", () => {
  it("the edges stay clear of the fills they are drawn beside", () => {
    // ONE HOME PER CLAIM. This block used to restate the fill ramp as well, and roborev 54832
    // caught the consequence: the pin landed on this copy while the row that ADVERTISES the pin
    // kept its `.not.toBe`, so the finding read as fixed with the misleading title still shipping.
    // The fill claim lives at "the hover ramp stays a ramp" above; this row keeps only the edge
    // half, which is the separate-by-line-weight thesis.
    for (const mode of MODES) {
      const hex = THEME_HEX[mode];
      for (const fill of CHROME_FILLS) {
        expect(
          contrast(hex.hairline, hex[fill]),
          `${mode}: hairline is invisible against ${fill}`,
        ).toBeGreaterThan(EDGE_MIN_CONTRAST);
      }
    }
  });
});

// ── THE SENT CARD, AND THE ONE FLOOR IT CANNOT CLEAR ───────────────────────────────────────────
// `chatBubbleSent` is the only chrome fill in this file that was placed by an INSTRUCTION rather
// than by the neutral ladder: the founder asked for a black card on a message that was sent to an
// agent. So the honest thing is to assert the floors it does clear and to record, in numbers, the
// one it does not — the same shape as the composited-pair note above, and for the same reason:
// leaving it undocumented is how the next reader "fixes" it by lightening the value.
//
// WHAT IT DOES NOT CLEAR: in DARK mode black is 1.22 against `conciergeSurface` and 1.45 against
// `chatBubble` — over EDGE_MIN_CONTRAST, under CHROME_MIN_CONTRAST. The card reads as a dark well
// rather than a crisp object, and that is a property of asking for black on a near-black column,
// not a mistake in the value. In LIGHT mode the same black is ~18 against both, which is the
// opposite problem: a heavy inverted slab. Both were shown to the founder as screenshots; the
// remedy if he wants one is a drawn hairline edge (the direction separates by line weight), NOT a
// quietly lightened fill, which would trade his instruction for a number.
describe("the black `sent to an agent` card", () => {
  // The card and both pinned inks are MODE-INVARIANT by construction, so a `for (const mode of
  // MODES)` loop over them computes the identical ratio twice and proves nothing about light mode.
  // An earlier version of this block did exactly that and read as if it covered the trap. Pin the
  // invariance itself, then assert each real case once.
  const CARD = THEME_HEX.dark.chatBubbleSent;

  it("is the same black in both themes — the premise everything below rests on", () => {
    expect(THEME_HEX.light.chatBubbleSent).toBe(THEME_HEX.dark.chatBubbleSent);
  });

  it("its PINNED inks clear AA on it", () => {
    expect(contrast(CHAT_SENT_INK, CARD), "the sent card's pinned ink is unreadable on it")
      .toBeGreaterThan(INK_MIN_CONTRAST);
    expect(contrast(CHAT_SENT_MUTED, CARD), "the sent card's pinned muted ink is unreadable on it")
      .toBeGreaterThan(INK_MIN_CONTRAST);
  });

  it("and the THEMED ink it refuses to inherit would be unreadable — why the pinning exists", () => {
    // THE ACTUAL TRAP, asserted rather than described. `cream` INVERTS: #dce8fc dark, #0a1b33 light.
    // A black card that inherited it would render near-black on black in light mode — the message
    // text, the pill's label and every paste pill gone together. Nothing asserted that before, so
    // the whole theme layer would have stayed green if the card dropped its pinning.
    //
    // This goes RED two ways, both of them the ones that matter: if someone retunes light's `cream`
    // toward white and makes inheriting it look safe, and if the card's fill is lightened until the
    // themed ink would have been fine — which is the "quietly lighten it" fix the header warns off.
    expect(
      contrast(THEME_HEX.light.cream, CARD),
      "light's themed ink is now readable on the sent card — if that is intended, the pinning in " +
        "SentToAgentRow.SENT_CARD_INK_VARS is no longer load-bearing and should be reconsidered " +
        "deliberately, not left in place by accident",
    ).toBeLessThan(INK_MIN_CONTRAST);
  });

  it("BOTH pinned inks also clear AA on the FILLS its own subtree paints", () => {
    // THE HALF THE FIRST VERSION MISSED. The card supplies the ground for text drawn straight onto
    // it — but a non-thumbnail attachment chip (AttachmentStrip) draws a ground of its OWN inside
    // the bubble. Pinning only the ink left that ground themed, so light mode put #dce8fc on a
    // #e8f0fd chip: ~1.07:1, invisible. The card pins that fill too (CHAT_SENT_FILL).
    //
    // BOTH INKS, not just the ink. The chip paints CHAT_SENT_MUTED as well as CHAT_SENT_INK — the
    // file glyph and the extension label (AttachmentStrip.tsx:127,144) — and an earlier version of
    // this sweep asserted only the ink while its title claimed both, leaving the muted pair free to
    // drift under AA on a retune of BLUEPRINT.dark.muted with this suite green (roborev 62750).
    //
    // This sweep is what stops the list going stale: add a fill a card descendant paints for itself,
    // add it here. Fills that need NO pin are listed in theme/colors beside CHAT_SENT_FILL, with the
    // reason each is safe — the collapsed-paste pill is translucent, and sienna's remove badge never
    // renders in a transcript at all.
    for (const [fillName, fill] of [["the attachment chip", CHAT_SENT_FILL]] as const) {
      for (const [inkName, ink] of [
        ["ink", CHAT_SENT_INK],
        ["muted ink", CHAT_SENT_MUTED],
      ] as const) {
        expect(
          contrast(ink, fill),
          `${fillName}: the card's pinned ${inkName} is unreadable on the ground that element paints for itself`,
        ).toBeGreaterThan(INK_MIN_CONTRAST);
      }
    }
  });

  it("is tellable from an ordinary bubble and from the column it sits on", () => {
    // The whole affordance is that a forwarded message is distinguishable AT A GLANCE from one the
    // concierge answered. EDGE_MIN_CONTRAST is the floor these actually clear (see the note above);
    // asserting it pins how little headroom dark mode has, so a future repaint of
    // `conciergeSurface` or `chatBubble` toward black fails here instead of silently erasing the card.
    for (const mode of MODES) {
      const hex = THEME_HEX[mode];
      expect(
        contrast(hex.chatBubbleSent, hex.chatBubble),
        `${mode}: the sent card is indistinguishable from an ordinary bubble`,
      ).toBeGreaterThan(EDGE_MIN_CONTRAST);
      expect(
        contrast(hex.chatBubbleSent, hex.conciergeSurface),
        `${mode}: the sent card is invisible against the concierge column`,
      ).toBeGreaterThan(EDGE_MIN_CONTRAST);
    }
  });
});
