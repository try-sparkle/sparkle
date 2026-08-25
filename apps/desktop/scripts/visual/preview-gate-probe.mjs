#!/usr/bin/env node
// DOES AN AGENT'S PREVIEW SHOW THE APP, OR THE AUTH GATE? (bead sparkle-bg6868)
//
// The founder's report: "It's great to see these previews but the preview I'm getting is not the
// right one" — every preview card rendered WelcomeScreen's "We couldn't load your free-trial
// status" banner instead of the app. Cause: a plain headless browser has no Tauri IPC, so
// `trialApi.fetchTrial()` (`invoke("trial_status")`) rejects, `trialStore` sets `error`, and
// `AuthGate` paints the gate. Fix: `vite.config.ts` serves the dev-only IPC shim (and
// `devBypassAuth` turns on) for `--mode preview`.
//
// WHY THIS PROBE EXISTS RATHER THAN A SCREENSHOT. "It looks different now" is not a check anyone
// else can re-run. This asserts on the DOM — the app shell present, the banner absent — and the
// exit code is the verdict. It is also the ONE measurement that covers the whole chain end to end;
// the unit tests pin each gate, but only this one proves the assembled thing renders.
//
// IT SPAWNS THE REAL PREVIEW COMMAND. The argv comes out of `.sparkle/config.toml`'s `[preview]`
// block, not out of a re-spelling of it here, so a change to that block that breaks the preview
// (dropping `--mode preview`, say — which is what switches the shim on) turns THIS red rather than
// passing against a command nobody runs.
//
// Not in `pnpm verify`: it needs the Playwright headless shell and ~20s. Run it by hand, or after
// touching the preview path:
//     node apps/desktop/scripts/visual/preview-gate-probe.mjs
//     node apps/desktop/scripts/visual/preview-gate-probe.mjs --json
// Exit 0 = the preview renders the app. Exit 1 = it renders the gate (or something else).

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { launch, getFreePort } from "./cdp.mjs";
import { decodePng } from "./png.mjs";
import { DESKTOP_DIR } from "./serve.mjs";

export const REPO_ROOT = resolve(DESKTOP_DIR, "..", "..");

/** The exact viewport `preview_capture.rs` uses, so what this reads is what the card shows. */
export const VIEWPORT = { width: 1280, height: 800 };

/**
 * The banner AuthGate paints when the trial read failed — the founder's screenshot, verbatim from
 * `AuthGate.tsx`. Its presence is the bug; a substring of it is enough and is less brittle than the
 * full sentence.
 */
export const GATE_BANNER = "We couldn't load your free-trial status";

/** WelcomeScreen's own copy, in case the banner is ever reworded but the gate still renders. */
export const GATE_MARKERS = [GATE_BANNER, "free-trial status", "Start a free trial"];

/**
 * THE app marker. `#root` having children is not enough — the gate renders into #root too, and so
 * does the error boundary (which is what the auth-bypass-without-a-shim experiment produced, and
 * what a "no banner" check alone would happily pass). `workspace-shell` is `Workspace.tsx`'s own
 * root element, so it exists only when the app itself has mounted behind the gate.
 */
export const APP_SHELL = '[data-testid="workspace-shell"]';

/** Reported alongside, not required — corroboration that the shell has real furniture in it. */
export const APP_MARKERS = [APP_SHELL, '[data-testid="concierge-box"]', "textarea"];

/**
 * THE SECOND SYMPTOM the founder screenshotted: a card thumbnail that reads as an empty box.
 *
 * `PreviewCards.tsx`'s collapsed `shot` is `objectFit: cover` + `objectPosition: top` +
 * `maxHeight: 150`, so the thumbnail is the TOP BAND of this 1280×800 capture. WelcomeScreen
 * centres a little text in a large flat field, so that band was a single colour. This is not a
 * separate defect and it is not gated here — it is REPORTED, so "fixing the gate fixed the
 * thumbnail too" is a number somebody can read rather than an inference.
 */
export const THUMBNAIL_BAND_HEIGHT = 150;

/** Distinct RGB values in a band of pixels. 1 means "a flat rectangle" — the blank thumbnail. */
export function distinctColors(png) {
  const seen = new Set();
  const { data, width, height } = png;
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    seen.add((data[o] << 16) | (data[o + 1] << 8) | data[o + 2]);
  }
  return seen.size;
}

/**
 * `[preview].command`/`args`/`path` out of the repo's own config, with `{port}` substituted.
 *
 * A deliberately small reader rather than a TOML dependency: it must fail LOUDLY if the block moves
 * or is rewritten, because a silent fallback to some other command is exactly how a probe ends up
 * measuring something nobody runs.
 */
