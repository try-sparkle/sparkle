#!/usr/bin/env node
// bead-card-expanded-shot — photograph the concierge's EXPANDED bead cards in both themes, and
// measure the contrast they actually achieve against the column they sit on.
//
//   node scripts/visual/bead-card-expanded-shot.mjs            # from apps/desktop
//   node scripts/visual/bead-card-expanded-shot.mjs --out=/tmp/shots
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────────
// The founder asked for bead cards to render expanded by default and asked to see it in both themes
// before it was called done. Neither existing instrument can show him:
//
//   • jsdom has no stylesheet and no computed colour, so `BeadPill.expanded.test.tsx` can assert the
//     card is IN THE DOM without a click and nothing at all about how it reads.
//   • the full visual harness photographs a `concierge-column` surface whose fixtures name no bead
//     (src/dev/visualFixtures.ts), so there is no card in it to be expanded.
//
// Same shape and same stated reasoning as sent-card-shot.mjs beside it.
//
// ── IT COUNTS AS WELL AS PHOTOGRAPHS, AND THAT IS THE POINT ─────────────────────────────────────
// "Are the cards expanded" is a question a screenshot invites you to answer by impression, and an
// impression cannot tell an expanded card from a collapsed one in a thumbnail. So the reading below
// is the honest version: how many pills the reply drew, how many CARDS are open beside them with no
// click having happened, and — the assertion the picture cannot make — that the unresolved id and
// the backticked one drew NEITHER. A shot of four lovely cards proves nothing if the feature also
// started linkifying things it must not.
//
// Exit 0 = both themes captured and every element it claims to cover actually measured. Exit 2 = the
// probe could not RUN (no Chrome, no dev server). Exit 3 = it ran, but the fixture no longer renders
// something it measures — coverage retired by drift, which is distinct from a probe that never
// started and must not be collapsed onto 2.
//
// It never fails on a CONTRAST reading: that is a finding for the founder to rule on, not a gate.
// A number outside expectation is a design question; a MISSING number is a broken instrument, and
// only the second one is this script's business.
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

const OUT = typeof args.out === "string" ? args.out : "visual-out/bead-card-expanded";
const THEMES = ["dark", "light"];

/** WCAG relative luminance / contrast, on `rgb(r, g, b)` strings as the browser reports them — so
 *  the numbers describe what was PAINTED, not what the token file says. */
const MEASURE = `(() => {
  const rgb = (s) => (s.match(/\\d+/g) || []).slice(0, 3).map(Number);
  const lum = ([r, g, b]) => {
    const ch = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
  };
  const ratio = (a, b) => {
    const [hi, lo] = [lum(rgb(a)), lum(rgb(b))].sort((x, y) => y - x);
    return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
  };
  const pills = [...document.querySelectorAll('[data-testid="concierge-bead-pill"]')];
  const cards = [...document.querySelectorAll('[data-testid="concierge-bead-card"]')];
  const column = document.getElementById("column");
  // THE HEADLINE FACT, and the one the picture cannot assert: cards exist with no click having
  // happened anywhere in this page's life.
  if (cards.length === 0) return { error: "no expanded bead card rendered — the feature is not on" };
  const card = cards[0];
  const title = card.querySelector('[data-testid="concierge-bead-card-title"]');
  const meta = card.querySelector('[data-testid="concierge-bead-card-meta"]');
  const desc = card.querySelector('[data-testid="concierge-bead-card-description"]');
  const stage = card.querySelector('[data-testid="concierge-bead-card-stage"]');
  const build = card.querySelector('[data-testid="concierge-bead-card-build-it"]');
  const close = card.querySelector('[data-testid="concierge-bead-card-close"]');
  // EACH ONE IS A LOUD ERROR RATHER THAN A null. A fixture edit that stopped rendering any of these
  // would otherwise report null beside a dozen healthy numbers and still exit 0, quietly retiring
  // the coverage — the failure mode sent-card-shot.mjs was corrected for.
  if (!title) return { error: "no card title — fixture drift" };
  if (!meta) return { error: "no card meta row — fixture drift" };
  if (!desc) return { error: "no card description — fixture drift" };
  if (!stage) return { error: "no progress rail — fixture drift" };
  if (!build) return { error: "no Build It button — the card is rendering read-only" };
  if (!close) return { error: "no close control — the collapse affordance is gone" };
  const cardBg = getComputedStyle(card).backgroundColor;
  const columnBg = getComputedStyle(column).backgroundColor;
  // THE NEGATIVE HALF. The loose matcher is meant to hand every id-SHAPED token to the renderer and
  // have the unresolved ones come back out as prose — and a backticked id must never be visited at
  // all. Both are stated as COUNTS of what got drawn, because the picture cannot show an absence.
  const body = document.body.textContent || "";
  const code = [...document.querySelectorAll("code")].map((c) => c.textContent || "");
  return {
    pills: pills.length,
    // Every card here opened WITHOUT a click. Nothing in this page ever dispatches one.
    expandedCards: cards.length,
    everyPillHasACard: pills.length === cards.length,
    cardBg, columnBg,
    cardVsColumn: ratio(cardBg, columnBg),
    titleOnCard: ratio(getComputedStyle(title).color, cardBg),
    metaOnCard: ratio(getComputedStyle(meta).color, cardBg),
    descriptionOnCard: ratio(getComputedStyle(desc).color, cardBg),
    // The description CAPS its height and scrolls rather than growing — the rule that keeps a long
    // bead from swallowing the thread, and the one an always-open card leans on hardest.
    descriptionMaxHeight: getComputedStyle(desc).maxHeight,
    descriptionScrolls: getComputedStyle(desc).overflowY,
    unresolvedIdStayedProse: body.includes("sparkle-notreal") &&
      !pills.some((p) => p.dataset.beadId === "sparkle-notreal"),
    backtickedIdStayedCode: code.some((t) => t.includes("sparkle-qogah")),
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
    browser = await launch({ width: 900, height: 2600 });
  } catch (e) {
    server.stop();
    console.error(`could not launch Chrome: ${e.message}`);
    process.exit(2);
  }

  const report = {};
  try {
    for (const theme of THEMES) {
      const page = await browser.newPage();
      try {
        await page.setViewport({ width: 900, height: 2600, deviceScaleFactor: 2 });
        await page.navigate(
          `${server.url}/scripts/visual/bead-card-expanded-harness.html?theme=${theme}&w=380`,
        );
        await page.waitForFunction("window.__beadCardHarnessReady === true", { timeout: 30000 });
        const clip = await page.boundingBox("#column");
        const png = await page.screenshot({ clip });
        const file = join(OUT, `bead-card-expanded-${theme}.png`);
        writeFileSync(file, png);
        report[theme] = { file, ...(await page.evaluate(MEASURE)) };
        // The guards inside MEASURE only RETURN an object; this is what makes them a failure. Their
        // `{ error }` is spread in beside the healthy numbers and would otherwise read like one more
        // field on a run that exited 0.
        if (report[theme].error) {
          console.error(`bead-card-expanded-shot: ${theme}: ${report[theme].error}`);
          console.error(JSON.stringify(report, null, 2));
          // 3, not 2: the probe RAN. 2 means it could not start.
          process.exitCode = 3;
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
}

main().catch((e) => {
  console.error(e?.stack || String(e));
  process.exit(2);
});
