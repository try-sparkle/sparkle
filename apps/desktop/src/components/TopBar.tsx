import { useState, useEffect, useMemo, type CSSProperties } from "react";
import { C, AGENT_STATUS, FONT_WEIGHT, ON_BRAND_FILL, statusInk } from "../theme/colors";
import type { AgentTabStatus, Project } from "../types";
import { SettingsDialog } from "./SettingsDialog";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import { orderedTopLevelAgents } from "../engine/agentOrdering";
import { withUnstartedWorkerAttention } from "../engine/workerAttention";
import { pickProjectFolder, basename } from "../services/dialog";
import { openProjectInWindow, defaultDeps, type OpenMode } from "../services/projectWindows";
import { findWindowForProject } from "../services/windowRegistry";
import { resolveOpenTarget, type OpenTarget } from "../services/openTarget";
import { OpenTargetDialog } from "./OpenTargetDialog";
import { ModalShell } from "./ModalShell";
import { AccountsScreen } from "./AccountsScreen";
import { AccountLoginModal } from "./AccountLoginModal";
import { invalidateAccountState } from "../services/accountSelection";
import type { Account } from "../services/accountStore";
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

/** One mark in the TopBar cluster: a top-level agent ("dot") or one of its workers ("half"). */
export type AgentDot = { id: string; status: AgentTabStatus; shape: "dot" | "half" };

/**
 * The TopBar dot cluster must TRACK the sidebar rows, not the raw `project.agents` array.
 * So both consume the SAME `orderedTopLevelAgents` (top-level agents, mode-filtered, attention-
 * ordered); here we then splice each build agent's workers in right after it — workers as
 * half-discs ("D"), so a sub-agent reads as nested under the full dot it follows. (Plan mode
 * lists no agents in the sidebar, so we fall back to the Build set to keep the header
 * status glanceable.)
 */
