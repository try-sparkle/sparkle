import { lazy, Suspense, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, getAllWindows } from "@tauri-apps/api/window";
import { C, FONT, FONT_WEIGHT, ON_BRAND_FILL, ON_GOLD_FILL } from "../theme/colors";
import type { AgentTab, Project } from "../types";
import { useProjectStore } from "../stores/projectStore";
import { ConciergeHost } from "./ConciergeHost";
import { ColumnPullTab } from "./ColumnPullTab";
import { CommandPalette, PaletteTrigger, useCommandPalette } from "./Concierge";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import { useConnectionStore } from "../stores/connectionStore";
import { useCloudAgentsEnabled } from "../hooks/useCloudAgents";
import { useSettingsStore } from "../stores/settingsStore";
import { useNewAgent } from "../hooks/useNewAgent";
import { reattachProjectOnOpen } from "../services/cloudAgents/startup";
import { NewAgentRuntimeToggle } from "./NewAgentRuntimeToggle";
import { useNewBuildAgentDrop } from "../hooks/useNewBuildAgentDrop";
import { AgentSidebar, NewBuildAgentButton } from "./AgentSidebar";
import { PLAN_COLUMN_Z } from "./layers";
import { PlanBuildToggle } from "./PlanBuildToggle";
import { ProjectTabsBar } from "./ProjectTabsBar";
import { OfflineBanner } from "./OfflineBanner";
import { ZeroCreditBanner } from "./ZeroCreditBanner";
import { ProviderUnavailableBanner } from "./ProviderUnavailableBanner";
import { ClosePrompt } from "./ClosePrompt";
import { StatusStrip } from "./StatusStrip";
import {
  shouldWarmSparkleAtLaunch,
  sparkleAgentIdFor,
  sparkleOpenSetWhitelist,
} from "../services/sparkleAgent";
import {
  useCurrentProjectId,
  useIsMainWindow,
  useCurrentWindowLabel,
} from "../windowContext";
import { isCalmBand, useConciergeFeed } from "../useConciergeFeed";
import { firstVisibleAgentId } from "../engine/agentOrdering";
import { firstLadderRowId } from "../engine/ladderSelection";
import { resolveStage, rollupStages } from "../engine/workflowStage";
import { publishedStatusFor } from "../useAttentionNotifications";
import { decidePromptTarget, resolvePinnedProjectId } from "../engine/shellResolve";
import {
  markProjectVisited,
  onVisitedProjectsChange,
  visitedProjectsVersion,
  wasProjectVisited,
} from "../services/sessionProjects";
import { subscribeToCrossWindowSync } from "../services/crossWindowSync";
import { useTornOutProjects } from "../hooks/useTornOutProjects";
import { focusSatellite, reclaimProject, reconcileSatellites } from "../services/satelliteWindows";
import { startPresenceTracking } from "../stores/presenceStore";
import { startOrchestrationListener } from "../services/orchestrationListener";
import { startControlListener } from "../services/controlListener";
import { closeScopeProjectNames, killAllOpenAgents, planWindowClose } from "../services/windowClose";
import { clearWindowProject } from "../services/windowRegistry";
import { clearWindowRoster } from "../services/attention";
import { safeUnlisten } from "../services/safeUnlisten";
import { TERMINAL_STAGE_DND_TARGET } from "../services/dndTargets";
import { useImprovementScheduler } from "../useImprovementScheduler";
import { ErrorBoundary, AgentPaneErrorCard } from "./ErrorBoundary";
import { perfRender } from "../perfTrace";

// Code-split the heavy, not-always-visible surfaces so a cold start doesn't ship them in the
// initial chunk (bead sparkle-alrm.5, #9). AgentPane pulls the terminal (xterm + webgl), Onboarding
// and the Markdown renderer (via ThinkPanel → react-markdown/remark-gfm); none of it is needed
// until an agent pane actually opens. BoardView, the Sparkle pane and the settings modal are
// likewise on-demand. The always-visible shell (tabs, sidebar, banners, close prompt) stays eager
// above. These are named exports, so map each to `default` for lazy().
// (Declared below all imports so no non-import statement precedes an `import`.)
const AgentPane = lazy(() => import("./AgentPane").then((m) => ({ default: m.AgentPane })));
const SparkleAgentPane = lazy(() =>
  import("./SparkleAgentPane").then((m) => ({ default: m.SparkleAgentPane })),
);
const BoardView = lazy(() => import("./BoardView").then((m) => ({ default: m.BoardView })));
const ProjectModal = lazy(() => import("./ProjectModal").then((m) => ({ default: m.ProjectModal })));
const NewCloudAgentDialog = lazy(() =>
  import("./NewCloudAgentDialog").then((m) => ({ default: m.NewCloudAgentDialog })),
);

/** The macOS titlebar / Window menu / dock tooltip text. A constant, not the project name — the
 *  project tab bar is what says which project you're on. Matches tauri.conf.json's window title so
 *  the runtime set_title can never disagree with the title the window is BORN with (a mismatch
 *  shows up as a visible flicker from one name to another during boot). */
export const WINDOW_TITLE = "Sparkle";

/** Fills the pane slot with the app background while a lazy surface's chunk loads, so on-demand
 * loading never flashes a blank/white frame under the (eager) shell. */
function PaneFallback() {
  return <div style={{ position: "absolute", inset: 0, background: C.forest }} />;
}

/** The concierge column's persisted width, and the range a drag/arrow-key commit is clamped to.
 *  360 is what the column shipped at as a hardcoded prop; the bounds are wider than the agent
 *  column's because this column holds prose (the thread) rather than a list of short rows. */
const CONCIERGE_WIDTH_KEY = "sparkle-concierge-width";
const CONCIERGE_MIN_WIDTH = 280;
const CONCIERGE_MAX_WIDTH = 560;
const CONCIERGE_DEFAULT_WIDTH = 360;

