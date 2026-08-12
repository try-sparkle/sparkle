#!/usr/bin/env node
// sent-card-shot — photograph the black "sent to an agent" card in BOTH themes, and measure the
// contrast it actually achieves against the surfaces it sits on.
//
//   node scripts/visual/sent-card-shot.mjs            # from apps/desktop
//   node scripts/visual/sent-card-shot.mjs --out=/tmp/shots
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────────
// The founder asked for a black card on a message that was sent to an agent, and asked to see it in
// both themes before it was called done. Neither existing instrument can show him:
//
//   • jsdom has no stylesheet and no computed colour, so the unit suite can assert the DECLARATION
//     (`--c-chat-bubble-sent` is applied) and nothing about the paint.
//   • the full visual harness photographs a `concierge-column` surface whose fixtures contain no
//     `you` messages at all (src/dev/visualFixtures.ts), so there is no bubble in it to be black.
//
// So this drives the app's own vite dev server and real Chrome against a small fixture thread — the
// same shape recap-narrow-probe.mjs uses, and for the same stated reason.
//
// ── IT MEASURES AS WELL AS PHOTOGRAPHS, AND THAT IS THE POINT ───────────────────────────────────
// "Does black read badly in this theme" is a question a screenshot invites you to answer by
// impression. The numbers below are the honest version: the card's rendered fill against the column
// it sits on, and against an ordinary bubble beside it, read out of a live layout. Black on dark's
// near-black column is the case where the answer is genuinely marginal, and it should be reported as
// a number rather than argued about.
//
// Exit 0 = both themes captured, every element it claims to cover actually measured. Exit 2 = the
// probe could not RUN (no Chrome, no dev server). Exit 3 = it ran, but the fixture no longer renders
// something it measures — coverage retired by drift, which is distinct from a probe that never
// started and must not be collapsed onto 2.
//
// It never fails on a CONTRAST reading: that is a finding for the founder to rule on, not a gate.
// The distinction is deliberate — a number outside expectation is a design question, a MISSING
// number is a broken instrument, and only the second one is the script's business.
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

const OUT = typeof args.out === "string" ? args.out : "visual-out/sent-card";
const THEMES = ["dark", "light"];

