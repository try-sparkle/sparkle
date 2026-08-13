// Frontend logging that funnels UI activity into the SAME file as the Rust backend
// (see src-tauri/src/logging.rs). The goal is a single, verbose, time-ordered log we can
// hand to a developer (or Claude) to reconstruct exactly what the app did.
//
// Three sources feed it:
//   1. console.* — patched so existing console.log/warn/error calls are captured for free.
//   2. log.info/warn/error/debug — explicit, scoped app-action logging (preferred for new code).
//   3. window error + unhandledrejection — so crashes/unawaited rejections are never silent.
//
// Each record is shipped to Rust via the `frontend_log` command. Shipping is best-effort:
// outside a Tauri webview (e.g. a plain browser) invoke throws and we silently no-op.

import { invoke } from "./services/ipc";

type Level = "debug" | "info" | "warn" | "error";

// Hold the real console methods BEFORE we patch them, so forwarding (and our own patch)
// can still print without recursing back into the forwarder.
const realConsole = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: console.debug.bind(console),
};

// Reentrancy guard: if invoke() ever logs to console on failure, we must not re-forward.
let forwarding = false;

// Whether DEBUG-level lines are forwarded to the persistent log file. Default: ON in dev, OFF in
// production builds. On hot paths (suggestions compute, auto-approve decisions, per-event
// console.debug across dozens of agents) debug fired thousands of times/day, and EACH forward pays
// a render() (JSON.stringify) plus a synchronous `frontend_log` IPC → disk write on the JS main
// thread — measured at 87–121 MB/day and contributing to main-thread jank at scale. info/warn/error
// always forward. A support capture can flip this on at runtime via setDebugForwarding(true); the
// devtools console still shows every debug line regardless (that costs nothing on disk).
let debugForwardEnabled = Boolean(import.meta.env.DEV);

/** Enable/disable forwarding DEBUG lines to the persistent log (e.g. turn on for a support capture).
 *  NOTE: this flag is per-webview (module state), so a support-capture toggle must be applied in
 *  each window whose debug traffic should be captured (main + capture + worker webviews), or driven
 *  from a cross-window setting. info/warn/error forwarding is unaffected. */
export function setDebugForwarding(on: boolean): void {
  debugForwardEnabled = on;
}

// Known-benign, high-frequency messages emitted by third-party runtimes (not our code) that
// would otherwise flood the persistent log and bury real signal. These are still printed to the
// live console (devtools) via the real console methods; we just don't forward them to the log
// file. Match on a stable substring of each message.
//
//   - "[TAURI] Couldn't find callback id N": Tauri logs this once per in-flight IPC callback
//     whenever the webview reloads while Rust is mid-async-operation — thousands of lines per
//     reload — and it's harmless (Tauri transparently falls back).
//   - "webglcontextrestored event received": xterm's WebglAddon logs this (at WARN) every time a
//     lost GPU context comes BACK on its own — dozens per loss/restore burst under GPU pressure.
//     A successful auto-restore is pure good news that needs no action, yet at WARN it pollutes
//     the error-adjacent stream. We deliberately keep the addon's diagnostic siblings —
//     "webglcontextlost event received" (frequency = GPU-pressure signal) and "context not
//     restored; firing onContextLoss" (our DOM-renderer fallback actually engaged) — forwarded.
const LOG_FORWARD_DENYLIST = ["Couldn't find callback id", "webglcontextrestored event received"];

// Not every third-party flood can be denylisted whole: xterm's IdleTaskQueue warns whenever one
// of ITS OWN idle-callback tasks overruns its slice, and it carries the overrun in the message —
// so the line is noise at one magnitude and real signal at another. Over a recent eight-day
// window it fired 741 times, the top WARN by volume on most days, with a median overrun of 40ms
// and a p95 of 197ms — imperceptible slices whose only stated remedy ("split the task into
// sub-tasks") is addressed to xterm's maintainers, not to anything we can act on. But the tail
// reached ~2s, which is a freeze a user feels, so dropping the message wholesale would throw
// away the one shape of it worth keeping. Gate on the magnitude instead.
const XTERM_TASK_QUEUE_OVERRUN = /task queue exceeded allotted deadline by (\d+)ms/;

