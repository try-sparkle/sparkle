// Every window/capture keydown listener must have DECIDED about `isRebinding()`.
//
// The defect this guards (roborev 55310, then 55487) is structural and it recurs. A global chord
// handler on `window` in the capture phase, registered at mount, runs BEFORE the Shortcuts pane's
// "Press a key…" recorder — which registers on click — and `stopPropagation` does not stop other
// listeners on the same node, nor does `stopImmediatePropagation` reach an EARLIER one. So the
// recorder cannot defend itself. Standing down by reading `capturingShortcut` is the only mechanism
// that works, and it has to be added to each handler by hand.
//
// Fixing ⌘, alone left the identical bug in two other handlers, and the miss was invisible: the
// symptom is "recording a binding also triggered the thing I was rebinding", which nobody traces to
// a missing line in an unrelated hook. Worse, the FIRST row of the Shortcuts pane is `toggleHints`,
// whose default is a bare Control tap — so the handler most likely to be hit was the one nobody
// thought of. A comment cannot enforce this; an enumeration can.
//
// The test is deliberately closed rather than heuristic: every file that registers a capture-phase
// window keydown must either call `isRebinding()` or appear in EXEMPT with a reason. A new handler
// therefore fails until someone classifies it, which is the whole point — the default for a new
// global key listener should be "prove you thought about this", not "silently inherit the bug".
//
// Source-read, so node environment (under jsdom `import.meta.url` is an http URL and fileURLToPath
// throws). Reading files cannot be fooled by mocks, and the property being checked IS textual.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const SRC = fileURLToPath(new URL("..", import.meta.url));

/** Handlers that legitimately need no stand-down, each with the reason it cannot misfire during a
 *  capture. Adding an entry is a claim someone can check; leaving a file out of both this list and
 *  the guard is the bug. */
const EXEMPT: Record<string, string> = {
  "components/KeyboardShortcutsMenu.tsx":
    "IS the recorder — it owns capturingShortcut and must receive the keys being recorded.",
  "components/HintOverlay.tsx":
    "label-key selection, and it returns early on any modifier (Meta/Ctrl/Alt) so it cannot match a " +
    "chord; it also only listens while the overlay is open, which useHintMode's stand-down prevents.",
  "components/composer/ModalOverlay.tsx":
    "Escape only, never a chord. Escape during a capture is the recorder's own cancel gesture, and " +
    "this overlay is not open behind the Shortcuts pane (Settings uses ModalShell).",
  "diagnostics/inputFreezeTrace.ts":
    "read-only diagnostic — logs and returns, calls no action, no preventDefault/stopPropagation.",
};

/** Every .ts/.tsx under src, excluding tests. */
function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      sources(full, out);
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** The parse errors on a SourceFile, throwing if TypeScript stops exposing them.
 *
 *  `parseDiagnostics` is an INTERNAL, undeclared property. A `?? []` at the call site would let a
 *  future `typescript` bump delete the parse-error guard silently — the property vanishes, the array
 *  reads as empty, mis-parsed files go back to contributing 0, and the whole suite stays green
 *  (roborev 56039). Its ABSENCE is itself a "detector needs updating" condition.
 *
 *  Split out and exported so the absence can be pinned by a test: `ts` is an ESM namespace and cannot
 *  be spied on ("Cannot redefine property: createSourceFile"), so the seam has to be here. This is the
 *  function `countCaptureKeyListeners` actually calls — the thing pinned is the thing used. */
