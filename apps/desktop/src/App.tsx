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
import { primeRepoSlugs } from "./services/conciergeTools/repoSlug";
import { useProjectStore } from "./stores/projectStore";
import { getConfig, onConfigChanged } from "./services/config";
import { refreshRoborevAuth, backfillImprovementConsentMirror } from "./services/configActions";
import { pollMemoryAdmission } from "./services/agentCapacity";
import { MEMORY_ADMISSION_POLL_MS } from "./services/memoryAdmission";
import { refreshAgentWatchdog } from "./services/agentMemoryWatchdog";
import { recordPeakConcurrency } from "./services/peakConcurrency";
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
import { StraudeConsentModal } from "./components/StraudeConsentModal";
import { AccountLimitModal } from "./components/AccountLimitModal";
import { startUpdater } from "./services/updaterService";
import { startStaleBuildWatch } from "./services/staleBuildService";
import { startAgentGoalDiskMirror } from "./services/agentGoalDisk";
import { startGoalContinuationRunner } from "./services/goalContinuationRunner";
import { startEpicSweepRunner } from "./services/epicSweepRunner";
import { startResurrectionRunner } from "./services/resurrectionRunner";
import { startAutoApproveWatch } from "./services/suggestions/autoApproveWatch";
import { startFleetWatch } from "./services/fleetWatch";
import { startBeadMentionWatch } from "./services/beadMentions/beadMentionWatch";
import { startInboxWatch } from "./stores/inboxStore";
import { startPipelineHealthWatch } from "./stores/pipelineHealthStore";
import { startCiBudgetGovernor } from "./services/ciBudgetGovernorInit";
import { startPusher } from "./services/pusherMount";
import { startAuthRecovery } from "./services/authRecovery";
import { startSocialSync } from "./services/socialSync";

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

