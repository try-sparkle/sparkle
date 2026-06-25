import { useState, type CSSProperties } from "react";
import { C, AGENT_STATUS, FONT_WEIGHT, ON_BRAND_FILL } from "../theme/colors";
import type { AgentTabStatus, Project } from "../types";
import { ThemeToggle } from "./ThemeToggle";
import { AgentOrderToggle } from "./AgentOrderToggle";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import { pickProjectFolder, basename } from "../services/dialog";
import { openProjectInWindow, defaultDeps, type OpenMode } from "../services/projectWindows";
import { resolveOpenTarget, type OpenTarget } from "../services/openTarget";
import { OpenTargetDialog } from "./OpenTargetDialog";
import {
  useCurrentProjectId,
  useReplaceCurrentProject,
  useCurrentWindowLabel,
} from "../windowContext";
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

const zbtn: CSSProperties = {
  background: "transparent",
  color: C.cream,
  border: `1px solid ${C.muted}`,
  borderRadius: 6,
  padding: "6px 0",
  minWidth: 34,
  cursor: "pointer",
  fontSize: 14,
  fontFamily: '"IBM Plex Sans", sans-serif',
  textAlign: "center",
};

// Section heading inside the ⋯ menu ("Theme", "Text size").
const menuLabel: CSSProperties = {
  color: C.muted,
  fontSize: 12,
  textTransform: "uppercase",
  letterSpacing: 1,
  fontWeight: FONT_WEIGHT.semibold,
  padding: "2px 4px 8px",
};

/**
 * Top bar: the current project (name colored by the majority of its agents' statuses, with
 * a per-agent dot cluster, click to open settings) plus the Open / Recent / New project
 * actions on the same row.
 */
export function TopBar({ onOpenSettings }: { onOpenSettings: (p: Project) => void }) {
  const projects = useProjectStore((s) => s.projects);
  const addProject = useProjectStore((s) => s.addProject);
  const touchProjectOpened = useProjectStore((s) => s.touchProjectOpened);
  const currentProjectId = useCurrentProjectId();
  const replaceCurrent = useReplaceCurrentProject();
  const windowLabel = useCurrentWindowLabel();
  const statusMap = useRuntimeStore((s) => s.status);
  const zoom = useUiStore((s) => s.zoom);
  const zoomIn = useUiStore((s) => s.zoomIn);
  const zoomOut = useUiStore((s) => s.zoomOut);
  const resetZoom = useUiStore((s) => s.resetZoom);
  const [recentOpen, setRecentOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // A project waiting on a replace/new-window choice (null = dialog closed). A "new" target
  // carries a not-yet-created folder so we only persist the project once the user actually picks
  // a target — cancelling the dialog must not leave an orphan project in Recent.
  const [pending, setPending] = useState<OpenTarget | null>(null);

  const project = projects.find((p) => p.id === currentProjectId) ?? null;
  // Recent first (most recently opened), so the "Recent Projects" label is honest.
  const recent = [...projects].sort((a, b) =>
    (b.lastOpenedAt ?? b.createdAt).localeCompare(a.lastOpenedAt ?? a.createdAt),
  );

  const route = (projectId: string, mode: OpenMode) =>
    void openProjectInWindow(
      projectId,
      mode,
      defaultDeps(replaceCurrent, touchProjectOpened, windowLabel),
    );

  // Resolve a pending target to a concrete project id (creating it only now, on commit) and open.
  const resolveAndRoute = (p: OpenTarget, mode: OpenMode) => {
    const id = p.kind === "existing" ? p.id : addProject(p.name, p.path);
    route(id, mode);
  };

  // No project open in this window → skip the prompt and just take over the window.
  const openOrAsk = (p: OpenTarget) => {
    if (!currentProjectId) resolveAndRoute(p, "replace");
    else setPending(p);
  };

  const pickAndOpen = async (title: string) => {
    setRecentOpen(false);
    const picked = await pickProjectFolder(title);
    if (!picked) return;
    // Map the folder to an existing project (reuse) or a not-yet-created one — created only on
    // commit (resolveAndRoute), so cancelling adds nothing.
    openOrAsk(resolveOpenTarget(picked, projects, basename));
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

      <button style={btn} onClick={() => void pickAndOpen("Open a project — choose its folder")}>
        Open Project
      </button>

      <div style={{ position: "relative" }}>
        <button
          style={{ ...btn, position: "relative", zIndex: 42 }}
          onClick={() => setRecentOpen((v) => !v)}
        >
          Recent ▾
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
                    setRecentOpen(false);
                    openOrAsk({ kind: "existing", id: p.id });
                  }}
                  title={p.rootPath}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "8px 10px",
                    borderRadius: 6,
                    cursor: "pointer",
                    background: p.id === currentProjectId ? C.forest : "transparent",
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
        style={{ ...btn, borderColor: C.teal, background: C.teal, color: ON_BRAND_FILL }}
        onClick={() => void pickAndOpen("New project — choose or create its folder")}
      >
        New
      </button>

      {/* ⋯ menu: app text-size (zoom) controls — mirrors Cmd +/- / Cmd 0. */}
      <div style={{ position: "relative" }}>
        <button
          aria-label="More options"
          title="More options"
          style={{ ...btn, position: "relative", zIndex: 42, padding: "4px 10px", fontSize: 18, lineHeight: 1 }}
          onClick={() => setMenuOpen((v) => !v)}
        >
          ⋯
        </button>
        {menuOpen && (
          <>
            <div
              onClick={() => setMenuOpen(false)}
              style={{ position: "fixed", inset: 0, zIndex: 40 }}
            />
            <div
              style={{
                position: "absolute",
                top: "100%",
                right: 0,
                marginTop: 4,
                minWidth: 200,
                background: C.deepForest,
                border: `1px solid ${C.forest}`,
                borderRadius: 8,
                boxShadow: "0 12px 32px rgba(0,0,0,0.45)",
                padding: 8,
                zIndex: 41,
              }}
            >
              <div style={menuLabel}>Theme</div>
              <ThemeToggle />
              <div style={{ ...menuLabel, paddingTop: 12 }}>Agent order</div>
              <AgentOrderToggle />
              <div style={{ ...menuLabel, paddingTop: 12 }}>Text size</div>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <button style={zbtn} onClick={zoomOut} title="Zoom out (⌘−)">
                  −
                </button>
                <button
                  style={{ ...zbtn, flex: 1, fontVariantNumeric: "tabular-nums" }}
                  onClick={resetZoom}
                  title="Reset to 100% (⌘0)"
                >
                  {Math.round(zoom * 100)}%
                </button>
                <button style={zbtn} onClick={zoomIn} title="Zoom in (⌘+)">
                  +
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      {pending && (
        <OpenTargetDialog
          onChoose={(mode) => {
            resolveAndRoute(pending, mode);
            setPending(null);
          }}
          onCancel={() => setPending(null)}
        />
      )}
    </div>
  );
}
