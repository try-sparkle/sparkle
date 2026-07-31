// THE FIDELITY GUARD. Every other test in theme/ measures the palette against itself — contrast
// floors, ladder ordering, ink legibility. All of them passed while the app looked nothing like the
// design, because internal consistency is not fidelity. This one re-reads the approved spec page
// and fails if the app's transcription of it has drifted by a single byte.
//
// It is the check that was missing for three releases.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BLUEPRINT, type BlueprintTheme } from "./blueprintSpec";

const SPEC = fileURLToPath(new URL("../../../../PRD/sparkle/ui-directions/index.html", import.meta.url));
/** rev-4 — THE COCKPIT. The approved mock the concierge column is ported from. It carries the
 *  tokens rev-4 ADDS on top of the direction page above (`--wm-*`, `--z-lift`), so those are read
 *  from here rather than from `index.html`, which predates them and has none of them. */
const REV4 = fileURLToPath(new URL("../../../../PRD/sparkle/ui-directions/rev4.html", import.meta.url));

/** Pull the `--k-*` declarations out of a CSS block body. */
function tokens(body: string): Record<string, string> {
  return Object.fromEntries(
    [...body.matchAll(/(--k-[a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]),
  );
}

/** The two blocks that define the direction: its base (light) and its dark override. */
function readSpec(): { light: Record<string, string>; dark: Record<string, string> } {
  const s = readFileSync(SPEC, "utf8");
  const lightBlock = /\[data-dir="blueprint"\] \.shell,\s*\[data-dir="blueprint"\] \.modalstage \{(.*?)\n {2}\}/s.exec(s);
  const darkBlock = /\[data-eff="dark"\][^{]*\{([^}]*--k-ground[^}]*)\}/s.exec(s);
  if (!lightBlock) throw new Error("blueprint light block not found in the spec page");
  if (!darkBlock) throw new Error("blueprint dark override not found in the spec page");
  return { light: tokens(lightBlock[1]!), dark: tokens(darkBlock[1]!) };
}

/** A `1px solid #hex` edge declaration reduced to its colour, which is what the app stores. */
const edgeColor = (v: string) => /#[0-9a-f]{3,8}/i.exec(v)?.[0] ?? v;

/** app field → spec token, and how to read the spec's value. */
const MAP: [keyof BlueprintTheme, string, ((v: string) => string)?][] = [
  ["ground", "--k-ground"],
  ["assist", "--k-assist"],
  ["bridge", "--k-bridge"],
  ["bar", "--k-bar"],
  ["term", "--k-term"],
  ["sel", "--k-sel"],
  ["input", "--k-input"],
  ["bubble", "--k-bubble"],
  ["ink", "--k-ink"],
  ["muted", "--k-muted"],
  ["faint", "--k-faint"],
  ["termInk", "--k-term-ink"],
  ["termMuted", "--k-term-muted"],
  ["primary", "--k-primary"],
  ["onPrimary", "--k-on-primary"],
  ["rule", "--k-rule"],
  ["dialog", "--k-dialog"],
  ["dialogNav", "--k-dialog-nav"],
  ["scrim", "--k-scrim"],
  ["shadow", "--k-shadow"],
  ["hair", "--k-hair", edgeColor],
  ["hairSolid", "--k-hair-solid", edgeColor],
  ["seam", "--k-seam", edgeColor],
  ["termHair", "--k-term-hair", edgeColor],
  ["dialogEdge", "--k-dialog-edge", edgeColor],
  ["inputEdge", "--k-input-edge", edgeColor],
];

/** app field → `rev4.html` token, for the tokens rev-4 ADDS (the direction page predates them and
 *  has no opinion about them). The SAME SHAPE as `MAP` above, and deliberately so.
 *
 *  It was a bare list of field NAMES, which left the coverage check below faked-able from the one
 *  side it did not cover. Naming a field in `MAP` forces a real comparison — the loop reads that
 *  token out of `index.html` and fails if it is missing or wrong — so `MAP` cannot be padded to
 *  silence anything. A list of names can: the next rev-4 token would produce a red coverage test
 *  whose own message invites you to add the name, and the suite would go green with that field
 *  pinned to nothing at all. Same escape the guard exists to remove, one level in.
 *
 *  Pairing the field with its token closes it: naming a field is what CREATES its comparison (see
 *  the transcription loop below), so an unpinned token cannot be typed into this list. */
const REV4_MAP: [keyof BlueprintTheme, string][] = [
  ["wmDark", "--wm-dark"],
  ["wmLit", "--wm-lit"],
  ["lift", "--z-lift"],
  ["assistLift", "--k-assist-lift"],
];

describe("the app's Blueprint tokens ARE the approved spec", () => {
  const spec = readSpec();

  // ── COVERAGE IS NOT ALLOWED TO BE A HAND-MAINTAINED LIST ──────────────────────────────────────
  // This file's whole claim is that it "fails if the app's transcription has drifted by a single
  // byte", and `MAP` is a list someone has to remember to extend. Three times now a token has been
  // added to `BlueprintTheme`; the next one silently escapes the fidelity guard entirely, with a
  // green suite — which is precisely the failure this file exists to end, one level up. The
  // pressure is worse since the source doubled (index.html + rev4.html), because "it must be
  // covered in the other block" is now an available excuse.
  //
  // So a new field is a RED TEST until it is pinned to a spec source, whichever source that is.
  it("pins EVERY field of BlueprintTheme to a spec file — no field may be uncovered", () => {
    const covered = new Set<string>([
      ...MAP.map(([field]) => field),
      ...REV4_MAP.map(([field]) => field),
    ]);
    expect(
      covered,
      "a BlueprintTheme field is not checked against any spec source — add it to MAP (index.html) or REV4_MAP (rev4.html), WITH the spec token it transcribes; both drive real comparisons, so neither can be padded to silence this",
    ).toEqual(new Set(Object.keys(BLUEPRINT.light)));
  });

  for (const mode of ["light", "dark"] as const) {
    it(`${mode}: every token matches PRD/sparkle/ui-directions/index.html`, () => {
      for (const [field, token, read] of MAP) {
        const raw = spec[mode][token];
        // The dark block overrides only what changes; anything absent inherits the light value.
        const expected = (read ?? ((v: string) => v))(raw ?? spec.light[token]!);
        expect(
          BLUEPRINT[mode][field],
          `${mode}.${field} disagrees with ${token} in the spec page`,
        ).toBe(expected);
      }
    });
  }

  // ── THE STRUCTURAL CLAIM, ASSERTED SO IT CANNOT BE "FIXED" BACK ──────────────────────────────
  // The direction separates registers by LINE WEIGHT, not by fill. The previous palette enforced
  // the opposite (every adjacent plane ≥ 1.2 apart) and deleted the sidebar's rule to make room for
  // it. This pins the design's actual intent: the columns are nearly the same colour, and the edge
  // between them is a real, visible line.
  const lum = (hex: string) => {
    const h = hex.replace("#", "");
    const ch = (i: number) => {
      const v = parseInt(h.slice(i, i + 2), 16) / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * ch(0) + 0.7152 * ch(2) + 0.0722 * ch(4);
  };
  const contrast = (a: string, b: string) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
    return (hi + 0.05) / (lo + 0.05);
  };

  it("the assistant column and the builder column are NOT separated by fill", () => {
    for (const mode of ["light", "dark"] as const) {
      const t = BLUEPRINT[mode];
      // Under 1.2 — i.e. under the floor the old palette enforced. This is the design, not a defect.
      expect(
        contrast(t.assist, t.bridge),
        `${mode}: the columns are too far apart in fill — this design separates them with a rule`,
      ).toBeLessThan(1.2);
    }
  });

  it("…they are separated by a SEAM, which has to be visible against both", () => {
    for (const mode of ["light", "dark"] as const) {
      const t = BLUEPRINT[mode];
      for (const plane of [t.assist, t.bridge]) {
        expect(
          contrast(t.seam, plane),
          `${mode}: the seam is invisible on ${plane} — the boundary would not exist`,
        ).toBeGreaterThan(1.2);
      }
    }
  });

  // EVEN THE TERMINAL IS EDGED, NOT STEPPED — and this corrects an assertion I wrote from
  // assumption a moment before running it. I claimed the terminal was "the one register that gets a
  // real fill step"; in dark, bridge→term measures 1.083, which is no more of a step than the
  // columns. The design gives it `--k-term-hair`, its own edge token, exactly like every other
  // boundary. The mechanism is line weight all the way down.
  it("the TERMINAL boundary is a rule too, visible on both sides", () => {
    for (const mode of ["light", "dark"] as const) {
      const t = BLUEPRINT[mode];
      for (const plane of [t.bridge, t.term]) {
        expect(
          contrast(t.termHair, plane),
          `${mode}: the terminal hairline is invisible on ${plane}`,
        ).toBeGreaterThan(1.15);
      }
    }
  });

  it("…and light gives the terminal MORE fill separation than dark does", () => {
    // Not a floor, a recorded fact: light steps 1.194 onto the terminal, dark only 1.083. Stated so
    // that "make them consistent" is a deliberate design change rather than a tidy-up.
    expect(contrast(BLUEPRINT.light.bridge, BLUEPRINT.light.term)).toBeGreaterThan(
      contrast(BLUEPRINT.dark.bridge, BLUEPRINT.dark.term),
    );
  });
});

// ── WHAT rev-4 ADDS ─────────────────────────────────────────────────────────────────────────────
// The direction page (`index.html`) is the palette; `rev4.html` is the COCKPIT layout built on top
// of it, and it introduces two tokens the palette page has no opinion about. They are read from
// rev4 rather than from index.html for exactly that reason — asking index.html for `--wm-dark`
// would return undefined and this whole block would pass by comparing nothing to nothing.

/** Pull `--<name>` declarations out of a CSS block body. Wider than `tokens()` above, which is
 *  scoped to `--k-*`; the rev-4 additions are `--wm-*` and `--z-*`. */
function anyTokens(body: string): Record<string, string> {
  return Object.fromEntries(
    [...body.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]),
  );
}

