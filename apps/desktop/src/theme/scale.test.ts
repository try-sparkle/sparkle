// A RATCHET, not a snapshot. It counts inline `fontSize:`/`borderRadius:` literals that are not on
// the scale and asserts the count has not GROWN. Adding an off-scale value fails; removing one
// passes and is expected to be followed by lowering the ceiling here in the same commit.
//
// Why a ratchet rather than a hard ban: there are ~250 off-scale values today, and migrating them
// is a visual decision that needs eyes on the running app (scale.ts explains why at length). A hard
// ban would have to be introduced together with a 500-site sweep nobody could review; a ratchet
// lands now, stops the bleeding immediately, and lets the migration arrive in pieces.
//
// It reads the SOURCE rather than rendered styles on purpose. These are inline style objects spread
// across hundreds of components with no shared render path, so there is no runtime seam to inspect
// — and the thing being guarded is what the next person TYPES.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ALLOWED_RADIUS, ALLOWED_TYPE, PILL, RADIUS, SPACE, TYPE } from "./scale";

// fileURLToPath, NOT `.pathname` — this repo's worktrees live under "Application Support", so the
// URL form is percent-encoded and `.pathname` hands back a directory that does not exist.
const SRC = fileURLToPath(new URL("..", import.meta.url));

// BOTH .ts AND .tsx (roborev 54238). Scanning only .tsx left a hole that ran the wrong way: style
// constants live in plain .ts too (components/appChrome.ts already carries `borderRadius: 5` and
// `fontSize: 12.5`), so hoisting a literal out of a component into a helper LOWERED the count
// without removing a single violation. A ratchet you can satisfy by moving code is not a ratchet.
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (/\.tsx?$/.test(name) && !name.includes(".test.")) out.push(p);
  }
  return out;
}

/**
 * Every numeric value assigned to `<prop>`, however it is written.
 *
 * The first cut matched `prop:\s*(\d+)` and only saw bare literals, exempting the routine
 * spellings: quoted shorthand (`borderRadius: "9px 9px 0 0"`) and ternaries
 * (`fontSize: compact ? 10 : 11` — a `? 14 : 18` passed unnoticed). So instead of matching the
 * literal, this takes the whole VALUE EXPRESSION and pulls every number out of it. A ternary
 * contributes both branches; a four-value shorthand contributes four. `TYPE.body` contributes
 * nothing, which is the point: using the scale is how you leave the count.
 *
 * Three refinements, each closing a way the count could be wrong (roborev 54246):
 *
 * 1. IT DOES NOT STOP AT A NEWLINE. It did, which exempted every WRAPPED value expression — and
 *    this codebase already wraps ternaries in style objects, so `fontSize: someLongCondition\n ?
 *    14\n : 18` contributed zero. That is the exact hole the rewrite claimed to have closed. It
 *    now stops only at a depth-0 `,` / `;` / closing bracket, which are the real terminators.
 *
 * 2. PERCENTAGES ARE NOT PX. `borderRadius: "50%"` is the idiomatic circle — the same "fully
 *    round" shape `PILL` and `0` are exempted for — and counting it made 17 of 77 radius
 *    "violations" noise. Worse, it put `50` on the published migration list as if it were a px
 *    value to swap for `PILL`, and that swap is NOT a no-op: on a non-square box `50%` is an
 *    ellipse and `999px` is a capsule. Acting on the list would have changed rendering.
 *
 * 3. SINGLE-FILE `const NAME = <number>` BINDINGS ARE RESOLVED. Hoisting into a .ts file was
 *    closed, but hoisting into a named constant was not: `const S = 12.5; … fontSize: S` counted
 *    zero. With exact-equality the count DROPPING is now visible progress, so that was a rewarded
 *    escape hatch. A bare identifier is looked up in its own file and contributes its value.
 */
function offScale(prop: string, allowed: readonly number[]): { file: string; value: number }[] {
  const hits: { file: string; value: number }[] = [];
  for (const file of sourceFiles(SRC)) {
    const src = readFileSync(file, "utf8");
    // module-level numeric constants in THIS file, so `fontSize: BASE` resolves to its value
    const consts = new Map<string, number>();
    for (const c of src.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*(?::\s*number\s*)?=\s*(\d+(?:\.\d+)?)\s*[;\n]/g)) {
      consts.set(c[1]!, Number(c[2]));
    }
    for (const m of src.matchAll(new RegExp(`\\b${prop}:`, "g"))) {
      const start = m.index! + m[0].length;
      let depth = 0, end = start;
      for (; end < src.length; end++) {
        const c = src[end]!;
        if ("([{".includes(c)) depth++;
        else if (")]}".includes(c)) { if (depth === 0) break; depth--; }
        else if ((c === "," || c === ";") && depth === 0) break;
      }
      const expr = src.slice(start, end);
      const push = (value: number) => {
        if (!allowed.includes(value)) hits.push({ file: file.slice(SRC.length), value });
      };
      // numbers, skipping any immediately followed by `%` (a shape, not a step)
      for (const n of expr.matchAll(/(\d+(?:\.\d+)?)(%?)/g)) {
        if (n[2] === "%") continue;
        push(Number(n[1]));
      }
      // a bare identifier standing alone as the value — resolve it to its constant
      const bare = expr.trim().match(/^([A-Za-z_$][\w$]*)$/);
      if (bare && consts.has(bare[1]!)) push(consts.get(bare[1]!)!);
    }
  }
  return hits;
}

