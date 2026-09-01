// ── THE FONT STACK IS A TOKEN, NOT A STRING YOU RETYPE ─────────────────────────────────────────
//
// `theme/scale.ts` explains at length WHY the faces matter: the app shipped IBM Plex Sans for the
// UI and Verdana for the concierge against a spec that uses the system face for both, and that one
// substitution is most of why the running app read as a different product from the approved design.
// The fix was a sweep, and a sweep only holds if the next person cannot quietly re-type the string.
//
// A RATCHET, not a ban — the same shape and for the same reason as `theme/scale.test.ts`. The gate
// is `<=`: it fails only when the count RISES (someone retyped a stack) and tolerates it falling
// (someone migrated one). Lower the constants in the same PR that lowers reality, so the ceiling
// stays tight.
//
// BOTH CEILINGS ARE NOW 0. The sweep that created this file covered one agent's surfaces and left
// the ceiling at 52 for the concierge, the workspace shell and the modals, which were in flight on
// other branches. Those have landed, so the remaining 42 sites were migrated to `FONT_UI` /
// `FONT_MONO`, `terminalChrome`'s `TERM_UI`/`TERM_MONO` now RE-EXPORT the tokens rather than
// re-typing them, and the two surfaces with a genuine typographic reason to name a face are exempt
// BY PATH below. Reaching 0 is what makes the guard mean "nobody retypes the stack" instead of
// "nobody retypes more of it than we already had".
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

// A scan that silently matched NOTHING would make every ceiling in this file vacuous. The ratchets
// below all gate on `hits.length <= CEILING`, and zero satisfies that — forever, silently, over a
// tree nobody opened. That is not hypothetical here: every agent worktree on this machine lives
// under a path containing a space ("Application Support"), so a walk rooted on a
// `new URL(..).pathname` reads a percent-encoded directory that does not exist. The
// `fileURLToPath` above is what keeps SRC honest; this floor is what notices if anything ever
// stops being honest.
//
// It THROWS rather than returning an empty list, so the vacuity is impossible rather than merely
// detectable: one broken walk reds every ratchet that depends on it, not just whichever single
// test happens to carry the assertion. Compare `modalChrome.test.ts`, which anchors its own
// narrower scope the same way.
const MIN_SCANNED_FILES = 200;

function scannedSourceFiles(): string[] {
  const files = sourceFiles(SRC);
  if (files.length < MIN_SCANNED_FILES) {
    throw new Error(
      `the source scan under ${SRC} found ${files.length} file(s), below the floor of ` +
        `${MIN_SCANNED_FILES}. The ratchets in this file gate on a COUNT, so a truncated or empty ` +
        `scan reports GREEN while guarding nothing. Fix the walk — do not lower this floor.`,
    );
  }
  return files;
}

/** The webfont families the app used to render in, and which the spec replaced with the system face. */
const BANNED = ["IBM Plex Sans", "IBM Plex Mono", "Source Code Pro", "Verdana"];

/**
 * `Terminal.tsx` is the one PERMANENT holdout, exempt by path rather than counted: xterm needs a
 * real monospace carrying the U+2500 box-drawing block, and the Google-Fonts subset of Source Code
 * Pro is named there deliberately for exactly that reason (see the comment at its call site). An
 * exemption you can see in a list is one the next person can argue with; a number they cannot.
 */
// MOVED, NOT ADDED (the mounted-composer font branch). The terminal body's stack used to be typed
// inline in Terminal's XTerm options, and this exemption followed it there. It now lives in
// `terminalChrome.TERM_BODY_FONT`, because the mounted concierge composer is set in the SAME face
// while what you type is bound for that agent's terminal — and a second copy of the stack in the
// composer is precisely the silent substitution this ratchet exists to prevent (it would not be
// WRONG, only different, so nothing else would ever go red).
//
// Terminal.tsx dropped OUT of both sets in the same move: it now imports the constant and names the
// faces only in a comment. That is the shape an exemption should have — it follows the one line that
// earns it rather than accumulating on files that used to.
//
// The blanket-immunity worry that `QUOTED_PATH_EXEMPT`'s note raises is answered by a HARD assertion
// below ("terminalChrome names exactly one face, and it is the terminal body's"), so this path
// cannot quietly grow an `IBM Plex Sans` behind the exemption.
const FONT_EXEMPT = new Set(["components/terminalChrome.ts"]);

