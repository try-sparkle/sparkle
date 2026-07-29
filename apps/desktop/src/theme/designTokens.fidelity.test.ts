// FIDELITY, NOT INTERNAL CONSISTENCY. The other theme tests (scale.test, chromeContrast, xtermTheme,
// cssMirror) all measure whether the app is consistent WITH ITSELF — the ratchet, the contrast
// floors, the CSS mirror. NONE of them measures whether the app matches the DESIGN. That gap is how
// two releases shipped a type scale and palette `PRD/sparkle/ui-directions/index.html` never
// specified: "does the app match the signed-off spec" was a judgement a human re-made by eye each
// time, and eyes drift. This test makes it a DIFF.
//
// It reads the spec HTML directly and independently — its own parser, not the JSON, not the
// extraction script — so THREE things are cross-checked against the one source of truth:
//   1. `design-tokens.json` is a faithful extraction of the spec's `[data-dir="blueprint"]` block.
//   2. Every scale in `scale.ts` (TYPE/RADIUS/SPACE/WEIGHT/fonts/…) equals the spec value.
//   3. The colour ramp in `colors.ts` is measured against the spec, token by token, and its
//      divergence is a RECORDED, change-controlled ledger rather than an invisible drift.
//
// Because the parser here is a second, independent derivation of the spec, it also guards the
// extraction script: a bug there, or a hand-edit to the JSON, disagrees with this parse and fails.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import tokens from "./design-tokens.json";
import {
  FONT_MONO,
  FONT_UI,
  LABEL,
  LINE_READ,
  RADIUS,
  SPACE,
  TERM_MEASURE,
  TERM_TYPE,
  TYPE,
  WEIGHT,
} from "./scale";
import { THEME_HEX } from "./colors";

// fileURLToPath, NOT `.pathname` — this repo's worktrees live under "Application Support", so the
// URL form is percent-encoded and `.pathname` hands back a directory that does not exist (the same
// note scale.test.ts carries). From src/theme/ up four levels reaches the repo root.
const SPEC_PATH = fileURLToPath(new URL("../../../../PRD/sparkle/ui-directions/index.html", import.meta.url));
const html = readFileSync(SPEC_PATH, "utf8");

/**
 * Independent copy of the extraction parser. Deliberately NOT imported from the script: two
 * derivations of the spec that must agree is the guard — a single shared parser could be wrong in
 * both places and still look consistent.
 */
