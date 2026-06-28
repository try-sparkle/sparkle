// Drives the dock badge + Notification Center banners off live agent status, and routes a
// notification click back to the exact worker that asked. Mounted once per window (inside the
// CurrentProjectProvider) by <AttentionController/>.
//
// Each window owns ONE project, so it only knows/reports the status of that project's agents:
//  - badge: report this window's red count; the backend sums across windows (the macOS dock
//    badge is app-global) — see attention.rs.
//  - notification: fire once when an agent crosses INTO a status the user has enabled for
//    notifications (Settings ⋯ → Notifications; newlyEntered), not on every tick. Switching the
//    window to a different project re-baselines silently so the switch itself doesn't ping you
//    for agents that were already in a notifiable status.
//  - click: the backend broadcasts attention://focus-agent to every window; the window that
//    owns that project brings itself forward and selects the agent (main adopts an orphaned
//    project no window is currently showing).
import { useEffect, useMemo, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  countAttention,
  newlyEntered,
  notificationFor,
  suppressNotification,
  type StatusMap,
} from "./engine/attention";
import { useRuntimeStore } from "./stores/runtimeStore";
import { useSettingsStore } from "./stores/settingsStore";
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
import type { AgentTab } from "./types";

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
  // Which statuses the user wants notifications for (⋯ → Notifications). Built into a Set so the
  // edge detector is a cheap membership test. Recomputed only when the prefs object changes.
  const notifyStatuses = useSettingsStore((s) => s.notifyStatuses);
  const enabled = useMemo(
    () =>
      new Set(
        (Object.keys(notifyStatuses) as Array<keyof typeof notifyStatuses>).filter(
          (k) => notifyStatuses[k],
        ),
      ),
    [notifyStatuses],
  );

  // Previous status snapshot + which project it was for, so a project switch re-baselines
  // instead of firing a notification for every already-notifiable agent in the new project.
  const prevStatus = useRef<StatusMap>({});
  const prevProject = useRef<string | null>(null);

  // Badge + notification side-effects, recomputed whenever status, the owned agent set, or the
  // notify prefs change. The badge stays strictly waiting/approval (countAttention); the banner
  // fires for any newly-entered status the user enabled.
  useEffect(() => {
    const ownedIds = agents.map((a) => a.id);
    reportAttentionCount(label, countAttention(status, ownedIds));

    const sameProject = prevProject.current === projectId;
    if (sameProject) {
      // Read live at fire time (no extra deps / re-baselining): is THIS window the OS-focused
      // window, and which of its agents is the selected tab. Together they let us suppress the
      // single "you're already looking at this exact agent" case while still firing for a
      // different agent, a background window/project, or another app in front.
      const windowFocused = typeof document !== "undefined" && document.hasFocus();
      const selectedAgentId =
        useProjectStore.getState().projects.find((p) => p.id === projectId)?.selectedAgentId ?? null;
      for (const { id, status: st } of newlyEntered(prevStatus.current, status, ownedIds, enabled)) {
        const agent = agents.find((a) => a.id === id);
        if (!agent || projectId == null) continue;
        if (suppressNotification({ windowFocused, selectedAgentId, agentId: id })) continue;
        notifyAttention({ projectId, agentId: id, ...notificationFor(st, agent.name, projectName) });
      }
    }
    prevStatus.current = status;
    prevProject.current = projectId;
  }, [status, agents, projectId, label, projectName, enabled]);

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
