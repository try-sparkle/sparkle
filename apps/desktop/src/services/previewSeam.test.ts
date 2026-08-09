import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { PREVIEW_ALREADY_STARTING } from "./preview";

// THE ONE SEAM IN THE PREVIEW FEATURE THAT NO OTHER TEST CAN SEE.
//
// `preview_open` refuses a second start for an agent whose first start is still in flight, and the
// frontend must NOT paint that refusal as a failed start — the pane's `failed` state is terminal, so
// doing so reports a broken preview for the one rejection where nothing is wrong and the honest
// "starting…" never comes back. The refusal crosses the IPC boundary as a bare string, so the whole
// mechanism rests on two languages agreeing about a literal that each one hand-copies.
//
// Every OTHER test of this path is blind to a drift in that literal, and blind in the direction that
// looks fine: the Rust suite asserts its own message contains its own constant, the TS suite feeds
// its own constant to a mocked rejection, and both stay green after either side is reworded. Reading
// the Rust source is unglamorous but it is the only mechanical pin available short of generating one
// side from the other (ts-rs / a shared fixture), which is the durable fix AGENTS.md names for
// exactly this shape of Rust↔TS coupling.
const RUST_SOURCE = fileURLToPath(new URL("../../src-tauri/src/preview.rs", import.meta.url));

describe("the already-starting refusal is one literal, not two", () => {
  const whole = readFileSync(RUST_SOURCE, "utf8");
  // PRODUCTION HALF ONLY. Scanning the whole file lets a Rust TEST satisfy the guard on the
  // production code's behalf — `assert_eq!(err, format!("… {ALREADY_STARTING}"))` is the natural
  // strengthening of the existing assertion, and once it exists `reserve_or_reattach` could drop
  // the interpolation for a plain literal with this, the seam's only mechanical pin, still green.
  //
  // FAILS CLOSED, BY CONSTRUCTION RATHER THAN BY AN ADJACENT ASSERTION. Two earlier shapes both
  // let `src` degrade to the whole file when the marker is absent, which silently restores the
  // blindness this scoping exists to close:
  //   * `indexOf(...) + 1 || whole.length` — the fallback IS the whole file (`-1 + 1 === 0` was the
  //     only reason it fired, which is also why the intent was unreadable).
  //   * a bare `slice(0, cut)` plus a sibling `expect(cut).toBeGreaterThan(-1)` — `slice(0, -1)` is
  //     the file minus its LAST CHARACTER, so the two tests below kept scanning `mod tests` and the
  //     red came from a different test complaining about a marker string. A filtered run
  //     (`-t "declares the token"`) never executes that sibling at all, and the cheap way to clear
  //     its failure is to edit the sentinel rather than the scope.
  // Throwing here fails every test in this describe AT COLLECTION, in any run configuration, with
  // the reason that is actually true.
  const cut = whole.indexOf("mod tests");
  if (cut < 0) {
    throw new Error(
      "preview.rs no longer carries its `mod tests` marker — this guard cannot scope itself to the " +
        "production half, and an unscoped scan can be satisfied by a Rust TEST on production's behalf",
    );
  }
  const src = whole.slice(0, cut);

  it("scoped itself to the production half", () => {
    // Not the marker check — that is the throw above. This is the OTHER direction: a `mod tests`
    // occurring early (a doc comment, a nested module) would truncate the scan to nearly nothing
    // and every pattern below would red as a seam violation when the seam is intact.
    // NOT `expect(src).not.toContain("mod tests")` — `slice(0, cut)` makes that true by
    // construction, which is the vacuous shape this whole file is written against. Both bounds are
    // properties the slice does NOT guarantee: production is large, and the test module it cut away
    // is large too (a marker landing near EOF would leave the scan looking scoped while covering
    // the tests anyway).
    expect(src.length).toBeGreaterThan(1000);
    expect(whole.length - src.length).toBeGreaterThan(1000);
  });

  it("declares the token in preview.rs with the exact value the frontend matches on", () => {
    // Anchored on the const DECLARATION rather than on any occurrence of the token in the file:
    // a comment mentioning "already-starting" would satisfy a bare `includes` forever, which is the
    // vacuous shape this file exists to avoid.
    const declared = /const ALREADY_STARTING: &str = "([^"]+)";/.exec(src)?.[1];
    expect(declared, "preview.rs must declare `const ALREADY_STARTING`").toBeDefined();
    expect(declared).toBe(PREVIEW_ALREADY_STARTING);
  });

  it("builds the refusal message from that const rather than restating it", () => {
    // THE WEAKEST TRUE PROPERTY: some format string interpolates the const. Nothing about the prose
    // around it, and nothing about the line breaks.
    //
    // The first draft pinned the whole sentence and the exact `Err(format!(…))` spelling, which
    // contradicted the design it was guarding — the const is a token precisely BECAUSE prose gets
    // edited. Rewording the message, adding the agent id, or letting rustfmt wrap that ~90-column
    // line would all have gone red with a failure that reads as a seam violation when the seam was
    // untouched. A guard that reds on correct changes gets deleted, and then the real regression
    // (dropping the interpolation for a plain literal) has nothing watching it.
    // `\s*` after the paren, because the rustfmt wrap named above as the motivating false-red is
    // exactly `format!(\n    "…{ALREADY_STARTING}"\n)` — a pattern requiring the quote to be
    // adjacent to the paren would still have reded on it, which is the failure this loosening
    // exists to prevent.
    expect(src).toMatch(/format!\(\s*"[^"]*\{ALREADY_STARTING\}/);
  });
});

