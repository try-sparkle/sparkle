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
      forward(level, "console", render(args));
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
    forward("error", "promise", `Unhandled rejection: ${render([e.reason])}`);
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
