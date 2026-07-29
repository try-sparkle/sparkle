// Fidelity guard for the terminal pane's chrome tokens.
//
// The failure this exists to stop is not "a wrong colour" — it is the one that has actually shipped
// six times: porting the direction's PALETTE and re-inventing its STRUCTURE. So the type scale, the
// radii and the mono stack are read out of the approved page itself
// (`PRD/sparkle/ui-directions/rev4.html`) and compared, exactly as `theme/blueprintSpec.test.ts`
// does for the colours. Change the design and this fails until the module is updated; change the
// module and it fails until the design agrees.
//
// The rule token is checked from BOTH ends: that `--c-term-hairline` is a real mirrored variable
// carrying THEME_HEX's `termHairline`, and that it is NOT the chrome `hairline`. The second half is
// the load-bearing one — `theme/chromeContrast.test.ts` deliberately does not floor `hairline`
// against the terminal plane (it skips that pair and floors `termHairline` there instead), so a
// regression to `C.hairline` on this plane would be an edge with no contrast guard anywhere.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { C, THEME_HEX } from "../theme/colors";
import { BLUEPRINT } from "../theme/blueprintSpec";
import { TERM_HAIRLINE, TERM_MONO, TERM_PLANE, TERM_RADIUS, TERM_TYPE, TERM_UI, termInk, termMuted, termMutedSpec } from "./terminalChrome";

const spec = readFileSync(
  fileURLToPath(new URL("../../../../PRD/sparkle/ui-directions/rev4.html", import.meta.url)),
  "utf8",
);
const css = readFileSync(fileURLToPath(new URL("../index.css", import.meta.url)), "utf8");

/** Read a `--name:value;` declaration out of the mock's first (light) `:root` block. */
function specVar(name: string): string {
  const m = spec.match(new RegExp(`${name}\\s*:\\s*([^;}]+)`));
  if (!m?.[1]) throw new Error(`token not found in rev4.html: ${name}`);
  return m[1].trim();
}

/** The px integer behind a `--t-*` / `--r-*` token. */
function specPx(name: string): number {
  const raw = specVar(name);
  const n = Number(raw.replace(/px$/, ""));
  if (!Number.isFinite(n)) throw new Error(`${name} is not a px length: ${raw}`);
  return n;
}

/** Read a `--c-*` declaration out of one of index.css's two theme blocks. */
function cssVar(selector: string, name: string): string {
  const body = css.match(
    new RegExp(`${selector.replace(/[[\]]/g, "\\$&")}\\s*\\{([^}]*)\\}`),
  )?.[1];
  if (body == null) throw new Error(`selector not found in index.css: ${selector}`);
  const m = body.match(new RegExp(`${name}\\s*:\\s*(#[0-9a-fA-F]{6})`));
  if (!m?.[1]) throw new Error(`${name} not declared under ${selector}`);
  return m[1].toLowerCase();
}

const MODES = [
  { mode: "dark" as const, selector: ":root" },
  { mode: "light" as const, selector: ':root[data-theme="light"]' },
];

describe("terminal chrome — surfaces and rules", () => {
  it("the pane's surface is the spec's `term` plane", () => {
    expect(TERM_PLANE).toBe("var(--c-forest)");
    for (const { mode, selector } of MODES) {
      // `--c-forest` is THEME_HEX.forest, which is BLUEPRINT[mode].term. Walking the whole chain
      // is what makes "the pane paints the term plane" a checked statement rather than a comment.
      expect(cssVar(selector, "--c-forest")).toBe(THEME_HEX[mode].forest.toLowerCase());
      expect(THEME_HEX[mode].forest).toBe(BLUEPRINT[mode].term);
    }
  });

  it("the rule on this plane is the spec's `termHair`, mirrored as --c-term-hairline", () => {
    expect(TERM_HAIRLINE).toBe("var(--c-term-hairline)");
    for (const { mode, selector } of MODES) {
      expect(cssVar(selector, "--c-term-hairline")).toBe(THEME_HEX[mode].termHairline.toLowerCase());
      expect(THEME_HEX[mode].termHairline).toBe(BLUEPRINT[mode].termHair);
    }
  });

  it("that rule is NOT the chrome hairline — the two are different tokens with different guards", () => {
    // `C.hairline` is the shell's seam. chromeContrast floors it on every plane EXCEPT the terminal
    // one, where `termHairline` is floored instead — so these must not converge to the same var.
    expect(TERM_HAIRLINE).not.toBe(C.hairline);
    for (const { mode } of MODES) {
      expect(THEME_HEX[mode].termHairline).not.toBe(THEME_HEX[mode].hairline);
    }
  });
});

