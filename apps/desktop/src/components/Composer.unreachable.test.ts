// `components/Composer` is NOT MOUNTED BY THE APP, and this is the guard that keeps that fact true
// rather than merely believed.
//
// Why it needs a guard at all: eleven `Composer.*.test.tsx` files render that component and pass, and
// one of them (`Composer.dictation.test.tsx`) is the ONLY pin on the sparkle-d2ec regression class —
// "can't type in ANY box while dictation is live". A reader who finds a green test named "does NOT
// steal focus from another editable element … (sparkle-d2ec)" reasonably concludes the shipped app is
// covered. It was not: the pane composer was retired with `SparkleAgentPane`'s composer, so those
// eleven suites exercise a component no user can reach. That is the repo's #1 failure mode — a green
// test guarding nothing — in its most expensive form, because it does not look vacuous. Each
// assertion really does run and really does pass; it is the SUBJECT that is dead.
//
// The live compose surface is `Concierge/ComposeBox`, and d2ec is now pinned there
// (`ComposeBox.focusSteal.test.tsx`). This file records the other half: that `Composer` has no path to
// the user, so nobody re-derives it by grepping, and — more importantly — so the day someone mounts it
// again this goes RED and forces a decision. At that moment those eleven suites stop being decorative
// and their coverage has to be re-read against the shipped path.
//
// KEPT rather than deleted, deliberately. Deleting `Composer.tsx` is the tidier end state and it is
// not a drive-by: four more modules are imported by nothing else (`composer/ApprovalNudge`,
// `composer/AttachmentRow`, `composer/suggestionVisibility`, `composerDrag`), each with its own tests,
// and three `SparkleAgentPane.*.test.tsx` files carry a `vi.mock("./Composer")` that stops resolving
// the moment the file goes. That sweep is worth doing on its own branch where the cascade can be
// verified; smuggling ~2,000 deleted lines into a focus-guard fix would make both harder to review and
// harder to revert. What must not survive is the false impression of coverage, and a checked fact
// removes that without the cascade.
//
// Node environment, because it reads source from disk: under jsdom `import.meta.url` is an http URL
// and `fileURLToPath` throws. Reading files cannot be fooled by a mock, and the property being
// asserted — "does any shipped file import this module" — IS textual.
//
// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const SRC = fileURLToPath(new URL("..", import.meta.url));

const isTest = (name: string) => /\.test\.tsx?$/.test(name);

