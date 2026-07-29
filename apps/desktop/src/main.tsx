import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { App } from "./App";
import { HelperApp } from "./helper/HelperApp";
import { CaptureApp } from "./capture/CaptureApp";
import { SatelliteApp } from "./satellite/SatelliteApp";
import { freezeUiPersistence } from "./satellite/uiPersistence";
import { ErrorBoundary, AppErrorFallback } from "./components/ErrorBoundary";
import { initLogger } from "./logger";
import { startJankMonitor, installPerfDevtools } from "./perfTrace";
import { initAnalytics } from "./analytics";
import { usageTelemetry } from "./services/usageTelemetry";
import { flushCrashReports } from "./services/crashReporter";
import { disableNativeTooltips } from "./disableNativeTooltips";
import { resolveThemeFromStorage } from "./theme/theme";
import { applyVisualFixtures } from "./dev/visualFixtures";
import { useHistoryStore } from "./stores/historyStore";
import { refreshModelCatalog } from "./services/models";
import {
  parseSatelliteProjectId,
  parseSuppressSelfFocus,
  parseViewFromSearch,
  isAppWindowSearch,
} from "./services/windowIdentity";
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
//
// PARSED BY services/windowIdentity, not by hand, and the boot gates below are POSITIVE
// (`if (isAppWindow)`) rather than a `!isCapture && !isHelper` denylist. The denylist was an
// allowlist of two negatives, so every view kind added afterwards inherited the app window's boot
// work by default. That went wrong the moment Rust could mint `?view=project&project=<id>`
// (project_window.rs): a satellite fell through every guard and would have started a second jank
// monitor, installed perf devtools, opened a phantom PostHog session with an APP_OPENED per
// tear-off, started its own 24h history-prune interval against the same store, and double-counted
// the launch in usage telemetry. `isAppWindowSearch` keys on `?view=` being ABSENT — the app
// window's URL is a bare index.html from tauri.conf.json — so a new view kind is now excluded by
// default and adding one in Rust cannot outrun the TypeScript.
const search = window.location.search;
const view = parseViewFromSearch(search);
const isCapture = view === "capture";
// The floating helper island: another tiny, always-alive webview.
const isHelper = view === "helper";
const isAppWindow = isAppWindowSearch(search);
// A torn-out project tab (src-tauri/src/project_window.rs). Returns the PROJECT ID, not a boolean,
// so a `?view=project` with no project is `null` and falls through to <App/> rather than mounting a
// satellite with nothing to render — see parseSatelliteProjectId's note on why the pair is asserted
// in one place.
const satelliteProjectId = parseSatelliteProjectId(search);

// Main-thread stall detector (perfTrace): logs every frame gap > threshold as a "jank stall" so a
// reproduction of the slowness surfaces exactly when the app froze and for how long, to correlate
// against the spawn/switch/close/render lines. Only in the real app view — the hidden capture and
// the tiny capture/helper webviews aren't where the slowness lives and would just add noise.
//
// No label is passed: the shell is single-window, so the only webview that runs a monitor is the app
// window, whose Tauri label is exactly `startJankMonitor`'s "main" default (see its doc for why the
// field is stamped at all). Reading `getCurrentWindow().label` here would compute that same constant
// at module scope, before createRoot — where a malformed `__TAURI_INTERNALS__` would throw and blank
// the app. If secondary app windows ever return, pass their label in; nothing else needs to change.
if (isAppWindow) startJankMonitor();

// Render counting is always on (a Map bump); the per-render LOG is gated off by default because
// each line is a main-thread Tauri IPC (bead sparkle-abv2). This exposes the toggle and the
// counters so `sparklePerf.counts()` / `sparklePerf.setRenderLogging(true)` work from devtools.
if (isAppWindow) installPerfDevtools();

// Analytics (PostHog) — masked session replay + autocapture + lifecycle events.
// No-ops when no key is configured. Started after the logger so init errors surface.
// Skipped in the capture and helper webviews: both are created hidden at every launch and would
// add a phantom PostHog session + APP_OPENED per boot.
if (isAppWindow) initAnalytics();

