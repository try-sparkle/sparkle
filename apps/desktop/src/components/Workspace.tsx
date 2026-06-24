import { useState } from "react";
import { C, FONT_WEIGHT } from "@sparkle/ui";
import type { AgentTab, Project } from "../types";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { AgentSidebar } from "./AgentSidebar";
import { TopBar } from "./TopBar";
import { AgentPane } from "./AgentPane";
import { ProjectModal } from "./ProjectModal";

/** Top-level layout (revised): agents in the left column, the project in the top bar, and
 * the active agent's pane filling the rest. Open agents stay mounted (sessions survive
 * tab/project switches); only the active one is visible. */
export function Workspace() {
  const projects = useProjectStore((s) => s.projects);
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
  const openAgentIds = useRuntimeStore((s) => s.openAgentIds);
  const open = useRuntimeStore((s) => s.open);
  const [settingsProject, setSettingsProject] = useState<Project | null>(null);

  const project = projects.find((p) => p.id === selectedProjectId) ?? null;
  const activeAgentId = project?.selectedAgentId ?? null;

  const live: Array<{ project: Project; agent: AgentTab }> = [];
  for (const p of projects) {
    for (const a of p.agents) {
      if (openAgentIds.includes(a.id)) live.push({ project: p, agent: a });
    }
  }
  const activeIsOpen = activeAgentId !== null && openAgentIds.includes(activeAgentId);

  return (
    <div
      style={{
        display: "flex",
        height: "100vh",
        width: "100vw",
        background: C.forest,
        color: C.cream,
        fontFamily: '"IBM Plex Sans", sans-serif',
      }}
    >
      <AgentSidebar project={project} />
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <TopBar onOpenSettings={setSettingsProject} />
        <div style={{ flex: 1, position: "relative", minHeight: 0 }}>
          {live.map(({ project: p, agent }) => (
            <AgentPane
              key={agent.id}
              project={p}
              agent={agent}
              visible={p.id === selectedProjectId && agent.id === activeAgentId}
            />
          ))}

          {!project && (
            <Hint title="Welcome to Sparkle">
              Create a project (top bar) and choose a folder on your Mac to start building.
            </Hint>
          )}
          {project && project.agents.length === 0 && (
            <Hint title={project.name}>Add an agent (left) to begin.</Hint>
          )}
          {project && project.agents.length > 0 && !activeAgentId && (
            <Hint title={project.name}>Pick an agent on the left.</Hint>
          )}
          {project && activeAgentId && !activeIsOpen && (
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
