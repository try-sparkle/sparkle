// ── EVERY APP-MODAL SCRIM REACHES THE ROOT LAYER, INCLUDING THE ONE NOBODY HAS WRITTEN YET ─────
//
// `ModalLayer.wiring.test.tsx` renders the real settings dialog inside the real concierge column and
// proves THAT modal escapes. It is the test that would have caught the bug. It is also, by
// construction, a test of one modal: nobody writes a wiring test for the dialog they are about to
// add, which is exactly how six dialogs stayed nested after `composer/ModalOverlay` had already
// worked the problem out and written the reasoning down.
//
// So this reads the source instead — the thing the next person actually types. Same bargain, and the
// same shape, as `modalChrome.test.ts`: a per-component render test cannot catch the seventh copy.
//
// WHAT IT BANS, precisely: a component that paints its own full-bleed `position: fixed` scrim and
// takes pointer events — an APP-MODAL backdrop — without routing through `ModalLayer`. Such a
// component's z-index is not a promise, it is a hope: it holds only while nobody gives an ancestor a
// stacking context, and `ConciergeColumn` gave one to the concierge for reasons that had nothing to
// do with modals.
//
// The backdrop is recognised by its DECLARED backdrop background, and that is two shapes, not one:
//   • the visible SCRIM token — the dim veil the known modals paint; and
//   • a background that is DECLARED but renders INVISIBLE — `transparent`, `none`, or `undefined` (a
//     scrim whose colour token never resolved). Same full-bleed pointer-taking geometry, so it eats
//     every click across the viewport while looking like nothing is there. An invisible click-catcher
//     is a MORE dangerous layering bug than a visible one, not a lesser one, and keying the guard on
//     the visible colour let it slip straight through (bead sparkle-51ykk). The signal is the
//     pointer-taking full-bleed geometry plus a declared backdrop background — not the colour.
//
// WHAT IT DELIBERATELY DOES NOT BAN, because a guard that flags legitimate work gets deleted:
//
//   • A `pointerEvents: "none"` full-bleed scrim. That is a DECORATIVE veil, not a modal — it
//     captures nothing and blocks nothing, so being out-ranked by a pull tab is a cosmetic question
//     rather than a broken modality. `SparkleOverlay`'s dim veil (zIndex 39) is the live example and
//     is correct as it stands.
//   • A full-bleed pointer-taking layer that DECLARES NO background at all. That is the scoped
//     dismiss backdrop for a menu — `AgentPane`, `OpenPrMenu`, `HelperApp`, `CaptureApp` and
//     `ModelPill` each render one — a lightweight click-catcher paired with its popup, not an app
//     modal. Omitting the background is the tell that it never meant to be a scrim; the invisible
//     click-catcher above is caught because it DECLARES one that happens to be invisible. Absent and
//     transparent look identical on screen but read as opposite intent in the source, and the source
//     is all this scanner has.
//   • `position: "absolute"` overlays. Those are scoped to a container ON PURPOSE — `BoardView`'s
//     bead detail dims the board it belongs to, not the app — and portaling one would be the bug.
//   • Consumers of `ModalShell` / `composer/ModalOverlay`. They inherit the layer from the shell,
//     which is the whole reason those shells exist; only a component painting its OWN scrim is asked
//     to name `ModalLayer` itself.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ROOTED AT THE APP SOURCE DIR, not at this test's own directory. It was `"."`, which scans only
// `components/` — so `src/App.tsx`, `src/capture/CaptureApp.tsx`, `src/satellite/SatelliteApp.tsx`,
// `src/helper/HelperApp.tsx` and every other surface outside this folder were invisible to the guard
// that exists to catch exactly them. The non-vacuity floor did not notice either, because all six
// known modals happen to live here (roborev 55317).
const SRC = fileURLToPath(new URL("..", import.meta.url));

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (/\.tsx?$/.test(name) && !name.includes(".test.")) out.push(p);
  }
  return out;
}

/** The app-modal backdrop signature. Matched within a window rather than by parsing the object,
 *  because these are inline style literals (and, in two files, module-level `CSSProperties`
 *  constants) with no shared render path to inspect — the same constraint modalChrome.test.ts works
 *  under, and the same generous window in both directions since the property order varies. */
const WINDOW = 8;
function isAppModalScrim(lines: string[], i: number): boolean {
  const near = lines.slice(Math.max(0, i - WINDOW), i + WINDOW).join("\n");
  if (!/position:\s*"fixed"/.test(near)) return false;
  if (!/inset:\s*0\b/.test(near)) return false;
  // A veil that passes input through is not a modal — see the note above.
  if (/pointerEvents:\s*"none"/.test(near)) return false;
  return true;
}

