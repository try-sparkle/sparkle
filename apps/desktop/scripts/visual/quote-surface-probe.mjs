#!/usr/bin/env node
// quote-surface-probe — the concierge's quote chrome, measured in Chrome, in BOTH themes.
//
//   pnpm --filter @sparkle/desktop visual:quote-surface
//   pnpm --filter @sparkle/desktop visual:quote-surface -- --json
//   pnpm --filter @sparkle/desktop visual:quote-surface -- --themes=light --keep
//
// ── TWO FOUNDER REPORTS, ONE COMPONENT ─────────────────────────────────────────────────────────
//
//   COLLISION  a screenshot: the copy glyph painted ON the blue blockquote rule, with the quoted
//              text starting straight after it. *"move the copy glyph OFF the blockquote rule … so
//              the rule, the icon and the quoted text each own their own space."*
//   RADIUS     *"Make this quote response button less rounded I can't stand the rounded buttons
//              like that."* — the floating "Quote in response" chiclet, which was `borderRadius:
//              PILL`.
//
// ── WHY A BROWSER, AND NOT A UNIT TEST ─────────────────────────────────────────────────────────
//
// The collision is a FLOAT rule, and jsdom implements no floats whatsoever. The copy glyph is
// `float: left` (ConciergeMessageRow); a float shortens the LINE BOXES beside it and never a
// following BLOCK's box, so a `<blockquote>`'s `border-left` is laid at the container's left edge —
// underneath the float — while its inline text is pushed clear of it. Every rect in jsdom is zero,
// so no assertion there can see either box, let alone their intersection. This is the same class of
// defect as the tab strip's clipped seam next door (`tab-seam-probe.mjs`): the thing that paints the
// offending pixels is not the element whose style a reader would inspect.
//
// The radius is measurable without a browser, and `Concierge/QuoteChiclet.radius.test.tsx` does pin
// it there. It is ALSO read here because the founder asked for both themes and because a computed
// `border-radius` is the honest end of that claim — a token could be re-pointed at a capsule value
// and the unit test, which reads the same token, would move with it.
//
// ── BOTH THEMES, EVERY RUN ─────────────────────────────────────────────────────────────────────
//
// Not thoroughness for its own sake. The blockquote's rule is `C.tealInk`, which resolves to a
// DIFFERENT colour per theme, and the copy glyph is `C.conciergeMuted` at 45% opacity — so "can you
// see the collision" has a different answer in each, and a fix eyeballed in dark only is a fix
// verified in half the product. The geometry assertion is theme-independent by construction, which
// is precisely why it is the one worth running twice: if it ever disagrees between themes, something
// is theme-dependent that should not be.
//
// Exit 0 = measured and clean, 1 = a real regression, 2 = the probe could not run.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "./cdp.mjs";
import { startDevServer, DESKTOP_DIR } from "./serve.mjs";

/** `--key=value` / bare `--flag`. Pure, so the CLI contract is unit-testable. */
export function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}

export const DEFAULT_THEMES = ["dark", "light"];

/** Parse `--themes`, or `null` when the argument is unusable. */
export function parseThemes(raw) {
  if (raw === undefined) return DEFAULT_THEMES;
  if (typeof raw !== "string") return null;
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) return null;
  if (parts.some((p) => p !== "dark" && p !== "light")) return null;
  return parts;
}

/**
 * The largest corner the founder's "less rounded" can mean, in CSS px.
 *
 * `RADIUS.modal` (6) is the app's own CEILING — `theme/scale.ts`: *"FOUR radii, all small … `modal`
 * is the largest thing on screen."* Bounding on the ceiling rather than on the exact step the
 * component picked is deliberate: this probe's job is "not a pill", and pinning the precise value
 * belongs to the unit test, where changing it is a one-line, reviewable decision rather than a
 * pixel measurement someone has to re-derive.
 */
export const MAX_RADIUS_PX = 6;

/**
 * THE COLLISION VERDICT, PURE AND EXPORTED.
 *
 * `rule` is the blockquote's `border-left` band — the strip between its border box's left edge and
 * that edge plus the border's own width. `icon` is the copy button's border box. They must not
 * intersect HORIZONTALLY while they overlap VERTICALLY; either separation alone is enough, and
 * requiring both would fail a perfectly good layout that simply puts the glyph above the quote.
 *
 * TOLERANCE IS ZERO, and that is a choice worth stating: sub-pixel adjacency is not a collision, but
 * a rule and a glyph that share ANY painted column is exactly the defect in the screenshot. The
 * boxes are compared as half-open ranges so two boxes that merely touch (`icon.right === rule.left`)
 * pass — which is the tightest legitimate layout and must not read as a failure.
 */