/**
 * THE app shell (Concierge Mode, bead sparkle-qd80 / CM-U7) — one window, three depth layers,
 * projects as TABS:
 *
 *   ┌ project tabs ────────────────────────────── kebab + avatar ┐
 *   │ ① Sparkle concierge │ ② builder agents │ ③ terminal        │
 *   └────────────────────────────────────────────────────────────┘
 *
 * The concierge column is persistent and spans every project (it does NOT participate in the tabs).
 * Column 2's header is the Plan/Build toggle; in Plan mode columns 2+3 collapse into one wide
 * Plan-card column. There is no composer above the terminal — the concierge box is the only one.
 *
 * PANE MOUNTING: every open agent of every project SELECTED AT LEAST ONCE this session is mounted,
 * and only the selected project's selected agent is visible. Both halves are load-bearing:
 *   • sticky — a Terminal unmount KILLS its PTY and disposes the xterm (Terminal.tsx cleanup) with
 *     no scrollback replay, so unmounting the panes of the tab you just left would kill that
 *     project's agents. The visited set only ever grows, which is that guarantee. One window means
 *     no risk of two xterms on one PTY, which is what the old per-window scoping guarded against.
 *   • lazy — mounting every project's panes at BOOT spawned a PTY + `claude --resume` for every
 *     open agent across every project before the user touched those tabs, plus each pane's
 *     background effects. The invariant only requires KEEPING panes after a visit, not pre-mounting.
 */