// THE STATE UNION IS THE OTHER HALF OF THIS SEAM, and until now nothing tied the two sides.
//
// Rust's `PreviewState` is serialized straight onto the wire and `applyPreviewStatus` writes it into
// the store unvalidated. Each side guards only itself: Rust's `wire_name` is an exhaustive `match`
// (adding a variant fails to compile THERE), and the pane's `PANE_FOR` is a total `Record` (adding a
// TS member fails to compile THERE). Neither notices the other — so adding `Installing` to the enum
// leaves every Rust test green while the TS union stays stale, and the pane then tells the user its
// state is unrecognised for a server that is perfectly healthy. That is the failure this asserts.
//
// The durable fix is generating one side from the other (`ts-rs`) or a fixture both suites parse.
// Until that exists, reading the enum is what makes the two fail TOGETHER.
const STORE = fileURLToPath(new URL("../stores/previewStore.ts", import.meta.url));

/**
 * Rust source with line and block comments blanked out, newlines preserved.
 *
 * A PRE-PASS OVER THE WHOLE SOURCE, not over an already-extracted body. Brace counting runs on the
 * text, so a brace that is only PROSE moves the boundary: preview.rs is written in a style dense
 * with backticked code inside doc comments (`{ALREADY_STARTING}`, `Listening {`), and one
 * unbalanced `}` in a variant's doc comment truncates the enum — dropping every later variant into
 * the same both-sides-missing blind spot a stale union then agrees with. An unbalanced `{` runs the
 * scan off the end of the enum into unrelated code. Stripping first is what makes the count mean
 * what it says.
 *
 * AND STRING LITERALS ARE MODELLED, because once the pass runs source-wide a regex cannot be
 * trusted to find a comment. `/\/\*[\s\S]*?\*\//` treats the `/*` inside ANY string as an opener,
 * and a glob literal contains one: `"**\/*.tsx"` carries both halves. preview.rs already ships
 * `"apps/*"` — harmless today only by accident, because it sits after the enum and the file happens
 * to contain no later block-comment close. Add one glob above the enum plus any `*\/` below it and
 * everything between is blanked, declaration included; `readEnum` then reports "no declaration" for
 * a declaration sitting right there — the misdiagnosis its two-cause result exists to prevent, and a
 * guard that reds on correct changes gets deleted (see `:81`).
 *
 * So: one left-to-right scan that knows what it is inside of. Strings (with `\` escapes), raw
 * strings (`r"…"`, `r#"…"#`), and char literals pass through untouched; comments — which nest in
 * Rust — are blanked to spaces with newlines preserved. A lone `'` is a LIFETIME, not a char
 * literal, so `&'static str` is left alone rather than swallowing source to the next quote.
 */
