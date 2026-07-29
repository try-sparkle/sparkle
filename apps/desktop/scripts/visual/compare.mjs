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
import { applyTheme, parseArgs, runSteps, settle } from "./capture.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
// apps/desktop/scripts/visual → apps/desktop/scripts → apps/desktop → apps → <repo root>
export const REPO_ROOT = resolve(HERE, "..", "..", "..", "..");
export const MOCK_REL = "PRD/sparkle/ui-directions/rev4-standalone.html";

/**
 * Where the approved mock lives.
 *
 * It is NOT on every branch. rev4-standalone.html was authored on `sparkle/blueprint-cockpit` and
 * has not landed on main, so an instrument that only reads the working tree would be unusable on
 * exactly the branches that most need it. Resolution order:
 *   1. --mock=<path>
 *   2. the working tree
 *   3. `git show <ref>:<path>` over a list of candidate refs (SPARKLE_VISUAL_MOCK_REF, then the
 *      branch that authored it, then main)
 * Once the mock lands on main, step 2 always wins and the fallback goes quiet on its own.
 */
export function resolveMock(explicitPath, { repoRoot = REPO_ROOT, refs } = {}) {
  if (explicitPath) {
    const p = resolve(explicitPath);
    if (!existsSync(p)) throw new Error(`--mock path does not exist: ${p}`);
    return { html: readFileSync(p, "utf8"), source: p };
  }
  const inTree = join(repoRoot, MOCK_REL);
  if (existsSync(inTree)) return { html: readFileSync(inTree, "utf8"), source: MOCK_REL };

  const candidates = refs ?? [
    process.env.SPARKLE_VISUAL_MOCK_REF,
    "sparkle/blueprint-cockpit",
    "origin/sparkle/blueprint-cockpit",
    "main",
    "origin/main",
  ].filter(Boolean);

  for (const ref of candidates) {
    try {
      const html = execFileSync("git", ["show", `${ref}:${MOCK_REL}`], {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 32 * 1024 * 1024,
      });
      if (html) return { html, source: `git:${ref}:${MOCK_REL}` };
    } catch {
      // ref missing, or the file is not in it — try the next
    }
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

function fmtPct(n) {
  return `${n.toFixed(2).padStart(6)}%`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const appDir = resolve(args.app || join(process.cwd(), "visual-out", "app"));
  const outDir = resolve(args.out || join(process.cwd(), "visual-out", "compare"));
  const scale = Number(args.scale || 2);
  const width = Number(args.width || 1600);
  const height = Number(args.height || 1000);
  const threshold = Number(args.threshold || 0);
  const surfaces = selectSurfaces(args.surfaces);
  const themes = args.theme ? [args.theme] : THEMES;

  const mock = resolveMock(args.mock);
  console.log(`[compare] reference: ${mock.source}`);
  mkdirSync(outDir, { recursive: true });

  const server = await serveHtml(mock.html);
  const browser = await launch({ width, height });
  const rows = [];

  try {
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
        }
        rows.push(row);
      }
    }
  } finally {
    await browser.close();
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