/** rev-4's theme blocks. LIGHT is the bare `:root{…}` base; DARK is defined TWICE — once under
 *  `@media (prefers-color-scheme:dark)` for a browser following the OS, and once as the explicit
 *  `:root[data-theme="dark"]{…}` the app's own attribute writer corresponds to.
 *
 *  BOTH are read, and `mediaDark` exists solely so they can be compared. A drift-detection guard
 *  that reads ONE of two duplicated sources of truth cannot detect that drift: edit the media copy
 *  and forget the explicit one and the mock renders one dark palette in a browser while this file
 *  certifies the other — with a green suite, which is the exact failure mode this file was written
 *  to end, one level up. */
function readRev4(): {
  light: Record<string, string>;
  dark: Record<string, string>;
  mediaDark: Record<string, string>;
} {
  const s = readFileSync(REV4, "utf8");
  const light = /^:root\{(.*?)\n\}/ms.exec(s);
  const dark = /^:root\[data-theme="dark"\]\{(.*?)\n\}/ms.exec(s);
  const mediaDark =
    /@media \(prefers-color-scheme:dark\)\{:root:not\(\[data-theme="light"\]\)\{(.*?)\n\}\}/s.exec(s);
  if (!light) throw new Error("rev4 light `:root{…}` block not found");
  if (!dark) throw new Error('rev4 `:root[data-theme="dark"]{…}` block not found');
  if (!mediaDark) throw new Error("rev4 `prefers-color-scheme:dark` block not found");
  return {
    light: anyTokens(light[1]!),
    dark: anyTokens(dark[1]!),
    mediaDark: anyTokens(mediaDark[1]!),
  };
}

