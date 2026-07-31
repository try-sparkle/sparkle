// NUMERIC FLOORS FOR LINK TEXT, on every light-mode surface a link is actually read on.
//
// The founder's report was "links are way too light in light mode". Measured, four link inks were
// below AA and the failures were invisible to every existing guard, because each one is a BRAND
// FILL literal being used as INK — the exact split `colors.ts` documents four separate times and
// which nothing enforced:
//
//   • `C.accent`  #34e0f0 — StatusFilterBar's "Reset", AgentSidebar's "Show all".   1.48–1.61:1
//   • `C.violet`  #8b6df0 — OpenPrMenu's PR chip and its per-PR "View on GitHub".   3.50–3.79:1
//   • `C.teal`    #2f6bff — RefillLink's "Refill", in the composer and the sidebar. 4.30–4.50:1
//   • `C.sienna`  #e0533f — ScopeVitals' link-shaped project button.                3.66–3.83:1
//
// The `C.teal` one is the reason this file measures RATIOS rather than asserting hex values: at
// 4.50:1 on pure white it is a rounding error away from passing, and it FAILS the moment the same
// word is drawn on the composer bar (#f7fafe) instead — which is one of the two places it actually
// renders. A hex assertion cannot see that. The hex can be right against the wrong background.
//
// Two guards, and they fail on different mistakes:
//   1. the ARITHMETIC below — an ink tier that drifts light stops clearing the floor;
//   2. the SOURCE SCAN at the bottom — a NEW link written against a brand fill is caught even
//      though its token's hex never moved. Guard 1 alone would have reported green on all four
//      failures above, because none of them changed a token; they consumed the wrong one.
//
// Inequality assertions are banned here for the reason chromeContrast.test.ts and
// xtermTheme.test.ts state: an inequality is what a washed-out palette satisfies.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LINK_MIN_CONTRAST, THEME_HEX } from "./colors";

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

/**
 * The surfaces a link is READ ON. Deliberately not "every plane in THEME_HEX", and the two
 * exclusions are the point of the list existing:
 *
 *   • `forest` in light is the TERMINAL plane (#d9e3f3). Terminal links are OSC-8 sequences drawn
 *     by xterm out of the ANSI palette, not by any of these tokens — xtermTheme.test.ts owns that
 *     surface and measures all sixteen slots against it.
 *   • `pillFill` is a pill's BACKGROUND, behind chip text; no link renders on it. It is the one
 *     plane `C.muted` would fail (4.26:1), and `muted` is a BLUEPRINT token ported verbatim from
 *     the approved direction — so including a surface no link uses would have forced an edit to a
 *     spec value to fix a problem that does not exist. chromeContrast.test.ts governs that pair.
 */
const LINK_SURFACES = [
  "conciergeSurface", // the assistant column — Markdown links, AgentPill, ApprovalPrompt
  "barSurface", // the composer + top strip — "Manage", "Reset", "Refill", ApprovalNudge
  "deepForest", // the builder column / board — BoardView's "Clear"
  "dialogSurface", // Settings + SupportModal bodies
  "dialogNav", // the Settings rail — `.settings-link-btn`
  "inputSurface", // the composer field, behind the placeholder overlay's "Refill"
  "chatBubble", // the user's own bubble — Markdown links inside a sent message
  "chatBubbleActive", // a selected row / active fill
] as const;

/**
 * Every ink a link's TEXT is painted with, and where. Keyed by the token name in `THEME_HEX` so a
 * rename breaks the test rather than silently dropping a row from coverage.
 *
 * `accentInk`/`tealInk` are the same value today; both appear because they are separate tokens
 * with separate consumers, and a future retune of one must be measured, not assumed.
 */
