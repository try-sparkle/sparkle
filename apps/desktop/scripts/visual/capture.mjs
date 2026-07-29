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
import { SURFACES, THEMES, artifactName, selectSurfaces, stepToExpression } from "./surfaces.mjs";

export const DEFAULT_VIEWPORT = { width: 1600, height: 1000 };

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

/** Apply a theme the way the app itself does — the media feature AND the explicit attribute. */
export async function applyTheme(page, theme) {
  await page.setColorScheme(theme);
  // MAPPING.md: `data-theme` on <html> is already how the app themes. Setting it explicitly stops
  // the capture depending on whether the user's persisted preference happened to be "auto".
  await page.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`);
  await page.waitForFunction(
    `document.documentElement.dataset.theme === ${JSON.stringify(theme)}`,
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = resolve(args.out || join(process.cwd(), "visual-out", "app"));
  const scale = Number(args.scale || 2);
  const width = Number(args.width || DEFAULT_VIEWPORT.width);
  const height = Number(args.height || DEFAULT_VIEWPORT.height);
  const surfaces = selectSurfaces(args.surfaces);
  const themes = args.theme ? [args.theme] : THEMES;

  mkdirSync(outDir, { recursive: true });
  console.log(`[capture] ${surfaces.length} surface(s) × ${themes.length} theme(s) → ${outDir}`);

  const server = await startDevServer({ quiet: !args.verbose });
  console.log(`[capture] dev server (auth bypass on) at ${server.url}`);
  const browser = await launch({ width, height });
  const results = [];

  try {
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
          await page.navigate(`${server.url}/?visual=1`);
          await applyTheme(page, theme);
          await runSteps(page, surface.app.steps);
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
        }
        results.push(record);
      }
    }
  } finally {
    await browser.close();
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