/** WCAG relative luminance / contrast, on `rgb(r, g, b)` strings as the browser reports them. So the
 *  numbers describe what was PAINTED, not what the token file says — which is the whole difference
 *  between this and the unit-level contrast guard. */
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
  const bubbles = [...document.querySelectorAll('[data-testid="you-bubble"]')];
  const card = bubbles.find((b) => b.dataset.sentToAgent === "yes");
  const plain = bubbles.find((b) => b.dataset.sentToAgent === "no");
  const column = document.getElementById("column");
  if (!card || !plain) return { error: "fixture did not render both a card and a plain bubble" };
  const cardBg = getComputedStyle(card).backgroundColor;
  const plainBg = getComputedStyle(plain).backgroundColor;
  const columnBg = getComputedStyle(column).backgroundColor;
  const row = card.querySelector('[data-testid="sent-to-agent"]');
  const pill = card.querySelector('[data-testid="concierge-agent-pill"]');
  // THE FOUNDER'S OWN WORDS, and the reading this probe originally did not take. The label and the
  // pill both name a var(--c-*) ink in their own style, so the card's pinned inks reach them — and
  // measuring only those two reported a healthy card while the message body, which inherits a
  // COMPUTED colour from the thread, rendered #0a1b33 on black in light mode. An instrument narrower
  // than the claim it backs is the failure mode AGENTS.md names; this is the missing third reading.
  // (No backticks in here: this whole expression is a template literal, and one would end it.)
  //
  // NO FALLBACK TO THE CARD. It had one, and the fallback was the only path taken because the testid
  // did not exist yet — so this measured getComputedStyle(card).color, which is the card's OWN color
  // declaration. That is tautological: it re-reads the thing under test instead of the paint on the
  // words, and it would keep reporting a healthy number if any future wrapper between the card and
  // the text re-declared a themed colour. A missing element is now a loud error.
  const body = card.querySelector('[data-testid="you-text"]');
  if (!body) return { error: "no [data-testid=you-text] inside the card — cannot read the body ink" };
  return {
    cardBg, plainBg, columnBg,
    cardVsColumn: ratio(cardBg, columnBg),
    cardVsPlainBubble: ratio(cardBg, plainBg),
    bodyTextOnCard: ratio(getComputedStyle(body).color, cardBg),
    // THE TWO DESCENDANTS THAT PAINT THEIR OWN GROUND, each read against ITS OWN fill rather than
    // against the card. Reading them against cardBg would be the tautology this probe just removed
    // one level up: the whole failure was that the chip's ground is not the card's.
    ...(() => {
      // Across ALL sent cards, not just the first: the fixture hangs these off a later message.
      const cards = bubbles.filter((b) => b.dataset.sentToAgent === "yes");
      const chip = cards.find((c) => c.querySelector('[data-testid="concierge-message-attachments"]'));
      const tile = chip && chip.querySelector('[data-testid="concierge-message-attachments"] button');
      const pill = chip && chip.querySelector('[data-testid="composer-text-pill"]');
      // WHAT THIS READS, AND WHY IT IS THE GROUND RATHER THAN A RATIO.
      //
      // The bug was that these two elements paint a THEMED ground of their own inside a card whose
      // ink is pinned dark — in light mode #dce8fc on a #e8f0fd chip, about 1.07:1. The card now
      // pins those fills too, and the fact that proves it is the GROUND being theme-invariant: the
      // chip reads rgb(20,41,74) in light as well as dark, where before it was #e8f0fd in light.
      //
      // The matching ink-vs-fill contrast is asserted numerically in theme/chromeContrast.test.ts
      // against the same two constants. Computing a ratio here as well would mean selecting whichever
      // descendant span happens to declare a colour, and a first attempt at that measured the wrong
      // node and returned a ratio of 5.4 MILLION. A reading that has to guess at its own subject is
      // worse than no reading; the ground is unambiguous and is the thing that was broken.
      //
      // An alpha-bearing background is NOT a ground — it lets the paint behind it through — so walk
      // past it. Both notations appear here: rgba(...) and color(srgb r g b / a).
      // NO REGEX IN HERE. This whole expression is a template literal, so every backslash is eaten
      // before the browser ever sees the pattern: a literal /rgba?\(...\)/ arrives as /rgba?(...)/ ,
      // which silently turns the escaped parens into a capture group and matches the wrong thing. It
      // is what produced the 5.4-million ratio — the pattern matched the "rgb" inside "color(srgb …)"
      // and read its alpha as absent. A later attempt failed louder with "Unterminated group". Plain
      // string operations have no escaping to lose, so they mean here what they say.
      const opaque = (bg) => {
        if (!bg || bg === "transparent") return false;
        const inner = bg.slice(bg.indexOf("(") + 1, bg.lastIndexOf(")"));
        // rgba(r, g, b, a) — the alpha is the fourth comma-separated part.
        if (bg.startsWith("rgba(")) return parseFloat(inner.split(",")[3] ?? "1") > 0.9;
        // color(srgb r g b / a) — the alpha follows a slash. No slash means fully opaque.
        if (bg.startsWith("color(")) {
          const slash = inner.indexOf("/");
          return slash === -1 || parseFloat(inner.slice(slash + 1)) > 0.9;
        }
        return true; // a plain rgb(...) or a named colour
      };
      const groundOf = (el) => {
        for (let n = el; n; n = n.parentElement) {
          const bg = getComputedStyle(n).backgroundColor;
          if (opaque(bg)) return bg;
        }
        return null;
      };
      // A MISSING ELEMENT IS AN ERROR, NOT A null — the same rule the body reading was promoted to.
      // These are scoped to the card found via the attachments testid, so a fixture edit (a stray
      // dataUrl turning the chip into a thumbnail, or moving the collapsed block to a message with
      // no attachment) would otherwise report null and still exit 0, quietly retiring the coverage.
      if (!tile) return { error: "no attachment chip inside a sent card — fixture drift" };
      if (!pill) return { error: "no collapsed-paste pill inside a sent card — fixture drift" };
      return {
        // The chip is the reading that MEANS something: it paints its own opaque ground, so this is
        // theme-invariant only because the card pins the fill. It was #e8f0fd in light before.
        attachmentChipGround: groundOf(tile),
        // NO GROUND READING FOR THE PASTE PILL, deliberately. Its fill is a translucent teal mix, so
        // walking to the nearest opaque ancestor just returns the CARD — which is black with or
        // without any pinning, in the old code as well as the new. That is precisely the tautology
        // this probe removed for the body text, and reporting it would re-introduce it one element
        // over (roborev 62750). What is true of the pill is that it has no ground of its own; its
        // own translucent fill is reported instead, which is the fact that makes it safe.
        pastePillOwnFill: getComputedStyle(pill).backgroundColor,
        pastePillHasOwnGround: opaque(getComputedStyle(pill).backgroundColor),
      };
    })(),
    labelOnCard: ratio(getComputedStyle(row).color, cardBg),
    pillTextOnCard: pill ? ratio(getComputedStyle(pill).color, cardBg) : null,
    // The affordance is only real if the pill is genuinely inside the card and clickable.
    pillInsideCard: Boolean(pill && card.contains(pill)),
    pillIsButton: pill ? pill.tagName.toLowerCase() : null,
    receiptBelowCard: Boolean(card.parentElement.querySelector('[data-testid="routing-receipt"]')),
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
  try {
    for (const theme of THEMES) {
      const page = await browser.newPage();
      try {
        await page.setViewport({ width: 900, height: 1000, deviceScaleFactor: 2 });
        await page.navigate(
          `${server.url}/scripts/visual/sent-card-harness.html?theme=${theme}&w=380`,
        );
        await page.waitForFunction("window.__sentCardHarnessReady === true", { timeout: 30000 });
        const clip = await page.boundingBox("#column");
        const png = await page.screenshot({ clip });
        const file = join(OUT, `sent-card-${theme}.png`);
        writeFileSync(file, png);
        report[theme] = { file, ...(await page.evaluate(MEASURE)) };
        // THE GUARDS INSIDE `MEASURE` ONLY RETURN AN OBJECT — THIS IS WHAT MAKES THEM A FAILURE.
        // Their `{ error }` is SPREAD into the reading above, so it lands beside a dozen healthy
        // numbers and reads like one more field. Without this check the script printed the error and
        // still exited 0, which is precisely the "coverage retired in silence" the guards were added
        // to end (roborev 62787): a caller checking the exit status could not tell a fully-measured
        // run from one that photographed nothing it claims to cover.
        if (report[theme].error) {
          console.error(`sent-card-shot: ${theme}: ${report[theme].error}`);
          console.error(JSON.stringify(report, null, 2));
          // 3, not 2: the probe RAN. 2 means it could not start (no Chrome, no dev server), and
          // collapsing "measured nothing" onto it would send a reader after the wrong problem.
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
