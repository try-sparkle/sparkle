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
//   • `C.sienna`  #e0533f — the concierge header's needs-you label (band red as TEXT). 3.66–3.83:1
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
import ts from "typescript";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LINK_MIN_CONTRAST, THEME_HEX } from "./colors";
import {
  attributedGuardReport,
  blameInvocationCount,
  resetBlameInvocationCount,
  type GuardSite,
} from "./scaleGuardTestUtils";

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
  ["dangerInk", "the concierge header's needs-you filter pill label"],
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
// The arithmetic above measures the TOKENS. This measures the CALL SITES — the half that has to
// catch a link consuming a correct-valued token that simply is not an ink. It is not decoration:
// it found `AgentSidebar`'s worker-row name painting the raw brand green at 2.22:1.
//
// ── WHY THIS PARSES INSTEAD OF PATTERN-MATCHING ────────────────────────────────────────────────
// Four consecutive review rounds found this scan wrong, each time in a NEW way, and every one was
// a consequence of reading TSX as lines of text:
//
//   1. it only looked at the `color:` written beside the decoration, so a locally-aliased ink
//      (`color: tint`) was waved through — the 3.83:1 link this branch fixed;
//   2. it never looked at CHILD elements, which is where React usually puts the ink (underline on
//      the interactive wrapper, colour on the text node) — reverting that fix stayed green;
//   3. it short-circuited the routes, so a wrapper that had ANY colour of its own stopped its
//      children from being examined at all;
//   4. and the line-window walks then wandered out of the element entirely — a module-scope style
//      object has no opening tag to end, so the forward walk ran on into an unrelated component
//      and would have blamed IT (`AuthGate`'s `linkBtn` reaches `LaunchFallback`'s spans), while
//      comment-stripping by `//` truncated any line containing a `https://` literal.
//
// Every one of those is free under a real parser: a JSX element has children, an object literal has
// spreads, a declaration has a scope, and a string literal is not a comment. So this walks the
// TypeScript AST. The rule it enforces is unchanged and the failure direction is unchanged (fail
// CLOSED — an expression that cannot be resolved to an ink is an offender, because "I could not
// tell" is not evidence of safety). What changed is that the analysis is now sound rather than
// approximately right for the shapes I happened to think of.
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

/** Expressions that carry no colour of their own. */
const INERT = /^(?:"inherit"|'inherit'|"currentColor"|"transparent"|undefined)$/;

/** Helpers whose whole job is to RETURN a themed text ink. A `color:` that goes through one is
 *  verified by that helper's own guard (`statusInk` by theme/statusInk.test.ts), so it passes —
 *  while a bare `bandColor(...)` / `AGENT_STATUS[…].color`, which returns a brand FILL, does not
 *  and fails closed. That distinction is the whole point: both are function calls, and only one
 *  of them promises an ink. */
const INK_HELPERS = /^statusInk\s*\(/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(p);
    return e.isFile() && p.endsWith(".tsx") && !p.includes(".test.") ? [p] : [];
  });
}

/** The nearest `const`/`let` initializer for `name` that is actually IN SCOPE at `use`.
 *
 *  Scope, not proximity — this is what the line-based version could not do. Picking the textually
 *  first match laundered one component's ink onto another's fill; picking the last one ABOVE the
 *  use site then broke the codebase's common trailing-consts layout, where a component at line 80
 *  spreads a style object declared at line 650. An ancestor check gets both right. */
function encloses(a: ts.Node, b: ts.Node): boolean {
  for (let p: ts.Node | undefined = b; p; p = p.parent) if (p === a) return true;
  return false;
}

/** The scope a declaration actually belongs to: the nearest enclosing block, function or file.
 *  NOT "the nearest function" — collapsing block scope into the function is what let a `const`
 *  inside an unrelated `if` branch count as in-scope for the whole function body. */
function scopeOf(n: ts.Node, sf: ts.SourceFile): ts.Node {
  for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
    if (ts.isBlock(p) || ts.isSourceFile(p) || ts.isFunctionLike(p) ||
        ts.isForStatement(p) || ts.isForOfStatement(p) || ts.isForInStatement(p) ||
        ts.isCaseClause(p) || ts.isModuleBlock(p)) {
      return p;
    }
  }
  return sf;
}

