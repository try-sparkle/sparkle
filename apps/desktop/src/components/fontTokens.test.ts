// ── THE FONT STACK IS A TOKEN, NOT A STRING YOU RETYPE ─────────────────────────────────────────
//
// `theme/scale.ts` explains at length WHY the faces matter: the app shipped IBM Plex Sans for the
// UI and Verdana for the concierge against a spec that uses the system face for both, and that one
// substitution is most of why the running app read as a different product from the approved design.
// The fix was a sweep, and a sweep only holds if the next person cannot quietly re-type the string.
//
// A RATCHET, not a ban — the same shape and for the same reason as `theme/scale.test.ts`. The sweep
// that landed this covered every surface one agent owned; the concierge, the workspace shell and the
// modals are being migrated on their own branches, so a hard `=== 0` here would red the fleet for
// work that is in flight rather than missing. The gate is `<=`: it fails only when the count RISES
// (someone retyped a stack) and tolerates it falling (someone migrated one). Lower the constants in
// the same PR that lowers reality, so the ceiling stays tight.
//
// It reads the SOURCE, for the same reason scale.test.ts does: these are inline style objects with
// no shared render path, so there is no runtime seam to inspect, and the thing being guarded is what
// the next person TYPES.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FONT_MONO, FONT_UI } from "../theme/scale";

// fileURLToPath, NOT `.pathname` — this repo's worktrees live under "Application Support", so the
// URL form is percent-encoded and `.pathname` hands back a directory that does not exist.
const SRC = fileURLToPath(new URL("..", import.meta.url));

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (/\.tsx?$/.test(name) && !name.includes(".test.")) out.push(p);
  }
  return out;
}

/** The webfont families the app used to render in, and which the spec replaced with the system face. */
const BANNED = ["IBM Plex Sans", "IBM Plex Mono", "Source Code Pro", "Verdana"];

/**
 * `Terminal.tsx` is the one PERMANENT holdout, exempt by path rather than counted: xterm needs a
 * real monospace carrying the U+2500 box-drawing block, and the Google-Fonts subset of Source Code
 * Pro is named there deliberately for exactly that reason (see the comment at its call site). An
 * exemption you can see in a list is one the next person can argue with; a number they cannot.
 */
const FONT_EXEMPT = new Set(["components/Terminal.tsx"]);

/**
 * `theme/scale.ts` DEFINES `FONT_UI` and `FONT_MONO`, so its two `export const … = 'system-ui, …'`
 * lines are the canonical source of truth — not drift (roborev 54781).
 *
 * This is worth spelling out because the first version of the hoisted-stack rule counted them, and
 * the commit that introduced it read the resulting 55 → 57 as "two hoists the old scan could not
 * see, in files other branches own". That was WRONG, and checkably so: those were the only
 * const-hoisted stacks left in `src/` at all, because the migration had already removed
 * `Markdown.tsx`'s `const MONO` and `AccountsScreen.tsx`'s `const fontStack` by hand. The ceiling
 * had recorded the definition as the offence — which would have told whoever hit the gate to go
 * migrate `theme/scale.ts` away from itself, and made 0 unreachable for a ratchet whose whole
 * premise is that 0 is the destination.
 */
const QUOTED_EXEMPT = new Set(["theme/scale.ts"]);

/** Lines naming a replaced webfont, outside the exempt path. Lower as branches land. */
const MAX_BANNED_FAMILY = 3;
/** `fontFamily:` properties still holding a quoted stack instead of FONT_UI / FONT_MONO. */
const MAX_QUOTED_STACK = 55;

/** Keywords, not stacks. `fontFamily: "inherit"` is a legitimate thing to write. */
const NOT_A_STACK = new Set(["inherit", "monospace", "initial", "unset", "revert"]);

/**
 * Does this string look like a font STACK? Used to catch one hoisted into a named binding, which the
 * property-site scan below cannot see by construction.
 *
 * Two tiers, because keyword-presence alone is far too broad against a zero-slack ceiling (roborev
 * 54781). `const HINT = "monospace font recommended"` is a tooltip, not a stack, and flagging it
 * would red the fleet with a message telling its author to import `FONT_UI`.
 *
 *   • STRONG signals name a specific system family and are conclusive on their own.
 *   • WEAK signals are the generic CSS families — they are ordinary English words too, so they only
 *     count alongside a comma, which is what makes a list of fallbacks a stack.
 */
function looksLikeStack(v: string): boolean {
  const strong = /system-ui|-apple-system|ui-monospace|SFMono|Segoe UI|SF Mono/.test(v);
  const weak = /sans-serif|\bmonospace\b|\bserif\b/.test(v);
  return strong || (weak && v.includes(","));
}