/** A rev-4 token in a given mode, WITH the light fallback CSS custom properties actually have.
 *
 *  The dark block is an OVERRIDE: a mock that stops restating an unchanged value is correct, and
 *  inherits. `readSpec()` above models that (`raw ?? spec.light[token]`) and this reader dropped it
 *  — so the day rev4.html stops restating, say, `--z-lift` in dark, the dark row would compare a
 *  real string against `undefined` and fail on a mock that is right. Two readers of the same kind
 *  of CSS in one file will not stay straight with opposite inheritance semantics. */
const rev4Token = (
  spec: ReturnType<typeof readRev4>,
  mode: "light" | "dark",
  token: string,
): string | undefined => (mode === "dark" ? (spec.dark[token] ?? spec.light[token]) : spec.light[token]);

/** WCAG relative luminance of a #rrggbb string. Local to this block — the copy inside the describe
 *  above is scoped to it. */
function lumOf(hex: string): number {
  const h = hex.replace("#", "");
  const ch = (i: number) => {
    const v = parseInt(h.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(0) + 0.7152 * ch(2) + 0.0722 * ch(4);
}
const ratio = (a: string, b: string) => {
  const [hi, lo] = [lumOf(a), lumOf(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

/** WCAG 1.4.11 non-text floor. The wordmark is a ~25px graphical mark, not body copy, so 3:1 is
 *  the applicable bar — but BOTH ends of a gradient have to clear it, since either one can be the
 *  paint under a given letterform. */
const NON_TEXT_MIN = 3;

// ── THE TRANSCRIPTION CHECK FOR EVERY REV-4 FIELD, DRIVEN BY REV4_MAP ITSELF ────────────────────
// This is what makes naming a field in REV4_MAP cost something. The wordmark's two ends and the
// lift used to be compared by hand inside their own describes, with their token strings written out
// a second time — so the coverage list and the assertions were two independent hand-maintained
// things that could disagree. One loop, one source.
describe("every rev-4 field IS its token in PRD/sparkle/ui-directions/rev4.html", () => {
  const rev4 = readRev4();

  for (const mode of ["light", "dark"] as const) {
    for (const [field, token] of REV4_MAP) {
      it(`${mode}.${field} matches ${token}`, () => {
        // PRESENCE FIRST, and separately — because "absent" and "different" fail for opposite
        // reasons and the value compare below reports the absent case as the baffling
        // `expected '#ffffff' to be undefined`.
        //
        // Absent is not hypothetical. `anyTokens` reads a value as "everything up to the next
        // semicolon", so a COMMENT in rev4.html that writes a custom-property name immediately
        // followed by a colon captures the rest of the comment AND the declaration under it — the
        // real token then vanishes from the parse with the page looking perfectly correct. That
        // ate this exact token twice while it was being added. This assertion names the cause.
        expect(
          rev4Token(rev4, mode, token),
          `${token} is not present in rev4.html's ${mode} block. If it looks present, check the comments just above it: a custom-property name followed by a colon inside a comment swallows the declaration beneath it.`,
        ).toBeDefined();
        expect(
          BLUEPRINT[mode][field],
          `${mode}.${field} disagrees with ${token} in rev4.html`,
        ).toBe(rev4Token(rev4, mode, token));
      });
    }
  }
});

describe("the WORDMARK RAMP — rev-4's `--wm-dark` / `--wm-lit`", () => {
  for (const mode of ["light", "dark"] as const) {

    it(`${mode}: the ramp runs DARK → LIGHT, so the mark ends on the lighter blue`, () => {
      expect(
        lumOf(BLUEPRINT[mode].wmLit),
        `${mode}: the ramp is running backwards — wmLit is not lighter than wmDark`,
      ).toBeGreaterThan(lumOf(BLUEPRINT[mode].wmDark));
    });

    it(`${mode}: both ends clear the non-text floor on the concierge column`, () => {
      // Measured on `assist` — the plate the mark ACTUALLY sits on (the concierge column), not on
      // `ground` or `bar`. Light's lit end is the tight one (#4a8bf5 on white); dark has room at
      // both ends. See theme/amberInk.test.ts for why "the plate the control actually sits on" is
      // the rule rather than a convenient nearby surface.
      for (const end of [BLUEPRINT[mode].wmDark, BLUEPRINT[mode].wmLit]) {
        expect(
          ratio(end, BLUEPRINT[mode].assist),
          `${mode}: the wordmark end ${end} is invisible on the concierge column`,
        ).toBeGreaterThanOrEqual(NON_TEXT_MIN);
      }
    });
  }

  // ── THE REASON THIS IS A TOKEN PAIR AND NOT `linear-gradient(ink, primary)` ────────────────────
  // This is the assertion the whole pair exists for. Write the ramp as a fixed order of two
  // EXISTING tokens and it is correct in one theme and reversed in the other — silently, because a
  // backwards gradient throws nothing and simply looks a bit off forever. The flip is pinned here
  // so anyone tempted to "simplify" the pair away has to argue with a red test first.
  it("…because WHICH of `primary` / `ink` is the lighter one FLIPS between themes", () => {
    expect(
      lumOf(BLUEPRINT.light.primary),
      "light: primary is expected to be the LIGHTER of the pair",
    ).toBeGreaterThan(lumOf(BLUEPRINT.light.ink));
    expect(
      lumOf(BLUEPRINT.dark.ink),
      "dark: ink is expected to be the LIGHTER of the pair",
    ).toBeGreaterThan(lumOf(BLUEPRINT.dark.primary));
  });

  // And the values are not merely those two tokens reordered: light's lit end is a lighter blue
  // than `primary`, so even a theme-aware `min/max(ink, primary)` would not reproduce the ramp.
  it("light's lit end is LIGHTER than `primary` — the ramp is not a reordering of existing tokens", () => {
    expect(lumOf(BLUEPRINT.light.wmLit)).toBeGreaterThan(lumOf(BLUEPRINT.light.primary));
  });
});

// ── THE MOCK'S TWO DARK BLOCKS HAVE TO AGREE WITH EACH OTHER ────────────────────────────────────
// rev4.html states its dark palette twice — once for a browser following the OS, once for the
// explicit `data-theme` the app writes. Everything above compares the app to ONE of them, which
// cannot catch the two of them disagreeing: edit the media copy alone and the mock renders one dark
// palette in a browser while this file certifies the other, green throughout. This closes that,
// before any comparison to the app is made.
describe("rev4.html's own two dark blocks", () => {
  const rev4 = readRev4();

  it("are byte-identical, so `the mock` names ONE dark palette and not two", () => {
    expect(
      rev4.mediaDark,
      "the prefers-color-scheme copy has drifted from the explicit [data-theme] block",
    ).toEqual(rev4.dark);
  });
});

describe("the LIFT — rev-4's `--z-lift`, the unplugged concierge's elevation", () => {
  // Its transcription is checked by the REV4_MAP loop above; what is left here is the claim that
  // value cannot make on its own.

  // There is deliberately no `--z-flush` token. FLUSH is the ABSENCE of the lift, and storing
  // "none" as data invites it to drift into something that isn't nothing.
  it("stores no `flush` counterpart — flush is the absence of this value", () => {
    expect(Object.keys(BLUEPRINT.light)).not.toContain("flush");
    expect(Object.keys(BLUEPRINT.dark)).not.toContain("flush");
  });
});

// ── `--k-assist-lift` — THE UNMOUNTED CONCIERGE'S SURFACE ──────────────────────────────────────
// The REV4_MAP loop above already proves this field transcribes the spec page. What it CANNOT
// prove is the thing the founder actually asked for: that in dark the unmounted column is
// meaningfully lighter than the ground, by a stated amount, and that lightening it did not eat a
// neighbouring register. Those are claims about the RELATIONSHIP between tokens, so they are
// asserted here — and they are what makes a future edit to the hex a red test rather than a
// silent regression.
//
// THIS BLOCK FAILS AGAINST THE CODE AS IT WAS. Before this change there was no `assistLift` at
// all; the column painted `assist`, i.e. 0% lighter, which is outside the band asserted below.
describe("the UNMOUNTED CONCIERGE's surface — rev-4's `--k-assist-lift`", () => {
  /** CIE L* — PERCEIVED lightness, which is what "10–20% lighter" means to an eye. Raw relative
   *  luminance is the wrong scale here: the same step reads as +63% in Y and +16% in L*, and only
   *  the second matches what you see on a near-black navy. */
  const lStar = (hex: string) => {
    const Y = lumOf(hex);
    return Y <= 0.008856 ? 903.3 * Y : 116 * Math.cbrt(Y) - 16;
  };

  it("dark: the unmounted column is 10–20% lighter than the ground it used to match", () => {
    const t = BLUEPRINT.dark;
    const pct = (lStar(t.assistLift) / lStar(t.assist) - 1) * 100;
    expect(
      pct,
      `dark assistLift (${t.assistLift}) is ${pct.toFixed(1)}% lighter than assist (${t.assist}) in L*; the founder asked for roughly 10–20%`,
    ).toBeGreaterThanOrEqual(10);
    expect(pct).toBeLessThanOrEqual(20);
  });

  // The POINT of the step: the unmounted column must not read as one more build column. It was
  // already lighter than `bridge` before this change — this pins that the gap WIDENED rather than
  // some later edit closing it.
  it("dark: it reads as distinctly lighter than the build column", () => {
    const t = BLUEPRINT.dark;
    expect(lStar(t.assistLift)).toBeGreaterThan(lStar(t.bridge) * 1.5);
  });

  // The regression this value was chosen to avoid. `bar` is the top strip and the composer's
  // frame; if the column behind them lightens past them, those registers stop being visible as
  // separate things. Ordering, not a magic number.
  it("dark: it stays UNDER `bar`, so bars and the composer frame keep their separation", () => {
    const t = BLUEPRINT.dark;
    expect(lStar(t.assistLift)).toBeLessThan(lStar(t.bar));
  });

  // Light is deliberately a no-op: #ffffff has nowhere to go, and the `lift` shadow already does
  // the separating. Asserted so nobody "fixes the asymmetry" by inventing an off-white.
  it("light: identical to `assist` — there is nothing above white", () => {
    expect(BLUEPRINT.light.assistLift).toBe(BLUEPRINT.light.assist);
  });
});
