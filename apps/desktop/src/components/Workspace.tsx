import { useEffect, useState } from "react";
import { getCurrentWindow, getAllWindows } from "@tauri-apps/api/window";
import { C, FONT_WEIGHT } from "../theme/colors";
import type { AgentTab, Project } from "../types";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import { AgentSidebar } from "./AgentSidebar";
import { TopBar } from "./TopBar";
import { OfflineBanner } from "./OfflineBanner";
import { AgentPane } from "./AgentPane";
import { SparkleAgentPane } from "./SparkleAgentPane";
import { BoardView } from "./BoardView";
import { ProjectModal } from "./ProjectModal";
import { ClosePrompt } from "./ClosePrompt";
import { SPARKLE_AGENT_ID } from "../services/sparkleAgent";
import {
  useCurrentProjectId,
  useIsMainWindow,
  useCurrentWindowLabel,
} from "../windowContext";
import { subscribeToCrossWindowSync } from "../services/crossWindowSync";
import { startOrchestrationListener } from "../services/orchestrationListener";
import { killProjectAgents, planWindowClose } from "../services/windowClose";
import { clearWindowProject } from "../services/windowRegistry";

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
  const projects = useProjectStore((s) => s.projects);
  const currentProjectId = useCurrentProjectId();
  const isMainWindow = useIsMainWindow();
  const currentWindowLabel = useCurrentWindowLabel();
  const openAgentIds = useRuntimeStore((s) => s.openAgentIds);
  const open = useRuntimeStore((s) => s.open);
  const reconcile = useRuntimeStore((s) => s.reconcile);
  const activeSpecial = useUiStore((s) => s.activeSpecial);
  const [settingsProject, setSettingsProject] = useState<Project | null>(null);
  const [closing, setClosing] = useState(false);
  const zoomIn = useUiStore((s) => s.zoomIn);
  const zoomOut = useUiStore((s) => s.zoomOut);
  const resetZoom = useUiStore((s) => s.resetZoom);

  // On boot, drop any persisted open-agent ids whose agent no longer exists (e.g. deleted
  // between launches) so a resumed session can't reference a vanished agent (bead ).
  // projectStore hydrates synchronously from localStorage, so the first commit has the full set.
  useEffect(() => {
    // validIds MUST stay derived from ALL projects, not just this window's current project:
    // runtimeStore.openAgentIds is shared across windows, so a window-scoped reconcile would
    // evict other windows' live PTYs from the persisted open set. Keep it global.
    const validIds = projects.flatMap((p) => p.agents.map((a) => a.id));
    // The Sparkle agent is app-owned (never in a project's `agents`), so whitelist its id or
    // reconcile would drop it from the persisted open set on every boot.
    reconcile([...validIds, SPARKLE_AGENT_ID]);
    // If the Sparkle view was active at last quit, re-mount its pane so it resumes. The Sparkle
    // singleton is owned by the main window only (gated below) so it never double-mounts across
    // windows; don't re-open it in a secondary project window.
    if (isMainWindow && useUiStore.getState().activeSpecial === "sparkle") open(SPARKLE_AGENT_ID);
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

  // Intercept the window's close (red traffic light) so we can ask keep-vs-kill before closing.
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    let unlisten: undefined | (() => void);
    void getCurrentWindow()
      .onCloseRequested((event) => {
        event.preventDefault();
        setClosing(true);
      })
      .then((u) => (unlisten = u));
    return () => unlisten?.();
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
  const activeAgentId = project?.selectedAgentId ?? null;

  // Only mount THIS window's project's agents. Each window owns one project; mounting every
  // project's agents in every window would attach two xterms to the same PTY.
  const live: Array<{ project: Project; agent: AgentTab }> = [];
  if (project) {
    for (const a of project.agents) {
      if (openAgentIds.includes(a.id)) live.push({ project, agent: a });
    }
  }
  const activeIsOpen = activeAgentId !== null && openAgentIds.includes(activeAgentId);
  // The Sparkle self-improvement agent is a global singleton. Gate it to the main window so it
  // never double-mounts across windows.
  const sparkleActive = isMainWindow && activeSpecial === "sparkle";
  const sparkleOpen = isMainWindow && openAgentIds.includes(SPARKLE_AGENT_ID);
  // The read-only Tasks board (bead sparkle-hiju.10) is a project-scoped special view: it covers
  // the agent panes for the current project, the same slot Sparkle uses. Only meaningful with a
  // project open.
  const boardActive = activeSpecial === "board" && !!project;

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
    if (plan.clearRegistry) clearWindowProject(currentWindowLabel);
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
          {live.map(({ project: p, agent }) => (
            <AgentPane
              key={agent.id}
              project={p}
              agent={agent}
              visible={!sparkleActive && !boardActive && agent.id === activeAgentId}
            />
          ))}

          {sparkleOpen && <SparkleAgentPane visible={sparkleActive} />}

          {/* The Tasks board overlays the panes for the current project (sparkle-hiju.10). */}
          {boardActive && project && <BoardView project={project} />}

          {!sparkleActive && !boardActive && !project && (
            <Hint title="Welcome to Sparkle">
              Create a project (top bar) and choose a folder on your Mac to start building.
            </Hint>
          )}
          {!sparkleActive && !boardActive && project && project.agents.length === 0 && (
            <Hint title={project.name}>Add an agent (left) to begin.</Hint>
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
                  color: C.cream,
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
        <ProjectModal
          project={projects.find((p) => p.id === settingsProject.id) ?? settingsProject}
          onClose={() => setSettingsProject(null)}
        />
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
