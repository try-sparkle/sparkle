#!/usr/bin/env node
// blocked-row-narrow-probe — read the REAL GEOMETRY of the pinned "BLOCKED:" row at a narrow
// concierge width and say whether the Approve button ever paints over the agent name.
//
//   pnpm --filter @sparkle/desktop visual:blocked-row-narrow
//   pnpm --filter @sparkle/desktop visual:blocked-row-narrow -- --json
//   pnpm --filter @sparkle/desktop visual:blocked-row-narrow -- --widths=360,280,200,140,90,50
//
// (or `node scripts/visual/blocked-row-narrow-probe.mjs` from apps/desktop). Exit 0 = every check
// passed; exit 1 = a real layout defect; exit 2 = the probe could not run (no Chrome, no server).
//
// ── WHY THIS EXISTS (bead sparkle-jaq7n) ────────────────────────────────────────────────────────
// The founder's own screenshot showed the Approve button painted directly on top of the agent
// name — "@Sparkle Preview Agent Eyes" with "Approve" overlapping mid-string — on the row pinned
// above the composer (`PinnedBlockers.tsx`). **jsdom has no layout engine**: `getBoundingClientRect`
// returns zeros, `scrollWidth`/`clientWidth` are 0, and `text-overflow` never evaluates — so a jsdom
// test that claimed to observe the overlap would be measuring nothing (docs/jsdom-test-caveats.md,
// this repo's #1 fleet-wide finding shape). The style-shape half lives in
// `src/components/Concierge/PinnedBlockers.narrow.test.tsx`; this is the half that can actually fail
// on the geometry, the same split `recap-narrow-probe.mjs` uses for the sibling bug.
//
// ── THE ORDER OF SACRIFICE THIS PROBE VERIFIES (founder, 2026-08-13) ────────────────────────────
// Elements must never overlap. As the column narrows, the row gives up the LEAST useful thing
// first:
//   1. widest    — the coloured dot, "BLOCKED:", the full agent name, the full Approve button.
//   2. narrower  — "BLOCKED:" drops to just the dot (the word is redundant with the colour).
//   3. narrower  — the agent name ellipsizes; the Approve button stays full size (the button is
//                  the point of the row — it is what unblocks the agent).
//   4. narrowest — only here does the button itself shrink to an icon, and the row's own click
//                  still lands the same approval, so the affordance is never lost.
// At every one of those tiers the two things a reader could be hurt by must both hold: nothing
// overlaps, and nothing overflows the column.

import { pathToFileURL } from "node:url";
import { launch } from "./cdp.mjs";
import { startDevServer } from "./serve.mjs";

/** `--key=value` / bare `--flag`. Pure, so the CLI contract is unit-testable. */
export function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}

/**
 * 360 is `CONCIERGE_DEFAULT_WIDTH` — the width every user opens into. 280 and 200 are plausible
 * dragged-narrow readings. 140 and 90 bracket where the label and then the button have to give.
 * 50 is `CONCIERGE_MIN_WIDTH`, the hard floor the resize engine enforces — the column can genuinely
 * be dragged there, so the sweep has to reach it rather than stopping at a width nobody can select.
 */
export const DEFAULT_WIDTHS = [360, 280, 200, 140, 90, 50];

/** Turn the raw `--widths` value into a width list, or `null` when it is not one. A PURE HELPER so
 *  the CLI contract is assertable without booting Chrome (same shape as recap-narrow-probe's, after
 *  roborev 58761 found the un-validated form silently sweeping `NaN`). */
export function parseWidths(raw) {
  if (raw === undefined) return DEFAULT_WIDTHS;
  if (typeof raw !== "string") return null;
  const widths = raw.split(",").map((w) => Number(w.trim()));
  if (widths.length === 0) return null;
  if (widths.some((w) => !Number.isFinite(w) || w <= 0)) return null;
  return widths;
}

/**
 * The measurement, run INSIDE the page. Returned as plain data so the verdict is computed in node,
 * where it can be read in a diff.
 */
