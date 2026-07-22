import { lazy, Suspense, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, getAllWindows } from "@tauri-apps/api/window";
import { C, FONT, FONT_WEIGHT, ON_BRAND_FILL, ON_BRAND_FILL_DARK } from "../theme/colors";
import type { AgentTab, Project } from "../types";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useSpawnBuildAgent } from "../hooks/useSpawnBuildAgent";
import { useNewBuildAgentDrop } from "../hooks/useNewBuildAgentDrop";
import { AgentSidebar, NewBuildAgentButton } from "./AgentSidebar";
import { TopBar } from "./TopBar";
import { OfflineBanner } from "./OfflineBanner";
import { ClosePrompt } from "./ClosePrompt";
import { sparkleAgentIdFor, sparkleOpenSetWhitelist } from "../services/sparkleAgent";
import {
  useCurrentProjectId,
  useIsMainWindow,
  useCurrentWindowLabel,
} from "../windowContext";
import { subscribeToCrossWindowSync } from "../services/crossWindowSync";
import { startOrchestrationListener } from "../services/orchestrationListener";
import { startControlListener } from "../services/controlListener";
import { killProjectAgents, planWindowClose } from "../services/windowClose";
import { windowTitleFor } from "../services/projectWindows";
import { clearWindowProject } from "../services/windowRegistry";
import { removeWindowSession } from "../services/windowSession";
import { clearWindowRoster } from "../services/attention";
import { safeUnlisten } from "../services/safeUnlisten";
import { useImprovementScheduler } from "../useImprovementScheduler";
import { ErrorBoundary, AgentPaneErrorCard } from "./ErrorBoundary";
import { perfRender } from "../perfTrace";

// Code-split the heavy, not-always-visible surfaces so a cold start doesn't ship them in the
// initial chunk (bead sparkle-alrm.5, #9). AgentPane pulls the terminal (xterm + webgl), the
// Composer, Onboarding and the Markdown renderer (via ThinkPanel → react-markdown/remark-gfm);
// none of it is needed until an agent pane actually opens. BoardView, the Sparkle pane and the
// settings modal are likewise on-demand. The always-visible shell (sidebar, top bar, banners,
// close prompt) stays eager above. These are named exports, so map each to `default` for lazy().
// (Declared below all imports so no non-import statement precedes an `import`.)
const AgentPane = lazy(() => import("./AgentPane").then((m) => ({ default: m.AgentPane })));
const SparkleAgentPane = lazy(() =>
  import("./SparkleAgentPane").then((m) => ({ default: m.SparkleAgentPane })),
);
const BoardView = lazy(() => import("./BoardView").then((m) => ({ default: m.BoardView })));
const ProjectModal = lazy(() => import("./ProjectModal").then((m) => ({ default: m.ProjectModal })));

/** Fills the pane slot with the app background while a lazy surface's chunk loads, so on-demand
 * loading never flashes a blank/white frame under the (eager) shell. */
function PaneFallback() {
  return <div style={{ position: "absolute", inset: 0, background: C.forest }} />;
}

/** Top-level layout (revised): agents in the left column, the project in the top bar, and
 * the active agent's pane filling the rest. Each window renders only its current project's
 * open agents; within that project they stay mounted across agent-tab switches (only the
 * active one is visible). Switching the window to another project ("Replace") unmounts the
 * displaced project's panes — and a Terminal unmount KILLS its PTY and disposes the xterm
 * (Terminal.tsx cleanup). There is NO scrollback replay: the only copy of the output lived in
 * the now-disposed xterm. Reopening the project remounts fresh panes that re-spawn and restore
 * the *visible conversation* via `claude --resume <id>` (AgentPane.prepare, bead sparkle-wwg7) —
 * Claude repaints the transcript; we do not replay raw PTY bytes. */
