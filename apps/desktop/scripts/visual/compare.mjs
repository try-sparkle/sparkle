#!/usr/bin/env node
// Render each named surface from the approved mock, then score the app's capture against it.
//
//   pnpm --filter @sparkle/desktop visual:compare
//   node scripts/visual/compare.mjs --app=/tmp/shots --out=/tmp/cmp --surfaces=agent-sidebar
//
// Emits, per surface and theme: `<name>-mock.png`, `<name>-side-by-side.png`, `<name>-diff.png`,
// plus a `report.json` and a printed table of percentage-of-differing-pixels.

import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "./cdp.mjs";
import { decodePng, encodePng } from "./png.mjs";
import { compareImages, diffImage, sideBySide } from "./diff.mjs";
import { MOCK_CHROME_SELECTORS, THEMES, artifactName, selectSurfaces } from "./surfaces.mjs";
import { applyTheme, numericArg, parseArgs, runSteps, settle } from "./capture.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
// apps/desktop/scripts/visual → apps/desktop/scripts → apps/desktop → apps → <repo root>
export const REPO_ROOT = resolve(HERE, "..", "..", "..", "..");
export const MOCK_REL = "PRD/sparkle/ui-directions/rev4-standalone.html";

/**
 * Where the approved mock lives.
 *
 * `rev4-standalone.html` HAS LANDED ON MAIN (it went in with the cockpit port), so step 2 is the
 * normal path and wins on every branch cut from main. Resolution order:
 *   1. --mock=<path>
 *   2. SPARKLE_VISUAL_MOCK_REF, if set — an explicitly named ref beats the tree
 *   3. the working tree
 *   4. `git show <ref>:<path>` over the remaining candidate refs (the branch that authored it,
 *      then main)
 *
 * SPARKLE_VISUAL_MOCK_REF OUTRANKS THE WORKING TREE, and that is a behaviour change (roborev
 * 55137). It used to sit in the candidate list at step 4, which was consulted only *after* the tree
 * lookup failed — so once the mock landed on main the variable became unreachable on any normal
 * checkout: setting it had no effect and produced no diagnostic, and the run silently scored
 * against the tree copy instead of the revision the operator named. An explicitly named ref is an
 * explicit instruction, so it now wins, and a named ref that does NOT carry the mock is a hard
 * error rather than a silent fall-through to the tree.
 *
 * Step 4 is a COMPATIBILITY path, not the load-bearing one: it covers a detached or sparse
 * checkout. `sparkle/blueprint-cockpit` stays in the candidate list only so an old worktree still
 * parked on it keeps resolving; nothing depends on that branch existing.
 *
 * To compare against a revision other than the tree's, either set SPARKLE_VISUAL_MOCK_REF=<ref> or
 * pass `--mock=<path>` — note `--mock` takes a PATH, not a ref, so the two are different inputs.
 */
export function resolveMock(
  explicitPath,
  { repoRoot = REPO_ROOT, refs, mockRef = process.env.SPARKLE_VISUAL_MOCK_REF } = {},
) {
  // `git show '<ref>:<path>'` as ONE argv element. Quoting-sensitive: the ref may carry `~`, `^` or
  // `@{…}`, which a shell would mangle — execFileSync passes it through literally.
  const fromRef = (ref) => {
    try {
      const html = execFileSync("git", ["show", `${ref}:${MOCK_REL}`], {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 32 * 1024 * 1024,
      });
      return html ? { html, source: `git:${ref}:${MOCK_REL}` } : null;
    } catch {
      return null; // ref missing, or the file is not in it
    }
  };

  if (explicitPath) {
    const p = resolve(explicitPath);
    if (!existsSync(p)) throw new Error(`--mock path does not exist: ${p}`);
    return { html: readFileSync(p, "utf8"), source: p };
  }

  // An explicitly named ref beats the working tree, and MISSES LOUDLY. Falling through to the tree
  // here would score the run against a revision the operator did not ask for and say nothing.
  if (mockRef) {
    const found = fromRef(mockRef);
    if (found) return found;
    throw new Error(
      `SPARKLE_VISUAL_MOCK_REF=${mockRef} does not carry ${MOCK_REL}.\n` +
        `Refusing to fall back to the working tree: that would silently compare against a different ` +
        `revision than the one you named. Fix the ref, or unset it to use the tree.`,
    );
  }

  const inTree = join(repoRoot, MOCK_REL);
  if (existsSync(inTree)) return { html: readFileSync(inTree, "utf8"), source: MOCK_REL };

  const candidates = refs ?? [
    "sparkle/blueprint-cockpit",
    "origin/sparkle/blueprint-cockpit",
    "main",
    "origin/main",
  ];

  for (const ref of candidates) {
    const found = fromRef(ref);
    if (found) return found;
  }
  throw new Error(
    `Could not find ${MOCK_REL} in the working tree or in any of: ${candidates.join(", ")}.\n` +
      `Pass --mock=<path>, or set SPARKLE_VISUAL_MOCK_REF=<git ref> to name the ref that has it.`,
  );
}