// The deployment-pipeline health poll behind the header's PipelineHealthChip (bead sparkle-m6jov5).
// Paints no UI.
//
// MAIN WINDOW ONLY, like FleetWatch and for the same reason (cost, not correctness): a tick shells
// out to `roborev status` and one `gh api` runner read, and the answer is repo-wide, so N windows
// each probing would be N times the subprocess/network work for one identical result. The chip in a
// non-main window still renders from the shared store the main window populates.
//
// Not deferred to onIdle: the poll returns immediately until a project root is set, so there is no
// boot-burst cost to defer, and deferring would delay the first health reading the founder can see.
function PipelineHealthWatch() {
  const isMain = useIsMainWindow();
  useEffect(() => {
    if (!isMain) return;
    const stopHealth = startPipelineHealthWatch();
    // The fleet CI-budget governor rides the same signal: it reads release-in-progress + CI-pool
    // saturation off the pipeline-health store and drains its queue on each reading. Main-window
    // only, and torn down together.
    const stopGovernor = startCiBudgetGovernor();
    return () => {
      stopGovernor();
      stopHealth();
    };
  }, [isMain]);
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

// Answers a permission prompt WHEN IT APPEARS rather than when its pane is clicked
// (services/suggestions/autoApproveWatch).
//
// MOUNTED HERE BECAUSE THE ONLY THING THAT EVER RAN AUTO-APPROVE WAS A PER-PANE HOOK, and the
// concierge mounts that hook for the SELECTED agent only — so the app was blind to every other
// agent, and the founder's click was what made a waiting prompt visible and answered it. Of 325 pane
// switches in one measured day, 96 were followed within a second by an auto-approve keystroke.
// App-level and singular for the same reason <GoalContinuation/> is: a prompt belongs to an AGENT,
// and one watcher serves the whole fleet.
//
// MAIN WINDOW ONLY, and here that is CORRECTNESS rather than cost — the distinction <FleetWatch/>
// draws above. This types into a PTY, the de-dupe set that stops a second keystroke is per-window
// module state, and a satellite window runs its own copy of these stores: two watchers would each
// answer the same picker once. Paints no UI.
function AutoApproveWatch() {
  const isMain = useIsMainWindow();
  useEffect(() => {
    if (!isMain) return;
    return startAutoApproveWatch();
  }, [isMain]);
  return null;
}

// Turns an `@agent` in a BEAD COMMENT into a doorbell in that agent's inbox (bead sparkle-jb809e).
//
// WHY THIS MOUNT IS THE DELIVERABLE. A bead comment is the sanctioned cross-agent channel, but
// posting one wakes nobody: during a CI P0 an agent posted a stand-down comment on another agent's
// bead, that agent never saw it and worked a superseded plan, and the FOUNDER hand-relayed it. Two
// earlier attempts at a mention channel are already on main and have never run — `mention.rs`'s four
// Tauri commands have zero frontend callers, and the compose UI's components are mounted by nothing.
// A watcher with no mount is the same dead code a third time, so this line is the feature.
//
// MAIN WINDOW ONLY, and — like <AutoApproveWatch/> above rather than like <InboxWatch/> — that is
// CORRECTNESS, not cost: this WRITES. It queues inbox messages and posts bead comments, so a second
// window would mean two doorbells and two comments for one mention. Deferred to idle with the rest
// of the boot burst; it adds no `bd` call of its own, riding the board poll's own comment counts.
// Paints no UI.
function BeadMentionWatch() {
  const isMain = useIsMainWindow();
  useEffect(() => {
    if (!isMain) return;
    let stop: (() => void) | undefined;
    let cancelled = false;
    onIdle(() => {
      if (cancelled) return;
      stop = startBeadMentionWatch();
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [isMain]);
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

// THE SAME SHAPE, ONE LEVEL UP: goal continuation watches an AGENT that stopped, this watches an
// EPIC that stopped. They are disjoint by construction — the epic sweep fires only when NO
// orchestrator is alive on the epic, which is exactly when there is no agent left for the other
// three sweeps to recover. Mounted app-level and elected per project for the identical reason: the
// side effect is a HANDOFF, so a per-pane timer would multiply the agents, not just the work.
function EpicSweep() {
  useEffect(() => startEpicSweepRunner(), []);
  return null;
}

// THE GOAL'S DURABLE MIRROR — `<app_data>/agent-goals/<agentId>.json`, for the SessionStart hook
// (services/agentGoalDisk, contract in docs/agent-goal-record.md).
//
// Beside GoalContinuation because they answer two halves of one question. That one restarts an agent
// whose turn ended with work remaining; this one makes sure an agent that comes back with NO session
// context can still be told what it was doing — the goal lives in localStorage, which a shell hook
// cannot read, so without this a resuming agent gets nothing. Same app-level shape and the same
// single-owner election, for the same reason: a goal belongs to an AGENT, and two windows writing
// one file would fight over it.
function GoalDiskMirror() {
  useEffect(() => startAgentGoalDiskMirror(), []);
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

// THE WRITER socialStore never had. `services/socialApi` and `stores/socialStore` were both complete
// and both had ZERO consumers, so the sidebar's Chat section was a component that would render if
// only it had data (services/socialSync).
//
// Mounted INSIDE <AuthGate> rather than beside the sweeps above, because everything it reads is
// authed and per-account. But note what the mount point does NOT buy: AuthGate renders its children
// on the anonymous TRIAL branch too, so being here is not a proof of sign-in. The loop's own
// `tokenPresent` gate is what keeps it from firing an unauthed request and earning a 401 that would
// stop it for the whole session — see socialSync's `onePass`. Cheap when the feature is off:
// `SOCIAL_ENABLED` is unset in production, so the first request 404s and the loop goes quiet after
// exactly one round trip. Paints no UI.
function SocialSync() {
  useEffect(() => startSocialSync(), []);
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
        // PRIME THE REPO-SLUG CACHE for every known project (roborev 65400, finding 1).
        //
        // Per-project tool policy is keyed by `owner/repo`, and `slugForRoot` is SYNCHRONOUS
        // because the whole policy path is. A cache miss therefore resolves to `null`, which is
        // treated as FOREIGN — the fail-closed answer — which floors `mutates-main` tools at `ask`.
        // Correct, but without this line the FIRST `merge_pr` of every session is a guaranteed
        // approval card even in a repo the human explicitly set to `allow`, which is exactly the
        // interruption this feature exists to remove. Lazy priming on miss fixes the second call;
        // this fixes the first.
        //
        // Fire-and-forget, after hydrate, and never awaited: it must not delay first paint, and a
        // failure only leaves the cache cold, which is the state we already handle safely.
        primeRepoSlugs(useProjectStore.getState().projects.map((p) => p.rootPath));
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
      // The PER-AGENT half: admission gates NEW spawns on total pressure, but nothing watched an
      // agent that was already admitted and then ran its RSS away — the 2026-07-20 jetsam mode
      // (`sparkle-0bye`). This surfaces warn/critical agents and, only when the user opted into
      // `agent_rss_auto_kill`, stops a runaway. Fire-and-forget like the admission poll; it never
      // throws (older backends reject the command every tick). Shares this one interval — no new
      // thread — because the two are the same cadence and the same "watch the machine" job.
      void refreshAgentWatchdog();
      // THE PERSISTENT RECORD (docs/peak-concurrency.md). Everything above this line MEASURES and
      // then throws the reading away — the admission sample expires in 15s, the watchdog report is
      // replaced wholesale on the next tick, and neither survives a relaunch. **This call is the
      // only thing in the app that ever writes a peak or a memory observation DOWN**, which is why
      // it exists at all: before it, nothing recorded how many agents had ever run at once, so
      // every number anyone quoted was a recollection, and the per-agent RSS the watchdog is
      // already computing was discarded 17,280 times a day rather than accumulated into the
      // distribution that would let the ceiling's assumed divisor be re-grounded.
      //
      // The sample carries the watchdog report's per-agent tree RSS through to Rust, because
      // running `agent_footprints`' uncached `ps -axo` a second time every 5s is the cost its own
      // doc comment warns about. NOTE the ordering above is INCIDENTAL, not a guarantee: the
      // watchdog call is `void`-ed and writes its store only after awaiting its own IPC, while
      // this call builds its payload synchronously on entry — so the RSS half is ALWAYS the
      // previous tick's report no matter which line comes first, exactly as peakConcurrency.ts's
      // header states. Do not "fix" a staleness bug by re-ordering these two; it changes nothing.
      // Each report is folded at most once (the watchdog store's `seq`), so a stalled watchdog
      // repeats a reading rather than compounding it. It shares
      // this interval for the same reason the watchdog does — same cadence, same "watch the
      // machine" job, no new thread. Fire-and-forget: it never throws, and an older backend
      // without the command rejects on every tick.
      void recordPeakConcurrency();
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
      <BeadMentionWatch />
      <PipelineHealthWatch />
      <LimitSync />
      <AutoApproveWatch />
      <GoalContinuation />
      <EpicSweep />
      <GoalDiskMirror />
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
        <SocialSync />
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
        <StraudeConsentModal />
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