export function parseDiagnosticsOf(sf: ts.SourceFile, fileLabel: string): ts.Diagnostic[] {
  const diags = (sf as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics;
  if (!Array.isArray(diags)) {
    throw new Error(
      `${fileLabel}: ts.SourceFile no longer exposes parseDiagnostics — the capture-listener detector needs updating`,
    );
  }
  return diags;
}

/** Count capture-phase key-listener registrations in one source string, via the TypeScript AST.
 *
 *  THIS USED TO BE A HAND-ROLLED SCANNER, and it was wrong five times running — each fix locally
 *  correct and each producing the next variant: a character class that could not cross `)`; a scan
 *  delimited by the wrong `;`; a fallback widening to end-of-file (over-count); a skip replacing it
 *  (under-count); and a literal/comment mask that was itself code-unit/code-point misaligned and read
 *  a JSX text apostrophe as a string opener (under-count again). Lexing TS+JSX correctly needs a real
 *  parser, and one is already a dependency.
 *
 *  EVERY UNKNOWN FAILS LOUD. That is the whole design rule here, because all six defects in this
 *  detector's history failed in the same direction: a dropped registration means its file never enters
 *  the cohort, so the stand-down assertion never applies to it and a new handler inherits the bug with
 *  NO diagnostic. An over-count costs one EXEMPT line with a reason; an under-count costs a silent
 *  regression. So anything this cannot classify throws "detector needs updating" rather than being
 *  quietly treated as "not a capture-phase key listener" (roborev 55805).
 *
 *  DELIBERATELY OVER-INCLUSIVE on the receiver: `x.addEventListener`, `x["addEventListener"]` and a
 *  bare `addEventListener(...)` all count. Strictly, only same-node (window) capture listeners outrun
 *  a window/capture recorder, but a false positive is cheap and a false negative is not.
 *
 *  Exported because the probe tests exercise this exact function — the thing pinned is the thing used. */
export function countCaptureKeyListeners(src: string, fileLabel = "probe.tsx"): number {
  // ScriptKind FROM THE EXTENSION, never a fixed TSX. Under TSX, TS-only syntax that is legal in a
  // `.ts` file — a generic arrow `<V>(m) => …`, an angle-bracket cast — scans as a JSX opening element
  // and `parseJsxChildren` then swallows the rest of the file as JsxText, so no CallExpression after
  // it is visible at all. That is live in this repo: forcing TSX on `stores/runtimeStore.ts` (which has
  // `const pruneMap = <V>(m: Record<string, V>) => …`) yields 37 parse errors and 0 under TS.
  const kind = fileLabel.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileLabel, src, ts.ScriptTarget.Latest, false, kind);

  // ANNOTATED ON THE VARIABLE, not just on the arrow. A never-returning call only narrows the code
  // after it when the callee is a const with an explicit type annotation — with the `: never` on the
  // arrow alone, TypeScript treats `bail(...)` as an ordinary call and the guards below stop
  // narrowing (four TS2345/TS2339 errors, which is how this was caught).
  const bail: (why: string) => never = (why) => {
    throw new Error(`${fileLabel}: ${why} — the capture-listener detector needs updating`);
  };

  // `createSourceFile` does NOT throw on a syntax error — it error-recovers and hands back a partial,
  // wrong tree. Silently walking that is an under-count, so any parse diagnostic is fatal here.
  const diags = parseDiagnosticsOf(sf, fileLabel);
  if (diags.length > 0) {
    const first = diags[0] as ts.Diagnostic;
    throw new Error(
      `${fileLabel}: failed to parse (${ts.flattenDiagnosticMessageText(first.messageText, " ")}) — the capture-listener detector needs updating`,
    );
  }

  // Same-file `const NAME = "literal"`, so a registration written against a local constant can still
  // be classified instead of throwing.
  //
  // UNAMBIGUOUS BINDINGS ONLY. This map is flat and name-keyed — it has no notion of scope — so a
  // name declared twice (two `const E` in sibling functions) or declared with `let`/`var` and
  // reassigned would resolve to whichever declaration the walk saw LAST. That is the one path that
  // slips past `bail`: a wrong-but-non-null answer is not null, so `"click"` gets returned for a real
  // `"keydown"` registration and the count silently drops to 0 (roborev 56039). A name that is not
  // provably one thing is therefore recorded as AMBIGUOUS, which resolves to null and bails.
  //
  // EVERY BINDING FORM COUNTS, not just `const`/`let`/`var` (roborev 56055). A parameter, an import,
  // a destructured element, a function/class declaration and a `catch` binding all introduce a name
  // that can shadow a trusted const, and the first version of this saw NONE of them — so
  // `function a() { const { E } = opts; …addEventListener(E, onKey, true) }` beside
  // `function b() { const E = "click"; }` still resolved to "click" and still silently counted 0.
  // The map has to see every DECLARATION, not every assignment.
  const stringConsts = new Map<string, string>();
  const ambiguous = new Set<string>();
  const markAmbiguous = (name: string): void => {
    ambiguous.add(name);
    stringConsts.delete(name);
  };
  /** Every identifier a binding introduces, including nested destructuring. */
  const eachBound = (name: ts.BindingName | undefined, visit: (id: string) => void): void => {
    if (!name) return;
    if (ts.isIdentifier(name)) {
      visit(name.text);
      return;
    }
    for (const el of name.elements) {
      if (ts.isBindingElement(el)) eachBound(el.name, visit);
    }
  };
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclarationList(node)) {
      const isConst = (node.flags & ts.NodeFlags.Const) !== 0;
      for (const d of node.declarations) {
        if (!ts.isIdentifier(d.name)) {
          // A destructured binding is never a string literal — but it still DECLARES the name, which
          // is the part the first version missed.
          eachBound(d.name, markAmbiguous);
          continue;
        }
        const name = d.name.text;
        if (stringConsts.has(name) || ambiguous.has(name)) {
          // Seen before under some other scope — this file cannot tell them apart.
          markAmbiguous(name);
        } else if (isConst && d.initializer && ts.isStringLiteralLike(d.initializer)) {
          stringConsts.set(name, d.initializer.text);
        } else {
          // `let`/`var` can be reassigned, and a non-literal initializer is unreadable either way.
          markAmbiguous(name);
        }
      }
    } else if (ts.isParameter(node)) {
      eachBound(node.name, markAmbiguous);
    } else if (ts.isCatchClause(node)) {
      eachBound(node.variableDeclaration?.name, markAmbiguous);
    } else if (
      ts.isImportSpecifier(node) ||
      ts.isNamespaceImport(node) ||
      ts.isImportClause(node) ||
      ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node)
    ) {
      // None of these can be proved to hold a string literal, so seeing the name at all is enough.
      if (node.name && ts.isIdentifier(node.name)) markAmbiguous(node.name.text);
    }
    ts.forEachChild(node, collect);
  };
  collect(sf);

  /** The event name, or null when it cannot be resolved from this file alone. */
  const eventNameOf = (arg: ts.Expression | undefined): string | null => {
    if (arg === undefined) return null;
    if (ts.isStringLiteralLike(arg)) return arg.text;
    if (ts.isIdentifier(arg)) return ambiguous.has(arg.text) ? null : (stringConsts.get(arg.text) ?? null);
    return null;
  };

  /** Is this third argument a CAPTURE-phase registration? Throws when it cannot tell. */
  const isCapture = (opts: ts.Expression): boolean => {
    if (opts.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (opts.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (ts.isObjectLiteralExpression(opts)) {
      for (const prop of opts.properties) {
        // A shorthand (`{ capture }`), a spread (`{ ...opts }`) or a computed key can all carry
        // `capture` and cannot be read off the syntax — these used to fall through to "bubble".
        if (!ts.isPropertyAssignment(prop)) {
          bail(`addEventListener options use ${ts.SyntaxKind[prop.kind]}, which may carry \`capture\``);
        }
        const key = prop.name;
        if (!ts.isIdentifier(key) && !ts.isStringLiteral(key)) {
          bail("addEventListener options have a computed key, which may be `capture`");
        }
        if (key.text !== "capture") continue;
        if (prop.initializer.kind === ts.SyntaxKind.TrueKeyword) return true;
        if (prop.initializer.kind === ts.SyntaxKind.FalseKeyword) return false;
        bail("addEventListener options have a non-literal `capture`");
      }
      return false; // every property was a resolvable, non-`capture` literal key
    }
    bail("addEventListener third argument is not a literal");
    return false; // unreachable; `bail` returns never
  };

  /** Does this callee name `addEventListener`, in any of the shapes it can be written? */
  const isAddEventListener = (e: ts.Expression): boolean =>
    (ts.isPropertyAccessExpression(e) && e.name.text === "addEventListener") ||
    (ts.isElementAccessExpression(e) &&
      e.argumentExpression !== undefined &&
      ts.isStringLiteralLike(e.argumentExpression) &&
      e.argumentExpression.text === "addEventListener") ||
    (ts.isIdentifier(e) && e.text === "addEventListener");

  let count = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isAddEventListener(node.expression)) {
      // A SPREAD makes arity unknowable, so nothing positional below can be trusted. `f(...args)`
      // leaves `opts` undefined and would be classified bubble-phase even though the spread may well
      // contain `true` — silent, and in the same direction as every prior defect (roborev 56039).
      if (node.arguments.some(ts.isSpreadElement)) {
        bail("addEventListener arguments include a spread, so the phase cannot be read positionally");
      }
      const [event, , opts] = node.arguments;
      const name = eventNameOf(event);
      // PHASE FIRST, deliberately. With no third argument the registration is bubble-phase and cannot
      // be in this failure mode whatever it listens to — which is what keeps an unresolvable event
      // name from throwing on the two real bubble-phase dynamic listeners in this repo. Only a
      // registration that could be capture-phase needs its event name known.
      if (opts !== undefined) {
        if (name === null) {
          bail("addEventListener has an unresolvable event name and a third argument");
        }
        if ((name === "keydown" || name === "keyup") && isCapture(opts)) count++;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return count;
}

function captureKeyRegistrations(): { file: string; count: number }[] {
  const out: { file: string; count: number }[] = [];
  for (const f of sources(SRC)) {
    const rel = f.slice(SRC.length).replace(/\\/g, "/");
    // Pass the real path so a "detector needs updating" throw names the file to go look at.
    const count = countCaptureKeyListeners(readFileSync(f, "utf8"), rel);
    if (count > 0) out.push({ file: rel, count });
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

function captureKeyFiles(): string[] {
  return captureKeyRegistrations().map((r) => r.file);
}

describe("the rebind stand-down contract covers every global keydown handler", () => {
  it("finds the known handlers — a zero-match regex would make every assertion below vacuous", () => {
    // Without this, a typo in the detector turns the whole suite green while proving nothing.
    const files = captureKeyFiles();
    expect(files.length).toBeGreaterThanOrEqual(5);
    expect(files).toContain("hooks/useSettingsShortcut.ts");
    expect(files).toContain("keyboardHints/useHintMode.ts");
    expect(files).toContain("components/Concierge/useCommandPalette.ts");
  });

  it("detects the inline-handler, keyup and {capture:true} forms a `, true)`-only scan would miss", () => {
    // Pins the three false-negative classes shut. These are not hypothetical spellings — the first
    // detector missed a real file for reason 1, and reason 3 is the half that carries a TAP binding.
    const probe = countCaptureKeyListeners;
    // The inline form — note the `;` INSIDE the handler body, which a scan-to-semicolon misses.
    expect(probe('window.addEventListener("keydown", (e) => { f(e); }, true);')).toBe(1);
    expect(probe('window.addEventListener("keyup", onKeyUp, true);')).toBe(1);
    expect(probe('window.addEventListener("keydown", onKey, { capture: true });')).toBe(1);
    expect(probe('win.addEventListener("keydown", onKey, true);')).toBe(1);
    // Two registrations in one string must count as two — this is what makes the per-handler
    // requirement below meaningful rather than a per-file substring check.
    expect(
      probe('window.addEventListener("keydown", a, true);\nwindow.addEventListener("keyup", b, true);'),
    ).toBe(2);
    // Still ignores the bubble phase, which is not in this failure mode.
    expect(probe('window.addEventListener("keydown", onKey);')).toBe(0);
    expect(probe('window.addEventListener("keydown", onKey, { capture: false });')).toBe(0);
    // The match is inside a STRING — prose about a listener, not a listener. It must not count, and
    // must not derail the scan into the later `capture: true` either.
    expect(
      probe('const s = \'addEventListener("keydown", ( \';\nconst o = { capture: true };'),
    ).toBe(0);
    // THE UNDER-COUNT CASE (roborev 55611). A REAL registration whose handler body holds a stray `(`
    // inside a string must still count as 1. Skipping it would drop the file from the cohort
    // entirely, so the stand-down assertion would never apply to it — a silent false negative, the
    // one direction this detector cannot tolerate.
    expect(probe('window.addEventListener("keydown", (e) => { log("oops ("); }, true);')).toBe(1);
    // …and the same for a comment holding one.
    expect(probe('window.addEventListener("keydown", onKey /* not ( yet */, true);')).toBe(1);
    // `capture: true` written inside a string is not an option object.
    expect(
      probe('window.addEventListener("keydown", onKey, { capture: false });\nconst s = "capture: true";'),
    ).toBe(0);
    // Formatting must not matter either — the old scanner keyed on `, true)` being adjacent.
    expect(probe('window.addEventListener(\n  "keydown",\n  onKey,\n  true,\n);')).toBe(1);
  });

  // roborev 55792 — the three cases that defeated the hand-rolled lexer this replaced. Each is
  // ordinary code, not a contrived spelling, and each silently DROPPED a real registration before.
  it("counts registrations in files the hand-rolled lexer desynced on", () => {
    const probe = countCaptureKeyListeners;
    // A JSX text apostrophe. The old mask read it as a string opener and masked arbitrary real code
    // after it — including, potentially, a genuine registration.
    expect(
      probe(
        'const A = () => <div>Couldn\'t start this agent</div>;\nwindow.addEventListener("keydown", onKey, true);',
      ),
    ).toBe(1);
    // A regex literal containing `//`, which flipped the old scanner into line-comment state.
    expect(
      probe('const re = /https:\\/\\//;\nwindow.addEventListener("keydown", onKey, true);'),
    ).toBe(1);
    // A regex literal containing an unmatched paren — nothing to balance, and no longer relevant.
    expect(probe('const re = /\\(/;\nwindow.addEventListener("keyup", onKey, true);')).toBe(1);
    // An ASTRAL character. `Array.from` iterates code POINTS while the old mask was built by code
    // UNITS, so every index after this shifted — and 6 non-test files under src/ contain one.
    expect(probe('const emoji = "\u{1F680}";\nwindow.addEventListener("keydown", onKey, true);')).toBe(1);
  });

  // roborev 55805 — the AST rewrite closed the lexing holes but opened new silent ones. Every case
  // below was previously counted as ZERO with no diagnostic, which is the same under-count in a new
  // costume: a dropped registration means its file never enters the cohort at all.
  it("parses .ts as TS — forcing TSX swallows the rest of the file as JSX", () => {
    // A generic arrow is legal in .ts and scans as a JSX opening element under TSX, after which
    // parseJsxChildren consumes everything to EOF as JsxText — so no later call is even visible.
    // Live in this repo: stores/runtimeStore.ts has exactly this, and forcing TSX on it yields 37
    // parse errors versus 0 under TS.
    const src = 'const pruneMap = <V>(m: Record<string, V>) => m;\nwindow.addEventListener("keydown", onKey, true);';
    expect(countCaptureKeyListeners(src, "stores/thing.ts")).toBe(1);
    // The same source under a .tsx label is genuinely a parse error, and must SAY so rather than
    // silently returning 0.
    expect(() => countCaptureKeyListeners(src, "components/Thing.tsx")).toThrow(/failed to parse/);
  });

  it("counts the callee shapes an AST walk can otherwise miss", () => {
    const probe = countCaptureKeyListeners;
    // Receiverless — valid in a browser/jsdom scope, and the OLD regex detector matched it.
    expect(probe('addEventListener("keydown", onKey, true);', "x.ts")).toBe(1);
    // Element access with a string-literal key.
    expect(probe('window["addEventListener"]("keydown", onKey, true);', "x.ts")).toBe(1);
    // An event name held in a same-file const still resolves rather than throwing.
    expect(probe('const E = "keydown";\nwindow.addEventListener(E, onKey, true);', "x.ts")).toBe(1);
    // …and a non-key one resolves to "not ours" rather than being counted.
    expect(probe('const E = "click";\nwindow.addEventListener(E, onKey, true);', "x.ts")).toBe(0);
    // A BUBBLE-phase registration with an unresolvable (imported) event name is safe to ignore — it
    // cannot be in this failure mode whatever it listens to. Both real cases in this repo are this.
    expect(probe('window.addEventListener(IMPORTED_EVENT, refetch);', "x.ts")).toBe(0);
  });

  it("throws on an options object whose `capture` cannot be read off the syntax", () => {
    // All three used to fall through to "bubble-phase" silently.
    expect(() =>
      countCaptureKeyListeners('window.addEventListener("keydown", h, { capture });', "x.ts"),
    ).toThrow(/detector needs updating/);
    expect(() =>
      countCaptureKeyListeners('window.addEventListener("keydown", h, { ...listenerOpts });', "x.ts"),
    ).toThrow(/detector needs updating/);
    expect(() =>
      countCaptureKeyListeners('window.addEventListener("keydown", h, { ["cap" + "ture"]: true });', "x.ts"),
    ).toThrow(/detector needs updating/);
    // An options object with only resolvable non-capture keys is genuinely bubble-phase.
    expect(countCaptureKeyListeners('window.addEventListener("keydown", h, { passive: true });', "x.ts")).toBe(0);
  });

  it("throws when an unresolvable event name is paired with a third argument", () => {
    // Here the phase COULD be capture, so "not a key event" is a guess in the under-count direction.
    expect(() =>
      countCaptureKeyListeners('window.addEventListener(IMPORTED_EVENT, onKey, true);', "x.ts"),
    ).toThrow(/detector needs updating/);
  });

  // roborev 56039 — three residual paths that still answered 0 instead of throwing. The first is the
  // nastiest of the whole series: every other hole returned null and hit `bail`, but a name resolved
  // against the WRONG declaration returns a non-null string, so it sails past the guard and answers
  // with some other event's name.
  it("refuses to resolve an event name that is not provably one thing", () => {
    const probe = countCaptureKeyListeners;
    // Two same-named consts in sibling scopes. The map is flat, so last-seen used to win — here that
    // is "click", and a real capture-phase keydown registration silently became 0.
    expect(() =>
      probe(
        'function a() { const E = "keydown"; window.addEventListener(E, onKey, true); }\n' +
          'function b() { const E = "click"; el.addEventListener(E, h); }',
        "x.ts",
      ),
    ).toThrow(/detector needs updating/);
    // Reassignment, same failure: `let` is not a promise about the value at the call site.
    expect(() =>
      probe('let E = "click";\nE = "keydown";\nwindow.addEventListener(E, onKey, true);', "x.ts"),
    ).toThrow(/detector needs updating/);
    // The baseline that keeps the above from passing because resolution broke outright: a single
    // unambiguous const must still resolve.
    expect(probe('const E = "keydown";\nwindow.addEventListener(E, onKey, true);', "x.ts")).toBe(1);
  });

  // roborev 56055 — the ambiguity map above only watched `const`/`let`/`var`, so every OTHER way to
  // introduce a name was invisible to it and could still shadow a trusted const. Each case below
  // resolved to the wrong string and answered 0.
  it("treats a name introduced by any other binding form as ambiguous too", () => {
    const probe = countCaptureKeyListeners;
    // A DESTRUCTURED binding. The old code skipped it because the VALUE is unreadable, which is true
    // and beside the point — it still declares the name.
    expect(() =>
      probe(
        'function a() { const { E } = opts; window.addEventListener(E, onKey, true); }\n' +
          'function b() { const E = "click"; }',
        "x.ts",
      ),
    ).toThrow(/detector needs updating/);
    // A PARAMETER.
    expect(() =>
      probe(
        'const EVENT = "click";\nfunction attach(EVENT: string) { window.addEventListener(EVENT, h, true); }',
        "x.ts",
      ),
    ).toThrow(/detector needs updating/);
    // An IMPORT — the shape both real dynamic-event files in this repo actually use.
    expect(() =>
      probe(
        'import { E } from "./x";\nfunction b() { const E = "click"; }\nwindow.addEventListener(E, h, true);',
        "x.ts",
      ),
    ).toThrow(/detector needs updating/);
    // A CATCH binding.
    expect(() =>
      probe(
        'const E = "click";\ntry { x(); } catch (E) { window.addEventListener(E, h, true); }',
        "x.ts",
      ),
    ).toThrow(/detector needs updating/);
    // A FUNCTION declaration.
    expect(() =>
      probe('const E = "click";\nfunction E2() {}\nfunction E() {}\nwindow.addEventListener(E, h, true);', "x.ts"),
    ).toThrow(/detector needs updating/);
    // Still not over-strict: a const nobody shadows resolves, and an unrelated binding of a DIFFERENT
    // name does not poison it. Without this the assertions above could pass by throwing on everything.
    expect(
      probe('import { other } from "./x";\nconst E = "keydown";\nfunction f(p) { return p; }\nwindow.addEventListener(E, h, true);', "x.ts"),
    ).toBe(1);
  });

  it("throws on a spread in the argument list rather than reading arity positionally", () => {
    // `arguments` is [SpreadElement], so `opts` is undefined and this read as bubble-phase — even
    // though `args` may be exactly ["keydown", onKey, true].
    expect(() => countCaptureKeyListeners("window.addEventListener(...args);", "x.ts")).toThrow(
      /detector needs updating/,
    );
    // A TRAILING spread hit `isCapture` and bailed already; pinned so it stays loud for the stated
    // reason (unreadable arity) rather than by accident.
    expect(() =>
      countCaptureKeyListeners('window.addEventListener("keydown", h, ...rest);', "x.ts"),
    ).toThrow(/detector needs updating/);
  });

  it("throws if TypeScript stops exposing parseDiagnostics", () => {
    // The parse-error guard reads an INTERNAL API. A `?? []` there would let a typescript bump delete
    // the guard silently — property gone, array empty, mis-parsed files back to contributing 0, suite
    // still green. Asserted on the exact function `countCaptureKeyListeners` calls, since `ts` is an
    // ESM namespace and cannot be mocked ("Cannot redefine property: createSourceFile").
    const sf = ts.createSourceFile("x.ts", "const a = 1;", ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
    // The property is there today, and the guard passes it through.
    expect(parseDiagnosticsOf(sf, "x.ts")).toEqual([]);

    // A future typescript that no longer exposes it must be LOUD, not empty.
    delete (sf as unknown as { parseDiagnostics?: unknown }).parseDiagnostics;
    expect(() => parseDiagnosticsOf(sf, "x.ts")).toThrow(/no longer exposes parseDiagnostics/);
  });

  it("throws rather than under-reporting when it cannot determine the phase", () => {
    // The escape hatch has to be loud. A call it cannot classify, if merely SKIPPED, would drop its
    // file out of the cohort, and the assertion below would then pass by never looking at it.
    expect(() =>
      countCaptureKeyListeners('window.addEventListener("keydown", onKey, OPTIONS);'),
    ).toThrow(/detector needs updating/);
    // …and likewise for an options object whose `capture` is computed rather than literal.
    expect(() =>
      countCaptureKeyListeners('window.addEventListener("keydown", onKey, { capture: wantsCapture });'),
    ).toThrow(/detector needs updating/);
  });

  it("every capture-phase key handler either stands down or is explicitly exempt", () => {
    // PER REGISTRATION, not per file: a whole-file substring test would excuse a file's second,
    // unguarded handler because its first one is guarded.
    const unguarded = captureKeyRegistrations().filter(({ file, count }) => {
      if (file in EXEMPT) return false;
      const guards = readFileSync(join(SRC, file), "utf8").match(/isRebinding\(\)/g)?.length ?? 0;
      return guards < count;
    });
    expect(unguarded).toEqual([]);
  });

  it("the three chord handlers really do call it — not just import it", () => {
    // Named individually so the failure says WHICH handler regressed, rather than "the set changed".
    for (const rel of [
      "hooks/useSettingsShortcut.ts",
      "keyboardHints/useHintMode.ts",
      "components/Concierge/useCommandPalette.ts",
    ]) {
      const src = readFileSync(join(SRC, rel), "utf8");
      expect(src, rel).toMatch(/if \(isRebinding\(\)\) return;/);
    }
  });

  it("useHintMode guards keyUP as well as keydown — a tap needs both", () => {
    // toggleHints' default is a TAP: press+release of a lone modifier. Guarding only keydown would
    // let a tap that began before the capture started still complete and pop the overlay.
    const src = readFileSync(join(SRC, "keyboardHints/useHintMode.ts"), "utf8");
    expect(src.match(/if \(isRebinding\(\)\) return;/g)).toHaveLength(2);
  });

  it("EXEMPT lists no file that has stopped registering such a listener", () => {
    // A stale exemption is a silent hole: the file could regain a chord handler and stay excused.
    const live = new Set(captureKeyFiles());
    expect(Object.keys(EXEMPT).filter((f) => !live.has(f))).toEqual([]);
  });
});
