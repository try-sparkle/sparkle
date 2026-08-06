// THE LATCH, AND THE BOUNDARY THAT IS THE REASON IT IS A SEPARATE FILE.
//
// Two unrelated-looking things are asserted together on purpose: the second is what the first is
// FOR. A future reader who moves `passRunning` back into `improvementPass` gets a green latch suite
// and a red boundary suite, sitting side by side, saying why.
import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// The compiler's OWN parser, the seam theme/linkContrast and stores/keybindingsStore already use for
// this. A regex would have to re-derive import grammar and TypeScript's type-erasure rules by hand,
// beside an AST that answers both exactly — `importClause.isTypeOnly` and each specifier's
// `isTypeOnly` ARE the erasure rule, rather than an approximation of it.
import ts from "typescript";

import { claimPass, releasePass, isPassRunning } from "./improvementPassLatch";

beforeEach(() => releasePass());
afterEach(() => releasePass());

describe("the in-flight latch", () => {
  it("is clear before anything claims it — the inverse guard", () => {
    // Without this, a latch hardwired to `true` would satisfy the claim case below while holding the
    // concierge's write gate shut forever.
    expect(isPassRunning()).toBe(false);
  });

  it("reads busy once claimed, and clear once released", () => {
    expect(claimPass()).toBe(true);
    expect(isPassRunning()).toBe(true);
    releasePass();
    expect(isPassRunning()).toBe(false);
  });

  it("REFUSES a second claim while the first still holds it", () => {
    // The check and the set are one call for exactly this: as two statements at the call site, a
    // second pass can be admitted between them, and two `claude -p` children in one worktree is the
    // collision the whole gate exists to prevent.
    expect(claimPass()).toBe(true);
    expect(claimPass()).toBe(false);
    // ...and the first holder's latch is untouched by the refusal, so its own release still clears.
    expect(isPassRunning()).toBe(true);
  });

  it("tolerates a release with nothing held", () => {
    // `runImprovementPass` releases in a `finally`, which runs on paths that never claimed.
    releasePass();
    expect(isPassRunning()).toBe(false);
  });
});

// ── THE IMPORT BOUNDARY ────────────────────────────────────────────────────────────────────────
//
// THE CHAIN THAT ACTUALLY BROKE, measured rather than assumed (roborev 59144 caught the first cut
// asserting a chain that does not exist at runtime — see "TYPE-ONLY EDGES" below):
//
//   components/Composer -> components/composer/ApprovalNudge -> services/configActions
//     -> services/conciergeTools/policy -> services/conciergeTools/lifecycle
//     -> services/sparkleBusy -> services/improvementPass
//     -> services/sparkleTranscript -> services/conciergeTools/terminal
//
// So `services/sparkleBusy` sits under an ordinary composer component, and anything it imports is
// acquired by that whole slice of the component tree. When it took `isPassRunning` from
// `improvementPass` itself, the slice grew to include the pass, `sparkleTranscript`, and
// `conciergeTools/terminal`. The failure that produced named none of those:
// `Composer.suggestionDeadPty.test.tsx` died at COLLECTION on a missing `SNAPSHOT_MAX_LINES` export
// of a `terminalScrollback` mock it had written long before, because `conciergeTools/terminal` reads
// that symbol at module scope. A test file the change never touched, over a symbol it never
// mentions — the module graph was the entire link, which is why a comment asking people not to do it
// again is not enough.
//
// ── TYPE-ONLY EDGES ARE NOT EDGES, and getting this wrong made the first cut vacuous ───────────
// esbuild erases `import type` / `export type`, so such a specifier creates NO runtime dependency.
// The first version of this walker counted them, and rooted the walk at `stores/settingsStore` —
// whose relative imports are ALL type-only, deliberately (its own comment says a value import to
// `conciergeTools/policy` "would close that loop"). Every assertion below therefore passed on an
// erased edge: the control case proved only that a regex walks source text, the inverse guard was
// satisfied through an edge no bundle contains, and a real re-introduction of the eager dependency
// by any other route would have stayed green. The walk models RUNTIME edges now, and there is a case
// below that pins the distinction so this cannot silently regress. The walk reads the AST rather
// than matching text, so those rules are the compiler's, not a re-derivation of them.
const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "..");

