// apps/desktop/scripts/screenshot.mjs
//
// Screenshot loop for the design agent (plan 3c). Boots the Vite dev server with the DEV auth
// bypass (VITE_SPARKLE_DEV_BYPASS_AUTH), drives headless Chromium to localhost:1420, waits for the
// WORKSPACE to render (sidebar + columns, NOT the paywall), then captures the viewport and each
// column in BOTH light and dark themes.
//
// Backend data is empty outside a Tauri webview (invoke no-ops), so the columns show their
// empty/onboarding state — that is fine: this exists to make the workspace CHROME (type scale,
// radii, spacing, columns) visible for a visual migration.
//
// Usage:  node scripts/screenshot.mjs [outDir]
//   or:   pnpm --filter @sparkle/desktop screenshot
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

function getFreePort() {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.on("error", rej);
    srv.listen(0, () => {
      const port = srv.address().port;
      srv.close(() => res(port));
    });
  });
}

const DESKTOP_DIR = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const PORT = process.env.SCREENSHOT_PORT ? Number(process.env.SCREENSHOT_PORT) : await getFreePort();
const BASE = "http://localhost:" + PORT;
const VIEWPORT = { width: 1440, height: 900 };

const outDir = resolve(process.argv[2] || join(tmpdir(), "sparkle-screenshots-" + Date.now()));
mkdirSync(outDir, { recursive: true });

function log(msg) {
  console.log("[screenshot] " + msg);
}

async function waitForServer(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(BASE);
      if (r.ok) return;
    } catch (e) {
      // not up yet
    }
    await new Promise((res) => setTimeout(res, 300));
  }
  throw new Error("Vite dev server never became ready at " + BASE);
}

function startDevServer() {
  // Run vite directly (not pnpm dev) to skip the predev MCP-copy the browser preview does not need.
  const env = Object.assign({}, process.env, { VITE_SPARKLE_DEV_BYPASS_AUTH: "1", BROWSER: "none" });
  const child = spawn("pnpm", ["exec", "vite", "--port", String(PORT), "--strictPort"], {
    cwd: DESKTOP_DIR,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => process.stdout.write("[vite] " + d));
  child.stderr.on("data", (d) => process.stderr.write("[vite] " + d));
  return child;
}

async function applyTheme(page, theme) {
  // Default themePref is auto, resolved via matchMedia, so emulating the color scheme re-runs the
  // app useApplyTheme effect and rewrites the <html data-theme> attribute. Set it directly too.
  await page.emulateMedia({ colorScheme: theme });
  await page.evaluate((t) => {
    document.documentElement.dataset.theme = t;
  }, theme);
  await page.waitForFunction((t) => document.documentElement.dataset.theme === t, theme, {
    timeout: 5000,
  });
  await page.waitForTimeout(350);
}

async function shoot(page, theme) {
  const files = [];
  const full = join(outDir, "workspace-" + theme + ".png");
  await page.screenshot({ path: full });
  files.push(full);
  const columns = [
    ["sidebar", "[data-testid=agent-sidebar-column]"],
    ["terminal-stage", "[data-testid=terminal-stage]"],
  ];
  for (const pair of columns) {
    const el = await page.$(pair[1]);
    if (el) {
      const f = join(outDir, "column-" + pair[0] + "-" + theme + ".png");
      await el.screenshot({ path: f });
      files.push(f);
    }
  }
  return files;
}

let server = null;
let browser = null;
try {
  log("booting Vite dev server on port " + PORT + " with the auth bypass ...");
  server = startDevServer();
  await waitForServer(60000);
  log("dev server ready; launching headless Chromium");
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2 });
  const page = await context.newPage();
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));
  // Minimal Tauri internals shim so getCurrentWindow()/getCurrentWebview()/invoke()/listen() no-op
  // instead of THROWING in a plain browser (they read window.__TAURI_INTERNALS__, absent here). Backend
  // invokes resolve to null, so the workspace renders with empty data — exactly the plan 3c scope.
  await page.addInitScript(() => {
    const rnd = () => Math.floor(Math.random() * 1e9);
    window.__TAURI_INTERNALS__ = {
      metadata: {
        currentWindow: { label: "main" },
        currentWebview: { label: "main" },
      },
      transformCallback: () => rnd(),
      unregisterCallback: () => {},
      invoke: () => Promise.resolve(null),
      convertFileSrc: (p) => p,
    };
  });
  await page.goto(BASE, { waitUntil: "domcontentloaded" });

  // Wait for the WORKSPACE (the terminal stage mounts only past AuthGate), not the paywall.
  try {
    await page.waitForSelector("[data-testid=terminal-stage]", { timeout: 45000 });
  } catch (e) {
    const fail = join(outDir, "FAILURE.png");
    await page.screenshot({ path: fail }).catch(() => {});
    const text = await page
      .evaluate(() => (document.body ? document.body.innerText.slice(0, 800) : "(no body)"))
      .catch(() => "(unreadable)");
    writeFileSync(
      join(outDir, "FAILURE.txt"),
      "Did not reach the workspace.\n\nVisible text:\n" + text + "\n\nConsole errors:\n" + errors.join("\n"),
    );
    throw new Error("Workspace (terminal-stage) never rendered. Wrote " + fail + " for diagnosis.");
  }

  const paywall = await page.getByText("Unlock Sparkle").count();
  if (paywall > 0) {
    throw new Error("Rendered the PAYWALL, not the workspace — the auth bypass did not take.");
  }

  const written = [];
  for (const theme of ["light", "dark"]) {
    await applyTheme(page, theme);
    const files = await shoot(page, theme);
    for (const f of files) written.push(f);
  }

  log("wrote " + written.length + " PNGs:");
  for (const f of written) console.log(f);
  log("DONE. Output dir: " + outDir);
  if (errors.length) {
    log("(note: " + errors.length + " page console errors — expected: Tauri invoke no-ops in a browser)");
  }
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server && server.pid) {
    // Kill the whole process group (spawned detached) so vite is not left orphaned.
    try {
      process.kill(-server.pid, "SIGTERM");
    } catch (e) {
      try {
        server.kill("SIGTERM");
      } catch (e2) {
        // already gone
      }
    }
  }
}
