import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { App } from "./App";
import { TrayApp } from "./tray/TrayApp";
import { initLogger } from "./logger";
import { initAnalytics } from "./analytics";
import { disableNativeTooltips } from "./disableNativeTooltips";
import { resolveThemeFromStorage } from "./theme/theme";
import { useHistoryStore } from "./stores/historyStore";
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

// Analytics (PostHog) — masked session replay + autocapture + lifecycle events.
// No-ops when no key is configured. Started after the logger so init errors surface.
initAnalytics();

// Enforce the history retention window: read the active tier, prune once on launch, then once a
// day. Best-effort — a failure here (e.g. backend not ready) must not block the UI from rendering.
const HISTORY_PRUNE_INTERVAL_MS = 86_400_000; // 24h
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

// NOTE: no React.StrictMode — its double-invoke of effects would spawn each agent's PTY
// twice (one would leak). Each AgentPane owns a single live PTY.
const isTray = new URLSearchParams(window.location.search).get("view") === "tray";
ReactDOM.createRoot(document.getElementById("root")!).render(isTray ? <TrayApp /> : <App />);

// Show-on-ready (bead sparkle-alrm.5, #10). The main window is created hidden ("visible": false
// in tauri.conf.json) so the user never sees a blank OS frame before React paints. Reveal it once
// the first meaningful paint has landed (theme is already resolved synchronously above; the root
// has rendered). The tray webview manages its own visibility, so skip it. The `__TAURI_INTERNALS__`
// guard no-ops in the plain-browser dev/preview (no OS window to show).
if (!isTray && "__TAURI_INTERNALS__" in window) {
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
