#!/usr/bin/env node
// notice-attribution-probe — photograph the concierge feed with all four treatments visible at
// once, in BOTH themes, and MEASURE the ink each one is actually painted (bead sparkle-4kgpb3).
//
//   node scripts/visual/notice-attribution-probe.mjs            # from apps/desktop
//   node scripts/visual/notice-attribution-probe.mjs --out=/tmp/shots
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────────
// The change greys and attributes app-authored lines that are addressed to the CONCIERGE, while
// leaving lines addressed to the FOUNDER at full weight. jsdom cannot check the half that matters:
// it has no stylesheet and no computed colour, so the unit suite asserts that `--c-cream` is
// REDEFINED on a notice row and can say nothing about what that row is painted. In particular the
// exact bug this treatment risks — a token redefined but the COMPUTED inherited colour never
// re-resolved — is invisible to it, and that bug has shipped before in this component family
// (SENT_CARD_INK_VARS).
//
// ── IT MEASURES AS WELL AS PHOTOGRAPHS ──────────────────────────────────────────────────────────
// "Is the grey clearly subordinate but still legible" is a question a screenshot invites you to
// answer by impression. The numbers are the honest version: the notice ink against the column it
// sits on, the reply ink against the same column, and the ratio between them — read out of a live
// layout, in both themes. The founder's brief says these must be de-emphasised but FULLY LEGIBLE,
// which is a contrast floor, not a matter of taste.
//
// Exit 0 = both themes captured and every element it claims to cover was measured. Exit 2 = the
// probe could not RUN (no Chrome, no dev server). Exit 3 = it ran, but the fixture no longer
// renders something it measures — coverage retired by drift, which is a different failure from a
// probe that never started and must not collapse onto 2.
//
// It never fails on a CONTRAST reading. A number outside expectation is a design question for the
// founder to rule on; a MISSING number is a broken instrument, and only the second is this script's
// business. Same split sent-card-shot.mjs draws, for the same reason.
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

const OUT = typeof args.out === "string" ? args.out : "visual-out/notice-attribution";
const THEMES = ["dark", "light"];

// NO REGEX AND NO BACKTICKS INSIDE — this whole expression is a template literal, so a backslash
// would be eaten before the browser saw it and a backtick would end the string. sent-card-shot.mjs
// records what that cost when it was got wrong (a contrast ratio of 5.4 million).
const MEASURE = `(() => {
  const rgb = (s) => (s.match(/\\d+/g) || []).slice(0, 3).map(Number);
  const lum = ([r, g, b]) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a, b) => {
    const la = lum(rgb(a)), lb = lum(rgb(b));
    return Math.round(((Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)) * 100) / 100;
  };

  const column = document.getElementById("column");
  if (!column) return { error: "no #column — harness did not mount" };
  const columnBg = getComputedStyle(column).backgroundColor;

  const rowById = (id) => document.querySelector('[data-message-id="' + id + '"]');

  const notice = rowById("refusal-1");
  const reply = rowById("reply-1");
  const founder = rowById("founder-1");
  // A MISSING ROW IS A LOUD ERROR, never a null that still exits 0. The whole claim of this probe is
  // a COMPARISON, and a comparison with one side absent is not a weaker reading — it is no reading.
  if (!notice) return { error: "no refusal row — fixture drift" };
  if (!reply) return { error: "no reply row — fixture drift" };
  if (!founder) return { error: "no founder-addressed row — fixture drift" };

  // THE INK ON THE WORDS, not on the row. Reading the row's own declared color would be
  // tautological — it would re-read the thing under test rather than the paint the reader sees, and
  // it is exactly the mistake sent-card-shot.mjs had to remove. The paragraph inherits.
  const proseOf = (row) => row.querySelector("p") || row;
  const noticeInk = getComputedStyle(proseOf(notice)).color;
  const replyInk = getComputedStyle(proseOf(reply)).color;
  const founderInk = getComputedStyle(proseOf(founder)).color;

  const header = notice.querySelector('[data-testid="concierge-notice-attribution"]');
  if (!header) return { error: "no attribution header on the refusal row — fixture or wiring drift" };

  const run = document.querySelector('[data-testid="concierge-receipt-run"]');

  return {
    columnBg,
    noticeInk, replyInk, founderInk,
    // THE THREE READINGS THE BRIEF ACTUALLY ASKS FOR.
    // 1. legible: the grey must still clear a real floor against the column it sits on.
    noticeOnColumn: ratio(noticeInk, columnBg),
    // 2. subordinate: the reply must be the brighter of the two. Reported as both inks so the
    //    direction is checkable rather than asserted.
    replyOnColumn: ratio(replyInk, columnBg),
    // 3. NOT greyed: a founder-addressed app line must be painted the SAME as a concierge reply.
    //    This is the assertion that a sender-based split would have failed.
    founderOnColumn: ratio(founderInk, columnBg),
    founderMatchesReply: founderInk === replyInk,
    noticeDiffersFromReply: noticeInk !== replyInk,
    headerText: header.textContent,
    // The fold, when the fixture produced one — reported rather than required, because WHICH
    // receipts fold is policy that lives in receiptRuns and may legitimately change.
    foldPresent: Boolean(run),
    foldCount: run ? run.getAttribute("data-count") : null,
    foldOpen: run ? run.getAttribute("data-open") : null,
    foldHasHeader: run ? Boolean(run.querySelector('[data-testid="concierge-notice-attribution"]')) : null,
    recipients: [...document.querySelectorAll("[data-recipient]")].map((el) => el.dataset.recipient),
  };
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
    browser = await launch({ width: 900, height: 1000 });
  } catch (e) {
    server.stop();
    console.error(`could not launch Chrome: ${e.message}`);
    process.exit(2);
  }

  const report = {};
  let drift = false;
  try {
    for (const theme of THEMES) {
      const page = await browser.newPage();
      try {
        await page.setViewport({ width: 900, height: 1000, deviceScaleFactor: 2 });
        await page.navigate(
          `${server.url}/scripts/visual/notice-attribution-harness.html?theme=${theme}&w=460`,
        );
        await page.waitForFunction("window.__noticeHarnessReady === true", { timeout: 30000 });
        const clip = await page.boundingBox("#column");
        const png = await page.screenshot({ clip });
        const file = join(OUT, `notice-attribution-${theme}.png`);
        writeFileSync(file, png);
        const measured = await page.evaluate(MEASURE);
        report[theme] = { shot: file, ...measured };
        if (measured && measured.error) drift = true;
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
    server.stop();
  }

  console.log(JSON.stringify(report, null, 2));
  if (drift) {
    console.error("fixture drift — an element this probe measures no longer renders");
    process.exit(3);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
