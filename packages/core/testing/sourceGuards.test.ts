// The unit that makes every source-scanning guard in this repo trustworthy.
//
// Read `sourceGuards.ts`'s header first: this file's whole reason for existing is that the guard it
// replaces was hand-rolled straight-line code INSIDE the test it was supposed to make trustworthy,
// so each of its three successive bugs could only be found by shipping it.
//
// THE REGRESSION THIS PINS is the last block: the OLD extraction (brace-match from the first `{`
// after the function NAME) is re-implemented here and driven against the same fixture, so the test
// asserts what it actually produced — a slice that IS the signature, non-empty, and therefore
// invisible to a `not.toBe("")` anchor. Delete that block and nothing here would notice the helper
// regressing back to it.

import { describe, expect, it } from "vitest";
import {
  BodyAnchorError,
  FunctionBodyExtractionError,
  assertBodyContains,
  extractTopLevelFunctionBody,
} from "./sourceGuards";

// ── FIXTURES ───────────────────────────────────────────────────────────────────────────────────

/**
 * THE MEASURED DEFECT, reduced. `interaction: Record<string, number> = {}` is a balanced brace pair
 * in the PARAMETER LIST that closes two characters after it opens, and it sits before the body. A
 * scanner that brace-matches from the first `{` after the name stops there and calls the SIGNATURE
 * the body.
 */
const OBJECT_DEFAULT_IN_PARAMS = `
import { thing } from "./thing"; // guard-ok — fixture text, not a real import

function composeRollup(
  agents: readonly Agent[],
  /** Injected clock — defaults to now. */
  now: number = Date.now(),
  interaction: Record<string, number> = {},
  thrashOf: (id: string) => Report | undefined = () => undefined,
) {
  const base = withNewAgentCalm(agents, now);
  const overlaid = withObservedAttention(base, interaction);
  return { published: overlaid, own: base };
}

function unrelated() {
  return withObservedAttention(null, {});
}
`;

/** An inline object RETURN TYPE — the trap one step past the parameter default. */
const INLINE_RETURN_TYPE = `
function shape(a: number, opts: Opts = {}): { published: Map; own: Map } {
  const deepInsideShape = a + 1;
  return { published: deepInsideShape, own: opts };
}
`;

/**
 * Prettier's formatting for a WIDE object return type puts its closing brace in COLUMN 0. "closes
 * at column 0" alone would therefore accept the return TYPE as the body; the close line reads
 * `} {`, which is what `closesItsLine` rejects.
 */
const MULTILINE_RETURN_TYPE = `
function wide(
  a: number,
): {
  published: StatusMap;
  own: StatusMap;
} {
  const deepInsideWide = a * 2;
  return { published: deepInsideWide, own: deepInsideWide };
}
`;

const ARROW_CONST = `
export const buildFeed = (rows: readonly Row[], opts: Opts = {}) => {
  const seen = new Set<string>();
  for (const r of rows) {
    if (!seen.has(r.id)) seen.add(r.id);
  }
  return { seen, deepInsideBuildFeed: opts };
};
`;

const CONST_FUNCTION_EXPRESSION = `
const legacyStyle = function (a: number, b: Record<string, number> = {}) {
  return deepInsideLegacyStyle(a, b);
};
`;

const ASYNC_FORMS = `
export async function fetchThings(url: string, init: RequestInit = {}) {
  const res = await fetch(url, init);
  return deepInsideFetchThings(res);
}

export const fetchMore = async (url: string, init: RequestInit = {}) => {
  return deepInsideFetchMore(url, init);
};
`;

/** Rust: `format!("… {}s …")` puts braces inside a STRING, and `'a` is a lifetime, not a quote. */
const RUST_FN = `
pub fn supervise<'a>(app: &'a App, claim: PortClaim) -> Result<(), String> {
    let started = Instant::now();
    // A comment with an unbalanced { and an apostrophe in the child's name.
    let msg = format!("bound after {}s on {}", started.elapsed().as_secs(), "port");
    if bound.is_none() {
        http_probe(&msg)?;
    }
    deep_inside_supervise(app, claim)
}

fn other() -> u8 {
    0
}
`;

const RUST_RAW_STRING = `
fn run_bd(project_path: &str) -> Result<BdOutput, String> {
    let pattern = r#"a lone { brace inside a raw string"#;
    run_cmd_bounded(&pattern, project_path, BD_TIMEOUT)
}
`;

