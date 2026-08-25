#!/usr/bin/env node
// Does WebKit paint `text-overflow: ellipsis` when `overflow: clip`?
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────────
// `.clip-no-scroll` (index.css) is `overflow: hidden` upgraded to `clip` under `@supports`, and two
// consumers rely on it while ALSO setting `text-overflow: ellipsis`: the concierge pill's name span
// (`AgentPill.NAME_CLIP_CLASS`) and three cells of the recap card (`RecapCard.CLIP_CLASS`). The
// upgrade exists so the box stops being a scroll container — a scroll container's alignment
// baseline is synthesised from its border box, which drops every dot-less pill off the baseline of
// the prose around it.
//
// The pairing that matters — `overflow: clip` PLUS `text-overflow: ellipsis` — is not observable
// from either existing test tier, and that gap is the whole point (roborev 58759):
//
//   • jsdom never loads the stylesheet, so a unit test can only read the rule TEXT, never its effect.
//   • `recap-narrow-probe.mjs` drives Chrome, and the app ships in a WKWebView.
//
// So on the engine that actually renders for users, the `clip` branch was backed by no evidence, and
// its failure mode is exactly the bug the ellipsis exists to prevent: a name hard-cut mid-glyph with
// nothing to say it was cut — on `-unwired`, i.e. what SupportModal and agent replies render.
//
// ── WHY PIXELS, AND NOT AN ASSERTION ────────────────────────────────────────────────────────────
// An ellipsis is PAINTED. It is not in `textContent`, not in `getComputedStyle`, and not exposed
// anywhere the DOM can be asked about it, so there is nothing to assert on. The only honest reading
// is to render the known-good control beside the candidate and compare what came out:
//
//   A: overflow: hidden + text-overflow: ellipsis   <- universally supported, the control
//   B: overflow: clip   + text-overflow: ellipsis   <- what `.clip-no-scroll` computes to on WebKit 16+
//
// Identical bytes => WebKit paints the ellipsis under `clip` too, and the upgrade is safe.
// Different bytes => `clip` drops it, and the ellipsizing boxes must stay on `hidden` — whose own
//                    baseline cost was measured at Δ0.00 in Chrome, so that revert is nearly free.
//
// ── HOW IT IS RUN ───────────────────────────────────────────────────────────────────────────────
// OPT-IN, like its sibling probes, and deliberately NOT part of `pnpm verify`: it needs
// `npx playwright install webkit`, which CI does not do (nothing in .github/workflows/ci.yml
// installs browser binaries — the same reason scripts/visual/ drives system Chrome over raw CDP).
//
//     node apps/desktop/scripts/visual/webkit-clip-ellipsis.mjs
//
// Exit 0 = the pairing holds. Exit 1 = it does not, and the two consumers above must revert to
// `overflow: hidden`. Exit 2 = the probe could not run (no webkit build installed), which is NOT a
// verdict about the CSS — the same three-way convention `recap-narrow-probe.mjs` uses.
//
// ── THE READING ─────────────────────────────────────────────────────────────────────────────────
// MEASURED 2026-08-24 by actually running this file — `node apps/desktop/scripts/visual/webkit-
// clip-ellipsis.mjs`, exit 0. Before that date the line here recorded a reading no run is known to
// have produced; it is replaced by this one, which was taken from the output quoted below.
//
//   engine            : WebKit 26.5 (AppleWebKit/605.1.15, Version/26.5 Safari/605.1.15),
//                       playwright 1.61.1, browser build webkit-2311, macOS (darwin arm64)
//   CSS.supports clip : true
//   computed #a       : hidden          (overflow: hidden + text-overflow: ellipsis — the control)
//   computed #b       : clip            (overflow: clip   + text-overflow: ellipsis — the candidate)
//   #a screenshot     : 2187 bytes
//   #b screenshot     : 2187 bytes
//   pixels identical  : true            (Buffer.compare === 0)
//
// VERDICT: **WebKit PAINTS the ellipsis under `overflow: clip`**, pixel-for-pixel as it does under
// `hidden`. `.clip-no-scroll` is safe on an ellipsizing box, so `AgentPill.NAME_CLIP_CLASS` and
// `RecapCard.CLIP_CLASS` stay as they are. Nothing to revert; the bead's fallback (drop those spans
// back to `overflow: hidden`, Chrome cost Δ0.00px baseline) was NOT needed and was not taken.
//
// THE INSTRUMENT IS NOT VACUOUS — asked separately, because "identical bytes" is also what a probe
// that rendered two blank boxes would report. Re-run with #b's `text-overflow` set to `clip` (the
// exact failure mode: a hard cut, no "…"), same engine, same HTML otherwise: 2187 vs 2386 bytes,
// NOT identical. So the comparison does see a dropped ellipsis when there is one to see, and the
// PASS above is a measurement rather than an artefact.
//
// ONE THING THIS DOES NOT COVER, stated rather than left to be rediscovered: playwright's WebKit
// is a current build, while the shipped app renders in the OS WKWebView, whose engine tracks the
// user's Safari. `overflow: clip` arrived in Safari 16, and `tauri.conf.json` allows back to macOS
// 11 — which is precisely why `.clip-no-scroll` is `hidden` with a `@supports` upgrade rather than
// bare `clip`. On an engine too old to support `clip` the @supports block is skipped entirely and
// the box stays `hidden`, so the pairing measured here is the only one that can ever reach a user.
// Cited from `NAME_CLIP_CLASS`.
import { pathToFileURL } from "node:url";
import { webkit } from "playwright";