/** Resolve a relative specifier the way the bundler does, or null for a package import. */
function resolveSpec(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), spec);
  for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`, base]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** The module specifier of a statement, when it has one. */
function specifierOf(node: ts.ImportDeclaration | ts.ExportDeclaration): string | null {
  const s = node.moduleSpecifier;
  return s !== undefined && ts.isStringLiteral(s) ? s.text : null;
}

/**
 * Runtime-edge specifiers of one file, read from the AST.
 *
 * ERASURE IS THE AST'S ANSWER, NOT OURS. An import survives to runtime unless the compiler erases
 * it, and the compiler's own nodes say exactly when that is:
 *   • `importClause.isTypeOnly` — a statement-level `import type { A } from "x"`;
 *   • every `ImportSpecifier.isTypeOnly` with no default and no namespace binding — an all-inline
 *     `import { type A, type B } from "x"`, which leaves nothing to emit. A mixed
 *     `import { a, type B }` keeps `a`, so it IS an edge;
 *   • `ExportDeclaration.isTypeOnly` — `export type { A } from "x"`;
 *   • every `ExportSpecifier.isTypeOnly` — `export { type A } from "x"`. THE STATEMENT FLAG IS
 *     FALSE HERE: the `type` modifiers sit on the specifiers, so a check of `isTypeOnly` alone
 *     reports an edge the bundle does not contain. Exactly the mirror of the import case, and this
 *     file's own header names over-reporting as the direction that spuriously reds a negative
 *     assertion while letting a positive control pass through a nonexistent edge.
 * An import with NO clause at all is `import "x";`, a side-effect import and always an edge.
 *
 * Static only, deliberately: a dynamic `await import()` does NOT put the target in the importer's
 * eager graph, which is the thing being bounded here.
 *
 * `fileName` IS LOAD-BEARING, not decoration. The script kind is inferred from its extension, and
 * parsing a `.ts` file as TSX is not a harmless mismatch: TSX reads `<V>(m: Record<string, V>) => …`
 * (a real shape in this repo — see stores/runtimeStore) as an unterminated JSX tag, and a file that
 * fails to parse yields NO specifiers. Silent under-reporting is the vacuity this suite exists to
 * prevent, so a parse error throws rather than returning an empty list.
 */
export function runtimeSpecifiers(source: string, fileName = "m.ts"): string[] {
  // No explicit ScriptKind: `createSourceFile` derives it from the extension, so a `.ts` file is
  // never parsed under JSX rules and vice versa.
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.ESNext, true);
  // `parseDiagnostics` is internal, hence the cast; an absent field must not read as "no errors".
  const diagnostics = (sf as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] })
    .parseDiagnostics;
  if (diagnostics !== undefined && diagnostics.length > 0) {
    const first = ts.flattenDiagnosticMessageText(diagnostics[0]!.messageText, " ");
    throw new Error(`runtimeSpecifiers: ${fileName} failed to parse (${first})`);
  }
  const out: string[] = [];
  for (const s of sf.statements) {
    if (ts.isImportDeclaration(s)) {
      const spec = specifierOf(s);
      if (spec === null) continue;
      const clause = s.importClause;
      if (clause === undefined) {
        out.push(spec); // `import "x";`
        continue;
      }
      if (clause.isTypeOnly) continue;
      const bindings = clause.namedBindings;
      const allInlineType =
        clause.name === undefined &&
        bindings !== undefined &&
        ts.isNamedImports(bindings) &&
        bindings.elements.length > 0 &&
        bindings.elements.every((e) => e.isTypeOnly);
      if (allInlineType) continue;
      out.push(spec);
    } else if (ts.isExportDeclaration(s)) {
      if (s.isTypeOnly) continue;
      const clause = s.exportClause;
      const allInlineType =
        clause !== undefined &&
        ts.isNamedExports(clause) &&
        clause.elements.length > 0 &&
        clause.elements.every((e) => e.isTypeOnly);
      if (allInlineType) continue;
      const spec = specifierOf(s);
      if (spec !== null) out.push(spec);
    }
  }
  return out;
}

/** Breadth-first walk of the runtime graph, returning the path to `target` or null. */
function importPath(entry: string, target: string): string[] | null {
  const cameFrom = new Map<string, string | null>([[entry, null]]);
  const queue = [entry];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === target) {
      const chain: string[] = [];
      for (let node: string | null = current; node; node = cameFrom.get(node) ?? null) {
        chain.push(relative(SRC, node));
      }
      return chain.reverse();
    }
    let source: string;
    try {
      source = readFileSync(current, "utf8");
    } catch {
      continue;
    }
    // The REAL path, so the script kind follows the real extension. See `runtimeSpecifiers`.
    for (const spec of runtimeSpecifiers(source, current)) {
      const next = resolveSpec(current, spec);
      if (next !== null && !cameFrom.has(next)) {
        cameFrom.set(next, current);
        queue.push(next);
      }
    }
  }
  return null;
}

describe("the walker models RUNTIME edges", () => {
  // These four are the guard on the guard. The boundary assertions further down are all NEGATIVE
  // (expect no path), so a walker that under-reports edges makes every one of them pass while
  // proving nothing — which is exactly what happened the first time.
  it("counts a plain value import", () => {
    expect(runtimeSpecifiers(`import { a } from "./x";`)).toEqual(["./x"]);
  });

  it("DROPS a statement-level type import, because esbuild erases it", () => {
    expect(runtimeSpecifiers(`import type { A } from "./x";`)).toEqual([]);
    expect(runtimeSpecifiers(`export type { A } from "./x";`)).toEqual([]);
  });

  it("DROPS a clause whose every binding is an inline type, but KEEPS a mixed one", () => {
    expect(runtimeSpecifiers(`import { type A, type B } from "./x";`)).toEqual([]);
    expect(runtimeSpecifiers(`import { a, type B } from "./x";`)).toEqual(["./x"]);
  });

  it("counts a bare side-effect import", () => {
    expect(runtimeSpecifiers(`import "./x";`)).toEqual(["./x"]);
  });

  it("keeps a default or namespace binding even when the named ones are all types", () => {
    // The all-inline-type rule must be conditioned on there being nothing else to emit. A regex
    // over the brace clause cannot see the binding to its left, which is one of the reasons this
    // reads the AST.
    expect(runtimeSpecifiers(`import D, { type A } from "./x";`)).toEqual(["./x"]);
    expect(runtimeSpecifiers(`import * as ns from "./x";`)).toEqual(["./x"]);
  });

  it("counts `export * from`, and drops `export type ... from`", () => {
    expect(runtimeSpecifiers(`export * from "./x";`)).toEqual(["./x"]);
    expect(runtimeSpecifiers(`export { a } from "./x";`)).toEqual(["./x"]);
    expect(runtimeSpecifiers(`export type { A } from "./x";`)).toEqual([]);
  });

  it("drops an all-inline-type RE-EXPORT, where the statement flag is false", () => {
    // `export { type A } from "x"` carries its `type` modifiers on the SPECIFIERS, so
    // `ExportDeclaration.isTypeOnly` is false and a statement-level check alone reports an edge the
    // bundle does not contain. The mirror of the `import D, { type A }` case, in the OVER-reporting
    // direction: it spuriously reds a negative assertion and lets a positive control pass through
    // an edge that is not there.
    expect(runtimeSpecifiers(`export { type A } from "./x";`)).toEqual([]);
    expect(runtimeSpecifiers(`export { type A, type B } from "./x";`)).toEqual([]);
    expect(runtimeSpecifiers(`export { a, type B } from "./x";`)).toEqual(["./x"]);
  });

  it("parses a .ts file under TS rules, not JSX rules", () => {
    // A generic arrow like this is real in this repo (stores/runtimeStore). Forced into TSX mode it
    // reads as an unterminated JSX tag, the parse fails, and the file contributes ZERO edges — which
    // every negative assertion below would then pass on. The script kind follows the extension.
    const generic = `const f = <V>(m: Record<string, V>) => m;\nimport { a } from "./x";`;
    expect(runtimeSpecifiers(generic, "m.ts")).toEqual(["./x"]);
  });

  it("THROWS on a file it cannot parse, rather than reporting no edges", () => {
    // Silent under-reporting is the vacuity this whole suite exists to prevent, so an unparseable
    // file must be loud. Without this, a future parser change that broke on some real file would
    // turn the boundary cases green for the worst possible reason.
    expect(() => runtimeSpecifiers(`import { a from "./x";`, "broken.ts")).toThrow(/failed to parse/);
  });

  it("is not fooled by an import-like string in a comment or a literal", () => {
    // The whole class of bug a text matcher is prone to, and the AST is immune to by construction.
    expect(runtimeSpecifiers(`// import { a } from "./ghost";\nconst s = 'import x from "./nope"';`))
      .toEqual([]);
  });

  it("ignores a DYNAMIC import, which creates no eager edge", () => {
    expect(runtimeSpecifiers(`const m = await import("./x");`)).toEqual([]);
  });
});

