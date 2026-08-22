import { describe, it, expect } from "vitest";
import { C as BRAND } from "@sparkle/ui";
import { statusInk, C, THEME_HEX, ON_BRAND_FILL_DARK } from "./colors";
import { AGENT_STATUS } from "@sparkle/ui";
import { stageMeta } from "../engine/workflowStage";

// statusInk maps a raw AGENT_STATUS color to a light-mode-legible THEMED ink. It branches on
// color-VALUE equality (the brand gray and the brand green), so these tests pin the mapping: a
// future taxonomy change that collides on a hex — or a token rename — fails here instead of
// silently miscoloring a status.
describe("statusInk (raw AGENT_STATUS color → themed text ink)", () => {
  it("flips the brand green ('working') to the themed successInk", () => {
    expect(statusInk(AGENT_STATUS.working.color)).toBe(C.successInk);
  });

  it("flips the brand gray ('done' and its idle/stopped peers) to agentIdle", () => {
    // idle/done/stopped share the brand gray, so all three map to agentIdle — and so does
    // `unmerged`, which left the red tier on 2026-07-26 (see packages/ui/tokens.ts). (`blocked` is
    // still RED, so it passes through — asserted in the red group below.)
    for (const st of ["done", "idle", "stopped", "unmerged"] as const) {
      expect(statusInk(AGENT_STATUS[st].color)).toBe(C.agentIdle);
    }
  });

  it("flips the brand RED tier to the themed dangerInk", () => {
    // THIS TEST USED TO ASSERT THE OPPOSITE, under the title "passes red/amber statuses through
    // unchanged (already legible in both themes)". The parenthetical was simply false, and nothing
    // measured it: BRAND.sienna is 3.83:1 on light's white concierge column and 3.54:1 on the
    // builder column. It paints the NAME of a worker row in the sidebar — an underlined-on-hover
    // link — and the concierge's needs-you sentence. `dangerInk` is the themed counterpart that
    // already existed. The ratios themselves are held by theme/linkContrast.test.ts; what this
    // pins is the MAPPING, so a taxonomy change that collides on a hex fails here.
    for (const st of ["waiting", "approval", "errored", "blocked"] as const) {
      expect(statusInk(AGENT_STATUS[st].color)).toBe(C.dangerInk);
    }
    // …and it really is a change, not an identity: the tier does not already equal the ink.
    expect(C.dangerInk).not.toBe(AGENT_STATUS.waiting.color);
  });

  it("flips the brand AMBER tier ('lapsed') to the themed amberInk", () => {
    // The third tier to need an arm, after red and blue, which is what makes it a rule: raw brand
    // amber measures ~1.7:1 on light's builder column — under HALF the 3.83:1 that was judged
    // insufficient for red above — and `lapsed` reaches TEXT directly, via AlertToggleButton's
    // label and border (alertControlKind returns a dismiss/re-enable control for it). Without this
    // arm it fell through `return color` and painted the raw fill hex.
    expect(statusInk(AGENT_STATUS.lapsed.color)).toBe(C.amberInk);
    expect(C.amberInk).not.toBe(AGENT_STATUS.lapsed.color);
  });

  it("gives EVERY status colour an ink that is not the raw fill, except the ones that pass through", () => {
    // The generalisation of the four cases above, so a SIXTH tier cannot be added without either an
    // arm here or a deliberate decision recorded in this list. Green/gray/red/blue/amber all map;
    // nothing else in the taxonomy may silently rely on the fallthrough.
    const MAPPED = new Set([
      AGENT_STATUS.working.color,
      AGENT_STATUS.idle.color,
      AGENT_STATUS.waiting.color,
      AGENT_STATUS.questions.color,
      AGENT_STATUS.lapsed.color,
    ]);
    for (const st of Object.keys(AGENT_STATUS) as (keyof typeof AGENT_STATUS)[]) {
      expect(MAPPED.has(AGENT_STATUS[st].color)).toBe(true);
      expect(statusInk(AGENT_STATUS[st].color)).not.toBe(AGENT_STATUS[st].color);
    }
  });

  it("leaves a colour outside the taxonomy alone", () => {
    // The fallthrough still exists and still means "not a status colour I know" — without this,
    // the three mappings above could be replaced by an unconditional `return C.dangerInk` and the
    // suite would not notice.
    expect(statusInk("#123456")).toBe("#123456");
  });
});