/** `r"`, `r##"`, `br"` … — sticky so it can be applied at an offset without slicing the source. */
const RAW_PREFIX = /b?r(#*)"/y;

function withoutRustComments(source: string): string {
  const blank = (s: string) => s.replace(/[^\n]/g, " ");
  const out: string[] = [];
  let i = 0;
  while (i < source.length) {
    const two = source.slice(i, i + 2);

    if (two === "//") {
      const nl = source.indexOf("\n", i);
      const stop = nl < 0 ? source.length : nl;
      out.push(blank(source.slice(i, stop)));
      i = stop;
      continue;
    }

    if (two === "/*") {
      const start = i;
      let depth = 0;
      while (i < source.length) {
        if (source.slice(i, i + 2) === "/*") {
          depth++;
          i += 2;
        } else if (source.slice(i, i + 2) === "*/") {
          depth--;
          i += 2;
          if (depth === 0) break;
        } else i++;
      }
      out.push(blank(source.slice(start, i)));
      continue;
    }

    // Raw string: `r"…"`, `r##"…"##`, and the BYTE form `br"…"`. Only when the prefix starts a
    // token, so `str` and `for` are safe. Two things here are deliberate, each a way an earlier
    // draft got it wrong: the `b` is part of the prefix (rejecting it re-scanned `br"C:\"` as an
    // ordinary escaped string, whose `\"` is not an escape at all in a raw literal, swallowing
    // source past the literal's real end), and the match is STICKY rather than run against a fixed
    // 16-char window, which silently failed to match beyond ~14 hashes.
    //
    // The terminator is `indexOf('"' + hashes)` — a quote followed by at least the opening hash
    // count, which is the rule. A hand-rolled scan replaced this for one commit, credited with
    // fixing a body containing its own `"#`; it was SEMANTICALLY IDENTICAL (same predicate, same
    // stop offset), so it fixed nothing and no mutant could distinguish them. Reverted to the form
    // with fewer moving parts rather than left in place with a claim attached.
    RAW_PREFIX.lastIndex = i;
    const raw = RAW_PREFIX.exec(source);
    if (raw && !/[A-Za-z0-9_]/.test(source[i - 1] ?? " ")) {
      const close = `"${raw[1]!}`;
      const end = source.indexOf(close, i + raw[0].length);
      const stop = end < 0 ? source.length : end + close.length;
      out.push(source.slice(i, stop));
      i = stop;
      continue;
    }

    if (source[i] === '"') {
      const start = i++;
      while (i < source.length) {
        if (source[i] === "\\") i += 2;
        else if (source[i] === '"') {
          i++;
          break;
        } else i++;
      }
      out.push(source.slice(start, i));
      continue;
    }

    // A char literal is exactly `'x'` or `'\n'`; anything else beginning with `'` is a lifetime.
    const ch = /^'(?:\\.|[^\\'])'/.exec(source.slice(i, i + 6));
    if (ch) {
      out.push(ch[0]);
      i += ch[0].length;
      continue;
    }

    out.push(source[i]!);
    i++;
  }
  return out.join("");
}

/** Why an enum could not be read, so the two causes are not diagnosed as one. */
type EnumRead =
  | { ok: true; variants: string[]; unparsed: string[] }
  | { ok: false; why: "no declaration" | "braces never balanced" };