/** Both boxes are deliberately identical apart from `overflow`, and narrow enough that the name
 *  overflows — the string is the real one from the founder's screenshot, so the measurement is
 *  taken on the content that motivated it rather than on lorem. */
export const HTML = `<!doctype html><meta charset="utf-8">
<style>
  body { margin: 0; background: #fff; font: 13px system-ui; }
  .box {
    width: 120px; white-space: nowrap; text-overflow: ellipsis;
    background: #fff; color: #000; padding: 4px; margin: 0;
  }
  #a { overflow: hidden; }
  #b { overflow: clip; }
</style>
<div class="box" id="a">@Concierge Says What It Is Doing</div>
<div class="box" id="b">@Concierge Says What It Is Doing</div>`;

async function main() {
  let browser;
  try {
    browser = await webkit.launch();
  } catch (e) {
    // No webkit build. Say so in the probe's own vocabulary rather than reporting a CSS verdict
    // nobody measured — the "silent green for an instrument" failure this directory keeps guarding.
    console.error(`could not launch WebKit (run \`npx playwright install webkit\`): ${e.message}`);
    process.exit(2);
  }

  const page = await browser.newPage({ viewport: { width: 300, height: 120 } });
  await page.setContent(HTML);

  const support = await page.evaluate(() => ({
    supportsClip: CSS.supports("overflow", "clip"),
    computedA: getComputedStyle(document.getElementById("a")).overflow,
    computedB: getComputedStyle(document.getElementById("b")).overflow,
  }));

  const a = await page.locator("#a").screenshot();
  const b = await page.locator("#b").screenshot();
  await browser.close();

  const identical = Buffer.compare(a, b) === 0;

  console.log("CSS.supports clip :", support.supportsClip);
  console.log("computed #a       :", support.computedA, "(overflow: hidden)");
  console.log("computed #b       :", support.computedB, "(overflow: clip)");
  console.log("pixels identical  :", identical);
  console.log(
    identical
      ? "PASS: WebKit paints the ellipsis under `clip` exactly as under `hidden` — .clip-no-scroll is safe."
      : "FAIL: WebKit renders `clip` differently from `hidden` — the ellipsis is at risk. " +
          "Revert AgentPill.NAME_CLIP_CLASS and RecapCard.CLIP_CLASS to `overflow: hidden`.",
  );
  process.exit(identical ? 0 : 1);
}

// Importable for a unit test without launching anything, the way the sibling probes are structured.
//
// `pathToFileURL`, NOT a `file://${process.argv[1]}` template — this repo is checked out under a
// path containing a SPACE ("Application Support"), which `import.meta.url` percent-encodes and a
// raw template does not. The two strings then never match, the guard silently declines to run, and
// the probe exits 0 having measured NOTHING: a passing exit code for an instrument that never ran,
// which is the exact failure this directory keeps guarding against. Measured here, not theorised.
if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
