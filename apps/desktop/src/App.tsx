import { lazy, Suspense, useEffect, useRef } from "react";
import { AuthGate } from "./components/AuthGate";
import { ReadinessGate } from "./components/ReadinessGate";
import { useAmbientVoice } from "./useDictation";
import { useApplyTheme } from "./theme/theme";
import { useConnectionMonitor } from "./connectionMonitor";
import { resolveEnvChiefPat } from "./services/chief";
import { healAgentHooks } from "./services/worktree";
import { importDefault } from "./services/accountStore";
import { startRelayHost, stopRelayHost } from "./services/relayClient";
import { useSettingsStore } from "./stores/settingsStore";
import { getConfig, onConfigChanged } from "./services/config";
import { refreshRoborevAuth } from "./services/configActions";
import { safeUnlisten } from "./services/safeUnlisten";
import {
  CurrentProjectProvider,
  useCurrentProjectId,
  useCurrentWindowLabel,
  useIsMainWindow,
  useReplaceCurrentProject,
} from "./windowContext";
import { LastFocusedProjectTracker } from "./capture/LastFocusedProjectTracker";
import { WindowSessionCapture } from "./WindowSessionCapture";
import { initCaptureSendListener, type CaptureSendCtx } from "./services/captureSends";
import { useAttentionNotifications } from "./useAttentionNotifications";
import { useRosterPublisher } from "./useRosterPublisher";
import { UpdateBanner } from "./components/UpdateBanner";
import { HintOverlay } from "./components/HintOverlay";
import { RoborevConsentModal } from "./components/RoborevConsentModal";
import { startUpdater } from "./services/updaterService";

// The Workspace subtree pulls in the heavy authenticated UI — xterm, markdown rendering, modals,
// the agent panes. Lazy-load it (code-split) so an unauthenticated / unpaid first-run user, who
// only ever sees AuthGate's sign-in / paywall, downloads and parses almost none of it. AuthGate and
// the sign-in/paywall path stay eager (imported directly) so the first screen paints immediately.
const Workspace = lazy(() =>
  import("./components/Workspace").then((m) => ({ default: m.Workspace })),
);

// Run non-critical launch work after first paint, when the main thread is idle. requestIdleCallback
// where available; setTimeout shim for WKWebView/Safari, which lack it. Keeps the boot-effect burst
// (relay socket, env resolution, default-account import, updater poll, worktree self-heal) off the
// critical path so config hydrate + first render aren't fighting all of them firing synchronously.
function onIdle(cb: () => void): void {
  const w = window as Window &
    typeof globalThis & { requestIdleCallback?: (cb: () => void) => number };
  if (typeof w.requestIdleCallback === "function") {
    w.requestIdleCallback(cb);
    return;
  }
  // WKWebView/Safari fallback: a bare setTimeout(cb, 1) can fire BEFORE first paint, so the deferred
  // boot burst would still race the initial render on the platform this most needs to help. rAF + a
  // 0ms timeout lands the callback after a frame has actually been committed.
  requestAnimationFrame(() => setTimeout(cb, 0));
}

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

// NOTE: LastFocusedProjectTracker lives in capture/LastFocusedProjectTracker.tsx (extracted
// with its own tests by the T3 worker); it must render inside CurrentProjectProvider.

