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
// ══ WHAT THIS GRIPS, STATED AS A LIST BECAUSE TWO EARLIER CUTS GOT IT WRONG ═══════════════════
// A source guard is only as good as the evasions it was actually run against, and this file has now
// misdescribed its own reach twice — first OVERSTATED (whole-file `toMatch`es that were satisfied by
// any one matching occurrence), then UNDERSTATED (an example listed as a blind spot that the guard
// actually catches). Both failures cost the same thing: the next maintainer trusts the list instead
// of re-deriving. So the list below is exactly the set that has been mutation-verified to RED:
//
//   1. a SECOND call in a file already on the list, with the wrong argument
//   2. `let` / `var` rebinding `calmStatus`
//   3. `const { status: calmStatus } = rt` — renamed INTO the name
//   4. `const { calmStatus } = somethingElse()` — right name, wrong producer
//   5. a TYPE-ANNOTATED PARAMETER named `calmStatus` — the form that needs no declaration keyword
//      and no `=`, so every check above misses it, and the likeliest one to appear in a 3,500-line
//      component full of memo and callback bodies
//   6. a CONTEXTUALLY-TYPED ARROW PARAMETER — `({ calmStatus }) => …` — which carries no annotation
//      at all because its type comes from the call it is passed to
//   7. a THIRD caller file
//
// WHAT IT STILL CANNOT SEE, and these are true rather than illustrative: an indirection through an
// object (`deps.calmStatus`), a spread call (`useFinishedHeads(...args)`), an UNANNOTATED parameter
// in a position TypeScript does not contextually type (which `noImplicitAny` rejects anyway, so the
// compiler is the guard there), and a caller outside `apps/desktop/src`. An ALIAS (`const m = calmStatus; useFinishedHeads(agentsById, m, …)`) was
// listed here and is WRONG — the per-call check compares against the literal argument list, so an
// alias reds. It reds as a FALSE ALARM, since aliasing the correct map is harmless, which brings us
// to the last thing a reader needs:
//
// ⚠️ HOW TO READ A FAILURE. The argument check is an exact string comparison, so renaming
// `agentsById` or `nudgeFlags`, adding a trailing comma to a wrapped call, or even quoting a
// `useFinishedHeads(…)` call inside a comment will red this file. That is "reformat, or update the
// guard" — NOT a regression. A real regression looks like an argument that is a different MAP.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(here, rel), "utf8");

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
      const src = read(rel);
      // The name check above is only as good as the name. Three ways to rebind it, all of which
      // would satisfy the call assertion while feeding the hook something else — and the first cut
      // of this guard caught only the first of them while its header claimed to close the hole:
      //
      //   const/let/var calmStatus = rt.status      ← direct rebind, any keyword
      //   const { status: calmStatus } = rt          ← renamed INTO the name during a destructure
      //   const { calmStatus } = somethingElse()     ← destructured from the wrong producer
      //
      // So: no direct binding at all, no rename into the name, and exactly ONE destructure that
      // binds it — whose right-hand side must be `useOverlaidStatus(`.
      expect(src.match(/(?:const|let|var)\s+calmStatus\b/g) ?? [], "calmStatus rebound directly").toEqual([]);
      expect(src.match(/:\s*calmStatus\b/g) ?? [], "something renamed INTO calmStatus").toEqual([]);
      // A PARAMETER needs no keyword and no `=`, so nothing above sees it — and in a component full
      // of memo and callback bodies it is the likeliest shadow of all:
      //   const finishedFor = (agentsById, calmStatus) => useFinishedHeads(agentsById, calmStatus, …)
      //   groups.map(({ calmStatus }) => useFinishedHeads(agentsById, calmStatus, …))
      // Both would satisfy every other assertion in this file while feeding the hook another map.
      // ⚠️ NOT `/[(,]\s*calmStatus\s*[:,)]/`, which was the first attempt and matched the ARGUMENT
      // position in the very call this file exists to bless (`…, calmStatus, nudgeFlags)`). What
      // separates a parameter from an argument here is a TYPE ANNOTATION — this codebase is
      // `noImplicitAny`, so a declared parameter carries one. The same pattern also rejects an
      // object-literal key, which is a shadow by another route and equally unwelcome.
      expect(
        src.match(/\bcalmStatus\s*:/g) ?? [],
        "calmStatus is type-annotated (a parameter) or used as an object key",
      ).toEqual([]);
      // …and the CONTEXTUALLY-typed arrow parameter, which needs no annotation because its type
      // comes from the call it is passed to: `(a, calmStatus) => …`. Anchored on the `=>` so the
      // ordinary argument position — no arrow after it — cannot match.
      expect(
        src.match(/\(\s*[^()]*\bcalmStatus\b[^()]*\)\s*=>/g) ?? [],
        "calmStatus is an arrow PARAMETER",
      ).toEqual([]);
      expect(
        src.match(/\{[^{}]*\bcalmStatus\b[^{}]*\}\s*(?::[^=]*)?=>/g) ?? [],
        "calmStatus is destructured in an ARROW PARAMETER",
      ).toEqual([]);
      const destructures = [...src.matchAll(/\{[^{}]*\bcalmStatus\b[^{}]*\}\s*=\s*([A-Za-z_$][\w$]*)\(/g)];
      expect(destructures.length, `${label} should destructure calmStatus exactly once`).toBe(1);
      expect(destructures[0]![1]).toBe("useOverlaidStatus");
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
