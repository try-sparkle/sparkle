// Boots the app's renderer over http for the visual harness.
//
// IT MUST BE THE VITE **DEV** SERVER, NOT `vite preview`. The auth bypass
// (src/dev/devBypassAuth.ts) is gated on `import.meta.env.DEV`, which is deliberately FALSE in a
// `vite build` artifact so the bypass can never activate in a shipped bundle. `vite preview` serves
// exactly that artifact, so the harness would only ever photograph the paywall. Anything that
// replaces this — a static server, `python3 -m http.server` — has the same problem for the same
// reason.

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getFreePort } from "./cdp.mjs";

export const DESKTOP_DIR = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

/**
 * Starts `vite` with the dev auth bypass on. Returns { url, stop }.
 * `stop` kills the whole process group — vite spawns children, and a bare `kill` orphans them.
 */
export async function startDevServer({ port, quiet = true } = {}) {
  const chosen = port ?? (await getFreePort());
  const child = spawn("pnpm", ["exec", "vite", "--port", String(chosen), "--strictPort"], {
    cwd: DESKTOP_DIR,
    env: { ...process.env, VITE_SPARKLE_DEV_BYPASS_AUTH: "1", BROWSER: "none" },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  const collect = (d) => {
    log += d;
    if (!quiet) process.stderr.write(`[vite] ${d}`);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);

  // `localhost`, not `127.0.0.1`: vite binds the hostname, which resolves to ::1 first on this
  // machine, so probing the IPv4 literal reports "never became ready" against a server that is up.
  const url = `http://localhost:${chosen}`;
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

  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      stop();
      throw new Error(`vite exited with code ${child.exitCode}. Output:\n${log.slice(0, 2000)}`);
    }
    try {
      const r = await fetch(url);
      if (r.ok) return { url, stop, port: chosen };
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  stop();
  throw new Error(`vite never became ready at ${url}. Output:\n${log.slice(0, 2000)}`);
}

/**
 * The Tauri IPC shim. The renderer reads `window.__TAURI_INTERNALS__` for every backend call;
 * outside a Tauri webview it is absent and those calls THROW, which is what pins the app on a
 * blank screen in a plain browser. Resolving them to null instead lets the tree mount — the
 * fixtures (src/dev/visualFixtures.ts) supply the data the backend would have.
 *
 * Installed via Page.addScriptToEvaluateOnNewDocument, so it is in place before any app module runs.
 */
export const TAURI_SHIM = `
  (() => {
    let seq = 0;
    // Commands whose NULL answer would visibly change the layout. Everything else resolves to null,
    // which the app already treats as "no data" — that is the intended empty-workspace behaviour.
    //
    // probe_connectivity is the one that bites. connectivity.ts falls back to navigator.onLine only
    // when invoke THROWS; a resolved null is a falsy verdict, so the whole workspace renders under
    // the offline banner — a full-width strip that pushes every surface down and would score as a
    // layout-wide difference on every capture. Answering it truthfully (the harness does have a
    // network) is more faithful than clamping the store afterwards.
    const ANSWERS = {
      probe_connectivity: true,
      notify_frontend_shown: null,
    };
    window.__TAURI_INTERNALS__ = {
      metadata: {
        currentWindow: { label: "main" },
        currentWebview: { label: "main" },
      },
      transformCallback: () => ++seq,
      unregisterCallback: () => {},
      invoke: (cmd) =>
        Promise.resolve(Object.prototype.hasOwnProperty.call(ANSWERS, cmd) ? ANSWERS[cmd] : null),
      convertFileSrc: (p) => p,
    };
  })();
`;

/**
 * Freezes wall-clock time. Every "3m ago" in the sidebar is `Date.now() - t`, so without this the
 * same surface renders differently on every run and a diff percentage measures the clock rather
 * than the design. Anchored to a fixed instant that the fixtures' timestamps are expressed against.
 *
 * `performance.now` is left alone: React and the animation code use it for scheduling, and pinning
 * it deadlocks rAF loops.
 */
export const FROZEN_CLOCK = `
  (() => {
    // 2026-07-28T17:00:00.000Z. Spelled as a literal, not computed, so the drift guard in
    // src/dev/visualFixtures.test.ts can read it straight out of this source file — that test
    // asserts this number equals FIXTURE_NOW, so the two cannot silently diverge.
    const FIXED = 1785258000000;
    const RealDate = Date;
    const D = function (...args) {
      if (!(this instanceof D)) return new RealDate(FIXED).toString();
      return args.length === 0 ? new RealDate(FIXED) : new RealDate(...args);
    };
    D.prototype = RealDate.prototype;
    D.now = () => FIXED;
    D.parse = RealDate.parse;
    D.UTC = RealDate.UTC;
    window.Date = D;
    // Kill CSS/JS animation drift: a capture taken mid-transition is not reproducible.
    const style = document.createElement("style");
    style.textContent =
      "*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;" +
      "transition-duration:0s!important;transition-delay:0s!important;" +
      "caret-color:transparent!important}";
    const attach = () => document.documentElement.appendChild(style);
    if (document.documentElement) attach();
    else document.addEventListener("DOMContentLoaded", attach);
  })();
`;