/** Every .ts/.tsx under src, as repo-relative-ish paths plus a test/non-test split. */
function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) sources(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Every module specifier one source string names — static imports, `export … from`, dynamic
 *  `import()`, `require()`, `vi.mock()`, and `import x = require()`.
 *
 *  Parsed with the TypeScript AST rather than a regex, and every unknown FAILS LOUD, for the reason
 *  the sibling walker in `stores/keybindingsStore.rebindStandDown.test.ts` documents at length: this
 *  assertion is NEGATIVE ("no shipped file imports Composer"), so any specifier this silently drops
 *  turns the guard green. Under-reporting is indistinguishable from safety.
 *
 *  SPLIT OUT FROM THE FILE READ so a control can feed it a synthetic source covering every shape it
 *  claims to handle. Without that seam the controls could only ever exercise the shapes that happen to
 *  occur in the tree today — all of which are plain static imports — so deleting just the
 *  `CallExpression` branch left both controls green while the headline assertion stopped seeing
 *  `lazy(() => import("./Composer"))`, which is this codebase's house pattern for heavy panes and
 *  therefore the MOST likely shape a real re-mount would take (roborev 59601). The thing pinned is the
 *  thing used: `specifiersOf` below calls exactly this function. */
export function specifiersOfSource(src: string, label: string): string[] {
  // ScriptKind FROM THE EXTENSION, never a fixed TSX: under TSX a generic arrow `<V>(m) => …` in a
  // `.ts` file scans as a JSX opening element and `parseJsxChildren` swallows the rest of the file,
  // so the walker sees zero nodes and reports the file as importing nothing.
  const kind = label.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  // `setParentNodes: false` — nothing here reads `.parent`, and this walks the whole tree (~10 MB of
  // TS), where building parent pointers is pure cost against a 15s per-test timeout.
  const sf = ts.createSourceFile(label, src, ts.ScriptTarget.Latest, false, kind);

  // `createSourceFile` error-recovers instead of throwing, handing back a partial tree — walking that
  // is an under-count, so any parse diagnostic is fatal. `parseDiagnostics` is INTERNAL and
  // undeclared: its absence means a `typescript` bump deleted this check, which is itself a
  // "needs updating" condition rather than an empty array.
  const diags = (sf as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics;
  if (!Array.isArray(diags)) {
    throw new Error(`${label}: ts.SourceFile no longer exposes parseDiagnostics — walker needs updating`);
  }
  if (diags.length > 0) {
    throw new Error(`${label}: ${diags.length} parse error(s) — walker cannot trust this tree`);
  }

  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if (
      (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) &&
      n.moduleSpecifier &&
      ts.isStringLiteral(n.moduleSpecifier)
    ) {
      out.push(n.moduleSpecifier.text);
    }
    // `import Composer = require("./Composer")` is an ImportEqualsDeclaration wrapping an
    // ExternalModuleReference — NOT a CallExpression, so the branch below never sees it.
    if (
      ts.isImportEqualsDeclaration(n) &&
      ts.isExternalModuleReference(n.moduleReference) &&
      ts.isStringLiteral(n.moduleReference.expression)
    ) {
      out.push(n.moduleReference.expression.text);
    }
    // `import("./X")`, `require("./X")`, and `vi.mock("./X")` — a call whose callee is `import`,
    // `require`, or a `.mock` member, with a literal first argument.
    if (ts.isCallExpression(n)) {
      const arg = n.arguments[0];
      const callee = n.expression;
      const named =
        callee.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(callee) && callee.text === "require") ||
        (ts.isPropertyAccessExpression(callee) && callee.name.text === "mock");
      // A no-substitution template literal — `import(`./Composer`)` — is NOT a StringLiteral, and
      // `lazy(() => import(`./X`))` is a shape people write. One that HAS a substitution is genuinely
      // uncomputable from source and is documented as out of scope on `mightMention`.
      if (named && arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) {
        out.push(arg.text);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** Per-file caches. `importersOf` runs three times over overlapping cohorts, and re-reading and
 *  re-parsing the whole tree each time is ~32 MB of TypeScript for an answer that needs a fraction of
 *  that. Desktop's per-test timeout is **15s** with `retry: 2`, and a full-tree parse measured **19.4s**
 *  here — i.e. already over budget before any CI contention, which would red the gate with a timeout
 *  that names this file and says nothing about reachability (roborev 59601). */
const TEXT = new Map<string, string>();
const SPECS = new Map<string, string[]>();

function textOf(file: string): string {
  let hit = TEXT.get(file);
  if (hit === undefined) {
    hit = readFileSync(file, "utf8");
    TEXT.set(file, hit);
  }
  return hit;
}

function specifiersOf(file: string): string[] {
  let hit = SPECS.get(file);
  if (hit === undefined) {
    hit = specifiersOfSource(textOf(file), relative(SRC, file));
    SPECS.set(file, hit);
  }
  return hit;
}

/** Could `file` possibly name a module with this basename? A cheap literal test that lets the expensive
 *  parse be skipped for the overwhelming majority of files.
 *
 *  SOUND IN THE DIRECTION THAT MATTERS, which is the only reason it is allowed to exist in front of a
 *  negative assertion: to import a module whose basename is `Composer`, a file must contain the
 *  substring `Composer` somewhere in the specifier, so a file that does not contain it verbatim cannot
 *  be an importer. The one shape this reasoning excludes — a COMPUTED specifier such as
 *  `import("./Compo" + "ser")` or a template literal with a substitution — is not a `StringLiteral` and
 *  is therefore invisible to the walker itself, prefilter or no prefilter. That limit is inherent to
 *  reading source rather than resolving modules, and it is stated here rather than left to be
 *  rediscovered. */
const mightMention = (file: string, basename: string) => textOf(file).includes(basename);

/** Does `spec` name a module with this basename? Exported so a control can pin the matcher directly.
 *
 *  The extension is stripped first: a bundler-legal `"./Composer.tsx"` would otherwise slip past the
 *  `(^|/)Composer$` anchor, which is an under-report in the direction that turns this guard green. */
export function matchesBasename(spec: string, basename: string): boolean {
  return new RegExp(`(^|/)${basename}$`).test(spec.replace(/\.[jt]sx?$/, ""));
}

/** Files whose specifiers name a module with this basename (e.g. "./Composer", "../components/Composer"). */
function importersOf(basename: string, files: string[]): string[] {
  return files
    .filter(
      (f) => mightMention(f, basename) && specifiersOf(f).some((s) => matchesBasename(s, basename)),
    )
    .map((f) => relative(SRC, f));
}

const ALL = sources(SRC);
const NON_TEST = ALL.filter((f) => !isTest(f));
const TESTS = ALL.filter((f) => isTest(f));

describe("components/Composer is unreachable from the shipped app", () => {
  // THE POSITIVE CONTROLS COME FIRST, on purpose. The assertion this file exists for is negative, so
  // a walker that quietly finds nothing would satisfy it perfectly. These two prove the walker can see
  // both of the things it would have to miss: the specifier shape, and the non-test cohort.
  it("resolves EVERY specifier shape it claims to cover (control)", () => {
    // The control that matters most, and the one that was missing. Every `Composer` importer in the
    // tree today is a plain static import, so a control drawn from real files can only ever prove that
    // one branch — leaving the dynamic-`import()` branch unproven while it is the shape a real
    // re-mount would most likely use (`lazy(() => import("./Composer"))`, the house pattern for heavy
    // panes; cf. the lazy `AgentPane` note in vite.config.ts). A synthetic source pins all of them.
    const probe = [
      'import A from "./A";',
      'export * from "./B";',
      'const c = () => import("./C");',
      'const d = require("./D");',
      'vi.mock("./E", () => ({}));',
      'import F = require("./F");',
      "const g = () => import(`./G`);",
    ].join("\n");

    expect([...specifiersOfSource(probe, "probe.ts")].sort()).toEqual([
      "./A",
      "./B",
      "./C",
      "./D",
      "./E",
      "./F",
      "./G",
    ]);
  });

  it("the basename matcher is not fooled by a file extension (control)", () => {
    // `"./Composer.tsx"` is bundler-legal and would sail past a bare `(^|/)Composer$` anchor — an
    // under-report in the only direction that matters, since it makes the headline assertion pass.
    expect(matchesBasename("./Composer", "Composer")).toBe(true);
    expect(matchesBasename("../components/Composer.tsx", "Composer")).toBe(true);
    expect(matchesBasename("./Composer.js", "Composer")).toBe(true);
    // …and still anchored: a longer name that merely starts with it must NOT match.
    expect(matchesBasename("./ComposerMic", "Composer")).toBe(false);
    expect(matchesBasename("./composer/AttachmentRow", "Composer")).toBe(false);
  });

  it("the walker really does resolve this specifier shape (control)", () => {
    // If this drops below the eleven suites that render <Composer>, the matcher is broken and the
    // headline assertion below is worthless.
    const testImporters = importersOf("Composer", TESTS);
    expect(testImporters.length).toBeGreaterThanOrEqual(11);
    expect(testImporters).toContain("components/Composer.dictation.test.tsx");
  });

  it("the walker really does read the non-test cohort (control)", () => {
    // Same walker, same cohort as the headline assertion, on a module that IS live. A non-test scan
    // that returns nothing for ComposeBox is not evidence about Composer — it is a broken scan.
    expect(NON_TEST.length).toBeGreaterThan(100);
    expect(importersOf("ComposeBox", NON_TEST).length).toBeGreaterThan(0);
  });

  it("no shipped file imports it — so its eleven suites cover nothing a user can reach", () => {
    expect(importersOf("Composer", NON_TEST)).toEqual([]);
  });
});
