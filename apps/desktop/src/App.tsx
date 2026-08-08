import { lazy, Suspense, useEffect, useRef } from "react";
import { AuthGate } from "./components/AuthGate";
import { ReadinessGate } from "./components/ReadinessGate";
import { useAmbientVoice } from "./useDictation";
import { installInputFreezeTrace, traceGates } from "./diagnostics/inputFreezeTrace";
import { installInputRelease } from "./services/inputRelease";
import { installDictationFocusTracker } from "./voice/dictationFocusTracker";
import { useDictationStore } from "./stores/dictationStore";
import { useApplyTheme } from "./theme/theme";
import { useConnectionMonitor } from "./connectionMonitor";
import { resolveEnvChiefPat, seedKeychainChiefPat } from "./services/chief";
import { healAgentHooks } from "./services/worktree";
import { importDefault } from "./services/accountStore";
import { startRelayHost, stopRelayHost } from "./services/relayClient";
import { useSettingsStore } from "./stores/settingsStore";
import { getConfig, onConfigChanged } from "./services/config";
import { refreshRoborevAuth, backfillImprovementConsentMirror } from "./services/configActions";
import { pollMemoryAdmission } from "./services/agentCapacity";
import { MEMORY_ADMISSION_POLL_MS } from "./services/memoryAdmission";
import { safeUnlisten } from "./services/safeUnlisten";
import {
  AppBoot,
  useCurrentProjectId,
  useCurrentWindowLabel,
  useIsMainWindow,
  useReplaceCurrentProject,
} from "./windowContext";
import { LastFocusedProjectTracker } from "./capture/LastFocusedProjectTracker";
import { initCaptureSendListener, type CaptureSendCtx } from "./services/captureSends";
import { useAttentionNotifications } from "./useAttentionNotifications";
import { useRosterPublisher } from "./useRosterPublisher";
import { useHelperVitalsPublisher } from "./useHelperVitalsPublisher";
import { useLimitSync } from "./hooks/useLimitSync";
import { useApiRecovery } from "./services/apiRecoveryRunner";
import { useDisplayRespan } from "./hooks/useDisplayRespan";
import { useSettingsShortcut } from "./hooks/useSettingsShortcut";
import { UpdateBanner } from "./components/UpdateBanner";
import { StaleBuildBanner } from "./components/StaleBuildBanner";
import { AccountSwitchHost } from "./components/AccountSwitchHost";
import { HintOverlay } from "./components/HintOverlay";
import { RoborevConsentModal } from "./components/RoborevConsentModal";
import { BuilderIndexConsentModal } from "./components/BuilderIndexConsentModal";
import { AccountLimitModal } from "./components/AccountLimitModal";
import { startUpdater } from "./services/updaterService";
import { startStaleBuildWatch } from "./services/staleBuildService";
import { startGoalContinuationRunner } from "./services/goalContinuationRunner";
import { startResurrectionRunner } from "./services/resurrectionRunner";
import { startFleetWatch } from "./services/fleetWatch";
import { startInboxWatch } from "./stores/inboxStore";
import { startPusher } from "./services/pusherMount";
import { startAuthRecovery } from "./services/authRecovery";

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

// Publishes the live agent roster to the paired phone + the tray aggregator. Rendered inside
// AppBoot so it starts after the boot-time cleanups, and as a sibling of AuthGate so it runs
// regardless of auth/loading state, matching its prior always-on behavior. (AppBoot is boot
// EFFECTS only now — CM-U7 part 2 removed the per-window context, so its hooks return constants
// and no longer throw outside it.) Paints no UI.
function RosterPublisher() {
  useRosterPublisher();
  // Feed the floating helper island its P0/P1 counts. Mounted HERE, not in ConciergeHost, which
  // unmounts when no project is open — the island must stay correct regardless.
  useHelperVitalsPublisher();
  return null;
}

