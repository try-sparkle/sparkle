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
// Exit 0 = both themes captured, every element it claims to cover was measured, and every PINNED
// VERDICT held. Exit 1 = a pinned verdict is FALSE — a real regression in what the reader is shown.
// Exit 2 = the probe could not RUN (no Chrome, no dev server). Exit 3 = it ran, but the fixture no
// longer renders something it measures — coverage retired by drift, which is a different failure
// from a probe that never started and must not collapse onto 2.
//
// It never fails on a CONTRAST reading. A number outside expectation is a design question for the
// founder to rule on; a MISSING number is a broken instrument, and only the second is this script's
// business. Same split sent-card-shot.mjs draws, for the same reason.
//
// ── WHY THE PILL-INK VERDICTS ARE THE EXCEPTION TO THAT (roborev 66521) ────────────────────────
// `pillInkSurvivesNotice`, `pillInkDiffersFromNoticeProse` and `dotStillCarriesStatus` are BINARY
// facts, not readings on a scale — either the label followed the row's grey or it did not. The
// exemption above was written for ratios a human has to judge; a boolean has nothing to judge. So
// they exit 1 rather than merely printing.
//
// ══ BUT BE PRECISE ABOUT WHAT THAT GATE COVERS — IT IS MANUAL (roborev 66548) ══════════════════
// THIS PROBE IS OPT-IN. Like every sibling in this directory it is not in `pnpm verify`, not in
// `pnpm test`, and not in any CI job — CI installs no browser binaries, which is the same reason
// scripts/visual/ drives system Chrome over raw CDP at all. `pnpm visual:notice-attribution` runs
// it. So exit 1 is seen by whoever runs it, and an earlier draft of this header was wrong to imply
// it was the thing standing between the founder's bug and a merge.
//
// WHAT IS ACTUALLY AUTOMATED, and it covers the obvious regression: `PillInk.test.tsx` asserts the
// pill DECLARES `var(--c-pill-ink)` and that `NOTICE_INK_VARS` omits that token, and
// `cssMirror.test.ts` requires every `--c-*` to be a literal hex matching THEME_HEX. MEASURED, not
// assumed: reverting `AgentPill`'s `C.pillInk` to `C.cream` REDS `PillInk.test.tsx` in CI. A token
// redefined to `var(--c-cream)` in index.css reds the mirror.
//
// WHAT ONLY THIS TIER CAN SEE is the residual: CASCADE and PAINT. jsdom loads no stylesheet and
// resolves no custom property, so no unit test can tell you what colour the label actually IS on
// screen, what the dot is beside it, or that a row's re-inking does or does not reach through. That
// is a narrower claim than the one this header used to make, and it is the true one.
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

  // ── THE PILL'S LABEL IS NEUTRAL; THE DOT ALONE CARRIES STATUS (bead sparkle-s6gonk) ─────────
  //
  // THIS IS THE ONE TIER THAT CAN SEE THIS AT ALL. The unit suite asserts that a pill DECLARES
  // 'var(--c-pill-ink)' and that NOTICE_INK_VARS omits that token — it cannot resolve either, so
  // the whole question of what the reader is shown lives here.
  //
  // The founder's report was a CONTRADICTION between two things a few pixels apart: a green status
  // dot and a grey name, on a live agent. So both are read, plus the same pill in an ordinary
  // reply, and the three readings are what pin the rule:
  //   • the pill in the notice row matches the pill in the reply     -> the row's de-emphasis did
  //                                                                     not reach the label;
  //   • the pill's label differs from the notice row's own prose     -> and the de-emphasis is
  //                                                                     still really there;
  //   • the dot keeps its band colour                                -> status is still signalled,
  //                                                                     by the one element that owns it.
  const pillIn = (row) => row.querySelector('[data-testid="concierge-agent-pill"]');
  const noticePill = pillIn(notice);
  const replyPill = pillIn(reply);
  if (!noticePill) return { error: "no agent pill in the refusal row — fixture drift" };
  if (!replyPill) return { error: "no agent pill in the reply row — fixture drift" };
  const labelOf = (pill) => pill.querySelector('[data-testid="concierge-agent-pill-name"]');
  if (!labelOf(noticePill)) return { error: "no pill label in the refusal row — fixture drift" };
  if (!labelOf(replyPill)) return { error: "no pill label in the reply row — fixture drift" };
  // The DOT is the pill's first flex item and is aria-hidden; it exists only on a resolved pill.
  const noticeDot = noticePill.querySelector('span[aria-hidden]');
  if (!noticeDot) return { error: "no status dot on the refusal row's pill — fixture drift" };
  const noticePillInk = getComputedStyle(labelOf(noticePill)).color;
  const replyPillInk = getComputedStyle(labelOf(replyPill)).color;
  const noticeDotFill = getComputedStyle(noticeDot).backgroundColor;

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
    // ── THE PILL-INK READINGS (bead sparkle-s6gonk) ─────────────────────────────────────────
    noticePillInk, replyPillInk, noticeDotFill,
    // 4. NEUTRAL: a pill inside a de-emphasised row is painted exactly like one in ordinary prose.
    //    This is the reading that was FALSE before the fix — the label followed the row's grey.
    pillInkSurvivesNotice: noticePillInk === replyPillInk,
    // 5. …and the de-emphasis it survived is genuinely present. Without this, 4 would also pass on
    //    a build that simply stopped greying notice rows at all, which is a different (worse) bug.
    pillInkDiffersFromNoticeProse: noticePillInk !== noticeInk,
    // 6. THE DOT STILL CARRIES STATUS. The harness's a1 is band 'running' (the band that paints
    //    GREEN), so this must be that band colour and NOT the label's ink — if the two ever match,
    //    saying anything and the rule has quietly become "nothing carries status".
    dotStillCarriesStatus: noticeDotFill !== noticePillInk,
    pillLabelOnColumn: ratio(noticePillInk, columnBg),
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
  // ── THE PINNED VERDICTS (bead sparkle-s6gonk) ────────────────────────────────────────────────
  // Checked AFTER drift, because a fixture that no longer renders the pill cannot have an opinion
  // about its colour and must report the broken instrument rather than a false regression.
  // Checked in BOTH themes: the tokens are per-theme, and light is where the sent card's opposite
  // rule (pin the pill ink, because the ground changed) would fail if the two ever got swapped.
  const PINNED = [
    ["pillInkSurvivesNotice", "a pill's label inside a de-emphasised notice row no longer matches the same pill in ordinary prose — the row's grey has re-coupled to the label"],
    ["pillInkDiffersFromNoticeProse", "the notice row's prose is no longer de-emphasised at all — the pill reads correctly only because nothing is being greyed"],
    ["dotStillCarriesStatus", "the status dot now paints the same colour as the label, so nothing on the pill carries status"],
  ];
  const broken = [];
  for (const theme of THEMES) {
    for (const [key, why] of PINNED) {
      if (report[theme]?.[key] !== true) broken.push(`${theme}: ${key} — ${why}`);
    }
  }
  if (broken.length > 0) {
    console.error("REGRESSION — a pinned pill-ink verdict is false:");
    for (const line of broken) console.error(`  ${line}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
