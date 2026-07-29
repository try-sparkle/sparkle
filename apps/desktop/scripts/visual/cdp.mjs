// A minimal Chrome DevTools Protocol client — the visual harness's browser driver.
//
// WHY NOT PLAYWRIGHT: `playwright` is listed in devDependencies and scripts/screenshot.mjs imports
// it, but it is NOT installed in this worktree's node_modules (that script dies with
// ERR_MODULE_NOT_FOUND). A measuring instrument that only runs after an optional install isn't an
// instrument. Chrome itself is on the machine, and Node >=22 ships a global WebSocket, so CDP over
// a raw socket needs nothing from npm at all.
//
// WHY NOT `--screenshot=out.png`: that one-shot flag loads a URL and exits. It cannot open the
// settings dialog, toggle `data-wired`, or report an element's bounding box — and four of the six
// named surfaces need exactly that. CDP is the same binary with a control channel attached.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

export const CHROME_PATH =
  process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/** Ask the OS for a free TCP port. Racy in principle; fine for a local harness. */
export function getFreePort() {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.on("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => res(port));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Flags chosen for BYTE-STABILITY, not speed. Anything that lets the machine's mood into the
 * raster — GPU rasterization, subpixel text positioning, hinting driven by display DPI, animations,
 * the background-network chatter that can repaint a surface mid-capture — is turned off here rather
 * than papered over with a longer settle timeout in the caller.
 */
export function chromeFlags({ port, userDataDir, width, height }) {
  return [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    `--window-size=${width},${height}`,
    "--disable-gpu",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    // Deterministic text rasterization.
    "--font-render-hinting=none",
    "--disable-font-subpixel-positioning",
    "--disable-lcd-text",
    // Keep the profile inert: no first-run UI, no network side-chatter, no animation drift.
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-sync",
    "--metrics-recording-only",
    "--mute-audio",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--force-color-profile=srgb",
    "--disable-features=Translate,BackForwardCache,AcceptCHFrame,MediaRouter,OptimizationHints",
  ];
}

/** Poll Chrome's HTTP endpoint until it hands back a browser-level websocket URL. */
async function waitForDebugger(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) {
        const j = await r.json();
        if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl;
      }
    } catch (e) {
      lastErr = e;
    }
    await sleep(100);
  }
  throw new Error(
    `Chrome's remote debugger never came up on port ${port}` +
      (lastErr ? ` (last error: ${lastErr.message})` : ""),
  );
}

/**
 * One websocket, many logical sessions. `send` is id-multiplexed; `sessionId` routes a command at
 * an attached page target. Events are dispatched to listeners registered by method name.
 */
class Connection {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener("message", (ev) => this.#onMessage(ev));
    ws.addEventListener("close", () => {
      for (const { reject } of this.pending.values()) {
        reject(new Error("CDP connection closed"));
      }
      this.pending.clear();
    });
  }

  #onMessage(ev) {
    let msg;
    try {
      msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
    } catch {
      return;
    }
    if (msg.id !== undefined) {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(`${msg.error.message} (${msg.method ?? "cdp"})`));
      else entry.resolve(msg.result);
      return;
    }
    const subs = this.listeners.get(msg.method);
    if (subs) for (const fn of [...subs]) fn(msg.params, msg.sessionId);
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(fn);
    return () => this.listeners.get(method)?.delete(fn);
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.ws.send(JSON.stringify(payload));
      } catch (e) {
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* already gone */
    }
  }
}

function connect(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => reject(new Error("Timed out opening the CDP websocket")), timeoutMs);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve(new Connection(ws));
    });
    ws.addEventListener("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`CDP websocket error: ${e?.message ?? "unknown"}`));
    });
  });
}

/**
 * A page target with the handful of operations the harness actually needs. Deliberately small:
 * every method here is used by capture.mjs or compare.mjs.
 */
export class Page {
  constructor(conn, sessionId) {
    this.conn = conn;
    this.sessionId = sessionId;
    this.consoleErrors = [];
    conn.on("Runtime.consoleAPICalled", (p, sid) => {
      if (sid === sessionId && p.type === "error") {
        this.consoleErrors.push(p.args.map((a) => a.value ?? a.description ?? "").join(" "));
      }
    });
    conn.on("Runtime.exceptionThrown", (p, sid) => {
      if (sid === sessionId) {
        this.consoleErrors.push(p.exceptionDetails?.exception?.description ?? "page error");
      }
    });
  }

  send(method, params) {
    return this.conn.send(method, params, this.sessionId);
  }