// Enforce the history retention window: read the active tier, prune once on launch, then once a
// day. Best-effort — a failure here (e.g. backend not ready) must not block the UI from rendering.
// Also skipped in the always-alive hidden capture/helper webviews — main already prunes.
const HISTORY_PRUNE_INTERVAL_MS = 86_400_000; // 24h
if (isAppWindow) {
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

// Seed the visual-fidelity harness's deterministic fixtures (scripts/visual/, dev/visualFixtures).
// Runs BEFORE createRoot so the first render already has the roster — a fixture that lands after
// mount would make the capture race the seed. Doubly inert outside a dev serve: the branch is
// `import.meta.env.DEV` (statically false in a `vite build`, so Rollup drops the call and, with it,
// the side-effect-free module), and applyVisualFixtures itself re-checks the auth-bypass flag and
// the `?visual=1` parameter before writing anything.
if (import.meta.env.DEV) applyVisualFixtures(search);

// NOTE: no React.StrictMode — its double-invoke of effects would spawn each agent's PTY
// twice (one would leak). Each AgentPane owns a single live PTY.
// The capture takeover is a dark surface by design (spec §3 approved mockup): pin the dark
// theme in that webview so reused themed components (LogoWaveform) stay legible on the navy
// card even when the app preference is Light.
if (isCapture) document.documentElement.dataset.theme = "dark";
// The helper island is a transparent window (see helper.rs). index.css paints `body` with the
// opaque app background, which would fill the window's rounded corners with a square block of
// navy — so clear it here. The island's own pill draws the only visible surface. Dark is pinned
// for the same reason the capture takeover pins it: the pill is a dark chip regardless of the
// app's light/dark preference.
if (isHelper) {
  document.documentElement.dataset.theme = "dark";
  document.body.style.background = "transparent";
}
// A satellite inherits the user's persisted UI preferences but must never write `sparkle-ui` back —
// that blob is the MAIN window's, and zustand republishes the whole partialized state on every
// change (see satellite/uiPersistence for the clobber this prevents). Must run before the tree
// mounts, since the sidebar writes uiStore as soon as it renders.
if (satelliteProjectId) freezeUiPersistence();

// Wrap the main app root in a top-level ErrorBoundary so an uncaught render exception degrades to a
// recoverable "Something broke — Reload UI" card (with a Report path into the existing support/crash
// pipeline) instead of unmounting the whole tree into a blank window. The helper and capture
// webviews are tiny, single-purpose surfaces — left unwrapped so their minimal render paths stay
// untouched.
//
// The SATELLITE (`?view=project&project=<id>`) IS wrapped: it is a full workspace column pair with
// agent panes in it, so an uncaught render exception there deserves the same recoverable card the
// main window gets rather than a blank second monitor. It resolves its own pool label (INSIDE the
// boundary — reading `getCurrentWindow().label` at module scope is what the jank-monitor note above
// refuses to do, because a malformed `__TAURI_INTERNALS__` would throw before createRoot and blank
// the window with no card to recover from).
ReactDOM.createRoot(document.getElementById("root")!).render(
  isHelper ? (
    <HelperApp />
  ) : isCapture ? (
    <CaptureApp />
  ) : satelliteProjectId ? (
    <ErrorBoundary scope="app-root" fallback={(p) => <AppErrorFallback {...p} />}>
      <SatelliteApp projectId={satelliteProjectId} />
    </ErrorBoundary>
  ) : (
    <ErrorBoundary scope="app-root" fallback={(p) => <AppErrorFallback {...p} />}>
      <App />
    </ErrorBoundary>
  ),
);

// Warm the per-agent model catalog from the user's BYOK Anthropic key (Phase 2, sparkle-i6rw).
// Fire-and-forget: refreshModelCatalog swallows every failure (no host/key/network → the curated
// list stands), and the ModelPill re-renders in place when fresh models land. Main webview only —
// the helper island never shows a model picker.
//
// This gate was `!isHelper`, which contradicted the "main webview only" it claims: the capture
// webview ran the refresh too, and a satellite would have as well. Now says what it meant.
if (isAppWindow) {
  void refreshModelCatalog();
}

// Anonymous usage telemetry → orchestration (AARRR funnel, task #4). Emit 'app_open' + open a
// session on launch, and close it on quit/reload. Best-effort and fire-and-forget: the service
// swallows every error, and no-ops when no install_id is resolvable (plain-browser dev/preview,
// where the Tauri trial command is absent). Only the main webview counts — the helper shares the
// same install and would otherwise double-count launches (the capture webview likewise).
if (isAppWindow) {
  void usageTelemetry.trackAppOpen();
  // beforeunload is the pragmatic best-effort "app closing" hook in the webview (reload/close).
  // A dropped session_end is acceptable — the server can also reap stale sessions.
  window.addEventListener("beforeunload", () => {
    void usageTelemetry.trackSessionEnd();
  });
  // Flush any crash reports captured on a previous run (panic hook / native fatal-signal handler in
  // Rust). Fire-and-forget: Rust enforces the consent gate (uploads only on "always"; otherwise the
  // reports stay on the user's disk). Main webview only — the helper/capture views share the install.
  void flushCrashReports();
}

// Show-on-ready (bead sparkle-alrm.5, #10). The main window is created hidden ("visible": false
// in tauri.conf.json) so the user never sees a blank OS frame before React paints. Reveal it once
// the first meaningful paint has landed (theme is already resolved synchronously above; the root
// has rendered). The helper webview manages its own visibility, so skip it — and the capture
// webview MUST be skipped: it is created hidden and only ever shown by Rust's
// show_capture_window; a boot-time self-show would flash the takeover at launch. The
// `__TAURI_INTERNALS__` guard no-ops in the plain-browser dev/preview (no OS window to show).
// A satellite is excluded because Rust builds it with `.visible(true)` and positions it at build
// time (project_window.rs) — it is already on screen, so there is nothing here to reveal.
if (isAppWindow && "__TAURI_INTERNALS__" in window) {
  // A restored, non-active window (`?focus=0`) must be SHOWN but not self-focused: session restore
  // reopens several windows at once and focuses exactly one — the last-active — which the restore
  // orchestrator sets explicitly. Without this, whichever restored window paints last would steal
  // focus. All normally-opened windows (no param) still self-focus.
  const suppressFocus = parseSuppressSelfFocus(window.location.search);
  const show = () => {
    const w = getCurrentWindow();
    void w
      .show()
      .then(() => (suppressFocus ? undefined : w.setFocus()))
      // Tell the Rust show-on-ready backstop the frontend completed its first show, so its 8s
      // last-resort net won't re-reveal a window the user may have since hidden. Chained
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