/** Shared lookup: the in-scope declaration of `name`, as (declaration node, value node). */
function lookup(
  name: string,
  use: ts.Node,
  sf: ts.SourceFile,
  wantFunction: boolean,
): { value: ts.Node; scope: ts.Node } | undefined {
  let best: { value: ts.Node; scope: ts.Node } | undefined;
  const visit = (n: ts.Node): void => {
    let value: ts.Node | undefined;
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name && n.initializer) {
      value = n.initializer;
    } else if (wantFunction && ts.isFunctionDeclaration(n) && n.name?.text === name) {
      value = n;
    }
    if (value) {
      const scope = scopeOf(n, sf);
      // IN SCOPE means the declaration's own scope contains the use site. A sibling branch's
      // `const color = …` does not, however textually close or deeply nested it is.
      if (encloses(scope, use)) {
        // Innermost wins: prefer a candidate whose scope is nested inside the incumbent's. Strict
        // containment, so an equal-depth candidate in a different branch cannot displace it.
        if (!best || (best.scope !== scope && encloses(best.scope, scope))) best = { value, scope };
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return best;
}

/**
 * A VALUE identifier — resolves only to a variable initializer.
 *
 * Deliberately blind to function declarations. It was briefly widened to return them (so the callee
 * path could find a style helper) and that leaked into `check`'s alias resolution: `color: someName`
 * naming a function then resolved to the WHOLE FUNCTION NODE, whose source text mentions ink tokens,
 * so `tokens.length > 0` reported it verified without establishing anything about the element's
 * colour — a fail-open on a path that had been fail-closed. The callee lookup lives in
 * `resolveCallee` instead, and this one stays narrow.
 */
function resolveIdent(name: string, use: ts.Node, sf: ts.SourceFile): ts.Expression | undefined {
  const hit = lookup(name, use, sf, false);
  return hit ? (hit.value as ts.Expression) : undefined;
}

/** A CALLEE identifier — a style helper, which may be a `function` declaration or an arrow const. */
function resolveCallee(name: string, use: ts.Node, sf: ts.SourceFile): ts.Node | undefined {
  return lookup(name, use, sf, true)?.value;
}

/** The object literal a `style={…}` expression can produce, for the shapes this codebase uses:
 *  a literal, an identifier, a CALL to a local style helper, or a CONDITIONAL between two of them.
 *  Returns every reachable candidate — both branches of a ternary are rendered by some state. */
function styleCandidates(
  expr: ts.Expression | undefined,
  sf: ts.SourceFile,
  use: ts.Node,
  seen = new Set<ts.Node>(),
): ts.ObjectLiteralExpression[] {
  if (!expr || seen.has(expr)) return [];
  seen.add(expr);
  if (ts.isObjectLiteralExpression(expr)) return [expr];
  if (ts.isParenthesizedExpression(expr)) return styleCandidates(expr.expression, sf, use, seen);
  if (ts.isIdentifier(expr)) {
    // RE-ANCHOR the scope to the declaration. Keeping the consumer's node as `use` while descending
    // resolved identifiers written inside a module-scope object in the CONSUMER's scope — so a
    // component with its own local `palette` would shadow the module `palette` that the object
    // actually closes over, and the scan would report a colour the element does not paint.
    const init = resolveIdent(expr.text, use, sf);
    return init ? styleCandidates(init, sf, init, seen) : [];
  }
  if (ts.isConditionalExpression(expr)) {
    return [
      ...styleCandidates(expr.whenTrue, sf, use, seen),
      ...styleCandidates(expr.whenFalse, sf, use, seen),
    ];
  }
  if (ts.isAsExpression(expr) || ts.isSatisfiesExpression(expr)) {
    return styleCandidates(expr.expression, sf, use, seen);
  }
  if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression)) {
    // A local style helper — `style={linkStyle(hover)}`. Follow it to what it returns.
    const fn = resolveCallee(expr.expression.text, use, sf);
    const body =
      fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn) || ts.isFunctionDeclaration(fn))
        ? fn.body
        : undefined;
    if (!body) return [];
    if (!ts.isBlock(body)) return styleCandidates(body as ts.Expression, sf, body, seen);
    const out: ts.ObjectLiteralExpression[] = [];
    const findReturn = (n: ts.Node): void => {
      if (ts.isReturnStatement(n) && n.expression) {
        out.push(...styleCandidates(n.expression, sf, n.expression, seen));
      }
      if (!ts.isFunctionLike(n) || n === body.parent) ts.forEachChild(n, findReturn);
    };
    ts.forEachChild(body, findReturn);
    return out;
  }
  return [];
}

