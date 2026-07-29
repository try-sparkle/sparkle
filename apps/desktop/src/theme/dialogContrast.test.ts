// ── THE MODAL PLANE'S FLOORS ────────────────────────────────────────────────────────────────────
//
// `chromeContrast.test.ts` sweeps the four SHELL planes. A dialog is not on any of them: it floats
// above the whole shell on `dialogSurface`, with `dialogNav` as its one interior register. Those two
// tokens were dead data in `blueprintSpec.ts` until this pass wired them, so nothing measured the
// surface roughly thirty dialogs are painted on.
//
// The contract is the same one the direction states everywhere else, and it has TWO halves that pull
// in opposite directions. Asserting only the first is how a reviewer "fixes" the second:
//
//   1. EDGES must be visible on what they are drawn on. That is what separates the registers.
//   2. THE TWO SURFACES MUST *NOT* SEPARATE BY FILL. Adjacent planes in the approved design differ
//      by 1.07–1.19 deliberately — structure is drawn, not filled. A darkened nav rail is a
//      regression even though it "reads better", and it is the single most-repeated failure in this
//      repaint's history, so it is pinned from ABOVE rather than left to good intentions.
//
// No ratios are written in these comments — the same rule colors.ts and xtermTheme.test.ts follow,
// for the same reason. The measurements are the contract; a comment quoting one goes stale and gets
// believed anyway.
import { describe, expect, it } from "vitest";
import {
  DIALOG_MAX_FILL_SPLIT,
  EDGE_MIN_CONTRAST,
  INK_MIN_CONTRAST,
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

const MODES = ["light", "dark"] as const;

/** The two surfaces a dialog paints: its body, and the settings dialog's category rail. */
const DIALOG_PLANES = ["dialogSurface", "dialogNav"] as const;

describe("the modal plane separates by LINE, not by fill", () => {
  // Half one. `dialogEdge` is the modal's outer boundary and `hairline` its interior rules (the
  // title bar's underline, the rail's right edge, a field row's divider). Both are drawn on both
  // surfaces — the rail is inside the dialog, so a rule crossing it has to survive on either — so
  // the sweep is a cross-product rather than a list of remembered pairs.
  const EDGES = ["dialogEdge", "hairline"] as const;

  it("every dialog edge reads on both dialog surfaces, in both themes", () => {
    for (const mode of MODES) {
      const hex = THEME_HEX[mode];
      for (const edge of EDGES) {
        for (const plane of DIALOG_PLANES) {
          expect(
            contrast(hex[edge], hex[plane]),
            `${mode}: ${edge} (${hex[edge]}) is invisible on ${plane} (${hex[plane]}) — the modal would have no boundary`,
          ).toBeGreaterThan(EDGE_MIN_CONTRAST);
        }
      }
    }
  });

  // `inputEdge` is the rule around a text field, and a field renders BOTH in a dialog's body and in
  // the settings rail (the search box). It also has to be visible against the field's own fill, or
  // the input has no outline at all — which is the state the app was in for `inputSurface`, since
  // every field was outlined in the column-seam token instead.
  it("`inputEdge` reads on the field's own fill AND on both surfaces a field sits on", () => {
    for (const mode of MODES) {
      const hex = THEME_HEX[mode];
      for (const ground of ["inputSurface", ...DIALOG_PLANES] as const) {
        expect(
          contrast(hex.inputEdge, hex[ground]),
          `${mode}: inputEdge (${hex.inputEdge}) is invisible on ${ground} (${hex[ground]})`,
        ).toBeGreaterThan(EDGE_MIN_CONTRAST);
      }
    }
  });

  // Half two, and the one that needs a CEILING rather than a floor. This is the assertion that makes
  // "the rail looks too subtle, let me darken it" fail in CI instead of in a founder review.
  it("the dialog body and its nav rail are NOT separated by fill — that is the superseded design", () => {
    for (const mode of MODES) {
      const hex = THEME_HEX[mode];
      expect(
        contrast(hex.dialogSurface, hex.dialogNav),
        `${mode}: the rail has been stepped away from the dialog body — this design separates them with a rule, not a fill`,
      ).toBeLessThan(DIALOG_MAX_FILL_SPLIT);
    }
  });

  // …and the rule that does the dividing has to survive on both sides of itself. Without this the
  // ceiling above would be satisfiable by making the two surfaces identical with nothing between.
  it("…so the rule between them is visible from both sides", () => {
    for (const mode of MODES) {
      const hex = THEME_HEX[mode];
      for (const plane of DIALOG_PLANES) {
        expect(
          contrast(hex.hairline, hex[plane]),
          `${mode}: the rail's rule cannot be seen against ${plane}`,
        ).toBeGreaterThan(EDGE_MIN_CONTRAST);
      }
    }
  });

  // ── THE SELECTED RAIL ROW: WHAT ACTUALLY CARRIES IT ───────────────────────────────────────────
  // This assertion was `expect(hex.chatBubbleActive).not.toBe(hex.dialogNav)` for one round — a
  // string-identity check under a title claiming the two were "distinguishable" (roborev 54686). It
  // is the exact pattern chromeContrast's header bans, and banning it was not theoretical: measured
  // on this palette, the selected row's fill against the rail is BELOW even the edge floor in light,
  // i.e. the settings dialog's primary navigation state was a weaker signal than a 1px hairline
  // while the guard reported green. An inequality cannot see that, which is why it is banned.
  //
  // The fix is not to darken `--k-sel`. The spec's own `.dlg .nav .item.on` never asked the fill to
  // work alone — it carries THREE signals, `background` + `color` + `font-weight` — and the app had
  // shipped two of them. So the measurements below pin the signal that actually does the reading
  // (the INK step), and the fill is recorded for what it is: a hint that is deliberately under the
  // edge floor, because this design does not separate by fill.
  it("the selected row's INK is what carries it — measured, on the fill it is read on", () => {
    for (const mode of MODES) {
      const hex = THEME_HEX[mode];
      // the selected label, on the selected row's own fill
      expect(
        contrast(hex.cream, hex.chatBubbleActive),
        `${mode}: the selected category's label on its own fill`,
      ).toBeGreaterThanOrEqual(INK_MIN_CONTRAST);
      // …and it has to be a STEP away from an unselected label, or selection reads as nothing.
      // Both are measured on the rail, which is what an unselected row actually sits on.
      expect(
        contrast(hex.cream, hex.muted),
        `${mode}: the selected label (${hex.cream}) against an unselected one (${hex.muted})`,
      ).toBeGreaterThanOrEqual(EDGE_MIN_CONTRAST);
    }
  });

  // …and the fill is NOT a substitute for them, which is a claim about LIGHT specifically. The two
  // themes are not symmetric here and an earlier version of this test asserted they were: dark's
  // selected fill does clear the edge floor against the rail, light's does not come close. Writing
  // one bound across both modes would have been a false statement about dark that happened to fail
  // loudly; writing it about light only is the fact that matters, because light is the mode where
  // the selection had nothing but a sub-hairline fill behind it.
  it("in LIGHT the selected fill is under the edge floor — which is WHY the ink and weight carry it", () => {
    const hex = THEME_HEX.light;
    expect(
      contrast(hex.chatBubbleActive, hex.dialogNav),
      "light: the selected row's fill now separates from the rail on its own — if that is intended, " +
        "say so here rather than leaving two mechanisms half-doing the same job",
    ).toBeLessThan(EDGE_MIN_CONTRAST);
    // Dark is recorded as the other side of the asymmetry, so "make them consistent" is a deliberate
    // design change rather than a tidy-up — the same convention blueprintSpec.test.ts uses for the
    // terminal's light/dark step.
    expect(contrast(THEME_HEX.dark.chatBubbleActive, THEME_HEX.dark.dialogNav)).toBeGreaterThan(
      contrast(hex.chatBubbleActive, hex.dialogNav),
    );
  });
});

describe("every ink a dialog reads is legible on the surface it is read on", () => {
  // `cream` is the body ink, `muted` the secondary line and the LABEL treatment, `accentInk` the
  // action ink. All three are read on the dialog body, the rail, AND the selected rail row — a
  // category label keeps its ink when the row is selected, so the row's fill is a third ground.
  const INKS = ["cream", "muted", "accentInk"] as const;
  // `inputSurface` is in this list because a FIELD is a ground a dialog reads ink on — its value and
  // its placeholder. It was missing for one round while the EDGE sweep above already treated it as a
  // first-class ground, and that asymmetry was the tell (roborev 54709): the token became a real
  // painted surface in this pass, and a token whose edges are guarded but whose inks are not is
  // exactly what this file's header says gets retuned with nobody noticing what reads on it.
  const GROUNDS = [...DIALOG_PLANES, "chatBubbleActive", "inputSurface"] as const;

  it("body, secondary and action inks clear AA on all three grounds, in both themes", () => {
    for (const mode of MODES) {
      const hex = THEME_HEX[mode];
      for (const ink of INKS) {
        for (const ground of GROUNDS) {
          expect(
            contrast(hex[ink], hex[ground]),
            `${mode}: ${ink} (${hex[ink]}) on ${ground} (${hex[ground]})`,
          ).toBeGreaterThanOrEqual(INK_MIN_CONTRAST);
        }
      }
    }
  });

  // Status inks are read in a dialog too — a consent modal's warning line, an error under a field.
  it("the status inks clear AA on the dialog body", () => {
    for (const mode of MODES) {
      const hex = THEME_HEX[mode];
      for (const ink of ["dangerInk", "amberInk", "successInk"] as const) {
        expect(
          contrast(hex[ink], hex.dialogSurface),
          `${mode}: ${ink} (${hex[ink]}) on the dialog body (${hex.dialogSurface})`,
        ).toBeGreaterThanOrEqual(INK_MIN_CONTRAST);
      }
    }
  });

  it("a dialog's primary button pairs its fill with the ink meant to sit on it", () => {
    for (const mode of MODES) {
      const hex = THEME_HEX[mode];
      expect(
        contrast(hex.onGoldFill, hex.goldFill),
        `${mode}: onGoldFill (${hex.onGoldFill}) on goldFill (${hex.goldFill})`,
      ).toBeGreaterThanOrEqual(INK_MIN_CONTRAST);
    }
  });

  // ── ONE PLACE THE APP DEPARTS FROM THE SPEC PAGE, MEASURED RATHER THAN HIDDEN ──────────────────
  // The mock paints the settings rail's title (`.dlg .nav .t`) and its group headers (`.grp`) in
  // `--k-faint`. Those are the LABEL treatment: 10px mono, uppercase, tracked — the SMALLEST text in
  // the product, where WCAG is stricter, not looser. Measured on the two dialog surfaces, `faint`
  // does not clear AA at either end.
  //
  // So the dialogs take `muted` for that ink and keep everything else about the treatment. This is
  // recorded as a FAILING measurement rather than a comment, for two reasons: it stops the departure
  // being read as a porting mistake and "corrected" back, and if a future palette move lifts `faint`
  // over the floor this test goes red and tells the next reader they can have the spec's own value.
  //
  // It is deliberately NOT a nudge to the token. `faint` is a shell ink with its own call sites and
  // its own floors; retuning a global to satisfy one dialog is exactly the reactive move THE
  // NEUTRAL LADDER in colors.ts exists to prevent.
  //
  // MEASURED AGAINST `BLUEPRINT[mode].faint` DIRECTLY, NOT VIA `agentIdle`. This row first read the
  // spec's label ink through the `agentIdle` token, which was a fair proxy for exactly as long as
  // that token was mapped to `faint` — and it stopped being one in the same integration: `agentIdle`
  // was repointed to `muted` because it is READ AS TEXT (statusInk → BandBadge's count) and failed
  // AA at 2.85–4.07 across its planes. The proxy then made this row assert that `muted` fails AA,
  // which is the opposite of what the paragraph above claims, and it went red. Reading the spec
  // token itself keeps the claim about the SPEC's value rather than about whichever app token
  // happens to alias it today.
  it("the spec's label ink `faint` does NOT clear AA on the dialog planes, which is why `muted` is used", () => {
    for (const mode of MODES) {
      const hex = THEME_HEX[mode];
      const faint = BLUEPRINT[mode].faint;
      const best = Math.max(...DIALOG_PLANES.map((p) => contrast(faint, hex[p])));
      expect(
        best,
        `${mode}: the spec's faint (${faint}) now clears AA on a dialog plane — the departure above can be reverted to the spec's own value`,
      ).toBeLessThan(INK_MIN_CONTRAST);
    }
    // …and the ink actually used does clear it, on both. Without this half the test above would
    // pass just as happily if the labels were painted in something worse.
    for (const mode of MODES) {
      const hex = THEME_HEX[mode];
      for (const plane of DIALOG_PLANES) {
        expect(
          contrast(hex.muted, hex[plane]),
          `${mode}: the label ink actually used (${hex.muted}) on ${plane}`,
        ).toBeGreaterThanOrEqual(INK_MIN_CONTRAST);
      }
    }
  });
});
