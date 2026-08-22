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
// The lesson is not "write a better regex" — and it was not "list the right node kinds" either.
// The first AST version enumerated three kinds and called them "every form the language has"; it
// missed `import { calmStatus } from …`, the easiest module-scope shadow there is. FIVE rounds, five
// enumerations, five misses.
//
// So the test is INVERTED. Any node whose own `.name` is this identifier is declaring it, and the
// exceptions are the few nodes that carry a `.name` while naming something else — a member access,
// an object key, a JSX attribute, a type member. That set is structural and does not grow when the
// language adds a declaration form. It is not claimed to be exhaustive; it is built to fail in the
// SAFE direction, where an unlisted naming node reds the guard as a false alarm someone reads,
// rather than passing as a shadow nobody sees. See `bindingsOf`.
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

/** Every identifier named `calmStatus` that is BEING DECLARED — not used.
 *
 *  ══ AN EXCLUSION LIST, NOT AN INCLUSION LIST, AND THAT IS THE WHOLE POINT ═══════════════════
 *  This started as three node kinds — VariableDeclaration, BindingElement, Parameter — described in
 *  the commit that added it as "every form the language has". It was not. It missed
 *  `import { calmStatus } from …`, which shadows at MODULE scope and is the easiest second-scope
 *  shadow of all, plus function/class/type/enum declaration names. That was the fifth consecutive
 *  round in which an enumeration of forms was the defect, and the fourth time a header claimed a
 *  reach it did not have.
 *
 *  So the test is inverted. ANY node whose own `name` is this identifier is declaring it — that is
 *  what `.name` MEANS across the AST — and the exceptions are the handful of nodes that carry a
 *  `.name` while naming something OTHER than a new binding. That set is small, structural, and does
 *  not grow when the language adds a declaration form, which is exactly the property the inclusion
 *  list never had:
 *
 *    PropertyAccessExpression  `deps.calmStatus`      — the `.name` is a MEMBER, not a binding
 *    QualifiedName             `Foo.calmStatus`       — same, in type space
 *    PropertyAssignment        `{ calmStatus: x }`    — an object-literal KEY
 *    ShorthandPropertyAssignment `{ calmStatus }`     — a key AND a use; the binding is elsewhere
 *    JsxAttribute              `<X calmStatus={…} />` — an attribute name
 *    PropertySignature / MethodSignature              — TYPE members, no runtime binding
 *
 *  ⚠️ AND A PARAMETER IN A TYPE POSITION IS NOT A BINDING EITHER. `type P = { onCalm: (calmStatus:
 *  Map) => void }` parses to a real `ts.Parameter`, and counting it would red this guard on an
 *  ordinary future prop type — a false alarm on a declaration that binds nothing at runtime. The
 *  test is whether the parameter's owner has a BODY: a function that runs has one, a function TYPE
 *  does not.
 *
 *  Comments are not nodes at all, so the doc line `calmStatus: the pre-escalation map` — which both
 *  caller files genuinely contain — is invisible here. That is why the comment-stripping hack this
 *  file used to carry is gone.
 *
 *  This is NOT claimed to be exhaustive. It is claimed to fail in the SAFE direction: an unlisted
 *  naming node counts as a binding and reds the guard, which is a false alarm someone reads, rather
 *  than a shadow nobody sees. Four earlier versions failed the other way. */
