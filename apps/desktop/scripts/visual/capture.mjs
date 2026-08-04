#!/usr/bin/env node
// Capture every named surface from the RUNNING APP, in both themes.
//
//   pnpm --filter @sparkle/desktop visual:capture
//   node scripts/visual/capture.mjs --out=/tmp/shots --surfaces=agent-sidebar --scale=2
//
// Writes `<surface>-<theme>.png` plus a `manifest.json` describing the run.

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "./cdp.mjs";
import { startDevServer, TAURI_SHIM, FROZEN_CLOCK } from "./serve.mjs";
import {
  DEFAULT_VIEWPORT,
  SURFACES,
  THEMES,
  artifactName,
  selectSurfaces,
  stepToExpression,
} from "./surfaces.mjs";

// Re-exported so every existing importer (and the `--width`/`--height` defaults below) is
// unchanged; it LIVES in the registry now — see the note there.
export { DEFAULT_VIEWPORT };

/** `--key=value` and bare `--flag` into an object. Pure, so the CLI contract is testable. */
export function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}

/**
 * The URL one surface is captured at.
 *
 * EXPORTED SO IT CAN BE TESTED, which is the whole reason it is a function rather than the inline
 * template it used to be. `capture=1` is what tells the fixture the harness is driving, and the
 * fixture's whole cross-surface reset hangs off it — but every fixture-side test hand-builds
 * "?visual=1&capture=1", so they prove the REACTION to the marker while nothing proved it was ever
 * SENT. Drop or misspell it in an inline template and the reset goes dead: captures still succeed,
 * still exit 0, and quietly go back to producing order-dependent PNGs with a fully green suite.
 * `harness.test.mjs` now runs every registry surface through this and asserts the app's own
 * `visualCaptureRun` accepts the result, so the two spellings are pinned across the boundary.
 *
 * Why the marker is separate from `visual=1`: "fixtures on" and "the harness is driving" are
 * different claims. Every surface gets a fresh PAGE but they share ONE BROWSER, and localStorage is
 * origin-scoped — so state a surface does not set is inherited from whichever ran before it. The
 * fixture resets the keys it owns when it sees `capture=1`. It must NOT do that for a developer who
 * merely opens their own dev server with `?visual=1`: those are real preferences on a real machine
 * and nothing else protects them. See `visualCaptureRun` in src/dev/visualFixtures.ts.
 */
export function surfaceUrl(baseUrl, surface) {
  const extra = surface.query ? `&${surface.query}` : "";
  return `${baseUrl}/?visual=1&capture=1${extra}`;
}

/**
 * Run one surface's steps against a page. Exported (and driven by the registry rather than
 * hardcoded) so compare.mjs replays the mock's steps through exactly the same interpreter.
 */
export async function runSteps(page, steps, { timeout = 30000 } = {}) {
  for (const step of steps) {
    const expr = stepToExpression(step);
    // Every verb is retried until it succeeds: a click on a not-yet-mounted node returns false
    // rather than throwing, so waiting and acting are the same loop.
    await page.waitForFunction(expr, { timeout });
  }
}

/**
 * Settle before the shutter. Two rAFs put us after React has committed AND the browser has painted
 * that commit; the fonts promise covers a late webfont swap, which would otherwise reflow text
 * between two otherwise-identical runs.
 */
export async function settle(page) {
  await page.evaluate(`(async () => {
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  })()`);
}

/**
 * Apply a theme, and PROVE it took.
 *
 * MUST BE CALLED AFTER THE APP HAS MOUNTED. `useApplyTheme` (src/theme/theme.ts) is the documented
 * single writer of `<html data-theme>` and runs in an effect after mount, so an attribute written
 * before that is simply overwritten moments later. The old check then read the value back
 * immediately and "passed" by observing its own write — so the real mechanism was the emulated
 * media feature alone, and a profile carrying an explicit light/dark preference would have produced
 * a light capture in a file named `-dark.png` with no error anywhere. (roborev 54744)
 *
 * The media emulation is the genuine lever (the app's theme preference defaults to "auto", and the
 * harness always launches with a fresh user-data-dir, so "auto" is what it reads). The attribute
 * write stays as belt-and-braces — but it is now verified for STABILITY, so if the app's effect
 * disagrees, the run fails loudly instead of mislabelling a screenshot.
 */
