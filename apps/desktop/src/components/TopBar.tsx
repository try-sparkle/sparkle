import { useState, type CSSProperties } from "react";
import { C, AGENT_STATUS, FONT_WEIGHT } from "@sparkle/ui";
import type { AgentTabStatus, Project } from "../types";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { pickProjectFolder, basename } from "../services/dialog";
import { StatusDot } from "./StatusDot";

/** Most common status across a project's agents — drives the project's color (spec). */
function majorityStatus(
  project: Project,
  statusMap: Record<string, AgentTabStatus>,
): AgentTabStatus {
  if (project.agents.length === 0) return "stopped";
  const counts = new Map<AgentTabStatus, number>();
  for (const a of project.agents) {
    const st = statusMap[a.id] ?? "stopped";
    counts.set(st, (counts.get(st) ?? 0) + 1);
  }
  let best: AgentTabStatus = "stopped";
  let bestN = -1;
  for (const [st, n] of counts) {
    if (n > bestN) {
      bestN = n;
      best = st;
    }
  }
  return best;
}

const btn: CSSProperties = {
  background: "transparent",
  color: C.cream,
  border: `1px solid ${C.muted}`,
  borderRadius: 8,
  padding: "6px 12px",
  cursor: "pointer",
  fontSize: 13,
  fontFamily: '"IBM Plex Sans", sans-serif',
  whiteSpace: "nowrap",
};

/**
 * Top bar: the current project (name colored by the majority of its agents' statuses, with
 * a per-agent dot cluster, click to open settings) plus the Open / Recent / New project
 * actions on the same row.
 */
export function TopBar({ onOpenSettings }: { onOpenSettings: (p: Project) => void }) {
  const projects = useProjectStore((s) => s.projects);
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
  const selectProject = useProjectStore((s) => s.selectProject);
  const addProject = useProjectStore((s) => s.addProject);
  const statusMap = useRuntimeStore((s) => s.status);
  const [recentOpen, setRecentOpen] = useState(false);

  const project = projects.find((p) => p.id === selectedProjectId) ?? null;
  // Recent first (most recently opened), so the "Recent Projects" label is honest.
  const recent = [...projects].sort((a, b) =>
    (b.lastOpenedAt ?? b.createdAt).localeCompare(a.lastOpenedAt ?? a.createdAt),
  );

  const pickAndAdd = async (title: string) => {
    setRecentOpen(false);
    const path = await pickProjectFolder(title);
    if (path) addProject(basename(path), path);
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "10px 14px",
        background: C.deepForest,
        borderBottom: `1px solid ${C.forest}`,
        minHeight: 30,
        position: "relative",
      }}
    >
      {project ? (
        <>
          <button
            onClick={() => onOpenSettings(project)}
            title="Project settings (rename / move)"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              background: "transparent",
              border: "none",
              cursor: "pointer",
              padding: "2px 4px",
            }}
          >
            <StatusDot status={majorityStatus(project, statusMap)} size={10} />
            <span
              style={{
                color: AGENT_STATUS[majorityStatus(project, statusMap)].color,
                fontSize: 15,
                fontWeight: FONT_WEIGHT.semibold,
              }}
            >
              {project.name}
            </span>
          </button>
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            {project.agents.map((a) => (
              <StatusDot key={a.id} status={statusMap[a.id] ?? "stopped"} size={7} />
            ))}
          </div>
        </>
      ) : (
        <span style={{ color: C.muted, fontSize: 14 }}>No project open</span>
      )}

      {/* Push the actions to the right. */}
      <div style={{ flex: 1 }} />

      <button style={btn} onClick={() => void pickAndAdd("Open a project — choose its folder")}>
        Open Project
      </button>

      <div style={{ position: "relative" }}>
        <button
          style={{ ...btn, position: "relative", zIndex: 42 }}
          onClick={() => setRecentOpen((v) => !v)}
        >
          Recent Projects ▾
        </button>
        {recentOpen && (
          <>
            <div
              onClick={() => setRecentOpen(false)}
              style={{ position: "fixed", inset: 0, zIndex: 40 }}
            />
            <div
              style={{
                position: "absolute",
                top: "100%",
                right: 0,
                marginTop: 4,
                minWidth: 240,
                maxHeight: 360,
                overflowY: "auto",
                background: C.deepForest,
                border: `1px solid ${C.forest}`,
                borderRadius: 8,
                boxShadow: "0 12px 32px rgba(0,0,0,0.45)",
                padding: 6,
                zIndex: 41,
              }}
            >
              {recent.length === 0 && (
                <div style={{ padding: "8px 10px", color: C.muted, fontSize: 13 }}>
                  No projects yet.
                </div>
              )}
              {recent.map((p) => (
                <div
                  key={p.id}
                  onClick={() => {
                    selectProject(p.id);
                    setRecentOpen(false);
                  }}
                  title={p.rootPath}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "8px 10px",
                    borderRadius: 6,
                    cursor: "pointer",
                    background: p.id === selectedProjectId ? C.forest : "transparent",
                  }}
                >
                  <StatusDot status={majorityStatus(p, statusMap)} size={8} />
                  <span
                    style={{
                      color: C.cream,
                      fontSize: 13,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {p.name}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      <button
        style={{ ...btn, borderColor: C.teal, background: C.teal }}
        onClick={() => void pickAndAdd("New project — choose or create its folder")}
      >
        New Project
      </button>
    </div>
  );
}