/** The overrun at which an xterm task-queue warning is worth a log line. Deliberately the same
 *  knee as `JANK_SEVERE_MS` in perfTrace.ts — that constant's reasoning (a sub-second stall is a
 *  dropped frame, and dropped frames matter as a RATE, not as individual lines) applies verbatim
 *  here, and the two instruments describe the same main-thread freeze, so they should agree on
 *  what counts as perceptible. Kept as a local copy rather than an import: perfTrace imports
 *  `log` from this module, so reaching back the other way would close an import cycle. */
const PERCEPTIBLE_STALL_MS = 1_000;

/** True for an xterm task-queue overrun too short for the user to perceive (see above). A
 *  non-matching message is never suppressed here, so this can only ever narrow that one line. */
function isSubPerceptibleTaskQueueOverrun(message: string): boolean {
  const m = XTERM_TASK_QUEUE_OVERRUN.exec(message);
  return m !== null && Number(m[1]) < PERCEPTIBLE_STALL_MS;
}

/** Whether an auto-captured console line should be forwarded to the persistent log. */
export function shouldForwardConsole(message: string): boolean {
  if (LOG_FORWARD_DENYLIST.some((needle) => message.includes(needle))) return false;
  return !isSubPerceptibleTaskQueueOverrun(message);
}

// Rejection signatures that originate INSIDE Tauri's own injected runtime, not our code, and
// that we cannot .catch at the source because we never hold the promise. The event-dispatch
// script reads `listeners[eventId].handlerId` to route a backend-emitted event; during a
// webview-reload/teardown race the listener slot is already gone, so it throws on undefined and
// surfaces on the global unhandledrejection handler. It's benign (the listener is simply gone /
// Tauri recovers), so it's logged at debug instead of ERROR to keep the error stream meaningful.
// Match on a stable substring of the source expression. Deliberately narrow — generic failures
// like "Load failed" can be real app bugs and must keep logging at ERROR.
const BENIGN_REJECTION_SIGNATURES = ["listeners[eventId].handlerId"];

/** Whether an unhandled rejection is known-benign Tauri-internal teardown noise (→ debug, not error). */
export function isBenignTauriRejection(message: string): boolean {
  return BENIGN_REJECTION_SIGNATURES.some((needle) => message.includes(needle));
}

// xterm's renderer throws a transient `undefined is not an object` from inside its OWN
// requestAnimationFrame render pass (and its teardown) whenever the buffer, the renderer, or a
// buffer line is momentarily undefined during a resize / reflow / scrollback-trim / dispose — bead
// sparkle-uhne8. One day's log showed the SAME family under four vendor symbols, all in the
// vendor-xterm render path:
//   · `a.loadCell`  (281x) — the WebGL renderer's _updateModel reads `buffer.lines.get(row+ydisp)`
//     with no null check and calls loadCell on the (undefined) line;
//   · `d.getWidth` / `d.setCellFromCodepoint` — sibling cell/model accesses in that same glyph pass;
//   · `this._renderer.value.dimensions` — the RenderService `dimensions` getter, read by internal
//     mouse/selection/IntersectionObserver callbacks AFTER the renderer is disposed.
// The render-pass subset is prevented at the source by the RenderService._renderRows wrapper in
// components/terminalRenderGuard.ts (installed per-terminal). This is the escape-boundary NET for the
// rest: these throws originate in vendor rAF/event callbacks we never hold and so cannot try/catch at
// the source, they reach `window.onerror`, and they are transient and self-healing (the next frame
// repaints, or the pane is being torn down anyway). So we log them at debug rather than flooding the
// ERROR stream — exactly the treatment isBenignTauriRejection gives the analogous Tauri teardown race.
//
// Deliberately narrow: the message (which carries the error's stack) must reference the vendored
// xterm bundle AND be an undefined/null access, so a genuine app TypeError — or a real, actionable
// xterm error that is NOT an undefined access — still logs at ERROR. Both WebKit ("undefined is not
// an object") and Chromium ("Cannot read properties of undefined") phrasings are covered.
const XTERM_BUNDLE_SIGNATURE = /vendor-xterm|@xterm\//;
const UNDEFINED_ACCESS_SIGNATURE =
  /undefined is not an object|null is not an object|Cannot read properties of (?:undefined|null)/;

/** Whether an uncaught window error is a transient xterm render/teardown undefined-access (→ debug,
 *  not error). Covers the whole `a.loadCell` / `dimensions` / `getWidth` / `setCellFromCodepoint`
 *  family without keying on any single symbol. */
