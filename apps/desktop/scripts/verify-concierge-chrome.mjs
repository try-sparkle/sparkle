// Visual verification for the three founder asks, in a REAL layout engine.
//
// jsdom cannot answer any of the questions that actually matter here — it has no layout, so
// getBoundingClientRect is all zeros and a CSS clamp never evaluates. This boots the real frontend
// under Vite (auth bypassed, same as scripts/screenshot.mjs), stubs the Tauri bridge so
// `project_open_prs` returns the THREE REAL PRs the founder supplied, and then MEASURES:
//
//   item 3 — each of #944 / #934 / #925 renders a non-green dot, carries a WORD, and its Merge
//            button is absent-or-disabled; "Merge all ready" counts only green.
//   item 1 — the PR chip sits in the concierge header next to the ⋮, shows an icon, and shows a
//            number only when something is green.
//   item 2 — the waveform's painted right edge reaches the column's right edge, and the credit
//            pill's box OVERLAPS the waveform's box (i.e. it is on top of it, not beside it).
//
// Writes PNGs + a JSON report. Exit code is nonzero if any check fails.
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

const DESKTOP_DIR = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const outDir = resolve(process.argv[2] || join(tmpdir(), "sparkle-concierge-chrome-" + process.pid));
mkdirSync(outDir, { recursive: true });

const getFreePort = () =>
  new Promise((res, rej) => {
    const s = createServer();
    s.on("error", rej);
    s.listen(0, () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
  });
const PORT = await getFreePort();
const BASE = "http://localhost:" + PORT;
const log = (m) => console.log("[verify] " + m);

async function waitForServer(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(BASE);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("vite never came up");
}

let server = null;
let browser = null;
const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass: !!pass, detail });
  log((pass ? "PASS  " : "FAIL  ") + name + " — " + detail);
};

