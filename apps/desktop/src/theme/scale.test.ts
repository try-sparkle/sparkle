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
import { type OffScaleRemedy, offScaleMessage } from "./scaleGuardTestUtils";

// ── THE FAILURE MESSAGE IS THE DOCUMENTATION (bead sparkle-qw9y62) ─────────────────────────────
// Nothing else in an agent's loop mentions these ratchets, and the neighbouring files are full of
// the raw numbers they forbid — so the first time anyone learns the rule is when it fires. A
// message naming only the token FAMILY ("use TYPE") leaves three lookups on the reader: which
// module, what the relative path is from the file they are standing in, and which step to pick.
// These remedies spend that surface on the literal import line instead, computed per offending
// file. The steps are derived from the real scales, so a step added or renamed cannot leave a
// stale list in the one place people read.
const TYPE_REMEDY: OffScaleRemedy = {
  named: "TYPE",
  module: "theme/scale",
  use: "TYPE.body",
  steps: Object.entries(TYPE)
    .map(([k, v]) => `TYPE.${k}=${v}`)
    .join(" "),
};

const RADIUS_REMEDY: OffScaleRemedy = {
  named: "RADIUS, PILL",
  module: "theme/scale",
  use: "RADIUS.input",
  steps: [
    ...Object.entries(RADIUS).map(([k, v]) => `RADIUS.${k}=${v}`),
    `PILL=${PILL} (a capsule/circle, not a step)`,
  ].join(" "),
};

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
  for (const file of scannedSourceFiles()) {
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
//
// ── 139 → 140 AND 60 → 61: WHY THIS IS A ONE-DIRECTIONAL RATCHET NOW ───────────────────────────
// This ratchet shipped as EXACT equality and it cost a release. It recorded 139/60, then landed on a
// `main` that had reached 140/61; and the v0.55.0 release commit (1a21f95dd) carried a constant of
// 140/61 while reality was 139/60. Under `===`, reality-BELOW-the-ceiling is just as red as
// reality-above it: a concurrent merge, or a migration that removed a value, flips green to a
// fleet-wide red on a test the merging branch never touched. That red tagged v0.55.0 — a DMG built
// from a commit its own suite rejects.
//
// So the gate is `<=`, not `===`: it fails ONLY when the count RISES above the recorded ceiling
// (someone added off-scale sprawl) and tolerates a count at or below it (a migration, or a concurrent
// merge that lowered reality). An improvement can never red the fleet.
//
// The `===` note below argued the opposite, and its point is real — a `<=` bound can sit ABOVE
// reality and silently carry budget for fresh sprawl. The answer is to keep the ceiling TIGHT: when
// you migrate values away, lower the constant to the new count in the SAME PR (auto-record the drop).
// The count and the constant still move together on the way DOWN; `<=` only removes the fleet-red for
// the window where they briefly disagree. A branch holding a stale-high ceiling should re-take it
// before merging, the way a lockfile gets refreshed.
const MAX_OFF_SCALE_TYPE = 0;
const MAX_OFF_SCALE_RADIUS = 0;

// `<=`, not EXACT (supersedes roborev 54238). The original intent — force a migration to update the
// constant — is preserved on the way DOWN by convention (lower the ceiling in the migrating PR), but
// the GATE no longer reds when reality dips below the ceiling, because that "failure" was almost
// always a concurrent merge or an improvement, not new sprawl. New sprawl (count RISES above the
// ceiling) still fails loudly and is the only thing this gate blocks on.
describe("the type and radius scales are a ratchet", () => {
  it("the off-scale fontSize count never rises above the recorded ceiling", () => {
    const hits = offScale("fontSize", ALLOWED_TYPE);
    expect(
      hits.length,
      offScaleMessage("fontSize", "use TYPE", hits, MAX_OFF_SCALE_TYPE, TYPE_REMEDY),
    ).toBeLessThanOrEqual(MAX_OFF_SCALE_TYPE);
  });

  it("the off-scale borderRadius count never rises above the recorded ceiling", () => {
    const hits = offScale("borderRadius", ALLOWED_RADIUS);
    expect(
      hits.length,
      offScaleMessage("borderRadius", "use RADIUS/PILL", hits, MAX_OFF_SCALE_RADIUS, RADIUS_REMEDY),
    ).toBeLessThanOrEqual(MAX_OFF_SCALE_RADIUS);
  });

  // The scales have to stay scales. Duplicated values, or steps that collapse into each other, are
  // how twenty-three font sizes happened in the first place.
  it("every step is distinct and ordered", () => {
    // ALIASES ARE ALLOWED, COLLISIONS ARE NOT — and for RADIUS the spec ships one deliberately:
    // `--r-input` and `--r-bubble` are both 4px. Two names for one value is a call-site vocabulary,
    // not sprawl; what would be sprawl is a value nothing names. So the assertion is on the SET
    // being ordered, not on every key being unique.
    for (const [name, steps] of [["TYPE", Object.values(TYPE)], ["RADIUS", Object.values(RADIUS)], ["SPACE", Object.values(SPACE)]] as const) {
      const distinct = [...new Set(steps)];
      expect(distinct, `${name} is not ascending`).toEqual([...distinct].sort((a, b) => a - b));
      expect(distinct.length, `${name} collapsed to a single step`).toBeGreaterThan(1);
    }
    // PILL is "fully round", not a step — keeping it out of RADIUS is what stops it being reached
    // for as "the biggest corner".
    expect(Object.values(RADIUS)).not.toContain(PILL);
  });

  it("nothing is smaller than the legibility floor", () => {
    expect(Math.min(...Object.values(TYPE))).toBeGreaterThanOrEqual(10);
  });
});

// The ratchet assertions run against the real source tree and so cannot be forced red on demand,
// which is exactly why the failure message was allowed to drop the file locations for so long. These
// tests exercise the message builder directly on synthetic hits, so they DO go red if it stops
// naming the files — the gap this change closes. (Run /mutation-check on scaleGuard.ts to confirm.)
describe("offScaleMessage names the files each off-scale value came from", () => {
  it("lists every value alongside the file(s) it was found in, plus the ceiling and total", () => {
    const hits = [
      { file: "components/appChrome.ts", value: 12.5 },
      { file: "components/modal.tsx", value: 12.5 },
      { file: "components/badge.tsx", value: 17 },
    ];
    const msg = offScaleMessage("fontSize", "use TYPE", hits, 0, TYPE_REMEDY);
    // the distinct values still appear (the old behaviour, preserved)
    expect(msg).toContain("(12.5, 17)");
    // the FILES now appear — this is the enrichment, and the assertion that would fail if it were dropped
    expect(msg).toContain("components/appChrome.ts");
    expect(msg).toContain("components/modal.tsx");
    expect(msg).toContain("components/badge.tsx");
    // and each value is tied to the specific file(s) it came from
    expect(msg).toContain("12.5 → components/appChrome.ts, components/modal.tsx");
    expect(msg).toContain("17 → components/badge.tsx");
    // the header count and recorded ceiling survive
    expect(msg).toContain("3 off-scale fontSize values");
    expect(msg).toContain("recorded ceiling 0");
    // the migration guidance is intact
    expect(msg).toContain("use TYPE");
    expect(msg).toContain("lower the constant to 3");
  });

  it("dedupes repeated files and caps a long list with 'and N more' without losing the true count", () => {
    // nine distinct files at one value, plus a duplicate of the first — the duplicate must not be listed twice
    const hits = [
      ...Array.from({ length: 9 }, (_, i) => ({ file: `f${i}.tsx`, value: 5 })),
      { file: "f0.tsx", value: 5 },
    ];
    const msg = offScaleMessage("borderRadius", "use RADIUS/PILL", hits, 0, RADIUS_REMEDY);
    // f0.tsx appears exactly once in the LOCATIONS list despite being present twice in the hits.
    // The import block names it a second time, deliberately — that line is the paste-me — so the
    // dedupe assertion is scoped to the locations half rather than to the whole message.
    const locationsHalf = msg.slice(0, msg.indexOf("PASTE THIS IMPORT"));
    expect(locationsHalf.split("f0.tsx").length - 1).toBe(1);
    // the display is capped, but the header count reflects ALL ten hits, not the six shown
    expect(msg).toMatch(/and \d+ more/);
    expect(msg).toContain("10 off-scale borderRadius values");
    expect(msg).toContain("use RADIUS/PILL");
  });
});

// ── THE MESSAGE MUST TEACH, NOT JUST ACCUSE (bead sparkle-qw9y62) ──────────────────────────────
//
// This is the half of the bead that is not about speed. The ratchet's message is the ONLY place a
// newcomer learns these ratchets exist — nothing upstream of a tripped guard mentions them, and
// every neighbouring file is full of the raw numbers it forbids. So "use TYPE" is not enough: it
// names the family and leaves the reader to find the module, work out the relative path from
// wherever they are standing, and guess a step.
//
// These assertions pin the LITERAL IMPORT STATEMENT, character for character, because a
// description of a paste-able line is not a paste-able line. They are written against synthetic
// hits for the reason the block above already gives: the real ratchets scan the real tree and
// cannot be forced red on demand, so nothing else here can fail if the teaching is dropped.
describe("a tripped ratchet prints the import line to paste, not a description of one", () => {
  it("gives the exact specifier for a file in components/, plus the token to type", () => {
    const msg = offScaleMessage(
      "fontSize",
      "use TYPE",
      [{ file: "components/appChrome.ts", value: 12.5 }],
      0,
      TYPE_REMEDY,
    );
    // THE deliverable: a line that can be pasted at the top of components/appChrome.ts verbatim.
    expect(msg, "the message must carry the literal import statement").toContain(
      'import { TYPE } from "../theme/scale";',
    );
    // …and what to write where the raw number was.
    expect(msg, "the message must name the replacement expression").toContain(
      "fontSize: TYPE.body",
    );
    // …and every step, so picking one is not a fourth lookup.
    expect(msg, "the message must list the steps available").toContain("TYPE.body=13");
    // …and the cheap way to re-take the verdict once it is fixed.
    expect(msg, "the message must name the standalone re-run").toContain(
      "bash scripts/design-token-ratchets.sh",
    );
  });

  it("computes the specifier from the OFFENDING FILE's own directory, not a fixed string", () => {
    // The whole point of computing it: these three files need three different lines, and a
    // hardcoded "../theme/scale" would be wrong for two of them. A constant would pass the test
    // above and fail here, which is what makes that test non-vacuous.
    const msg = offScaleMessage(
      "borderRadius",
      "use RADIUS/PILL",
      [
        { file: "theme/blueprintSpec.ts", value: 7 },
        { file: "components/Concierge/ComposeBox.tsx", value: 7 },
        { file: "App.tsx", value: 7 },
      ],
      0,
      RADIUS_REMEDY,
    );
    expect(msg, "a sibling of scale.ts imports it as ./scale").toContain(
      'import { RADIUS, PILL } from "./scale";',
    );
    expect(msg, "a file one directory deeper needs an extra ../").toContain(
      'import { RADIUS, PILL } from "../../theme/scale";',
    );
    expect(msg, "a file at the src root needs ./theme/scale").toContain(
      'import { RADIUS, PILL } from "./theme/scale";',
    );
    // Each import line names the file(s) it is for, so three lines are not three riddles.
    expect(msg).toContain("// in theme/blueprintSpec.ts");
    expect(msg).toContain("// in App.tsx");
    // PILL is offered as the capsule shape rather than as a step to pick off the scale.
    expect(msg).toContain("PILL=999");
  });
});
