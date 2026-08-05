// THE SEND TRAY'S LABELS, MEASURED ON THE SURFACE THEY ARE ACTUALLY PAINTED ON.
//
// The founder's report, with a screenshot of the three mode buttons: Send and Push to talk (both
// UNSELECTED) are crisp, and Speak (SELECTED, nothing running) is the hardest of the three to read.
// His words: "the text should be above the button … which is shaded behind … basically the same font
// color … as when it's not an active button". Selection was costing legibility on the one pill whose
// whole job is to say which mode you are in.
//
// The cause was `color: ink` on the selected-but-idle pill — the label drawn in the SAME hue as its
// own fill and border. This file is the guard that keeps it fixed, and it exists because nothing
// composited the pill fill before: theme/amberInk.test.ts models the presence slider's segment tint
// and theme/chromeContrast.test.ts pairs edges to planes, but the send tray's own stack (plane → tray
// strip → pill fill → label) was unmeasured. It had been shipping a hard AA failure — amber ink on a
// 22% amber fill in light mode measures 1.95 — that no test could see.
//
// ── THE RULE THIS ASSERTS ───────────────────────────────────────────────────────────────────────
// SELECTION IS CARRIED BY THE FILL AND THE BORDER, NEVER BY TINTING THE TEXT. So the selected-idle
// label must be at least as legible as an unselected one on the same tray — not merely "AA somewhere
// above 4.5", which the old amber-on-amber would still have failed but which green-on-green would
// have passed while looking exactly like the founder's screenshot. The baseline is the comparison a
// user actually makes, because the three pills sit side by side.
//
// ── WHY THE CONSTANTS ARE IMPORTED AND NOT RESTATED ─────────────────────────────────────────────
// The washes (8%, 22%) and the ink tokens come from components/Concierge/trayInk, which is the same
// module the component paints through. A test that re-spelled them would be a copy of the component
// that goes stale while staying green — the failure mode trayGeometry records as roborev 56213.
import { describe, expect, it } from "vitest";
import { C as BRAND } from "@sparkle/ui";
import { THEME_HEX } from "./colors";
import { BLUEPRINT } from "./blueprintSpec";
import {
  MODE_INK_TOKEN,
  PILL_LABEL_TOKEN,
  TRAY_SELECTED_FILL_PCT,
  TRAY_STRIP_TINT_PCT,
  TRAY_SWEEP_INK_TOKEN,
  TRAY_SWEEP_TINT_PCT,
} from "../components/Concierge/trayInk";

/** WCAG AA for normal text. The tray's labels are TYPE.small (12px) and TYPE.micro (10px) — both
 *  well under the 18.66px "large text" threshold that would allow the 3:1 relaxation. */
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

/** What a `color-mix(… n%, transparent)` wash actually LOOKS like once painted over an opaque
 *  surface: plain source-over compositing. The tray stacks two of these. */
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

/** Resolve an ink token to hex. Most are themed (THEME_HEX); `amber` is brand-constant and lives on
 *  BRAND — which is exactly why trayInk stores NAMES: the two families resolve differently. */
function ink(theme: Theme, token: string): string {
  const themed = (THEME_HEX[theme] as Record<string, string>)[token];
  return themed ?? (BRAND as unknown as Record<string, string>)[token];
}

/**
 * The two planes the tray can sit on, and the edge it draws in each.
 *
 * WIRED IS NOT OPTIONAL TO MODEL. When the concierge column is patched to a terminal it FLOODS to
 * the terminal plane and the composer goes transparent, so every control in the row is read on
 * `--k-term` instead of `--k-input` — a different surface, and in light mode a considerably darker
 * one. SendModeTray takes that as its `wired` prop and swaps `C.hairline` for `termHair`. Measuring
 * only the unwired plate is the mistake theme/amberInk.test.ts's header records (it certified AA
 * against a surface the control never touches), so both are measured here.
 */
