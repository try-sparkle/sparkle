// ── NO HAND-ROLLED SCRIMS. THE ONE GUARD THAT SCALES TO SITES NOBODY REMEMBERED ────────────────
//
// `ModalShell.test.tsx` pins the tokens on the rendered element, which is the right check for the
// component it covers — and it covers exactly ONE of the sites that had the defect. The reason this
// commit exists is that the same four values had been copy-pasted into six more dialogs, each of
// which drifted independently: `rgba(0,0,0,0.5)`, `rgba(0,0,0,0.55)`, `rgba(0,0,0,0.45)` — three
// different blacks for one scrim, none of them themed, so light mode's near-white shell got dark
// mode's wash at whatever opacity that file's author happened to type (roborev 54692).
//
// A per-component render test cannot catch the SEVENTH copy, because nobody writes a test for a
// component they are copying a style into. This reads the source instead, which is the thing the
// next person actually types.
//
// It is deliberately narrow: it bans a hard-coded black used as a full-bleed OVERLAY background, not
// every rgba in the app. Translucent blacks are legitimate in plenty of places — a gradient stop, a
// text shadow, a tinted hover — and a guard that flagged those would be turned off within a week.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL(".", import.meta.url));

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (/\.tsx?$/.test(name) && !name.includes(".test.")) out.push(p);
  }
  return out;
}

/** `background: "rgba(0,0,0,…)"` — a hard-coded black fill, however it is spaced. */
const HARDCODED_BLACK_BG = /background:\s*"rgba\(\s*0\s*,\s*0\s*,\s*0\s*,/;

/**
 * The overlay signature: `position: "fixed"` (or `"absolute"`) with `inset: 0`. A style object with
 * both is a full-bleed layer, i.e. a scrim — which is the only place the ban applies.
 *
 * Matched within a window of the offending line rather than by parsing the object, because these are
 * inline style literals with no shared render path to inspect. The window is generous in both
 * directions since `inset: 0` sits above the background in some files and below it in others.
 */
const WINDOW = 8;
function looksLikeOverlay(lines: string[], i: number): boolean {
  const near = lines.slice(Math.max(0, i - WINDOW), i + WINDOW).join("\n");
  return /inset:\s*0\b/.test(near) && /position:\s*"(fixed|absolute)"/.test(near);
}