const LINK_INKS: ReadonlyArray<readonly [keyof (typeof THEME_HEX)["light"], string]> = [
  ["accentInk", "Markdown <a>, BoardView 'Clear', Composer 'Manage', ApprovalNudge, 'Reset', 'Show all'"],
  ["tealInk", "RefillLink 'Refill'"],
  ["violetInk", "OpenPrMenu PR chip + per-PR 'View on GitHub'"],
  ["dangerInk", "ScopeVitals' link-shaped project button"],
  ["muted", "AuthGate, CloseAgentPrompt, StatusStrip, .settings-link-btn"],
  ["conciergeMuted", "ApprovalPrompt's 'why' disclosure"],
  ["cream", "AgentPill's label"],
];

describe("light-mode link contrast", () => {
  it("clears WCAG AA on every surface a link is read on", () => {
    for (const [token, where] of LINK_INKS) {
      const ink = THEME_HEX.light[token];
      for (const surface of LINK_SURFACES) {
        expect(
          contrast(ink, THEME_HEX.light[surface]),
          `light ${token} (${ink}) on ${surface} (${THEME_HEX.light[surface]}) — ${where}`,
        ).toBeGreaterThanOrEqual(LINK_MIN_CONTRAST);
      }
    }
  });

  it("holds in DARK mode too — the light fix must not cost the mode it did not touch", () => {
    // Not the subject of the report, and asserted anyway: the tokens above are themed pairs, and
    // an edit to the light half is one keystroke away from the dark half in the same object.
    for (const [token, where] of LINK_INKS) {
      const ink = THEME_HEX.dark[token];
      for (const surface of LINK_SURFACES) {
        expect(
          contrast(ink, THEME_HEX.dark[surface]),
          `dark ${token} (${ink}) on ${surface} (${THEME_HEX.dark[surface]}) — ${where}`,
        ).toBeGreaterThanOrEqual(LINK_MIN_CONTRAST);
      }
    }
  });
});

// ── THE SOURCE SCAN ────────────────────────────────────────────────────────────────────────────
//
// The arithmetic above measures the TOKENS. This measures the CALL SITES, and it is the half that
// has to catch a link consuming a correct-valued token that simply is not an ink.
//
// IT FAILS CLOSED, and the first cut did not — which made it miss the very site this change fixed.
// That version asked "does this `color:` expression contain a banned `C.<fill>`?", so it was blind
// to one level of indirection: ScopeVitals painted `color: tint` where `const tint =
// bandColor(VITAL_BAND)`, and the scan reported green on the 3.83:1 link. Asking the question the
// other way round — "does this expression resolve to a token I can VERIFY is an ink?" — flags an
// unresolvable identifier instead of waving it through. An exception then has to be written down
// in ALIASED_OK with the test that covers it, rather than being invisible.
const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

/** `C.<name>` values that are FILLS/STROKES — constant across themes by design — and therefore must
 *  never paint text — mapped to the themed tier that replaces each. The mapping is not always the
 *  name plus "Ink" (`sienna` → `dangerInk`, `gold` → `goldInk`), so it is spelled out: a wrong hint
 *  in a CI failure sends the next person looking for a token that does not exist. */
const FILL_TO_INK: Record<string, string> = {
  accent: "accentInk",
  teal: "tealInk",
  violet: "violetInk",
  sienna: "dangerInk",
  success: "successInk",
  amber: "amberInk",
  gold: "goldInk",
  goldHot: "goldHotInk",
};
const FILL_ONLY = Object.keys(FILL_TO_INK);

/** `C.<name>` values that ARE text tiers. Anything matching `…Ink` is one by construction; these
 *  are the tiers whose names predate that convention. Measured by the arithmetic above. */
const INK_OK = /^(?:.*Ink|muted|conciergeMuted|agentIdle|cream|termInk|termMuted)$/;

/** Expressions that are not tokens at all and carry no colour of their own. */
const INERT = /^(?:"inherit"|"currentColor"|"transparent"|undefined)$/;

/** Helpers whose whole job is to RETURN a themed text ink. A `color:` that goes through one is
 *  verified by that helper's own guard (`statusInk` by theme/statusInk.test.ts), so it passes —
 *  while a bare `bandColor(...)` / `AGENT_STATUS[…].color`, which returns a brand FILL, does not
 *  and fails closed. That distinction is the whole point: both are function calls, and only one
 *  of them promises an ink. */