const MEASURE = `(() => {
  const column = document.getElementById('column');
  const rows = [...document.querySelectorAll('[data-testid="concierge-pinned-blocker"]')];
  if (rows.length === 0) {
    return { ok: false, reason: 'no [data-testid=concierge-pinned-blocker] row — fixture or testid changed' };
  }

  // A LEAF LABELLED BOX: something that paints ink and contains no other such thing. Same
  // definition row-narrow-probe.mjs uses, so "two things share pixels" means the same thing in
  // both instruments.
  const isInk = (el) => {
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    // 'svg'/'IMG' ONLY — not 'path'. A single icon glyph is often drawn as several <path>
    // elements that deliberately overlap (e.g. a bell plus its "muted" slash), so treating each
    // path as its own leaf reports the icon overlapping itself. Matches row-narrow-probe.mjs.
    if (el.tagName === 'svg' || el.tagName === 'IMG') return true;
    return [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 0);
  };

  // WHAT A BOX ACTUALLY PAINTS, not where it was laid out — the same correction
  // row-narrow-probe.mjs makes. getBoundingClientRect reports the LAYOUT box whether or not an
  // ancestor's overflow clips it, so comparing raw rects invents overlaps between a name that is
  // genuinely ellipsized (nothing painted past the clip) and whatever sits beside it. Every rect is
  // intersected with each clipping ancestor's, up to the row.
  const visibleRect = (el, row) => {
    let r = el.getBoundingClientRect();
    let box = { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    for (let p = el.parentElement; p; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
        const pr = p.getBoundingClientRect();
        box = {
          left: Math.max(box.left, pr.left),
          right: Math.min(box.right, pr.right),
          top: Math.max(box.top, pr.top),
          bottom: Math.min(box.bottom, pr.bottom),
        };
      }
      if (p === row) break;
    }
    box.width = Math.max(0, box.right - box.left);
    box.height = Math.max(0, box.bottom - box.top);
    return box;
  };

  const measured = rows.map((row) => {
    const colRect = column.getBoundingClientRect();

    const inkEls = [...row.querySelectorAll('*')].filter(isInk);
    const leaves = inkEls.filter((el) => !inkEls.some((o) => o !== el && el.contains(o)));

    const overlaps = [];
    for (let i = 0; i < leaves.length; i++) {
      for (let j = i + 1; j < leaves.length; j++) {
        const a = visibleRect(leaves[i], row);
        const b = visibleRect(leaves[j], row);
        if (a.width <= 0 || a.height <= 0 || b.width <= 0 || b.height <= 0) continue;
        const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        // 0.5px tolerance absorbs sub-pixel rounding; anything more is two things genuinely
        // sharing pixels ON SCREEN.
        if (ox > 0.5 && oy > 0.5) {
          overlaps.push({
            a: (leaves[i].textContent || leaves[i].tagName).trim().slice(0, 30),
            b: (leaves[j].textContent || leaves[j].tagName).trim().slice(0, 30),
            px: Math.round(ox * oy),
          });
        }
      }
    }

    const label = row.querySelector('[data-testid="concierge-pinned-blocker-label"]');
    const approve = row.querySelector('button[data-testid="concierge-pinned-blocker-action"]');
    const nameEl = row.querySelector('[data-testid="concierge-agent-pill-name"]');

    // THE WORST OFFENDER AMONG THE ROW *AND EVERY DESCENDANT*, not just the row's own box. A
    // child laid out past its own (correctly-contained) parent is invisible to a check that only
    // reads the parent's rect — this is exactly how the mute/dismiss icon buttons, pushed by an
    // auto left margin, were found painting tens of px past both the row and the column at
    // CONCIERGE_MIN_WIDTH while the row's own rowOverhang read 0. Matches recap-narrow-probe.mjs's
    // "offenders" sweep.
    //
    // THE VISIBLE (CLIPPED) RECT, not the raw layout box. The row's own container now clips
    // (overflow hidden) as the containment floor's backstop, so a control laid out past that clip
    // is not PAINTED past it either; grading the raw box would report a permanent false
    // "overflow" for exactly the case the clip exists to neutralise. A control clipped to nothing
    // contributes 0, same as row-narrow-probe.mjs skipping zero-sized elements.
    // NO BACKTICKS ANYWHERE IN THIS FUNCTION — it is built from a template literal (MEASURE, see
    // above), and one in a comment ends it mid-expression with a SyntaxError pointing at the next
    // identifier.
    const overhangPx = [row, ...row.querySelectorAll('*')].reduce((worst, el) => {
      const v = visibleRect(el, row);
      if (v.width <= 0 && v.height <= 0) return worst;
      return Math.max(worst, v.right - colRect.right);
    }, -Infinity);

    return {
      agentId: row.dataset.agentId,
      text: row.textContent.slice(0, 80),
      overlaps,
      // A row (or anything inside it) wider than the column, or whose right edge passes the
      // column's, is the overflow case this probe exists to catch alongside the overlap.
      rowOverhang: Math.round(Math.max(0, overhangPx)),
      labelVisible: label ? getComputedStyle(label).display !== 'none' : null,
      approveVisible: approve ? getComputedStyle(approve).display !== 'none' : false,
      approveText: approve ? approve.textContent.trim() : null,
      nameTruncated: nameEl ? nameEl.scrollWidth > nameEl.clientWidth + 1 : null,
      nameTitle: (row.querySelector('button[data-testid="concierge-agent-pill"]') || {}).title ?? null,
    };
  });

  return {
    ok: true,
    columnWidth: Math.round(column.getBoundingClientRect().width),
    // THE COLUMN'S OWN scrollWidth, not the document body's — the body carries the browser's
    // default margin around #root, which reads as "scrolls sideways" for every width tested and
    // has nothing to do with the row.
    scrollsSideways: column.scrollWidth > column.clientWidth + 1,
    rows: measured,
  };
})()`;