describe("modal chrome is not hand-rolled", () => {
  it("no component paints a full-bleed overlay in a hard-coded black — use SCRIM", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        // Skip comments — the note above quotes the banned form verbatim, and a scanner that flags
        // its own documentation is a scanner nobody keeps (the same rule svgTokens.test.ts follows).
        if (/^\s*(\/\/|\/\*|\*)/.test(line)) return;
        if (HARDCODED_BLACK_BG.test(line) && looksLikeOverlay(lines, i)) {
          offenders.push(`${file.slice(SRC.length)}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(
      offenders,
      "a scrim is a THEMED value — `rgba(0,0,0,…)` is dark mode's wash applied to both themes, so " +
        "light mode's near-white shell gets a half-black overlay. Import SCRIM from theme/colors:\n" +
        offenders.join("\n"),
    ).toEqual([]);
  });

  // The other half of the copy-paste. A dialog CARD painted in a shell plane is the defect this
  // whole pass is about — `deepForest` is the builder column, `forest` the terminal — and it is
  // invisible to every contrast guard, because the colours are internally consistent and simply
  // belong to another register.
  it("no dialog card is painted in a shell plane — use C.dialogSurface", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (/^\s*(\/\/|\/\*|\*)/.test(line)) return;
        if (!/background:\s*C\.(deepForest|forest)\b/.test(line)) return;
        // Only when it is the card of an overlay — a `boxShadow` naming the modal shadow, or a
        // sibling scrim. A panel INSIDE the shell painting a shell plane is correct by definition.
        const near = lines.slice(Math.max(0, i - WINDOW), i + WINDOW).join("\n");
        if (/MODAL_SHADOW|SCRIM/.test(near)) {
          offenders.push(`${file.slice(SRC.length)}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(
      offenders,
      "a modal floats above the shell and takes the spec's own `dialog` surface, not the plane of " +
        "whichever column it happens to open over:\n" + offenders.join("\n"),
    ).toEqual([]);
  });
});

// ── THE MODAL RADIUS BELONGS TO THE CARD, NOT TO ITS BUTTONS ───────────────────────────────────
// `--r-modal` (6) is the largest surface on screen; `--r-input` (4) is the workhorse for the controls
// inside it. A 35-site hand sweep established that, and `scale.test.ts` is structurally blind to it:
// it is a ratchet on values OFF the scale, and 4 and 6 are both ON it, so the entire sweep left its
// count unchanged (roborev 54710). `ModalShell.test.tsx` pins the card and nothing pins the inside.
//
// Same coverage argument the scrim guard above already won on: a hand sweep defended by nothing
// re-forks the moment someone copies a `borderRadius: 6` from one of the ~160 literals still
// elsewhere in the tree.
describe("the modal radius is the card's alone", () => {
  /**
   * DIALOG-DEDICATED files, by filename. Not "every file that contains a dialog" — the first cut
   * used that and it was wrong in a way worth keeping: `AgentSidebar`, `BoardView` and
   * `Concierge/KebabMenu` all mount a dialog while being mostly something else, so a file-wide
   * literal ban flagged fifteen corners of sidebars and board cards that have nothing to do with
   * modal chrome (and two of those files belong to other workers this pass).
   *
   * Source scanning cannot tell which JSX subtree a style object lands in, so the honest scope is
   * the population where EVERY radius is dialog chrome by construction: a file whose whole job is
   * one dialog. The mixed-purpose files keep their coverage from the scrim and card-surface sweeps
   * above, which are precise regardless of what else is in the file.
   *
   * BOTH SIGNALS ARE REQUIRED, and the second was learned the same way as the first. The name alone
   * over-matches in the other direction: `PinnedPrompt` and `Concierge/ApprovalPrompt` end in
   * `Prompt` and are not dialogs at all — they are INLINE prompts with no shell, no overlay and no
   * dialog surface — so a name-only rule demanded modal geometry from components that never open a
   * modal. A file qualifies only if it is named like a dialog AND actually renders one.
   */
  const DIALOG_FILE = /(Modal|Dialog|Prompt)\.tsx$/;
  const RENDERS_A_DIALOG = /<ModalShell|<ModalOverlay|C\.dialogSurface/;

  it("no dialog file gives an inner control the MODAL radius or a re-typed literal 6", () => {
    const offenders: string[] = [];
    const files = sourceFiles(SRC).filter(
      (f) => DIALOG_FILE.test(f) && RENDERS_A_DIALOG.test(readFileSync(f, "utf8")),
    );
    // A scope that silently matched nothing would make this guard a no-op that reads as green.
    expect(files.length, "the dialog-file scope matched nothing — the heuristic has drifted").
      toBeGreaterThan(5);
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      // `RADIUS.modal` is legitimate at most once per file, and only where the file paints its own
      // card. A file mounting <ModalShell> gets its card from the shell, so it has no business
      // naming the modal radius at all.
      const ownsCard = /C\.dialogSurface/.test(src);
      let seen = 0;
      src.split("\n").forEach((line, i) => {
        if (/^\s*(\/\/|\/\*|\*)/.test(line)) return;
        if (/borderRadius:\s*RADIUS\.modal\b/.test(line)) {
          seen++;
          if (!ownsCard || seen > 1) {
            offenders.push(`${file.slice(SRC.length)}:${i + 1}: ${line.trim()} (modal radius on an inner control)`);
          }
        }
        // A re-typed literal. `RADIUS.modal` and `6` render identically, which is exactly why the
        // literal has to be banned HERE — the scale ratchet counts values OFF the scale, and both 4
        // and 6 are on it, so the whole 35-site migration left its count unchanged.
        if (/borderRadius:\s*6\s*[,}]/.test(line)) {
          offenders.push(`${file.slice(SRC.length)}:${i + 1}: ${line.trim()} (literal 6 — use RADIUS.input or RADIUS.modal)`);
        }
      });
    }
    expect(
      offenders,
      "inside a dialog, controls take RADIUS.input (4) and only the card takes RADIUS.modal (6). " +
        "Sharing one corner between the modal and its buttons flattens the hierarchy the spec draws:\n" +
        offenders.join("\n"),
    ).toEqual([]);
  });
});

