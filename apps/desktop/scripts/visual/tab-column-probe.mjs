#!/usr/bin/env node
// tab-column-probe — is the ACTIVE project tab painted in the plane of the column BENEATH it?
//
//   pnpm --filter @sparkle/desktop visual:tab-column
//   pnpm --filter @sparkle/desktop visual:tab-column -- --json
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────────
//
// The founder, with a light-mode and a dark-mode screenshot of the same defect:
//
//   *"So you need to be aware of where the tab sits and shade it the correct color based on where
//   it sits."*
//
// The active tab's face was `C.forest` — the TERMINAL plane — no matter which column it sat above,
// so it was correct over the terminal by luck and a visible seam over the build column in BOTH
// themes. `ProjectTabs` now reads the background off the column element it measures itself to be
// above (engine/pairColumns).
//
// `ProjectTabs.columnFill.test.tsx` pins that rule in jsdom and this does NOT replace it. There is
// one link in the chain a unit test cannot check, and it is the one the whole fix hangs from: the
// component reads `getComputedStyle(column).backgroundColor`, and both real columns declare their
// background as a CSS CUSTOM PROPERTY. jsdom does not resolve custom properties, so the unit test
// has to feed its fixture columns concrete hex. If a real engine answered `""` there, the component
// would read no colour, fall back to `C.forest`, and the bug would be back with every unit test
// still green. Here the harness columns carry the shipped `var(--c-deep-forest)` / `var(--c-forest)`,
// so a pass proves the resolution actually happens.
//
// ── WHAT IS ASSERTED, AND WHY IT NAMES NO COLOUR ───────────────────────────────────────────────
//
// For each theme, and for one tab over EACH column: the tab's computed background equals the
// computed background of the column its own midpoint is over — both read from the live elements,
// neither compared to a literal. A probe pinned to `rgb(9, 20, 38)` would keep passing while the
// columns were restyled underneath it, which is the class of bug that let this ship.
//
// It also asserts the two columns are DISTINCT in that theme. Without it the equality is trivially
// satisfiable — if both planes were the same colour, a tab that ignored position entirely would
// pass every case here.
//
// WHICH TAB SITS OVER WHICH COLUMN IS DISCOVERED, not hardcoded: the probe surveys the real rects
// first and then picks one tab per column. So the widths in the harness can change without silently
// turning this into two copies of the same case.
//
// Exit 0 = measured and correct, 1 = a real regression, 2 = the probe could not run (no Chrome, no
// dev server, a harness that would not mount, or a layout with no tab over one of the columns).

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
 * Read the strip and the columns straight out of the page.
 *
 * The `under` field re-derives the founder's rule from real geometry — the column whose horizontal
 * extent contains the TAB'S MIDPOINT — independently of the component's own resolution. That is
 * deliberate: if the probe asked the component which column it thought it was over, a component
 * that resolved the wrong column would still agree with itself and pass.
 */
const READ = `(() => {
  const cols = [...document.querySelectorAll('[data-pair-column]')].map((el) => {
    const r = el.getBoundingClientRect();
    return {
      kind: el.getAttribute('data-pair-column'),
      left: r.left,
      right: r.right,
      bg: getComputedStyle(el).backgroundColor,
    };
  });
  const tabs = [...document.querySelectorAll('[role="tab"]')].map((tab) => {
    const id = (tab.getAttribute('data-testid') || '').replace(/^tab-/, '');
    const r = tab.getBoundingClientRect();
    const mid = (r.left + r.right) / 2;
    const under = cols.find((c) => mid >= c.left && mid < c.right) || null;
    const face = document.querySelector('[data-testid="tab-body-' + id + '"]');
    return {
      id,
      active: tab.getAttribute('aria-selected') === 'true',
      mid,
      under: under ? under.kind : null,
      wantBg: under ? under.bg : null,
      faceBg: face ? getComputedStyle(face).backgroundColor : null,
    };
  });
  return JSON.stringify({ cols, tabs });
})()`;

/** Mount the harness in one theme with one tab active, and read it. */
async function read(page, serverUrl, { theme, active }) {
  const q = new URLSearchParams({ theme, ...(active ? { active } : {}) });
  await page.navigate(`${serverUrl}/scripts/visual/tab-column-harness.html?${q}`);
  try {
    await page.waitForFunction("window.__tabColumnHarnessReady === true", { timeout: 30000 });
  } catch (e) {
    const errs = page.consoleErrors.length
      ? `\npage errors:\n  ${page.consoleErrors.join("\n  ")}`
      : "\n(no page errors were reported — check the dev server compiled the harness)";
    throw new Error(`${e.message}${errs}`);
  }
  return JSON.parse(await page.evaluate(READ));
}

