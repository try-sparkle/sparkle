// THE ONE OWNER of "slice a top-level function's body out of source text", for the source-scanning
// test guards in this repo.
//
// ── WHY IT EXISTS (bead `sparkle-7uh1v5`) ──────────────────────────────────────────────────────
// A guard in `engine/observedAttentionChainParity.test.ts` brace-matched a function body starting
// from the FIRST `{` after the function NAME. That brace was not the body — it was an empty-object
// default in the PARAMETER LIST (`interaction: Record<string, number> = {}`), a balanced pair that
// closes two characters later. The "body" it sliced was therefore the SIGNATURE ALONE, so the one
// assertion the guard existed to make could never fail. It stayed green on the very day the thing
// it was watching for landed inside that function.
//
// That guard's anti-vacuity anchor was `expect(body).not.toBe("")` — which passes happily on a
// seventeen-line signature. Three successive drafts of the same guard were each vacuous in a
// DIFFERENT way (a whole-file grep, a slice-to-EOF, and this signature-only slice), which is the
// evidence that hand-rolling this is not a thing anyone gets right by being careful.
//
// ── THE TWO RULES THIS MODULE ENFORCES ─────────────────────────────────────────────────────────
//  1. SKIP THE WHOLE PARAMETER LIST by balancing PARENS, then take the body from a `{` whose
//     matching `}` sits in COLUMN 0 and ends its line. Neither a defaulted parameter nor an inline
//     object RETURN TYPE (`): { published: StatusMap } {`) can forge that anchor.
//  2. IT THROWS. It never returns "" and never returns the whole file. An empty return is exactly
//     how this class of vacuity survives: every downstream `!== ""` / `not.toBe("")` anchor passes
//     on it, so a broken scanner reads as a passing guard. A guard that CRASHES naming what it
//     could not find is strictly better than one that silently stops asserting.
//
// And the extracted slice is the body ONLY — exclusive of the outer braces, and therefore
// exclusive of the signature. That is deliberate: the measured defect was a slice that WAS the
// signature, so a helper that can never include the signature cannot reproduce it.
//
// ── WHY IT LIVES IN `packages/core/testing/` ───────────────────────────────────────────────────
// The guards that need it live in BOTH `@sparkle/desktop` and `@sparkle/mcp-control`. Those two
// packages cannot import each other's sources — `apps/mcp-control/tsconfig.json` pins
// `rootDir: "src"`, so a relative import reaching into `apps/desktop/src` fails `tsc --noEmit` even
// though vitest would resolve it at runtime. `@sparkle/core` is a workspace dependency of both, and
// `testing/landedClaim.ts` beside this file is the established precedent for a shared,
// framework-free test utility. Nothing here imports vitest: the suites do the asserting.
//
// ── WHAT IT DOES NOT PARSE ─────────────────────────────────────────────────────────────────────
// It is a brace/paren scanner that knows about line comments, block comments, single- and
// double-quoted strings, template literals (including `${…}` interpolations), Rust raw strings
// (`r"…"`, `r#"…"#`), Rust char literals and Rust lifetimes. It is NOT a parser. It does not know
// about JS regex literals, so a regex holding an unbalanced brace (`/\{/`) between the declaration
// and the body's close will make brace matching run away — and that fails LOUDLY with a throw,
// which is the failure direction this whole module is about.

/** Thrown when a body cannot be extracted. Named so a `catch` can tell it from an assertion. */
export class FunctionBodyExtractionError extends Error {
  readonly functionName: string;
  constructor(functionName: string, reason: string) {
    super(
      `extractTopLevelFunctionBody(${JSON.stringify(functionName)}): ${reason}. ` +
        `Refusing to return a slice — a wrong or empty body makes every assertion built on it ` +
        `vacuous, which is the exact failure (bead sparkle-7uh1v5) this helper exists to end.`,
    );
    this.name = "FunctionBodyExtractionError";
    this.functionName = functionName;
  }
}

/** Thrown by {@link assertBodyContains} when the deep-body anchor is missing. */
export class BodyAnchorError extends Error {
  readonly functionName: string;
  readonly marker: string;
  constructor(functionName: string, marker: string, reason: string) {
    super(reason);
    this.name = "BodyAnchorError";
    this.functionName = functionName;
    this.marker = marker;
  }
}