// ── THE FIELD MIGRATION, TRACKED RATHER THAN LEFT TO BE NOTICED ────────────────────────────────
// `inputSurface`/`inputEdge` are the spec's field pair, and this pass made the dialogs it owns the
// first consumers. Roughly forty other fields across the app still borrow the shell — `deepForest`
// for the fill, `hairline` for the rule — so two field treatments ship at once (roborev 54709).
//
// PORTING ALL OF THEM IS NOT THIS BRANCH'S WORK. Several live in files owned by concurrent workers
// this pass (`Concierge/**`, the composer), and a sweep across them would be a merge conflict rather
// than a fix. What this branch CAN do is stop the count growing, which is the same bargain
// `scale.test.ts` struck for the type/radius sprawl and for the same reason: a hard ban would need a
// forty-file sweep nobody could review, while a ratchet lands now and stops the bleeding.
//
// `<=`, never `===` — exactly as scale.test.ts learned the hard way. Reality dipping below the
// ceiling means someone MIGRATED a field, and an improvement must never red the fleet. Lower the
// constant in the PR that does the migrating.
// 26 → 28 (bead sparkle-7h01z). BOTH new entries are PANELS, not fields, which this heuristic's own
// comment above says "must not be counted": the stale-checkout panel's card
// (`StaleCheckoutPanel.tsx`) and the stale badge's hover tooltip (`ProjectTabs.tsx`). Each paints
// `deepForest` + `hairline` because that is the app's ONE dropdown/panel treatment — the very paint
// `OpenPrMenu.tsx:1336` uses, and it is already an accepted entry on this list, as are
// `SelectionPopup`, `ModelPill` and `TerminalDropPill`. The detector cannot see the difference
// between a bordered panel on a plane and a text field, so a correct panel lands here as a false
// positive. Raising the recorded count is the honest move; restyling a panel to dodge a heuristic
// would make the UI wrong to keep a number down. The ratchet still does its job — it stops FIELD
// sprawl, and the next migration lowers this.
const MAX_BORROWED_FIELDS = 28;

describe("fields borrowing the shell's tokens is a shrinking population", () => {
  /** A style object that looks like a text field: a `hairline` border over a `deepForest` fill. */
  const BORROWED = /border:\s*`1px solid \$\{C\.hairline\}`/;

  it("the count of shell-borrowing field styles never rises", () => {
    const hits: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (/^\s*(\/\/|\/\*|\*)/.test(line)) return;
        if (!BORROWED.test(line)) return;
        // only when it is paired with a fill from the shell's planes, i.e. a FIELD rather than a
        // panel outline — a bordered panel on a plane is correct and must not be counted.
        const near = lines.slice(Math.max(0, i - 4), i + 4).join("\n");
        if (/background:\s*C\.(deepForest|forest|barSurface)\b/.test(near)) {
          hits.push(`${file.slice(SRC.length)}:${i + 1}`);
        }
      });
    }
    expect(
      hits.length,
      `${hits.length} field styles still borrow the shell's tokens vs the recorded ceiling ` +
        `${MAX_BORROWED_FIELDS}. Use C.inputSurface / C.inputEdge. (If you MIGRATED some, this ` +
        `passes; lower the constant to ${hits.length} in this PR to keep the ceiling tight.)\n` +
        hits.join("\n"),
    ).toBeLessThanOrEqual(MAX_BORROWED_FIELDS);
  });
});
