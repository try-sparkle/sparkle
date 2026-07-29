// ── THE TWO PLACES A TOKEN CAN HIDE FROM A SOURCE SCANNER ──────────────────────────────────────
//
// `fontTokens.test.ts` and `theme/scale.test.ts` both walk `sourceFiles(SRC)` filtered to
// `/\.tsx?$/`. That leaves exactly two escapes, and the branch that wrote those guards fell into
// both (roborev 54788):
//
//  1. `index.css` — NOT a `.tsx` file, so no scanner reads it. Its `body` rule carries
//     `font-family: system-ui, -apple-system, "Segoe UI", sans-serif`, which is `FONT_UI` retyped
//     character-for-character, sitting exempt from the guard built specifically to stop the font
//     stack being "a string every file retypes". The scrollbar thumb's radius is the same shape:
//     its provenance was a COMMENT reading "3px = RADIUS.sm", which is precisely the arrangement
//     `SparkleOverlay`'s `.14em` had already proved does not hold.
//
//  2. `packages/ui` — OUTSIDE `apps/desktop/src` entirely, and reached through an INDIRECTION that
//     evades all three of fontTokens' assertions by construction: `FONT.mono` names no banned
//     family, puts no quoted string at a `fontFamily:` property, and resolves through an import
//     rather than a same-file const. `packages/ui/tokens.ts` still holds the pre-spec webfonts
//     (`"IBM Plex Sans"`, `"Source Code Pro"`), so every remaining `FONT.mono` reference renders a
//     replaced face in production with every ratchet green.
//
// `theme/cssMirror.test.ts` is the in-directory precedent for making `index.css` duplication an
// invariant rather than a comment; this is its sibling, living here because `theme/` belongs to
// another branch.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FONT_UI, RADIUS } from "../theme/scale";

const SRC = fileURLToPath(new URL("..", import.meta.url));
const CSS = readFileSync(join(SRC, "index.css"), "utf8");

/**
 * The value of `prop` in the first rule that both names `selector` and declares it.
 *
 * "AND DECLARES IT" is load-bearing, not defensive: `body` appears twice in this stylesheet — once
 * at the head of a `body, #root` selector list that sets only layout, and once as its own rule with
 * the font. Taking the FIRST match returned the layout rule and a null font-family, so the
 * assertion failed while the value it was checking was perfectly correct.
 *
 * Comments are stripped first, because every declaration asserted here carries a block comment
 * above it that quotes the very value being asserted.
 */
function declaration(selector: string, prop: string): string | null {
  const src = CSS.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const rule of src.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!rule[1]!.includes(selector)) continue;
    const m = rule[2]!.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:([^;]+)`));
    if (m) return m[1]!.trim();
  }
  return null;
}

describe("index.css spends the same tokens the TSX does", () => {
  it("body's font-family IS FONT_UI, not a copy of it", () => {
    expect(declaration("body", "font-family")).toBe(FONT_UI);
  });

  it("the xterm scrollbar thumb uses RADIUS.sm — the direction draws no capsules", () => {
    // 5px on a 10px-wide track is a fully-round capsule, and the approved mock's only round corner
    // in the whole page is `50%` on a 7px status dot.
    expect(declaration(".xterm-viewport::-webkit-scrollbar-thumb", "border-radius")).toBe(`${RADIUS.sm}px`);
  });
});

// ── THE INDIRECTION RATCHET ────────────────────────────────────────────────────────────────────
// `packages/ui`'s `FONT` export is the pre-spec webfonts. Its two remaining consumers are owned by
// other branches, so this is a ratchet rather than a ban — but "deferred" and "invisible" are
// different things, and leaving nothing that can see a THIRD consumer being added is what turns a
// deferral into a hole. Lowering this count IS the migration record; when it reaches 0, retire
// `FONT` from `packages/ui` in the same PR.
const MAX_FONT_INDIRECTION = 2;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (/\.tsx?$/.test(name) && !name.includes(".test.")) out.push(p);
  }
  return out;
}

describe("nothing new reaches the old webfonts through @sparkle/ui's FONT", () => {
  it("the count of FONT.ui / FONT.mono references never rises", () => {
    const hits: string[] = [];
    for (const file of sourceFiles(SRC)) {
      readFileSync(file, "utf8").split("\n").forEach((line, i) => {
        if (/^\s*(\/\/|\/\*|\*)/.test(line)) return;
        if (/\bFONT\.(mono|ui)\b/.test(line)) hits.push(`${file.slice(SRC.length)}:${i + 1}`);
      });
    }
    expect(
      hits.length,
      `${hits.length} references to @sparkle/ui's FONT vs ceiling ${MAX_FONT_INDIRECTION}. That ` +
        `token still holds "IBM Plex Sans" / "Source Code Pro" — the faces the spec replaced — so a ` +
        `reference here renders a webfont no ratchet can see. Use FONT_UI / FONT_MONO from ` +
        `theme/scale. Known, and owned by other branches: Workspace.tsx, AgentSidebar.tsx.\n${hits.join("\n")}`,
    ).toBeLessThanOrEqual(MAX_FONT_INDIRECTION);
  });
});