const INK_HELPERS = /^\s*statusInk\s*\(/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(p);
    return e.isFile() && p.endsWith(".tsx") && !p.includes(".test.") ? [p] : [];
  });
}

/** Any `textDecoration` whose value can be `underline` — including `"underline dotted"` and
 *  `hover ? "underline" : "none"`, both of which the exact-literal match used to miss. */
const UNDERLINED = /textDecoration:\s*[^,\n]*["']underline/;

/** Resolve ONE level of local aliasing: `const vitalInk = C.dangerInk` → `C.dangerInk`. */
function resolveAlias(expr: string, src: string): string {
  const ident = /^[A-Za-z_$][\w$]*$/.exec(expr.trim());
  if (!ident) return expr;
  const decl = new RegExp(`\\b(?:const|let)\\s+${expr.trim()}\\s*=\\s*([^;\\n]+)`).exec(src);
  return decl ? decl[1]! : expr;
}

describe("no link paints its text with a brand FILL token", () => {
  it("every underlined control's `color:` resolves to a verifiable ink tier", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const src = readFileSync(file, "utf8");
      const lines = src.split("\n");
      const rel = relative(SRC, file);
      lines.forEach((line, i) => {
        if (!UNDERLINED.test(line)) return;
        // Walk back to the start of THIS style object, tracking brace depth, so a sibling
        // element's `color:` can never be blamed for (or excuse) this one.
        let depth = 0;
        let found: { expr: string; line: number } | null = null;
        for (let j = i; j >= 0 && i - j < 40; j--) {
          const l = lines[j]!;
          // Walking BACKWARD, a `}` means we are descending into a nested object and a `{` means we
          // are leaving ours. Depth is updated BEFORE the match is tested, so that the line
          // carrying our object's opening brace is still eligible — `style={{ color: X,` on the
          // opener is a real shape, and breaking on it first would silently skip the colour.
          if (j < i) depth += (l.match(/}/g) ?? []).length - (l.match(/{/g) ?? []).length;
          const m = /(?:^|[\s?:{])color:\s*([^,\n]+)/.exec(l);
          if (m && depth <= 0) { found = { expr: m[1]!.trim(), line: j + 1 }; break; }
          // Now that this line has been considered, a negative depth means we have walked out of
          // the enclosing object — stop rather than cross into a sibling element's style.
          if (depth < 0) break;
        }
        if (!found) return; // no colour of its own — it inherits, which the parent's site governs
        const raw = found.expr.replace(/,\s*$/, "");
        const resolved = resolveAlias(raw, src);
        const tokens = [...resolved.matchAll(/\bC\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]!);
        const bad = tokens.find((t) => FILL_ONLY.includes(t));
        if (bad) {
          offenders.push(`${rel}:${found.line} — color: ${raw} (C.${bad} is a fill; use C.${FILL_TO_INK[bad]})`);
        } else if (
          tokens.length === 0 &&
          !INERT.test(resolved.trim()) &&
          !INK_HELPERS.test(resolved)
        ) {
          // FAIL CLOSED. This is the ScopeVitals shape: `color: tint` where `const tint =
          // bandColor(...)`. An expression the scan cannot trace to an ink is not evidence of
          // safety — the previous version treated it as such and waved a 3.83:1 link through.
          offenders.push(`${rel}:${found.line} — color: ${raw} → ${resolved.trim()} (unverifiable; point it at an ink token or route it through statusInk)`);
        } else if (tokens.length > 0) {
          const unknown = tokens.find((t) => !INK_OK.test(t));
          if (unknown) {
            offenders.push(`${rel}:${found.line} — color: ${raw} (C.${unknown} is not a known text tier)`);
          }
        }
      });
    }
    expect(offenders, `underlined link text not provably on an ink tier:\n${offenders.join("\n")}`)
      .toEqual([]);
  });
});