function plate(theme: Theme, wired: boolean): { surface: string; edge: string } {
  return wired
    ? { surface: BLUEPRINT[theme].term, edge: BLUEPRINT[theme].termHair }
    : // `seam` and NOT `inputEdge`: the component's unwired edge is `C.hairline`, which resolves
      // through THEME_HEX.hairline to BLUEPRINT.seam. Reading the wrong one here would measure a
      // strip the tray never paints.
      { surface: BLUEPRINT[theme].input, edge: BLUEPRINT[theme].seam };
}

/**
 * The tray strip's own painted colour — its edge at `TRAY_STRIP_TINT_PCT` over the plane, plus the
 * countdown SWEEP when one is running.
 *
 * THE SWEEP IS A REAL LAYER UNDER EVERY LABEL and omitting it made this file's coverage claim false
 * (roborev 59015). While Speak counts, the sweep spans the tray at `zIndex: 0` and the pills sit
 * above it at `zIndex: 1` — and an UNSELECTED pill's background is `transparent`, so its label is
 * read on strip+sweep, not on the bare strip. A selected pill's fill is itself a wash, so the sweep
 * shows through that too; hence it composites underneath in both cases.
 *
 * Modelled at full extent (the sweep starts spanning the whole tray and recedes), which is the
 * worst case for every pill and therefore the right one to hold a floor against.
 */
function strip(theme: Theme, wired: boolean, sweeping = false): string {
  const { surface, edge } = plate(theme, wired);
  const base = over(edge, TRAY_STRIP_TINT_PCT, surface);
  return sweeping ? over(ink(theme, TRAY_SWEEP_INK_TOKEN), TRAY_SWEEP_TINT_PCT, base) : base;
}

/** A SELECTED-BUT-IDLE pill's painted fill: the position's identity colour, washed onto the strip. */
function selectedFill(
  theme: Theme,
  wired: boolean,
  mode: keyof typeof MODE_INK_TOKEN,
  sweeping = false,
): string {
  return over(
    ink(theme, MODE_INK_TOKEN[mode]),
    TRAY_SELECTED_FILL_PCT,
    strip(theme, wired, sweeping),
  );
}

const THEMES: Theme[] = ["dark", "light"];
const WIRED = [false, true];
const MODES = ["send", "ptt", "speak"] as const;
/** Both countdown states, because the sweep changes the surface every label is read on. */
const SWEEPING = [false, true];

