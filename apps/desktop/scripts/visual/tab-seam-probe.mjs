#!/usr/bin/env node
// tab-seam-probe — does the ACTIVE project tab open into the content area, at reduced zoom?
//
//   pnpm --filter @sparkle/desktop visual:tab-seam
//   pnpm --filter @sparkle/desktop visual:tab-seam -- --json
//   pnpm --filter @sparkle/desktop visual:tab-seam -- --scales=0.7,1
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────────
//
// Two founder reports, one strip:
//
//   bead sparkle-civ4i  *"Active project tab draws a bottom border so the tab strip rule runs under
//                       it — the active tab must open into the content area like a folder tab."*
//   the click half      clicking a tab that is not the active one must MAKE it the active one.
//
// Neither is answerable by a unit test. jsdom never lays out and never loads the stylesheet, so a
// green suite is compatible with a visible line under the active tab; and it never hit-tests, so a
// click that the browser routes somewhere else still "lands" there. Reasoning from the source is no
// better for the rule: the line under the active tab is painted by a DIFFERENT element than the one
// whose style you would read — the bar's own bottom edge — and whether the tab's face covers it
// depends on the strip's `overflow` clip, not on the tab's own `border-bottom`.
//
// ── WHY `--scales` AND WHY 0.7/0.8/0.9 ──────────────────────────────────────────────────────────
//
// The founder reads the app zoomed OUT. A page at 70% zoom is, to the rasteriser, a page whose
// device-pixel ratio is 0.7: one CSS pixel no longer owns a whole device pixel, so a 1px rule and a
// 1px overlap of it round INDEPENDENTLY and need not cancel. `Emulation.setDeviceMetricsOverride`
// takes a fractional `deviceScaleFactor`, so those zooms are reproducible here exactly.
//
// A design that covers the rule by out-measuring it is therefore never trustworthy at one scale
// alone; the fix has to be one whose correctness does not depend on the rounding, and the only way
// to show that is to measure at several.
//
// Exit 0 = measured and clean, 1 = a real regression, 2 = the probe could not run (no Chrome, no
// dev server, a harness that would not mount).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "./cdp.mjs";
import { startDevServer } from "./serve.mjs";
import { decodePng } from "./png.mjs";
import { pixelAt, runsOf, toHex, channelDelta } from "./seam-probe.mjs";

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
 * The zooms to measure at.
 *
 * 1 is in the list DELIBERATELY, and it is not padding: without it a failure cannot distinguish
 * "this breaks when zoomed out" from "this is broken everywhere", and those send the reader to
 * different code.
 */
export const DEFAULT_SCALES = [0.7, 0.8, 0.9, 1];

/** Parse `--scales`, or `null` when the argument is unusable. */
export function parseScales(raw) {
  if (raw === undefined) return DEFAULT_SCALES;
  if (typeof raw !== "string") return null;
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) return null;
  const nums = parts.map(Number);
  // Chrome refuses a deviceScaleFactor outside (0, 100]; bounding here names the caller's mistake
  // instead of surfacing a protocol error from four frames away.
  if (nums.some((n) => !Number.isFinite(n) || n <= 0 || n > 4)) return null;
  return nums;
}

/**
 * The strip width the harness is asked to model.
 *
 * NARROW ENOUGH TO CROWD the six long names, deliberately: the hover expansion only widens a tab
 * whose name is being clipped, so at a roomy width the click-across-an-expansion case below would
 * be exercising a gesture that cannot go wrong and reporting it as evidence.
 */
export const HARNESS_WIDTH = 620;

/** How far ABOVE the bar's bottom edge the scan starts, in CSS px — inside the tab's own bottom
 *  padding, so the band is plain tab face and never a glyph. */
export const SCAN_INSET_CSS = 6;
/** How far BELOW the bar's bottom edge the scan runs, in CSS px — into the content plane. */
export const SCAN_OUTSET_CSS = 6;

/**
 * The widest band that still counts as a RULE rather than as a third surface, in CSS px.
 *
 * A 1px rule is 1 image px at scale 1 and can round to 2 at a fractional scale; 3 CSS px of slack
 * keeps a genuinely different plane (a header, a shadow gradient) from being mistaken for one.
 */
export const RULE_MAX_CSS = 3;

/** Read one vertical line of pixels and collapse it into runs, with absolute y positions attached.
 *  The column twin of `seam-probe.mjs`'s `scanRow`, which only scans horizontally. */
export function scanColumn(img, x, yFrom, yTo, tolerance = 2) {
  const pixels = [];
  for (let y = yFrom; y <= yTo; y++) pixels.push(pixelAt(img, x, y));
  let y = yFrom;
  return runsOf(pixels, tolerance).map((run) => {
    const at = { from: y, to: y + run.width - 1, ...run, hex: toHex(run.color) };
    y += run.width;
    return at;
  });
}

