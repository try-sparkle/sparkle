import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BLUEPRINT } from "./blueprintSpec";
import { C, MODAL_SHADOW, SCRIM, THEME_HEX } from "./colors";

// Enforce that index.css is a faithful mirror of THEME_HEX. Static CSS is required so a
// data-theme flip re-themes with no FOUC and no JS, but that means the values are duplicated
// — this test makes the mirror an invariant instead of a comment: edit one without the other
// and CI fails. Asserts both VALUE equality and KEY-SET equality (a THEME_HEX entry with no
// matching CSS var, or a stray var, fails rather than slipping past an intersection compare).

const css = readFileSync(fileURLToPath(new URL("../index.css", import.meta.url)), "utf8");

// camelCase THEME_HEX key → the `--c-*` CSS var name (deepForest → --c-deep-forest).
const varName = (key: string) => "--c-" + key.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());

// Pull the `{ … }` body of the first rule whose selector exactly matches, then parse its
// `--c-xxx: #hex;` declarations into a { varName: hex } map.
function parseVars(selector: string): Record<string, string> {
  const re = new RegExp(`${selector.replace(/[[\]]/g, "\\$&")}\\s*\\{([^}]*)\\}`);
  const body = css.match(re)?.[1];
  if (body == null) throw new Error(`selector not found in index.css: ${selector}`);
  const vars: Record<string, string> = {};
  for (const [, name, hex] of body.matchAll(/(--c-[\w-]+)\s*:\s*(#[0-9a-fA-F]{6})/g)) {
    if (name && hex) vars[name] = hex.toLowerCase();
  }
  return vars;
}

describe("index.css ⇄ THEME_HEX mirror", () => {
  const cases = [
    { selector: ":root", hex: THEME_HEX.dark, label: "dark" },
    { selector: ':root[data-theme="light"]', hex: THEME_HEX.light, label: "light" },
  ];

  for (const { selector, hex, label } of cases) {
    it(`${selector} declares exactly the ${label} THEME_HEX key set`, () => {
      const declared = Object.keys(parseVars(selector)).sort();
      const expected = Object.keys(hex).map(varName).sort();
      expect(declared).toEqual(expected);
    });

    it(`${selector} values equal THEME_HEX.${label}`, () => {
      const vars = parseVars(selector);
      for (const [key, value] of Object.entries(hex)) {
        expect(vars[varName(key)]).toBe(value.toLowerCase());
      }
    });
  }
});

// ── THE TWO SPEC VALUES THAT ARE NOT HEX ───────────────────────────────────────────────────────
// `scrim` is an `rgba()` and `shadow` is a whole `box-shadow`, so neither can live in THEME_HEX —
// the mirror above parses `#rrggbb` and asserts key-set equality, and a non-hex entry there would
// read as a var index.css declares but the parser cannot see. They are declared under the spec's own
// `--k-*` prefix instead (see SCRIM / MODAL_SHADOW in colors.ts), which leaves them mirrored by
// nothing unless this block exists.
//
// It is worth the extra assertions because these are exactly the values eleven dialogs had been
// hand-typing: `rgba(0,0,0,0.5)` and `0 20px 60px rgba(0,0,0,0.5)`, unthemed, so light mode's
// near-white shell got dark mode's flat black scrim. Untested tokens drift back to literals.
describe("index.css ⇄ the spec's non-hex overlay tokens", () => {
  /** The `--k-*` declarations of a rule body — values run to the `;`, so an rgba() survives. */
  function parseK(selector: string): Record<string, string> {
    const re = new RegExp(`${selector.replace(/[[\]]/g, "\\$&")}\\s*\\{([^}]*)\\}`);
    const body = css.match(re)?.[1];
    if (body == null) throw new Error(`selector not found in index.css: ${selector}`);
    const vars: Record<string, string> = {};
    for (const [, name, value] of body.matchAll(/(--k-[\w-]+)\s*:\s*([^;]+);/g)) {
      if (name && value) vars[name] = value.trim();
    }
    return vars;
  }

  const cases = [
    { selector: ":root", spec: BLUEPRINT.dark, label: "dark" },
    { selector: ':root[data-theme="light"]', spec: BLUEPRINT.light, label: "light" },
  ];

  for (const { selector, spec, label } of cases) {
    it(`${selector} declares the ${label} scrim and shadow exactly as the spec states them`, () => {
      const vars = parseK(selector);
      expect(vars["--k-scrim"], `${label} scrim`).toBe(spec.scrim);
      expect(vars["--k-shadow"], `${label} shadow`).toBe(spec.shadow);
    });
  }

  // The token strings components import have to name the vars index.css actually declares — a typo
  // there is invisible at runtime (an unresolved var() just yields nothing, so the scrim vanishes and
  // the modal floats on the raw shell) and no contrast guard can see it.
  it("the exported tokens point at those vars", () => {
    expect(SCRIM).toBe("var(--k-scrim)");
    expect(MODAL_SHADOW).toBe("var(--k-shadow)");
  });
});

// ── `C` IS THE THIRD SIDE OF THE TRIANGLE, AND IT WAS UNGUARDED ────────────────────────────────
// The mirror above holds THEME_HEX ⇄ index.css. Components import neither — they import `C`, whose
// members are hand-written `var(--c-*)` strings, and nothing checked that those name a var that
// exists (roborev 54686). `svgTokens.test.ts` asserts only that they ARE var() strings.
//
// The failure it leaves open is silent at every layer: rename a THEME_HEX key and index.css MUST
// follow (key-set equality forces it), while `C` keeps pointing at the old name. An unresolved
// `var()` yields nothing, so a modal renders with a transparent body over the live shell — and the
// whole suite stays green, because every test that could have noticed is comparing the two sides
// that did move.
describe("`C`'s var() strings name vars index.css actually declares", () => {
  const declared = new Set(
    [...css.matchAll(/(--c-[\w-]+)\s*:/g)].map(([, name]) => name!),
  );

  it("every `var(--c-*)` token in `C` resolves to a declared variable", () => {
    const dangling: string[] = [];
    for (const [key, value] of Object.entries(C)) {
      if (typeof value !== "string") continue;
      const named = /^var\((--c-[\w-]+)\)$/.exec(value)?.[1];
      if (named && !declared.has(named)) dangling.push(`C.${key} → ${named}`);
    }
    expect(
      dangling,
      "these tokens point at CSS variables index.css does not declare — var() resolves to nothing, " +
        "so the surface renders transparent:\n" + dangling.join("\n"),
    ).toEqual([]);
  });
});
