import { useEffect, useState } from "react";
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
import { ProjectModal } from "./ProjectModal";
import { SPARKLE_AGENT_ID } from "../services/sparkleAgent";

/** Top-level layout (revised): agents in the left column, the project in the top bar, and
 * the active agent's pane filling the rest. Open agents stay mounted (sessions survive
 * tab/project switches); only the active one is visible. */
export function Workspace() {
  const projects = useProjectStore((s) => s.projects);
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
  const openAgentIds = useRuntimeStore((s) => s.openAgentIds);
  const open = useRuntimeStore((s) => s.open);
  const reconcile = useRuntimeStore((s) => s.reconcile);
  const activeSpecial = useUiStore((s) => s.activeSpecial);
  const [settingsProject, setSettingsProject] = useState<Project | null>(null);
  const zoomIn = useUiStore((s) => s.zoomIn);
  const zoomOut = useUiStore((s) => s.zoomOut);
  const resetZoom = useUiStore((s) => s.resetZoom);

  // On boot, drop any persisted open-agent ids whose agent no longer exists (e.g. deleted
  // between launches) so a resumed session can't reference a vanished agent (bead ).
  // projectStore hydrates synchronously from localStorage, so the first commit has the full set.
  useEffect(() => {
    const validIds = projects.flatMap((p) => p.agents.map((a) => a.id));
    // The Sparkle agent is app-owned (never in a project's `agents`), so whitelist its id or
    // reconcile would drop it from the persisted open set on every boot.
    reconcile([...validIds, SPARKLE_AGENT_ID]);
    // If the Sparkle view was active at last quit, re-mount its pane so it resumes.
    if (useUiStore.getState().activeSpecial === "sparkle") open(SPARKLE_AGENT_ID);
    // Run once on mount; the persisted open set is reconciled against the hydrated projects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const project = projects.find((p) => p.id === selectedProjectId) ?? null;
  const activeAgentId = project?.selectedAgentId ?? null;

  const live: Array<{ project: Project; agent: AgentTab }> = [];
  for (const p of projects) {
    for (const a of p.agents) {
      if (openAgentIds.includes(a.id)) live.push({ project: p, agent: a });
    }
  }
  const activeIsOpen = activeAgentId !== null && openAgentIds.includes(activeAgentId);
  // The Sparkle self-improvement agent is a global singleton, not tied to a project. It mounts
  // once opened and stays alive; only its visibility flips with the special-view selection.
  const sparkleActive = activeSpecial === "sparkle";
  const sparkleOpen = openAgentIds.includes(SPARKLE_AGENT_ID);

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
              visible={!sparkleActive && p.id === selectedProjectId && agent.id === activeAgentId}
            />
          ))}

          {sparkleOpen && <SparkleAgentPane visible={sparkleActive} />}

          {!sparkleActive && !project && (
            <Hint title="Welcome to Sparkle">
              Create a project (top bar) and choose a folder on your Mac to start building.
            </Hint>
          )}
          {!sparkleActive && project && project.agents.length === 0 && (
            <Hint title={project.name}>Add an agent (left) to begin.</Hint>
          )}
          {!sparkleActive && project && project.agents.length > 0 && !activeAgentId && (
            <Hint title={project.name}>Pick an agent on the left.</Hint>
          )}
          {!sparkleActive && project && activeAgentId && !activeIsOpen && (
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
