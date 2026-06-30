import ReactDOM from "react-dom/client";
import { App } from "./App";
import { TrayApp } from "./tray/TrayApp";
import { initLogger } from "./logger";
import { initAnalytics } from "./analytics";
import { resolveThemeFromStorage } from "./theme/theme";
import { useHistoryStore } from "./stores/historyStore";
import "@xterm/xterm/css/xterm.css";
import "./index.css";

// Set <html data-theme> synchronously, before first paint, from the persisted preference —
// otherwise a user who chose Light would see a flash of the default dark theme on launch.
// resolveThemeFromStorage parses the same zustand `sparkle-ui` envelope the store hydrates.
document.documentElement.dataset.theme = resolveThemeFromStorage(localStorage.getItem("sparkle-ui"));

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