export function gradeCollision({ theme, icon, rule, iconFloat }) {
  const failures = [];
  if (!icon || !rule) {
    return [
      `${theme}: could not measure the ${!icon ? "copy glyph" : "blockquote rule"} — ` +
        `a missing measurement is not a pass`,
    ];
  }
  // THE FIXTURE MUST STILL REPRODUCE THE PRODUCT. `main()` checks that the ROW still floats the
  // glyph; this checks that the HARNESS does. Without both, the guard is one-directional and a
  // harness that quietly stopped floating would make every collision impossible and every run
  // green (roborev 63277). `undefined` is not checked — only an explicit reading that disagrees —
  // so a caller that cannot measure it still gets the geometry verdict rather than a false alarm.
  if (iconFloat !== undefined && iconFloat !== null && iconFloat !== "left") {
    failures.push(
      `${theme}: the harness's copy glyph is not floating (cssFloat=${JSON.stringify(iconFloat)}), ` +
        `so no collision with the quote rule is possible and this measurement proves nothing — ` +
        `the fixture has stopped reproducing ConciergeMessageRow`,
    );
  }
  if (!(rule.width > 0)) {
    // The rule vanishing would satisfy "no overlap" perfectly and is not the fix that was asked
    // for: the founder wants the rule, the icon and the text each in their own space, which
    // presupposes there is still a rule.
    failures.push(`${theme}: the blockquote has no left rule at all (width ${rule.width})`);
  }
  const overlapsX = icon.left < rule.right && rule.left < icon.right;
  const overlapsY = icon.top < rule.bottom && rule.top < icon.bottom;
  if (overlapsX && overlapsY) {
    failures.push(
      `${theme}: the copy glyph is painted ON the blockquote rule — icon x ` +
        `${icon.left.toFixed(1)}..${icon.right.toFixed(1)}, rule x ` +
        `${rule.left.toFixed(1)}..${rule.right.toFixed(1)} (they share ` +
        `${(Math.min(icon.right, rule.right) - Math.max(icon.left, rule.left)).toFixed(1)}px), ` +
        `and they overlap vertically too. The rule, the icon and the quoted text must each own ` +
        `their own space.`,
    );
  }
  return failures;
}

/** The radius verdict. `radiusPx` is the computed `border-top-left-radius`, already in px. */
export function gradeRadius({ theme, radiusPx, maxPx = MAX_RADIUS_PX }) {
  if (!Number.isFinite(radiusPx)) {
    return [`${theme}: could not read the quote chiclet's corner radius — a missing measurement is not a pass`];
  }
  if (radiusPx > maxPx) {
    return [
      `${theme}: the "Quote in response" chiclet's corner radius is ${radiusPx}px ` +
        `(ceiling ${maxPx}px — the app's own largest step). The founder asked for it to be less ` +
        `rounded; anything above the scale's ceiling reads as a pill.`,
    ];
  }
  return [];
}

/**
 * THE HARNESS COPIES `ConciergeMessageRow`'S FLOAT, so it has to be checked against it.
 *
 * The fixture reproduces the row's two-element relationship verbatim rather than importing the row
 * (which needs the whole concierge store graph). That is a copy, and a copy of a layout rule is a
 * thing that drifts silently: the row could stop floating the glyph, the collision would be gone in
 * the product, and this probe would keep measuring — and passing — a shape nothing renders.
 *
 * So the float is re-read from the row's own source. `null` when the row no longer floats the copy
 * glyph left, which is a FAILURE at the call site rather than a pass.
 */