// ── SCANNER PRIMITIVES ─────────────────────────────────────────────────────────────────────────

/** A Rust char literal or a JS single-quoted char: `'x'`, `'\n'`, `'\u{1F600}'`. */
const CHAR_LITERAL = /^'(?:\\(?:x[0-9a-fA-F]{2}|u\{[0-9a-fA-F]{1,6}\}|.)|[^\\'\n])'/;
/** A Rust lifetime — `'a`, `'static` — NOT closed by a second quote. */
const LIFETIME = /^'(?:[A-Za-z_][A-Za-z0-9_]*)(?!')/;

/**
 * If `src[i]` opens a comment or a string, return the index just PAST it. Otherwise return `i`
 * unchanged, meaning "this is a code character, look at it".
 *
 * An unterminated comment or string returns `src.length`, which stops every caller's loop and ends
 * in a throw rather than in a silent partial answer.
 */
function skipNonCode(src: string, i: number): number {
  const c = src[i];
  if (c === undefined) return src.length;

  if (c === "/" && src[i + 1] === "/") {
    const nl = src.indexOf("\n", i);
    return nl === -1 ? src.length : nl; // leave the newline in code, callers count columns on it
  }
  if (c === "/" && src[i + 1] === "*") {
    const end = src.indexOf("*/", i + 2);
    return end === -1 ? src.length : end + 2;
  }

  // Rust raw string: r"…", r#"…"#, r##"…"##. No escapes inside; the hash count closes it.
  if (c === "r" && (src[i + 1] === '"' || src[i + 1] === "#")) {
    let h = i + 1;
    while (src[h] === "#") h += 1;
    if (src[h] === '"') {
      const hashes = "#".repeat(h - (i + 1));
      const end = src.indexOf(`"${hashes}`, h + 1);
      return end === -1 ? src.length : end + 1 + hashes.length;
    }
  }

  if (c === "'") {
    const rest = src.slice(i, i + 16);
    const ch = CHAR_LITERAL.exec(rest);
    if (ch) return i + ch[0].length;
    const lt = LIFETIME.exec(rest);
    if (lt) return i + lt[0].length; // a lifetime is an identifier, not a string
    return skipQuoted(src, i, "'");
  }
  if (c === '"') return skipQuoted(src, i, '"');
  if (c === "`") return skipTemplate(src, i);

  return i;
}

/** Index just past a `'…'` / `"…"` string opening at `i`, honouring backslash escapes. */
function skipQuoted(src: string, i: number, quote: string): number {
  for (let j = i + 1; j < src.length; j += 1) {
    const c = src[j];
    if (c === "\\") {
      j += 1;
      continue;
    }
    if (c === quote) return j + 1;
  }
  return src.length;
}

/**
 * Index just past a template literal opening at `i`.
 *
 * `${…}` regions are CODE, so they are walked with the same scanner (nested templates, strings and
 * comments all work), and only their closing `}` returns us to template text. Without this, a
 * template holding a lone `{` would unbalance the outer brace count.
 */
function skipTemplate(src: string, i: number): number {
  for (let j = i + 1; j < src.length; j += 1) {
    const c = src[j];
    if (c === "\\") {
      j += 1;
      continue;
    }
    if (c === "`") return j + 1;
    if (c === "$" && src[j + 1] === "{") {
      let depth = 1;
      let k = j + 2;
      while (k < src.length && depth > 0) {
        const skipped = skipNonCode(src, k);
        if (skipped !== k) {
          if (skipped >= src.length) return src.length;
          k = skipped;
          continue;
        }
        if (src[k] === "{") depth += 1;
        else if (src[k] === "}") depth -= 1;
        k += 1;
      }
      if (depth !== 0) return src.length;
      j = k - 1;
    }
  }
  return src.length;
}