function bindingsOf(src: string): ts.Identifier[] {
  const sf = ts.createSourceFile("caller.tsx", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: ts.Identifier[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n) && n.text === "calmStatus" && isDeclaredHere(n)) out.push(n);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** Does this identifier introduce a NEW binding at its own position? See `bindingsOf`'s header. */
function isDeclaredHere(id: ts.Identifier): boolean {
  const p = id.parent as (ts.Node & { name?: ts.Node }) | undefined;
  if (p === undefined || p.name !== id) return false;
  if (
    ts.isPropertyAccessExpression(p) ||
    ts.isQualifiedName(p) ||
    ts.isPropertyAssignment(p) ||
    ts.isShorthandPropertyAssignment(p) ||
    ts.isJsxAttribute(p) ||
    ts.isPropertySignature(p) ||
    ts.isMethodSignature(p)
  ) {
    return false;
  }
  // ── RESOLVE OUT THROUGH BINDING PATTERNS BEFORE ASKING WHO OWNS THIS ──────────────────────────
  // The carve-out below was written against a DIRECT parameter (`(calmStatus: T) => void`) and was
  // half a fix: a DESTRUCTURED parameter of a function type — `type P = { onCalm: ({ calmStatus }:
  // A) => void }` — parses as BindingElement → ObjectBindingPattern → Parameter → FunctionTypeNode,
  // so the direct parent is a BindingElement and it fell straight through to "binds". That is the
  // most common shape in this repo (destructured props) written in type space, and it would have
  // reddened this guard with "bound more than once" — the message that means the regression this
  // file exists to catch. So walk out of the pattern first, then ask.
  let owner: ts.Node = p;
  while (
    ts.isBindingElement(owner) ||
    ts.isObjectBindingPattern(owner) ||
    ts.isArrayBindingPattern(owner)
  ) {
    owner = owner.parent;
  }
  // A parameter of a function TYPE binds nothing at runtime — only one with a body does.
  if (ts.isParameter(owner)) {
    const fn = owner.parent as ts.Node & { body?: ts.Node };
    return fn.body !== undefined;
  }
  return true;
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

// ══ THE CLASSIFIER'S OWN SUITE, WHICH IS THE THING THAT WAS MISSING ═══════════════════════════
// `isDeclaredHere` is the load-bearing part of this file and it shipped, five times, with NOTHING
// able to red on it. Every mutation check across those rounds was run against ad-hoc sources that
// were never committed — so the evidence lived in commit messages, where no future change can
// re-run it, and deleting the entire exclusion list left the suite green. Given that the classifier
// is exactly where all five defects were, that is the property most worth pinning.
//
// Each case below is an inline source string with a stated expected count, so every branch has a
// test that fails when that branch is mutated.
describe("bindingsOf — what counts as declaring the name", () => {
  const count = (src: string) => bindingsOf(src).length;

  it.each([
    ["a plain declaration", "const calmStatus = 1;"],
    ["let, which is still a binding", "let calmStatus;"],
    ["a shorthand destructure", "const { calmStatus } = f();"],
    ["a renamed destructure", "const { status: calmStatus } = f();"],
    ["a NESTED destructure", "const { a: { calmStatus } } = f();"],
    ["an array destructure", "const [calmStatus] = xs;"],
    ["a for-of destructure", "for (const { calmStatus } of xs) { use(calmStatus); }"],
    // The module-scope shadow the inclusion-list version could not see at all.
    ["an IMPORT", 'import { calmStatus } from "./m";'],
    ["a renamed import", 'import { m as calmStatus } from "./m";'],
    ["a function declaration", "function calmStatus() { return 1; }"],
    ["a class declaration", "class calmStatus {}"],
    // The shape four regex versions AND the first AST version missed.
    ["a DESTRUCTURED parameter of a real function", "function F({ calmStatus }: P) { return calmStatus; }"],
    ["a direct parameter of a real function", "const f = (calmStatus: T) => calmStatus;"],
  ])("counts %s", (_label, src) => {
    expect(count(src)).toBe(1);
  });

  it.each([
    // Each of these carries a `.name` that is this identifier while naming something that is NOT a
    // new binding — the exclusion list. Delete an entry and its case here reds.
    ["a member access", "use(deps.calmStatus);"],
    ["a qualified name in type space", "let x: Foo.calmStatus;"],
    ["an object-literal key", "const o = { calmStatus: 1 };"],
    ["a shorthand property USE", "const o = { calmStatus };"],
    ["a JSX attribute", "const el = <X calmStatus={y} />;"],
    ["a property signature", "interface I { calmStatus: T }"],
    ["a method signature", "interface I { calmStatus(): void }"],
    // Binds nothing at runtime — the false alarm the body check exists to prevent…
    ["a parameter of a function TYPE", "type F = (calmStatus: T) => void;"],
    // …and the same thing DESTRUCTURED, which the first version of that check let through.
    ["a DESTRUCTURED parameter of a function type", "type F = ({ calmStatus }: A) => void;"],
    ["a plain use as an argument", "f(agentsById, calmStatus, nudgeFlags);"],
    ["a comment", "// calmStatus: the pre-escalation map\nconst x = 1;"],
  ])("does NOT count %s", (_label, src) => {
    expect(count(src)).toBe(0);
  });

  it("counts each binding separately when a file has two", () => {
    // The actual regression: one legitimate binding plus a shadow. Neither case above would catch a
    // classifier that returned at most one.
    expect(count('import { calmStatus } from "./m";\nfunction F({ calmStatus }: P) { return calmStatus; }')).toBe(2);
  });
});