/**
 * Paths allowed to name a font stack literally — exempt from the QUOTED count ONLY.
 *
 * SEPARATE FROM `FONT_EXEMPT` ON PURPOSE (roborev 55159). Collapsing the two into one
 * skip-the-whole-file gate was wider than its own justification: Terminal needs a real
 * box-drawing mono and SparkleOverlay's reply is a deliberate serif, and NEITHER of those
 * requires immunity from `BANNED`. Blanket immunity would have let someone type `IBM Plex Sans`
 * or `Verdana` into the overlay with both ratchets still green — precisely the substitution this
 * guard exists to prevent. It also reopened the hoisting hole the scanner's header claims closed:
 * a stack `const`-exported from a fully-skipped file is invisible to every importer, because the
 * per-file const sweep is the only thing that would have counted it.
 */
const QUOTED_PATH_EXEMPT = new Set([
  // xterm needs a real monospace carrying the U+2500 box-drawing block, and reads its `fontFamily`
  // option as a real stack rather than through the cascade — so this one cannot be a var. It lives
  // in terminalChrome now because the mounted composer borrows it; see FONT_EXEMPT above.
  "components/terminalChrome.ts",
  // The Sparkle voice overlay's reply is set in a SERIF on purpose — the one surface deliberately
  // not in the instrument's own face. Listed rather than counted: an exemption you can see is one
  // the next person can argue with; a number they cannot.
  "components/SparkleOverlay/SparkleOverlay.tsx",
]);

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
const MAX_BANNED_FAMILY = 0;
/**
 * `fontFamily:` properties still holding a quoted stack instead of FONT_UI / FONT_MONO.
 *
 * ZERO — the destination this ratchet was written to reach, arrived at rather than declared. It sat
 * at 52 while the sweep that created it covered only one agent's surfaces; the rest are migrated
 * now, `terminalChrome`'s TERM_UI/TERM_MONO re-export the tokens instead of re-typing them, and the
 * two genuine holdouts are exempt BY PATH above rather than hidden inside a number.
 *
 * It stays a `<=` ratchet, not a `=== 0`: the gate should fail when someone re-types a stack, and a
 * future surface with a real typographic reason to name a face belongs in FONT_EXEMPT with its
 * reason written down — not smuggled in by nudging a constant.
 */
const MAX_QUOTED_STACK = 0;

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
/**
 * Does this `${…}` span have a font stack hiding inside it?
 *
 * Asked of interpolations, whose contents the fragment scan cannot see on their own: the outer
 * backtick span is consumed whole, so a literal nested inside is invisible unless it is pulled out
 * here. A span hides a stack when one of ITS literals looks like one, or carries the comma that
 * makes a list of fallbacks a stack.
 *
 * KNOWN GAP, stated rather than papered over: a nested TEMPLATE literal — `` `${`Menlo, Consolas`}` ``
 * — is not caught, because the value walk above closes its quote on the inner backtick and cuts the
 * expression short before this is ever reached. Closing it needs a template-aware walk with
 * interpolation-depth tracking, which is a parser this guard does not otherwise need, for a spelling
 * that appears nowhere in the repo and that nobody writes by accident. Declined deliberately
 * (roborev 55235); if that spelling ever shows up, the walk is the thing to fix.
 */