/** Click the approve control (button or, once it is hidden, the row itself) on EVERY row and
 *  report what fired PER ROW, keyed by its agent id. Clicking only the first row (as an earlier
 *  draft did — roborev 63961) let a hidden button on a LATER row be "verified" by a click on an
 *  earlier one, since the fixture's two rows sit at the same column width and therefore the same
 *  tier — the assertion was never actually about the row it claimed to be about. */
const CLICK_APPROVE = `(() => {
  const rows = [...document.querySelectorAll('[data-testid="concierge-pinned-blocker"]')];
  const perRow = {};
  for (const row of rows) {
    const agentId = row.dataset.agentId;
    window.__blockedRowActions.length = 0;
    window.__blockedRowClicks.length = 0;
    const approve = row.querySelector('button[data-testid="concierge-pinned-blocker-action"]');
    const visible = approve && getComputedStyle(approve).display !== 'none';
    (visible ? approve : row).click();
    perRow[agentId] = {
      clickedApproveButton: Boolean(visible),
      actions: [...window.__blockedRowActions],
      clicks: [...window.__blockedRowClicks],
    };
  }
  return perRow;
})()`;

/** Turn one width's measurement into pass/fail claims. Pure, so the rules are readable and
 *  unit-testable without a browser. */
export function verdictFor(width, m, clicked) {
  const checks = [];
  const add = (ok, name, detail) => checks.push({ ok, name, detail });

  if (!m || m.ok === false) {
    add(false, "the probe could reach the row", m?.reason ?? "no measurement returned");
    return { width, checks, measurement: m };
  }

  const rows = m.rows ?? [];
  if (rows.length === 0) {
    add(false, "the fixture produced rows to measure", "no rows returned");
    return { width, checks, measurement: m };
  }

  // ── 1. NOTHING OVERLAPS, AT EVERY WIDTH — THE FOUNDER'S OWN REPORT ─────────────────────────────
  const collided = rows.filter((r) => r.overlaps.length > 0);
  add(
    collided.length === 0,
    "the Approve button never paints over the agent name (or any other label)",
    collided.length === 0
      ? `${rows.length} row(s) clean`
      : collided
          .map((r) => `"${r.text}": ${r.overlaps.map((o) => `[${o.a}]×[${o.b}] ${o.px}px²`).join(", ")}`)
          .join("; "),
  );

  // ── 2. NOTHING OVERFLOWS THE COLUMN ────────────────────────────────────────────────────────────
  const overhung = rows.filter((r) => r.rowOverhang > 1);
  add(
    !m.scrollsSideways && overhung.length === 0,
    "no row's content passes the column's right edge, and the column does not scroll sideways",
    m.scrollsSideways
      ? "the column scrolls sideways"
      : overhung.length === 0
        ? `${rows.length} row(s) contained`
        : overhung.map((r) => `"${r.text}" overhangs by ${r.rowOverhang}px`).join("; "),
  );

  // ── 3. THE SACRIFICE ORDER: LABEL FIRST, NAME SECOND, BUTTON LAST ──────────────────────────────
  // Every width is graded against the SAME rule rather than a per-tier branch, because the rule IS
  // the ordering: a button may only be hidden on a row whose label is ALSO hidden (never the
  // reverse — that would drop the point of the row before dropping its most redundant word).
  const buttonHiddenWithLabelShown = rows.filter((r) => !r.approveVisible && r.labelVisible === true);
  add(
    buttonHiddenWithLabelShown.length === 0,
    "the button is never hidden while the BLOCKED label is still shown — label goes first",
    buttonHiddenWithLabelShown.length === 0
      ? "sacrifice order respected"
      : buttonHiddenWithLabelShown.map((r) => `"${r.text}"`).join("; "),
  );

  // ── 4. EVERY ROW, CLICKED, FIRES EXACTLY ITS OWN APPROVAL — CHECKED PER ROW ────────────────────
  // `clicked` is keyed by agent id (see CLICK_APPROVE), which now clicks EVERY row — including
  // ones whose button is still visible. Two roborev findings (job 64018), both fixed here:
  //
  //   (1) GRADE EVERY ROW, not only the ones with a hidden button. `CLICK_APPROVE` was already
  //       pressing the real Approve button on a roomy-width row and recording what fired, but this
  //       loop used to filter to `!r.approveVisible` first — so that evidence was collected and
  //       then thrown away, and a wide-width row whose button rendered but had a stale/detached
  //       handler would sail through the whole sweep ungraded.
  //   (2) CHECK IDENTITY, not just "some approve action fired". `c.actions[0][1] === "approve"`
  //       reads only the action id and never the AGENT id the action was attributed to
  //       (`c.actions[0][0]`) — so if every row's activation closed over the wrong blocker (e.g.
  //       always `blockers[0]`), each row would still record `[id, "approve"]` for ITS OWN
  //       `clicked[agentId]` key and both checks would read as verified. Comparing
  //       `c.actions[0][0] === r.agentId` is what actually distinguishes "row B fired its own
  //       approval" from "row B's key happens to hold row A's click".
  for (const r of rows) {
    const c = clicked?.[r.agentId];
    const tier = r.approveVisible ? "the visible Approve button" : "the row itself (button hidden)";
    add(
      c?.actions?.length === 1 &&
        c.actions[0][0] === r.agentId &&
        c.actions[0][1] === "approve",
      `clicking ${tier} on row "${r.text}" fires exactly that row's OWN approval`,
      c ? `clickedApproveButton=${c.clickedApproveButton}, actions=${JSON.stringify(c.actions)}` : "not measured",
    );
  }

  // ── 5. A TRUNCATED NAME IS ALWAYS RECOVERABLE ──────────────────────────────────────────────────
  const truncated = rows.filter((r) => r.nameTruncated === true);
  if (truncated.length > 0) {
    add(
      truncated.every((r) => typeof r.nameTitle === "string" && r.nameTitle.length > 0),
      "a truncated agent name still carries its full name in a title/tooltip",
      truncated.map((r) => `"${r.text}" title=${JSON.stringify(r.nameTitle)}`).join("; "),
    );
  }

  return { width, checks, measurement: m };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const widths = parseWidths(args.widths);
  if (widths === null) {
    console.error(
      `--widths must be a comma-separated list of positive numbers (got: ${String(args.widths)})`,
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
    browser = await launch({ width: 1200, height: 900 });
  } catch (e) {
    server.stop();
    console.error(`could not launch Chrome: ${e.message}`);
    process.exit(2);
  }

  const results = [];
  try {
    for (const width of widths) {
      const page = await browser.newPage();
      try {
        await page.navigate(`${server.url}/scripts/visual/blocked-row-narrow-harness.html?w=${width}`);
        await page.waitForFunction("window.__blockedRowHarnessReady === true", { timeout: 30000 });
        // THE RESIZEOBSERVER RACE. `PinnedBlockers` measures its own column width via a
        // ResizeObserver on its parent (see PinnedBlockers.tsx's `data-column-width`), and that
        // observer's first callback is not guaranteed to have run by the time the two-rAF ready
        // flag above flips — so without this wait, the row was sometimes measured while still at
        // its "unmeasured" (0 → roomy) default REGARDLESS of the width under test, which silently
        // graded every tier check against the wrong tier. Wait for the exposed attribute to catch
        // up to the width actually requested before reading anything else.
        // 2px tolerance: contentRect.width is a float (border/subpixel rounding), so an exact
        // string match would spin until timeout on a fractional reading that never lands on the
        // integer requested.
        await page.waitForFunction(
          `Math.abs(Number(document.querySelector('[data-testid="concierge-pinned-blockers"]')?.dataset.columnWidth) - ${width}) <= 2`,
          { timeout: 30000 },
        );
        const m = await page.evaluate(MEASURE);
        const clicked = await page.evaluate(CLICK_APPROVE);
        if (page.consoleErrors.length) {
          console.error(`page errors at ${width}px:\n  ${page.consoleErrors.join("\n  ")}`);
        }
        results.push(verdictFor(width, m, clicked));
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
    server.stop();
  }

  const failed = results.filter((r) => r.checks.some((c) => !c.ok));
  if (args.json) {
    console.log(JSON.stringify({ results, ok: failed.length === 0 }, null, 2));
  } else {
    for (const r of results) {
      console.log(`\n── ${r.width}px ${"─".repeat(48)}`);
      for (const c of r.checks) console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${c.name}\n          ${c.detail}`);
    }
    console.log(
      failed.length === 0
        ? `\nBLOCKED ROW NARROW PROBE PASSED (${results.length} width(s): ${widths.join(", ")})`
        : `\nBLOCKED ROW NARROW PROBE FAILED at ${failed.map((r) => `${r.width}px`).join(", ")}`,
    );
  }
  process.exit(failed.length === 0 ? 0 : 1);
}

// `pathToFileURL`, not string concatenation — Sparkle's own worktrees live under a path containing
// a space, which `import.meta.url` percent-encodes and a raw comparison would not. See
// recap-narrow-probe.mjs for the fuller note; the same trap applies here.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(2);
  });
}
