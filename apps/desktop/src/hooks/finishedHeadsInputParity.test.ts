// THE PARITY GUARD FOR THE ARGUMENT THAT CAN SILENTLY REGRESS.
//
// `useFinishedHeads` takes its most consequential input as a plain `Record<string, AgentTabStatus>`
// parameter, and the two callers must pass the SAME thing: `hooks/useOverlaidStatus`'s `calmStatus`.
// Handing it the raw store map instead is a one-word edit, it type-checks, and it is exactly the bug
// this subsystem already shipped — `stallReport` gates every arm behind `isQuiet(status)`, so a head
// carrying a red worker reads `blocked` in the overlaid map (verdict `active`) and `idle` in the raw
// one (`finished`). One head, two answers, decided by which caller asked.
//
// ══ WHY A SOURCE TEST, WHICH IS NOT THE FIRST CHOICE ═══════════════════════════════════════════
// Because the behavioural route was tried and provably does not exist. `hooks/useFinishedHeads.test`
// proves the two maps DIVERGE at the hook; what nothing could witness is the divergence reaching a
// rendered square, and the reason is mechanical:
//
//   `rollupDot` paints an epic from its WORKERS' published statuses plus the head's own bubble-free
//   tier. A head's verdict only ever demotes the HEAD's published status, which is not in either of
//   those. And the two maps never disagree about a WORKER: a red worker is `blocked` in both (the
//   overlays repaint parents, not the worker itself) and `blocked` is not quiet, so both answer
//   `active`. A never-started strand is `approval` in one and absent from the other — where the
//   hook falls back to `stopped` — and neither of those is quiet either.
//
// Four fixtures were written to catch it through the column, including the one a review specified
// verbatim (head `idle` + `blocked` worker, `CLEAN_BS` on the head's branch status, `MERGED_WS` on
// its workflow state). Each was run against BOTH call sites: every one printed `red` either way.
//
// The review reached the opposite conclusion from `EpicsColumn.finishedCalm.test.tsx`, which DOES
// move the square on this fixture — but that test MOCKS the hook to answer for every id, so its
// WORKER is called finished too, and that is what demotes the red. The real hook never calls a
// `blocked` worker finished. A mock answering more ids than the real thing can is the difference,
// and it is worth naming: it is why that test cannot stand in for this guard.
//
// So this is the same shape as `engine/observedAttentionChainParity.test.ts`, whose header states
// the principle — when the only thing that can witness a constraint is the source, read the source.
// If `useFinishedHeads` ever takes its map from a hook rather than a parameter, DELETE THIS FILE: a
// structural guarantee needs no guard.
//
// ══ WHAT THIS GRIPS — AND WHY IT IS NO LONGER A LIST OF SYNTAXES ══════════════════════════════
// Three consecutive review rounds each found a declaration shape this file's enumeration had
// missed, and each round the fix was to add one more regex. The last miss was the one that proved
// the approach wrong: a destructure whose right-hand side is NOT a call, in a SECOND SCOPE in the
// same file — which every shape-regex missed, which the old destructure counter did not count
// (it required `= ident(`), and whose argument spelling was correct. Three rounds where the
// STATED REACH was itself the defect is an argument for changing the method, not extending it.
//
// So the question is no longer "which syntax is this". It is: HOW MANY TIMES is this name BOUND in
// this file? The answer must be one, and that one must come from `useOverlaidStatus`. A shape
// nobody enumerated still counts as a binding, which is the property the enumeration never had.
//
// Mutation-verified to RED: a second call with the wrong argument; `let`/`var`; a rename INTO the
// name; a destructure from the wrong producer; a type-annotated parameter; a contextually-typed
// arrow parameter; an ARRAY destructure; a `for…of` destructure; and the second-scope non-call
// destructure above. Verified NOT to red: a doc comment naming the identifier — comments are
// stripped before scanning, because both caller files genuinely comment on this very name.
//
// WHAT IT STILL CANNOT SEE: an indirection through an object at the CALL (`useFinishedHeads(a,
// deps.calmStatus, n)` — though that reds on the argument check, as a false alarm), a spread call
// (`useFinishedHeads(...args)`), and a caller outside `apps/desktop/src`.
//
// ⚠️ HOW TO READ A FAILURE. The argument check is an exact string comparison, so renaming
// `agentsById` or `nudgeFlags`, or adding a trailing comma to a wrapped call, will red this file.
// That is "reformat, or update the guard" — NOT a regression. A real regression looks like the name
// being BOUND a second time, or an argument that is a different MAP.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(here, rel), "utf8");

/** Source with comments removed.
 *
 *  NOT cosmetic: every pattern below scans raw text, and both caller files comment ON this very
 *  identifier. A doc line reading `calmStatus: the pre-escalation map` is a perfectly natural thing
 *  to write and would have matched the annotated-parameter pattern, reddening this guard with the
 *  message "calmStatus is type-annotated (a parameter)" — a false alarm on a comment. Stripping
 *  first means the guard reads CODE, which is what it claims to do. */
const strip = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

/** Every production caller. A new one added without a line here is the case this cannot see, so the
 *  list is asserted to be complete against a repo-wide grep below. */
const CALLERS: readonly (readonly [string, string])[] = [
  ["AgentSidebar", "../components/AgentSidebar.tsx"],
  ["EpicsColumn", "../components/EpicsColumn.tsx"],
];

