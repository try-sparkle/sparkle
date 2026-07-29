// Extract the signed-off design's custom properties into a machine-readable JSON, so the app's
// theme is GENERATED from the spec rather than re-derived by hand. Two releases shipped a palette
// and type scale the design never specified because "does the app match the design" was a judgement
// a human re-made each time; this makes it a diff (see theme/designTokens.fidelity.test.ts).
//
// SOURCE: PRD/sparkle/ui-directions/index.html, the `[data-dir="blueprint"]` block — the direction
// the founder signed off, authored as real CSS custom properties (not a picture). It has two rules:
//   • BASE  — `[data-dir="blueprint"] .shell, … .modalstage { … }` — every scale token plus the
//             LIGHT-mode `--k-*` colour ramp.
//   • DARK  — `:root[data-eff="dark"] [data-dir="blueprint"] .shell, … { … }` — only the `--k-*`
//             colour overrides for dark mode.
//
// Run: `node apps/desktop/scripts/extract-design-tokens.mjs` (writes src/theme/design-tokens.json).
// The fidelity test re-parses the spec INDEPENDENTLY and asserts the committed JSON still matches,
// so a hand-edit that drifts the JSON from the spec — or a bug in this script — fails CI.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url)); // apps/desktop/scripts/
const SPEC = fileURLToPath(new URL("../../../PRD/sparkle/ui-directions/index.html", import.meta.url));
const OUT = fileURLToPath(new URL("../src/theme/design-tokens.json", import.meta.url));

/**
 * Parse the two `[data-dir="blueprint"]` CSS rule bodies into `{ base, dark }` maps of
 * `--custom-prop` → value. Kept small and dependency-free on purpose: the fidelity test carries its
 * own copy of this logic so the two derive the spec independently.
 */
export function parseBlueprintTokens(html) {
  // The `.shell, … { … }` body for a given selector prefix. Anchored on the OPENING selector so the
  // dark rule (which shares the `[data-dir="blueprint"] .shell` fragment) is matched by its
  // `:root[data-eff="dark"]` prefix and never by the base pattern.
  const bodyOf = (selectorPrefix) => {
    const start = html.indexOf(selectorPrefix);
    if (start < 0) throw new Error(`selector not found in spec: ${selectorPrefix}`);
    const open = html.indexOf("{", start);
    const close = html.indexOf("}", open);
    if (open < 0 || close < 0) throw new Error(`unterminated rule for: ${selectorPrefix}`);
    return html.slice(open + 1, close);
  };
  // Strip `/* … */` comments (the base block carries the RAMP comment), then pull every
  // `--name: value;` pair. Values may contain commas (font stacks) and spaces (multi-value
  // paddings) but never a `;`, so `;` is the only terminator.
  const parse = (body) => {
    const clean = body.replace(/\/\*[\s\S]*?\*\//g, "");
    const out = {};
    for (const [, name, value] of clean.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      out[name] = value.trim();
    }
    return out;
  };
  return {
    base: parse(bodyOf('[data-dir="blueprint"] .shell,')),
    dark: parse(bodyOf(':root[data-eff="dark"] [data-dir="blueprint"] .shell,')),
  };
}

const html = readFileSync(SPEC, "utf8");
const { base, dark } = parseBlueprintTokens(html);

const json = {
  $comment:
    "GENERATED from PRD/sparkle/ui-directions/index.html [data-dir=\"blueprint\"] by " +
    "apps/desktop/scripts/extract-design-tokens.mjs. Do not hand-edit — regenerate. This is the " +
    "source of truth for theme/scale.ts and the colors.ts ramp; theme/designTokens.fidelity.test.ts " +
    "asserts the app's generated values match it.",
  $source: 'PRD/sparkle/ui-directions/index.html [data-dir="blueprint"]',
  // BASE rule: scale tokens + the LIGHT colour ramp. Property names are verbatim from the spec.
  base,
  // DARK rule: the `--k-*` colour overrides only.
  dark,
};

writeFileSync(OUT, JSON.stringify(json, null, 2) + "\n");
console.log(`wrote ${OUT}`);
console.log(`  base: ${Object.keys(base).length} props, dark: ${Object.keys(dark).length} props`);
