// ── THEMED TOKENS MAY NEVER REACH AN SVG PRESENTATION ATTRIBUTE ────────────────────────────────
// Every token in `C` is a `var(--c-*)` string, and `var()` is NOT substituted in SVG presentation
// attributes — `stroke`, `fill`, `stopColor` and friends. WebKit, which is what Tauri renders with
// on macOS, does not support it. The attribute is simply invalid, so the property falls back to its
// initial value: `stroke` becomes `none` and the shape renders INVISIBLE.
//
// This shipped. `DANGER` was a hex literal for a long time, so `<svg stroke={DANGER}>` was correct;
// the moment DANGER became themed, the sidebar's alert-circle icon silently stopped drawing, and
// nothing caught it — the whole suite was green, and a contrast guard cannot see it because the
// colour is right, it just never reaches the pixel (roborev 54231).
//
// The correct spelling is `stroke="currentColor"` with the token in a CSS property
// (`style={{ color: TOKEN }}`), because `color` is a real CSS property where var() resolves and
// `currentColor` reads it back. This sweeps the source for the broken form so the next themed token
// cannot repeat it.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("..", import.meta.url));

/** SVG presentation attributes that take a paint value and silently die on an unresolved var(). */
const PAINT_ATTRS = ["stroke", "fill", "stopColor", "floodColor", "lightingColor"];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (/\.tsx?$/.test(name) && !name.includes(".test.")) out.push(p);
  }
  return out;
}

describe("themed var() tokens never reach an SVG presentation attribute", () => {
  it("no `stroke={C.x}` / `fill={DANGER}` style attribute bindings anywhere in src", () => {
    // Matches an ATTRIBUTE binding (`stroke={...}`) — not a style-object property (`stroke: ...`),
    // which is a CSS property and resolves var() correctly.
    const pattern = new RegExp(
      `\\b(${PAINT_ATTRS.join("|")})=\\{\\s*(DANGER|ON_GOLD_FILL|ON_BRAND_FILL|C\\.\\w+)`,
      "g",
    );
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      // Line by line, skipping COMMENTS — the note explaining this bug quotes the broken form
      // verbatim, and a scanner that flags its own documentation is a scanner nobody keeps.
      readFileSync(file, "utf8").split("\n").forEach((line, i) => {
        if (/^\s*(\/\/|\/\*|\*)/.test(line)) return;
        for (const m of line.matchAll(pattern)) {
          offenders.push(`${file.slice(SRC.length)}:${i + 1}: ${m[1]}={${m[2]}}`);
        }
      });
    }
    expect(
      offenders,
      "var() does not resolve in SVG presentation attributes — the shape renders INVISIBLE. " +
        'Use `stroke="currentColor"` with `style={{ color: TOKEN }}` instead:\n' +
        offenders.join("\n"),
    ).toEqual([]);
  });

  // The companion half: the fixed spelling has to actually be the fixed spelling. A bare
  // `stroke="currentColor"` with no `color` set inherits from whatever is above it, which is a
  // different silent failure — the icon draws, in the wrong colour.
  it("the sidebar's alert icon carries currentColor AND a color to resolve it", () => {
    // The icon moved out of AgentSidebar.tsx with SupportTicketRow, its only caller. Path only —
    // the two assertions below are untouched, and they still fail loudly (not vacuously) if it
    // moves again: a missing marker collapses `body` to "" and both `toContain`s go red.
    const src = readFileSync(join(SRC, "components/SupportTicketRow.tsx"), "utf8");
    const icon = src.slice(src.indexOf("function AlertCircleIcon"));
    const body = icon.slice(0, icon.indexOf("</svg>"));
    expect(body, "alert icon lost its currentColor stroke").toContain('stroke="currentColor"');
    expect(body, "alert icon has no color for currentColor to read").toContain("color: DANGER");
  });
});