function hidesAStack(span: string): boolean {
  for (const m of span.matchAll(/(['"`])([\s\S]*?)\1/g)) {
    const lit = m[2]!;
    if (looksLikeStack(lit) || lit.includes(",")) return true;
  }
  return false;
}

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

    // BOTH the longhand AND the `font:` SHORTHAND, which carries a family too and is already
    // idiomatic here (15 call sites, two of them setting a face). Reading only `fontFamily:` left
    // `font: '700 13px/1 system-ui, …'` retyping the stack character-for-character with both
    // ceilings still at 0 — a fourth evasion of exactly the shape the header enumerates as closed,
    // and one that costs more at 0 than it did at 52 (roborev 55159). The depth/quote-aware value
    // walk below needs no change: it already reads to the real terminator.
    for (const m of src.matchAll(/\bfont(?:Family)?:/g)) {
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
      // JUDGE THE VALUE BY `looksLikeStack`, NOT BY "it contains a quote" (roborev 55194).
      //
      // The quote-based rule was wrong in BOTH directions once `font:` was in scope:
      //
      //  • It missed backticks entirely. Every real shorthand that sets a face is a TEMPLATE
      //    LITERAL, because the shorthand needs size interpolation — so
      //    `font: \`700 13px/1 ui-monospace, Menlo, monospace\`` retyped a stack, named no BANNED
      //    family, and left both ceilings at 0. The widened regex matched the property and then
      //    found nothing to report.
      //  • It over-fired on the prefix. A shorthand's value legitimately carries size/weight text,
      //    so `font: '700 13px/1 ' + FONT_UI` — a correct use of the token — was reported as a
      //    retyped stack, as were the CSS system-font keywords (`caption`, `menu`, `status-bar`);
      //    only `inherit` was excused.
      //
      // Both go away by asking the same question the hoist sweep asks: does this text look like a
      // font stack? Backticks are included in the fragment scan, and a fragment that does not look
      // like a stack is not one.
      // WHICH RULE APPLIES DEPENDS ON WHICH PROPERTY MATCHED (roborev 55199).
      //
      // For `fontFamily:` a quoted value IS a family by definition, so ANY quoted fragment counts —
      // the original rule. Applying the shape heuristic here too punched a new hole in the very
      // ratchet the previous commit closed: `fontFamily: "Georgia"`,
      // `'"Helvetica Neue", Helvetica, Arial'` and `"Menlo, Consolas"` are all fully retyped stacks
      // that name no BANNED family and carry no `system-ui`-class token, so they went from one hit
      // to none with both ceilings still reading 0.
      //
      // The shorthand is the case that needs the heuristic, and only it: its value legitimately
      // carries size/weight text, and the CSS system-font keywords (`caption`, `menu`,
      // `status-bar`) are legal there and nowhere else.
      const shorthand = !m[0].includes("Family");
      for (const q of expr.matchAll(/(['"`])([\s\S]*?)\1/g)) {
        const v = q[2]!;
        if (NOT_A_STACK.has(v.trim())) continue;
        // PURE INTERPOLATION IS A TOKEN USE, NOT A STACK. Backticks only entered this scan when the
        // shorthand did, and `looksLikeStack` was masking them; with the longhand back on its
        // any-quoted-fragment rule, `` fontFamily: `${FONT_UI}` `` would be reported as drift —
        // telling its author to migrate code that is already migrated, which is precisely the
        // false-positive the shorthand has its own regression test for. (roborev 55203)
        //
        // A QUOTE INSIDE THE BRACES IS THE SIGNAL — not the expression's shape.
        //
        // `[^}]*` accepted anything, and because the fragment regex consumes the whole backtick
        // span, literals nested inside are never scanned on their own: wrapping a stack in `${…}`
        // was a fourth evasion of a scanner whose header enumerates three as closed (roborev 55209).
        // But narrowing to a BARE BINDING over-corrected — `` `${mono ? FONT_MONO : FONT_UI}` `` is
        // a fully migrated spelling that names no family, and it was reported as drift, the same
        // "go migrate code that is already migrated" false positive this file keeps two regression
        // tests for (roborev 55223).
        //
        // A literal-free interpolation cannot hide a stack, whatever its shape. But "contains a
        // QUOTE" was too coarse a proxy for the reverse (roborev 55235): a quote inside `${…}` is
        // just as often a map key or a unit argument, so `` `${FONTS["mono"]}` `` — a fully migrated
        // spelling naming no family — was reported as drift. The question is whether a nested
        // literal LOOKS LIKE A STACK, which is what `hidesAStack` asks.
        // TWO NARROWINGS THE PREVIOUS CUT INTRODUCED, both closed here (roborev 55235):
        //
        //  1. A BARE WRAPPED LITERAL IS ALWAYS A STACK. `${"Georgia"}` names a family and satisfies
        //     neither `looksLikeStack` nor the comma test, so judging the literal's SHAPE let it
        //     through — where the unwrapped `fontFamily: "Georgia"` is caught, because the longhand's
        //     rule is "any quoted fragment IS a family". Wrapping is not a migration, so an
        //     interpolation that IS a single literal is treated as hiding a stack unconditionally.
        //  2. THE SKIP MUST MATCH ONE INTERPOLATION, not a greedy span. `.*` let a value that merely
        //     STARTS with `${` and ENDS with `}` count as one — so a stack split across two spans,
        //     `${"italic 12px Menlo"}, ${"Consolas"}`, was skipped before the depth-0 comma test that
        //     used to catch it, because neither literal holds the comma itself.
        const isBareWrappedLiteral = /^\s*\$\{\s*(['"])[\s\S]*?\1\s*\}\s*$/.test(v);
        const isSingleInterpolation = /^\s*\$\{[^{}]*\}\s*$/.test(v);
        if (
          q[1] === "`" &&
          !isBareWrappedLiteral &&
          isSingleInterpolation &&
          !hidesAStack(v)
        )
          continue;
        // A DEPTH-0 COMMA IS THE OTHER THING THAT MAKES A FALLBACK LIST A STACK.
        //
        // `looksLikeStack` alone needs a strong token, or a generic keyword AND a comma — so under
        // the shorthand it waved through exactly what the longhand fix had just caught:
        // `font: '700 13px/1 "Helvetica Neue", Helvetica, Arial'`, `font: "italic 12px Menlo,
        // Consolas"`. And the shorthand is where the real retypes live here — every site that sets a
        // face is a shorthand template literal. None of the legitimate shorthand values carry a
        // comma (`'700 13px/1 ' + FONT_UI`, `caption`, `` `700 ${SIZE}px/1 ${FONT_MONO}` ``), so the
        // comma is a safe second signal.
        // DEPTH-0 means what it says now: interpolations are stripped before the comma test. A
        // comma inside `${…}` is an argument separator, not a font fallback — so
        // `` font: `700 ${Math.max(11, size)}px/1 ${FONT_UI}` `` was being reported as a retyped
        // stack, the same false positive the prefix case has a regression test for, arriving
        // through the interpolation instead. (roborev 55209)
        // Strip interpolations that hide NOTHING. Removing their contents wholesale erased the
        // evidence along with the separator (`` font: `${"italic 12px Menlo, Consolas"}` `` scored
        // zero, roborev 55223); keeping any span with a quote in it let an ARGUMENT comma read as a
        // fallback separator, so `` font: `700 ${fmt(size, "px")}px/1 ${FONT_UI}` `` was reported as
        // a retype — the same `Math.max(11, size)` false positive arriving through a quoted
        // argument (roborev 55235). Keep only what actually hides a stack.
        const literal = v.replace(/\$\{.*?\}/gs, (span) => (hidesAStack(span) ? span : ""));
        if (shorthand && !looksLikeStack(v) && !literal.includes(",")) continue;
        quoted.push(`${rel}:${lineAt(m.index!)}: ${v}`);
      }
      // A bare identifier as the value needs no separate handling: if it names a stack hoisted in
      // this file, the `consts` sweep above already counted the DECLARATION — which is the honest
      // place to count it, since one hoist referenced from ten call sites is one piece of drift,
      // not ten. If it names an import, it is `FONT_UI` / `FONT_MONO` and there is nothing to flag.
    }
  }
  return { banned, quoted };
}

/**
 * Apply the two exemption gates across a set of already-scanned files.
 *
 * EXPORTED, and parameterised on the (rel, source) pairs, because the gates were previously
 * unreachable from any test: the scanner describe exercises `scanSource` directly and never got
 * here, so "the overlay is no longer immune to BANNED" — the entire point of splitting the two
 * sets — was asserted nowhere (roborev 55194).
 */
export function applyExemptions(
  files: ReadonlyArray<readonly [string, string]>,
): { banned: string[]; quoted: string[] } {
  const banned: string[] = [];
  const quoted: string[] = [];
  for (const [rel, src] of files) {
    const r = scanSource(rel, src);
    // TWO SEPARATE GATES. The quoted exemption is what made 0 reachable (roborev 54852) — it used
    // to gate `banned` only, so the holdouts' deliberate stacks still counted toward the quoted
    // ceiling, an exemption that did not exempt. But it must NOT also grant immunity from BANNED:
    // see QUOTED_PATH_EXEMPT.
    if (!FONT_EXEMPT.has(rel)) banned.push(...r.banned);
    if (!QUOTED_PATH_EXEMPT.has(rel)) quoted.push(...r.quoted);
  }
  return { banned, quoted };
}

function scan(): { banned: string[]; quoted: string[] } {
  return applyExemptions(
    scannedSourceFiles().map((f) => [f.slice(SRC.length), readFileSync(f, "utf8")] as const),
  );
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
      // Migrated by the concierge-guidelines branch (FONT_UI once, FONT_MONO twice). Pinned by NAME
      // as well as counted, because the ceiling is tradeable in exactly the way this test's header
      // describes: another file dropping a stack would pay for these three coming back.
      "components/ConciergeGuidelinesPane.tsx",
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

  // ══ THE EXEMPT PATH IS NOT A BLANK CHEQUE ═══════════════════════════════════════════════════════
  // `terminalChrome.ts` is exempt from BOTH ratchets, which is wider than the one line that earns it:
  // the file also re-exports TERM_UI / TERM_MONO, and blanket immunity is exactly what
  // QUOTED_PATH_EXEMPT's own note warns about — someone could type `IBM Plex Sans` in there and both
  // ceilings would stay green, which is the substitution this whole guard exists to prevent.
  //
  // So the exemption is bounded HERE instead of by a number: exactly one face may be named in that
  // file, and it must be the terminal body's. A second stack — for any surface, however good the
  // reason — fails this and has to be argued for rather than slipped in behind the path.
  it("terminalChrome names exactly one face, and it is the terminal body's", () => {
    const rel = "components/terminalChrome.ts";
    const r = scanSource(rel, readFileSync(join(SRC, rel), "utf8"));
    expect(
      r.quoted,
      `terminalChrome may name ONE font stack (TERM_BODY_FONT, which xterm needs as a literal). ` +
        `Everything else on that plane re-exports FONT_UI / FONT_MONO:\n${r.quoted.join("\n")}`,
    ).toHaveLength(1);
    expect(r.quoted[0]).toContain("TERM_BODY_FONT");
    // ══ THE BANNED HALF, WHICH THE FIRST CUT OF THIS TEST LEFT OPEN (roborev 57361) ═══════════════
    // `FONT_EXEMPT` suppresses BANNED for this whole file, and bounding only `quoted` did not close
    // that: the const sweep records a literal only when it `looksLikeStack` (a strong token, or a
    // generic keyword AND a comma). `export const TERM_HEADING_FONT = "IBM Plex Sans";` matches
    // none of those — so it would be invisible to `quoted`, suppressed in `banned`, and all three
    // assertions would stay green while the file grew exactly the webfont substitution this whole
    // guard exists to prevent. That shape — an exported face const with no fallback list — is the
    // LIKELY one here, not a corner case.
    //
    // So every banned-family mention in this file must be on the TERM_BODY_FONT line (its own
    // declaration, plus the doc comment that explains why the order matters).
    for (const hit of r.banned) {
      expect(
        hit,
        `terminalChrome may name a replaced webfont ONLY in TERM_BODY_FONT, which xterm needs as a ` +
          `literal. Everything else must come from FONT_UI / FONT_MONO:\n${hit}`,
      ).toMatch(/Source Code Pro/);
    }
  });

  // …and the file it moved OUT of must stay clean, or the exemption has simply been duplicated.
  // Terminal.tsx now imports the constant; the faces appear there only in a comment.
  it("Terminal.tsx reads the constant rather than re-typing the stack", () => {
    const rel = "components/Terminal.tsx";
    expect(scanSource(rel, readFileSync(join(SRC, rel), "utf8")).quoted).toEqual([]);
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

  // THE `font:` SHORTHAND — the fourth evasion. It carries a family too, and every real site that
  // sets a face is a TEMPLATE LITERAL because the shorthand needs size interpolation.
  it("SHORTHAND: `font:` with a stack counts, in quotes or backticks", () => {
    expect(
      q(`const a = { font: '700 13px/1 system-ui, -apple-system, "Segoe UI", sans-serif' };\n`),
    ).toHaveLength(1);
    // The backtick form is the one that actually appears in this codebase.
    expect(q("const a = { font: `700 13px/1 ui-monospace, Menlo, monospace` };\n")).toHaveLength(1);
  });

  // THE LONGHAND KEEPS THE STRICT RULE. These three are fully retyped stacks that name no BANNED
  // family and carry no `system-ui`-class token, so a shape heuristic would wave them through — and
  // did, for one commit. The pre-existing longhand cases all happen to carry a generic keyword AND a
  // comma, so they clear that bar by accident and cannot detect the narrowing. (roborev 55199)
  it("LONGHAND: any quoted family counts, with or without a generic or a comma", () => {
    expect(q('const a = { fontFamily: "Georgia" };\n')).toHaveLength(1);
    expect(q(`const a = { fontFamily: '"Helvetica Neue", Helvetica, Arial' };\n`)).toHaveLength(1);
    expect(q('const a = { fontFamily: "Menlo, Consolas" };\n')).toHaveLength(1);
    // …but the keywords are still not stacks.
    expect(q('const a = { fontFamily: "inherit" };\n')).toEqual([]);
  });

  it("SHORTHAND: a comma-bearing family list counts even with no system-ui-class token", () => {
    // The same wave-through the longhand case above pins, one property over — and this is the
    // property the real retypes actually use. (roborev 55203)
    expect(q(`const a = { font: '700 13px/1 "Helvetica Neue", Helvetica, Arial' };\n`)).toHaveLength(1);
    expect(q('const a = { font: "italic 12px Menlo, Consolas" };\n')).toHaveLength(1);
    expect(q("const a = { font: `600 13px/1 Georgia, Palatino` };\n")).toHaveLength(1);
  });

  it("LONGHAND: a pure-interpolation template is a token use, not drift", () => {
    expect(q("const a = { fontFamily: `${FONT_UI}` };\n")).toEqual([]);
    // …but only a BARE BINDING. Arbitrary code inside the braces hides a literal from the scan,
    // because the fragment regex swallows the whole backtick span.
    expect(q(`const a = { fontFamily: \`\${cond ? "Menlo, Consolas" : FONT_UI}\` };\n`)).toHaveLength(1);
  });

  it("SHORTHAND: a comma INSIDE an interpolation is an argument, not a fallback list", () => {
    expect(q("const a = { font: `700 ${Math.max(11, size)}px/1 ${FONT_UI}` };\n")).toEqual([]);
    // …but a QUOTED literal inside one is a stack in hiding, not an argument. Stripping the whole
    // interpolation erased the evidence with the separator and let this score zero, while the
    // unwrapped spelling is pinned at one hit above.
    expect(q(`const a = { font: \`\${"italic 12px Menlo, Consolas"}\` };\n`)).toHaveLength(1);
  });

  it("a quote inside an interpolation is not proof of a stack", () => {
    // A map key and a unit argument both carry quotes and neither names a family. Treating the
    // quote as conclusive red-flagged fully migrated code at a ceiling of 0. (roborev 55235)
    expect(q('const a = { fontFamily: `${FONTS["mono"]}` };\n')).toEqual([]);
    // …and the ARGUMENT comma in a quoted call must not read as a fallback separator.
    expect(q('const a = { font: `700 ${fmt(size, "px")}px/1 ${FONT_UI}` };\n')).toEqual([]);
  });

  it("a literal-free interpolation is a token use, whatever its shape", () => {
    // Requiring a BARE BINDING rejected this — a fully migrated spelling that names no family.
    expect(q("const a = { fontFamily: `${mono ? FONT_MONO : FONT_UI}` };\n")).toEqual([]);
    expect(q("const a = { fontFamily: `${props.mono ? FONT_MONO : FONT_UI}` };\n")).toEqual([]);
  });

  it("SHORTHAND: the size/weight prefix does not make a token use look like a retype", () => {
    // `font: '700 13px/1 ' + FONT_UI` is a CORRECT use of the token. A quote-based rule reported it
    // as drift, which would have told its author to go migrate code that was already migrated.
    expect(q("const a = { font: '700 13px/1 ' + FONT_UI };\n")).toEqual([]);
    expect(q("const a = { font: `700 ${SIZE}px/1 ${FONT_MONO}` };\n")).toEqual([]);
    // CSS system-font keywords are not stacks either.
    expect(q('const a = { font: "caption" };\n')).toEqual([]);
    expect(q('const a = { font: "inherit" };\n')).toEqual([]);
  });
  // THE TWO NARROWINGS, AS CASES. Neither was covered: the previous cut's regression test pinned
  // only the two FALSE POSITIVES it fixed, so both holes it opened were invisible (roborev 55235).
  it("still catches a family that has merely been WRAPPED in an interpolation", () => {
    // Wrapping is not migrating. `fontFamily: "Georgia"` is caught; this is the same thing.
    expect(q('const a = { fontFamily: `${"Georgia"}` };')).toHaveLength(1);
    expect(q('const a = { fontFamily: `${"Helvetica Neue"}` };')).toHaveLength(1);
  });

  it("still catches a stack SPLIT across two interpolations", () => {
    // Neither literal holds the comma, so only reaching the depth-0 comma test catches it — which a
    // greedy single-span skip prevented.
    expect(q('const a = { font: `${"italic 12px Menlo"}, ${"Consolas"}` };')).toHaveLength(1);
  });

  it("still waves through the migrated spellings the narrowing was FOR", () => {
    // The regressions that motivated widening the skip in the first place must stay fixed — this is
    // the direction that produces "go migrate code that is already migrated".
    expect(q('const a = { fontFamily: `${FONTS["mono"]}` };')).toEqual([]);
    expect(q('const a = { font: `700 ${fmt(size, "px")}px/1 ${FONT_UI}` };')).toEqual([]);
  });
});

// ── THE TWO EXEMPTION GATES ───────────────────────────────────────────────────────────────────
//
// `FONT_EXEMPT` (banned) and `QUOTED_PATH_EXEMPT` (quoted) are deliberately SEPARATE. Collapsing
// them into one skip-the-file gate was wider than its justification and handed the exempt paths
// blanket immunity from BANNED — someone could type `Verdana` into the overlay with both ceilings
// still green. These are the cases that were asserted nowhere before (roborev 55194).
describe("the exemption gates", () => {
  const OVERLAY = "components/SparkleOverlay/SparkleOverlay.tsx";

  it("suppresses a quoted stack on a quoted-exempt path", () => {
    const r = applyExemptions([[OVERLAY, `const a = { fontFamily: '"Iowan Old Style", "Palatino", serif' };\n`]]);
    expect(r.quoted).toEqual([]);
  });

  it("STILL reports a banned family on that same path", () => {
    // The whole point of the split. A serif reply is a typographic decision; shipping Verdana is the
    // regression this guard exists to prevent, and the exemption must not cover it.
    const r = applyExemptions([[OVERLAY, `const a = { fontFamily: '"Verdana", serif' };\n`]]);
    expect(r.banned.length).toBe(1);
    expect(r.banned[0]).toContain("Verdana");
  });

  it("reports both on a path that is not exempt at all", () => {
    const r = applyExemptions([["components/Whatever.tsx", `const a = { fontFamily: '"IBM Plex Sans", sans-serif' };\n`]]);
    expect(r.banned.length).toBe(1);
    expect(r.quoted.length).toBe(1);
  });

});