export async function applyTheme(page, theme) {
  await page.setColorScheme(theme);
  await page.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`);
  await page.waitForStableValue("document.documentElement.dataset.theme", theme);
}

/**
 * Reject a non-numeric CLI value instead of silently capturing at the wrong size.
 *
 * `Number(args.scale || 2)` turned a bare `--scale` into 1 (true → 1) and `--scale=x` into NaN,
 * both without complaint — the same silently-wrong-density class of bug as the clip-scale one.
 * `min` is 0 for tolerances (a threshold of 0 means "exact" and is the default) and left at its
 * default for dimensions, where zero is meaningless. (roborev 54744)
 */
export function numericArg(raw, fallback, name, min = Number.EPSILON) {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (typeof raw === "boolean" || raw === "" || !Number.isFinite(n) || n < min) {
    throw new Error(
      `--${name} must be a number >= ${min === Number.EPSILON ? "0 (exclusive)" : min} ` +
        `(got ${JSON.stringify(raw)})`,
    );
  }
  return n;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = resolve(args.out || join(process.cwd(), "visual-out", "app"));
  const scale = numericArg(args.scale, 2, "scale");
  const width = numericArg(args.width, DEFAULT_VIEWPORT.width, "width");
  const height = numericArg(args.height, DEFAULT_VIEWPORT.height, "height");
  const surfaces = selectSurfaces(args.surfaces);
  const themes = args.theme ? [args.theme] : THEMES;

  mkdirSync(outDir, { recursive: true });
  console.log(`[capture] ${surfaces.length} surface(s) × ${themes.length} theme(s) → ${outDir}`);

  const server = await startDevServer({ quiet: !args.verbose });
  console.log(`[capture] dev server (auth bypass on) at ${server.url}`);
  // `browser` is declared here but LAUNCHED INSIDE the try. Launching outside it meant that a
  // missing Chrome (CHROME_PATH defaults to a macOS path — any Linux/CI runner misses it) threw
  // after the 30s debugger timeout with `server.stop()` never reached. vite is spawned detached as
  // its own process-group leader, so it outlived the failed run and kept its port and CPU forever,
  // once per attempt, with nothing in the output to say so. (roborev 54744)
  let browser = null;
  const results = [];

  try {
    browser = await launch({ width, height });
    for (const theme of themes) {
      for (const surface of surfaces) {
        // A FRESH PAGE PER SURFACE, deliberately. Surfaces mutate app state — the settings surface
        // opens a modal, the wired ones set an attribute — and leaking that into the next capture
        // is exactly the kind of order-dependence that makes a baseline untrustworthy.
        const page = await browser.newPage();
        const record = { surface: surface.name, theme, file: artifactName(surface.name, theme) };
        try {
          await page.setViewport({ width, height, deviceScaleFactor: scale });
          await page.addInitScript(TAURI_SHIM);
          await page.addInitScript(FROZEN_CLOCK);
          // `?visual=1`, PLUS whatever extra state this surface needs the FIXTURE to seed. A
          // surface that needs two pairs (`workspace-wired-left`) cannot get them from a step —
          // steps run after mount, and the pair layout is decided by the seed — so it asks here.
          //
          // `capture=1` SAYS THE HARNESS IS DRIVING, which is a different claim from `visual=1` and
          // is why it is a separate parameter. Every surface gets a fresh PAGE but they all share
          // ONE BROWSER, and `localStorage` is origin-scoped — so state a surface does not set is
          // not "the app's default", it is whatever the previous surface left. The fixture resets
          // the non-zustand keys it owns (the concierge widths) when it sees this, which makes a
          // capture independent of the order the run took. It must NOT do that for a developer who
          // merely opens their own dev server with `?visual=1`: those are real preferences on a
          // real machine and nothing else protects them. See `visualCaptureRun` in
          // src/dev/visualFixtures.ts.
          await page.navigate(surfaceUrl(server.url, surface));
          // Media emulation FIRST (the app reads prefers-color-scheme as it mounts), then the
          // steps that wait for the shell, and only then applyTheme — which asserts the attribute
          // holds. See applyTheme's docblock for why the old order could not have worked.
          await page.setColorScheme(theme);
          await runSteps(page, surface.app.steps);
          await applyTheme(page, theme);
          await settle(page);

          let clip = null;
          if (surface.app.clip) {
            clip = await page.boundingBox(surface.app.clip);
            if (!clip) throw new Error(`clip selector matched nothing: ${surface.app.clip}`);
            if (clip.width < 1 || clip.height < 1) {
              throw new Error(`clip selector has zero area: ${surface.app.clip}`);
            }
          }
          const png = await page.screenshot({ clip });
          writeFileSync(join(outDir, record.file), png);
          record.ok = true;
          record.bytes = png.length;
          record.pixels = { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
          if (page.consoleErrors.length) record.consoleErrors = page.consoleErrors.slice(0, 5);
          console.log(
            `[capture] ✓ ${record.file} ${record.pixels.width}×${record.pixels.height}` +
              ` (${png.length} bytes)`,
          );
        } catch (e) {
          record.ok = false;
          record.error = e.message;
          record.consoleErrors = page.consoleErrors.slice(0, 5);
          console.log(`[capture] ✗ ${record.file} — ${e.message}`);
        } finally {
          // Tear the page down before the next surface mounts its own copy of the app.
          await page.close();
        }
        results.push(record);
      }
    }
  } finally {
    if (browser) await browser.close();
    server.stop();
  }

  const manifest = {
    // No timestamp on purpose: the manifest is an artifact of a byte-stable run, so stamping it
    // would make two identical runs produce different files.
    viewport: { width, height, deviceScaleFactor: scale },
    surfaces: SURFACES.map((s) => s.name),
    results,
  };
  writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  const failed = results.filter((r) => !r.ok);
  console.log(`\n[capture] ${results.length - failed.length}/${results.length} captured → ${outDir}`);
  if (failed.length) {
    console.error(`[capture] FAILED: ${failed.map((f) => f.file).join(", ")}`);
  }
  return failed.length ? 1 : 0;
}

/**
 * Exit explicitly. Chrome leaves helper processes and socket handles behind that can keep the event
 * loop alive well after the work is done — the run finished, printed 12/12, and then sat there. All
 * output is already flushed (the manifest via writeFileSync, the log lines before this point), so
 * exiting here costs nothing and makes the command terminate predictably in CI.
 */
async function cli() {
  process.exit(await main());
}

// Only run when invoked directly, so the exported helpers can be imported by tests.
// Compared as decoded PATHS, not as URL strings: this repo lives under "Application Support", and
// the space in that path is percent-encoded in import.meta.url but not in process.argv[1], so the
// naive `import.meta.url === "file://" + argv[1]` check silently never fires here.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await cli();
}