const TEMPLATE_LITERAL = `
function render(rows: Row[], opts: Opts = {}) {
  const head = \`a lone { brace in a template\`;
  const each = rows.map((r) => \`\${r.id} — \${opts.label ?? "none"}\`);
  return deepInsideRender(head, each);
}
`;

// ── THE HELPER ─────────────────────────────────────────────────────────────────────────────────

describe("extractTopLevelFunctionBody", () => {
  it("skips an object default in the parameter list — the measured defect (sparkle-7uh1v5)", () => {
    const body = extractTopLevelFunctionBody(OBJECT_DEFAULT_IN_PARAMS, "composeRollup");
    // The body, not the signature.
    expect(body).toContain("withNewAgentCalm(agents, now)");
    expect(body).toContain("withObservedAttention(base, interaction)");
    // …and NOT the signature, which is where the broken slice stopped.
    expect(body).not.toContain("interaction: Record<string, number>");
    expect(body).not.toContain("Injected clock");
  });

  it("stops at the function's own close, not at a later function's call", () => {
    // The slice-to-EOF draft swallowed `unrelated()`'s call, so the body appeared to contain a call
    // it does not make. Two calls in the file, exactly one in the body.
    const body = extractTopLevelFunctionBody(OBJECT_DEFAULT_IN_PARAMS, "composeRollup");
    expect(body.match(/withObservedAttention\(/g) ?? []).toHaveLength(1);
    expect(body).not.toContain("function unrelated");
  });

  it("skips an inline object RETURN TYPE", () => {
    const body = extractTopLevelFunctionBody(INLINE_RETURN_TYPE, "shape");
    expect(body).toContain("deepInsideShape");
    expect(body).not.toContain("published: Map");
  });

  it("skips a MULTILINE return type whose own close sits in column 0", () => {
    const body = extractTopLevelFunctionBody(MULTILINE_RETURN_TYPE, "wide");
    expect(body).toContain("deepInsideWide");
    expect(body).not.toContain("published: StatusMap;");
  });

  it("keeps nested braces in the body and ends at the matching close", () => {
    const body = extractTopLevelFunctionBody(ARROW_CONST, "buildFeed");
    expect(body).toContain("if (!seen.has(r.id)) seen.add(r.id);");
    expect(body).toContain("deepInsideBuildFeed");
    // Balanced: every `{` in the returned slice has its `}`.
    expect(body.split("{").length).toBe(body.split("}").length);
  });

  it("handles an arrow-function const, a function expression, and both async forms", () => {
    expect(extractTopLevelFunctionBody(ARROW_CONST, "buildFeed")).toContain("deepInsideBuildFeed");
    expect(extractTopLevelFunctionBody(CONST_FUNCTION_EXPRESSION, "legacyStyle")).toContain(
      "deepInsideLegacyStyle",
    );
    expect(extractTopLevelFunctionBody(ASYNC_FORMS, "fetchThings")).toContain(
      "deepInsideFetchThings",
    );
    expect(extractTopLevelFunctionBody(ASYNC_FORMS, "fetchMore")).toContain("deepInsideFetchMore");
  });

  it("reads a Rust fn: braces in a `format!` string and a lifetime are not structure", () => {
    const body = extractTopLevelFunctionBody(RUST_FN, "supervise");
    expect(body).toContain("deep_inside_supervise(app, claim)");
    expect(body).toContain("if bound.is_none() {");
    expect(body).not.toContain("fn other()");
    expect(body).not.toContain("PortClaim)"); // the signature is not in the slice
  });

  it("reads a Rust raw string holding a lone brace", () => {
    const body = extractTopLevelFunctionBody(RUST_RAW_STRING, "run_bd");
    expect(body).toContain("run_cmd_bounded(");
  });

  it("reads a template literal holding a lone brace and an interpolation", () => {
    const body = extractTopLevelFunctionBody(TEMPLATE_LITERAL, "render");
    expect(body).toContain("deepInsideRender(head, each)");
  });

  it("returns the body EXCLUSIVE of its outer braces, so a signature can never be in it", () => {
    const body = extractTopLevelFunctionBody(INLINE_RETURN_TYPE, "shape");
    expect(body.trimStart().startsWith("const")).toBe(true);
    expect(body.trimEnd().endsWith(";")).toBe(true);
    expect(body).not.toContain("function shape");
  });
});

describe("extractTopLevelFunctionBody THROWS rather than returning an empty slice", () => {
  // An empty return is how this vacuity class survives: every downstream `!== ""` anchor passes on
  // it. Each case below asserts the THROW and that the message names what went wrong.
  it("throws when the name does not exist", () => {
    expect(() => extractTopLevelFunctionBody(OBJECT_DEFAULT_IN_PARAMS, "notThere")).toThrow(
      FunctionBodyExtractionError,
    );
    expect(() => extractTopLevelFunctionBody(OBJECT_DEFAULT_IN_PARAMS, "notThere")).toThrow(
      /no top-level \(column 0\) declaration/,
    );
  });

  it("throws on an INDENTED declaration — a nested function is not top level", () => {
    const nested = `
class Thing {
  compose(a: number = 1) {
    return a;
  }
}
`;
    expect(() => extractTopLevelFunctionBody(nested, "compose")).toThrow(
      FunctionBodyExtractionError,
    );
  });

  it("throws when the braces never balance", () => {
    const broken = `
function halfWritten(a: number = 1) {
  if (a) {
    return a;
`;
    expect(() => extractTopLevelFunctionBody(broken, "halfWritten")).toThrow(
      /braces never balance/,
    );
  });

  it("throws when the close is not in column 0 on a line of its own", () => {
    // One-liner: the close is mid-line, so nothing anchors the slice.
    const oneLiner = `const inline = (a: number) => { return a; };\n`;
    expect(() => extractTopLevelFunctionBody(oneLiner, "inline")).toThrow(
      /no candidate brace after the parameter list closes in COLUMN 0/,
    );
  });

  it("NEVER walks into the NEXT function's body when its own is rejected (roborev 74090)", () => {
    // THE WORST FAILURE THIS MODULE CAN HAVE, and it is worse than the empty slice it replaced: a
    // wrong-but-plausible body is non-empty, so a `not.toBe("")` anchor passes on it AND an
    // unrelated `toContain` can pass too. `target`'s body is written on ONE line, so its close is
    // mid-line and rightly rejected — and Rust puts no `;` after a `fn`, so the `;` stop cannot
    // see it. Unbounded, the walk finds `other`'s brace, whose close IS in column 0 on a line of
    // its own, and hands back `other`'s body at exit 0.
    const oneLineThenSibling = `
fn target(a: u8) -> u8 { a }

fn other() -> u8 {
    99
}
`;
    expect(() => extractTopLevelFunctionBody(oneLineThenSibling, "target")).toThrow(
      FunctionBodyExtractionError,
    );
    // Named explicitly: a regression here would return "\n    99\n", never "".
    let caught = "";
    try {
      caught = extractTopLevelFunctionBody(oneLineThenSibling, "target");
    } catch (e) {
      caught = `THREW: ${(e as Error).message}`;
    }
    expect(caught).not.toContain("99");
    expect(caught).toContain("THREW:");

    // The TS half of the same shape: `} as const;` fails the "closes its line" rule, so the real
    // body is rejected and the walk would otherwise continue into `next`.
    const asConstThenSibling = `
const target = (a: number) => {
  return a;
} as const;

function next() {
  return 99;
}
`;
    expect(() => extractTopLevelFunctionBody(asConstThenSibling, "target")).toThrow(
      FunctionBodyExtractionError,
    );
  });

  it("throws on a name that is an object literal, not a function", () => {
    const obj = `
export const CONTROL_OP_TIERS: Record<string, string> = {
  get_state: "free",
};
`;
    expect(() => extractTopLevelFunctionBody(obj, "CONTROL_OP_TIERS")).toThrow(
      /not a function/,
    );
  });

  it("throws on a bodiless declaration (an overload signature)", () => {
    const overload = `
export function pick(a: number): number;
`;
    expect(() => extractTopLevelFunctionBody(overload, "pick")).toThrow(/no body/);
  });

  it("throws when two top-level declarations share the name — an ambiguous slice", () => {
    const twice = `
fn run_bd(a: u8) -> u8 {
    a
}

fn run_bd(a: u8, b: u8) -> u8 {
    a + b
}
`;
    expect(() => extractTopLevelFunctionBody(twice, "run_bd")).toThrow(
      /2 top-level declarations/,
    );
  });

  it("throws on an empty function name", () => {
    expect(() => extractTopLevelFunctionBody(OBJECT_DEFAULT_IN_PARAMS, "")).toThrow(
      /the function name is empty/,
    );
  });
});

// ── THE ANTI-VACUITY ANCHOR ────────────────────────────────────────────────────────────────────

describe("assertBodyContains", () => {
  it("passes when the marker is deep in the body", () => {
    const body = extractTopLevelFunctionBody(OBJECT_DEFAULT_IN_PARAMS, "composeRollup");
    expect(() => assertBodyContains(body, "withObservedAttention(", "composeRollup")).not.toThrow();
    expect(() =>
      assertBodyContains(body, ["withObservedAttention(", "withNewAgentCalm("], "composeRollup"),
    ).not.toThrow();
  });

  it("fails with a message naming the FUNCTION, the MISSING MARKER and the RULE", () => {
    let err: unknown;
    try {
      assertBodyContains("const a = 1;", "withObservedAttention(", "composeRollup");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BodyAnchorError);
    const message = (err as Error).message;
    expect(message).toContain("composeRollup");
    expect(message).toContain("withObservedAttention(");
    expect(message).toContain("deep-body anchor");
    // The rule's name and its REASON — a failure message is the one surface guaranteed to be read
    // at the moment of violation, so it spends that surface on why, not just on what.
    expect(message).toContain("sparkle-7uh1v5");
    expect(message).toContain("vacuous");
    expect(message).toContain("Do NOT weaken the anchor");
  });

  it("refuses an EMPTY marker — every string contains it, including a signature-only slice", () => {
    expect(() => assertBodyContains("anything", "", "composeRollup")).toThrow(BodyAnchorError);
    expect(() => assertBodyContains("anything", "   ", "composeRollup")).toThrow(/empty marker/);
    expect(() => assertBodyContains("anything", [], "composeRollup")).toThrow(/no markers given/);
  });

  it("is wired into the extractor as an option, so the strong anchor is the SHORT form", () => {
    expect(() =>
      extractTopLevelFunctionBody(OBJECT_DEFAULT_IN_PARAMS, "composeRollup", {
        anchors: ["withObservedAttention("],
      }),
    ).not.toThrow();
    expect(() =>
      extractTopLevelFunctionBody(OBJECT_DEFAULT_IN_PARAMS, "composeRollup", {
        anchors: ["notInTheBody("],
      }),
    ).toThrow(BodyAnchorError);
  });
});

// ── THE REGRESSION ─────────────────────────────────────────────────────────────────────────────

/**
 * THE OLD, BROKEN EXTRACTION, re-implemented verbatim: anchor on the declaration, then brace-match
 * from the first `{` after the function NAME and slice from the declaration to that brace's match.
 * Kept here and nowhere else, so what it actually produced is ASSERTED rather than described.
 */
function legacyFirstBraceAfterName(source: string, name: string): string {
  const at = source.indexOf(`function ${name}(`);
  if (at === -1) return "";
  const open = source.indexOf("{", at);
  if (open === -1) return "";
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(at, i + 1);
    }
  }
  return "";
}