function parseBlueprint(src: string): { base: Record<string, string>; dark: Record<string, string> } {
  const bodyOf = (selectorPrefix: string): string => {
    const start = src.indexOf(selectorPrefix);
    if (start < 0) throw new Error(`selector not found in spec: ${selectorPrefix}`);
    const open = src.indexOf("{", start);
    const close = src.indexOf("}", open);
    return src.slice(open + 1, close);
  };
  const parse = (body: string): Record<string, string> => {
    const clean = body.replace(/\/\*[\s\S]*?\*\//g, "");
    const out: Record<string, string> = {};
    for (const [, name, value] of clean.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[name!] = value!.trim();
    return out;
  };
  return {
    base: parse(bodyOf('[data-dir="blueprint"] .shell,')),
    dark: parse(bodyOf(':root[data-eff="dark"] [data-dir="blueprint"] .shell,')),
  };
}

const spec = parseBlueprint(html);
/** Numbers in a spec value, in order: "6px 9px" → [6, 9]; "13px" → [13]; "500" → [500]. */
const nums = (v: string): number[] => v.trim().split(/\s+/).map((t) => Number(t.replace(/px$/, "")));
const px = (v: string): number => nums(v)[0]!;
const part = (v: string, i: number): number => nums(v)[i]!;

describe("design-tokens.json is a faithful extraction of the spec", () => {
  it("the committed BASE block equals a fresh parse of the spec (verbatim)", () => {
    expect(tokens.base).toEqual(spec.base);
  });
  it("the committed DARK block equals a fresh parse of the spec (verbatim)", () => {
    expect(tokens.dark).toEqual(spec.dark);
  });
  it("records where it came from, so the provenance is not just a commit message", () => {
    expect(tokens.$source).toBe('PRD/sparkle/ui-directions/index.html [data-dir="blueprint"]');
  });
});

describe("the type / radius / spacing scales are GENERATED from the spec, not re-typed", () => {
  const B = spec.base;
  it("TYPE matches --t-* exactly", () => {
    expect(TYPE.micro).toBe(px(B["--t-micro"]!));
    expect(TYPE.small).toBe(px(B["--t-small"]!));
    expect(TYPE.body).toBe(px(B["--t-body"]!));
    expect(TYPE.title).toBe(px(B["--t-title"]!));
    expect(TERM_TYPE).toBe(px(B["--t-term"]!));
  });
  it("RADIUS matches --r-* exactly", () => {
    expect(RADIUS.sm).toBe(px(B["--r-sm"]!));
    expect(RADIUS.input).toBe(px(B["--r-input"]!));
    expect(RADIUS.bubble).toBe(px(B["--r-bubble"]!));
    expect(RADIUS.modal).toBe(px(B["--r-modal"]!));
  });
  it("WEIGHT and LINE_READ match --w-* / --lh-read", () => {
    expect(WEIGHT.med).toBe(px(B["--w-med"]!));
    expect(WEIGHT.bold).toBe(px(B["--w-bold"]!));
    expect(LINE_READ).toBe(px(B["--lh-read"]!));
  });
  it("SPACE maps each step to the spec padding it is lifted from", () => {
    expect(SPACE.xs).toBe(px(B["--sp-row"]!)); // 6 — row padding, vertical
    expect(SPACE.sm).toBe(px(B["--sp-bubble"]!)); // 8 — bubble padding, vertical
    expect(SPACE.row).toBe(part(B["--sp-row"]!, 1)); // 9 — row padding, horizontal
    expect(SPACE.input).toBe(part(B["--sp-bubble"]!, 1)); // 11 — bubble padding, horizontal
    expect(SPACE.md).toBe(px(B["--sp-comp"]!)); // 12 — compose box
    expect(SPACE.lg).toBe(px(B["--sp-hd"]!)); // 14 — header sides
    expect(SPACE.xl).toBe(px(B["--sp-thread"]!)); // 16 — thread padding
  });
  it("the fonts, the label treatment and the terminal measure match verbatim", () => {
    expect(FONT_UI).toBe(B["--k-ui"]);
    expect(FONT_MONO).toBe(B["--k-mono"]);
    expect(LABEL.fontFamily).toBe(B["--k-label"]); // spec's --k-label == --k-mono
    expect(LABEL.letterSpacing).toBe(B["--ls-label"]);
    expect(LABEL.textTransform).toBe(B["--tt-label"]);
    expect(TERM_MEASURE).toBe(B["--term-measure"]);
  });
  // The one spec padding component the SPACE scale does not expose, pinned so its absence stays a
  // conscious decision (see the note in scale.ts) rather than a value someone forgets exists.
  it("documents the one spec padding with no named step: --sp-navitem's 10px", () => {
    expect(part(B["--sp-navitem"]!, 1)).toBe(10);
    expect(Object.values(SPACE)).not.toContain(10);
  });
});

// ── THE COLOUR RAMP: A DIFF AGAINST THE SPEC, INCLUDING WHERE IT DIVERGES ────────────────────────
// This is the honest part. The scale layer above matches the spec exactly. The colour ramp does
// NOT: `colors.ts`'s THEME_HEX was re-derived — through the black-and-gold repaint and then the
// Blueprint contrast pass — to clear the WCAG floors that `chromeContrast.test.ts` enforces
// (PLANE_MIN_SPLIT between adjacent light planes, CHROME/INK/CONTROL floors for every chrome slot
// and ink). Every one of those re-derivations moved the value AWAY from the spec: the spec's light
// ramp is near-white (planes < 1.2 apart), which is exactly what those floors forbid.
//
// So spec-fidelity and the merged contrast guards are, for the colour ramp, in direct conflict:
// porting the spec `--k-*` values verbatim reddens chromeContrast, and satisfying chromeContrast is
// how the ramp left the spec. Reconciling them (restore the near-white ramp, then re-derive the
// whole chrome/ink ladder against it, or loosen PLANE_MIN_SPLIT) is a visual decision that needs
// eyes on the running app and a founder call on the guard — tracked in bead sparkle-jvsi's
// follow-up. It is NOT something to fake green here.
//
// What this test does instead is make the gap a LEDGER: a canonical mapping from spec token to
// shipped token, the exact spec-vs-shipped value for each, and a status. A token that matches today
// cannot silently drift; a token that diverges cannot silently converge (which would mean someone
// changed the ramp without re-deriving the guards); a new plane can't be added unmapped. "Does the
// app match the design" is now a table CI reads, not a judgement.
describe("the colour ramp is measured against the spec, token by token", () => {
  // spec token → shipped THEME_HEX key. Only the correspondences that are UNCONTESTED are mapped;
  // tokens the code models differently or not at all (--k-sel, --k-input, --k-dialog*, --k-faint,
  // --k-term-ink/muted, the edge/scrim/shadow tokens) are intentionally left out rather than forced
  // into a fuzzy match — a mapping that has to be argued would guard nothing.
  const MAP: Record<string, keyof (typeof THEME_HEX)["dark"]> = {
    "--k-term": "forest", // the terminal content plane
    "--k-bridge": "deepForest", // the builder / left column
    "--k-bar": "barSurface", // the top bar + composer
    "--k-assist": "conciergeSurface", // the concierge / assistant column
    "--k-primary": "goldFill", // the opaque accent fill
    "--k-on-primary": "onGoldFill", // ink on the accent
    "--k-ink": "cream", // primary text ink
    "--k-muted": "muted", // secondary text ink
    "--k-bubble": "chatBubble", // the user's chat bubble
  };

  // The RECORDED state of each mapping, per theme: "match" means shipped == spec (locked), "diverge"
  // means the ramp was re-derived away from the spec for the reason above. Any change to the actual
  // relationship — a match that drifts, a divergence that closes — must update this table, which is
  // the whole point: the drift becomes a reviewed line, not a silent release.
  // THE LEDGER IS NOW EMPTY OF DIVERGENCES, AND THAT IS THE POINT OF THE PORT.
  //
  // Every one of these read "diverge" until the Blueprint spec was transcribed as data
  // (theme/blueprintSpec.ts) and THEME_HEX re-pointed at it — 15 of the 18 rows. They diverged
  // because the shipped palette had been DERIVED by a contrast solver rather than ported, which is
  // why six releases could each be a faithful implementation of the guards and still not look like
  // the design. All 18 are locked to the spec now.
  //
  // The type is unchanged and "diverge" is deliberately still expressible: this table is a ledger,
  // not an assertion that divergence is forbidden. A future token may need to leave the spec for a
  // measured reason — `agentIdle` and the dialogs' label ink both did, and both are recorded as
  // failing measurements in their own files. When that happens the row moves back to "diverge" and
  // becomes a reviewed line, which is what this file exists to force.
  const STATUS: Record<"light" | "dark", Record<string, "match" | "diverge">> = {
    light: {
      "--k-term": "match",
      "--k-bridge": "match",
      "--k-bar": "match",
      "--k-assist": "match",
      "--k-primary": "match",
      "--k-on-primary": "match",
      "--k-ink": "match",
      "--k-muted": "match",
      "--k-bubble": "match",
    },
    dark: {
      "--k-term": "match",
      "--k-bridge": "match",
      "--k-bar": "match",
      "--k-assist": "match",
      "--k-primary": "match",
      "--k-on-primary": "match",
      "--k-ink": "match",
      "--k-muted": "match",
      "--k-bubble": "match",
    },
  };

  const specValue = (mode: "light" | "dark", prop: string): string =>
    ((mode === "dark" ? { ...spec.base, ...spec.dark } : spec.base)[prop] ?? "").toLowerCase();

  it("the recorded match/diverge status is still the actual status — no silent drift, no silent convergence", () => {
    for (const mode of ["light", "dark"] as const) {
      for (const [prop, token] of Object.entries(MAP)) {
        const s = specValue(mode, prop);
        const shipped = THEME_HEX[mode][token].toLowerCase();
        const actual = s === shipped ? "match" : "diverge";
        expect(
          actual,
          `${mode} ${prop} → ${token}: spec ${s} vs shipped ${shipped} is now "${actual}" but the ledger records "${STATUS[mode][prop]}". ` +
            `A match that drifted is a regression; a divergence that closed means the ramp was changed without re-deriving the contrast guards — update this ledger and chromeContrast together (bead sparkle-jvsi).`,
        ).toBe(STATUS[mode][prop]);
      }
    }
  });

  it("the tokens recorded as matching the spec are GENERATED-equal to it, and locked there", () => {
    // The four that already honour the spec — dark's accent pair, and light's two white surfaces —
    // are pinned to the spec value itself, so a future palette edit cannot quietly walk them off it.
    for (const mode of ["light", "dark"] as const) {
      for (const [prop, token] of Object.entries(MAP)) {
        if (STATUS[mode][prop] !== "match") continue;
        expect(
          THEME_HEX[mode][token].toLowerCase(),
          `${mode} ${token} is recorded as matching spec ${prop} — it must equal the spec value`,
        ).toBe(specValue(mode, prop));
      }
    }
  });

  it("every mapped spec token exists in the spec and every shipped token exists in THEME_HEX", () => {
    // Guards the mapping itself: a spec rename or a THEME_HEX key removal fails here rather than
    // making a downstream assertion quietly measure `undefined`.
    for (const [prop, token] of Object.entries(MAP)) {
      expect(spec.base[prop], `spec is missing ${prop}`).toBeDefined();
      expect(THEME_HEX.dark[token], `THEME_HEX is missing ${token}`).toBeDefined();
      expect(THEME_HEX.light[token], `THEME_HEX is missing ${token}`).toBeDefined();
    }
  });
});