export function isTransientXtermRenderError(message: string): boolean {
  return XTERM_BUNDLE_SIGNATURE.test(message) && UNDEFINED_ACCESS_SIGNATURE.test(message);
}

function forward(level: Level, scope: string, message: string) {
  if (forwarding) return;
  forwarding = true;
  try {
    void invoke("frontend_log", { entry: { level, scope, message } }).catch(() => {
      /* not in a Tauri webview, or command unavailable — drop silently */
    });
  } catch {
    /* invoke unavailable (non-Tauri context) — drop silently */
  } finally {
    forwarding = false;
  }
}

/** Render arbitrary console/log args into one readable line. */
function render(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === "string") return a;
      if (a instanceof Error) return `${a.name}: ${a.message}${a.stack ? `\n${a.stack}` : ""}`;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");
}

/** Scoped, explicit logging — prefer this in new code: `log.info("composer", "sent prompt", {len})`. */
export const log = {
  debug: (scope: string, message: string, data?: unknown) => emit("debug", scope, message, data),
  info: (scope: string, message: string, data?: unknown) => emit("info", scope, message, data),
  warn: (scope: string, message: string, data?: unknown) => emit("warn", scope, message, data),
  error: (scope: string, message: string, data?: unknown) => emit("error", scope, message, data),
};

function emit(level: Level, scope: string, message: string, data?: unknown) {
  // Skip the whole render+forward for debug lines when debug forwarding is off — this is the hot
  // path (log.debug on suggestions/approvals/etc.). Still print to the live devtools console cheaply.
  if (level === "debug" && !debugForwardEnabled) {
    realConsole.debug(`[${scope}]`, message, data);
    return;
  }
  const line = data === undefined ? message : `${message} ${render([data])}`;
  realConsole[level === "debug" ? "debug" : level === "info" ? "info" : level]?.(`[${scope}]`, line);
  forward(level, scope, line);
}

/** Patch console.* so legacy console calls are mirrored into the log file. Idempotent. */
let installed = false;
export function initLogger() {
  if (installed) return;
  installed = true;

  const patch = (name: "log" | "info" | "warn" | "error" | "debug", level: Level) => {
    console[name] = (...args: unknown[]) => {
      realConsole[name](...args);
      // console.debug is a hot path; when debug forwarding is off, skip render() + forward entirely
      // (the line was already printed to devtools above).
      if (level === "debug" && !debugForwardEnabled) return;
      const line = render(args);
      // Drop known-benign Tauri-internal noise from the log file (still printed above).
      if (shouldForwardConsole(line)) forward(level, "console", line);
    };
  };
  patch("log", "info");
  patch("info", "info");
  patch("warn", "warn");
  patch("error", "error");
  patch("debug", "debug");

  // Uncaught errors and unhandled promise rejections — the bugs we most want in the log.
  window.addEventListener("error", (e) => {
    // Render the error (its stack included) FIRST, then classify: a transient xterm render/teardown
    // undefined-access is thrown from a vendor rAF/event callback we can't .catch at the source, is
    // benign and self-healing, and used to flood the ERROR stream 281x/day (bead sparkle-uhne8).
    // Downgrade that family to debug so the ERROR stream stays meaningful; everything else stays ERROR.
    const message = e.error ? render([e.error]) : `${e.message} (${e.filename}:${e.lineno})`;
    forward(isTransientXtermRenderError(message) ? "debug" : "error", "window", message);
  });
  window.addEventListener("unhandledrejection", (e) => {
    const message = `Unhandled rejection: ${render([e.reason])}`;
    // Known-benign Tauri-internal teardown races can't be .catch'd at the source; log them at
    // debug so they stay out of the ERROR stream (still captured for investigation).
    forward(isBenignTauriRejection(message) ? "debug" : "error", "promise", message);
  });

  log.info("app", "frontend logger initialized");
}

// ── Status-bar helpers ────────────────────────────────────────────────────────

/** The app version, for the bottom-left status bar. */
export function getAppVersion(): Promise<string> {
  return invoke<string>("app_version");
}

/** Absolute path to the log directory (shown on hover). */
export function getLogDir(): Promise<string> {
  return invoke<string>("log_dir");
}

/** Open the log directory in Finder ("Show logs"). */
export function revealLogs(): Promise<void> {
  return invoke("reveal_logs");
}
