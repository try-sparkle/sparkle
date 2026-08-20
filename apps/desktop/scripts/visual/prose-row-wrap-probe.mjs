#!/usr/bin/env node
// prose-row-wrap-probe — count the REAL LINE BOXES of a short concierge receipt and say whether the
// floated copy glyph evicts its last word.
//
//   node scripts/visual/prose-row-wrap-probe.mjs           (from apps/desktop)
//   node scripts/visual/prose-row-wrap-probe.mjs --json
//
// Exit 0 = the fix holds AND the defect reproduces without it; exit 1 = a real layout defect;
// exit 2 = the probe could not run (no Chrome).
//
// ── WHY THIS EXISTS (the founder's 2026-08-18 screenshot) ───────────────────────────────────────
// A receipt reading "Retired that agent." rendered as "Retired that" / "agent." — the break landing
// at x≈235 in a column running to x≈1400:
//
//     *"It says retired that, and then it says agent on the next line. You often do this. I don't
//      know why you put something on the next line when there's plenty of space."*
//
// **jsdom cannot see this.** It has no layout engine: it never resolves a percentage, never lays out
// a float, and returns zeros from every box-metric API (docs/jsdom-test-caveats.md). So the unit
// guard beside this (`src/components/Concierge/ConciergeMessageRow.proseWidth.test.tsx`) asserts the
// DECLARATION and says so rather than pretending to measure — and this probe is the half that can
// actually fail on the geometry. Same split as `blocked-row-narrow-probe.mjs` and its sibling unit
// test, for the same reason.
//
// ── THE MECHANISM IT PINS ───────────────────────────────────────────────────────────────────────
// Three facts combine, and NO TWO OF THEM ARE ENOUGH. The concierge's prose rows are flex items in a
// column, so `alignSelf: flex-start` sizes them SHRINK-TO-FIT; each carries its copy affordance as a
// `float: left` so the prose flows around the glyph instead of being pushed below it; and the words
// are a BLOCK, because `<Markdown>` emits a `<p>`.
//
// **In intrinsic sizing a BLOCK child does not sit beside a float**, so the row shrink-wraps to the
// paragraph's max-content ALONE and the float contributes nothing to it. The float is then laid in,
// overlapping the block, and shortens its FIRST line box. The paragraph is handed exactly the width
// its text needs and then has some of it taken away — so the overflow is always exactly one word.
//
// **THE INLINE VERSION DOES NOT REPRODUCE, WHICH IS WHY THIS PROBE EXISTS.** Reduce the same row with
// the text in a `<span>` rather than a `<p>` and the float and the text DO sum (measured: row 176px,
// one line) — the defect vanishes and the fix looks unnecessary. That reduction was written first,
// and it is what this probe caught. The harness below therefore uses a block paragraph deliberately;
// changing it to inline is not a simplification, it is deleting the bug.
//
// It is invisible on LONG lines because their max-content exceeds the 92% cap, so the cap sizes the
// box and the float's width comes out of slack that existed anyway — which is why, in the founder's
// own screenshot, the informative receipt wrapped correctly and the bare one directly beneath it did
// not, in the same component.
//
// ── WHY IT ASSERTS THE DEFECT TOO, NOT JUST THE FIX ─────────────────────────────────────────────
// A probe that only checked "the fixed row is one line" would pass against a harness whose text is
// simply too short to wrap under ANY styling — the vacuous shape this repo's AGENTS.md opens with.
// So the harness renders BOTH rows and the run fails unless the unfixed one genuinely breaks. The
// control is what makes the pass mean something.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { launch } from "./cdp.mjs";

/** The founder's own line. Short enough that its max-content sits well under the 92% cap, which is
 *  the only condition under which a float can evict a word. */
const RECEIPT = "Retired that agent.";

/** The column width from the screenshot, near enough — the point is that it is enormous relative to
 *  the text, so any wrap at all is the defect rather than an honest line break. */
const COLUMN_PX = 1400;

/**
 * Both rows, differing ONLY in the declaration under test.
 *
 * Everything else is copied from `ConciergeMessageRow`'s prose arms: the flex column parent, the
 * `align-self: flex-start`, the `max-width: 92%`, and the `float: left` glyph with its real margins.
 */
