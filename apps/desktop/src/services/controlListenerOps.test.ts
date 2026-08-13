// EVERY OP THE FRONTEND HANDLES MUST BE ON THE RUST ALLOWLIST — the general pin, not a per-op one.
//
// WHY THIS FILE EXISTS (roborev 63072). `handle_control_request_line` rejects any op outside
// `CONTROL_OPS` with `unknown op` BEFORE the request reaches the frontend, so a handler added to
// `controlListener`'s `switch (req.op)` without a matching allowlist entry is DEAD IN PRODUCTION
// while every suite stays green — the desktop tests hand the payload straight to `dispatch`, and the
// mcp-control tests mock `Bridge`, so neither side crosses the socket. That has now happened TWICE:
// `concierge_tool` (roborev 54241) and then the entire twelve-tool Chief surface, which shipped
// inert with 186 + 250 tests passing. Each time the repair was another op-specific transport test,
// and each time the next op walked into the same hole because nothing checked the CLASS.
//
// WHY IT IS ON THIS SIDE OF THE WIRE. The obvious Rust-side generalization is vacuous: iterating
// `CONTROL_OPS` and asserting each is not "unknown op" is a tautology over the same array the check
// reads. The `control_all_ops_are_allowlisted` ratchet in bridge.rs is a count, so it fires when
// `CONTROL_OPS` CHANGES — never on an omission, which is the direction that hurts. The fact nothing
// held was that the two lists are written in different languages with no shared type. So: parse both
// and compare. Same technique as `goalContinuation.test.ts` and the CONTROL_KEYS pins — parse,
// don't import, because importing Rust is the thing that cannot be done.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The string literals of `const CONTROL_OPS: &[&str] = &[ … ];` in the Rust bridge. */
function controlOps(): string[] {
  const source = readFileSync(
    fileURLToPath(new URL("../../src-tauri/src/bridge.rs", import.meta.url)),
    "utf8",
  );
  const start = source.indexOf("const CONTROL_OPS: &[&str] = &[");
  if (start < 0) throw new Error("could not find CONTROL_OPS in bridge.rs — was it renamed?");
  const end = source.indexOf("];", start);
  if (end < 0) throw new Error("unterminated CONTROL_OPS literal");
  const ops = [...source.slice(start, end).matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
  // A parse that silently found nothing would make every assertion below vacuous — the exact
  // failure shape this file exists to catch, reproduced in the file that catches it.
  if (ops.length < 5) throw new Error(`CONTROL_OPS parse found only ${ops.length} ops`);
  return ops;
}

/**
 * The op names `controlListener.dispatch` actually handles.
 *
 * Read out of the ONE `switch (req.op)` in that file. Both spellings are collected because the
 * switch mixes them: most arms are string literals (`case "get_state":`) while Chief's is a
 * constant (`case CHIEF_TOOL_OP:`) — and a reader that understood only literals would have skipped
 * precisely the op whose omission caused the outage this test is named for.
 */
function handledOps(): string[] {
  const source = readFileSync(
    fileURLToPath(new URL("./controlListener.ts", import.meta.url)),
    "utf8",
  );
  const start = source.indexOf("switch (req.op) {");
  if (start < 0) throw new Error("could not find the op switch in controlListener.ts");
  const end = source.indexOf("\n    }", start);
  if (end < 0) throw new Error("unterminated op switch");
  const body = source.slice(start, end);

  // TRUNCATION CHECK. The end is located by the first 4-space-indented `}`, which a future
  // block-bodied arm or a wrapped expression would trip — silently dropping every case after it.
  // The switch's own `default:` arm is the last thing in it, so its presence proves we read to the
  // bottom (roborev 63142).
  if (!body.includes("default:")) {
    throw new Error("op-switch parse truncated before `default:` — the slice ended early");
  }

  // STRICT, NOT BEST-EFFORT, and this is the whole point of the file. A parser that skips an arm it
  // does not recognise fails in the SAME direction as the bug it exists to catch: the op is simply
  // absent from the comparison, the diff comes back empty, and the class-level guard is green while
  // the op is dead in production. So every `case` is matched generically and an unresolvable
  // discriminant is an ERROR rather than an omission — a digit in the name (`set_config_v2`) or a
  // single-quoted literal used to vanish here.
  const arms = [...body.matchAll(/\bcase\s+([^:\n]+):/g)].map((m) => m[1]!.trim());
  const ops = arms.map((arm) => {
    const literal = /^["']([a-z0-9_]+)["']$/.exec(arm);
    if (literal) return literal[1]!;
    // A `case SOME_CONSTANT:` arm — resolve the constant to its literal from the same file.
    if (/^[A-Z][A-Z0-9_]*$/.test(arm)) {
      const decl = new RegExp(`export const ${arm}\\s*=\\s*["']([a-z0-9_]+)["']`).exec(source);
      if (!decl) throw new Error(`case ${arm}: is not a string constant declared in this file`);
      return decl[1]!;
    }
    throw new Error(
      `could not resolve the op name for \`case ${arm}:\` — teach this parser that form rather ` +
        `than letting the arm be skipped, which would hide exactly the drift this test checks`,
    );
  });

  // Tied to what was actually found rather than to a fixed floor: a hard-coded `>= 19` equals
  // today's count, so once the surface grows a parser that finds 20 of 25 stays green.
  if (ops.length !== arms.length) {
    throw new Error(`resolved ${ops.length} ops from ${arms.length} case arms`);
  }
  if (new Set(ops).size !== ops.length) {
    throw new Error(`the op switch has duplicate cases: ${ops.join(", ")}`);
  }
  if (ops.length < 10) throw new Error(`op-switch parse found only ${ops.length} cases`);
  return ops;
}

/** The op names `CONTROL_OP_TIERS` in controlListener.ts assigns a tier to. */
function tieredOps(): string[] {
  const source = readFileSync(
    fileURLToPath(new URL("./controlListener.ts", import.meta.url)),
    "utf8",
  );
  const start = source.indexOf('const CONTROL_OP_TIERS: Record<ControlOp, "free" | "privileged"> = {');
  if (start < 0) throw new Error("could not find CONTROL_OP_TIERS — was it renamed?");
  const end = source.indexOf("\n};", start);
  if (end < 0) throw new Error("unterminated CONTROL_OP_TIERS literal");
  const ops = [...source.slice(start, end).matchAll(/^\s{2}([a-z0-9_]+):\s*"(?:free|privileged)"/gm)].map(
    (m) => m[1]!,
  );
  if (ops.length < 10) throw new Error(`CONTROL_OP_TIERS parse found only ${ops.length} entries`);
  return ops;
}

describe("the control-op allowlist and the frontend dispatcher agree", () => {
  // THE ASSERTION THAT WOULD HAVE CAUGHT BOTH OUTAGES. Not "chief_tool is allowlisted" — that is
  // the per-op test we already wrote twice. This one goes red for an op nobody has thought of yet.
  it("every op the dispatcher handles is on the Rust allowlist", () => {
    const allowed = new Set(controlOps());
    const missing = handledOps().filter((op) => !allowed.has(op));
    expect(
      missing,
      `these ops have a handler in controlListener.ts but are NOT in CONTROL_OPS in bridge.rs, so ` +
        `every call to them dies at "unknown op" before the frontend is reached: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  // THE THIRD LIST (roborev 63142). Reaching the allowlist is not enough: `dispatch` also reads
  // `CONTROL_OP_TIERS[req.op as ControlOp]`, and because that cast defeats the Record's
  // exhaustiveness, an op named outside the `ControlOp` union evaluated to `undefined` — so the
  // `=== "privileged"` test was false and `callerMayAdminister` was skipped by OMISSION rather than
  // by decision. `chief_tool` was in exactly that state. A guard that pins one of the three lists an
  // op must reach is not a class-level guard.
  it("every op the dispatcher handles has an explicit privilege tier", () => {
    const tiered = new Set(tieredOps());
    const missing = handledOps().filter((op) => !tiered.has(op));
    expect(
      missing,
      `these ops have a handler but no CONTROL_OP_TIERS entry, so their privilege tier is an ` +
        `accident rather than a decision: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  // The parsers are the load-bearing part of the checks above, and a parser that quietly matched
  // nothing — or matched only some — would make them pass forever. Both counts are tied to the
  // SURFACE rather than to a fixed floor: a hard-coded `>= 19` equals today's count exactly, so a
  // parser that found 20 of a future 25 would stay green.
  it("reads all three lists whole, so the checks above are not vacuous", () => {
    const handled = handledOps();
    // Every op with a handler is allowlisted AND tiered, so all three lists agree on their size at
    // minimum — a parser that dropped arms would break this before it silently weakened the checks.
    expect(new Set(controlOps()).size).toBeGreaterThanOrEqual(handled.length);
    expect(new Set(tieredOps()).size).toBeGreaterThanOrEqual(handled.length);
    // The constant-resolving arm specifically — the one a literals-only parser would have skipped,
    // and the op whose omission took the whole Chief surface down.
    expect(handled).toContain("chief_tool");
    expect(controlOps()).toContain("chief_tool");
    expect(tieredOps()).toContain("chief_tool");
  });

  // The parser must FAIL on an arm it cannot resolve, not skip it — that is the difference between
  // this file and the two op-specific tests it replaces. Asserted directly, because "it throws"
  // cannot be observed from the passing path.
  it("refuses to parse a case arm it does not understand", () => {
    const resolve = (arm: string) => {
      if (/^["']([a-z0-9_]+)["']$/.test(arm)) return arm.slice(1, -1);
      if (/^[A-Z][A-Z0-9_]*$/.test(arm)) return arm;
      throw new Error(`could not resolve the op name for \`case ${arm}:\``);
    };
    // The forms the real parser accepts, including the two that used to vanish silently.
    expect(resolve('"set_config"')).toBe("set_config");
    expect(resolve("'set_config'")).toBe("set_config");
    expect(resolve('"set_config_v2"')).toBe("set_config_v2");
    // …and a computed discriminant is an error rather than an omission.
    expect(() => resolve("OPS.chief")).toThrow(/could not resolve/);
  });

  // THE OTHER DIRECTION IS DELIBERATELY NOT ASSERTED, and the omission is the point rather than an
  // oversight: `CONTROL_OPS` may legitimately name an op the Rust side answers itself, so an
  // allowlisted op with no frontend `case` is a valid state, not a bug. A test for it would have to
  // pass unconditionally — and a test that cannot fail is worse than no test, because it reads as
  // coverage. Only the direction above breaks anything.
});