/**
 * A RATCHET YOU CAN SATISFY BY MOVING CODE IS NOT A RATCHET (roborev 54688).
 *
 * The first cut of this scan matched `fontFamily:` followed immediately by a quoted string, on one
 * line. Three ways past it, and the first is not hypothetical — it is the exact hole the migrating
 * commit had to close BY HAND:
 *
 *  1. HOISTING. `const F = 'system-ui, …'; … fontFamily: F` has no quotes at the property and names
 *     no banned family, so neither ratchet saw it. `Markdown.tsx`'s `const MONO` and
 *     `AccountsScreen.tsx`'s `const fontStack` were both this. `theme/scale.test.ts` learned the
 *     same lesson twice — once for `.ts` helper files, once for named numeric constants — and the
 *     answer here is the same: resolve single-file bindings, and additionally flag any hoisted
 *     string that LOOKS like a stack, since that is drift whether or not it is ever assigned.
 *  2. WRAPPING. A value expression split across lines (`fontFamily: cond\n  ? A\n  : "…"`) never
 *     matched, because the regex could not cross a newline. So the value is now read to its real
 *     terminator — a depth-0 `,` `;` or closing bracket — exactly as scale.test.ts reads its own.
 *  3. TWO ON ONE LINE. `line.match` is non-global and stopped at the first hit.
 */