describe("the regression this unit exists to pin", () => {
  it("the OLD extraction produced the SIGNATURE — non-empty, so every `not.toBe('')` passed", () => {
    const legacy = legacyFirstBraceAfterName(OBJECT_DEFAULT_IN_PARAMS, "composeRollup");

    // 1. It was non-empty — the whole reason the old `not.toBe("")` anchor was blind to this.
    expect(legacy).not.toBe("");
    expect(legacy.length).toBeGreaterThan(100);
    // 2. …because it stopped on the empty-object DEFAULT in the parameter list, so what it
    //    returned was the SIGNATURE and nothing else.
    expect(legacy).toContain("function composeRollup(");
    expect(legacy).toContain("interaction: Record<string, number> = {}");
    expect(legacy.trimEnd().endsWith("= {}")).toBe(true);
    // 3. It contained NONE of the code the guard claimed to be searching, so the guard's real
    //    assertion — "this call is not in the body" — could never fail.
    expect(legacy).not.toContain("withObservedAttention(");
    expect(legacy.match(/withObservedAttention\(/g) ?? []).toHaveLength(0);
  });

  it("the helper gets it right, and the deep-body anchor is what tells the two apart", () => {
    const body = extractTopLevelFunctionBody(OBJECT_DEFAULT_IN_PARAMS, "composeRollup");
    expect(body).toContain("withObservedAttention(");

    // The anchor PASSES on the real body and FAILS on the legacy slice. A `not.toBe("")` check
    // passes on both, which is exactly why it is not an anchor.
    expect(() => assertBodyContains(body, "withObservedAttention(", "composeRollup")).not.toThrow();
    const legacy = legacyFirstBraceAfterName(OBJECT_DEFAULT_IN_PARAMS, "composeRollup");
    expect(legacy).not.toBe("");
    expect(() =>
      assertBodyContains(legacy, "withObservedAttention(", "composeRollup"),
    ).toThrow(BodyAnchorError);
  });
});
