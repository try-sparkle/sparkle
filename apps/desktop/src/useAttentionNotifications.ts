// Drives the dock badge + Notification Center banners off live agent status, and routes a
// notification click back to the exact worker that asked. Mounted once per window (inside the
// CurrentProjectProvider) by <AttentionController/>.
//
// Each window owns ONE project, so it only knows/reports the status of that project's agents:
//  - badge: report this window's red count; the backend sums across windows (the macOS dock
//    badge is app-global) — see attention.rs.
//  - notification: fire once when an agent crosses INTO red (newlyNeedingAttention), not on
//    every tick. Switching the window to a different project re-baselines silently so the
//    switch itself doesn't ping you for agents that were already waiting.
//  - click: the backend broadcasts attention://focus-agent to every window; the window that
//    owns that project brings itself forward and selects the agent (main adopts an orphaned
//    project no window is currently showing).
import { useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { countAttention, newlyNeedingAttention, type StatusMap } from "./engine/attention";
import { useRuntimeStore } from "./stores/runtimeStore";
import { useProjectStore } from "./stores/projectStore";
import {
  useCurrentProjectId,
  useCurrentWindowLabel,
  useIsMainWindow,
  useReplaceCurrentProject,
} from "./windowContext";
import { findWindowForProject } from "./services/windowRegistry";
import {
  reportAttentionCount,
  notifyAttention,
  onFocusAgent,
  type FocusAgentPayload,
} from "./services/attention";
import type { AgentTab, AgentTabStatus } from "./types";

/** Human phrasing for the banner body, by why the agent needs you. */
function noticeBody(status: AgentTabStatus, projectName: string): string {
  const ask = status === "approval" ? "Approve an action" : "Answer a question";
  return `${ask} · ${projectName}`;
}

/** Bring this window to the foreground (notification click landed here). */
async function bringToFront(): Promise<void> {
  try {
    const w = getCurrentWindow();
    await w.unminimize();
    await w.show();
    await w.setFocus();
  } catch (e) {
    console.debug("bringToFront failed", e);
  }
}

/** Mount the agent (so its pane exists) and make it the selected tab. */
function selectAndOpen(projectId: string, agentId: string): void {
  useRuntimeStore.getState().open(agentId);
  useProjectStore.getState().selectAgent(projectId, agentId);
}

export function useAttentionNotifications(): void {
  const status = useRuntimeStore((s) => s.status);
  const projectId = useCurrentProjectId();
  const label = useCurrentWindowLabel();
  const isMain = useIsMainWindow();
  const replace = useReplaceCurrentProject();
  const agents = useProjectStore(
    (s) => s.projects.find((p) => p.id === projectId)?.agents ?? EMPTY_AGENTS,
  );
  const projectName = useProjectStore(
    (s) => s.projects.find((p) => p.id === projectId)?.name ?? "",
  );

  // Previous status snapshot + which project it was for, so a project switch re-baselines
  // instead of firing a notification for every already-waiting agent in the new project.
  const prevStatus = useRef<StatusMap>({});
  const prevProject = useRef<string | null>(null);

  // Badge + notification side-effects, recomputed whenever status or the owned agent set changes.
  useEffect(() => {
    const ownedIds = agents.map((a) => a.id);
    reportAttentionCount(label, countAttention(status, ownedIds));

    const sameProject = prevProject.current === projectId;
    if (sameProject) {
      for (const id of newlyNeedingAttention(prevStatus.current, status, ownedIds)) {
        const agent = agents.find((a) => a.id === id);
        const st = status[id];
        if (!agent || st === undefined || projectId == null) continue;
        notifyAttention({
          projectId,
          agentId: id,
          title: agent.name,
          body: noticeBody(st, projectName),
        });
      }
    }
    prevStatus.current = status;
    prevProject.current = projectId;
  }, [status, agents, projectId, label, projectName]);

  // Report 0 on unmount so a closed window stops contributing to the badge total.
  useEffect(() => () => reportAttentionCount(label, 0), [label]);

  // Notification-click routing. Registered once; reads live window/project via refs.
  const ctx = useRef({ projectId, label, isMain, replace });
  ctx.current = { projectId, label, isMain, replace };
  useEffect(() => {
    // `onFocusAgent` resolves async; if we unmount before it does, mark cancelled so the
    // late-arriving unlisten tears down immediately instead of leaking the listener.
    let cancelled = false;
    let unlisten: undefined | (() => void);
    const handle = (p: FocusAgentPayload) => {
      const { projectId: mine, isMain: main, replace: setProject } = ctx.current;
      if (p.projectId === mine) {
        void bringToFront();
        selectAndOpen(p.projectId, p.agentId);
        return;
      }
      // Orphaned project (no window currently shows it) — the main window adopts it. Otherwise
      // the window that owns it handles this same broadcast via the `=== mine` branch above.
      if (findWindowForProject(p.projectId) == null && main) {
        setProject(p.projectId);
        selectAndOpen(p.projectId, p.agentId);
        void bringToFront();
      }
    };
    void onFocusAgent(handle).then((u) => {
      if (cancelled) u();
      else unlisten = u;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
}

// Stable empty reference so the agents selector doesn't return a fresh [] each render.
const EMPTY_AGENTS: AgentTab[] = [];