// Remove every span where a `<ModalLayer>` mention is PROSE rather than JSX: block comments — which
// includes the JSX comment form, since its interior IS a block comment — line comments, and
// string/template literals. Counting the tag over the remainder is what makes "this file wraps
// something" mean it, rather than meaning "this file talks about wrapping".
//
// (Written as line comments on purpose: spelling the JSX comment form inside a block comment closes
// it early, which is its own small demonstration of why prefix-testing lines is not enough.)
function stripProse(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, " ")
    .replace(/"(?:\\.|[^"\\])*"/g, " ")
    .replace(/'(?:\\.|[^'\\])*'/g, " ");
}

/** The file itself is the primitive, so it cannot import itself. */
const IS_THE_PRIMITIVE = /\/ModalLayer\.tsx$/;
const ROUTES_THROUGH_LAYER = /from "[^"]*\/ModalLayer"|from "\.\/ModalLayer"/;

// A DECLARED backdrop background, in either of its two shapes. The visible SCRIM token is the dim
// veil the known modals paint. The INVISIBLE form — `background`/`backgroundColor` set to
// `transparent`, `none`, or `undefined`, quoted or not — is the botched scrim the SCRIM-only anchor
// missed: on the same full-bleed pointer-taking geometry it is an invisible click-catcher that eats
// every click across the viewport (bead sparkle-51ykk). Absence of any background is NOT a match on
// purpose — that is the scoped menu-dismiss backdrop, which is legitimate (see header).
const SCRIM_BG = /background:\s*SCRIM\b/;
const INVISIBLE_BG = /background(?:Color)?:\s*"?(?:transparent|none|undefined)"?/;
const isBackdropBg = (line: string): boolean => SCRIM_BG.test(line) || INVISIBLE_BG.test(line);

/** Line indices of every app-modal backdrop the file paints: a line that DECLARES a backdrop
 *  background (visible or invisibly-declared) whose surrounding window is the full-bleed
 *  pointer-taking geometry. Comments are skipped so the guard never flags its own documentation. */
function backdropLines(lines: string[]): number[] {
  const isComment = (line: string) => /^\s*(\/\/|\/\*|\*)/.test(line);
  return lines.flatMap((line, i) =>
    !isComment(line) && isBackdropBg(line) && isAppModalScrim(lines, i) ? [i] : [],
  );
}

/** A file routes its backdrops through the layer when it imports `ModalLayer` AND actually mounts
 *  the tag — counted over source with comments and strings stripped (see the "ONE WRAPPER USE" note
 *  in the scan). This is the coverage half of the verdict, factored out so the directory scan and
 *  the single-source verdict decide it with ONE implementation and cannot drift. */
function routesThroughLayer(src: string): boolean {
  const wraps = (stripProse(src).match(/<ModalLayer[\s>]/g) ?? []).length;
  return ROUTES_THROUGH_LAYER.test(src) && wraps >= 1;
}

/** The full guard verdict for ONE source string: it paints an app-modal backdrop that it never
 *  routes through `ModalLayer`. Both halves — detection (`backdropLines`) and coverage
 *  (`routesThroughLayer`) — are the SAME functions the directory scan runs, so the fixture test is
 *  exercising exactly the shipped guard and neither can drift from the other. */
function unwrappedBackdrop(src: string): boolean {
  if (backdropLines(src.split("\n")).length === 0) return false;
  return !routesThroughLayer(src);
}