function harnessHtml() {
  return `<!doctype html>
<meta charset="utf-8">
<style>
  body { margin: 0; font: 19px/1.45 -apple-system, system-ui, sans-serif; }
  /* The concierge column: a flex COLUMN, which is what makes align-self size these rows. */
  .thread { display: flex; flex-direction: column; width: ${COLUMN_PX}px; }
  .row { max-width: 92%; align-self: flex-start; }
  /* THE FIX under test. */
  .fixed { width: 100%; }
  /* The copy affordance, floated exactly as the component floats it. */
  .glyph { float: left; margin-right: 6px; margin-left: -2px; margin-top: -1px;
           width: 16px; height: 16px; background: #888; }
  /* THE DETAIL THAT MAKES THE DEFECT: <Markdown> emits a BLOCK <p>, not inline text. */
  .txt { margin: 0; }
</style>
<div class="thread">
  <div class="row" id="unfixed"><span class="glyph"></span><p class="txt">${RECEIPT}</p></div>
  <div class="row fixed" id="fixed"><span class="glyph"></span><p class="txt">${RECEIPT}</p></div>
</div>
<script>window.__proseHarnessReady = true;</script>`;
}

/**
 * Line boxes per row, read from the TEXT rather than from the box.
 *
 * A Range over a text node yields ONE client rect per line box it occupies, which is the direct
 * question ("did this sentence get broken?"). Measuring the row's HEIGHT instead would answer it
 * only indirectly and would be confounded by the floated glyph's own height.
 */
const MEASURE = `(() => {
  const read = (id) => {
    const el = document.getElementById(id);
    const txt = el.querySelector('.txt').firstChild;
    const r = document.createRange();
    r.selectNodeContents(txt);
    const rects = Array.from(r.getClientRects()).filter((x) => x.width > 0);
    return {
      lines: rects.length,
      rowWidth: Math.round(el.getBoundingClientRect().width),
      // Where the break lands, for the report — this is the x≈235 from the screenshot.
      firstLineEndsAt: rects.length ? Math.round(rects[0].right) : 0,
    };
  };
  return { unfixed: read('unfixed'), fixed: read('fixed'), column: ${COLUMN_PX} };
})()`;

export async function main(argv = []) {
  const json = argv.includes("--json");
  let browser;
  try {
    browser = await launch({ width: 1600, height: 600 });
  } catch (e) {
    console.error(`prose-row-wrap-probe: could not launch Chrome — ${e.message}`);
    return 2;
  }
  try {
    const dir = mkdtempSync(join(tmpdir(), "prose-wrap-"));
    const file = join(dir, "harness.html");
    writeFileSync(file, harnessHtml());
    const page = await browser.newPage();
    await page.navigate(pathToFileURL(file).href);
    await page.waitForFunction("window.__proseHarnessReady === true", { timeout: 30000 });
    const m = await page.evaluate(MEASURE);
    await page.close();

    if (json) console.log(JSON.stringify(m, null, 2));

    // THE CONTROL FIRST. If the unfixed row does not break, the harness is not reproducing the
    // defect and the fixed row's single line proves nothing at all.
    const reproduced = m.unfixed.lines > 1;
    const fixedHolds = m.fixed.lines === 1;

    if (!json) {
      console.log(`column ${m.column}px`);
      console.log(
        `  unfixed (shrink-to-fit + float): ${m.unfixed.lines} line(s), ` +
          `row ${m.unfixed.rowWidth}px, first line ends at x=${m.unfixed.firstLineEndsAt}`,
      );
      console.log(
        `  fixed   (width: 100%):           ${m.fixed.lines} line(s), ` +
          `row ${m.fixed.rowWidth}px, first line ends at x=${m.fixed.firstLineEndsAt}`,
      );
    }

    if (!reproduced) {
      console.error(
        "prose-row-wrap-probe: FAILED TO REPRODUCE — the unfixed row did not break, so this run " +
          "cannot say the fix does anything. The harness text may have changed, or the engine's " +
          "shrink-to-fit now accounts for the float.",
      );
      return 1;
    }
    if (!fixedHolds) {
      console.error(
        `prose-row-wrap-probe: DEFECT — "${RECEIPT}" still wraps to ${m.fixed.lines} lines with ` +
          `width:100% in a ${m.column}px column.`,
      );
      return 1;
    }
    console.log(
      `\nOK — the defect reproduces without the fix (${m.unfixed.lines} lines) and is gone with it ` +
        `(${m.fixed.lines} line).`,
    );
    return 0;
  } catch (e) {
    console.error(`prose-row-wrap-probe: could not run — ${e.message}`);
    return 2;
  } finally {
    await browser.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((c) => process.exit(c));
}