export function Workspace() {
  // Workspace subscribes to the whole `projects` array, so it re-renders on EVERY projectStore write
  // (status flips, activity, prompt appends…) and re-renders the live pane list under it. This counter
  // exposes that render rate — the top-level driver of pane re-render thrash (perfTrace).
  perfRender("Workspace", "main");

  // The concierge column's width, persisted. It lives HERE rather than inside ConciergeHost because
  // the resize tab is a sibling of the column, not a child: the boundary belongs to the layout that
  // owns both sides of it. Same storage shape as the agent column's width, and the same
  // read-through validation — a persisted value outside the clamp is ignored rather than restored,
  // so a stale entry from an older clamp cannot wedge the column off-screen.
  const [conciergeWidth, setConciergeWidthRaw] = useState<number>(() => {
    const saved = Number(localStorage.getItem(CONCIERGE_WIDTH_KEY));
    return saved >= CONCIERGE_MIN_WIDTH && saved <= CONCIERGE_MAX_WIDTH ? saved : CONCIERGE_DEFAULT_WIDTH;
  });
  const setConciergeWidth = (next: number) => {
    setConciergeWidthRaw(next);
    localStorage.setItem(CONCIERGE_WIDTH_KEY, String(next));
  };
  const projects = useProjectStore((s) => s.projects);
  const currentProjectId = useCurrentProjectId();
  const isMainWindow = useIsMainWindow();
  const currentWindowLabel = useCurrentWindowLabel();
  const openAgentIds = useRuntimeStore((s) => s.openAgentIds);
  const open = useRuntimeStore((s) => s.open);
  const reconcile = useRuntimeStore((s) => s.reconcile);
  const activeSpecial = useUiStore((s) => s.activeSpecial);
  const workMode = useUiStore((s) => s.workMode);
  const setWorkMode = useUiStore((s) => s.setWorkMode);
  const setActiveSpecial = useUiStore((s) => s.setActiveSpecial);
  const pinnedProjectId = useUiStore((s) => s.pinnedProjectId);
  // Resolve the pin DEFENSIVELY: it is persisted and load-bearing (it scopes the concierge vitals),
  // but a project can be deleted from another webview or a stale blob can name one that no longer
  // exists — and no tab renders for a missing project, so a dangling pin would silently zero the
  // concierge's surfaced P0/P1 with no affordance to clear it. Unknown id → "no pin".
  // (projectStore.removeProject clears the pin for the common case; this is the read-site backstop
  // for a stale persisted blob or a project that vanished through the cross-window merge.)
  const resolvedPinnedProjectId = useMemo(
    () => resolvePinnedProjectId(projects, pinnedProjectId),
    [projects, pinnedProjectId],
  );
  // Improve Sparkle is per-window: this window's own Sparkle copy is keyed by this id (the main
  // window keeps the canonical id, secondary windows get their own). See services/sparkleAgent.
  const sparkleAgentId = sparkleAgentIdFor(currentWindowLabel);
  const [settingsProject, setSettingsProject] = useState<Project | null>(null);
  const [closing, setClosing] = useState(false);
  const zoomIn = useUiStore((s) => s.zoomIn);
  const zoomOut = useUiStore((s) => s.zoomOut);
  const resetZoom = useUiStore((s) => s.resetZoom);

  // The cross-project status-band feed (CM-U3) drives BOTH the per-tab Needs-you glow and the concierge
  // column. Built ONCE here and passed down: two `useConciergeFeed`s meant two tray-roster fetches,
  // two roster listeners, two full recomputes per status tick — and two copies that could disagree
  // across render commits, so a tab badge and the vitals line could show different counts.
  const feed = useConciergeFeed({ pinnedProjectId: resolvedPinnedProjectId });

  // ⌘K history search (CM-U5). The controller owns the global binding; the overlay is fixed-position
  // so it can mount anywhere in the tree.
  const palette = useCommandPalette();

  // The hourly self-improvement pass clock (consent banner's "once per hour" promise). Main
  // window only — one scheduler per app, never one per window.
  useImprovementScheduler(isMainWindow);

  // On boot, drop any persisted open-agent ids whose agent no longer exists (e.g. deleted
  // between launches) so a resumed session can't reference a vanished agent (bead ).
  // projectStore hydrates synchronously from localStorage, so the first commit has the full set.
  useEffect(() => {
    // validIds MUST stay derived from ALL projects: openAgentIds is global (every tab's agents
    // live in it), so a project-scoped reconcile would evict other tabs' live PTYs.
    const validIds = projects.flatMap((p) => p.agents.map((a) => a.id));
    // The Sparkle agent is app-owned (never in a project's `agents`). Improve Sparkle is now
    // per-window, so the SHARED open set can hold several Sparkle ids at once (one per window, all in
    // the `__sparkle_self__` namespace) and reconcile() is a non-merging whole-array filter. The
    // whitelist rules are subtle (preserve other windows' LIVE ids, but prune dead per-window ids on
    // main's cold boot so the persisted set doesn't grow unboundedly) — see sparkleOpenSetWhitelist.
    const sparkleWhitelist = sparkleOpenSetWhitelist({
      isMainWindow,
      ownId: sparkleAgentId,
      openIds: useRuntimeStore.getState().openAgentIds,
    });
    reconcile([...validIds, ...sparkleWhitelist]);
    // If the Sparkle view was active at last quit, re-mount THIS window's pane so it resumes. Each
    // window has its own copy now, keyed by its own id — so this is correct in every window, not
    // just the main one.
    if (useUiStore.getState().activeSpecial === "sparkle") open(sparkleAgentId);
    // Otherwise, WARM the pane at launch when consent allows it (shouldWarmSparkleAtLaunch):
    // `open()` alone mounts the pane with visible=false, which spawns/resumes its claude session
    // behind the current view. Deliberately NOT paired with an activeSpecial change — warming must
    // never steal the user's view at startup; it only means that when they do open the row, the
    // agent is already up instead of cold-starting on the click.
    else if (
      shouldWarmSparkleAtLaunch({
        consent: useSettingsStore.getState().sparkleImprovementConsent,
        optIn: useSettingsStore.getState().improvementLaunchWarm,
        isMainWindow,
      })
    ) {
      open(sparkleAgentId);
    }
    // Run once on mount; the persisted open set is reconciled against the hydrated projects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep this window's project list in sync with changes made in other webviews (tray / capture).
  useEffect(() => subscribeToCrossWindowSync(), []);

  // Presence (Here | Away) — frontmost subscription + the idle tick. App-level, not concierge-level:
  // the signal is fed by TERMINAL keystrokes as much as by the compose box, and it must be current
  // the moment anything reads it, so it cannot wait on whatever the user happens to have on screen.
  // `startPresenceTracking` is ref-counted and returns an idempotent disposer, so a StrictMode/HMR
  // double-mount installs one ticker and one listener (stores/presenceStore).
  useEffect(() => startPresenceTracking(), []);

  // Start the orchestration listener singleton. The singleton guard in the listener prevents
  // double-registration under React StrictMode / HMR. An `unmounted` flag handles the race
  // where the component unmounts before the start promise resolves: if that happens we invoke
  // the cleanup immediately so the listener is always torn down exactly once.
  useEffect(() => {
    let cleanup: (() => void) | undefined;
    let unmounted = false;
    void startOrchestrationListener()
      .then((c) => {
        if (unmounted) c();
        else cleanup = c;
      })
      // Terminal catch: a start failure (e.g. the Tauri event bus is transiently unavailable
      // at boot) must not become a silent unhandled rejection — surface a diagnostic. No retry
      // here; the listener's singleton clears its start guard on failure so a later remount
      // re-arms it.
      .catch((e: unknown) => console.error("[orchestration] listener failed to start:", e));
    return () => {
      unmounted = true;
      cleanup?.();
    };
  }, []);

  // Start the app-level sparkle-control listener singleton (mirrors the orchestration listener
  // above, but is app-global — one control bridge shared by ALL agent kinds, not per-Build-agent).
  // Its own singleton guard makes this safe under StrictMode / HMR double-mount; the `unmounted`
  // flag tears it down exactly once if we unmount before the start promise resolves. Started here at
  // app boot — NOT per-pane — so the control surface exists regardless of whether any agent runs.
  //
  // MAIN-WINDOW ONLY: the control bridge is an app-level SINGLETON and Tauri emits "control:request"
  // app-globally, so a second app window would dispatch the same request twice — violating "reply
  // EXACTLY once per reqId". The shell is single-window now, which makes this gate a no-op in
  // practice; it stays as the belt-and-braces guard for the capture/tray webviews.
  useEffect(() => {
    if (!isMainWindow) return;
    let cleanup: (() => void) | undefined;
    let unmounted = false;
    void startControlListener()
      .then((c) => {
        if (unmounted) c();
        else cleanup = c;
      })
      .catch((e: unknown) => console.error("[control] listener failed to start:", e));
    return () => {
      unmounted = true;
      cleanup?.();
    };
  }, [isMainWindow]);

  // Reap orphaned per-window Sparkle worktrees left behind by the old multi-window shell: each
  // secondary window (`win-<uuid>`) cut its own Sparkle worktree, and those windows no longer exist,
  // so their worktrees would sit there forever. Sweep them on boot — once, from the app window,
  // which is now the only one. The canonical worktree is always preserved. Best-effort: a failure
  // just leaves stale dirs.
  useEffect(() => {
    if (!isMainWindow) return;
    void invoke("reap_secondary_sparkle_worktrees").catch((e) =>
      console.debug("reap_secondary_sparkle_worktrees failed", e),
    );
  }, [isMainWindow]);

  // Intercept the window's close (red traffic light) so we can ask keep-vs-kill before closing.
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    // safeUnlisten awaits the listen() promise on cleanup so a handler that resolves AFTER unmount
    // is still torn down (and the Tauri teardown race is swallowed).
    const unlistenPromise = getCurrentWindow().onCloseRequested((event) => {
      event.preventDefault();
      setClosing(true);
    });
    return () => void safeUnlisten(unlistenPromise);
  }, []);

  // Cmd +/- to resize the terminal text, Cmd 0 to reset (matches browser/editor
  // conventions). The size factor is applied to the terminal font only — see Terminal.tsx —
  // so the surrounding UI chrome (sidebar, tabs, buttons) stays fixed.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey) return;
      if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        zoomIn();
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        zoomOut();
      } else if (e.key === "0") {
        e.preventDefault();
        resetZoom();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoomIn, zoomOut, resetZoom]);

  const project = projects.find((p) => p.id === currentProjectId) ?? null;

  // The window is titled "Sparkle", full stop — NOT the selected project's name.
  //
  // It used to name the project, on the theory that the macOS Window menu and dock tooltip should
  // name the work. That reasoning died with the project TAB BAR: the tabs already say which project
  // you're on, and much more precisely (they show every open project and which is selected, not
  // just the one name). All the title added was a second, redundant answer to a question already
  // answered on screen — and a confusing one, because a repo folder called e.g. "sparkle-desktop"
  // made the chrome read as a different app than the one the user launched.
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    // A rejection (e.g. window tearing down mid-call) must not surface as an unhandled rejection.
    getCurrentWindow().setTitle(WINDOW_TITLE).catch(() => {});
  }, []);

  const activeAgentId = project?.selectedAgentId ?? null;
  // The agent the concierge compose box can prompt directly (CM-U7): the selected tab's selected
  // agent. This is what re-homes the removed AgentPane composer — with a target the box can send a
  // real prompt into a terminal instead of only chatting with the brain. Null → the box is
  // Sparkle-only, and its target toggle renders inert.
  // Only the TARGET is consumed now. `decidePromptTarget` also returns the honest `refusal` copy
  // ("Cloud agents take prompts in their own terminal for now"), which existed to explain a
  // DISABLED send-target toggle — and that toggle is gone (auto-routing, PRD §1). The refusal has
  // no surface left: a target that can't take input simply routes to Sparkle, where the reply is
  // recoverable, rather than sitting inert behind a tooltip. The decision function keeps returning
  // it so the reason is one edit away if a surface ever wants it again.
  const { target: promptTarget } = useMemo(
    () => decidePromptTarget(project, activeAgentId),
    [project, activeAgentId],
  );
  // Lets the empty-state start button create a build agent exactly like the sidebar's "+ New Build
  // Agent" row does (same hook → same behavior).
  // Runtime-aware (Local/Cloud toggle) — the same action the sidebar row runs.
  const spawnBuild = useNewAgent(project);
  const cloudCreateOpen = useUiStore((s) => s.cloudCreateOpen);
  const setCloudCreateOpen = useUiStore((s) => s.setCloudCreateOpen);
  // Cloud re-attach (Service B): a cloud session keeps running while the laptop is closed, so when
  // a project's tab is first selected we reconcile its tabs against the server's LIVE sessions and
  // recreate any that lost their tab. Best-effort and silent — signed out, offline, feature off, or
  // "this project has never run a cloud agent" all resolve to "created nothing" (see startup.ts).
  // Once per project per Workspace MOUNT (per session today — the shell never unmounts it), not
  // once per tab switch: in the tabbed shell `project` is the selected tab, so a last-id guard
  // would re-list on every A→B→A flip — and re-listing would also resurrect a cloud tab the user
  // deliberately removed while its server session was still live. Marked BEFORE the await so a
  // re-render can't double-fire, and un-marked when the attempt never got a useful answer (null:
  // auth still settling on a cold boot, offline) so a later attempt retries instead of the project
  // staying silently unreconciled until relaunch.
  //
  // AUTH IS IN THE DEPS, not just the project id (roborev 49295): the motivating null — "the token
  // hadn't landed yet on a cold boot" — resolves seconds later without anything about the project
  // changing. Keyed on the id alone, a user with ONE project (or who simply doesn't flip tabs) got
  // exactly one attempt and the un-mark had nothing to trigger it again, which made the retry a
  // no-op for the very case it was written for. Now the settling token IS the retry trigger.
  // The same gate every other cloud surface reads (services/cloudAgents/gating, via the hook) —
  // not a fourth hand-rolled copy of `tokenPresent && me?.cloudAgentsEnabled` (roborev 52648).
  const cloudAuthReady = useCloudAgentsEnabled();
  // …and CONNECTIVITY, because auth-settling is only half of what produces a retryable null. On an
  // offline cold boot for an already-signed-in user the persisted token rehydrates `tokenPresent`
  // true on the first frame, so `cloudAuthReady` never transitions and the un-mark had nothing to
  // fire it: a single-project user got exactly one attempt and stayed unreconciled until relaunch
  // (roborev 52648/52649). The offline→online transition is the trigger for that half.
  const online = useConnectionStore((s) => s.isOnline);
  const reattachedProjects = useRef<Set<string>>(new Set());
  useEffect(() => {
    const id = project?.id ?? null;
    if (!id || !cloudAuthReady || !online || reattachedProjects.current.has(id)) return;
    reattachedProjects.current.add(id);
    void reattachProjectOnOpen(id).then((r) => {
      if (r === null) reattachedProjects.current.delete(id);
    });
  }, [project?.id, cloudAuthReady, online]);
  // Files dropped on either "+ New Build Agent" button spawn a new build agent with the files
  // attached. Mounted here (not in a composer) so it also works when no agent exists yet — the
  // empty-state button has no pane to piggyback on.
  useNewBuildAgentDrop(project);

  // LAZY, STICKY pane mounting. The invariant is "don't kill the tab you LEFT" — which only needs
  // panes to stay mounted once visited, not every project's panes mounted before the user touches
  // those tabs. Mounting all of them at boot spawned N PTYs + `claude --resume` for every open agent
  // across every project (plus each pane's own effects: branch polling, alert episodes) on
  // a cold start. So: track the projects selected at least once this session — the set only ever
  // GROWS, which is exactly the no-unmount guarantee — and mount their open agents.
  // Updated during render (not in an effect) so a tab switch mounts its panes in the same commit,
  // with no frame where the newly-selected project shows its empty state.
  //
  // The user-visible cost, stated plainly: an agent left running in a project you have NOT opened
  // this session is listed as open (the sidebar and the concierge read the store) but has no PTY,
  // no live status and no attention notifications until you click that tab, at which point it
  // resumes. That is the trade for not spending a token on every project at every launch.
  // SINGLE SOURCE OF TRUTH (roborev 46351): the visited set lives in services/sessionProjects —
  // the same set the roster publisher reads — and this component subscribes to it rather than
  // mirroring it into React state. A mirrored copy diverged after a Workspace remount (HMR,
  // StrictMode, shell swap): the module set survived while the mirror re-seeded, so the publisher
  // reported projects whose panes weren't mounted. The set is deliberately never pruned when a
  // project leaves `projects` — a transient absence (a cross-window merge landing mid-render)
  // would unmount that project's panes, and a Terminal unmount KILLS its PTY. A stale id costs
  // nothing: the loop iterates `projects`, so an id naming no project matches nothing.
  const visitedVersion = useSyncExternalStore(onVisitedProjectsChange, visitedProjectsVersion);
  // Record the tab in an effect (a render-phase notify would set state in another component
  // mid-render; one commit of lag is irrelevant to a 250ms-debounced roster push). The CURRENT
  // tab is unioned in at render time below, so its panes still mount in the same commit.
  useEffect(() => markProjectVisited(currentProjectId), [currentProjectId]);

  // Projects that have been pulled out into their own window (services/satelliteWindows). This is
  // the ONE subscription that has to be synchronous: the claim lands before the satellite window is
  // built, and main must drop those panes in the same commit — a Terminal unmount KILLS its PTY, so
  // if main were still holding them when the satellite mounts, both webviews would spawn an xterm
  // against the same agent id and `pty_spawn`'s `sessions.insert` would orphan one of the two child
  // processes. useSyncExternalStore (hooks/useTornOutProjects) gives that; a useEffect poll would
  // not.
  const tornOut = useTornOutProjects();

  const live: Array<{ project: Project; agent: AgentTab }> = useMemo(() => {
    const out: Array<{ project: Project; agent: AgentTab }> = [];
    // One Set for the whole nested loop: this memo re-runs on EVERY projectStore write (the file's
    // perf comment calls that the top render driver), so an O(projects × agents) scan with an
    // inner `includes` was a linear search per agent.
    const open = new Set(openAgentIds);
    for (const p of projects) {
      // Torn out → NOT ours to mount, even though it is visited and even when it is the selected
      // tab. This `continue` is the entire pane-ownership gate; see `tornOut` above for why letting
      // it slip costs a duplicated PTY rather than a duplicated pixel.
      if (tornOut.has(p.id)) continue;
      if (!wasProjectVisited(p.id) && p.id !== currentProjectId) continue;
      for (const a of p.agents) {
        if (open.has(a.id)) out.push({ project: p, agent: a });
      }
    }
    return out;
    // visitedVersion is the subscription token for the module set read via wasProjectVisited.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects, openAgentIds, visitedVersion, currentProjectId, tornOut]);

  // Is the tab the user is looking at one whose columns now live in another window?
  const selectedIsTornOut = !!project && tornOut.has(project.id);
  // WHICH projects have a re-dock in flight (the ask-then-force handshake in
  // services/satelliteWindows). A SET, not a bare boolean and not a single slot — both simpler
  // shapes are wrong with up to four satellites. A boolean disabled "Bring it back here" on every
  // other torn-out tab, blocking the only recovery path for a project whose reclaim was not even
  // running. A single slot was bypassable the other way: start p1, start p2, then p1 settles (or
  // times out after REDOCK_TIMEOUT_MS) and clears the slot, re-enabling p2's button while p2's
  // reclaim is still in flight — a second click then starts a second reclaim, which is the double
  // force this state exists to prevent.
  const [reclaimingIds, setReclaimingIds] = useState<ReadonlySet<string>>(() => new Set());
  const startReclaim = (id: string) => {
    if (reclaimingIds.has(id)) return;
    setReclaimingIds((prev) => new Set(prev).add(id));
    void reclaimProject(id).finally(() =>
      setReclaimingIds((prev) => {
        // Remove only the id that finished — never replace the whole set.
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      }),
    );
  };
  // Columns ② + ③ belong to the satellite while it holds the project, so the sidebar renders EMPTY
  // rather than listing agents whose panes are somewhere else — clicking one here would select an
  // agent that this window has no terminal for.
  const sidebarProject = selectedIsTornOut ? null : project;

  // Crash/force-quit backstop. A satellite that died without releasing leaves its project owned by
  // a window that no longer exists, and nothing would ever render it again. Reconcile when main
  // regains focus — the moment a user who just force-quit a satellite comes back to look for it.
  // Also once at mount, for the case where the crash happened while main was already focused.
  useEffect(() => {
    void reconcileSatellites();
    const onFocus = () => void reconcileSatellites();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);
  const activeIsOpen = activeAgentId !== null && openAgentIds.includes(activeAgentId);
  // Improve Sparkle keeps its own pane slot (activeSpecial lives in uiStore, the pane is keyed by
  // this window's sparkleAgentId).
  const sparkleActive = activeSpecial === "sparkle";
  const sparkleOpen = openAgentIds.includes(sparkleAgentId);
  // The read-only Tasks board (bead sparkle-hiju.10) is the Plan view. Only meaningful with a
  // project open, and only when the Beads tool ([tools].beads) is enabled — off means the board is
  // used nowhere (the Plan chevron hides and mode reconciles away from it).
  const beadsEnabled = useSettingsStore((s) => s.beadsEnabled);
  const boardActive = activeSpecial === "board" && !!project && beadsEnabled;
  // PRD §3: "Plan mode: columns 2 + 3 collapse into one wide column of Plan cards." Build splits
  // them back. The agent column stays MOUNTED (display:none) rather than unmounting — it owns live
  // effects (alert episodes, branch polling, the close prompt) that must not restart on a mode flip.
  const planCollapsed = boardActive;

  // Is the selected agent actually ON SCREEN? `project.selectedAgentId` stays non-null while the
  // Plan board or the Improve Sparkle pane is showing, and while the agent's tab isn't open at all.
  //
  // This gates ROUTING, not the suggestions engine — the concierge needs both facts and they are
  // deliberately separate (see ConciergeHost's promptTarget/targetShown props). Under the old
  // target toggle the slack was harmless: the user had to flip a control to aim, so a stale
  // selection could never receive anything by itself. The router infers "there is a build agent in
  // view" from this, so ungated it would write an imperative typed while looking at the board into
  // a terminal the user cannot see. See PRD/sparkle/concierge-auto-routing.md §2.
  const promptTargetShown = !sparkleActive && !boardActive && activeIsOpen;

  // Calm terminal (PRD §3 / prototype `.terminal.calm`): when the agent you're looking at has
  // nothing for you, its terminal TEXT desaturates, so only a screen that wants something from you
  // carries color. Read from the same feed the tabs and the concierge use, so "calm" means one
  // thing app-wide.
  //
  // This is now the ONLY calm treatment. It used to run alongside a matching one in the sidebar —
  // a `grayscale(1) opacity(.72)` filter over any row this same predicate called calm — which was
  // removed on 2026-07-27 because `working` is in the calm set, so it desaturated the status dot of
  // every agent that was actually running. Do not restore a row filter here or there; the sidebar
  // carries status by DOT COLOR now. See services/conciergeFeed.isCalmBand for the full note.
  //
  // It asks `isCalmBand(status)` and not the agent's status BAND. Those are different sets by
  // design and `unmerged` is the difference: it bands `done` (it must not buy a nudge card) but is
  // NOT calm (unlanded work is exactly what you should still see). Reading the band here meant
  // selecting an unmerged agent desaturated its terminal while its sidebar row stayed fully colored
  // — the two surfaces disagreeing about the one status the split exists to protect.
  //
  // Only ever true for a VISIBLE AGENT PANE (roborev 46254-M1). It used to default to `true` with
  // no agent selected and ignore the overlays, while the treatment was a `filter` on the whole
  // stage — so a brand-new user's onboarding screen ("Welcome to Sparkle", the teal + New Build
  // Agent button, "Press ⌃ Ctrl to take a tour") rendered fully grayscale, and the Improve-Sparkle
  // pane grayed and ungrayed according to the priority of a hidden build agent it has nothing to do
  // with. The desaturation now rides the terminal's own theme (AgentPane → Terminal → xtermTheme),
  // which also keeps it off the WebGL canvas's per-frame composite path.
  const terminalCalm = useMemo(() => {
    if (sparkleActive || boardActive || !activeAgentId || !activeIsOpen) return false;
    const p = feed.projects.find((x) => x.id === currentProjectId);
    // An agent the feed doesn't know reads `undefined`, which isCalmBand treats as calm — the same
    // answer the old `?? 2` default gave.
    return isCalmBand(p?.agents.find((a) => a.id === activeAgentId)?.status);
  }, [feed, currentProjectId, activeAgentId, activeIsOpen, sparkleActive, boardActive]);

  // Plan/Build handlers for the collapsed Plan column's header. Deliberately simpler than the
  // sidebar's copy: there is no "second click spawns an agent" stage to honor from Plan.
  const onPickPlanCollapsed = () => {
    setWorkMode("plan");
    setActiveSpecial("board");
  };
  const onPickBuildCollapsed = () => {
    setWorkMode("build");
    setActiveSpecial(null);
    if (!project) return;
    // Land on the row the Build column ACTUALLY renders first, so the pane matches the mode. Uses
    // the ladder + the live status filter — plain array order would happily select a row the user
    // has filtered out of sight, leaving a terminal with no row beside it (roborev 53428/53439).
    const stageFor = (id: string) =>
      resolveStage(useRuntimeStore.getState().branchStatus[id], useRuntimeStore.getState().workflowStage[id]);
    const headStageFor = (id: string) => {
      const kids = project.agents.filter((a) => a.parentId === id);
      const rollup = rollupStages(kids.map((w) => stageFor(w.id)));
      return rollup ? rollup.stage : stageFor(id);
    };
    const published = publishedStatusFor(
      project.agents,
      useRuntimeStore.getState().status,
      new Set(useRuntimeStore.getState().openAgentIds),
      useRuntimeStore.getState().lastObserved,
      stageFor,
    );
    const next =
      firstLadderRowId(
        project.agents,
        "build",
        headStageFor,
        (id) => published[id] ?? "stopped",
        useUiStore.getState().statusFilter,
      ) ?? firstVisibleAgentId(project.agents, "build");
    useProjectStore.getState().selectAgent(project.id, next);
    if (next) open(next);
  };

  // Only computed while the prompt is up (it's the prompt's copy), but a plain call is cheaper than
  // the memo that would guard it.
  const closeScopeNames = closing
    ? closeScopeProjectNames(projects, openAgentIds, project?.id ?? null)
    : [];

  const finishClose = async (mode: "keep" | "kill") => {
    // Dismiss the prompt immediately so a second click on Keep/Kill (the handler awaits below)
    // can't re-enter this flow.
    setClosing(false);
    const win = getCurrentWindow();
    // "Keep agents running" keeps PTYs alive only while the app PROCESS lives, so the app window is
    // hidden (not destroyed) to keep the process — and thus every project's kept agents — alive.
    // "Kill … & close" quits, which necessarily stops them all (standard app-quit semantics).
    const all = await getAllWindows();
    const plan = planWindowClose(mode, all.length <= 1, isMainWindow);
    // "Stop the agents" means every project's RUNNING agents, not just the selected tab's: one
    // window hosts every project now, and leaving the others open in the runtime means the next
    // launch resumes them all. It stops them — it does not delete agents (see windowClose.ts).
    if (plan.killAgents) await killAllOpenAgents(projects, openAgentIds);
    // Keep the registry mapping when only hiding, so a later open can find and reveal the hidden
    // window (the Rust RunEvent::Reopen handler re-shows it on Dock click).
    if (plan.clearRegistry) {
      clearWindowProject(currentWindowLabel);
      clearWindowRoster(currentWindowLabel);
    }
    if (plan.hide) await win.hide();
    else await win.destroy();
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        width: "100vw",
        // Depth layer 0 — the app ink behind everything (PRD §3: Sparkle lightest → builder →
        // terminal darkest; the shell itself sits below all three).
        background: C.deepForest,
        color: C.cream,
        fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
      }}
    >
      {/* Spans the very top of the app, just below the window chrome, above the tabs.
          Offline sits ABOVE out-of-credits on purpose: when both are up, connectivity is the more
          urgent (and the more likely) explanation for AI features misbehaving, and a top-up can't
          be bought without a network anyway. */}
      <OfflineBanner />
      <ZeroCreditBanner />
      {/* Below both on purpose. Offline and a $0 balance are things the USER can act on, so they
          lead; this one they cannot act on at all. It is here rather than nowhere because the
          alternative — what shipped before — was every AI feature going dark with no explanation
          anywhere for 12 hours. Renders only while an outage is actually recorded. */}
      <ProviderUnavailableBanner />
      {/* The project tabs + the top-right kebab/avatar cluster — the app's only top chrome. */}
      <ProjectTabsBar feed={feed} onOpenProjectSettings={setSettingsProject} />
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        {/* ① The persistent cross-project concierge column. Unconditional — the concierge IS the
            experience now, not a flagged addition to the old UI. */}
        <ConciergeHost
          width={conciergeWidth}
          feed={feed}
          promptTarget={promptTarget}
          promptTargetShown={promptTargetShown}
          searchSlot={<PaletteTrigger onOpen={palette.openPalette} />}
        />
        {/* THE CONCIERGE BOUNDARY IS DRAGGABLE NOW. This column shipped at a hardcoded 360 with no
            way to move it, while the agent column beside it had a full resize strip — so of the
            shell's two vertical seams, one was adjustable and the other was a wall. Same control,
            same keyboard contract, and the 2×3 dot grip that fades in on hover; see
            ColumnResizeTab for why the grip is hidden at rest and why it cannot take pointer
            events. */}
        <ColumnPullTab
          width={conciergeWidth}
          onWidth={setConciergeWidth}
          min={CONCIERGE_MIN_WIDTH}
          max={CONCIERGE_MAX_WIDTH}
          label="Sparkle column"
          testId="concierge-pull-tab"
        />
        {/* ② + ③. Position:relative so Plan mode can lay ONE wide card column over both of them —
            covering, never unmounting: a Terminal unmount kills its PTY, so a mode flip must not
            tear the panes down (and display:none would zero their measured size). */}
        <div style={{ flex: 1, display: "flex", minWidth: 0, position: "relative" }}>
          {/* ② Builder agents (the sidebar owns the Plan/Build toggle as its header). */}
          <AgentSidebar project={sidebarProject} />
          {/* ③ The terminal stage. Darkest layer; the selected agent row docks into it (the row
              paints in C.forest too, so the join is seamless).

              NO `filter` here. Calm is the visible pane's own text color (see terminalCalm above):
              a filter on this container would (1) re-composite the WebGL canvas every frame of
              streaming output, (2) gray the onboarding empty states and the Sparkle pane along with
              it, and (3) — being a non-`none` filter — make this div a containing block for
              `position: fixed` descendants, which silently shrank the AccountBadge's full-screen
              click-away backdrop to the stage (roborev 46254). `data-calm` stays: it is what the
              shell tests read. */}
          <div
            data-testid="terminal-stage"
            // Files dropped anywhere on the stage attach to the VISIBLE agent's next message
            // (hooks/useTerminalDrop). Tauri's drag events are window-global and carry no target
            // element, so this marker is what the hit-test resolves against (services/dndTargets).
            data-dnd-target={TERMINAL_STAGE_DND_TARGET}
            data-calm={String(terminalCalm)}
            style={{
              flex: 1,
              position: "relative",
              minHeight: 0,
              background: C.forest,
              // NO `isolation: isolate` HERE, and it is worth saying why, because it looks like the
              // tidy answer to "contain the stage's own high z-indices". It also DEMOTES the whole
              // subtree to layer 0 — including the full-window `position: fixed` surfaces that are
              // supposed to escape this stage. `composer/ModalOverlay` (fixed, inset 0, zIndex 1000)
              // and AgentPane's click-away backdrop both live in panes inside here and are meant to
              // cover column ①; isolated, they lose to any `z-index: 1` descendant of the concierge
              // column, so the dim backdrop gets punched through by the compose box and the
              // click-away stops dismissing. The sidebar's overlay panel clears this stage by
              // out-numbering it instead — see components/layers.ts.
            }}
          >
            {/* Each lazy surface gets its own Suspense so loading one never blanks a sibling that's
                already mounted (the live agent panes keep their PTYs). The agent panes share one
                chunk, so a single boundary around the list is enough. */}
            <Suspense fallback={<PaneFallback />}>
              {live.map(({ project: p, agent }) => {
                // Agent ids are globally unique, so "is this the selected tab's selected agent"
                // is exactly this comparison — a background tab's agent never matches.
                const visible = !sparkleActive && !boardActive && agent.id === activeAgentId;
                // Per-pane boundary: one crashing pane degrades to an inline card (respecting its
                // visibility) instead of unmounting the workspace and its sibling agents.
                return (
                  <ErrorBoundary
                    key={agent.id}
                    scope="agent-pane"
                    fallback={({ error, reset }) => (
                      <AgentPaneErrorCard error={error} reset={reset} visible={visible} />
                    )}
                  >
                    <AgentPane
                      project={p}
                      agent={agent}
                      visible={visible}
                      // Calm is a property of the pane you are LOOKING at, so only the visible one
                      // ever carries it — a background pane re-theming would clear its WebGL atlas
                      // for a screen nobody is watching.
                      calm={visible && terminalCalm}
                    />
                  </ErrorBoundary>
                );
              })}
            </Suspense>

            {sparkleOpen && (
              <Suspense fallback={<PaneFallback />}>
                <SparkleAgentPane visible={sparkleActive} agentId={sparkleAgentId} />
              </Suspense>
            )}

            {!sparkleActive && !boardActive && !project && (
              <Hint title="Welcome to Sparkle">
                Open a project with the <strong>+</strong> in the tab bar and choose a folder on your
                Mac to start building.
              </Hint>
            )}
            {/* The project is in its own window. Say so plainly and offer both ways out — raise
                that window, or take it back — because otherwise a torn-out tab looks like a project
                that lost its agents. "Bring it back here" is also the ONLY recovery path when the
                satellite has ended up on a monitor that is no longer plugged in. */}
            {!sparkleActive && !boardActive && selectedIsTornOut && project && (
              <Hint title={project.name}>
                <div style={{ marginBottom: 18 }}>
                  This project is open in its own window.
                </div>
                <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
                  <button
                    data-testid="focus-satellite"
                    onClick={() => void focusSatellite(project.id)}
                    style={{
                      background: C.teal,
                      color: ON_BRAND_FILL,
                      border: "none",
                      borderRadius: 6,
                      padding: "10px 20px",
                      fontWeight: FONT_WEIGHT.semibold,
                      cursor: "pointer",
                      fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
                    }}
                  >
                    Show that window
                  </button>
                  {/* Re-docking is a HANDSHAKE, so it can take up to REDOCK_TIMEOUT_MS when the
                      satellite is slow to answer. Without a pending state the button looks inert
                      and gets clicked repeatedly, and each click emits another request and can
                      eventually force another window close. */}
                  <button
                    data-testid="reclaim-satellite"
                    disabled={reclaimingIds.has(project.id)}
                    // The guard lives in startReclaim, not only in `disabled`: a disabled button is
                    // a rendering detail, and this handler is also what the keyboard path reaches.
                    onClick={() => startReclaim(project.id)}
                    style={{
                      background: "transparent",
                      color: C.cream,
                      border: `1px solid ${C.muted}`,
                      borderRadius: 6,
                      padding: "10px 20px",
                      fontWeight: FONT_WEIGHT.semibold,
                      cursor: reclaimingIds.has(project.id) ? "default" : "pointer",
                      opacity: reclaimingIds.has(project.id) ? 0.6 : 1,
                      fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
                    }}
                  >
                    {reclaimingIds.has(project.id) ? "Bringing it back…" : "Bring it back here"}
                  </button>
                </div>
              </Hint>
            )}
            {!sparkleActive && !boardActive && !selectedIsTornOut && project && project.agents.length === 0 && (
              <Hint title={project.name}>
                {/* The same "+ New Build Agent" button as the sidebar, so the user can start a build
                    agent right here. Hovering it also lights up the sidebar's copy blue (shared
                    buildAgentHover flag), pointing at where the affordance normally lives. */}
                <div style={{ width: 240, margin: "0 auto", display: "flex", flexDirection: "column", gap: 6 }}>
                  <NewAgentRuntimeToggle />
                  <NewBuildAgentButton onClick={spawnBuild} />
                </div>
                {/* ~3 blank rows of breathing room before the tour line. */}
                <div style={{ height: 60 }} />
                <div
                  style={{
                    fontSize: 17,
                    fontWeight: FONT_WEIGHT.semibold,
                    color: C.cream,
                    lineHeight: 1.5,
                  }}
                >
                  Press <KbdKey>⌃ Ctrl</KbdKey> key to take a tour. Happy tokenmaxxing!
                </div>
              </Hint>
            )}
            {!sparkleActive && !boardActive && !selectedIsTornOut && project && project.agents.length > 0 && !activeAgentId && (
              <Hint title={project.name}>Pick an agent on the left.</Hint>
            )}
            {!sparkleActive && !boardActive && !selectedIsTornOut && project && activeAgentId && !activeIsOpen && (
              <Hint title={project.name}>
                <button
                  onClick={() => open(activeAgentId)}
                  style={{
                    background: C.teal,
                    color: ON_BRAND_FILL,
                    border: "none",
                    borderRadius: 6,
                    padding: "10px 20px",
                    fontWeight: FONT_WEIGHT.semibold,
                    cursor: "pointer",
                    fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
                  }}
                >
                  ▶ Start this agent
                </button>
              </Hint>
            )}
          </div>

          {/* PRD §3 — Plan mode: columns ② + ③ collapse into ONE wide column of Plan cards, with
              the segmented toggle as its header so the way back to Build is exactly where it was.
              An overlay (not a swap) so the panes underneath keep their PTYs and their layout. */}
          {planCollapsed && project && (
            <div
              data-testid="plan-column"
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                flexDirection: "column",
                background: C.deepForest,
                // Must stay above the sidebar's overlay panel, which is a sibling here — see
                // components/layers.ts for the ordering contract and why it matters.
                zIndex: PLAN_COLUMN_Z,
              }}
            >
              <div style={{ paddingTop: 12 }}>
                <PlanBuildToggle
                  mode={workMode}
                  beadsEnabled={beadsEnabled}
                  onPickPlan={onPickPlanCollapsed}
                  onPickBuild={onPickBuildCollapsed}
                  style={{ margin: "0 12px 8px", maxWidth: 320 }}
                />
              </div>
              <div style={{ flex: 1, position: "relative", minHeight: 0 }}>
                <Suspense fallback={<PaneFallback />}>
                  <BoardView project={project} />
                </Suspense>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* The app's only bottom chrome: Changelog · Support · v{version}, hugging the bottom-right
          corner. A real ROW of this column (not an overlay), so it can never occlude the terminal
          stage, the composer, or any other bottom-anchored UI — they simply lay out above it. */}
      <StatusStrip />

      {/* ⌘K history search across every project's conversations (CM-U5). */}
      <CommandPalette open={palette.open} onClose={palette.closePalette} />

      {settingsProject && (
        <Suspense fallback={null}>
          <ProjectModal
            project={projects.find((p) => p.id === settingsProject.id) ?? settingsProject}
            onClose={() => setSettingsProject(null)}
          />
        </Suspense>
      )}

      {/* The cloud-agent create dialog is rendered exactly ONCE here, though the "+ New Build
          Agent" affordance that opens it exists in two places (sidebar row + empty state). Lazy so
          a local-only user never downloads it. */}
      {cloudCreateOpen && project && (
        <Suspense fallback={null}>
          <NewCloudAgentDialog project={project} onClose={() => setCloudCreateOpen(false)} />
        </Suspense>
      )}

      {closing && (
        <ClosePrompt
          projectName={project?.name ?? "this project"}
          // "Stop the agents" reaches every project's RUNNING agents (killAllOpenAgents), so the
          // copy names exactly those projects rather than implying the visible tab is the only
          // casualty — or naming the front tab when nothing in it is running. Front project first
          // (when it has any), since that's the one the user is looking at.
          runningProjectNames={closeScopeNames}
          onKeep={() => void finishClose("keep")}
          onKill={() => void finishClose("kill")}
          onCancel={() => setClosing(false)}
        />
      )}
    </div>
  );
}