describe("every caller feeds useFinishedHeads the overlaid map", () => {
  for (const [label, rel] of CALLERS) {
    it(`${label} passes useOverlaidStatus's calmStatus at EVERY call site`, () => {
      const src = read(rel);
      // ⚠️ EVERY OCCURRENCE, NOT THE FIRST MATCH. A whole-file `toMatch` is satisfied by ANY one
      // matching call, so a file calling the hook twice — once correctly, once with `rt.status` —
      // passed green. That is not hypothetical shape-lawyering: `AgentSidebar.tsx` is 3,500+ lines
      // with `calmStatus`, `status` and `escalatedStatus` all live in the same scope, which is
      // exactly where a second call lands. The completeness walk below closes "a third FILE"; this
      // closes "a second CALL in a file already on the list".
      const calls = [...src.matchAll(/useFinishedHeads\(([^)]*)\)/g)];
      expect(calls.length, `${label} no longer calls useFinishedHeads`).toBeGreaterThan(0);
      for (const m of calls) {
        // `?? ""` rather than `!`: under `noUncheckedIndexedAccess` a capture group is
        // `string | undefined`, and an empty argument list is a REAL case (`useFinishedHeads()`)
        // that must fail the comparison rather than crash the test.
        const args = (m[1] ?? "").replace(/\s+/g, " ").trim();
        expect(args, `bad call in ${label}: ${m[0]}`).toBe("agentsById, calmStatus, nudgeFlags");
      }
    });

    it(`${label} binds calmStatus exactly once, from useOverlaidStatus`, () => {
      // ══ COUNT BINDINGS, DO NOT ENUMERATE SYNTAXES ══════════════════════════════════════════
      // This assertion was a list of five regexes, one per declaration shape, and three consecutive
      // review rounds each found a shape the list had missed — the last being a destructure whose
      // right-hand side is NOT a call, in a SECOND SCOPE in the same file:
      //
      //   function EpicRowFooter(props: FooterProps) {
      //     const { agentsById, nudgeFlags } = props;
      //     const { calmStatus } = props.maps;                 // ← the shadow, no call on the RHS
      //     const isFinishedOf = useFinishedHeads(agentsById, calmStatus, nudgeFlags);
      //
      // Every shape-regex missed it, the old destructure counter did not count it (it required
      // `= ident(`), and the argument check passed because the SPELLING was right. That case is
      // also the only viable one left: a second binding INSIDE one component is a TypeScript
      // redeclaration error, and a parameter shadow puts the hook call in a non-hook callback,
      // which `react-hooks/rules-of-hooks` rejects. A second component in one file has neither
      // problem — and `AgentSidebar.tsx` is 4,000+ lines.
      //
      // So the enumeration is abandoned. The question is not "which syntax is this" but "HOW MANY
      // TIMES is this name bound", and the answer must be one. Adding a sixth regex would have been
      // the fourth round of the same mistake.
      const src = strip(read(rel));
      const bindings = [
        // A destructure in ANY binding position — `=`, `of`, `in` — whatever is on the right.
        ...src.matchAll(/\{[^{}]*\bcalmStatus\b[^{}]*\}\s*(?:=[^=>]|\bof\b|\bin\b)/g),
        // A plain declaration, any keyword.
        ...src.matchAll(/(?:const|let|var)\s+calmStatus\b/g),
        // An array destructure.
        ...src.matchAll(/\[[^\]]*\bcalmStatus\b[^\]]*\]\s*=[^=>]/g),
        // A rename INTO the name, and a type-annotated parameter. Both are bindings; neither is a
        // use. (Comments are stripped above, so a doc line reading `calmStatus: the pre-escalation
        // map` — which these files genuinely contain — cannot be mistaken for one.)
        ...src.matchAll(/:\s*calmStatus\b/g),
        ...src.matchAll(/\bcalmStatus\s*:/g),
        // A contextually-typed arrow parameter, which carries no annotation at all.
        ...src.matchAll(/\(\s*[^()]*\bcalmStatus\b[^()]*\)\s*=>/g),
      ];
      expect(
        bindings.map((m) => m[0]),
        `${label} should bind calmStatus EXACTLY ONCE`,
      ).toHaveLength(1);
      // …and that one binding must take it from the shared hook.
      expect(src).toMatch(/\{[^{}]*\bcalmStatus\b[^{}]*\}\s*=\s*useOverlaidStatus\(/);
    });
  }

  it("names every file that calls the hook — a third caller cannot slip past this list", () => {
    // Walked from the source tree rather than hard-coded, so adding a caller reds HERE (with its
    // path in the message) instead of going silently unguarded. Tests and the hook itself are
    // excluded: the hook DEFINES the function, and a test may legitimately call it any way it likes.
    const hits = grepCallers(resolve(here, ".."));
    expect([...hits].sort()).toEqual(CALLERS.map(([, rel]) => resolve(here, rel)).sort());
  });
});

/** Every non-test source file under `root` that calls `useFinishedHeads(`. */
function grepCallers(root: string): Set<string> {
  const out = new Set<string>();
  const skip = /(^|\/)(node_modules|dist|__snapshots__)(\/|$)/;
  const walk = (dir: string) => {
    for (const e of readdirSyncSafe(dir)) {
      const p = resolve(dir, e.name);
      if (skip.test(p)) continue;
      if (e.isDirectory()) {
        walk(p);
        continue;
      }
      if (!/\.tsx?$/.test(e.name) || /\.test\.tsx?$/.test(e.name)) continue;
      if (p.endsWith("useFinishedHeads.ts")) continue; // the definition, not a call
      if (readFileSync(p, "utf8").includes("useFinishedHeads(")) out.add(p);
    }
  };
  walk(root);
  return out;
}

/** A directory that cannot be read is not a caller — an unreadable path must not fail the walk and
 *  turn a coverage question into an I/O one. */
function readdirSyncSafe(dir: string) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}
