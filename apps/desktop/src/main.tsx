import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { App } from "./App";
import { TrayApp } from "./tray/TrayApp";
import { CaptureApp } from "./capture/CaptureApp";
import { initLogger } from "./logger";
import { startJankMonitor } from "./perfTrace";
import { initAnalytics } from "./analytics";
import { usageTelemetry } from "./services/usageTelemetry";
import { disableNativeTooltips } from "./disableNativeTooltips";
import { resolveThemeFromStorage } from "./theme/theme";
import { useHistoryStore } from "./stores/historyStore";
import { refreshModelCatalog } from "./services/models";
import "@xterm/xterm/css/xterm.css";
import "./index.css";

// Set <html data-theme> synchronously, before first paint, from the persisted preference —
// otherwise a user who chose Light would see a flash of the default dark theme on launch.
// resolveThemeFromStorage parses the same zustand `sparkle-ui` envelope the store hydrates.
document.documentElement.dataset.theme = resolveThemeFromStorage(localStorage.getItem("sparkle-ui"));

// Turn off native `title=` tooltips app-wide (see disableNativeTooltips). The styled <Tooltip>
// hover card is disabled separately in its own component.
disableNativeTooltips();

// Stand up unified logging first so console.* calls and errors during render are captured.
initLogger();

// Which webview this is (parsed before the boot side effects below, which gate on it).
const view = new URLSearchParams(window.location.search).get("view");
const isTray = view === "tray";
const isCapture = view === "capture";

// Main-thread stall detector (perfTrace): logs every frame gap > threshold as a "jank stall" so a
// reproduction of the slowness surfaces exactly when the app froze and for how long, to correlate
// against the spawn/switch/close/render lines. Only in the real app view — the hidden capture and
// the tiny tray webviews aren't where the slowness lives and would just add noise.
if (!isTray && !isCapture) startJankMonitor();

// Analytics (PostHog) — masked session replay + autocapture + lifecycle events.
// No-ops when no key is configured. Started after the logger so init errors surface.
// Skipped in the capture webview: it is created hidden at every launch and would add a
// phantom PostHog session + APP_OPENED per boot (the tray predates this and is left as-is).
if (!isCapture) initAnalytics();

// Enforce the history retention window: read the active tier, prune once on launch, then once a
// day. Best-effort — a failure here (e.g. backend not ready) must not block the UI from rendering.
// Also skipped in the always-alive hidden capture webview — main/tray already prune.
const HISTORY_PRUNE_INTERVAL_MS = 86_400_000; // 24h
if (!isCapture) {
  void (async () => {
    try {
      await useHistoryStore.getState().loadEntitlement();
      await useHistoryStore.getState().prune();
    } catch {
      // Retention is best-effort; ignore and let the next daily tick try again.
    }
  })();
  setInterval(() => {
    void useHistoryStore.getState().prune();
  }, HISTORY_PRUNE_INTERVAL_MS);
}

// NOTE: no React.StrictMode — its double-invoke of effects would spawn each agent's PTY
// twice (one would leak). Each AgentPane owns a single live PTY.
// The capture takeover is a dark surface by design (spec §3 approved mockup): pin the dark
// theme in that webview so reused themed components (LogoWaveform) stay legible on the navy
// card even when the app preference is Light.
if (isCapture) document.documentElement.dataset.theme = "dark";
ReactDOM.createRoot(document.getElementById("root")!).render(
  isTray ? <TrayApp /> : isCapture ? <CaptureApp /> : <App />,
);

// Warm the per-agent model catalog from the user's BYOK Anthropic key (Phase 2, sparkle-i6rw).
// Fire-and-forget: refreshModelCatalog swallows every failure (no host/key/network → the curated
// list stands), and the ModelPill re-renders in place when fresh models land. Main webview only —
// the tray never shows a model picker.
if (!isTray) {
  void refreshModelCatalog();
}

// Anonymous usage telemetry → orchestration (AARRR funnel, task #4). Emit 'app_open' + open a
// session on launch, and close it on quit/reload. Best-effort and fire-and-forget: the service
// swallows every error, and no-ops when no install_id is resolvable (plain-browser dev/preview,
// where the Tauri trial command is absent). Only the main webview counts — the tray shares the
// same install and would otherwise double-count launches (the capture webview likewise).
if (!isTray && !isCapture) {
  void usageTelemetry.trackAppOpen();
  // beforeunload is the pragmatic best-effort "app closing" hook in the webview (reload/close).
  // A dropped session_end is acceptable — the server can also reap stale sessions.
  window.addEventListener("beforeunload", () => {
    void usageTelemetry.trackSessionEnd();
  });
}

// Show-on-ready (bead sparkle-alrm.5, #10). The main window is created hidden ("visible": false
// in tauri.conf.json) so the user never sees a blank OS frame before React paints. Reveal it once
// the first meaningful paint has landed (theme is already resolved synchronously above; the root
// has rendered). The tray webview manages its own visibility, so skip it — and the capture
// webview MUST be skipped: it is created hidden and only ever shown by Rust's
// show_capture_window; a boot-time self-show would flash the takeover at launch. The
// `__TAURI_INTERNALS__` guard no-ops in the plain-browser dev/preview (no OS window to show).
if (!isTray && !isCapture && "__TAURI_INTERNALS__" in window) {
  const show = () => {
    const w = getCurrentWindow();
    void w
      .show()
      .then(() => w.setFocus())
      // Tell the Rust show-on-ready backstop the frontend completed its first show, so its 8s
      // last-resort net won't re-reveal a window the user may have since hidden to the tray. Chained
      // AFTER a successful show(): if show() rejects, the flag stays false and the backstop still
      // fires — otherwise a failed show would leave the window permanently hidden.
      .then(() => invoke("notify_frontend_shown"))
      .catch(() => {});
  };
  // Safety net: if the two rAFs are starved or a render throws after this point, never leave the
  // window permanently hidden — reveal it anyway after a short grace period. (Rust adds a second,
  // longer backstop for the case where this bundle never executes at all.)
  const safety = setTimeout(show, 3000);
  // Two rAFs = after React commits AND the browser has painted that commit.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      clearTimeout(safety);
      show();
    }),
  );
}