/**
 * Every variant of `pub enum <name>`, lowercased, plus the entries that did NOT parse.
 *
 * SPLIT ON TOP-LEVEL COMMAS, don't walk lines. Line-walking got this wrong twice in opposite
 * directions and both were reported as findings:
 *   * one variant per line was assumed, so `Starting, Listening,` on one hand-written line parsed
 *     only `starting` and the rest vanished — with a "every line must parse" assertion that could
 *     not see it, because the leftovers sat on a line that DID parse (green, union stale);
 *   * a multi-line struct variant made `port: u16,` and `},` look like unparsed variants, so an
 *     ordinary rustfmt-shaped Rust change REDS with a message accusing a field line of being a
 *     variant. A guard that reds on correct changes gets deleted (see `:81`), which is how the
 *     regression it was watching for ends up unwatched.
 * A comma at brace/paren depth 0 is the only thing that separates variants, so splitting there
 * makes both shapes fall out: two variants on one line are two entries, and a struct variant is ONE
 * entry however many lines it spans (its inner commas are at depth > 0).
 *
 * `unparsed` is returned rather than thrown so the caller can name the offending entries — an
 * entry the parser cannot read is a variant that would be compared against the union WITHOUT.
 */
function readEnum(source: string, name: string): EnumRead {
  const clean = withoutRustComments(source);
  const decl = clean.indexOf(`pub enum ${name}`);
  if (decl < 0) return { ok: false, why: "no declaration" };
  const open = clean.indexOf("{", decl);
  if (open < 0) return { ok: false, why: "braces never balanced" };

  let depth = 0;
  let close = -1;
  for (let i = open; i < clean.length; i++) {
    if (clean[i] === "{") depth++;
    else if (clean[i] === "}" && --depth === 0) {
      close = i;
      break;
    }
  }
  if (close < 0) return { ok: false, why: "braces never balanced" };

  // Split the body at depth-0 commas.
  const body = clean.slice(open + 1, close);
  const entries: string[] = [];
  let buf = "";
  let d = 0;
  for (const ch of body) {
    if (ch === "{" || ch === "(" || ch === "[") d++;
    else if (ch === "}" || ch === ")" || ch === "]") d--;
    if (ch === "," && d === 0) {
      entries.push(buf);
      buf = "";
    } else buf += ch;
  }
  entries.push(buf);

  const variants: string[] = [];
  const unparsed: string[] = [];
  for (const raw of entries) {
    // Attributes are STRIPPED, not used to discard the entry: `#[serde(rename = "installing")]
    // Installing` is a variant, and filtering the whole entry out hid it from both the parse and
    // the accounting, which is a stale union going green.
    const entry = raw.replace(/#\[[\s\S]*?\]/g, "").replace(/\s+/g, " ").trim();
    if (entry === "") continue;
    // Name, then OPTIONALLY a whole payload / discriminant — and nothing else. Requiring the match
    // to consume the entry is what makes leftovers visible instead of discarded.
    const m = /^([A-Za-z][A-Za-z0-9_]*)\s*(?:\([\s\S]*\)|\{[\s\S]*\}|=\s*\S[\s\S]*)?$/.exec(entry);
    if (m) variants.push(m[1]!.toLowerCase());
    else unparsed.push(entry);
  }
  return { ok: true, variants, unparsed };
}

// THE LEXER IS TESTED DIRECTLY, because the enum comparison is a weak and ambiguous detector of a
// regression in it. A mis-lexed region that leaves a real comment un-blanked lets a brace in prose
// move the enum boundary — which reds with a message accusing the SEAM, sending the reader to the
// wrong file — and if the union happens to be stale for exactly the truncated tail, both sides agree
// and it goes green. None of the shapes below appear in preview.rs today, which is the point: they
// are what a lexer edit months from now would break, with nothing else in the repo watching.
describe("withoutRustComments keeps code and blanks only comments", () => {
  // ASSERT ON THE COMMENT AFTER THE TRICKY LITERAL, NOT ON THE DECLARATION SURVIVING. The first
  // draft of these tests checked `toContain("pub enum …")`, which is VACUOUS for every literal
  // shape: a mis-lexed literal does not delete what follows, it keeps it (string content passes
  // through untouched), so the declaration is present either way and the test passes against the
  // broken lexer. Mutation confirmed it — dropping the `b?` prefix and dropping the lifetime guard
  // both stayed green. What a mis-lex actually costs is that the region gets treated as STRING, so
  // a real comment inside it is never blanked — and an unbalanced brace in that comment is what
  // moves the enum boundary. Each case therefore ends with a comment that must be gone.
  const lexed = (src: string) => withoutRustComments(src);

  it("does not read a glob literal's `/*` as a block-comment opener", () => {
    // THE FIXTURE IS `"apps/*"`, WHICH IS THE ONE THAT SHIPS — and the choice is the whole test.
    // The first draft used `"apps/**/*.tsx"`, which is VACUOUS against the regex this lexer
    // replaced: a lazy `/\/\*[\s\S]*?\*\//` opens at the `/*` in `apps/**` and closes two
    // characters later on the `*/` of `**/`, so the match is the 4-char `/**/`, nothing below is
    // touched, and both assertions pass against the broken implementation. Only a glob with NO
    // `*/` of its own — exactly the `"apps/*"` preview.rs carries at its packages fixture — makes
    // the lazy match run down to the next `*/` below and swallow the declaration.
    const out = lexed('let g = "apps/*";\npub enum PreviewState { A }\n/* later */\n');
    expect(out, "a glob's `/*` must not open a comment that swallows the declaration").toContain(
      "pub enum PreviewState { A }",
    );
    expect(out, "a real comment below it must still be blanked").not.toContain("later");
  });

  it("keeps a byte raw string whole rather than re-scanning it as an escaped string", () => {
    // `br"C:\"` ends at that quote — `\` is not an escape in a RAW literal. Read as one, the string
    // runs on and eats the comment after it, brace and all.
    const out = lexed('let p = br"C:\\"; // swallowed {\npub enum PreviewState { A }\n');
    expect(out).toContain("pub enum PreviewState { A }");
    expect(out, "the comment after a byte raw string must still be blanked").not.toContain(
      "swallowed",
    );
  });

  it("ends a raw string on a quote followed by its hash count, not on the first quote", () => {
    // RETITLED, because the previous name credited a distinction that does not exist: a body
    // containing `"#` is handled identically by `indexOf('"##')` and by a hand-rolled hash scan —
    // same predicate, same stop offset — so no mutant could separate them and the test could not
    // fail for the reason its name gave. What IS a real property is that the closing quote must
    // carry the hashes: terminate at the first bare quote and the literal ends inside its own body.
    // (`toContain("inside")` was also dropped — an early-terminated literal leaves ` inside` as
    // code, so it is present either way.)
    // The body needs BOTH properties, and dropping either one loses a mutant:
    //   * an ODD number of bare quotes — with an even count, terminating early re-lexes the
    //     remainder into something that happens to re-align, the comment is blanked anyway, and a
    //     different case catches the mutant instead;
    //   * a `"#` sequence — without one, a close that counts the WRONG number of hashes (`'"#'`
    //     instead of `'"##'`) still lands on the real terminator one hash short, leaves a stray `#`
    //     as code, and goes green. This is the whole "followed by its hash count" half of the title.
    // A previous fixture had the first without the second and pinned only half of its own name.
    const out = lexed('let s = r##"a "# b"##; // swallowed {\nlet t = "x";\n');
    expect(out, "a bare quote inside the body must not terminate an `r##` literal").not.toContain(
      "swallowed",
    );
  });

  it("handles more hashes than any fixed window", () => {
    // The body must contain a QUOTE for this to be observable: a prefix matcher with a fixed
    // lookahead window fails to match at 20 hashes, and then that inner quote opens a string that
    // runs past the comment. Without the inner quote every mis-lex still blanks the comment and the
    // test proves nothing — verified by mutation.
    const h = "#".repeat(20);
    const out = lexed(`let s = r${h}"a " b"${h}; // swallowed {\nlet t = "x";\n`);
    expect(out, "the prefix scan must not be bounded by a fixed window").not.toContain("swallowed");
  });

  it("treats a lone quote as a lifetime and a real char literal as a literal", () => {
    // ONE lifetime, then the comment — a lifetime read as a char literal consumes to the next quote
    // in the file, and the comment in between is what stops being blanked. (Two lifetimes on one
    // line make the mutant close on the second one and blank the comment anyway, which is how the
    // first draft of this assertion passed against the broken lexer.)
    const lt = lexed("fn f<'a>(s: &str) {}\n// swallowed {\nlet c = 'x';\n");
    expect(lt, "a lifetime must not open a char literal").not.toContain("swallowed");
    const chr = lexed("let c = '\"';\n// swallowed {\npub enum X { A }\n");
    expect(chr, "a quote INSIDE a char literal must not open a string").not.toContain("swallowed");
  });

  it("leaves comment-shaped text INSIDE a string alone", () => {
    // The other direction, and the only one that catches a lexer with no string tracking at all:
    // every case above still blanks its comment when strings are ignored, because the mis-lex
    // happens to close in time. This one does not — the text is only preserved if the scanner knows
    // it is inside a string.
    const out = lexed('let s = "keep /* this */ text";\npub enum X { A }\n');
    expect(out, "a comment inside a string literal is not a comment").toContain(
      "keep /* this */ text",
    );

    // …and an ESCAPED quote does not end the string early. Without escape handling the literal
    // closes at `\"` and the rest is lexed as code, so the comment-shaped tail gets blanked.
    const esc = lexed('let s = "a \\" /* still string */";\npub enum X { A }\n');
    expect(esc, "an escaped quote must not close the string").toContain("/* still string */");
  });

  it("blanks comments — including nested ones — to spaces, preserving line count", () => {
    const out = withoutRustComments("a /* x /* y */ z */ b\n// gone\nc\n");
    expect(out).toBe("a                   b\n       \nc\n");
    expect(out.split("\n")).toHaveLength(4);
    // The whole point of blanking rather than deleting: offsets and line numbers still line up.
    expect(out).not.toContain("x");
    expect(out).not.toContain("gone");
  });

  it("still blanks a comment that FOLLOWS a string on the same line", () => {
    // The mirror of every case above — a lexer that bails out of string tracking too eagerly would
    // keep the comment, and a brace in that comment moves the enum boundary.
    const code = 'let s = "x"; ';
    const comment = "// note {";
    expect(withoutRustComments(`${code}${comment}\n`)).toBe(`${code}${" ".repeat(comment.length)}\n`);
  });
});

describe("Rust's PreviewState and the TypeScript union name the same states", () => {
  it("has one member per variant, lowercased", () => {
    const rust = readFileSync(RUST_SOURCE, "utf8");
    const read = readEnum(rust, "PreviewState");
    // The two failure causes are reported separately: an absent declaration and an enum whose
    // braces never balance are different repairs, and diagnosing the second as the first sends the
    // reader looking for a declaration that is right there.
    expect(
      read.ok ? null : read.why,
      "preview.rs must still declare `pub enum PreviewState` with balanced braces",
    ).toBeNull();
    const { variants, unparsed } = read as { variants: string[]; unparsed: string[] };

    // ACCOUNT FOR EVERY ENTRY, because a permissive pattern is still a pattern. An entry the parser
    // cannot read is a variant this guard would compare the union against WITHOUT — the silent
    // direction, which is why it is named rather than counted.
    expect(
      unparsed,
      "every entry in the enum body must parse as a variant — one that does not is a variant this " +
        "guard would compare the union against WITHOUT",
    ).toEqual([]);

    const store = readFileSync(STORE, "utf8");
    const union = /export type PreviewState =([\s\S]*?);/.exec(store)?.[1];
    expect(union, "previewStore.ts must still declare `export type PreviewState`").toBeDefined();
    const members = [...union!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);

    expect(variants.length).toBeGreaterThan(3);
    expect(new Set(members)).toEqual(new Set(variants));
  });
});