/**
 * An object literal's properties, flattened through spreads and identifier aliases.
 *
 * Returns the merged map PLUS every `color` any spread branch could contribute. The merged map
 * alone is not enough: a spread whose expression is a ternary has several candidates, and folding
 * them into one map with last-writer-wins discards the earlier branch — so
 * `{ ...(cond ? { color: C.accent } : { color: C.accentInk }), textDecoration: "underline" }`
 * resolved to the ink and PASSED while the `cond` branch painted the fill. Every branch renders
 * under some state, so every branch's colour is checked; `alternates` carries the ones the merge
 * dropped. Fail-closed beats tidy here.
 */
function flattenStyle(
  expr: ts.Expression | undefined,
  sf: ts.SourceFile,
  use: ts.Node,
  seen = new Set<ts.Node>(),
): { props: Map<string, ts.Expression>; alternates: ts.Expression[] } {
  const out = new Map<string, ts.Expression>();
  const alternates: ts.Expression[] = [];
  if (!expr || seen.has(expr)) return { props: out, alternates };
  seen.add(expr);
  if (!ts.isObjectLiteralExpression(expr)) return { props: out, alternates };
  for (const p of expr.properties) {
    // SOURCE ORDER, last writer wins — that is what object spread actually does. Merging spreads
    // with `if (!out.has(k))` was only right when the spread is written FIRST: for
    // `{ color: C.accentInk, ...quiet }` it kept the explicit ink while the runtime paints
    // `quiet.color`, so a fill inside the spread was laundered into a pass.
    if (ts.isSpreadAssignment(p)) {
      // The spread target goes through `styleCandidates` too — it is an identifier far more often
      // than a literal (`...quiet`), and it can itself be a ternary or a helper call.
      //
      // Its own `seen`, deliberately: the two functions guard DIFFERENT things — `styleCandidates`
      // marks the expressions it has walked, `flattenStyle` the object literals it has expanded.
      // Sharing one set made `styleCandidates` mark the resolved literal as visited a moment
      // before `flattenStyle` was asked to read it, so every spread silently flattened to nothing.
      // Cycles are still bounded: a spread that resolves back to an object already being expanded
      // is stopped by `flattenStyle`'s own `seen` below.
      for (const o of styleCandidates(p.expression, sf, use)) {
        const inner = flattenStyle(o, sf, o, seen);
        alternates.push(...inner.alternates);
        const c = inner.props.get("color");
        if (c) alternates.push(c); // keep it even if a later writer wins the merge
        for (const [k, v] of inner.props) out.set(k, v);
      }
    } else if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) {
      out.set(p.name.text, p.initializer);
    }
  }
  return { props: out, alternates };
}

/** Names this module IMPORTS. A style built from one lives in another file, which a single-file
 *  walk cannot follow — see the tripwire in the test below for why that is safe rather than a hole. */
function importedNames(sf: ts.SourceFile): Set<string> {
  const out = new Set<string>();
  for (const s of sf.statements) {
    if (!ts.isImportDeclaration(s) || !s.importClause) continue;
    if (s.importClause.name) out.add(s.importClause.name.text);
    const b = s.importClause.namedBindings;
    if (b && ts.isNamedImports(b)) for (const e of b.elements) out.add(e.name.text);
    if (b && ts.isNamespaceImport(b)) out.add(b.name.text);
  }
  return out;
}

/** Every identifier a style expression is rooted in — `X`, `X(…)`, `a ? X : Y`, `X.y`. */
function rootIdents(expr: ts.Expression | undefined, out = new Set<string>()): Set<string> {
  if (!expr) return out;
  if (ts.isIdentifier(expr)) out.add(expr.text);
  else if (ts.isCallExpression(expr)) rootIdents(expr.expression, out);
  else if (ts.isPropertyAccessExpression(expr)) rootIdents(expr.expression, out);
  else if (ts.isConditionalExpression(expr)) {
    rootIdents(expr.whenTrue, out);
    rootIdents(expr.whenFalse, out);
  } else if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr)) {
    rootIdents(expr.expression, out);
  } else if (ts.isBinaryExpression(expr)) {
    rootIdents(expr.left, out);
    rootIdents(expr.right, out);
  }
  return out;
}

/** The `style={…}` expression of a JSX tag, if it has one. */
function styleExpr(tag: ts.JsxOpeningLikeElement): ts.Expression | undefined {
  for (const a of tag.attributes.properties) {
    if (ts.isJsxAttribute(a) && a.name.getText() === "style" && a.initializer &&
        ts.isJsxExpression(a.initializer)) {
      return a.initializer.expression;
    }
  }
  return undefined;
}

