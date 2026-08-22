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
// ══ IT WALKS THE AST, BECAUSE FOUR ROUNDS OF PATTERNS DID NOT CONVERGE ════════════════════════
// This check has been rewritten four times and each version missed a binding form the previous
// author had not thought of — the last one a destructured parameter of a NON-arrow function,
// `function EpicRowFooter({ calmStatus }: FooterProps)`, which is the dominant React component
// signature in this repo (185 `.tsx` files use it, `AgentSidebar.tsx` among them). Every round the
// fix was another pattern, and every round the stated reach was the next round's finding.
//
// The lesson is not "write a better regex". A regex family enumerates SYNTAX, and the set of ways
// JavaScript can bind a name is not a set this file gets to close. So it parses instead: one
// TypeScript AST walk, counting identifiers named `calmStatus` that sit in a BINDING position —
// a variable declaration, a binding element (shorthand or renamed, nested to any depth), or a
// parameter. The AST knows every form, including ones nobody here has thought of, which is what
// makes "a shape nobody enumerated still counts" TRUE rather than aspirational.
//
// The contract, in two assertions: `calmStatus` is bound EXACTLY ONCE in each caller, and that one
// binding is destructured from `useOverlaidStatus(...)`. Everything else is a use.
//
// ⚠️ HOW TO READ A FAILURE. "bound more than once" means someone introduced a second
// `calmStatus` — the regression this file exists to catch. The argument check beside it is an exact
// string comparison, so renaming `agentsById` or `nudgeFlags` reds it too; that one is "update the
// guard", not a regression.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import ts from "typescript";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(here, rel), "utf8");

/** Every identifier named `calmStatus` that is BEING BOUND — not used — in this source.
 *
 *  Three node kinds cover every form the language has, which is the entire reason this is an AST
 *  walk and not a pattern list:
 *
 *    VariableDeclaration  `const calmStatus = …`, any keyword
 *    BindingElement       `{ calmStatus }`, `{ status: calmStatus }`, `[calmStatus]`, nested to any
 *                         depth, and — the form four rounds of regexes missed — the same patterns
 *                         used as a FUNCTION PARAMETER, `function F({ calmStatus }: Props)`
 *    Parameter            `(calmStatus: T) => …`, arrow or not, annotated or contextually typed
 *
 *  Comments and type positions are not nodes of these kinds, so a doc line reading
 *  `calmStatus: the pre-escalation map` — which both caller files genuinely contain — cannot be
 *  mistaken for a binding. That was a real false alarm under the regex version. */
function bindingsOf(src: string): ts.Identifier[] {
  const sf = ts.createSourceFile("caller.tsx", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: ts.Identifier[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n) && n.text === "calmStatus") {
      const p = n.parent as ts.Node | undefined;
      if (
        p !== undefined &&
        (ts.isVariableDeclaration(p) || ts.isBindingElement(p) || ts.isParameter(p)) &&
        p.name === n
      ) {
        out.push(n);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** The function a binding was destructured from, or null when it did not come from a call.
 *
 *  Walks OUT to the enclosing variable declaration, so it answers the same for `const { calmStatus }
 *  = f()` and for a nested `const { a: { calmStatus } } = f()`. A parameter has no declaration to
 *  walk out to and answers null, which is what makes a parameter shadow fail this. */
function producerOf(binding: ts.Identifier): string | null {
  let n: ts.Node | undefined = binding.parent;
  while (n !== undefined && !ts.isVariableDeclaration(n)) {
    if (ts.isParameter(n) || ts.isSourceFile(n)) return null;
    n = n.parent;
  }
  const init = n !== undefined && ts.isVariableDeclaration(n) ? n.initializer : undefined;
  if (init === undefined || !ts.isCallExpression(init)) return null;
  return ts.isIdentifier(init.expression) ? init.expression.text : null;
}

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
      const bound = bindingsOf(read(rel));
      expect(
        bound.map((n) => n.getText().slice(0, 60)),
        `${label} should bind calmStatus EXACTLY ONCE`,
      ).toHaveLength(1);
      expect(producerOf(bound[0]!), `${label}'s calmStatus must come from useOverlaidStatus`).toBe(
        "useOverlaidStatus",
      );
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
