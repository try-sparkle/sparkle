#!/usr/bin/env node
// reply-quote-shot — photograph AND measure the concierge's reply quote, in BOTH themes.
//
//   node scripts/visual/reply-quote-shot.mjs            # from apps/desktop
//   node scripts/visual/reply-quote-shot.mjs --out=/tmp/shots
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────────
// The founder reported his question quoted back at him twice (2026-08-17, bead sparkle-y3ptuf) and
// asked for the blue bar with the copy glyph, not the gray one. `ConciergeThread.quoteOnce.test.tsx`
// is the guard for the structure; this is the instrument for the part that suite cannot reach.
//
// TWO THINGS jsdom CANNOT ANSWER, and both are in his sentence:
//
//   • WHICH BAR IS IT. The rule is `C.tealInk` → `var(--c-teal-ink)`. jsdom loads no stylesheet, so
//     a custom property resolves to the empty string and the unit suite can only compare the
//     declaration against itself. Here the browser resolves it, so "blue" is a reading.
//   • IS IT ACTUALLY ONE BAR. A suppression that fires produces the same DOM as a component that
//     was never mounted, and a screenshot is what a person can check that claim against.
//
// ── IT MEASURES AS WELL AS PHOTOGRAPHS ─────────────────────────────────────────────────────────
// A screenshot invites you to answer by impression, and the whole defect was two nearly identical
// lines of gray-on-navy that a glance can miss. So each case is also counted: how many gray stubs,
// how many blue bars, and whether the reply's own text says his sentence once or twice.
//
// Exit 0 = measured and clean, 1 = a real regression (the duplicate is back, or a bar that should
// have stayed was suppressed), 2 = the probe could not RUN (no Chrome, no dev server), 3 = it ran
// but the fixture no longer renders something it claims to cover. 3 is kept distinct from 2 for the
// reason `sent-card-shot.mjs` gives: coverage retired by drift is not a probe that never started.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launch } from "./cdp.mjs";
import { startDevServer } from "./serve.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true];
  }),
);

const OUT = typeof args.out === "string" ? args.out : "visual-out/reply-quote";
const THEMES = ["dark", "light"];

/** What each case must look like once the fix is in. `stubs` is the gray `ReplyAnchorStubs` count,
 *  `bars` the `<blockquote>` count, `jumps` how many of those bars became the jump control. */
const EXPECTED = {
  // THE REPORTED CASE. One bar, and it is the jump — this is the whole ask.
  fixed: { stubs: 0, bars: 1, jumps: 1, sentenceOccurrences: 1 },
  // MUST NOT BE SUPPRESSED: the reply quotes scrollback, so his question keeps its stub and the
  // scrollback keeps its bar. If this ever reads {stubs: 0} the suppression has gone position-only
  // and his question is nowhere on screen.
  foreign: { stubs: 1, bars: 1, jumps: 0 },
  // Three messages, one merged bar, one jump — `remarkMergeQuotes` doing its job under the fix.
  burst: { stubs: 0, bars: 1, jumps: 1 },
};

const MEASURE = `(() => {
  const rgb = (s) => (s.match(/\\d+/g) || []).slice(0, 3).map(Number);
  const out = {};
  for (const section of document.querySelectorAll('[data-case]')) {
    const id = section.dataset.case;
    const bars = [...section.querySelectorAll('blockquote')];
    const stubs = [...section.querySelectorAll('[data-testid="reply-anchor"]')];
    const jumps = [...section.querySelectorAll('[data-testid="quote-jump"]')];
    const first = bars[0];
    out[id] = {
      stubs: stubs.length,
      bars: bars.length,
      jumps: jumps.length,
      // THE COLOUR CLAIM, RESOLVED. This is the reading the unit suite cannot take.
      barRuleColor: first ? getComputedStyle(first).borderLeftColor : null,
      barRuleWidth: first ? getComputedStyle(first).borderLeftWidth : null,
      // …and the gray one, when it is present, so "these are two different colours" is a fact rather
      // than an assumption. Read off the stub's own left border, which is what draws its bar.
      stubRuleColor: stubs[0] ? getComputedStyle(stubs[0]).borderLeftColor : null,
      // HIS SENTENCE, COUNTED — INSIDE THE REPLY ROW, not the whole case.
      //
      // Scoped deliberately, and the first version of this line was not: counting over the section
      // includes HIS OWN BUBBLE, where the sentence is supposed to appear, so a perfectly fixed
      // render reads as 2 and the probe fails on the very thing it exists to confirm. The defect was
      // never "his words appear twice on screen" — it was "the REPLY quotes them twice".
      sentenceOccurrences: id === 'fixed'
        ? ((section.querySelector('[data-message-id="brain-1"]') || { textContent: '' })
            .textContent.match(/What did you find out about Epic versus tasks\\?/g) || []).length
        : null,
      // THE COPY GLYPH HE NAMED — a real control inside the reply, beside the bar.
      hasCopyGlyph: id === 'fixed'
        ? !!section.querySelector('[data-message-id="brain-1"] button')
        : null,
    };
    if (first && bars.length && stubs[0]) {
      const a = rgb(getComputedStyle(first).borderLeftColor);
      const b = rgb(getComputedStyle(stubs[0]).borderLeftColor);
      out[id].rulesDiffer = a.join(',') !== b.join(',');
    }
  }
  return out;
})()`;

async function main() {
  mkdirSync(OUT, { recursive: true });
  let server;
  let browser;
  try {
    server = await startDevServer({ quiet: !args.verbose });
  } catch (e) {
    console.error(`could not start the dev server: ${e.message}`);
    process.exit(2);
  }
  try {
    browser = await launch({ width: 620, height: 1200 });
  } catch (e) {
    server.stop();
    console.error(`could not launch Chrome: ${e.message}`);
    process.exit(2);
  }

  const report = {};
  let bad = false;
  try {
    for (const theme of THEMES) {
      const page = await browser.newPage();
      try {
        await page.setViewport({ width: 620, height: 1200, deviceScaleFactor: 2 });
        await page.navigate(`${server.url}/scripts/visual/reply-quote-harness.html?theme=${theme}`);
        await page.waitForFunction("window.__replyQuoteHarnessReady === true", { timeout: 30000 });
        const clip = await page.boundingBox("#page");
        const png = await page.screenshot({ clip });
        const file = join(OUT, `reply-quote-${theme}.png`);
        writeFileSync(file, png);
        const measured = await page.evaluate(MEASURE);
        report[theme] = { file, ...measured };

        for (const [id, want] of Object.entries(EXPECTED)) {
          const got = measured[id];
          // A CASE THAT DID NOT RENDER IS DRIFT, NOT A PASS. Without this the loop below would
          // silently skip it and the run would exit 0 having measured nothing — the "coverage
          // retired in silence" failure its sibling probe documents.
          if (!got) {
            console.error(`reply-quote-shot: ${theme}: case "${id}" did not render — fixture drift`);
            process.exitCode = 3;
            continue;
          }
          for (const [k, v] of Object.entries(want)) {
            if (got[k] !== v) {
              console.error(`reply-quote-shot: ${theme}: ${id}.${k} = ${got[k]}, expected ${v}`);
              bad = true;
            }
          }
        }
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
    server.stop();
  }

  console.log(JSON.stringify(report, null, 2));
  // A real regression outranks drift: if the duplicate is back, that is the answer worth reporting.
  if (bad) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e?.stack || String(e));
  process.exit(2);
});