describe("no link paints its text with a brand FILL token", () => {
  it("every underlined element's colour resolves to a verifiable ink tier", () => {
    // SITES, not formatted strings. Who introduced each one is resolved lazily, only while the
    // failure message is being built — this walks every .tsx in the tree, so blaming inline would
    // put a `git` process behind every element on a GREEN run.
    resetBlameInvocationCount();
    const offenders: GuardSite[] = [];

    for (const file of sourceFiles(SRC)) {
      const src = readFileSync(file, "utf8");
      const rel = relative(SRC, file);
      const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

      /** Classify one resolved `color:` expression. */
      const check = (colour: ts.Expression, at: ts.Node) => {
        let e: ts.Expression = colour;
        // One level of local aliasing: `color: vitalInk` where `const vitalInk = statusInk(tint)`.
        if (ts.isIdentifier(e)) e = resolveIdent(e.text, at, sf) ?? e;
        const text = e.getText(sf).replace(/\s+/g, " ").trim();
        const raw = colour.getText(sf).replace(/\s+/g, " ").trim();
        const shown = raw === text ? raw : `${raw} → ${text}`;
        const line = lineOf(at);

        const tokens = [...text.matchAll(/\bC\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]!);
        const bad = tokens.find((t) => FILL_ONLY.includes(t));
        if (bad) {
          offenders.push({ file: rel, line, text: `color: ${shown} (C.${bad} is a fill; use C.${FILL_TO_INK[bad]})` });
          return;
        }
        if (tokens.length > 0) {
          const unknown = tokens.find((t) => !INK_OK.test(t));
          if (unknown) {
            offenders.push({ file: rel, line, text: `color: ${shown} (C.${unknown} is not a known text tier)` });
          }
          return;
        }
        if (INERT.test(text) || INK_HELPERS.test(text)) return;
        // FAIL CLOSED — an expression that cannot be traced to an ink is not evidence of safety.
        offenders.push({ file: rel, line, text: `color: ${shown} (unverifiable; point it at an ink token or route it through statusInk)` });
      };

      // Every `textDecoration: …underline` the AST actually reached. Cross-checked against a plain
      // text search at the end of the file, so a shape the parser does not understand becomes a
      // LOUD failure instead of a silent skip — see the note on `accounted` below.
      const accounted = new Set<number>();

      const visit = (node: ts.Node): void => {
        if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
          const sx = styleExpr(node);
          // Every object this `style={…}` can produce: a literal, an identifier, a call to a local
          // style helper, or EITHER BRANCH of a ternary — both are rendered by some state, so both
          // are checked. Restricting this to object literals silently skipped two live links.
          const candidates = styleCandidates(sx, sf, node);
          // PER-ELEMENT accounting. An element that HAS a `style={…}` the parser cannot turn into
          // any object is an unmodelled shape — `style={hover && linkBtn}`, `style={styles.link}`,
          // `style={Object.assign(…)}`. Keying the audit by line let one reached element mark a
          // shared declaration covered for every other consumer of it (AuthGate's `linkBtn` has
          // eight), so a rewritten sibling would vanish silently. This reports the element itself.
          if (sx && candidates.length === 0) {
            // …unless it is built from an IMPORTED name, which lives in another module and is out
            // of reach of a single-file walk. That exemption is only safe because of the tripwire
            // in the next test: no non-`.tsx` module defines an underlined style, so nothing a
            // cross-module reference could be hiding is a link. If that ever changes, it fails.
            const imported = importedNames(sf);
            const roots = [...rootIdents(sx)];
            if (roots.length === 0 || !roots.every((r) => imported.has(r))) {
              offenders.push({ file: rel, line: lineOf(node), text: "`style={…}` shape the AST cannot resolve to an object (teach styleCandidates about it rather than letting the element be skipped)" });
            }
          }
          for (const obj of candidates) {
          const style = flattenStyle(obj, sf, obj);
          const deco = style.props.get("textDecoration");
          // `"underline"`, `"underline dotted"`, and `hover ? "underline" : "none"` alike — the
          // text of the whole expression is searched, so a ternary cannot hide the value.
          if (deco && /\bunderline\b/.test(deco.getText(sf))) {
            accounted.add(lineOf(deco));
            const own = style.props.get("color");
            const sites: { colour: ts.Expression; at: ts.Node }[] = own ? [{ colour: own, at: own }] : [];
            // Colours a spread branch could paint that the merge dropped — see flattenStyle.
            for (const alt of style.alternates) sites.push({ colour: alt, at: alt });

            // …AND the children. UNION, not fallback: a wrapper's own ink does not excuse a
            // child's fill, because both paint visible link text. Bounded by the element itself —
            // this walks its subtree, so it cannot reach a sibling or the next component.
            const element = ts.isJsxOpeningElement(node) ? node.parent : undefined;
            if (element) {
              const descend = (n: ts.Node): void => {
                if (n !== node && (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n))) {
                  for (const o of styleCandidates(styleExpr(n), sf, n)) {
                    const inner = flattenStyle(o, sf, o);
                    const c = inner.props.get("color");
                    if (c) sites.push({ colour: c, at: c });
                    for (const alt of inner.alternates) sites.push({ colour: alt, at: alt });
                  }
                }
                ts.forEachChild(n, descend);
              };
              ts.forEachChild(element, descend);
            }

            if (sites.length === 0) {
              offenders.push({ file: rel, line: lineOf(node), text: "underlined element has no resolvable colour in itself or its children (point it at an ink tier)" });
            }
            for (const s of sites) check(s.colour, s.at);
          }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);

      // ── THE COVERAGE CROSS-CHECK ─────────────────────────────────────────────────────────────
      // A parser is only sound for the shapes it models, and the failure mode of an unmodelled
      // shape is SILENCE: `style.get("textDecoration")` is undefined, the element is skipped, and
      // the suite goes green having checked nothing. That is exactly how the first AST cut dropped
      // two live links — a `ConditionalExpression` and a `CallExpression` — and I read the
      // resulting "16 sites" as agreeing with the old scan's 17 instead of investigating the gap.
      //
      // So the text search stays, not as the guard but as the guard's AUDITOR: every
      // `textDecoration: …underline` written in the file must have been reached by the AST walk.
      // A shape the parser cannot follow now fails loudly, at its own line, instead of vanishing.
      src.split("\n").forEach((line, i) => {
        if (!/textDecoration:\s*[^,\n]*["']underline/.test(line)) return;
        if (accounted.has(i + 1)) return;
        offenders.push({ file: rel, line: i + 1, text: "an underlined style the AST walk never reached (unsupported `style={…}` shape; teach styleCandidates about it rather than letting it be skipped)" });
      });
    }

    expect(
      offenders,
      // Newest commit first, so the link this branch just wrote is the TOP entry rather than one
      // alphabetical row among many. Built only when there is something to report.
      offenders.length === 0
        ? ""
        : attributedGuardReport({
            root: SRC,
            headline: `${offenders.length} underlined link site(s) not provably on an ink tier.`,
            remedy:
              "Point the newest site above at an ink tier (C.ink / C.muted / C.faint) or route " +
              "it through statusInk; a brand FILL token is not a text colour. If the site is an " +
              "unresolvable `style={…}` shape, teach styleCandidates about it rather than " +
              "letting the element be skipped.",
            sites: offenders,
          }),
    ).toEqual([]);
    // A GREEN scan must not have shelled out even once — see the note where offenders is declared.
    expect(
      blameInvocationCount(),
      "a GREEN link scan spawned git processes — attribution must stay on the failing path only",
    ).toBe(0);
  });

  it("no style module outside the scanned .tsx files defines an underlined style", () => {
    // THE TRIPWIRE FOR THE ONE EXEMPTION ABOVE. The scan walks a file at a time, so a `style={…}`
    // built from an IMPORTED name (`terminalSuggestionAnchorStyle(…)`, `menuItemStyle`) cannot be
    // resolved, and those elements are exempted rather than reported. That exemption is only sound
    // while nothing outside the scanned `.tsx` set is a LINK — so this asserts exactly that, and
    // turns "we cannot see across modules" from a silent hole into a failure the moment a link
    // moves there. The remedy then is to follow the import, not to widen the exemption.
    const offenders: GuardSite[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!e.isFile() || !p.endsWith(".ts") || p.endsWith(".d.ts") || p.includes(".test.")) continue;
        readFileSync(p, "utf8").split("\n").forEach((line, i) => {
          if (/textDecoration:\s*[^,\n]*["']underline/.test(line)) {
            offenders.push({
              file: relative(SRC, p),
              line: i + 1,
              text: `an underlined style outside the .tsx scan: ${line.trim()}`,
            });
          }
        });
      }
    };
    walk(SRC);
    expect(
      offenders,
      offenders.length === 0
        ? ""
        : attributedGuardReport({
            root: SRC,
            headline: `${offenders.length} link style(s) the .tsx scan cannot reach.`,
            remedy:
              "A link has moved into a non-.tsx module, which the single-file AST walk above " +
              "exempts and therefore cannot check. Follow the import from the newest site above " +
              "and bring the style back into the scanned set — do NOT widen the exemption.",
            sites: offenders,
          }),
    ).toEqual([]);
  });
});
