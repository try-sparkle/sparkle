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
 * String literals are NOT modelled: a `//` inside a Rust string would blank the rest of that line.
 * The only strings in an enum body are attribute values (`#[serde(rename = "…")]`), and the failure
 * direction is a line that stops parsing — loud, not silent.
 */
function withoutRustComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
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