describe("terminal chrome — inks", () => {
  it("uses the terminal's OWN ink register, not the shell's", () => {
    for (const { mode } of MODES) {
      expect(termInk(mode)).toBe(BLUEPRINT[mode].termInk);
      // `termMutedSpec`, not `termMuted`: the pane's secondary INK deliberately departs from the
      // spec's value, which is under AA on this plane (see the legibility block below). The claim
      // being made here is about the REGISTER — the pane has its own — and that is unaffected.
      expect(termMutedSpec(mode)).toBe(BLUEPRINT[mode].termMuted);
      // The shell's inks are a different register. If these ever coincide the pane has quietly been
      // re-pointed at chrome ink, which is the drift the separate tokens exist to prevent.
      expect(termInk(mode)).not.toBe(THEME_HEX[mode].cream);
      expect(termMuted(mode)).not.toBe(THEME_HEX[mode].muted);
    }
  });

  it("matches the ink values written on the approved page", () => {
    expect(termInk("light")).toBe(specVar("--k-term-ink"));
    expect(termMutedSpec("light")).toBe(specVar("--k-term-muted"));
    // The dark block redeclares both; take them from the explicit [data-theme="dark"] rule.
    const darkBlock = spec.match(/:root\[data-theme="dark"\]\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(darkBlock).toContain(`--k-term-ink:${termInk("dark")}`);
    expect(darkBlock).toContain(`--k-term-muted:${termMutedSpec("dark")}`);
  });
});

describe("terminal chrome — type scale and radii come from the approved page", () => {
  it("the type scale is --t-micro / --t-small / --t-body / --t-title", () => {
    expect(TERM_TYPE.micro).toBe(specPx("--t-micro"));
    expect(TERM_TYPE.small).toBe(specPx("--t-small"));
    expect(TERM_TYPE.body).toBe(specPx("--t-body"));
    expect(TERM_TYPE.title).toBe(specPx("--t-title"));
  });

  it("the radii are near-square: --r-sm / --r-in / --r-md", () => {
    expect(TERM_RADIUS.sm).toBe(specPx("--r-sm"));
    expect(TERM_RADIUS.input).toBe(specPx("--r-in"));
    expect(TERM_RADIUS.modal).toBe(specPx("--r-md"));
    // "Near-square" is the point of the direction's shapes; nothing on this plane pillows.
    expect(TERM_RADIUS.modal).toBeLessThanOrEqual(6);
  });

  it("the font stacks are --k-mono and --k-ui", () => {
    // Normalised for the whitespace the mock omits and the source carries.
    const squash = (s: string) => s.replace(/\s+/g, "");
    expect(squash(TERM_MONO)).toBe(squash(specVar("--k-mono")));
    expect(squash(TERM_UI)).toBe(squash(specVar("--k-ui")));
  });
});

// ── THE PANE'S INK CLEARS AA ON THE PANE — roborev 54704 ─────────────────────────────────────
// The port routed four TEXT sites (the loading hint, the overlay message, AgentPane's error and
// `Centered`) onto the pane's own register, which was a net contrast REGRESSION at every one:
// they had been using the shell's inks, and the overlay message fell from 7.77 to 3.96 in light.
// Nothing measured it — the sweeps were scoped to the concierge column, and this file asserted
// token IDENTITY only, which cannot see a legibility change.
describe("the terminal register is legible on the terminal plane", () => {
  const AA = 4.5;
  const lum = (hex: string) => {
    const ch = (i: number) => {
      const v = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * ch(0) + 0.7152 * ch(1) + 0.0722 * ch(2);
  };
  const ratio = (a: string, b: string) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
    return (hi + 0.05) / (lo + 0.05);
  };

  for (const mode of ["light", "dark"] as const) {
    it(`${mode}: both inks clear AA on the pane`, () => {
      const plane = BLUEPRINT[mode].term;
      expect(ratio(termInk(mode), plane)).toBeGreaterThanOrEqual(AA);
      expect(ratio(termMuted(mode), plane)).toBeGreaterThanOrEqual(AA);
    });

    it(`${mode}: the SPEC's own --k-term-muted does NOT — which is why termMuted departs`, () => {
      // Recorded as a failing measurement so the departure reads as a decision rather than drift,
      // and so a future palette move that makes the spec's value legible turns this red and offers
      // it back. Deliberately not a change to blueprintSpec.ts: that file is the spec transcribed,
      // and editing it to suit the app is how a "port" stops being one.
      expect(ratio(termMutedSpec(mode), BLUEPRINT[mode].term)).toBeLessThan(AA);
    });

    it(`${mode}: the departure is a luminance move within the same hue`, () => {
      // The fix must not become "pick a different colour". Same hue family, one step further from
      // the plane: darker in light, lighter in dark.
      const [a, b] = [termMuted(mode), termMutedSpec(mode)];
      expect(mode === "light" ? lum(a) < lum(b) : lum(a) > lum(b)).toBe(true);
    });
  }
});