// ── THE COUNTS ─────────────────────────────────────────────────────────────────────────────────
// The EXACT number of off-scale values today. Not a budget — see the equality note below. Lower
// them as you migrate; the test tells you the number to write.
//
// The distinct values still out there, for whoever migrates them:
//   fontSize     9  9.5  10.5  11.5  12.5  13.5  14  15  17  17.5  18  19  20  24  28  34  42
//   borderRadius 1  2  3  5  7  9  10  14  15  16  26
//
// The FRACTIONAL font sizes are the tell that this drifted rather than being designed: 12.5 and
// 13.5 appear ~43 times between them, hand-typed in modal body copy, and no scale produces those.
//
// BOTH DIRECTIONS HAVE ALREADY HAPPENED, and each move was the scanner getting more honest rather
// than the code changing. Radius went 53 → 77 when quoted shorthand and `.ts` files stopped being
// exempt (roborev 54238), then 77 → 60 when `50%` stopped being counted as a px step (54246) —
// `"50%"` is the idiomatic circle, the same shape `PILL` and `0` are exempt for, and listing `50`
// as a value to migrate would have sent someone swapping ellipses for capsules.
const MAX_OFF_SCALE_TYPE = 139;
const MAX_OFF_SCALE_RADIUS = 60;

// EXACT, not `<=` (roborev 54238). The file told the next person to lower the ceiling when they
// migrated, and then used a bound that cannot tell whether they did: remove twenty literals without
// touching the constant and the ratchet silently carries twenty units of budget for fresh sprawl,
// green the whole time. It also made violations fungible — delete a component, earn room to be
// careless somewhere else. Equality means the count and the constant move together or CI says so.
describe("the type and radius scales are a ratchet", () => {
  it("the off-scale fontSize count is EXACTLY the recorded ceiling", () => {
    const hits = offScale("fontSize", ALLOWED_TYPE);
    const byValue = [...new Set(hits.map((h) => h.value))].sort((a, b) => a - b);
    expect(
      hits.length,
      `${hits.length} off-scale fontSize values (${byValue.join(", ")}) vs recorded ${MAX_OFF_SCALE_TYPE}. ` +
        `HIGHER: you added one — use TYPE. LOWER: you migrated some — set the constant to ${hits.length}.`,
    ).toBe(MAX_OFF_SCALE_TYPE);
  });

  it("the off-scale borderRadius count is EXACTLY the recorded ceiling", () => {
    const hits = offScale("borderRadius", ALLOWED_RADIUS);
    const byValue = [...new Set(hits.map((h) => h.value))].sort((a, b) => a - b);
    expect(
      hits.length,
      `${hits.length} off-scale borderRadius values (${byValue.join(", ")}) vs recorded ${MAX_OFF_SCALE_RADIUS}. ` +
        `HIGHER: you added one — use RADIUS/PILL. LOWER: you migrated some — set the constant to ${hits.length}.`,
    ).toBe(MAX_OFF_SCALE_RADIUS);
  });

  // The scales have to stay scales. Duplicated values, or steps that collapse into each other, are
  // how twenty-three font sizes happened in the first place.
  it("every step is distinct and ordered", () => {
    for (const [name, steps] of [["TYPE", Object.values(TYPE)], ["RADIUS", Object.values(RADIUS)], ["SPACE", Object.values(SPACE)]] as const) {
      expect(new Set(steps).size, `${name} has duplicate steps`).toBe(steps.length);
      expect(steps, `${name} is not ascending`).toEqual([...steps].sort((a, b) => a - b));
    }
    // PILL is "fully round", not a step — keeping it out of RADIUS is what stops it being reached
    // for as "the biggest corner".
    expect(Object.values(RADIUS)).not.toContain(PILL);
  });

  it("nothing is smaller than the legibility floor", () => {
    expect(Math.min(...Object.values(TYPE))).toBeGreaterThanOrEqual(10);
  });
});
