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

// ── THE CHAT TRANSCRIPT KEEPS A SCROLLBAR YOU CAN SEE AND GRAB (bead sparkle-nheu8) ────────────
//
// This is a REGRESSION GUARD ON AN ABSENCE, which is why it is worth its own block. The pane was
// never broken — it scrolled, and `ConciergeThread.autofollow.test.tsx` drives real scrollTop
// values on it. What it had was NO `::-webkit-scrollbar` rule, so it inherited the macOS WKWebView
// default: an OVERLAY bar that paints during a scroll gesture and fades. Nothing in a jsdom render
// can observe that (jsdom does not lay out and never paints a scrollbar — docs/jsdom-test-caveats
// .md), and nothing in the token ratchets sees index.css. So a delete of these three rules leaves
// every other test in this repo green while the founder's pane silently goes back to having no
// visible bar. This block is the only thing that reds.
//
// It asserts the MECHANISM, not a precondition: an explicitly declared WIDTH is precisely what
// converts WebKit's overlay bar into a classic, always-present, space-occupying one. Drop the
// width and the rest of the styling still parses — and the bar disappears again.
const CHAT_SCROLLER = '[data-concierge-scroller="yes"]';

describe("the chat transcript scrollbar is classic, not the macOS overlay", () => {
  it("declares an explicit width — the one thing that opts out of the overlay bar", () => {
    expect(
      declaration(`${CHAT_SCROLLER}::-webkit-scrollbar`, "width"),
      "index.css must declare a width on the chat scroller's ::-webkit-scrollbar. Without it " +
        "macOS paints an OVERLAY scrollbar that fades the moment the gesture stops, which is the " +
        "exact defect bead sparkle-nheu8 exists for. A styled thumb alone does NOT bring it back.",
    ).toBe("10px");
  });

  it("hangs off the marker BOTH transcripts carry, not off a component-specific hook", () => {
    // ConciergeThread and MountedAgentThread swap for one another in the same column, and neither
    // has a className. `data-concierge-scroller` is the app-wide marker they share (asserted on
    // both by threadScrollerMarker.test.tsx, which also runs THIS selector against the rendered
    // markup). Keying the CSS to it is what gives a mounted session the same bar.
    // Comments stripped first, or `[^{}]+` swallows the block comment above each rule into the
    // "selector" it captures — every rule in this stylesheet carries one.
    const selectors = [...CSS.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{[^{}]*\}/g)]
      .map(([, sel]) => sel!.trim())
      .filter((sel) => sel.includes("-webkit-scrollbar") && sel.includes("concierge-scroller"));
    expect(selectors).toHaveLength(3); // scrollbar, track, thumb
    for (const sel of selectors) expect(sel.startsWith(CHAT_SCROLLER)).toBe(true);
  });

  it("paints the thumb with a themed var, so it is not a literal that light mode never sees", () => {
    // `pillFill`, not `chatBubble`: colors.ts floors hairline/pillFill/goldFill as "a chrome SHAPE
    // against the surface it is drawn on", which is what a 10px thumb is. `chatBubble` is a row
    // fill that sits deliberately near its ground and measures ~1.19 dark / ~1.15 light against
    // these planes — invisible, in both themes, which is the whole bug.
    expect(declaration(`${CHAT_SCROLLER}::-webkit-scrollbar-thumb`, "background")).toBe(
      "var(--c-pill-fill)",
    );
  });

  it("leaves the track transparent so no UA stripe paints down a repainting column", () => {
    // ConciergeColumn repaints its plane from `data-wired`, so any fixed track colour is wrong in
    // at least one state. Unstyled is NOT the same as transparent — unstyled is the UA's own track.
    expect(declaration(`${CHAT_SCROLLER}::-webkit-scrollbar-track`, "background")).toBe(
      "transparent",
    );
  });

  it("uses RADIUS.sm on the thumb — the same no-capsule rule the xterm bar is held to", () => {
    expect(declaration(`${CHAT_SCROLLER}::-webkit-scrollbar-thumb`, "border-radius")).toBe(
      `${RADIUS.sm}px`,
    );
  });
});

// ── THE INDIRECTION RATCHET ────────────────────────────────────────────────────────────────────
// `packages/ui`'s `FONT` export is the pre-spec webfonts — `FONT.mono` is literally
// `'"Source Code Pro", monospace'`. It sat at 2 because its two consumers were owned by other
// branches; that rationale expired when the font sweep landed, and those two sites were the ONLY
// places in the app still rendering a replaced webfont. Leaving them while `fontTokens`'s ceilings
// read 0 would have made "0" mean "no more retyped STRINGS" while the visible defect those ceilings
// exist to prevent was still on screen — a guard whose number reads finished and is not
// (roborev 55159). Both now use `FONT_MONO`, so this is 0 and `FONT` has no consumers left in the
// desktop app; retire it from `packages/ui` when nothing else imports it.
const MAX_FONT_INDIRECTION = 0;

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
        `theme/scale. There is no sanctioned baseline any more — the last two references ` +
        `(Workspace.tsx, AgentSidebar.tsx) were migrated when the ceiling went to 0, so anything ` +
        `listed below is new.\n${hits.join("\n")}`,
    ).toBeLessThanOrEqual(MAX_FONT_INDIRECTION);
  });
});
