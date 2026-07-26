// "Open this project" in the single-window concierge shell (bead sparkle-qd80 / CM-U7).
//
// This REPLACES services/projectWindows.openProjectInWindow at every live call site. There is one
// window now and every project is a TAB across its top, so "open a project" is no longer a window
// operation at all — it is a store write: select the project tab (and, when a specific agent was
// asked for, select + mount that agent inside it).
//
// Why a service and not an inline store call: several surfaces open projects (the tab bar, the
// sidebar's other-window rows, history search, the ⌘K palette, the menu-bar tray), and they must
// land the user in exactly the same place. The tray runs in its OWN webview — its store writes
// reach the main window through the cross-window sync, but the main window still has to be raised —
// so the cross-context path is kept here too, next to the in-window one.
//
// (services/projectWindows.ts survives for now, unmounted, and is deleted by the legacy-purge unit.)
import { useProjectStore } from "../stores/projectStore";
import { useUiStore } from "../stores/uiStore";
import { selectAndOpen } from "./agentReveal";
import { emitFocusAgent, emitSelectProject } from "./attention";

/**
 * Select `projectId`'s tab. With `agentId`, also leave any Plan/Sparkle overlay, switch to Build,
 * mount that agent's pane and select it — the same landing a notification click performs
 * (useAttentionNotifications.selectAndOpen), so every "show me that agent" path agrees.
 *
 * Selecting a tab bumps the project's recency (projectStore.selectProject), which is what keeps the
 * tab order's "most recently used" reading honest.
 */
export function openProjectTab(projectId: string, agentId?: string | null): void {
  const store = useProjectStore.getState();
  if (!store.projects.some((p) => p.id === projectId)) return; // unknown/deleted project — no-op
  store.selectProject(projectId);
  // `activeSpecial` is APP-global, not per-project. Improve Sparkle ("sparkle") is an app-owned
  // pane that covers column ③ — leaving it up means clicking another project's tab visibly does
  // NOTHING, because the Sparkle pane is still the thing on screen. Clear it here, on the one path
  // every tab selection goes through. "board" is deliberately kept ON THIS BRANCH: the Plan board
  // is a per-project view, so following the user onto the new project's board is what Plan mode
  // means. (The agent branch below is different — a reveal has to SHOW the agent, so selectAndOpen
  // leaves every overlay, board included, and switches to Build.)
  //
  // The two states have to move together: `boardActive` requires `activeSpecial === "board"`, so
  // dropping the Sparkle pane while `workMode` is still "plan" would leave Plan selected with a
  // Build pane on screen — a chevron that lies about what you are looking at (roborev 46291-L).
  const ui = useUiStore.getState();
  if (ui.activeSpecial === "sparkle") {
    ui.setActiveSpecial(null);
    if (ui.workMode === "plan") ui.setWorkMode("build");
  }
  if (agentId) selectAndOpen(projectId, agentId);
}

/**
 * The same intent from ANOTHER webview (the menu-bar tray popover, the capture window): those
 * contexts share the persisted stores but not the DOM, and cannot raise the app window themselves.
 *
 * Two DIFFERENT broadcasts, deliberately (roborev 46249-H1/M2):
 *  - no agent asked for → `select-project`: select the tab, raise the window, touch nothing else.
 *    This is what "Open" on a tray row means. It used to piggyback on focus-agent, which needs a
 *    target: an agent-less project (every freshly added folder — `addProject` creates `agents: []`)
 *    emitted nothing and the click did nothing, and a project WITH agents had one invented for it,
 *    which force-mounted a PTY and threw the user out of Plan/Sparkle.
 *  - an agent asked for → `focus-agent`, the genuine reveal path, and only when that agent really
 *    exists in that project (a stale tray row must not push a phantom id into `openAgentIds`).
 */
export function requestProjectTabFromOtherWindow(
  projectId: string,
  agentId?: string | null,
): void {
  const store = useProjectStore.getState();
  const project = store.projects.find((p) => p.id === projectId);
  if (!project) return;
  // Claim the selection here too: this store write is what the main window reads (through the
  // cross-window sync) to land on the right tab, even if nothing is listening for the event.
  store.selectProject(projectId);
  const target = agentId && project.agents.some((a) => a.id === agentId) ? agentId : null;
  if (target) emitFocusAgent({ projectId, agentId: target });
  else emitSelectProject({ projectId });
}