try {
  server = spawn("pnpm", ["exec", "vite", "--port", String(PORT), "--strictPort"], {
    cwd: DESKTOP_DIR,
    env: { ...process.env, VITE_SPARKLE_DEV_BYPASS_AUTH: "1", BROWSER: "none" },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stderr.on("data", (d) => process.stderr.write("[vite] " + d));
  await waitForServer(90000);
  log("vite up on " + PORT);

  browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.addInitScript(() => {
    // A project, so the concierge's PR chip has a repo to scope to.
    localStorage.setItem(
      "sparkle-projects",
      JSON.stringify({
        state: {
          projects: [
            {
              id: "p1",
              name: "sparkle",
              rootPath: "/repo",
              defaultBranch: "main",
              createdAt: "2026-07-30T00:00:00.000Z",
              lastOpenedAt: "2026-07-30T00:00:00.000Z",
              agents: [],
              selectedAgentId: null,
              freshBuildAgentId: null,
            },
          ],
          selectedProjectId: "p1",
        },
        version: 12,
      }),
    );

    // THE THREE REAL PRs, exactly as the GitHub API reported them, plus one genuinely green row so
    // "Merge all ready (1)" has something to count.
    const PRS = [
      {
        number: 944,
        title: "fix: the conflicting one",
        headRefName: "sparkle/conflicting",
        url: "https://github.com/drodio/sparkle/pull/944",
        checks: "passing",
        mergeable: "conflicting",
        mergeStateStatus: "dirty",
        failingChecks: [],
        pendingChecks: [],
      },
      {
        number: 934,
        title: "feat: unstable, a check is failing",
        headRefName: "sparkle/unstable-a",
        url: "https://github.com/drodio/sparkle/pull/934",
        checks: "failing",
        mergeable: "mergeable",
        mergeStateStatus: "unstable",
        failingChecks: ["CI / test (node)"],
        pendingChecks: [],
      },
      {
        number: 925,
        title: "chore: unstable, a check is still running",
        headRefName: "sparkle/unstable-b",
        url: "https://github.com/drodio/sparkle/pull/925",
        checks: "pending",
        mergeable: "mergeable",
        mergeStateStatus: "unstable",
        failingChecks: [],
        pendingChecks: ["CI / build", "secret-scan", "CI / lint"],
      },
      {
        number: 900,
        title: "docs: the genuinely green one",
        headRefName: "sparkle/green",
        url: "https://github.com/drodio/sparkle/pull/900",
        checks: "passing",
        mergeable: "mergeable",
        mergeStateStatus: "clean",
        failingChecks: [],
        pendingChecks: [],
      },
    ];

    const rnd = () => Math.floor(Math.random() * 1e9);
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: () => rnd(),
      unregisterCallback: () => {},
      invoke: (cmd) => Promise.resolve(cmd === "project_open_prs" ? PRS : null),
      convertFileSrc: (p) => p,
    };
  });

  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-testid=terminal-stage]", { timeout: 60000 });
  await page.waitForSelector("[aria-label='Sparkle concierge']", { timeout: 20000 });
  await page.waitForTimeout(1200);

  // ── ITEM 2: the waveform reaches the right edge; the credit pill floats ON it ────────────────
  const geom = await page.evaluate(() => {
    const col = document.querySelector("[aria-label='Sparkle concierge']");
    const slot = document.querySelector("[data-testid=concierge-waveform-slot]");
    const overlay = document.querySelector("[data-testid=concierge-credit-overlay]");
    const wave = document.querySelector("[data-testid=logo-waveform]") || slot;
    const r = (e) => (e ? e.getBoundingClientRect().toJSON() : null);
    return { col: r(col), slot: r(slot), overlay: r(overlay), wave: r(wave) };
  });

  if (!geom.slot || !geom.overlay) {
    check("item2/present", false, "waveform slot or credit overlay is not in the DOM: " + JSON.stringify(geom));
  } else {
    // The founder's complaint was DEAD SPACE on the right where the pill began. The waveform's own
    // stage should now run to the column's right edge, allowing only the strip's 16px padding.
    const gap = geom.col.right - geom.slot.right;
    check(
      "item2/waveform reaches the right edge",
      gap <= 4,
      `column right ${geom.col.right.toFixed(1)} − waveform right ${geom.slot.right.toFixed(1)} = ${gap.toFixed(1)}px of dead space (want ≤4)`,
    );
    // OVERLAID, not beside: the pill's box must sit INSIDE the waveform's horizontal span.
    const overlaps = geom.overlay.left < geom.slot.right && geom.overlay.right > geom.slot.left;
    check(
      "item2/credit pill overlays the waveform",
      overlaps,
      `pill x=[${geom.overlay.left.toFixed(1)}, ${geom.overlay.right.toFixed(1)}] vs waveform x=[${geom.slot.left.toFixed(1)}, ${geom.slot.right.toFixed(1)}]`,
    );
    // …and it must not have shrunk the waveform to do it: the slot spans essentially the whole strip.
    const frac = geom.slot.width / geom.col.width;
    check(
      "item2/waveform was not shrunk to make room",
      frac > 0.92,
      `waveform is ${(frac * 100).toFixed(1)}% of the column's width`,
    );
  }

  // ── ITEM 1: the compact PR chip, in the header, beside the ⋮ ────────────────────────────────
  const chip = await page.evaluate(() => {
    const header = document.querySelector("[data-testid=concierge-header]");
    const badge = header ? header.querySelector("[data-testid=open-pr-badge]") : null;
    const kebab = header ? header.querySelector("[aria-label=Settings], button[title*=Settings]") : null;
    if (!badge) return { found: false, headerHTML: header ? header.innerHTML.slice(0, 400) : null };
    const br = badge.getBoundingClientRect();
    return {
      found: true,
      text: badge.textContent,
      hasSvg: !!badge.querySelector("svg"),
      ready: badge.getAttribute("data-ready"),
      width: br.width,
      height: br.height,
      kebabRight: kebab ? kebab.getBoundingClientRect().left : null,
      badgeRight: br.right,
      // No second PR affordance anywhere in the app.
      totalBadges: document.querySelectorAll("[data-testid=open-pr-badge]").length,
    };
  });
  check("item1/chip is in the concierge header", chip.found, JSON.stringify(chip).slice(0, 300));
  if (chip.found) {
    check("item1/shows the PR icon", chip.hasSvg, "svg present");
    check(
      "item1/shows the GREEN count only",
      chip.text.trim() === "1",
      `chip text is "${chip.text}" — 4 PRs open, 1 green, so the number must be 1 and there must be no "PRs waiting" wording`,
    );
    check("item1/is small", chip.width < 60, `chip is ${chip.width.toFixed(1)}px wide`);
    check(
      "item1/sits left of the ⋮ cluster",
      chip.kebabRight === null || chip.badgeRight <= chip.kebabRight + 1,
      `chip right ${chip.badgeRight.toFixed(1)} vs kebab left ${chip.kebabRight}`,
    );
    check(
      "item1/there is exactly ONE PR affordance in the app",
      chip.totalBadges === 1,
      `${chip.totalBadges} open-pr badges rendered`,
    );
  }

  await page.screenshot({ path: join(outDir, "concierge-closed.png") });
  const col = await page.$("[aria-label='Sparkle concierge']");
  if (col) await col.screenshot({ path: join(outDir, "column-closed.png") });

  // ── ITEM 3: open the menu and judge the three real PRs ───────────────────────────────────────
  if (chip.found) {
    await page.click("[data-testid=open-pr-badge]");
    await page.waitForSelector("[data-testid=open-pr-panel]", { timeout: 10000 });
    await page.waitForTimeout(600);

    const rows = await page.evaluate(() => {
      const panel = document.querySelector("[data-testid=open-pr-panel]");
      const out = {};
      for (const n of [944, 934, 925, 900]) {
        const word = panel.querySelector(`[data-testid=pr-state-${n}]`);
        const merge = panel.querySelector(`[data-testid=merge-${n}]`);
        const override = panel.querySelector(`[data-testid=merge-override-${n}]`);
        const dot = panel.querySelector(`[data-testid=pr-dot-${n}]`);
        out[n] = {
          word: word ? word.textContent : null,
          wordColor: word ? getComputedStyle(word).color : null,
          dotColor: dot ? getComputedStyle(dot).backgroundColor : null,
          mergeEnabled: merge ? !merge.disabled : null,
          hasOverride: !!override,
          overrideText: override ? override.textContent : null,
        };
      }
      const all = panel.querySelector("[data-testid=merge-all]");
      out.mergeAll = all ? { text: all.textContent, disabled: all.disabled } : null;
      out.panelRect = panel.getBoundingClientRect().toJSON();
      return out;
    });

    for (const n of [944, 934, 925]) {
      const r = rows[n];
      check(
        `item3/#${n} offers no one-click Merge`,
        r.mergeEnabled !== true,
        `merge button enabled=${r.mergeEnabled}, override=${r.hasOverride ? JSON.stringify(r.overrideText) : "none"}`,
      );
      check(
        `item3/#${n} carries a WORD, not just a colour`,
        !!r.word && r.word.trim().length > 0,
        `word=${JSON.stringify(r.word)} colour=${r.wordColor}`,
      );
    }
    check(
      "item3/#934 names the FAILING check",
      (rows[934].word || "").toLowerCase().includes("fail"),
      `word=${JSON.stringify(rows[934].word)}`,
    );
    check(
      "item3/#925 says checks are RUNNING, with a count",
      /running|\(3\)/i.test(rows[925].word || ""),
      `word=${JSON.stringify(rows[925].word)}`,
    );
    check(
      "item3/#944 says conflict",
      /conflict/i.test(rows[944].word || ""),
      `word=${JSON.stringify(rows[944].word)}`,
    );
    check("item3/the green one DOES offer one-click Merge", rows[900].mergeEnabled === true, `#900 enabled=${rows[900].mergeEnabled}`);
    check(
      "item3/'Merge all ready' counts only green",
      rows.mergeAll && rows.mergeAll.text.includes("(1)"),
      `merge-all = ${JSON.stringify(rows.mergeAll)}`,
    );

    // Containment: the panel must stay inside the window on a ~380px column.
    const vp = page.viewportSize();
    check(
      "item1/panel stays inside the window",
      rows.panelRect.left >= -1 && rows.panelRect.right <= vp.width + 1,
      `panel x=[${rows.panelRect.left.toFixed(1)}, ${rows.panelRect.right.toFixed(1)}] in a ${vp.width}px window`,
    );

    await page.screenshot({ path: join(outDir, "concierge-menu-open.png") });
    if (col) await col.screenshot({ path: join(outDir, "column-menu-open.png") });
  }

  writeFileSync(join(outDir, "report.json"), JSON.stringify({ results, errors: errors.slice(0, 20) }, null, 2));
  const failed = results.filter((r) => !r.pass);
  log(`${results.length - failed.length}/${results.length} checks passed. PNGs + report.json in ${outDir}`);
  if (failed.length) {
    log("FAILED: " + failed.map((f) => f.name).join(", "));
    process.exitCode = 1;
  }
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server && server.pid) {
    try {
      process.kill(-server.pid, "SIGTERM");
    } catch {
      try {
        server.kill("SIGTERM");
      } catch {}
    }
  }
}
