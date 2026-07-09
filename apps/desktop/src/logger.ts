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

import { invoke } from "@tauri-apps/api/core";

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

/** Whether an auto-captured console line should be forwarded to the persistent log. */
export function shouldForwardConsole(message: string): boolean {
  return !LOG_FORWARD_DENYLIST.some((needle) => message.includes(needle));
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
    forward("error", "window", e.error ? render([e.error]) : `${e.message} (${e.filename}:${e.lineno})`);
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