// Level 0 of the fleet ladder, running CONTINUOUSLY — plus the idle-inbox delivery that depends on
// it (services/fleetWatch). Without this mount both were capabilities with no caller: nothing polled
// `fleet_digest`, and `inbox_claim_for_idle` had zero callers anywhere, so a message queued for an
// agent that was already idle — one that has emitted its last `Stop` and will emit no more — was
// delivered never.
//
// MAIN WINDOW ONLY, and for cost rather than correctness: the O_EXCL claim in `inbox.rs` makes
// double delivery impossible however many windows race, but N windows each walking every worktree
// every ten seconds is N times the work for the same answer. Deferred to idle like the rest of the
// boot burst — the first digest reads files for every agent and nothing on the first screen needs it.
// Paints no UI.
function FleetWatch() {
  const isMain = useIsMainWindow();
  useEffect(() => {
    if (!isMain) return;
    let stop: (() => void) | undefined;
    let cancelled = false;
    onIdle(() => {
      if (cancelled) return;
      stop = startFleetWatch();
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [isMain]);
  return null;
}

// The READ half of the Level 2 inbox: what is queued for each agent a surface is currently showing,
// so a message the concierge queued is VISIBLE before it is delivered (bead sparkle-zm0c8 — a queued
// instruction appeared nowhere at all, which made "I sent it" uncheckable). Paints no UI.
//
// EVERY WINDOW, unlike `FleetWatch` above, and the difference is not an oversight. FleetWatch is
// main-window-only because it WRITES — it claims messages and types them into a PTY — so extra
// windows would be extra cost for the same delivery. This one only reads (`inbox_peek` never claims),
// and agent rows render in every window: gating it on the main window would leave every other
// window's column showing exactly the nothing this bead is about.
//
// Not deferred to `onIdle` either: the registry starts empty and a tick over no watchers returns
// immediately, so there is no boot-burst cost to defer, and deferring would delay the first badge.
function InboxWatch() {
  useEffect(() => startInboxWatch(), []);
  return null;
}

// ⌘, → Settings, from ANY focus context (window-level, capture-phase; see useSettingsShortcut).
//
// Mounted INSIDE THE <Suspense> THAT WRAPS Workspace, deliberately — that boundary, not <AuthGate>,
// is the one that matters. The hook only *requests* a category via uiStore.settingsRequest, and
// nothing clears a request nobody consumed; the sole consumer (KebabMenu) derives
// `settingsVisible = settingsOpen || settingsRequest !== null` on its FIRST render. So anywhere the
// binding is live without that consumer mounted, a press does nothing visible AND latches — and the
// dialog then springs open uninvited the moment the consumer appears.
//
// That is two boundaries deep, and only fixing the outer one leaves the bug: AuthGate withholds
// everything on the sign-in / loading / paywall screens, and Workspace is ALSO React.lazy, so the
// chunk fetch right after sign-in is a second window with the same symptom. Mounting here — inside
// the boundary, as Workspace's sibling — closes both at once, because a suspended boundary commits
// none of its children, so this hook cannot register until the consumer can honor it.
//
// Pinned by useSettingsShortcut.wiring.test.ts, which asserts the position against <Suspense> and
// exercises the suspended case for real rather than trusting that reading of React. Paints no UI.
function SettingsShortcut() {
  useSettingsShortcut();
  return null;
}

// Keeps account exhaustion flags in step with REAL rate-limit events (structured transcript
// records, not terminal text — see services/limitSync). App-wide and singular: a limit belongs to
// an ACCOUNT, so one poller serves every open agent. Paints no UI.
function LimitSync() {
  useLimitSync();
  return null;
}

// Restarts an agent whose TURN ENDED with its goal unmet — the fix for the 37 stalls / 23.6 lost
// agent-hours measured on 2026-07-29, the longest a single agent idle for 153 minutes mid-task
// (see engine/goalContinuation for the log that commissioned it). Mounted ONCE, app-wide, in the
// same shape as <LimitSync/>: a goal belongs to an AGENT and one sweep serves the whole fleet, so a
// per-pane timer would not just duplicate the work — it would duplicate the SENDS. The runner's own
// single-owner election keeps a torn-off satellite window from restarting the same agent. Paints no
// UI.
function GoalContinuation() {
  useEffect(() => startGoalContinuationRunner(), []);
  return null;
}

// THE FLEET RESURRECTOR — the sweep that brings back agents that are DEAD, as opposed to stalled
// (services/resurrectionRunner).
//
// The mirror of `apiRecoveryRunner`, and the pair is disjoint by construction: that one recovers
// `errored + alive` by typing a retry into a living PTY, this one recovers `errored + dead`, which
// no keystroke can reach. App restart is the largest single killer of agents in this app — 54
// SessionEnd in one minute on 2026-08-06, 49 more twenty-six minutes later, of which exactly one
// came back.
//
// Mounted app-level for the same reason GoalContinuation is: a death belongs to an AGENT and one
// sweep serves the whole fleet, so a per-pane timer would multiply the RESPAWNS. Its own
// single-owner election and the process-global `pty_live_sessions` check keep a torn-off satellite
// window from respawning an agent this window is already respawning. Paints no UI.
function FleetResurrection() {
  useEffect(() => startResurrectionRunner(), []);
  return null;
}

// THE PUSHER — the continuous sweep that decides, every minute, whether a build agent or the
// concierge needs pushing (services/pusherMount, sparkle-4cd0x).
//
// MOUNTED HERE BECAUSE IT NEVER WAS. Its whole decision core has existed and been tested for weeks
// in packages/core, and `pusherRunner` recorded in its own header that nothing in a running app had
// ever called it. That is the mechanical reason the founder kept finding a fleet nobody was
// cycling through: not a Pusher that judged badly, a Pusher that was never asked.
//
// Beside GoalContinuation deliberately — the two are siblings that must not collide. The goal
// runner writes to the PTY and answers an expired goal with `{action:"none"}`; this writes to the
// inbox and every one of its triggers sits in a gap the goal runner declines. Same single-owner
// election, so a satellite window observes without double-pushing.
function Pusher() {
  useEffect(() => startPusher(), []);
  return null;
}

// Unblocks the whole fleet when the subscription comes back (PRD/sparkle/claude-account-identity-truth.md §6).
//
// MOUNTED, and that word is the entire point of this component. `authRecovery` is 600 lines whose
// value is exactly zero until something calls `startAuthRecovery()` — the same failure its own
// header describes for `nudger://escalation`, which detected these agents and flagged into a void
// because nothing in TypeScript ever listened. An unmounted recovery service IS that void.
//
// Model-free on every path, so it survives the outage it exists to report on: `claude_oneshot` is
// gated by the same account limit, which is why the resume is a pane restart and a Rust-side `Esc`
// rather than anything that asks a model. `startAuthRecovery` is idempotent (StrictMode and HMR
// both double-mount) and returns its own teardown.
function AuthRecovery() {
  useEffect(() => startAuthRecovery(), []);
  return null;
}

// Retries an agent that a transient Anthropic API error (529/500) knocked out mid-turn, on an
// escalating ladder, instead of leaving a red row for a human to notice (services/apiRecoveryRunner).
//
// Mounted HERE, beside LimitSync, because the two answer adjacent halves of one question and must not
// be confused: LimitSync handles ACCOUNT exhaustion, which no retry can fix and which benches the
// account until its real reset; this handles VENDOR-side failure, which time alone does fix.
// engine/apiRecovery classifies which is which and never pings the former.
//
// Sibling of the columns rather than inside ConciergeHost on purpose: ConciergeHost unmounts when no
// project is open, and an agent that 529s must keep being retried regardless of what the window is
// showing. Paints no UI.
function ApiRecovery() {
  useApiRecovery();
  return null;
}

// Re-fits a window spanned across displays when one is plugged in or unplugged. App-wide because
// the Settings pane that offers the span is almost never open when a cable actually moves, and a
// window left at a multi-display geometry after an unplug can end up unreachable. Paints no UI.
function DisplayRespan() {
  useDisplayRespan();
  return null;
}

// NOTE: LastFocusedProjectTracker lives in capture/LastFocusedProjectTracker.tsx (extracted
// with its own tests by the T3 worker); it must render inside AppBoot.

// Mounts the capture://send listener once per window (spec §4/§5/§6). The capture modal
// broadcasts one payload to every window; this window's routing (ownership + main's stale-owner
// self-heal) decides whether to act, then dispatches Think/Build/Plan. MUST render inside
// AppBoot — it needs this window's label/isMain/current project + `replace` (to
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
  // Diagnostics: record first-responder + keyboard-capture transitions so a recurrence of the
  // dictation input-freeze (sparkle-d2ec) is pinnable. The focus stream and the keydown fingerprint
  // are gated differently — `traceGates` owns that derivation and is unit-tested, rather than an
  // inline closure nothing could pin (roborev 54719/56006).
  useEffect(
    () => installInputFreezeTrace({ dictationState: () => traceGates(useDictationStore.getState()) }),
    [],
  );
  // THE WAY OUT, beside the instrument that records the way in. The trace above says a freeze
  // happened; this is what lets the user leave one without force-quitting the app (sparkle-thm9o).
  // Installed at the ROOT and never gated: a hatch that is conditional on app state is unavailable
  // in exactly the states nobody predicted, which is the only kind this exists for. The trigger is
  // a native menu item, so it survives a webview whose own event pipeline is the broken thing —
  // see services/inputRelease.
  useEffect(() => installInputRelease(), []);
  // DICTATION FOLLOWS FOCUS. Records who holds the caret (and whether this window is active) into
  // the dictation store; the routing gate in useDictation and the paused copy on both mic surfaces
  // read the ONE verdict derived from it (voice/dictationFocus). Installed here, beside the trace
  // above, because it is the same app-wide DOM signal — and the trace is what caught the terminal
  // case in the field. Decides nothing itself; see voice/dictationFocusTracker.
  useEffect(
    () =>
      installDictationFocusTracker({
        setFocusOwner: (o) => useDictationStore.getState().setFocusOwner(o),
        setWindowFocused: (v) => useDictationStore.getState().setWindowFocused(v),
      }),
    [],
  );
  // NOTE: roster publishing lives in <RosterPublisher/> below, mounted inside AppBoot so it starts
  // after the boot-time cleanups rather than racing them.

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
      // Seed the OS-keychain PAT into memory (bead ), read keychain-first. A legacy
      // localStorage PAT remains a read-only fallback via effectiveChiefPat. Best-effort and safe
      // alongside the env-resolved runtime PAT below.
      void seedKeychainChiefPat();
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
      // Also watch for a stale RUNNING build vs the INSTALLED bundle on disk (bead sparkle-jeen).
      // Same idle defer + packaged/main-window guards; its own teardown is chained onto `stop`.
      const stopStale = startStaleBuildWatch();
      const stopUpdater = stop;
      stop = () => {
        stopUpdater?.();
        stopStale();
      };
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
  // SCOPE: the UI mirror reflects the GLOBAL layer (no project root passed), and the ⋯ settings
  // controls write back to that same global layer. Most mirrored controls ([workers], [ai],
  // [tools]) are global-only by design, so that's exact. Two are NOT: [plugins] is repo-overridable
  // (like [workflow]), so a repo whose .sparkle/config.toml disables a plugin will show that plugin
  // as ON here — the pane is showing the machine-wide default, while the Rust engine honors the
  // repo's override directly (config::for_project, resolved per worktree in hooks::install_agent_hooks).
  // Per-project overrides are never surfaced through this mirror.
  useEffect(() => {
    let cancelled = false;
    const hydrate = useSettingsStore.getState().hydrateFromConfig;
    void getConfig()
      .then((eff) => {
        if (cancelled) return;
        hydrate(eff);
        // Reconcile the [improvement].consent mirror the OTHER way. hydrate above is read-only and
        // deliberately won't let an absent section overwrite a persisted choice, so a user whose
        // choice predates the mirror has one that no headless agent can see — and those gate
        // fail-closed on the file. Must run AFTER hydrate, which is what makes `eff` and the store
        // agree about what the file says. Fire-and-forget: it must never delay first paint.
        void backfillImprovementConsentMirror(eff.config.improvement?.consent);
        // Probe roborev's auth once the real flag is loaded. Must run AFTER hydrate (the store's
        // pre-hydrate default would decide it for us) and only matters when roborev is on — see
        // refreshRoborevAuth: the toggle defaults ON, so this launch path is the only thing that
        // checks a fresh install or a restart. Fire-and-forget: it must never delay first paint.
        void refreshRoborevAuth();
      })
      .catch((e) => {
        console.warn("getConfig failed", e);
        if (cancelled) return;
        // HYDRATION MUST BE TERMINAL, not best-effort (roborev 54260, finding 1).
        //
        // The concierge policy layer holds back every non-read-only tool until it has READ the
        // human's rules, because before that it cannot tell "no rule" from "a rule we haven't
        // loaded". That hold is justified only because it is brief. On this path it isn't: there
        // is no retry and no timeout, so a failed config read would leave the flag false for the
        // entire session and permanently refuse navigate / rename_agent / close_agent / every
        // useful tool — recoverable only by restarting, with no clue why.
        //
        // A config read that FAILED is a definite answer to "what rules did the human set": none
        // we can see, so the derived defaults are genuinely the whole policy. Marking it settled
        // is therefore honest, not a shortcut — and it fails toward the tool defaults, which are
        // `ask` for everything risky, not toward blanket permission.
        useSettingsStore.getState().markConciergeToolPolicySettled();
      });
    // Keep the listen() promise; safeUnlisten awaits it on cleanup so a listener that resolves
    // AFTER unmount is still torn down (and the Tauri teardown race is swallowed).
    const unlistenPromise = onConfigChanged(hydrate);
    return () => {
      cancelled = true;
      void safeUnlisten(unlistenPromise);
    };
  }, []);

  // Keep the LIVE memory reading fresh, so the concurrency ceiling can react to the machine.
  //
  // Everything the hydrate above loads is a prediction made once at startup (installed RAM, cores,
  // a pin in config.toml) and it never changes while the app runs. This poll is the other half:
  // services/memoryAdmission caches what the machine actually looks like right now, and
  // localAgentCapacity narrows its ceiling by that — so a refused spawn can say "refused: memory
  // pressure" instead of a bare "at capacity" on a machine that is already swapping.
  //
  // 5s, and the number is load-bearing in both directions. Cheap enough: the Rust side shells out
  // to vm_stat/sysctl behind its own 1s TTL, so this is a handful of process spawns a minute and
  // most ticks are served from that cache. Frequent enough: three polls fit inside the module's 15s
  // staleness TTL, so one slow or dropped sample never expires the narrowing and starts admitting
  // spawns onto a squeezed machine — while a backend that has genuinely stopped answering (every
  // build predating the command rejects on every tick) releases the ceiling within ~15s. That
  // tolerance is real rather than aspirational: the module keeps its cached reading on a failed poll
  // and lets the TTL expire it, and it sequences replies so a slow sample cannot land as fresh.
  //
  // Fire-and-forget by design: refreshMemoryAdmission never rejects, and this must never delay a
  // paint or block anything. It reads capacity fresh on each tick rather than closing over it, so the
  // empty dep array is correct — nothing in here goes stale.
  //
  // WHICH count gets sent is a correctness decision (`live`, not `used` — roborev 55383), so it
  // lives in pollMemoryAdmission() next to the gate that consumes it, where it is unit-testable.
  // Inline here it was not, and it shipped wrong.
  useEffect(() => {
    const tick = () => {
      void pollMemoryAdmission();
    };
    tick(); // don't make the first reading wait a whole interval
    const id = window.setInterval(tick, MEMORY_ADMISSION_POLL_MS);
    return () => window.clearInterval(id);
  }, []);

  return (
    <AppBoot>
      <RosterPublisher />
      <FleetWatch />
      <InboxWatch />
      <LimitSync />
      <GoalContinuation />
      <FleetResurrection />
      <Pusher />
      <AuthRecovery />
      <ApiRecovery />
      <DisplayRespan />
      <LastFocusedProjectTracker />
      {/* Historical: WindowSessionCapture recorded per-window geometry so a cold start could
          reopen every project WINDOW (bead ). The single-window shell restores the
          selected TAB + the persisted open agents from the stores instead, and CM-U7 part 2
          deleted the component. */}
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
        <StaleBuildBanner />
        <AccountSwitchHost />
        {/* Workspace is code-split (React.lazy); Suspense holds the first frame while its chunk
            loads. fallback={null} keeps the transition invisible — the authed UI paints its own
            skeleton, and this only ever shows for the brief chunk fetch right after sign-in. */}
        <Suspense fallback={null}>
          <Workspace />
          {/* Inside the boundary on purpose — see SettingsShortcut. */}
          <SettingsShortcut />
        </Suspense>
        {/* One-time roborev consent modal — mounted once (not per-agent), self-gated on
            settingsStore.roborevConsentOpen (flipped at the first reviewable commit). */}
        <RoborevConsentModal />
        <BuilderIndexConsentModal />
        {/* Raised by <LimitSync/> when a REAL account limit lands. Self-gated on
            accountLimitStore.current, so it costs nothing until an account is actually blocked —
            and it is the one place the user can log into another account without a terminal. */}
        <AccountLimitModal />
        {/* Vimium-style keyboard hints: a clean ⌘ tap overlays gold chiclets on the primary
            controls. Mounted last so its portal sits above the whole UI. */}
        <HintOverlay />
        </AuthGate>
      </ReadinessGate>
    </AppBoot>
  );
}