export function previewCommand(toml, port) {
  // `(?![\s\S])` is end-of-input; JS has no `\Z`, and `$` under /m would stop at the first newline.
  const block = /^\[preview\]$([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(toml);
  if (!block) throw new Error("no [preview] block in .sparkle/config.toml");
  const body = block[1];
  const command = /^command\s*=\s*"([^"]*)"/m.exec(body)?.[1];
  const path = /^path\s*=\s*"([^"]*)"/m.exec(body)?.[1] ?? ".";
  const argsRaw = /^args\s*=\s*\[([^\]]*)\]/m.exec(body)?.[1];
  if (!command || argsRaw === undefined) {
    throw new Error("[preview] is missing command/args — the preview server's argv is not readable");
  }
  const args = [...argsRaw.matchAll(/"([^"]*)"/g)].map((m) => m[1].replace("{port}", String(port)));
  return { command, args, path };
}

async function startPreviewServer() {
  const port = await getFreePort();
  const toml = readFileSync(resolve(REPO_ROOT, ".sparkle", "config.toml"), "utf8");
  const { command, args, path } = previewCommand(toml, port);
  const cwd = resolve(REPO_ROOT, path);
  // NO `VITE_SPARKLE_DEV_BYPASS_AUTH` and NO CDP init script: the whole question is whether the
  // SERVER supplies what the preview needs, with the browser given nothing the real capture path
  // (`preview_capture.rs` `launch_flags`) does not give it.
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, BROWSER: "none" },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  const stop = () => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  };
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      stop();
      throw new Error(`${command} exited ${child.exitCode}. Output:\n${log.slice(0, 2000)}`);
    }
    try {
      const r = await fetch(url);
      if (r.ok) return { url, port, stop, argv: [command, ...args] };
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  stop();
  throw new Error(`${command} never became ready at ${url}. Output:\n${log.slice(0, 2000)}`);
}

/** The single read the verdict is made from. Kept pure-ish so the shape is easy to print. */
export function verdict(observed) {
  const gateHits = GATE_MARKERS.filter((m) => observed.text.includes(m));
  const appHits = APP_MARKERS.filter((s) => observed.selectorsPresent.includes(s));
  return {
    ...observed,
    gateHits,
    appHits,
    // BOTH halves are required. "no banner" alone passes for a blank page and for the app's own
    // error boundary (19 nodes — the measured result of the auth bypass WITHOUT this shim); "the
    // shell is mounted" alone would pass if the gate somehow painted over a mounted tree.
    ok: gateHits.length === 0 && appHits.includes(APP_SHELL),
  };
}

export async function probe() {
  const server = await startPreviewServer();
  let browser;
  try {
    browser = await launch(VIEWPORT);
    const page = await browser.newPage();
    await page.setViewport({ ...VIEWPORT, deviceScaleFactor: 1 });
    await page.navigate(server.url);
    // The app mounts asynchronously (AuthGate resolves, then Workspace is a lazy chunk). Wait for
    // EITHER outcome so a broken preview fails with its actual content rather than a bare timeout.
    const settled = `(() => {
      const t = document.body ? document.body.innerText : "";
      if (${JSON.stringify(GATE_MARKERS)}.some((m) => t.includes(m))) return true;
      return ${JSON.stringify(APP_MARKERS)}.some((s) => !!document.querySelector(s));
    })()`;
    try {
      await page.waitForFunction(settled, { timeout: 30000 });
    } catch {
      /* fall through and report what IS there — that is more useful than the timeout */
    }
    const read = `JSON.stringify({
      text: (document.body ? document.body.innerText : "").slice(0, 1200),
      nodes: document.querySelectorAll("*").length,
      selectorsPresent: ${JSON.stringify(APP_MARKERS)}.filter((s) => !!document.querySelector(s)),
      title: document.title,
    })`;
    const observed = JSON.parse(await page.evaluate(read));
    const band = decodePng(
      await page.screenshot({
        clip: { x: 0, y: 0, width: VIEWPORT.width, height: THUMBNAIL_BAND_HEIGHT },
      }),
    );
    return verdict({
      ...observed,
      thumbnailColors: distinctColors(band),
      url: server.url,
      argv: server.argv,
    });
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.stop();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const json = process.argv.includes("--json");
  const v = await probe();
  if (json) {
    console.log(JSON.stringify(v, null, 2));
  } else {
    console.log(`preview:      ${v.url}`);
    console.log(`argv:         ${v.argv.join(" ")}`);
    console.log(`DOM nodes:    ${v.nodes}`);
    console.log(`thumb colors: ${v.thumbnailColors} distinct RGB in the top ${THUMBNAIL_BAND_HEIGHT}px (1 = a blank card)`);
    console.log(`app markers:  ${v.appHits.length ? v.appHits.join(", ") : "(none)"}`);
    console.log(`gate markers: ${v.gateHits.length ? v.gateHits.join(", ") : "(none)"}`);
    console.log(`--- body text (first 1200 chars) ---\n${v.text}`);
    console.log(v.ok ? "\nPASS — the preview renders the app." : "\nFAIL — the preview is not the app.");
  }
  process.exit(v.ok ? 0 : 1);
}