  /** deviceScaleFactor is applied here rather than at launch so one browser can serve many scales. */
  async setViewport({ width, height, deviceScaleFactor = 2 }) {
    this.viewport = { width, height, deviceScaleFactor };
    await this.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor,
      mobile: false,
      screenWidth: width,
      screenHeight: height,
    });
  }

  /** Drives `prefers-color-scheme`, which is what the app's "auto" theme preference reads. */
  async setColorScheme(scheme) {
    await this.send("Emulation.setEmulatedMedia", {
      media: "screen",
      features: [{ name: "prefers-color-scheme", value: scheme }],
    });
  }

  /** Runs before ANY page script on the next navigation — the only place to install shims. */
  async addInitScript(source) {
    await this.send("Page.addScriptToEvaluateOnNewDocument", { source });
  }

  async navigate(url) {
    const loaded = new Promise((resolve) => {
      const off = this.conn.on("Page.loadEventFired", (_p, sid) => {
        if (sid === this.sessionId) {
          off();
          resolve();
        }
      });
      setTimeout(() => {
        off();
        resolve();
      }, 30000);
    });
    await this.send("Page.navigate", { url });
    await loaded;
  }

  /** Evaluate an expression and return its JSON value. Awaits promises. */
  async evaluate(expression) {
    const r = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error(
        `evaluate failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`,
      );
    }
    return r.result?.value;
  }

  /** Poll a JS predicate. Polling beats a MutationObserver here: React commits in batches. */
  async waitForFunction(expression, { timeout = 30000, poll = 100 } = {}) {
    const deadline = Date.now() + timeout;
    let last;
    while (Date.now() < deadline) {
      try {
        last = await this.evaluate(`!!(${expression})`);
        if (last) return true;
      } catch (e) {
        last = e.message;
      }
      await sleep(poll);
    }
    throw new Error(`waitForFunction timed out after ${timeout}ms: ${expression}`);
  }

  waitForSelector(selector, opts) {
    return this.waitForFunction(`document.querySelector(${JSON.stringify(selector)})`, opts);
  }

  /**
   * CSS-pixel bounding box of the first match, in DOCUMENT coordinates, or null.
   *
   * The scroll offsets are load-bearing. getBoundingClientRect() is viewport-relative, but CDP's
   * screenshot `clip` is a document-space offset — the two agree only while the page is scrolled to
   * the top. Today `body { overflow: hidden }` pins that at 0, so dropping the offsets would appear
   * to work and then silently crop the wrong region the first time a surface is reached with the
   * document scrolled (a scrollable dialog host, a layout change). A wrong-but-stable crop is worse
   * than a crash in a measuring instrument, because nothing about it looks broken. (roborev 54701)
   */
  async boundingBox(selector) {
    return this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        x: r.x + window.scrollX,
        y: r.y + window.scrollY,
        width: r.width,
        height: r.height,
      };
    })()`);
  }

  /**
   * PNG bytes. `clip` is in CSS pixels.
   *
   * clip.scale is 1, NOT the deviceScaleFactor. Emulation.setDeviceMetricsOverride already applies
   * the DSF to the raster, and clip.scale multiplies ON TOP of it — passing the DSF here produced
   * crops at 4× (a 220×933 sidebar came out 880×3732) while full-viewport shots were correctly 2×,
   * so cropped and uncropped surfaces silently disagreed about pixel density.
   */
  async screenshot({ clip } = {}) {
    const params = { format: "png", fromSurface: true, captureBeyondViewport: false };
    if (clip) {
      params.clip = {
        // Round to whole CSS pixels: a fractional clip makes Chrome resample, and a resampled
        // edge is exactly the kind of 1px churn that makes a diff percentage meaningless.
        x: Math.round(clip.x),
        y: Math.round(clip.y),
        width: Math.round(clip.width),
        height: Math.round(clip.height),
        scale: 1,
      };
    }
    const r = await this.send("Page.captureScreenshot", params);
    return Buffer.from(r.data, "base64");
  }
}

/** A launched Chrome plus its lifetime. Always close it in a `finally`. */
export class Browser {
  constructor(proc, conn, userDataDir) {
    this.proc = proc;
    this.conn = conn;
    this.userDataDir = userDataDir;
  }

  async newPage() {
    const { targetId } = await this.conn.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await this.conn.send("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    const page = new Page(this.conn, sessionId);
    await page.send("Page.enable", {});
    await page.send("Runtime.enable", {});
    return page;
  }

  async close() {
    // Bounded, because a graceful Browser.close can neither resolve nor reject: Chrome tears the
    // websocket down as it exits, and if the socket dies without firing `close` the pending request
    // is never settled and the process hangs after all the work is done. The SIGKILL below is the
    // real guarantee; this is only the polite first ask.
    try {
      await Promise.race([
        this.conn.send("Browser.close"),
        new Promise((r) => setTimeout(r, 2000)),
      ]);
    } catch {
      /* the browser may already be gone */
    }
    this.conn.close();
    if (this.proc?.pid) {
      try {
        process.kill(this.proc.pid, "SIGKILL");
      } catch {
        /* already exited */
      }
    }
    if (this.userDataDir) {
      try {
        rmSync(this.userDataDir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }
}

export async function launch({ width = 1440, height = 900 } = {}) {
  const port = await getFreePort();
  const userDataDir = mkdtempSync(join(tmpdir(), "sparkle-visual-"));
  const proc = spawn(CHROME_PATH, chromeFlags({ port, userDataDir, width, height }), {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  proc.stderr.on("data", (d) => {
    stderr += d;
  });
  proc.on("error", (e) => {
    stderr += `\nfailed to spawn ${CHROME_PATH}: ${e.message}`;
  });
  let wsUrl;
  try {
    wsUrl = await waitForDebugger(port, 30000);
  } catch (e) {
    try {
      process.kill(proc.pid, "SIGKILL");
    } catch {
      /* nothing to kill */
    }
    rmSync(userDataDir, { recursive: true, force: true });
    throw new Error(`${e.message}\nChrome stderr:\n${stderr.slice(0, 2000)}`);
  }
  const conn = await connect(wsUrl);
  return new Browser(proc, conn, userDataDir);
}
