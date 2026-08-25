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
 * Wipes the origin's web storage before ANY app module runs, on every new document.
 *
 * A fresh PAGE is not a fresh STORE. Every surface gets its own page, but the whole run shares one
 * browser and one profile, and `localStorage` is origin-scoped — so a key a surface never sets is
 * not "the app's default", it is whatever the surface captured before it left behind. That already
 * cost one real capture: a "wide" surface inherited the previous surface's narrow column and the
 * two PNGs came out byte-identical, with the suite green the whole time.
 *
 * The per-key answer to that lives in the fixture, which resets the concierge widths when it sees
 * `capture=1`. This is the general one: it covers EVERY key, including ones a fixture written next
 * month will store, so a future surface cannot reintroduce the same order-dependence by simply not
 * knowing about this rule. Keep both — the fixture's reset is what makes a width-less surface mean
 * "the default" mid-run, and this is what makes the whole origin start each document from cold.
 *
 * MUST BE THE FIRST init script installed (see INIT_SCRIPTS in capture.mjs). Ordered after a shim
 * that seeds storage it would erase that shim's writes, which is why the ordering has a test of its
 * own rather than resting on the order the calls happen to appear in.
 *
 * The access is guarded: reading `localStorage` throws outright when a browser has storage disabled
 * for the origin, and a throw here runs before the app and would blank every surface. A harness that
 * cannot clear storage should still capture — the bleed it is preventing cannot happen on an origin
 * that has no storage to bleed.
 */
export const CLEAR_STORAGE = `
  (() => {
    try { localStorage.clear(); } catch {}
    try { sessionStorage.clear(); } catch {}
  })();
`;

// The Tauri IPC shim now lives in ./tauriShim.mjs so the agent PREVIEW SERVER can install the same
// string this harness does (bead sparkle-bg6868) — the preview was showing the auth gate because
// nothing served it a bridge. Re-exported here, unchanged, so every existing
// `import { TAURI_SHIM } from "./serve.mjs"` keeps resolving.
export { TAURI_SHIM } from "./tauriShim.mjs";

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