describe("send tray — the selected label stays as legible as an unselected one", () => {
  // ── THE HEADLINE GUARD ────────────────────────────────────────────────────────────────────────
  // This is the founder's complaint stated as a number, and it is a RELATIVE floor on purpose. An
  // absolute "must clear AA" would have passed the selected Speak pill in dark mode (5.19) while it
  // still looked exactly like the screenshot he sent, because the unselected labels beside it are at
  // 6.78. The thing he can see is the DIFFERENCE.
  // Compared at the same countdown state FIRST, and then at the mixed one the geometry actually
  // produces (see the next test) — the sweep is right-anchored and recedes, so "both sides swept" is
  // only true at the very start of a countdown. Same-state is the clean floor; mixed is the honest
  // one. Compared at the same countdown state, because the sweep moves both sides: it darkens the strike
  // under an unselected label and shows through a selected pill's fill alike. Holding a resting
  // baseline against a swept selected pill would be comparing two different surfaces.
  it("selected-but-idle label is never dimmer than the unselected baseline, on any plane", () => {
    for (const theme of THEMES) {
      for (const wired of WIRED) {
        for (const sweeping of SWEEPING) {
          const baseline = contrast(
            ink(theme, PILL_LABEL_TOKEN.unselected),
            strip(theme, wired, sweeping),
          );
          for (const mode of MODES) {
            const ratio = contrast(
              ink(theme, PILL_LABEL_TOKEN.selectedIdle),
              selectedFill(theme, wired, mode, sweeping),
            );
            expect(
              ratio,
              `${theme}/${wired ? "wired" : "unwired"}${sweeping ? "/sweeping" : ""} ${mode}: ` +
                `selected label ${ratio.toFixed(2)}:1 on its fill vs unselected baseline ` +
                `${baseline.toFixed(2)}:1 — selection must not cost legibility`,
            ).toBeGreaterThanOrEqual(baseline);
          }
        }
      }
    }
  });

  // ── THE PAIRING THE GEOMETRY ACTUALLY PRODUCES ────────────────────────────────────────────────
  // The sweep is anchored RIGHT and its leading edge walks toward Speak's left edge, so through most
  // of a countdown the swept SELECTED Speak pill sits beside UNSWEPT unselected pills. That mixed
  // pairing is the one a user sees, and it is slightly worse than either uniform state (roborev
  // 59042). Worst case, measured: dark/unwired Speak 6.76 vs a 6.78 unswept baseline — 0.3% short.
  //
  // A HAIR OF TOLERANCE, STATED, rather than a rule that quietly excludes its own hardest case. 2%
  // is far below anything perceptible and still an order of magnitude tighter than the defect this
  // file exists for (5.19 against 6.78 — a 23% shortfall the founder could see in a screenshot).
  const MIXED_PAIRING_TOLERANCE = 0.98;

  it("holds even mid-countdown, where a swept selected pill sits beside unswept ones", () => {
    for (const theme of THEMES) {
      for (const wired of WIRED) {
        const baseline = contrast(ink(theme, PILL_LABEL_TOKEN.unselected), strip(theme, wired));
        for (const mode of MODES) {
          const ratio = contrast(
            ink(theme, PILL_LABEL_TOKEN.selectedIdle),
            selectedFill(theme, wired, mode, true),
          );
          expect(
            ratio,
            `${theme}/${wired ? "wired" : "unwired"} ${mode}: swept selected label ` +
              `${ratio.toFixed(2)}:1 vs unswept baseline ${baseline.toFixed(2)}:1`,
          ).toBeGreaterThanOrEqual(baseline * MIXED_PAIRING_TOLERANCE);
        }
      }
    }
  });

  it("the selected-but-idle label clears WCAG AA on every plane, sweeping or not", () => {
    for (const theme of THEMES) {
      for (const wired of WIRED) {
        for (const sweeping of SWEEPING) {
          for (const mode of MODES) {
            expect(
              contrast(
                ink(theme, PILL_LABEL_TOKEN.selectedIdle),
                selectedFill(theme, wired, mode, sweeping),
              ),
              `${theme}/${wired ? "wired" : "unwired"}${sweeping ? "/sweeping" : ""} ${mode}: ` +
                `selected-but-idle label on its fill`,
            ).toBeGreaterThanOrEqual(AA_NORMAL);
          }
        }
      }
    }
  });

  // ── THE UNSELECTED BASELINE, AND A SECOND PRE-EXISTING GAP THE SWEEP OPENS ────────────────────
  // At REST the unselected label clears AA on all four planes. UNDER THE SWEEP it does not, in
  // light mode: the sweep is an 18% successInk wash across the whole tray and the unselected pills
  // are transparent, so `conciergeMuted` is read on strip+sweep — 4.39 light/unwired and 3.51
  // light/wired. Both are pre-existing (the sweep and that ink both predate this change) and both
  // are outside the founder's report, which is about the SELECTED pill. Pinned rather than
  // exempted, so they cannot widen silently. See the UNFILED note on the acting gap below — these
  // want the same bead treatment.
  it("the unselected label clears AA at rest, on every plane", () => {
    for (const theme of THEMES) {
      for (const wired of WIRED) {
        expect(
          contrast(ink(theme, PILL_LABEL_TOKEN.unselected), strip(theme, wired)),
          `${theme}/${wired ? "wired" : "unwired"}: unselected label on the resting strip`,
        ).toBeGreaterThanOrEqual(AA_NORMAL);
      }
    }
  });

  it("KNOWN GAP (UNFILED): under the countdown sweep the unselected label drops below AA in light", () => {
    // Dark is unaffected — it keeps a comfortable margin under the sweep.
    for (const wired of WIRED) {
      expect(
        contrast(ink("dark", PILL_LABEL_TOKEN.unselected), strip("dark", wired, true)),
        `dark/${wired ? "wired" : "unwired"}: unselected label under the sweep`,
      ).toBeGreaterThanOrEqual(AA_NORMAL);
    }
    // Light is the gap, and it is a real one at both plates.
    expect(contrast(ink("light", PILL_LABEL_TOKEN.unselected), strip("light", false, true))).toBeCloseTo(4.39, 1);
    expect(contrast(ink("light", PILL_LABEL_TOKEN.unselected), strip("light", true, true))).toBeCloseTo(3.51, 1);
  });

  // ── THE REGRESSION THIS REPLACED, PINNED AS A NEGATIVE ────────────────────────────────────────
  // Guards the specific mistake rather than only its symptom: if someone reverts the label to the
  // position's identity colour, this fails by name even if the palette has moved on. Push to talk in
  // light mode is the worst case (amber ink on an amber wash) and it is not a near miss — 1.95:1
  // against a 4.5 floor — which is what makes it a safe, non-flaky pin.
  it("the OLD treatment — label painted in its own fill's hue — really was a failure", () => {
    const worst = contrast(ink("light", MODE_INK_TOKEN.ptt), selectedFill("light", false, "ptt"));
    expect(worst).toBeLessThan(AA_NORMAL);
    // And the fix clears the same floor comfortably on the same surface.
    const fixed = contrast(ink("light", PILL_LABEL_TOKEN.selectedIdle), selectedFill("light", false, "ptt"));
    expect(fixed).toBeGreaterThanOrEqual(AA_NORMAL);
    expect(fixed).toBeGreaterThan(worst);
  });

  // ── THE ACTING STATE: MEASURED, AND ONE KNOWN GAP LEFT DELIBERATELY UNFIXED ───────────────────
  // Acting is NOT held to the baseline rule above: it inverts onto a SOLID identity fill, which is
  // its own pairing, and it is the one state the founder explicitly was not complaining about
  // ("a distinct treatment is fine and expected … do not change it"). It still has to be readable,
  // so it is measured here — and measuring it turned up a PRE-EXISTING failure that is out of scope
  // for the selected-but-idle fix.
  //
  // IT IS NOT FILED AS A BEAD, and this comment says so rather than implying otherwise: the beads
  // Dolt store was locked by another process across every attempt while this branch was written
  // (~12 tries over ~20 minutes). Saying "tracked separately" when nothing tracks it is how a real
  // AA failure becomes permanent — the next reader sees "tracked" and moves on (roborev 59015).
  // FILE IT, then put the id in the test titles below and delete this paragraph.
  //
  // THE GAP: the acting branch paints `onGoldFill` for all three positions, but that token is the
  // partner of `goldFill` alone. In LIGHT mode it is #ffffff, and Push to talk's fill is brand amber
  // #e0982f — 2.41:1, under AA, in the state where the user is holding the key and being heard.
  // Dark is fine (#04101f there); Send and Speak are fine in both. It is specifically light+amber.
  const ACTING_KNOWN_GAP = new Set(["light/ptt"]);

  it("the acting state's inverted label clears AA on its solid fill — except the tracked gap", () => {
    for (const theme of THEMES) {
      for (const mode of MODES) {
        if (ACTING_KNOWN_GAP.has(`${theme}/${mode}`)) continue;
        expect(
          contrast(ink(theme, PILL_LABEL_TOKEN.acting), ink(theme, MODE_INK_TOKEN[mode])),
          `${theme} ${mode}: acting label on the solid fill`,
        ).toBeGreaterThanOrEqual(AA_NORMAL);
      }
    }
  });

  // PINNED so the gap cannot silently WIDEN, and so fixing it turns this test red on purpose rather
  // than leaving a stale exemption behind. When the acting label gets an ink paired with the fill it
  // actually sits on, delete this test and `ACTING_KNOWN_GAP` above.
  it("KNOWN GAP (UNFILED — beads store locked): light-mode Push to talk acting label is white on amber, under AA", () => {
    const ratio = contrast(ink("light", PILL_LABEL_TOKEN.acting), ink("light", MODE_INK_TOKEN.ptt));
    expect(ratio).toBeLessThan(AA_NORMAL);
    expect(ratio).toBeCloseTo(2.41, 1);
  });
});
