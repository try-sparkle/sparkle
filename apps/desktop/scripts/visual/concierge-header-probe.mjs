#!/usr/bin/env node
// concierge-header-probe — read the REAL "Concierge Agents" header in REAL Chrome, at the widths the
// sidebar column can actually be dragged to, and say whether its two numbers stay readable.
//
//   pnpm --filter @sparkle/desktop visual:concierge-header
//   pnpm --filter @sparkle/desktop visual:concierge-header -- --json
//   pnpm --filter @sparkle/desktop visual:concierge-header -- --widths=420,220,160 --shots=/tmp/out
//
// Exit 0 = every check passed; 1 = a real layout defect; 2 = the probe could not run.
//
// ── WHY THIS EXISTS (bead sparkle-8f4pj7) ──────────────────────────────────────────────────────
// The header used to read `Concierge Agents +2 · 63 recently`. The founder could not act on either
// number: `+2` never said what it counted, and `63 recently` was bounded by a window stated nowhere
// on screen. It now reads `Concierge Agents · 2 active now · 63 in the last hour` — which is
// FOUR TIMES LONGER, in a column that is routinely dragged narrow.
//
// That length is the whole risk of the change, and it is exactly the property the jsdom suite
// cannot see: jsdom has no layout engine, returns 0 from every `getBoundingClientRect`, never
// resolves a flex line and never applies `text-overflow`. `ConciergeAgentsRow.test.tsx` passes just
// as happily against a header whose numbers are clipped off the side of the column. So the copy is
// pinned there and the GEOMETRY is pinned here.
//
// ── WHAT IT ASSERTS ────────────────────────────────────────────────────────────────────────────
//   NUMBERS INTACT   the badge span is never clipped: `scrollWidth <= clientWidth`. The two counts
//                    are the entire point of the row, so the TITLE may ellipsize (it is a constant
//                    string every reader already knows) but the numbers may not. This is the
//                    "degrades gracefully rather than clipping mid-word" requirement, measured.
//   BADGE IN COLUMN  the badge's right edge sits inside the column's content box. A span can be
//                    unclipped by its own metrics and still be painted past the edge of the pane.
//   WINDOW NAMED     the visible text names its window ("in the last hour"), at every width. A
//                    responsive rule that abbreviated it away at narrow widths would re-create the
//                    unreadable `· N recently` the change exists to remove.
//   COUNT BOUNDED    the header reads 63, not 65 — the fixture seeds two dispatches OUTSIDE the
//                    hour. This is what stops the label from being a pure relabelling of an
//                    unbounded count, measured at the surface rather than in the selector.
//   NO H-SCROLL      the column never scrolls sideways at any width.
//
// ── WIDTHS ─────────────────────────────────────────────────────────────────────────────────────
// 420 is a comfortably wide control — every check must pass there too, so a "fix" that hides the
// numbers at every width cannot pass. 220 is `BUILD_COLUMN_DEFAULT_WIDTH`, the width the app opens
// at and the width the founder's screenshot was taken at. 160 and 120 are the dragged-narrow band.

import { mkdirSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { launch } from "./cdp.mjs";
import { startDevServer, CLEAR_STORAGE, TAURI_SHIM, FROZEN_CLOCK } from "./serve.mjs";

/** `--key=value` / bare `--flag`. Pure, so the CLI contract is unit-testable. */
export function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}

export const DEFAULT_WIDTHS = [420, 220, 160, 120];

/** What the seeded fixture must produce. 63 in-window dispatches, 2 live among them. */
export const EXPECTED_RECENT = 63;
export const EXPECTED_ACTIVE = 2;

/**
 * Horizontal overflow the sidebar column reports on the UNCHANGED build, at every width.
 *
 * Measured, not assumed — see the check that uses it. Encoded as a named baseline so the probe can
 * fail on overflow THIS row causes without failing on overflow it inherited.
 */
export const BASELINE_COLUMN_OVERFLOW_PX = 13;