function Hint({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 12,
        textAlign: "center",
        padding: 24,
      }}
    >
      <div style={{ fontSize: 17, fontWeight: FONT_WEIGHT.semibold, color: C.cream }}>{title}</div>
      <div style={{ color: C.muted, maxWidth: 420, lineHeight: 1.5 }}>{children}</div>
    </div>
  );
}

// A keycap "chiclet" — the same gold pill the keyboard-hint overlay uses (HintOverlay.tsx), reused
// inline in copy to render a physical key (e.g. the ⌃ Ctrl key). Sits on the text baseline center.
function KbdKey({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        display: "inline-block",
        verticalAlign: "middle",
        margin: "0 3px",
        // The themed opaque-gold PAIR — see theme/colors `goldFill` / ON_GOLD_FILL. This said
        // "gold #e0982f" while painting the amber STATUS token.
        background: C.goldFill,
        color: ON_GOLD_FILL,
        font: `700 15px/1 ${FONT.mono}`,
        letterSpacing: 0.5,
        padding: "3px 8px",
        borderRadius: 4,
        border: `1px solid ${ON_GOLD_FILL}`,
        boxShadow: "0 1px 3px rgba(0,0,0,0.4)",
        textTransform: "uppercase",
      }}
    >
      {children}
    </span>
  );
}