export function Workspace() {
  // Workspace subscribes to the whole `projects` array, so it re-renders on EVERY projectStore write
  // (status flips, activity, prompt appends…) and re-renders the live pane list under it. This counter
  // exposes that render rate — the top-level driver of pane re-render thrash (perfTrace).
  perfRender("Workspace", "main");
  const projects = useProjectStore((s) => s.projects);
  const currentProjectId = useCurrentProjectId();
  const isMainWindow = useIsMainWindow();
  const currentWindowLabel = useCurrentWindowLabel();
  const openAgentIds = useRuntimeStore((s) => s.openAgentIds);
  const open = useRuntimeStore((s) => s.open);
  const reconcile = useRuntimeStore((s) => s.reconcile);
  const activeSpecial = useUiStore((s) => s.activeSpecial);
  // Improve Sparkle is per-window: this window's own Sparkle copy is keyed by this id (the main
  // window keeps the canonical id, secondary windows get their own). See services/sparkleAgent.
  const sparkleAgentId = sparkleAgentIdFor(currentWindowLabel);
  const [settingsProject, setSettingsProject] = useState<Project | null>(null);
  const [closing, setClosing] = useState(false);
  const zoomIn = useUiStore((s) => s.zoomIn);
  const zoomOut = useUiStore((s) => s.zoomOut);
  const resetZoom = useUiStore((s) => s.resetZoom);

  // The hourly self-improvement pass clock (consent banner's "once per hour" promise). Main
  // window only — one scheduler per app, never one per window.
  useImprovementScheduler(isMainWindow);

  // On boot, drop any persisted open-agent ids whose agent no longer exists (e.g. deleted
  // between launches) so a resumed session can't reference a vanished agent (bead ).
  // projectStore hydrates synchronously from localStorage, so the first commit has the full set.
  useEffect(() => {
    // validIds MUST stay derived from ALL projects, not just this window's current project:
    // runtimeStore.openAgentIds is shared across windows, so a window-scoped reconcile would
    // evict other windows' live PTYs from the persisted open set. Keep it global.
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
    // Run once on mount; the persisted open set is reconciled against the hydrated projects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep this window's project list in sync with changes made in other windows.
  useEffect(() => subscribeToCrossWindowSync(), []);

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
  // app-globally, so if every window registered a listener, N windows would each dispatch the same
  // request and each call control_respond — violating "reply EXACTLY once per reqId". The
  // in-process start guard only dedupes within one window; gating to the main window dedupes across
  // them (the project store is cross-window-synced, so the main window can service any agent).
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

  // Reap orphaned per-window Sparkle worktrees. Improve Sparkle is per-window: each secondary
  // window (`win-<uuid>`) cuts its own Sparkle worktree, but secondary windows are never restored
  // across an app restart (multi-window session restore is deferred, bead ), so their
  // worktrees would accumulate forever. Sweep them on boot — MAIN-WINDOW ONLY and once, which at
  // cold start is the only live window (so no in-use secondary worktree can be clobbered). The
  // canonical (main) worktree is always preserved. Best-effort: a failure just leaves stale dirs.
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
  // so the surrounding UI chrome (sidebar, top bar, buttons) stays fixed.
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
  const projectName = project?.name ?? null;

  // Title the window after its project so the macOS Window menu lists windows by project
  // instead of N identical "Sparkle" entries. Keyed on the NAME (not just the id) so a
  // rename/relocate re-titles in place; Replace re-titles because currentProjectId is reactive.
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    // A rejection (e.g. window tearing down mid-call) must not surface as an unhandled rejection.
    getCurrentWindow()
      .setTitle(windowTitleFor(projectName))
      .catch(() => {});
  }, [projectName]);

  const activeAgentId = project?.selectedAgentId ?? null;
  // Lets the empty-state start button create a build agent exactly like the sidebar's "+ New Build
  // Agent" row does (same hook → same behavior).
  const spawnBuild = useSpawnBuildAgent(project);
  // Files dropped on either "+ New Build Agent" button spawn a new build agent with the files
  // attached to ITS composer. Mounted here (not in a composer) so it also works when no agent
  // exists yet — the empty-state button has no active composer to piggyback on.
  useNewBuildAgentDrop(project);

  // Only mount THIS window's project's agents. Each window owns one project; mounting every
  // project's agents in every window would attach two xterms to the same PTY.
  const live: Array<{ project: Project; agent: AgentTab }> = [];
  if (project) {
    for (const a of project.agents) {
      if (openAgentIds.includes(a.id)) live.push({ project, agent: a });
    }
  }
  const activeIsOpen = activeAgentId !== null && openAgentIds.includes(activeAgentId);
  // Improve Sparkle is per-window: each window shows/hides its OWN copy (activeSpecial lives in
  // the per-window uiStore, and the pane is keyed by this window's sparkleAgentId), so no
  // main-window gate is needed — distinct ids mean distinct worktrees/PTYs, never a double-mount.
  const sparkleActive = activeSpecial === "sparkle";
  const sparkleOpen = openAgentIds.includes(sparkleAgentId);
  // The read-only Tasks board (bead sparkle-hiju.10) is a project-scoped special view: it covers
  // the agent panes for the current project, the same slot Sparkle uses. Only meaningful with a
  // project open, and only when the Beads tool ([tools].beads) is enabled — off means the board is
  // used nowhere (AgentSidebar hides the Plan chevron and reconciles mode away from it).
  const beadsEnabled = useSettingsStore((s) => s.beadsEnabled);
  const boardActive = activeSpecial === "board" && !!project && beadsEnabled;

  const finishClose = async (mode: "keep" | "kill") => {
    // Dismiss the prompt immediately so a second click on Keep/Kill (the handler awaits below)
    // can't re-enter this flow.
    setClosing(false);
    const win = getCurrentWindow();
    // "Keep agents running" keeps a project's PTYs alive only while the app PROCESS lives:
    // closing a non-last window destroys it but the app stays up (other windows), so its agents
    // survive; the LAST window is hidden (not destroyed) to keep the process — and thus every
    // project's kept agents — alive. Choosing "Kill … & close" on the last window quits the app,
    // which necessarily stops all other projects' kept agents too (standard app-quit semantics).
    // NOTE: isLast is read from getAllWindows() after an await; two windows closing in the same
    // frame could both see >1 and both destroy. That's human-impossible at our operating point
    // and only degrades to the normal last-window-quit; a Rust-side last-window check would be
    // the robust fix if it ever matters.
    const all = await getAllWindows();
    const plan = planWindowClose(mode, all.length <= 1, isMainWindow);
    if (plan.killAgents && project) await killProjectAgents(project);
    // Keep the registry mapping when only hiding, so a later open can find and reveal the hidden
    // window (the Rust RunEvent::Reopen handler re-shows it on Dock click).
    if (plan.clearRegistry) {
      clearWindowProject(currentWindowLabel);
      clearWindowRoster(currentWindowLabel);
      // Drop this window from the restore snapshot — an EXPLICIT close (this destroy path) means the
      // user doesn't want it reopened next launch. Gated on clearRegistry so a HIDE (keep-agents last
      // window, or main-while-others) keeps its entry and still restores. This is the only removal
      // path: quit (Cmd+Q) never runs finishClose, so it leaves every entry intact ().
      if (currentProjectId) removeWindowSession(currentProjectId);
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
        background: C.forest,
        color: C.cream,
        fontFamily: '"IBM Plex Sans", sans-serif',
      }}
    >
      {/* Spans the very top of the app, just below the window chrome, above the sidebar + bar. */}
      <OfflineBanner />
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        <AgentSidebar project={project} />
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
          <TopBar onOpenSettings={setSettingsProject} />
        <div style={{ flex: 1, position: "relative", minHeight: 0 }}>
          {/* Each lazy surface gets its own Suspense so loading one (e.g. first board open) never
              blanks a sibling that's already mounted (the live agent panes keep their PTYs). The
              agent panes share one chunk, so a single boundary around the list is enough. */}
          <Suspense fallback={<PaneFallback />}>
            {live.map(({ project: p, agent }) => {
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
                  <AgentPane project={p} agent={agent} visible={visible} />
                </ErrorBoundary>
              );
            })}
          </Suspense>

          {sparkleOpen && (
            <Suspense fallback={<PaneFallback />}>
              <SparkleAgentPane visible={sparkleActive} agentId={sparkleAgentId} />
            </Suspense>
          )}

          {/* The Tasks board overlays the panes for the current project (sparkle-hiju.10). */}
          {boardActive && project && (
            <Suspense fallback={<PaneFallback />}>
              <BoardView project={project} />
            </Suspense>
          )}

          {!sparkleActive && !boardActive && !project && (
            <Hint title="Welcome to Sparkle">
              Create a project (top bar) and choose a folder on your Mac to start building.
            </Hint>
          )}
          {!sparkleActive && !boardActive && project && project.agents.length === 0 && (
            <Hint title={project.name}>
              {/* The same "+ New Build Agent" button as the sidebar, so the user can start a build
                  agent right here. Hovering it also lights up the sidebar's copy blue (shared
                  buildAgentHover flag), pointing at where the affordance normally lives. */}
              <div style={{ width: 240, margin: "0 auto" }}>
                <NewBuildAgentButton onClick={spawnBuild} />
              </div>
              {/* ~3 blank rows of breathing room before the tour line. */}
              <div style={{ height: 60 }} />
              <div
                style={{
                  fontSize: 24,
                  fontWeight: FONT_WEIGHT.semibold,
                  color: C.cream,
                  lineHeight: 1.5,
                }}
              >
                Press <KbdKey>⌃ Ctrl</KbdKey> key to take a tour. Happy tokenmaxxing!
              </div>
            </Hint>
          )}
          {!sparkleActive && !boardActive && project && project.agents.length > 0 && !activeAgentId && (
            <Hint title={project.name}>Pick an agent on the left.</Hint>
          )}
          {!sparkleActive && !boardActive && project && activeAgentId && !activeIsOpen && (
            <Hint title={project.name}>
              <button
                onClick={() => open(activeAgentId)}
                style={{
                  background: C.teal,
                  color: ON_BRAND_FILL,
                  border: "none",
                  borderRadius: 8,
                  padding: "10px 20px",
                  fontWeight: FONT_WEIGHT.semibold,
                  cursor: "pointer",
                  fontFamily: '"IBM Plex Sans", sans-serif',
                }}
              >
                ▶ Start this agent
              </button>
            </Hint>
          )}
          </div>
        </div>
      </div>

      {settingsProject && (
        <Suspense fallback={null}>
          <ProjectModal
            project={projects.find((p) => p.id === settingsProject.id) ?? settingsProject}
            onClose={() => setSettingsProject(null)}
          />
        </Suspense>
      )}

      {closing && (
        <ClosePrompt
          projectName={project?.name ?? "this project"}
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
      <div style={{ fontSize: 18, fontWeight: FONT_WEIGHT.semibold, color: C.cream }}>{title}</div>
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
        background: C.amber, // gold #e0982f
        color: ON_BRAND_FILL_DARK, // dark navy, constant across themes
        font: `700 15px/1 ${FONT.mono}`,
        letterSpacing: 0.5,
        padding: "3px 8px",
        borderRadius: 5,
        border: `1px solid ${ON_BRAND_FILL_DARK}`,
        boxShadow: "0 1px 3px rgba(0,0,0,0.4)",
        textTransform: "uppercase",
      }}
    >
      {children}
    </span>
  );
}