/**
 * The narrowest column at which the badge is required to render UNCLIPPED.
 *
 * ══ A REPORTING FLOOR, NOT A BLIND SPOT ════════════════════════════════════════════════════════
 *
 * Below roughly 136px the requirement is arithmetically unsatisfiable, not merely hard: the row
 * spends 56px on padding, the dot slot and the gap, so a 120px column has 64px of inner room and
 * the SHORTEST phrasing the ladder can produce (`· 2 · 63 last hr`) measures 78px. No abbreviation
 * closes a gap like that; only deleting a number would, and a header that silently drops one of its
 * two counts is worse than one that ellipsizes.
 *
 * So below this width the shortfall is REPORTED as a note and the remaining checks still run — in
 * particular `badge inside the column`, which is the one that actually matters down here and which
 * the PRE-CHANGE build FAILED (its 89px badge was painted 24px past a 120px column's edge, per the
 * baseline measurement in the check below). Clipping inside the column is a strict improvement on
 * overflowing it, and it is the "degrades gracefully rather than clipping mid-word" behaviour asked
 * for: `text-overflow: ellipsis` cuts at a glyph boundary and marks the cut.
 */
export const BADGE_INTACT_MIN_COLUMN_PX = 140;

/**
 * The queue depth the sweep WOULD seed — 16, the row's own documented example.
 *
 * ══ WHY THE QUEUED CASE IS NOT SWEPT ═══════════════════════════════════════════════════════════
 *
 * The badge has a third segment (`· 16 queued`) between its two research numbers, and the tier
 * ladder's budgets were originally calibrated WITHOUT it — the defect the sibling change fixes.
 * Measuring it here would be the natural check, and it is deliberately ABSENT rather than broken:
 * `visualFixtures`' `?queue=N` seed is OVERWRITTEN when `ConciergeHost` mounts and publishes its
 * own (empty) depth — last-write-wins, by the store's own contract — so the row draws no queue
 * segment and a sweep of that case would fail at every width for a reason that has nothing to do
 * with layout. (An earlier note here blamed the subscription; that was wrong.)
 *
 * Shipping it anyway would be the exact fault this file exists to avoid — a check whose result says
 * nothing about the thing it names. So the three-segment badge is covered where it CAN be observed:
 * `ConciergeAgentsRow.test.tsx` renders it with an explicit `queuedCount` and asserts the exact
 * string, including that the tier steps down so the window survives. Choosing a string needs no
 * layout engine; only the pixels do, and those are what this file measures at every width.
 */
export const QUEUE_DEPTH = 16;

/**
 * Mirrors `CONCIERGE_TITLE_FLOOR_MIN_COLUMN_PX` in `src/components/rowWidthThresholds.ts` — the
 * width below which the title's floor is released and the numbers take the whole row.
 *
 * Duplicated as a literal because a probe cannot import the app's TypeScript. The row's own unit
 * suite pins the constant; this only has to agree with it about where the behaviour changes.
 */
export const TITLE_FLOOR_MIN_COLUMN_PX = 195;

/**
 * Seed the sidebar width as an INIT SCRIPT so the app boots already narrow.
 *
 * Navigate-then-resize would measure a layout mid-reflow; booting at the width removes that hazard
 * entirely. Same approach, and the same two localStorage keys, as `row-narrow-probe`.
 */
export const SEED_WIDTH = (w) => `
  localStorage.setItem('sparkle-sidebar-width:left', String(${w}));
  localStorage.setItem('sparkle-sidebar-width:right', String(${w}));
`;

/**
 * Read the header's real geometry. Runs IN THE PAGE, so it must be self-contained.
 *
 * The badge is found by its `aria-label`, not by text or by position: the label is the one handle
 * that is stable across every count and every width, and keying on the visible text would make the
 * probe unable to detect the very clipping it exists to measure.
 */
