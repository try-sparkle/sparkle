import { useState } from "react";
import { C, AGENT_STATUS, FONT_WEIGHT } from "@sparkle/ui";
import type { Project } from "../types";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { removeAgentWorktree } from "../services/worktree";
import { StatusDot } from "./StatusDot";

/**
 * Left column: the current project's agents as a vertical list (spec layout, revised).
 * Each row is a status dot + the agent name rendered in that status's color; click a row
 * to open the agent, click the selected agent's name (or double-click any) to rename, ×
 * to close. "+ Agent" adds one.
 */
export function AgentSidebar({ project }: { project: Project | null }) {
  const selectAgent = useProjectStore((s) => s.selectAgent);
  const addAgent = useProjectStore((s) => s.addAgent);
  const removeAgent = useProjectStore((s) => s.removeAgent);
  const renameAgent = useProjectStore((s) => s.renameAgent);
  const open = useRuntimeStore((s) => s.open);
  const close = useRuntimeStore((s) => s.close);
  const status = useRuntimeStore((s) => s.status);
  const [editing, setEditing] = useState<string | null>(null);

  const onSelect = (id: string) => {
    if (!project) return;
    selectAgent(project.id, id);
    open(id);
  };
  const onAdd = () => {
    if (!project) return;
    const id = addAgent(project.id);
    open(id);
  };
  const onClose = (id: string) => {
    if (!project) return;
    close(id);
    removeAgent(project.id, id);
    void removeAgentWorktree(project.rootPath, id).catch(() => {});
  };

  return (
    <div
      style={{
        width: 220,
        flex: "0 0 auto",
        background: C.deepForest,
        borderRight: `1px solid ${C.forest}`,
        display: "flex",
        flexDirection: "column",
        height: "100%",
      }}
    >
      <div style={{ padding: "14px 14px 6px" }}>
        <img src="/sparkle-logo.svg" alt="Sparkle" style={{ height: 22 }} />
      </div>
      <div
        style={{
          padding: "6px 14px",
          color: C.muted,
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: 1,
          fontWeight: FONT_WEIGHT.semibold,
        }}
      >
        Agents
      </div>

      {project && (
        <button
          onClick={onAdd}
          style={{
            margin: "0 10px 8px",
            padding: "9px 12px",
            background: "transparent",
            color: C.accent,
            border: `1px dashed ${C.muted}`,
            borderRadius: 8,
            cursor: "pointer",
            fontFamily: '"IBM Plex Sans", sans-serif',
            fontSize: 14,
          }}
        >
          + Agent
        </button>
      )}

      <div style={{ flex: 1, overflowY: "auto", padding: "0 8px" }}>
        {project?.agents.map((a) => {
          const st = status[a.id] ?? "stopped";
          const color = AGENT_STATUS[st].color;
          const isActive = project.selectedAgentId === a.id;
          return (
            <div
              key={a.id}
              onClick={() => onSelect(a.id)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "8px 10px",
                borderRadius: 8,
                cursor: "pointer",
                background: isActive ? C.forest : "transparent",
                marginBottom: 2,
              }}
            >
              <StatusDot status={st} />
              {editing === a.id ? (
                <input
                  autoFocus
                  defaultValue={a.name}
                  onBlur={(e) => {
                    renameAgent(project.id, a.id, e.target.value);
                    setEditing(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                    if (e.key === "Escape") setEditing(null);
                  }}
                  onClick={(e) => e.stopPropagation()}
                  style={{
                    flex: 1,
                    background: C.deepForest,
                    color: C.cream,
                    border: `1px solid ${C.teal}`,
                    borderRadius: 4,
                    padding: "2px 6px",
                    fontSize: 13,
                    outline: "none",
                    minWidth: 0,
                  }}
                />
              ) : (
                <span
                  onClick={(e) => {
                    // Finder-style: click the selected agent's name to rename it.
                    if (isActive) {
                      e.stopPropagation();
                      setEditing(a.id);
                    }
                  }}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    setEditing(a.id);
                  }}
                  title="Click again to rename"
                  style={{
                    flex: 1,
                    // The whole name takes its status color.
                    color,
                    fontSize: 13,
                    fontWeight: isActive ? FONT_WEIGHT.semibold : FONT_WEIGHT.medium,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {a.name}
                </span>
              )}
              <span
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(a.id);
                }}
                title="Close agent"
                style={{ color: C.muted, fontSize: 15, lineHeight: 1, flex: "0 0 auto" }}
              >
                ×
              </span>
            </div>
          );
        })}
        {project && project.agents.length === 0 && (
          <div style={{ color: C.muted, fontSize: 12, padding: 10, lineHeight: 1.5 }}>
            No agents yet. Add one to start building.
          </div>
        )}
        {!project && (
          <div style={{ color: C.muted, fontSize: 12, padding: 10, lineHeight: 1.5 }}>
            Create a project to add agents.
          </div>
        )}
      </div>
    </div>
  );
}