/**
 * One theme × one active tab: does the active tab's face match the column it is over?
 *
 * `expectOver` is the column the SURVEY said this tab would sit over. It is re-checked here rather
 * than trusted, because the survey is taken once (in one theme) and reused for the other — so a
 * layout that differs between themes could quietly move the tab to the other column and leave the
 * run testing the same column twice while still reporting four green cases (roborev 63620). The
 * verdict below is always computed from THIS run's own geometry; this only refuses to call the pair
 * of cases "both columns" when it no longer is.
 */
export function judge({ theme, state, expectOver }) {
  const failures = [];
  const active = state.tabs.find((t) => t.active);
  if (!active) return { ok: false, failures: ["no tab reported itself active"] };
  if (expectOver && active.under !== expectOver) {
    failures.push(
      `coverage gap: ${active.id} was surveyed over the ${expectOver} column but sits over ` +
        `${active.under ?? "no column"} in ${theme} — this run no longer covers both columns`,
    );
  }

  const planes = new Set(state.cols.map((c) => c.bg));
  if (planes.size < state.cols.length) {
    // Not a tab bug, but it makes every equality below meaningless — say so rather than pass.
    failures.push(
      `the columns are not distinct in ${theme} (${state.cols.map((c) => `${c.kind}=${c.bg}`).join(", ")})`,
    );
  }
  if (!active.under) {
    failures.push(`the active tab (${active.id}) is over no column at all — mid=${active.mid}`);
  } else if (active.faceBg !== active.wantBg) {
    const other = state.cols.find((c) => c.kind !== active.under);
    const alias = other && active.faceBg === other.bg ? ` — it is the ${other.kind}'s plane` : "";
    failures.push(
      `${theme}: active tab ${active.id} sits over the ${active.under} column ` +
        `(${active.wantBg}) but paints ${active.faceBg}${alias}`,
    );
  }
  return { ok: failures.length === 0, failures };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  let server;
  let browser;
  try {
    server = await startDevServer({ quiet: !args.verbose });
  } catch (e) {
    console.error(`could not start the dev server: ${e.message}`);
    process.exit(2);
  }
  try {
    browser = await launch({ width: 1000, height: 400 });
  } catch (e) {
    server.stop();
    console.error(`could not launch Chrome: ${e.message}`);
    process.exit(2);
  }

  const results = [];
  try {
    // SURVEY FIRST. Which tab is over which column is a function of the rendered widths, so it is
    // discovered rather than assumed — see the header.
    const survey = await (async () => {
      const page = await browser.newPage();
      try {
        return await read(page, server.url, { theme: "dark" });
      } finally {
        await page.close();
      }
    })();
    const overBuild = survey.tabs.find((t) => t.under === "build");
    const overTerminal = survey.tabs.find((t) => t.under === "terminal");
    if (!overBuild || !overTerminal) {
      throw new Error(
        "the harness produced no tab over one of the columns — widen the strip or shorten the " +
          `names (got: ${survey.tabs.map((t) => `${t.id}@${t.under}`).join(", ")})`,
      );
    }

    for (const theme of ["light", "dark"]) {
      for (const t of [overBuild, overTerminal]) {
        // A FRESH PAGE PER CASE. The theme is applied at module scope from the query string and the
        // harness keeps its own selection state, so a reused page would measure the previous case's
        // theme or selection.
        const page = await browser.newPage();
        try {
          const state = await read(page, server.url, { theme, active: t.id });
          const verdict = judge({ theme, state, expectOver: t.under });
          results.push({ theme, active: t.id, over: t.under, ...verdict, state });
        } finally {
          await page.close();
        }
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
      const a = r.state.tabs.find((t) => t.active);
      console.log(
        `${r.theme.padEnd(5)} active=${r.active} over=${r.over}  ` +
          `tab=${a ? a.faceBg : "?"}  column=${a ? a.wantBg : "?"}  ${r.ok ? "OK" : "FAIL"}`,
      );
      for (const f of r.failures) console.log(`   ✗ ${f}`);
    }
  }
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}

// Only when run directly, so the pure exports above can be imported by a test.
if (process.argv[1] && process.argv[1].endsWith("tab-column-probe.mjs")) {
  main();
}