export function scanSource(rel: string, src: string): { banned: string[]; quoted: string[] } {
  const banned: string[] = [];
  const quoted: string[] = [];
  {
    const lineAt = (idx: number) => src.slice(0, idx).split("\n").length;
    // Comments quote the banned names to explain them, and a scanner that flags its own
    // documentation is a scanner nobody keeps.
    const isComment = (idx: number) => /^\s*(\/\/|\/\*|\*)/.test(src.split("\n")[lineAt(idx) - 1] ?? "");

    src.split("\n").forEach((line, i) => {
      if (/^\s*(\/\/|\/\*|\*)/.test(line)) return;
      for (const fam of BANNED) if (line.includes(fam)) banned.push(`${rel}:${i + 1}: ${fam}`);
    });

    // A hoisted stack is counted AT ITS DECLARATION. No identifier resolution is needed at the
    // property site, and there is none: one hoist referenced from ten call sites is one piece of
    // drift, not ten, and if the binding lives in another module then that module's own declaration
    // is counted when the walk reaches it. (An earlier version kept a `consts` map here that was
    // populated and never read, while the comment and the commit message both described resolving
    // through it — the exact "a claim asserted in a comment rather than in code" this file's header
    // warns about, reported as roborev 54781.)
    if (!QUOTED_EXEMPT.has(rel)) {
      for (const c of src.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*(?::\s*string\s*)?=\s*(['"])(.*?)\2\s*[;\n]/g)) {
        if (isComment(c.index!)) continue;
        if (looksLikeStack(c[3]!) && !NOT_A_STACK.has(c[3]!)) {
          quoted.push(`${rel}:${lineAt(c.index!)}: const ${c[1]} = ${c[3]}`);
        }
      }
    }

    for (const m of src.matchAll(/\bfontFamily:/g)) {
      const start = m.index! + m[0].length;
      if (isComment(m.index!)) continue;
      // Read to the value expression's REAL terminator, so a wrapped ternary is not exempt.
      //
      // THE WALK MUST SKIP STRING LITERALS, and this is not a nicety — a font stack is *made of
      // commas*. `fontFamily: 'system-ui, -apple-system, …'` terminates at the comma after
      // `system-ui` unless the walker knows it is inside quotes, which cuts the value before its
      // closing quote and makes the very literal being hunted unmatchable. scale.test.ts's walk has
      // no such clause because it reads NUMBERS, where a truncated expression still yields the
      // leading digits; copying its shape verbatim silently dropped this count from 55 to 7.
      let depth = 0;
      let end = start;
      let quote = "";
      for (; end < src.length; end++) {
        const c = src[end]!;
        if (quote) {
          if (c === "\\") end++;
          else if (c === quote) quote = "";
          continue;
        }
        if (c === "'" || c === '"' || c === "`") quote = c;
        else if ("([{".includes(c)) depth++;
        else if (")]}".includes(c)) {
          if (depth === 0) break;
          depth--;
        } else if ((c === "," || c === ";") && depth === 0) break;
      }
      const expr = src.slice(start, end);
      for (const q of expr.matchAll(/(['"])(.*?)\1/g)) {
        if (NOT_A_STACK.has(q[2]!)) continue;
        quoted.push(`${rel}:${lineAt(m.index!)}: ${q[2]}`);
      }
      // A bare identifier as the value needs no separate handling: if it names a stack hoisted in
      // this file, the `consts` sweep above already counted the DECLARATION — which is the honest
      // place to count it, since one hoist referenced from ten call sites is one piece of drift,
      // not ten. If it names an import, it is `FONT_UI` / `FONT_MONO` and there is nothing to flag.
    }
  }
  return { banned, quoted };
}

function scan(): { banned: string[]; quoted: string[] } {
  const banned: string[] = [];
  const quoted: string[] = [];
  for (const file of sourceFiles(SRC)) {
    const rel = file.slice(SRC.length);
    const r = scanSource(rel, readFileSync(file, "utf8"));
    if (!FONT_EXEMPT.has(rel)) banned.push(...r.banned);
    quoted.push(...r.quoted);
  }
  return { banned, quoted };
}

describe("font families come from the scale, never from a retyped literal", () => {
  it("the count of replaced-webfont references never rises", () => {
    const { banned } = scan();
    expect(
      banned.length,
      `${banned.length} references to a webfont the spec replaced vs ceiling ${MAX_BANNED_FAMILY}. ` +
        `Use FONT_UI / FONT_MONO from theme/scale:\n${banned.join("\n")}`,
    ).toBeLessThanOrEqual(MAX_BANNED_FAMILY);
  });

  it("the count of retyped `fontFamily:` stacks never rises", () => {
    const { quoted } = scan();
    expect(
      quoted.length,
      `${quoted.length} quoted fontFamily stacks vs ceiling ${MAX_QUOTED_STACK}. ` +
        `Use FONT_UI (${FONT_UI}) or FONT_MONO (${FONT_MONO}) from theme/scale:\n${quoted.join("\n")}`,
    ).toBeLessThanOrEqual(MAX_QUOTED_STACK);
  });

  // The half that is a HARD assertion rather than a ratchet: whatever else drifts, the surfaces this
  // sweep migrated must keep reading from the token. A ceiling alone cannot say that — a branch
  // could re-type a stack in `BoardView` and pay for it by removing one from a modal.
  it("the migrated surfaces read the token, not a string", () => {
    for (const rel of [
      "components/BoardView.tsx",
      "components/StatusFilterBar.tsx",
      "components/Composer.tsx",
      "components/ToolsPane.tsx",
      "components/CreditsPanel.tsx",
      "components/OpenPrMenu.tsx",
      "helper/HelperApp.tsx",
    ]) {
      // THE FIXED SCANNER, not a second naive regex (roborev 54781). This assertion is the half the
      // header calls stronger than the ceiling — it blocks the trade of adding drift to a swept
      // surface and paying for it elsewhere — so leaving it on the old one-line pattern meant a
      // hoist or a wrapped value could un-migrate a swept file with BOTH assertions still green.
      expect(
        scanSource(rel, readFileSync(join(SRC, rel), "utf8")).quoted,
        `${rel} re-typed a font stack — import FONT_UI / FONT_MONO from theme/scale instead`,
      ).toEqual([]);
    }
  });
});

// ── THE SCANNER'S OWN TESTS ────────────────────────────────────────────────────────────────────
// A ratchet is only worth its constant if it can actually fail, and this one shipped unable to see
// three routine spellings (roborev 54688). Asserting "the fix works" in a comment is what let the
// first version look finished; these run it against each hole instead.
describe("the scan cannot be evaded by moving code", () => {
  const q = (src: string) => scanSource("x.tsx", src).quoted;

  it("HOISTING: a stack behind a named binding still counts", () => {
    // The exact shape of Markdown.tsx's `const MONO` and AccountsScreen.tsx's `const fontStack`,
    // both of which the migrating commit had to find by hand because the scan could not.
    const hits = q(`const F = 'system-ui, -apple-system, "Segoe UI", sans-serif';\nconst a = { fontFamily: F };\n`);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain("const F =");
  });

  it("WRAPPING: a value expression split across lines still counts", () => {
    expect(q(`const a = {\n  fontFamily: cond\n    ? FONT_UI\n    : "Comic Sans, sans-serif",\n};\n`)).toHaveLength(1);
  });

  it("TWO ON ONE LINE: both count, not just the first", () => {
    expect(q(`const a = { fontFamily: "A, serif" }, b = { fontFamily: "B, serif" };`)).toHaveLength(2);
  });

  it("a stack made of COMMAS is read to its closing quote, not cut at the first one", () => {
    // The regression that turned this fix into a 55 -> 7 undercount: the expression walk treated the
    // comma inside `'system-ui, -apple-system, …'` as the value's terminator.
    const hits = q(`const a = { fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif' };`);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain("sans-serif");
  });

  it("the legal spellings stay legal", () => {
    expect(q(`const a = { fontFamily: FONT_UI };`)).toEqual([]);
    expect(q(`const a = { fontFamily: "inherit" };`)).toEqual([]);
    expect(q(`// fontFamily: "IBM Plex Mono, monospace" in a comment is documentation\n`)).toEqual([]);
  });
});
