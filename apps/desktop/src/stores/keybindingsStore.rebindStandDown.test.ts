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

/** Files registering a CAPTURE-phase keydown listener on a global target — the cohort that can
 *  outrun the recorder. A bubble-phase or element-scoped listener is not in this failure mode.
 *
 *  Matches ANY receiver, not literally `window.`, and that over-inclusiveness is the point: the
 *  first version of this anchored on `window.` and silently missed `inputFreezeTrace.ts`, which
 *  aliases the receiver (`const win = window` … `win.addEventListener`). Strictly, only same-node
 *  (window) capture listeners outrun a window/capture recorder — a document/capture one runs after
 *  it and IS stopped by its stopPropagation. But the asymmetry favours over-matching: a false
 *  positive costs one EXEMPT line with a reason, while a false negative silently reintroduces the
 *  bug this file exists to prevent. */
function windowCaptureKeydownFiles(): string[] {
  return sources(SRC)
    .filter((f) =>
      /[A-Za-z_$][\w$]*\.addEventListener\(\s*"keydown"[^)]*,\s*true\s*\)/.test(readFileSync(f, "utf8")),
    )
    .map((f) => f.slice(SRC.length).replace(/\\/g, "/"))
    .sort();
}

describe("the rebind stand-down contract covers every global keydown handler", () => {
  it("finds the known handlers — a zero-match regex would make every assertion below vacuous", () => {
    // Without this, a typo in the detector turns the whole suite green while proving nothing.
    const files = windowCaptureKeydownFiles();
    expect(files.length).toBeGreaterThanOrEqual(5);
    expect(files).toContain("hooks/useSettingsShortcut.ts");
    expect(files).toContain("keyboardHints/useHintMode.ts");
    expect(files).toContain("components/Concierge/useCommandPalette.ts");
  });

  it("every window/capture keydown handler either stands down or is explicitly exempt", () => {
    const unguarded = windowCaptureKeydownFiles().filter(
      (rel) => !(rel in EXEMPT) && !readFileSync(join(SRC, rel), "utf8").includes("isRebinding()"),
    );
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
    const live = new Set(windowCaptureKeydownFiles());
    expect(Object.keys(EXEMPT).filter((f) => !live.has(f))).toEqual([]);
  });
});