// Guards that switching the shipped ✓ green to successInk is a LIGHT-mode-only change:
// successInk's DARK value must equal the brand green the final "shipped" stage uses, so the
// dark-mode ✓ color is byte-for-byte unchanged.
describe("successInk dark value preserves the final-stage green", () => {
  it("THEME_HEX.dark.successInk equals the shipped stage color and BRAND.success", () => {
    expect(THEME_HEX.dark.successInk).toBe(BRAND.success);
    expect(stageMeta("shipped").color).toBe(BRAND.success);
  });

  it("light successInk is darker than the brand green (the legibility fix)", () => {
    expect(THEME_HEX.light.successInk).not.toBe(THEME_HEX.dark.successInk);
  });
});

// ── TEXT ON A BRAND FILL ──────────────────────────────────────────────────────────────────────
// `C.onFillInk` exists to give `ON_BRAND_FILL_DARK` a name `theme/linkContrast` can trace. A RENAME
// that changes the value is not a rename, and this pair is where that goes wrong quietly: both
// names read like ink-on-a-fill, so a themed value substituted for the constant looks right in
// review and in dark mode, and only light mode shows it.
//
// It shipped exactly once, and the wrong check is what let it: `--c-forest` and `--c-on-fill-ink`
// held the same hex in index.css, so comparing THOSE confirmed a claim about a token neither of
// them is. `ON_BRAND_FILL_DARK` is `BRAND.forest` — the CONSTANT `#0a1a3f` — while `C.forest` is
// `var(--c-forest)`, the themed app background. Compare against the constant or prove nothing.
const lum = (hex: string) => {
  const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * v[0]! + 0.7152 * v[1]! + 0.0722 * v[2]!;
};
/** WCAG 2.x contrast ratio. */
const ratio = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m) as [number, number];
  return (x + 0.05) / (y + 0.05);
};

describe("C.onFillInk — ink for text on a brand FILL", () => {
  it("is ON_BRAND_FILL_DARK byte for byte, because it is that token's NAME", () => {
    expect(C.onFillInk).toBe(ON_BRAND_FILL_DARK);
  });

  it("is a CONSTANT, not a themed var — the fills it sits on do not change with the theme", () => {
    // `C.sienna` / `C.amber` are brand identity and pass through unthemed. An ink that flipped
    // with the theme would be legible against only one of them: the themed value was `#d9e3f3`
    // in light mode, i.e. near-white on amber.
    expect(C.onFillInk).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(C.onFillInk).not.toMatch(/^var\(/);
    // ...and it is therefore NOT a per-theme token, in either palette.
    expect(THEME_HEX.dark).not.toHaveProperty("onFillInk");
    expect(THEME_HEX.light).not.toHaveProperty("onFillInk");
  });

  it("beats the THEMED alternative on every constant fill it is used over", () => {
    // The guard for this token's whole reason to be a constant. Measured, sRGB relative luminance
    // per WCAG 2.x:
    //                       constant #0a1a3f     themed light #d9e3f3
    //   on C.amber                  7.06                     1.87   <- near-invisible
    //   on C.sienna                 4.45                     2.96
    // So this is not a stylistic preference between two defensible inks. Routing this through a
    // themed var made the amber bar's text 1.87:1 in light mode, and dark mode looked fine, which
    // is why it reviewed clean. Asserting the constant simply "is dark" would not have caught it —
    // what pins it is that the constant BEATS the themed value on both fills.
    const themedLight = "#d9e3f3"; // BLUEPRINT.light.term — what --c-on-fill-ink resolved to
    for (const fill of [C.sienna, C.amber]) {
      expect(fill).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(ratio(C.onFillInk, fill)).toBeGreaterThan(ratio(themedLight, fill));
    }
    expect(ratio(C.onFillInk, C.amber)).toBeGreaterThanOrEqual(4.5);
  });

  it("RATCHET: neither fill's contrast may fall from what ships today", () => {
    // sienna sits at 4.45 against AA's 4.5 — a REAL 1.2% shortfall in the shipped brand pair, not
    // something this change introduced and not something a token rename may quietly relitigate.
    // Recorded rather than rounded away: it is filed, and the floor here stops it drifting further
    // while the design call is made. Raise these when the pair is retuned; never lower them.
    expect(ratio(C.onFillInk, C.sienna)).toBeGreaterThanOrEqual(4.44);
    expect(ratio(C.onFillInk, C.amber)).toBeGreaterThanOrEqual(7.05);
  });
});
