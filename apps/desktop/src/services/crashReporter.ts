// Crash-report flush trigger — the frontend half of the desktop crash-capture vertical.
//
// Local crash capture (the Rust panic hook + native fatal-signal handler in src-tauri/src/crash.rs)
// is ALWAYS ON and writes crash records to the user's own disk. This service does the ONE thing the
// webview owns: on launch, ask Rust to flush any pending reports, passing the CURRENT Sparkle
// Improvement consent. Rust ENFORCES the gate — it only uploads (to the orchestration
// /telemetry/crash ingest) when consent === "always"; otherwise the reports stay local.
//
// Best-effort + fire-and-forget, exactly like usageTelemetry.trackAppOpen: never throws into the
// caller, no-ops outside the real Tauri webview (plain-browser dev/preview + unit tests, where the
// `flush_crash_reports` command is absent).

import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore } from "../stores/settingsStore";

/**
 * Flush pending crash reports at launch. Reads `sparkleImprovementConsent` from settingsStore and
 * passes it to the Rust `flush_crash_reports` command (which enforces the "always"-only upload gate).
 * Swallows every error — crash reporting must never disrupt app startup.
 */
export async function flushCrashReports(): Promise<void> {
  try {
    // Only inside the real Tauri webview — outside it (dev/preview, tests) there is no command.
    if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
    const consent = useSettingsStore.getState().sparkleImprovementConsent;
    await invoke("flush_crash_reports", { consent });
  } catch {
    // Best-effort: a failed flush is retried on the next launch.
  }
}