describe("the composer graph does not reach the improvement pass", () => {
  // Rooted at the module that ACTUALLY broke, not at a store that only looked like the entry point.
  const composer = resolve(SRC, "components/Composer.tsx");
  const pass = resolve(SRC, "services/improvementPass.ts");
  const latch = resolve(SRC, "services/improvementPassLatch.ts");
  const terminal = resolve(SRC, "services/conciergeTools/terminal.ts");

  it("proves the walk reaches the right neighbourhood, by finding a path it MUST find", () => {
    // Without this the negative assertions below would pass just as well against a walker that
    // returns null for everything. `sparkleBusy` is the module whose imports are being bounded, so
    // if the walk cannot even get THERE, it is bounding nothing.
    const known = importPath(composer, resolve(SRC, "services/sparkleBusy.ts"));
    expect(known).not.toBeNull();
    expect(known![0]).toBe("components/Composer.tsx");
    expect(known![known!.length - 1]).toBe("services/sparkleBusy.ts");
  });

  it("cannot reach services/improvementPass", () => {
    const found = importPath(composer, pass);
    expect(found === null ? null : found.join(" -> ")).toBeNull();
  });

  it("cannot reach services/conciergeTools/terminal", () => {
    // The consequence rather than the cause — and the one that actually broke a suite. Asserted
    // separately so a future edge that reaches terminal by some OTHER route is caught too.
    const found = importPath(composer, terminal);
    expect(found === null ? null : found.join(" -> ")).toBeNull();
  });

  it("still reaches the LATCH — the boundary bounds dependencies, it does not sever the feature", () => {
    // The write gate must keep working. If this ever goes null, `sparkleBusy` has stopped consulting
    // the latch at all and the two assertions above have become trivially true.
    const found = importPath(composer, latch);
    expect(found).not.toBeNull();
  });
});