describe("app-modal surfaces join the root modal layer", () => {
  it("no component paints its own fixed, interactive scrim without ModalLayer", () => {
    const offenders: string[] = [];
    let covered = 0;

    for (const file of sourceFiles(SRC)) {
      if (IS_THE_PRIMITIVE.test(file)) continue;
      const src = readFileSync(file, "utf8");
      const lines = src.split("\n");

      // EVERY scrim in the file, not just the first. Coverage used to be decided per FILE — the
      // first matching line, against "does this file import ModalLayer anywhere" — so a file that
      // already routes one surface could grow a SECOND inline scrim beside it and stay green. That
      // is the realistic path (a confirm dialog added next to an existing modal), and it is the one
      // shape this guard exists to refuse (roborev 55317). `backdropLines` catches both the visible
      // SCRIM and the invisibly-declared click-catcher, and skips comments so the guard never flags
      // its own documentation.
      const scrimLines = backdropLines(lines);
      if (scrimLines.length === 0) continue;

      // ONE WRAPPER USE, COUNTED ON NON-COMMENT LINES. That is the whole rule, and the narrowness
      // is deliberate — this guard has now been through three cuts and the last two were worse than
      // the first:
      //
      //   • The original counted `<ModalLayer` over the RAW text, so the tag written in a comment or
      //     an error string bought a free unwrapped scrim. Real hole; fixed by `isComment` below.
      //   • Replacing the count with a lexical open/close SPAN machine then made it false-FAIL: a
      //     JSX comment (`{/* wrap it in <ModalLayer> */}`), a block-comment interior, or any string
      //     mentioning the tag inflates the depth so the real close never returns to zero and NO
      //     span is pushed — every correct scrim in that file becomes an offender. An unmatched
      //     close drives depth negative with the same result. And the guard's own failure message
      //     instructs the reader to write `<ModalLayer>`, which in a .tsx file gets pasted as
      //     exactly that JSX comment. A guard that flags legitimate work gets deleted (this file's
      //     header), so a false failure is strictly worse than the leak it was closing.
      //
      // PER-SURFACE VERIFICATION IS THEREFORE NOT ATTEMPTED, and this says so rather than pretending
      // otherwise. Deciding whether a PARTICULAR scrim is inside a PARTICULAR wrapper needs a real
      // parser — the shapes in play include hoisted `CSSProperties` constants applied inside the
      // wrapper, conditional scrims sharing one wrapper, and comments quoting both — and every
      // heuristic tried for it failed in one direction or the other. What this catches is the thing
      // it was written for: a NEW modal that paints an app-modal scrim and never mentions the layer
      // at all. A file that routes one surface and adds a second unwrapped one is NOT caught; the
      // wiring tests (ModalLayer.wiring.test.tsx) are what cover specific surfaces.
      // COUNTED OVER SOURCE WITH COMMENTS AND STRINGS STRIPPED, not over lines that merely fail a
      // prefix test. `isComment` only sees `//`, `/*` and `*` line starts — so in a .tsx file a JSX
      // comment (`{/* wrap the backdrop in <ModalLayer> */}`) is NOT a comment to it, and neither is
      // the tag inside a string literal on a code line. Both are exactly the spellings this guard's
      // own failure message tells the reader to write, so both would have bought a free unwrapped
      // scrim — the hole the prefix test was introduced to close, still open (roborev 55391).
      // Coverage is decided by the SHARED `routesThroughLayer` (same call `unwrappedBackdrop` makes),
      // so tightening the rule moves both the scan and the fixture test together. `scrimLines` is
      // retained only to attribute offender line numbers.
      if (routesThroughLayer(src)) {
        covered += scrimLines.length;
      } else {
        for (const i of scrimLines) {
          offenders.push(`${file.slice(SRC.length)}:${i + 1}: ${lines[i]?.trim()}`);
        }
      }
    }

    // A scope that silently matched nothing would make this guard a no-op that reads as green — the
    // exact failure mode this repo keeps re-learning. These are the modals that own their own scrim:
    // ModalShell, SettingsDialog, AccountLoginModal, ProjectModal, NewCloudAgentDialog and
    // composer/ModalOverlay.
    expect(
      covered + offenders.length,
      "the app-modal-scrim scope matched nothing — the heuristic has drifted and this guard is inert",
    ).toBeGreaterThanOrEqual(6);

    expect(
      offenders,
      "a modal's z-index is meaningless unless it competes at the ROOT stacking context, and any " +
        "`position: relative; z-index: n` ancestor — the concierge column's lift, an agent pane's " +
        "visibility layer — caps the whole surface at n. Wrap the backdrop and card in <ModalLayer> " +
        "INSIDE this component (never at the call site). See components/ModalLayer.tsx:\n" +
        offenders.join("\n"),
    ).toEqual([]);
  });

  // The dangerous shape the SCRIM-only anchor missed, pinned to fixtures rather than to whatever
  // happens to live in the tree. Feeds `unwrappedBackdrop` — the SAME verdict the directory scan
  // runs — so this asserts the guard's ACTUAL flag, not a restatement of the regex. Under the old
  // `/background:\s*SCRIM\b/`-only detection an invisibly-declared backdrop matched nothing, so the
  // first assertion below was FALSE — that is the non-vacuity: revert `isBackdropBg` to SCRIM-only
  // and this test goes red (bead sparkle-51ykk).
  it("flags an invisible full-bleed click-catcher — a declared-transparent backdrop with no ModalLayer", () => {
    // FLAGGED: full-bleed (fixed + inset:0), TAKES pointer events, background DECLARED but invisible.
    const transparentCatcher = [
      "export function Bug() {",
      "  return (",
      '    <div style={{ position: "fixed", inset: 0, background: "transparent", zIndex: 50 }} />',
      "  );",
      "}",
    ].join("\n");
    expect(unwrappedBackdrop(transparentCatcher)).toBe(true);

    // FLAGGED: same geometry, background is a colour token that never resolved (`undefined`).
    const undefinedScrim =
      'function B() { return <div style={{ position: "fixed", inset: 0, background: undefined, zIndex: 5 }} />; }';
    expect(unwrappedBackdrop(undefinedScrim)).toBe(true);

    // NOT FLAGGED — the controls the broadening must leave alone, or it flags legitimate work and
    // gets deleted (this file's header):
    //  (1) pointerEvents:none — a decorative veil that captures nothing.
    const veil =
      '<div style={{ position: "fixed", inset: 0, background: "transparent", pointerEvents: "none" }} />';
    expect(unwrappedBackdrop(veil)).toBe(false);
    //  (2) a dismiss backdrop that DECLARES NO background — the live AgentPane / OpenPrMenu /
    //      HelperApp / CaptureApp / ModelPill pattern: a scoped menu click-catcher, not an app modal.
    const dismiss = '<div onClick={close} style={{ position: "fixed", inset: 0, zIndex: 19 }} />';
    expect(unwrappedBackdrop(dismiss)).toBe(false);
    //  (3) a proper SCRIM that DOES route through ModalLayer — covered, not an offender.
    const routed = [
      'import { ModalLayer } from "./ModalLayer";',
      "export function Ok() {",
      "  return (",
      "    <ModalLayer>",
      '      <div style={{ position: "fixed", inset: 0, background: SCRIM }} />',
      "    </ModalLayer>",
      "  );",
      "}",
    ].join("\n");
    expect(unwrappedBackdrop(routed)).toBe(false);
  });

  // The rule the audit turned up and the reason the wrapping belongs in the component: a call site
  // that portals its own child protects that ONE mount. `Concierge/KebabMenu` and `Workspace` each
  // mount several of these dialogs, and the guarantee has to hold for whichever mount a future
  // commit adds, not for the ones someone remembered.
  it("no caller wraps a modal in ModalLayer on its behalf", () => {
    const offenders: string[] = [];
    const MODAL_TAGS =
      /<(SettingsDialog|AccountLoginModal|ProjectModal|NewCloudAgentDialog|ModalShell|ModalOverlay)\b/;

    for (const file of sourceFiles(SRC)) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (/^\s*(\/\/|\/\*|\*)/.test(line)) return;
        if (!/<ModalLayer\b/.test(line)) return;
        const near = lines.slice(i, i + 4).join("\n");
        if (MODAL_TAGS.test(near)) {
          offenders.push(`${file.slice(SRC.length)}:${i + 1}: ${line.trim()}`);
        }
      });
    }

    expect(
      offenders,
      "wrap the modal's own root in <ModalLayer>, not its call site — otherwise the guarantee " +
        "belongs to whoever remembered rather than to the modal:\n" + offenders.join("\n"),
    ).toEqual([]);
  });

  // THE SCOPE IS REAL, and this asserts it by NAME rather than by count. The first version checked
  // `outside.length > 20`, which cannot fail under the drift it was written for: if `SRC` reverted
  // to this folder, `sourceFiles` would return the component files, whose sliced paths do not begin
  // with "components/" either — so every one of them would count as "outside" and the number would
  // still pass. It was the vacuous shape this whole file exists to refuse, three lines below the
  // comment saying so (roborev 55370).
  it("scans the whole app source dir, not just components/", () => {
    // The scope itself, stated: `SRC` has to BE the src root.
    expect(SRC.replace(/\/$/, "").endsWith("/src")).toBe(true);
    // …and the specific roots the old scope could not see. Any of these going missing means the
    // scan narrowed, and each one is a place an app-modal scrim can plausibly be added.
    const names = sourceFiles(SRC).map((f) => f.slice(SRC.length));
    expect(names).toContain("App.tsx");
    expect(names).toContain("capture/CaptureApp.tsx");
    expect(names).toContain("components/ModalShell.tsx");
  });
});
