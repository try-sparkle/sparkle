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
import { CurrentProjectProvider } from "./windowContext";
import { useAttentionNotifications } from "./useAttentionNotifications";
import { useRosterPublisher } from "./useRosterPublisher";

// Owns the dock badge + Notification Center banners + click-to-worker routing. Rendered inside
// the provider (it reads this window's current project) and paints no UI of its own.
function AttentionController() {
  useAttentionNotifications();
  return null;
}

export function App() {
  // Single writer of <html data-theme> for the whole app (owns the matchMedia subscription).
  useApplyTheme();
  // Watches connectivity: drives the offline banner and re-queries agents on reconnect.
  useConnectionMonitor();
  // App-level always-listening voice controller (mounted once).
  useAmbientVoice();
  // Publish the live agent roster to the paired phone (the mobile dashboard mirror).
  useRosterPublisher();

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

  return (
    <CurrentProjectProvider>
      <AuthGate>
        <AttentionController />
        <Workspace />
      </AuthGate>
    </CurrentProjectProvider>
  );
}