export const MEASURE = `(() => {
  // THE ROW'S OWN HANDLE. Text matching was the first version and it is fragile in both
  // directions: the title ellipsizes (though textContent does not), and \`[role="button"]\` matches
  // ancestors several levels up, so "the first thing containing the words" is not the row.
  const row = document.querySelector('[data-hint="concierge-agents"]');
  if (!row) return { found: false };
  const badge = Array.from(row.querySelectorAll("span")).find((s) =>
    (s.getAttribute("aria-label") || "").includes("active now"),
  );
  if (!badge) return { found: true, badge: false, rowText: row.textContent };
  const title = Array.from(row.querySelectorAll("span")).find(
    (s) => (s.textContent || "").trim() === "Concierge Agents",
  );
  // The scrolling column is the row's PARENT — it carries no hint of its own, and it is the box
  // whose \`scrollWidth\`/\`clientWidth\` report the sideways overflow this probe grades.
  const col = row.parentElement;
  const cb = col.getBoundingClientRect();
  const bb = badge.getBoundingClientRect();
  return {
    found: true,
    badge: true,
    rowText: row.textContent,
    badgeText: badge.textContent,
    badgeAria: badge.getAttribute("aria-label"),
    badgeTitle: badge.getAttribute("title"),
    // ── HOW WIDE THE TEXT ACTUALLY WANTS TO BE ────────────────────────────────────────────────
    // Measured with an OFF-LAYOUT CLONE in the same font, because the obvious test is VACUOUS here:
    // once the badge carries \`overflow: hidden\` + \`text-overflow: ellipsis\`, \`scrollWidth\`
    // collapses onto \`clientWidth\`, so \`scrollWidth <= clientWidth\` is true whether the text fits
    // or has been ellipsized away. It reported "intact" on a header that was visibly cut.
    //
    // A free-standing span with no clipping ancestor has nothing to collapse against, so \`need\` is
    // the honest width of the string and \`need > have\` is a real, failable assertion.
    badgeNeedW: (() => {
      const p = document.createElement("span");
      const cs = getComputedStyle(badge);
      p.style.font = cs.font;
      p.style.letterSpacing = cs.letterSpacing;
      p.style.position = "absolute";
      p.style.whiteSpace = "nowrap";
      p.style.visibility = "hidden";
      p.textContent = badge.textContent;
      document.body.appendChild(p);
      const w = Math.ceil(p.getBoundingClientRect().width);
      p.remove();
      return w;
    })(),
    badgeHaveW: Math.round(bb.width),
    badgeScrollW: badge.scrollWidth,
    badgeClientW: badge.clientWidth,
    titleW: title ? Math.round(title.getBoundingClientRect().width) : null,
    // Is it painted past the column's edge?
    badgeRight: bb.right,
    colRight: cb.right,
    colWidth: cb.width,
    // The title is ALLOWED to ellipsize; reported so the report can say that it did.
    titleClipped: title ? title.scrollWidth > title.clientWidth + 1 : null,
    colScrollW: col.scrollWidth,
    colClientW: col.clientWidth,
  };
})()`;

