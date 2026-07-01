import { useEffect } from "react";
import { Workspace } from "./components/Workspace";
import { AuthGate } from "./components/AuthGate";
import { useAmbientVoice } from "./useDictation";
import { useApplyTheme } from "./theme/theme";
import { useConnectionMonitor } from "./connectionMonitor";
import { resolveEnvChiefPat } from "./services/chief";
import { healAgentHooks } from "./services/worktree";
import { importDefault } from "./services/accountStore";
import { startRelayHost, stopRelayHost } from "./services/relayClient";
import { useSettingsStore } from "./stores/settingsStore";
import { getConfig, onConfigChanged } from "./services/config";
import { safeUnlisten } from "./services/safeUnlisten";
import { CurrentProjectProvider } from "./windowContext";
import { useAttentionNotifications } from "./useAttentionNotifications";
import { useRosterPublisher } from "./useRosterPublisher";
import { UpdateBanner } from "./components/UpdateBanner";
import { HintOverlay } from "./components/HintOverlay";
import { startUpdater } from "./services/updaterService";

// Owns the dock badge + Notification Center banners + click-to-worker routing. Rendered inside
// the provider (it reads this window's current project) and paints no UI of its own.
function AttentionController() {
  useAttentionNotifications();
  return null;
}

// Publishes the live agent roster to the paired phone + the tray aggregator. MUST be rendered
// INSIDE CurrentProjectProvider: useRosterPublisher → useCurrentWindowLabel → useCtx(), which
// throws "must be used within CurrentProjectProvider" if run in App's body (App renders the
// provider as a child, so the body is outside it). Mounted as a sibling of AuthGate so it runs
// regardless of auth/loading state, matching its prior always-on behavior. Paints no UI.
function RosterPublisher() {
  useRosterPublisher();
  return null;
}

export function App() {
  // Single writer of <html data-theme> for the whole app (owns the matchMedia subscription).
  useApplyTheme();
  // Watches connectivity: drives the offline banner and re-queries agents on reconnect.
  useConnectionMonitor();
  // App-level always-listening voice controller (mounted once).
  useAmbientVoice();
  // NOTE: roster publishing moved into <RosterPublisher/> (inside the provider) — it depends on
  // useCurrentWindowLabel(), which throws if called here in App's body (outside the provider).

  // Phone approvals remote: open the relay host connection (no-op if signed out) so a local
  // agent's "needs you" can reach the paired phone, and a phone decision can drive the PTY.
  useEffect(() => {
    void startRelayHost().catch((e) => console.warn("startRelayHost failed", e));
    return () => stopRelayHost();
  }, []);

  // Seed the Chief PAT from the user's environment (.env.local) at launch so the Think
  // agent works without pasting a token. Resolved in Rust (never baked into the bundle); set
  // unconditionally — including "" — so a removed env token doesn't leave a stale value.
  useEffect(() => {
    void resolveEnvChiefPat().then((pat) =>
      useSettingsStore.getState().setRuntimeChiefPat(pat),
    );
  }, []);

  // Multi Claude Max account support: ensure account #1 (the existing ~/.claude) always exists, so
  // selection has a default to fall back to. Idempotent on the Rust side — a no-op once imported.
  useEffect(() => {
    void importDefault().catch((e) => console.warn("importDefault failed", e));
  }, []);

  // Self-heal agent worktrees whose Claude Code hook scripts (status emitter + write-guard) point
  // at an old/renamed/removed app bundle — otherwise every hook for those agents errors with
  // MODULE_NOT_FOUND and the lost write-guard silently un-confines the worktree. Re-points them at
  // a stable app-data copy. Idempotent: a no-op once everything already points there.
  useEffect(() => {
    void healAgentHooks()
      .then((n) => {
        if (n > 0) console.info(`healed stale hook paths in ${n} worktree(s)`);
      })
      .catch((e) => console.warn("healAgentHooks failed", e));
  }, []);

  // Auto-updater: poll the signed GitHub Releases manifest at launch + every 6h. No-ops in dev /
  // the browser preview / when unpackaged (the plugin + manifest only exist in a real build).
  useEffect(() => startUpdater(), []);

  // Editable config file: hydrate the settings store from config.toml at launch and on every
  // live-reload (hand-edit / in-app write / reset). The file is the source of truth; this is the
  // read side. Handler is idempotent (re-pulls), so the expected double config-changed emit on an
  // in-app write is harmless.
  // SCOPE: the UI mirror reflects the GLOBAL layer (no project root passed). That's correct — the
  // mirrored controls are [workers]/[ai], which are global-only by design; per-project [workflow]
  // overrides are honored by the Rust engine directly (config::for_project), not via this mirror.
  useEffect(() => {
    let cancelled = false;
    const hydrate = useSettingsStore.getState().hydrateFromConfig;
    void getConfig()
      .then((eff) => {
        if (!cancelled) hydrate(eff);
      })
      .catch((e) => console.warn("getConfig failed", e));
    // Keep the listen() promise; safeUnlisten awaits it on cleanup so a listener that resolves
    // AFTER unmount is still torn down (and the Tauri teardown race is swallowed).
    const unlistenPromise = onConfigChanged(hydrate);
    return () => {
      cancelled = true;
      void safeUnlisten(unlistenPromise);
    };
  }, []);

  return (
    <CurrentProjectProvider>
      <RosterPublisher />
      <AuthGate>
        <AttentionController />
        <UpdateBanner />
        <Workspace />
        {/* Vimium-style keyboard hints: a clean ⌘ tap overlays gold chiclets on the primary
            controls. Mounted last so its portal sits above the whole UI. */}
        <HintOverlay />
      </AuthGate>
    </CurrentProjectProvider>
  );
}