// Mounts the capture://send listener once per window (spec §4/§5/§6). The capture modal
// broadcasts one payload to every window; this window's routing (ownership + main's stale-owner
// self-heal) decides whether to act, then dispatches Think/Build/Plan. MUST render inside
// CurrentProjectProvider — it needs this window's label/isMain/current project + `replace` (to
// adopt an orphan project). A ref feeds the listener FRESH context each event without re-mounting
// (the label/isMain are fixed; projectId changes as the user switches projects). Paints no UI.
function CaptureSendController() {
  const isMain = useIsMainWindow();
  const label = useCurrentWindowLabel();
  const projectId = useCurrentProjectId();
  const replace = useReplaceCurrentProject();
  const ctxRef = useRef<CaptureSendCtx>({ isMain, label, projectId, replace });
  ctxRef.current = { isMain, label, projectId, replace };
  useEffect(() => {
    const unlistenPromise = initCaptureSendListener(() => ctxRef.current);
    return () => void safeUnlisten(unlistenPromise);
  }, []);
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
  // Deferred to idle — it opens a socket.io WebSocket (and now lazy-loads the socket.io client),
  // which the first paint doesn't need. `cancelled` guards an unmount before the idle callback runs.
  useEffect(() => {
    let cancelled = false;
    onIdle(() => {
      if (cancelled) return;
      void startRelayHost().catch((e) => console.warn("startRelayHost failed", e));
    });
    return () => {
      cancelled = true;
      stopRelayHost();
    };
  }, []);

  // Seed the Chief PAT from the user's environment (.env.local) at launch so the Think
  // agent works without pasting a token. Resolved in Rust (never baked into the bundle); set
  // unconditionally — including "" — so a removed env token doesn't leave a stale value.
  // Deferred to idle: nothing on the first screen needs the Chief token.
  useEffect(() => {
    let cancelled = false;
    onIdle(() => {
      if (cancelled) return;
      void resolveEnvChiefPat().then((pat) =>
        useSettingsStore.getState().setRuntimeChiefPat(pat),
      );
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Multi Claude Max account support: ensure account #1 (the existing ~/.claude) always exists, so
  // selection has a default to fall back to. Idempotent on the Rust side — a no-op once imported.
  // Deferred to idle — account selection isn't touched during first paint.
  useEffect(() => {
    let cancelled = false;
    onIdle(() => {
      if (cancelled) return;
      void importDefault().catch((e) => console.warn("importDefault failed", e));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Self-heal agent worktrees whose Claude Code hook scripts (status emitter + write-guard) point
  // at an old/renamed/removed app bundle — otherwise every hook for those agents errors with
  // MODULE_NOT_FOUND and the lost write-guard silently un-confines the worktree. Re-points them at
  // a stable app-data copy. Idempotent: a no-op once everything already points there.
  // Pure self-heal maintenance — walks every agent worktree on disk — so it runs fully off the
  // critical path, deferred to idle after first paint.
  useEffect(() => {
    let cancelled = false;
    onIdle(() => {
      if (cancelled) return;
      void healAgentHooks()
        .then((n) => {
          if (n > 0) console.info(`healed stale hook paths in ${n} worktree(s)`);
        })
        .catch((e) => console.warn("healAgentHooks failed", e));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Auto-updater: poll the signed GitHub Releases manifest at launch + every 6h. No-ops in dev /
  // the browser preview / when unpackaged (the plugin + manifest only exist in a real build).
  // Deferred to idle — the update check is background work, not needed for first paint. `stop`
  // captures startUpdater's teardown so cleanup still tears down the poll if the effect unmounts.
  useEffect(() => {
    let cancelled = false;
    let stop: (() => void) | undefined;
    onIdle(() => {
      if (cancelled) return;
      stop = startUpdater();
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);

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
        if (cancelled) return;
        hydrate(eff);
        // Probe roborev's auth once the real flag is loaded. Must run AFTER hydrate (the store's
        // pre-hydrate default would decide it for us) and only matters when roborev is on — see
        // refreshRoborevAuth: the toggle defaults ON, so this launch path is the only thing that
        // checks a fresh install or a restart. Fire-and-forget: it must never delay first paint.
        void refreshRoborevAuth();
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
      <LastFocusedProjectTracker />
      <WindowSessionCapture />
      <CaptureSendController />
      {/* Proactive first-run readiness: walk a fresh user through git/node/claude + sign-in up
          front. Invisible for an already-ready machine (renders children immediately, probes in the
          background, only overlays the checklist when a prereq is confirmed missing). Wraps AuthGate
          so it runs before/alongside the welcome/auth screen without disturbing Workspace's lazy
          load for unauthenticated users. */}
      <ReadinessGate>
        <AuthGate>
        <AttentionController />
        <UpdateBanner />
        {/* Workspace is code-split (React.lazy); Suspense holds the first frame while its chunk
            loads. fallback={null} keeps the transition invisible — the authed UI paints its own
            skeleton, and this only ever shows for the brief chunk fetch right after sign-in. */}
        <Suspense fallback={null}>
          <Workspace />
        </Suspense>
        {/* One-time roborev consent modal — mounted once (not per-agent), self-gated on
            settingsStore.roborevConsentOpen (flipped at the first reviewable commit). */}
        <RoborevConsentModal />
        {/* Vimium-style keyboard hints: a clean ⌘ tap overlays gold chiclets on the primary
            controls. Mounted last so its portal sits above the whole UI. */}
        <HintOverlay />
        </AuthGate>
      </ReadinessGate>
    </CurrentProjectProvider>
  );
}