export function rowFloatsCopyGlyphLeft(rowSource) {
  return /float:\s*"left"[\s\S]{0,160}?<CopyAnswerButton/.test(rowSource);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function measureTheme(page, serverUrl, theme, { keepShots }) {
  await page.setColorScheme(theme);
  await page.navigate(`${serverUrl}/scripts/visual/quote-surface-harness.html?theme=${theme}`);
  try {
    await page.waitForFunction("window.__quoteHarnessReady === true", { timeout: 30000 });
  } catch (e) {
    const errs = page.consoleErrors.length
      ? `\npage errors:\n  ${page.consoleErrors.join("\n  ")}`
      : "\n(no page errors were reported — check the dev server compiled the harness)";
    throw new Error(`${e.message}${errs}`);
  }
  await sleep(250);

  const measured = await page.evaluate(
    `(() => {
       const q = document.querySelector('[data-testid="answer"] blockquote');
       const btn = document.querySelector('[data-testid="answer"] button');
       const chiclet = document.querySelector('[data-testid="quote-chiclet"]');
       // WALK UP TO THE FLOATED ANCESTOR, do not assume the parent. CopyAnswerButton wraps its own
       // button in a flex div, so the floated span is the GRANDparent -- reading the immediate
       // parent returns "none" and reports a healthy fixture as broken. (Caught by this very guard
       // on its first run, which is the argument for it existing.) Bounded by the answer container
       // so this can never walk out to the document.
       const floatOf = (el) => {
         let n = el?.parentElement ?? null;
         while (n && n.dataset.testid !== "answer") {
           const f = getComputedStyle(n).cssFloat;
           if (f && f !== "none") return f;
           n = n.parentElement;
         }
         return "none";
       };
       const box = (el) => {
         if (!el) return null;
         const r = el.getBoundingClientRect();
         return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width };
       };
       let rule = null;
       if (q) {
         const r = q.getBoundingClientRect();
         // THE RULE IS THE BORDER BAND, not the blockquote. Comparing against the whole element
         // would call every quote a collision the moment a glyph sat beside its text.
         const w = parseFloat(getComputedStyle(q).borderLeftWidth) || 0;
         rule = { left: r.left, right: r.left + w, top: r.top, bottom: r.bottom, width: w };
       }
       return {
         icon: box(btn),
         rule,
         quote: box(q),
         // IS THE FIXTURE'S OWN GLYPH STILL FLOATING? The drift guard in main() reads the
         // PRODUCT's source; this reads the HARNESS's rendered state, and without it that guard is
         // one-directional -- drop the float in the harness and the glyph stops being a float, no
         // block can collide with it, the collision verdict comes back clean, and the probe reports
         // PASS while measuring a shape that reproduces nothing (roborev 63277).
         // NO BACKTICKS IN HERE: this comment is inside a template literal, and one would end it.
         iconFloat: floatOf(btn),
         radiusPx: chiclet ? parseFloat(getComputedStyle(chiclet).borderTopLeftRadius) : NaN,
       };
     })()`,
  );

  const failures = [
    ...gradeCollision({
      theme,
      icon: measured.icon,
      rule: measured.rule,
      iconFloat: measured.iconFloat,
    }),
    ...gradeRadius({ theme, radiusPx: measured.radiusPx }),
  ];

  let shot = null;
  if (failures.length || keepShots) {
    shot = path.join(os.tmpdir(), `quote-surface-${theme}.png`);
    fs.writeFileSync(shot, await page.screenshot());
  }

  return { theme, ok: failures.length === 0, failures, ...measured, shot };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const themes = parseThemes(args.themes);
  if (themes === null) {
    console.error(`--themes must be a comma-separated list of dark|light (got: ${String(args.themes)})`);
    process.exit(2);
  }

  // The drift guard runs BEFORE Chrome: it needs no browser, and a fixture that no longer matches
  // the product makes every measurement below meaningless rather than merely suspect.
  const rowPath = path.join(DESKTOP_DIR, "src/components/Concierge/ConciergeMessageRow.tsx");
  let rowSource = "";
  try {
    rowSource = fs.readFileSync(rowPath, "utf8");
  } catch (e) {
    console.error(`could not read ${rowPath}: ${e.message}`);
    process.exit(2);
  }
  if (!rowFloatsCopyGlyphLeft(rowSource)) {
    console.error(
      "ConciergeMessageRow no longer floats the copy glyph left, so this probe's fixture no longer " +
        "reproduces the product. Update quote-surface-harness.jsx to match the row before trusting a number.",
    );
    process.exit(2);
  }

  let server;
  let browser;
  try {
    server = await startDevServer({ quiet: !args.verbose });
  } catch (e) {
    console.error(`could not start the dev server: ${e.message}`);
    process.exit(2);
  }
  try {
    browser = await launch({ width: 900, height: 500 });
  } catch (e) {
    server.stop();
    console.error(`could not launch Chrome: ${e.message}`);
    process.exit(2);
  }

  const results = [];
  try {
    for (const theme of themes) {
      // A fresh page per theme: the harness stamps `data-theme` at module scope, so a reused page
      // would keep the first theme's attribute while the emulated media query changed underneath.
      const page = await browser.newPage();
      try {
        results.push(await measureTheme(page, server.url, theme, { keepShots: !!args.keep }));
      } finally {
        await page.close();
      }
    }
  } catch (e) {
    await browser.close();
    server.stop();
    console.error(`the probe could not complete: ${e.message}`);
    process.exit(2);
  }
  await browser.close();
  server.stop();

  if (args.json) {
    console.log(JSON.stringify({ results }, null, 2));
  } else {
    for (const r of results) {
      const gap = r.icon && r.rule ? (r.rule.left - r.icon.right).toFixed(1) : "?";
      console.log(
        `theme=${r.theme}  icon→rule gap=${gap}px  chiclet radius=${r.radiusPx}px  ${r.ok ? "OK" : "FAIL"}`,
      );
      for (const f of r.failures) console.log(`   ✗ ${f}`);
      if (r.shot) console.log(`   shot: ${r.shot}`);
    }
  }
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}

// Only when run directly, so the pure exports above can be imported by the harness tests.
// `fileURLToPath`, never `new URL(...).pathname`: this repo lives under a path containing a space,
// which percent-encodes there and would make the comparison silently false.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
