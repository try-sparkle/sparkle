import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { THEME_HEX } from "./colors";

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