/** Index of the `}` matching the `{` at `openIdx`, or -1 when it never balances. */
function matchBrace(src: string, openIdx: number): number {
  let depth = 1;
  let i = openIdx + 1;
  while (i < src.length) {
    const skipped = skipNonCode(src, i);
    if (skipped !== i) {
      if (skipped >= src.length) return -1;
      i = skipped;
      continue;
    }
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return -1;
}

/** Index of the `)` matching the `(` at `openIdx`, or -1 when it never balances. */
function matchParen(src: string, openIdx: number): number {
  let depth = 1;
  let i = openIdx + 1;
  while (i < src.length) {
    const skipped = skipNonCode(src, i);
    if (skipped !== i) {
      if (skipped >= src.length) return -1;
      i = skipped;
      continue;
    }
    if (src[i] === "(") depth += 1;
    else if (src[i] === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return -1;
}

/** True when `idx` is the first character of its line. */
function atColumnZero(src: string, idx: number): boolean {
  return idx === 0 || src[idx - 1] === "\n";
}

/**
 * True when nothing but an optional `;` (and an optional trailing comment) follows `}` on its line.
 *
 * THIS IS THE HALF THAT SURVIVES A MULTILINE RETURN TYPE. Prettier formats a wide object return
 * type with its closing brace in COLUMN 0 — `): {\n  x: string;\n} {` — so "closes at column 0" on
 * its own would accept the return TYPE as the body, one step past the bug this module fixes. The
 * return type's close line reads `} {`; a real body's reads `}` or `};`.
 */
function closesItsLine(src: string, closeIdx: number): boolean {
  const nl = src.indexOf("\n", closeIdx);
  const rest = src.slice(closeIdx + 1, nl === -1 ? src.length : nl);
  return /^\s*;?\s*(?:\/\/.*)?$/.test(rest);
}

function escapeForRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── DECLARATION LOOKUP ─────────────────────────────────────────────────────────────────────────

/**
 * Every top-level declaration form this helper knows, anchored to COLUMN 0 (`^` under `m`), which
 * is itself the top-level check: an indented declaration is nested in something and is out of
 * scope by construction.
 *
 *  - `function name(`, `export function name(`, `async function name(`, `export default function`
 *  - `fn name(`, `pub fn name(`, `pub(crate) fn name(`, `pub async fn name(`  (Rust)
 *  - `const name = (…) =>`, `const name = async (…) =>`, `const name = function (…)`,
 *    `export const name: T = (…) =>`
 */
function declarationPatterns(name: string): RegExp[] {
  const n = escapeForRegExp(name);
  return [
    new RegExp(
      `^(?:export\\s+(?:default\\s+)?)?(?:pub(?:\\s*\\([^)\\n]*\\))?\\s+)?(?:async\\s+)?(?:function|fn)\\s+${n}\\b`,
      "gm",
    ),
    new RegExp(`^(?:export\\s+)?(?:const|let|var)\\s+${n}\\b`, "gm"),
  ];
}

/**
 * The start of the NEXT top-level thing, in either language — an attribute, a decorator, or a
 * declaration keyword in COLUMN 0.
 *
 * THIS IS WHAT BOUNDS THE CANDIDATE WALK (roborev 74090). Rejecting a candidate brace and walking
 * on is correct inside one declaration — an inline return type is exactly that — but unbounded it
 * leaves the declaration entirely and returns a SIBLING's body: `fn target(a: u8) -> u8 { a }`
 * followed by a normally-formatted `fn other()` rejects `{ a }` (close is mid-line), finds
 * `other`'s brace, and hands back `other`'s body with no throw. Rust puts no `;` after a `fn`, so
 * the `;` stop cannot see it, and a wrong-but-plausible body is WORSE than an empty one: it passes
 * a `not.toBe("")` anchor AND can satisfy an unrelated `toContain`.
 */
const NEXT_TOP_LEVEL =
  /^(?:#\[|@|export\b|import\b|declare\b|pub\b|async\b|function\b|fn\b|const\b|let\b|var\b|class\b|interface\b|type\b|enum\b|impl\b|struct\b|trait\b|mod\b|use\b|static\b|unsafe\b|extern\b)/gm;

/** Index where the declaration starting at `from` must have ended — the next top-level start. */
function declarationLimit(source: string, from: number): number {
  NEXT_TOP_LEVEL.lastIndex = from;
  const m = NEXT_TOP_LEVEL.exec(source);
  NEXT_TOP_LEVEL.lastIndex = 0;
  return m ? m.index : source.length;
}

/** Every column-0 declaration of `name`, as start indices, in source order. */
function declarationIndices(source: string, name: string): number[] {
  const found: number[] = [];
  for (const re of declarationPatterns(name)) {
    for (const m of source.matchAll(re)) {
      if (m.index === undefined) continue;
      found.push(m.index + m[0].length);
    }
  }
  return [...new Set(found)].sort((a, b) => a - b);
}

// ── THE PUBLIC API ─────────────────────────────────────────────────────────────────────────────

export interface ExtractOptions {
  /**
   * Deep-body markers the slice must contain — checked with {@link assertBodyContains}.
   *
   * Passing them here is the SHORT form, which is the point: the strong anchor should be less
   * typing than the weak one. Omit only when the caller anchors separately.
   */
  anchors?: readonly string[];
}

/**
 * Slice the BODY of the top-level function `functionName` out of `source`.
 *
 * Returns the text BETWEEN the body's opening brace and its matching close, exclusive of both — so
 * the signature is never in the result, whatever the parameter list contains.
 *
 * @throws {FunctionBodyExtractionError} when the declaration is not found, is ambiguous, has no
 *         parameter list, has no body, or when the braces never balance to a column-0 close. It
 *         NEVER returns "" and never returns the whole file.
 * @throws {BodyAnchorError} when `opts.anchors` is given and the slice does not contain one.
 */
export function extractTopLevelFunctionBody(
  source: string,
  functionName: string,
  opts: ExtractOptions = {},
): string {
  if (functionName === "") {
    throw new FunctionBodyExtractionError(functionName, "the function name is empty");
  }
  const starts = declarationIndices(source, functionName);
  if (starts.length === 0) {
    throw new FunctionBodyExtractionError(
      functionName,
      "no top-level (column 0) declaration of that name — was it renamed, moved, or indented " +
        "into a class or block? Known forms: `function f(`, `async function f(`, `export const " +
        "f = (`, `const f = function (`, `fn f(`, `pub fn f(`",
    );
  }
  if (starts.length > 1) {
    throw new FunctionBodyExtractionError(
      functionName,
      `${starts.length} top-level declarations of that name — the slice would be ambiguous. ` +
        "Scope the source first (Rust: cut at `#[cfg(test)]`; TS: cut at the test module)",
    );
  }
  const afterName = starts[0]!;

  // 1. THE PARAMETER LIST. Scan to its opening paren, tolerating a generic parameter list on the
  //    way (`<T extends { x: 1 }>`) — a `{` inside angle brackets is a type, not the body.
  let i = afterName;
  let angle = 0;
  let paramOpen = -1;
  while (i < source.length) {
    const skipped = skipNonCode(source, i);
    if (skipped !== i) {
      if (skipped >= source.length) break;
      i = skipped;
      continue;
    }
    const c = source[i];
    if (c === "<") angle += 1;
    else if (c === ">") angle = Math.max(0, angle - 1);
    else if (c === "(" && angle === 0) {
      paramOpen = i;
      break;
    } else if (angle === 0 && (c === "{" || c === ";")) {
      break; // an object literal / interface / bare declaration — not a function
    }
    i += 1;
  }
  if (paramOpen === -1) {
    throw new FunctionBodyExtractionError(
      functionName,
      "found the declaration but no parameter list before a `{` or `;` — this name is not a " +
        "function (an object literal, an interface and a bare `const` all land here)",
    );
  }
  const paramClose = matchParen(source, paramOpen);
  if (paramClose === -1) {
    throw new FunctionBodyExtractionError(
      functionName,
      "the parameter list's parentheses never balance",
    );
  }

  // 2. THE BODY. Every `{` after the parameter list is a candidate; the body is the first whose
  //    matching `}` sits in column 0 AND ends its line. A defaulted `= {}` inside the parameters is
  //    already behind us; an inline object return type is rejected here (its close is mid-line, or
  //    its close line reads `} {`).
  const MAX_CANDIDATES = 8;
  // Hard stop: the next top-level declaration. Past it we are no longer looking at THIS function,
  // and a candidate found there would hand back a sibling's body (roborev 74090).
  const limit = declarationLimit(source, paramClose + 1);
  let cursor = paramClose + 1;
  for (let n = 0; n < MAX_CANDIDATES; n += 1) {
    let cand = -1;
    while (cursor < limit) {
      const skipped = skipNonCode(source, cursor);
      if (skipped !== cursor) {
        if (skipped >= source.length) break;
        cursor = skipped;
        continue;
      }
      if (source[cursor] === "{") {
        cand = cursor;
        break;
      }
      if (source[cursor] === ";") {
        // A `;` before ANY candidate brace means there is no body at all. A `;` after one means we
        // saw braces and rejected every one of them, which is a different diagnosis — fall through
        // to the column-0 message below rather than claiming the declaration is bodiless.
        if (n === 0) {
          throw new FunctionBodyExtractionError(
            functionName,
            "the declaration ends at `;` with no body (an overload signature, a trait method, or " +
              "a type alias)",
          );
        }
        break;
      }
      cursor += 1;
    }
    if (cand === -1 || cand >= limit) break;

    const close = matchBrace(source, cand);
    if (close === -1) {
      throw new FunctionBodyExtractionError(
        functionName,
        "braces never balance from the candidate body brace to the end of the source — the body " +
          "is unterminated, or an unhandled construct (a regex literal holding a lone brace) is " +
          "in the way",
      );
    }
    if (atColumnZero(source, close) && closesItsLine(source, close)) {
      const body = source.slice(cand + 1, close);
      if (opts.anchors) assertBodyContains(body, opts.anchors, functionName);
      return body;
    }
    cursor = close + 1;
  }

  throw new FunctionBodyExtractionError(
    functionName,
    "no candidate brace after the parameter list closes in COLUMN 0 on a line of its own BEFORE " +
      "the next top-level declaration, so the body cannot be bounded. Either the declaration is " +
      "not top level, its body is written on one line, or the file is formatted in a way this " +
      "scanner does not model. The search deliberately stops at the next declaration rather than " +
      "walking on: a brace found there would hand back a SIBLING's body, which is worse than no " +
      "answer — fix the anchor rather than widening the slice",
  );
}

/**
 * THE ANTI-VACUITY ANCHOR. Assert that an extracted body contains a marker from DEEP INSIDE it.
 *
 * `expect(body).not.toBe("")` is not this. The truncation that motivated this module produced a
 * seventeen-line, perfectly NON-EMPTY signature which sailed through exactly that check while
 * containing none of the code the guard claimed to be searching. A marker that only appears well
 * past the parameter list and the return type is the thing a truncated slice cannot forge.
 *
 * @param body    the slice returned by {@link extractTopLevelFunctionBody}.
 * @param marker  one distinctive identifier from deep in the body, or several.
 * @param fnName  the function the body came from — it goes in the failure message.
 * @throws {BodyAnchorError} naming the rule, the function, and the missing marker.
 */
export function assertBodyContains(
  body: string,
  marker: string | readonly string[],
  fnName: string,
): void {
  const markers = typeof marker === "string" ? [marker] : marker;
  if (markers.length === 0) {
    throw new BodyAnchorError(
      fnName,
      "",
      `deep-body anchor: no markers given for \`${fnName}\`. An anchor with nothing to look for ` +
        `is the vacuous check this rule exists to replace — name an identifier that appears only ` +
        `deep inside the body.`,
    );
  }
  for (const m of markers) {
    if (m.trim() === "") {
      throw new BodyAnchorError(
        fnName,
        m,
        `deep-body anchor: an empty marker was given for \`${fnName}\`. An empty marker is ` +
          `contained by every string, including a signature-only slice — that is precisely the ` +
          `vacuity this rule exists to prevent.`,
      );
    }
    if (!body.includes(m)) {
      throw new BodyAnchorError(
        fnName,
        m,
        `deep-body anchor FAILED for \`${fnName}\`: the extracted body does not contain ` +
          `${JSON.stringify(m)}.\n` +
          `WHY THIS RULE EXISTS (bead sparkle-7uh1v5): a slice that stops inside the SIGNATURE is ` +
          `non-empty, so a \`not.toBe("")\` check passes on it and every assertion built on the ` +
          `slice becomes vacuous — green on the exact event the guard exists to catch. A marker ` +
          `from deep in the body is the one thing a truncated slice cannot forge.\n` +
          `WHAT TO DO: if \`${fnName}\` still contains ${JSON.stringify(m)}, the extraction is ` +
          `broken — fix it. If the code genuinely moved, re-point this guard at the function that ` +
          `holds the behaviour now. Do NOT weaken the anchor.\n` +
          `Extracted ${body.length} chars, first line: ${JSON.stringify(body.split("\n")[1] ?? body.slice(0, 80))}`,
      );
    }
  }
}