/**
 * THE RULE, as read off a tab that is NOT active — a run that is neither of the planes it sits
 * between, and narrow enough to be a rule.
 *
 * Read EMPIRICALLY rather than compared against a token, and that is the point: the probe then says
 * nothing about which colour the rule ought to be, so it keeps working across themes and across a
 * retint, and the active-tab verdict below is "that exact band is absent" rather than "some colour I
 * was told to look for is absent".
 *
 * `null` when the scan shows no such band. That is a FAILURE at the call site, not a pass: a fix
 * that deleted the rule everywhere would otherwise make the active-tab check vacuously true.
 */
export function ruleBandOf(runs, ruleMaxPx) {
  if (runs.length < 3) return null;
  for (let i = 1; i < runs.length - 1; i++) {
    const band = runs[i];
    if (band.width > ruleMaxPx) continue;
    // Between two DIFFERENT planes or between two identical ones — either way it is an
    // interruption. What disqualifies a run is only being one of the planes itself.
    if (channelDelta(band.color, runs[0].color) <= 2) continue;
    if (channelDelta(band.color, runs[runs.length - 1].color) <= 2) continue;
    return band;
  }
  return null;
}

/**
 * THE VERDICT, PURE AND EXPORTED — so the grading can be tested without Chrome.
 *
 * Three claims, and all three have to hold or the run is not evidence of anything:
 *
 *  1. the rule EXISTS under an inactive tab. Without this the probe passes a strip that has no rule
 *     at all, which is a different design and not the one asked for.
 *  2. the active tab READS AS ACTIVE — its face is not the bar's own surface. Without this a strip
 *     that simply stopped painting an active state would satisfy (3) perfectly.
 *  3. the rule does NOT appear under the active tab.
 */
export function gradeSeam({ scale, activeRuns, inactiveRuns, ruleMaxPx }) {
  const failures = [];
  if (!activeRuns?.length || !inactiveRuns?.length) {
    return [`scale ${scale}: the column scans came back empty — nothing was measured, which is not a pass`];
  }
  const rule = ruleBandOf(inactiveRuns, ruleMaxPx);
  if (!rule) {
    failures.push(
      `scale ${scale}: no rule was found under the INACTIVE tab ` +
        `(runs: ${inactiveRuns.map((r) => `${r.hex}×${r.width}`).join(" ")}) — so the ` +
        `active-tab check below would pass by the rule simply not existing`,
    );
    return failures;
  }
  const barSurface = inactiveRuns[0].color;
  const activeFace = activeRuns[0].color;
  if (channelDelta(activeFace, barSurface) <= 2) {
    failures.push(
      `scale ${scale}: the ACTIVE tab's face is ${toHex(activeFace)}, the same as the bar's own ` +
        `surface ${toHex(barSurface)} — it does not read as active, so an absent rule beneath it ` +
        `would prove nothing`,
    );
  }
  const under = activeRuns.filter((r) => channelDelta(r.color, rule.color) <= 2);
  if (under.length) {
    failures.push(
      `scale ${scale}: the strip's rule (${rule.hex}) is painted UNDER the active tab at ` +
        under.map((r) => `y ${r.from}..${r.to} (${r.width}px)`).join(", ") +
        ` — the active tab must open into the content area, not sit on top of a line. ` +
        `Active column runs: ${activeRuns.map((r) => `${r.hex}×${r.width}`).join(" ")}`,
    );
  }
  return failures;
}

/**
 * The click half. A press on a tab that is not the active one must make it the active one.
 *
 * `gesture` names WHICH click, because the two this probe performs fail for different reasons and a
 * verdict that does not say which one is a bug report nobody can act on.
 */
export function gradeClick({ scale, gesture, clicked, selected }) {
  if (selected === clicked) return [];
  return [
    `scale ${scale}: the ${gesture} click on the non-active tab ${clicked} did not activate it — ` +
      `the strip reports ${JSON.stringify(selected)} as selected instead`,
  ];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Move the real pointer.
 *
 * `button: "none"` is REQUIRED — CDP's `mouseMoved` needs an explicit button state and silently
 * produces nothing useful without it. Sent TWICE a pixel apart, because the browser derives
 * `mouseover`/`mouseout` from a CHANGE of hit-tested element, so the first move of a session can
 * land with no transition to report.
 */
async function movePointer(page, x, y) {
  for (const dx of [0, 1]) {
    await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x + dx, y, button: "none", buttons: 0 });
  }
}