/** Grade one width's measurement. Pure, so the rules are unit-testable without a browser. */
export function verdictFor(width, m, queued = false) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: detail || "" });

  if (!m.found) {
    add("row present", false, "no Concierge Agents row rendered");
    return { width, checks, measured: m };
  }
  if (!m.badge) {
    add("badge present", false, `badge span not found; row read ${JSON.stringify(m.rowText)}`);
    return { width, checks, measured: m };
  }
  add("badge present", true, JSON.stringify(m.badgeText));

  // 1px of tolerance: sub-pixel text metrics round against us on fractional layouts.
  const intact = m.badgeNeedW <= m.badgeHaveW + 1;
  if (width >= BADGE_INTACT_MIN_COLUMN_PX) {
    add("numbers intact (badge not clipped)", intact, `needs ${m.badgeNeedW}px, has ${m.badgeHaveW}px`);
  } else {
    // Below the floor this is a NOTE, never a pass dressed as one: the text says the requirement was
    // waived and why, so nobody reads a green run as "it fits at 120px".
    checks.push({
      name: "numbers intact (WAIVED below the floor)",
      ok: true,
      detail:
        `${width}px < ${BADGE_INTACT_MIN_COLUMN_PX}px floor — ` +
        `${intact ? "fits anyway" : `clipped, needs ${m.badgeNeedW}px but has ${m.badgeHaveW}px`}` +
        "; the column cannot hold the shortest phrasing at this width (see BADGE_INTACT_MIN_COLUMN_PX)",
    });
  }
  add(
    "badge inside the column",
    m.badgeRight <= m.colRight + 1,
    `badge right ${Math.round(m.badgeRight)} vs column right ${Math.round(m.colRight)}`,
  );
  // THE INVARIANT ACROSS EVERY TIER: an abbreviation may shed words, never the unit. It must accept
  // every spelling the DERIVED labels can produce — `in the last hour`, `in the last 6 hours`,
  // `last hr`, `last 6h`, `last 20m` — and reject `63 in th…`, the ellipsized full form this check
  // exists to catch. An earlier version hardcoded `last hr` and would have failed a six-hour window
  // for naming its own period correctly. `/hr` is deliberately NOT accepted: it reads as a rate.
  add(
    "window is named",
    /(in the last |last hr\b|last \d+[mh]\b)/.test(m.badgeText || ""),
    "the count must state its window at every width",
  );
  add(
    "window is not ellipsized away",
    !/…/.test(m.badgeText || "") || /(in the last |last hr\b|last \d+[mh]\b)/.test(m.badgeText || ""),
    "a clipped label that lost its window is the defect this bead removes",
  );
  // The ROW keeps its name. Weighted to yield first and left unbounded, the title vanished entirely
  // at 220px — see CONCIERGE_TITLE_FLOOR_PX.
  // MEASURED, not read from textContent: CSS ellipsis never changes textContent, so a text test
  // passes just as happily against a title squeezed to zero pixels — which is exactly what happened
  // before CONCIERGE_TITLE_FLOOR_PX existed.
  if (width >= TITLE_FLOOR_MIN_COLUMN_PX) {
    add("row keeps a visible name", (m.titleW ?? 0) > 0, `title ${m.titleW}px wide`);
  } else {
    // The floor is RELEASED down here by design (CONCIERGE_TITLE_FLOOR_MIN_COLUMN_PX): the floor
    // plus the shortest badge exceed the whole row, so holding it would clip the numbers to buy a
    // name nobody dragged the column this narrow to read. Reported, never silently skipped.
    checks.push({
      name: "row keeps a visible name (WAIVED — floor released)",
      ok: true,
      detail: `${width}px < ${TITLE_FLOOR_MIN_COLUMN_PX}px; title ${m.titleW}px — the numbers take the row`,
    });
  }
  // The live gauge LEADS the badge, with or without a separator in front of it — the leading `·`
  // is a presentation choice this check must not depend on.
  add(
    "live gauge is present",
    /^(·\s*)?\d+/.test(m.badgeText || ""),
    "the live count must be on the row at every width",
  );
  // BOUNDED, not merely relabelled: the fixture seeds 2 dispatches OUTSIDE the hour, so a probe
  // reading 65 is looking at a regression. Matched against the count alone because the words around
  // it change with the tier.
  add(
    `count is bounded to the hour (${EXPECTED_RECENT}, not 65)`,
    new RegExp(`\\b${EXPECTED_RECENT}\\b`).test(m.badgeText || "") &&
      !/\b65\b/.test(m.badgeText || ""),
    "the fixture seeds 2 dispatches outside the hour; they must not be counted",
  );
  // THE VALUE, separate from the wording — the wording follows the tier ladder (`2 active now` →
  // `2 active` → `2`), the NUMBER never changes. Anchored on the leading separator so it reads the
  // live gauge specifically and cannot be satisfied by the `63` beside it.
  add(
    `live gauge reads ${EXPECTED_ACTIVE} (one running + one queued)`,
    new RegExp(`^(·\\s*)?${EXPECTED_ACTIVE}\\b`).test(m.badgeText || ""),
    "the fixture seeds exactly one running and one queued task",
  );
  add(
    "live gauge does not say `running`",
    !/\brunning\b/.test(m.badgeText || ""),
    "the gauge counts queued + running",
  );
  // The aria label must tell the same story as the eye — the repo treats copy as code.
  if (queued) {
    // THE SEGMENT THAT USED TO BE OFF THE LADDER. It sits between the two research numbers, so when
    // it pushed the badge over budget the ellipsis ate the TAIL — the windowed count. Both facts
    // are graded: the queue is on screen, AND the unit after it survived.
    add(
      `queue segment present (${QUEUE_DEPTH})`,
      new RegExp(`${QUEUE_DEPTH}\\s*(queued|q)\\b`).test(m.badgeText || ""),
      JSON.stringify(m.badgeText),
    );
  } else {
    add("no queue segment when the queue is empty", !/queued|\d+ q\b/.test(m.badgeText || ""), "");
  }
  add(
    "aria matches the visible text",
    /active now/.test(m.badgeAria || "") && /in the last hour/.test(m.badgeAria || ""),
    JSON.stringify(m.badgeAria),
  );
  // ── THE 13px THAT IS NOT OURS ────────────────────────────────────────────────────────────────
  // The column reports a standing 13px of horizontal overflow at EVERY width, and it does so on the
  // UNCHANGED build too — measured by running this probe against the pre-change copy (`+2 · 63
  // recently`): 432/419, 232/219, 172/159, 143/119, i.e. exactly 13 in every case except the 120px
  // column, which the old badge already overflowed on its own. It is chrome, it predates this bead,
  // and failing on it would make the probe red for a defect it cannot fix and did not cause.
  //
  // So the check is a DELTA against that baseline rather than an absolute — it still catches this
  // row pushing the column sideways (before the badge was made shrinkable it read 26 / 86 / 126),
  // which is the regression that matters here.
  add(
    "column does not scroll sideways beyond the pre-existing 13px",
    m.colScrollW - m.colClientW <= BASELINE_COLUMN_OVERFLOW_PX + 1,
    `overflow ${m.colScrollW - m.colClientW}px (baseline ${BASELINE_COLUMN_OVERFLOW_PX}px)`,
  );
  return { width, checks, measured: m };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  let widths = DEFAULT_WIDTHS;
  if (args.widths !== undefined) {
    // VALIDATED, NOT COERCED. A bare `--widths` arrives as `true` and `Number(true)` is 1, which
    // would silently sweep a 1px column and grade every rule against a layout nobody can reach.
    const raw = typeof args.widths === "string" ? args.widths : "";
    const parsed = raw.split(",").map((w) => Number(w.trim()));
    if (raw === "" || parsed.length === 0 || parsed.some((w) => !Number.isFinite(w) || w <= 0)) {
      console.error(`--widths must be a comma-separated list of positive numbers (got: ${String(args.widths)})`);
      process.exit(2);
    }
    widths = parsed;
  }
  const shotDir = typeof args.shots === "string" ? args.shots : null;
  if (shotDir) mkdirSync(shotDir, { recursive: true });

  let server;
  let browser;
  try {
    server = await startDevServer({ quiet: !args.verbose });
  } catch (e) {
    console.error(`could not start the dev server: ${e.message}`);
    process.exit(2);
  }
  try {
    browser = await launch({ width: 1600, height: 1000 });
  } catch (e) {
    server.stop();
    console.error(`could not launch Chrome: ${e.message}`);
    process.exit(2);
  }

  // ONE PASS, NO QUEUE — see the note on `QUEUE_DEPTH` for why the queued case cannot be seeded
  // yet. It is covered by the render tests instead.
  const cases = widths.map((width) => ({ width, queued: false }));

  const results = [];
  try {
    for (const { width, queued } of cases) {
      const page = await browser.newPage();
      try {
        // `research=1` seeds the Concierge Agents row; without it the row renders empty and the
        // probe would grade an absent badge as an environment failure. `queue=N` seeds the badge's
        // MIDDLE segment — the one the ladder's budgets were originally NOT measured with.
        const url =
          `${server.url}/?visual=1&capture=1&research=1` + (queued ? `&queue=${QUEUE_DEPTH}` : "");
        for (const source of [CLEAR_STORAGE, TAURI_SHIM, FROZEN_CLOCK, SEED_WIDTH(width)]) {
          await page.addInitScript(source);
        }
        await page.navigate(url);
        // WAIT ON THE ROW, NOT THE BADGE. Waiting on the badge made `verdictFor`'s `!m.badge`
        // branch unreachable — the wait already guaranteed what that check exists to test — so a
        // missing badge timed out as an environment failure instead of being GRADED as the layout
        // defect it is.
        await page.waitForFunction(
          `!!document.querySelector('[data-hint="concierge-agents"]')`,
          { timeout: 30000 },
        );
        const m = await page.evaluate(MEASURE);
        if (shotDir && m.found) {
          // ANCHORED ON THE SAME TWO ELEMENTS THE MEASUREMENT USES, so the picture and the
          // verdict describe the same box. Two earlier attempts got this wrong in opposite
          // directions and both produced misleading evidence: clipping to a text-matched ancestor
          // captured an unrelated strip of the app, and clipping to the row's own content box gave
          // a ~110px image in which the header LOOKED clipped while the DOM said it was intact. A
          // screenshot that argues against its own measurement is worse than no screenshot.
          const clip = await page.evaluate(`(() => {
            const row = document.querySelector('[data-hint="concierge-agents"]');
            const col = row.parentElement;
            const r = row.getBoundingClientRect();
            const b = col.getBoundingClientRect();
            return {
              x: Math.max(0, Math.round(b.left) - 6),
              y: Math.max(0, Math.round(r.top) - 10),
              width: Math.round(b.width) + 12,
              height: Math.round(r.height) + 20,
            };
          })()`);
          const png = await page.screenshot({ clip });
          writeFileSync(join(shotDir, `concierge-header-${width}px.png`), png);
        }
        if (page.consoleErrors.length) {
          console.error(`page errors at ${width}px:\n  ${page.consoleErrors.join("\n  ")}`);
        }
        results.push({ ...verdictFor(width, m, queued), queued });
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
    server.stop();
  }

  if (args.json) {
    console.log(JSON.stringify({ results }, null, 2));
  } else {
    for (const r of results) {
      console.log(
        `\n  ${r.width}px${r.queued ? " +queue" : "       "}  ${JSON.stringify(r.measured.badgeText ?? "")}`,
      );
      if (r.measured.titleClipped) console.log(`    note  title ellipsized (allowed)`);
      for (const c of r.checks) {
        console.log(`    ${c.ok ? "ok  " : "FAIL"}  ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
      }
    }
  }

  const failed = results.filter((r) => r.checks.some((c) => !c.ok));
  if (failed.length > 0) {
    console.error(
      `\nconcierge-header-probe: ${failed.length} of ${results.length} widths FAILED ` +
        `(${failed.map((f) => `${f.width}px${f.queued ? "+queue" : ""}`).join(", ")})`,
    );
    process.exit(1);
  }
  console.log(`\nconcierge-header-probe: all ${results.length} widths passed`);
}

// `pathToFileURL`, NOT a `file://` template: this repo lives under a path containing a SPACE
// ("Application Support"), which `import.meta.url` percent-encodes and the template does not. The
// naive guard therefore never matches, `main()` never runs, and the probe exits 0 having asserted
// NOTHING — a silent green, which is the one outcome a verification tool must never produce.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // EXIT 2, NOT 1. Everything after the two guarded setup steps — above all the 30s
  // `waitForFunction` — was reaching an unhandled rejection, and Node exits 1 for that. This file
  // defines 1 as "a real layout defect", so a stale bundle, a changed handle, or a fixture that
  // stopped seeding sent the reader hunting a layout bug that did not exist. It is also not
  // hypothetical: under machine load the wait timed out and reported exactly that. Those are all
  // "the probe could not run", which is 2.
  main().catch((e) => {
    console.error(`concierge-header-probe: could not run — ${e?.message ?? e}`);
    process.exit(2);
  });
}