/** Serve one HTML string over http — file:// is rejected by too much tooling to be worth it. */
export async function serveHtml(html) {
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(html);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${server.address().port}/`,
    stop: () => server.close(),
  };
}

/** CSS that hides the mock's own scaffolding — its control bar, caption and notes are not design. */
export function mockChromeCss(selectors = MOCK_CHROME_SELECTORS) {
  return `${selectors.join(",")} { display: none !important; }`;
}

/**
 * The viewport the mock must be rendered at: whatever `visual:capture` actually used.
 *
 * capture.mjs writes its viewport into manifest.json precisely so this side does not have to guess,
 * but this used to re-derive its own defaults and ignore the file. Capture at `--scale=1` and
 * compare at the default 2 (easy — the `visual` script chains the two commands and forwards
 * nothing) and every surface is scored at half density against a double-density reference: sizes
 * differ by exactly 2×, the percentage saturates, and the report reads as catastrophic design
 * divergence with nothing anywhere pointing at the density. Explicit CLI flags still win, so a
 * deliberate override is possible; the manifest is the default. (roborev 54744)
 */
export function viewportFromManifest(appDir, overrides = {}) {
  const fallback = { width: 1600, height: 1000, deviceScaleFactor: 2 };
  let fromManifest = {};
  const p = join(appDir, "manifest.json");
  if (existsSync(p)) {
    try {
      const m = JSON.parse(readFileSync(p, "utf8"));
      if (m && typeof m.viewport === "object" && m.viewport) fromManifest = m.viewport;
    } catch {
      // A corrupt manifest is not worth aborting a comparison over — fall back and say so.
      console.warn(`[compare] ${p} is unreadable; falling back to default viewport`);
    }
  }
  const merged = { ...fallback, ...fromManifest, ...overrides };
  return {
    width: merged.width,
    height: merged.height,
    deviceScaleFactor: merged.deviceScaleFactor,
    source: Object.keys(overrides).length
      ? "cli"
      : Object.keys(fromManifest).length
        ? "manifest"
        : "default",
  };
}

function fmtPct(n) {
  return `${n.toFixed(2).padStart(6)}%`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const appDir = resolve(args.app || join(process.cwd(), "visual-out", "app"));
  const outDir = resolve(args.out || join(process.cwd(), "visual-out", "compare"));
  const overrides = {};
  if (args.scale !== undefined) overrides.deviceScaleFactor = numericArg(args.scale, 2, "scale");
  if (args.width !== undefined) overrides.width = numericArg(args.width, 1600, "width");
  if (args.height !== undefined) overrides.height = numericArg(args.height, 1000, "height");
  const vp = viewportFromManifest(appDir, overrides);
  const { width, height, deviceScaleFactor: scale } = vp;
  const threshold = numericArg(args.threshold, 0, "threshold", 0);
  const surfaces = selectSurfaces(args.surfaces);
  const themes = args.theme ? [args.theme] : THEMES;

  const mock = resolveMock(args.mock);
  console.log(`[compare] reference: ${mock.source}`);
  console.log(`[compare] viewport: ${width}×${height} @${scale}x (from ${vp.source})`);
  mkdirSync(outDir, { recursive: true });

  const server = await serveHtml(mock.html);
  // Launched inside the try for the same reason as capture.mjs: a throw here must not skip
  // server.stop(). (roborev 54744)
  let browser = null;
  const rows = [];

  try {
    browser = await launch({ width, height });
    for (const theme of themes) {
      for (const surface of surfaces) {
        const row = { surface: surface.name, theme };
        const appFile = join(appDir, artifactName(surface.name, theme));

        if (!surface.mock) {
          row.status = "no-reference";
          row.note = "the mock has no counterpart for this surface";
          rows.push(row);
          continue;
        }
        if (!existsSync(appFile)) {
          row.status = "missing-capture";
          row.note = `no app capture at ${appFile} — run visual:capture first`;
          rows.push(row);
          continue;
        }

        const page = await browser.newPage();
        try {
          await page.setViewport({ width, height, deviceScaleFactor: scale });
          await page.navigate(server.url);
          await applyTheme(page, theme);
          await page.evaluate(`(() => {
            const s = document.createElement("style");
            s.textContent = ${JSON.stringify(mockChromeCss())};
            document.head.appendChild(s);
          })()`);
          await runSteps(page, surface.mock.steps);
          await settle(page);

          const clip = await page.boundingBox(surface.mock.clip);
          if (!clip) throw new Error(`mock clip matched nothing: ${surface.mock.clip}`);
          const mockPng = await page.screenshot({ clip });
          writeFileSync(join(outDir, `${surface.name}-${theme}-mock.png`), mockPng);

          const appImg = decodePng(readFileSync(appFile));
          const mockImg = decodePng(mockPng);
          const result = compareImages(appImg, mockImg, { threshold });

          writeFileSync(
            join(outDir, `${surface.name}-${theme}-side-by-side.png`),
            encodePng(sideBySide(appImg, mockImg)),
          );
          writeFileSync(
            join(outDir, `${surface.name}-${theme}-diff.png`),
            encodePng(diffImage(appImg, mockImg, { threshold })),
          );

          Object.assign(row, { status: "compared", ...result });
        } catch (e) {
          row.status = "error";
          row.note = e.message;
        } finally {
          await page.close();
        }
        rows.push(row);
      }
    }
  } finally {
    if (browser) await browser.close();
    server.stop();
  }

  writeFileSync(
    join(outDir, "report.json"),
    JSON.stringify({ reference: mock.source, threshold, rows }, null, 2) + "\n",
  );

  console.log(`\n  surface                  theme       diff  overlap   app px        mock px`);
  console.log(`  ${"─".repeat(76)}`);
  for (const r of rows) {
    const name = r.surface.padEnd(24);
    const theme = r.theme.padEnd(8);
    if (r.status !== "compared") {
      console.log(`  ${name} ${theme} ${r.status.padStart(8)}  — ${r.note ?? ""}`);
      continue;
    }
    const a = `${r.aSize.width}×${r.aSize.height}`.padEnd(12);
    const b = `${r.bSize.width}×${r.bSize.height}`;
    console.log(`  ${name} ${theme} ${fmtPct(r.percent)} ${fmtPct(r.overlapPercent)}  ${a}  ${b}`);
  }
  console.log(
    `\n  diff    = differing pixels over the UNION — saturates near 100% when sizes differ,\n` +
      `            which is the honest reading: a surface of the wrong size is wholly wrong.\n` +
      `  overlap = differing pixels within the SHARED region only — the number that moves as\n` +
      `            the design converges. Read both; either alone hides half the finding.`,
  );
  console.log(`\n[compare] artifacts → ${outDir}`);

  const errored = rows.filter((r) => r.status === "error" || r.status === "missing-capture");
  if (errored.length) {
    console.error(`[compare] ${errored.length} surface(s) could not be compared.`);
    return 1;
  }
  return 0;
}

async function cli() {
  // Same reason as capture.mjs: Chrome can keep the loop alive after the work is done.
  process.exit(await main());
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await cli();
}