/** Press and release at a point — a real click, hit-tested by the browser. */
async function clickAt(page, x, y) {
  for (const type of ["mousePressed", "mouseReleased"]) {
    await page.send("Input.dispatchMouseEvent", {
      type,
      x,
      y,
      button: "left",
      buttons: type === "mousePressed" ? 1 : 0,
      clickCount: 1,
    });
  }
}

/** Park the pointer well clear of the strip so any expanded tab collapses. */
async function unhover(page) {
  await movePointer(page, 5, 340);
}

/** Where the label of each tab sits, and where the bar's bottom edge is — all in CSS px. */
async function geometry(page, ids) {
  return page.evaluate(
    `(() => {
       const bar = document.querySelector('.concierge-tabbar');
       if (!bar) return null;
       const b = bar.getBoundingClientRect();
       const tabs = {};
       for (const id of ${JSON.stringify(ids)}) {
         const el = document.querySelector('[data-testid="tab-label-' + id + '"]');
         if (!el) continue;
         const r = el.getBoundingClientRect();
         if (r.width === 0 || r.height === 0) continue;
         tabs[id] = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
       }
       return { barBottom: b.bottom, barTop: b.top, tabs };
     })()`,
  );
}

async function measureScale(page, serverUrl, scale, { keepShots }) {
  await page.setViewport({ width: 900, height: 400, deviceScaleFactor: scale });
  await page.navigate(`${serverUrl}/scripts/visual/tab-seam-harness.html?w=${HARNESS_WIDTH}`);
  try {
    await page.waitForFunction("window.__tabHarnessReady === true", { timeout: 30000 });
  } catch (e) {
    // A readiness timeout almost always means the harness THREW while mounting, and the bare
    // "waitForFunction timed out" reads like a slow machine instead. Name the real cause.
    const errs = page.consoleErrors.length
      ? `\npage errors:\n  ${page.consoleErrors.join("\n  ")}`
      : "\n(no page errors were reported — check the dev server compiled the harness)";
    throw new Error(`${e.message}${errs}`);
  }
  await unhover(page);
  await sleep(400);

  const active = await page.evaluate("window.__selected");
  const ids = ["p1", "p2", "p3", "p4", "p5", "p6"];
  const geo = await geometry(page, ids);
  if (!geo) throw new Error("the tab bar did not render — no .concierge-tabbar in the harness");
  const inactive = ids.find((id) => id !== active && geo.tabs[id]);
  if (!inactive) throw new Error("the harness rendered no inactive tab to compare against");

  // ── THE PIXELS. Photograph with the pointer parked away, so no hover expansion is in the shot.
  const png = await page.screenshot();
  const img = decodePng(png);
  const toPx = (cssY) => Math.round(cssY * scale);
  const yFrom = toPx(geo.barBottom - SCAN_INSET_CSS);
  const yTo = Math.min(img.height - 1, toPx(geo.barBottom + SCAN_OUTSET_CSS));
  const ruleMaxPx = Math.max(1, Math.round(RULE_MAX_CSS * scale));
  const columnFor = (id) => scanColumn(img, Math.round(geo.tabs[id].x * scale), yFrom, yTo);
  const activeRuns = columnFor(active);
  const inactiveRuns = columnFor(inactive);

  const failures = [...gradeSeam({ scale, activeRuns, inactiveRuns, ruleMaxPx })];

  // ── CLICK 1: THE SETTLED CLICK. Park on a tab that is not active, let the strip settle, press.
  // Aimed at the LABEL centre — the tab's own midpoint is where the × sits, and that button has a
  // different job, so a probe aiming there would report a dropped click forever.
  const target = inactive;
  await movePointer(page, geo.tabs[target].x, geo.tabs[target].y);
  await sleep(250);
  await clickAt(page, geo.tabs[target].x, geo.tabs[target].y);
  await sleep(400);
  const settledSelected = await page.evaluate("window.__selected");
  failures.push(...gradeClick({ scale, gesture: "settled", clicked: target, selected: settledSelected }));

  // ── CLICK 2: THE CLICK ACROSS AN EXPANSION — the gesture a hand actually makes.
  //
  // You do not approach a tab from nowhere: the pointer is already somewhere in the strip, and by
  // the time it gets to the tab you want, the tab it RESTED on has expanded. That expansion is out
  // of flow and grows INWARD over its neighbour, so the neighbour you are aiming at can be under it
  // when you press — and the strip takes another `TAB_EXPAND_DELAY_MS` to notice the pointer moved.
  // Clicking inside that window is not an edge case, it is the normal speed of a hand.
  // RE-MEASURE FIRST. `geo` was read before the settled click, and that click CHANGED the strip: a
  // different tab is active, so the min-width floor moves (the active tab is floored higher), the
  // chrome re-measures, and the newly-selected tab is scrolled into view. Aiming this second
  // gesture with the old coordinates would press wherever those tabs USED to be — which is a
  // dropped click reported as a landed one, or a landed one reported for the wrong tab
  // (roborev 63275).
  const geo2 = await geometry(page, ids);
  if (!geo2) throw new Error("the tab bar vanished after the first click");
  const order = ids.filter((id) => geo2.tabs[id]);
  const restIdx = Math.max(1, order.indexOf(target));
  const rest = order[restIdx];
  // The neighbour the expansion grows OVER. `settleNow` anchors a tab in the strip's right half to
  // its right edge (so it grows leftward) and one in the left half to its left edge — so the
  // covered neighbour is on the opposite side of the midpoint from `rest`.
  const covered = await page.evaluate(
    `(() => {
       const bar = document.querySelector('.concierge-tabbar').getBoundingClientRect();
       const el = document.querySelector('[data-testid="tab-${rest}"]').getBoundingClientRect();
       const growsLeft = el.left + el.width / 2 > bar.left + bar.width / 2;
       const ids = ${JSON.stringify(order)};
       const i = ids.indexOf("${rest}");
       return growsLeft ? (ids[i - 1] ?? null) : (ids[i + 1] ?? null);
     })()`,
  );
  let fastTarget = null;
  let fastSelected = null;
  if (covered && covered !== settledSelected) {
    await unhover(page);
    await sleep(300);
    // Rest on `rest` long enough that it expands…
    await movePointer(page, geo2.tabs[rest].x, geo2.tabs[rest].y);
    await sleep(300);
    // …then move to the neighbour and press straight away, well inside the settle delay.
    fastTarget = covered;
    await movePointer(page, geo2.tabs[fastTarget].x, geo2.tabs[fastTarget].y);
    await sleep(30);
    await clickAt(page, geo2.tabs[fastTarget].x, geo2.tabs[fastTarget].y);
    await sleep(400);
    fastSelected = await page.evaluate("window.__selected");
    failures.push(
      ...gradeClick({ scale, gesture: "across-an-expansion", clicked: fastTarget, selected: fastSelected }),
    );
  }

  let shot = null;
  if (failures.length || keepShots) {
    shot = path.join(os.tmpdir(), `tab-seam-${String(scale).replace(".", "_")}.png`);
    fs.writeFileSync(shot, png);
  }

  return {
    scale,
    ok: failures.length === 0,
    failures,
    active,
    inactive,
    settledClick: { clicked: target, selected: settledSelected },
    fastClick: fastTarget ? { clicked: fastTarget, selected: fastSelected } : null,
    activeRuns: activeRuns.map((r) => ({ from: r.from, to: r.to, width: r.width, hex: r.hex })),
    inactiveRuns: inactiveRuns.map((r) => ({ from: r.from, to: r.to, width: r.width, hex: r.hex })),
    shot,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const scales = parseScales(args.scales);
  if (scales === null) {
    console.error(`--scales must be a comma-separated list of numbers in (0, 4] (got: ${String(args.scales)})`);
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
    browser = await launch({ width: 900, height: 400 });
  } catch (e) {
    server.stop();
    console.error(`could not launch Chrome: ${e.message}`);
    process.exit(2);
  }

  const results = [];
  try {
    for (const scale of scales) {
      // A FRESH PAGE PER SCALE. The viewport override and the harness's own state both persist on a
      // reused page, and a scale measured against the previous scale's layout is the kind of
      // order-dependent number this whole harness exists not to produce.
      const page = await browser.newPage();
      try {
        results.push(await measureScale(page, server.url, scale, { keepShots: !!args.keep }));
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
      const fast = r.fastClick ? `  fast=${r.fastClick.clicked}→${r.fastClick.selected}` : "  fast=(skipped)";
      const head =
        `scale=${r.scale}  active=${r.active}` +
        `  settled=${r.settledClick.clicked}→${r.settledClick.selected}${fast}`;
      console.log(`${head}  ${r.ok ? "OK" : "FAIL"}`);
      for (const f of r.failures) console.log(`   ✗ ${f}`);
      if (r.shot) console.log(`   shot: ${r.shot}`);
    }
  }
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}

// Only when run directly, so the pure exports above can be imported by the harness tests.
// `fileURLToPath`, never `new URL(...).pathname`: this repo lives under a path containing a space,
// which percent-encodes there and would make the comparison silently false — so the probe would
// import cleanly and then do nothing at all when run.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