export function agentDots(
  project: Project,
  statusMap: Record<string, AgentTabStatus>,
  workMode: "think" | "plan" | "build",
  attentionOrder: boolean,
): AgentDot[] {
  const ordered = orderedTopLevelAgents(project.agents, statusMap, workMode, attentionOrder);
  const dots: AgentDot[] = [];
  for (const top of ordered) {
    dots.push({ id: top.id, status: statusMap[top.id] ?? "stopped", shape: "dot" });
    if (top.kind === "build") {
      for (const w of project.agents.filter((a) => a.parentId === top.id)) {
        dots.push({ id: w.id, status: statusMap[w.id] ?? "stopped", shape: "half" });
      }
    }
  }
  return dots;
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
  const addProject = useProjectStore((s) => s.addProject);
  const touchProjectOpened = useProjectStore((s) => s.touchProjectOpened);
  const currentProjectId = useCurrentProjectId();
  const replaceCurrent = useReplaceCurrentProject();
  const windowLabel = useCurrentWindowLabel();
  const statusMap = useRuntimeStore((s) => s.status);
  const openAgentIds = useRuntimeStore((s) => s.openAgentIds);
  // A spawned-but-never-started worker has no live status, so it would render GRAY and hide the
  // fact that it's blocking its orchestrator. Overlay RED on it and its parent before computing any
  // dot/summary color, so the block surfaces at the top. Per-project (openAgentIds is global).
  const openSet = useMemo(() => new Set(openAgentIds), [openAgentIds]);
  const effStatus = (p: Project): Record<string, AgentTabStatus> =>
    withUnstartedWorkerAttention(p.agents, statusMap, openSet);
  const workMode = useUiStore((s) => s.workMode);
  const agentOrdering = useUiStore((s) => s.agentOrdering);
  const [recentOpen, setRecentOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // The settings modal is a true centered dialog now, so Escape should dismiss it (backdrop click
  // alone isn't enough for keyboard users). Only listen while it's open.
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);
  // Multi Claude Max account support: the "Claude accounts" settings modal, and (when the user adds
  // an account) the interactive `claude login` modal handed off from AccountsScreen's onLogin seam.
  const [accountsOpen, setAccountsOpen] = useState(false);
  const [loginAccount, setLoginAccount] = useState<Account | null>(null);
  // A pending replace/new-window choice (null = dialog closed). Two shapes:
  //   - "target": the folder is already known (Recent) — the choice just routes it.
  //   - "pick":  Open/New — we must ask the choice FIRST, then pop the folder picker. Showing the
  //     picker before this dialog is the regression we guard against: the user would hit the OS
  //     finder before ever being asked replace-vs-new-window.
  // A "new" target carries a not-yet-created folder so we only persist the project once the user
  // actually commits — cancelling the dialog must not leave an orphan project in Recent.
  const [pending, setPending] = useState<
    { type: "target"; target: OpenTarget } | { type: "pick"; title: string } | null
  >(null);

  const project = projects.find((p) => p.id === currentProjectId) ?? null;
  // The current project's dot, label, and cluster all read this — compute the overlay once instead
  // of re-spreading the status map on each call (the recent-project rows use effStatus directly; they
  // only render while the menu is open).
  const currentEff = useMemo(
    () => (project ? effStatus(project) : {}),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [project, statusMap, openSet],
  );
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
  const openOrAsk = (target: OpenTarget) => {
    if (!currentProjectId) resolveAndRoute(target, "replace");
    else setPending({ type: "target", target });
  };

  // Pop the native folder picker, then open with the already-chosen mode. Map the folder to an
  // existing project (reuse) or a not-yet-created one — created only on commit, so a cancel adds
  // nothing.
  const pickAndRoute = async (title: string, mode: OpenMode) => {
    const picked = await pickProjectFolder(title);
    if (!picked) return;
    resolveAndRoute(resolveOpenTarget(picked, projects, basename), mode);
  };

  // Open / New entry point: ask replace-vs-new-window BEFORE the folder picker when a project is
  // already open (the picker is the LAST step, not the first). With no project open there's no
  // choice to make — go straight to the picker and take over the window.
  const startOpen = (title: string) => {
    setRecentOpen(false);
    if (!currentProjectId) void pickAndRoute(title, "replace");
    else setPending({ type: "pick", title });
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
            <StatusDot status={majorityStatus(project, currentEff)} size={10} />
            <span
              style={{
                color: statusInk(AGENT_STATUS[majorityStatus(project, currentEff)].color),
                fontSize: 15,
                fontWeight: FONT_WEIGHT.semibold,
              }}
            >
              {project.name}
            </span>
          </button>
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            {agentDots(project, currentEff, workMode, agentOrdering === "attention").map((d) => (
              <StatusDot key={d.id} status={d.status} size={7} shape={d.shape} />
            ))}
          </div>
          {/* The Tasks board now opens from the "Plan" button in the agent strip (AgentSidebar). */}
        </>
      ) : (
        <span style={{ color: C.muted, fontSize: 14 }}>No project open</span>
      )}

      {/* Push the actions to the right. */}
      <div style={{ flex: 1 }} />

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
              {recent.map((p) => {
                // Is this project already showing in some OTHER window? (A live registry entry
                // whose label isn't this window's.) If so, offer a "Switch" affordance that just
                // raises that window instead of replacing/reopening anything.
                const openLabel = findWindowForProject(p.id);
                const openElsewhere = openLabel != null && openLabel !== windowLabel;
                return (
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
                    <StatusDot status={majorityStatus(p, effStatus(p))} size={8} />
                    <span
                      style={{
                        flex: 1,
                        minWidth: 0,
                        color: C.cream,
                        fontSize: 13,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {p.name}
                    </span>
                    {openElsewhere && (
                      <button
                        onClick={(e) => {
                          // Don't let the row's open-handler fire too — Switch only raises the
                          // existing window. openProjectInWindow focuses an already-open project
                          // regardless of mode, so this never spawns a duplicate.
                          e.stopPropagation();
                          setRecentOpen(false);
                          route(p.id, "new");
                        }}
                        title="Bring the window already showing this project to the front"
                        style={{
                          flex: "0 0 auto",
                          background: "transparent",
                          color: C.teal,
                          border: `1px solid ${C.teal}`,
                          borderRadius: 6,
                          padding: "2px 8px",
                          fontSize: 12,
                          cursor: "pointer",
                          fontFamily: '"IBM Plex Sans", sans-serif',
                          whiteSpace: "nowrap",
                        }}
                      >
                        Switch
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>

      <button style={btn} onClick={() => startOpen("Open a project — choose its folder")}>
        Open
      </button>

      <button
        style={{ ...btn, borderColor: C.teal, background: C.teal, color: ON_BRAND_FILL }}
        onClick={() => startOpen("New project — choose or create its folder")}
      >
        New
      </button>

      {/* ⋯ menu: opens the categorized settings dialog (SettingsDialog). */}
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
          <SettingsDialog
            onClose={() => setMenuOpen(false)}
            onManageAccounts={() => {
              setMenuOpen(false);
              setAccountsOpen(true);
            }}
          />
        )}
      </div>

      {pending && (
        <OpenTargetDialog
          onChoose={(mode) => {
            const p = pending;
            setPending(null);
            // "target": folder already known (Recent) → route it. "pick": Open/New → NOW pop the
            // folder picker, with the mode the user just chose.
            if (p.type === "target") resolveAndRoute(p.target, mode);
            else void pickAndRoute(p.title, mode);
          }}
          onCancel={() => setPending(null)}
        />
      )}

      {/* Claude accounts settings (multi Claude Max support). Closing invalidates the selection
          cache so per-agent badges pick up any add/rename/remove. */}
      {accountsOpen && (
        <ModalShell
          width={520}
          onCancel={() => {
            setAccountsOpen(false);
            invalidateAccountState();
          }}
        >
          <AccountsScreen
            onLogin={(account) => {
              // Hand off to the interactive login modal; close the accounts list behind it.
              setAccountsOpen(false);
              setLoginAccount(account);
            }}
          />
        </ModalShell>
      )}

      {/* Interactive `claude login` PTY for a just-added account (AccountsScreen onLogin seam). */}
      {loginAccount && (
        <AccountLoginModal
          account={loginAccount}
          onClose={() => {
            setLoginAccount(null);
            invalidateAccountState();
          }}
        />
      )}
    </div>
  );
}
