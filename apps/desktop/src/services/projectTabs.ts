// Opening and CLOSING a project tab — the store-writing half of engine/openProjects.
//
// It lives beside services/openProjectTab (which answers "show me this project", and calls
// `markProjectOpen` on its way through) rather than inside uiStore, because closing a tab has to
// move the SELECTION too, and that lives in projectStore. uiStore deliberately can't import
// projectStore — projectStore imports uiStore, for the pin — so the code that needs both sits here.
//
// WHAT CLOSING A TAB DOES NOT DO, deliberately:
//   • it does not delete the project (removeProject is a different, destructive action reached from
//     project settings — closing must be reversible with one click, so it only hides the tab);
//   • it does not touch anything on disk;
//   • it does not kill that project's agents. Workspace mounts agent panes from
//     `projects` × the visited set × `openAgentIds` (Workspace.tsx's `live` memo) — none of which
//     this writes — so a closed project's PTYs keep running exactly as they were. A Terminal
//     unmount KILLS its PTY with no scrollback replay, so tearing them down would make [×] a quiet
//     destroyer of running work. That is the SAFE default and the reason there is no "are you sure,
//     N agents are running?" prompt: nothing is at risk. Those agents stay reachable the whole time
//     (the concierge column is cross-project and reads `projects`, not the open set), and clicking
//     one there reopens the tab via openProjectTab.
//
// The "kill every project's agents" behaviour is a DIFFERENT thing: it belongs to the app-window
// close prompt (Workspace's `plan.killAgents` / killAllOpenAgents), where the user is quitting and
// is asked explicitly. Closing a tab must never borrow it.
import { useProjectStore } from "../stores/projectStore";
import { useUiStore } from "../stores/uiStore";
import {
  closedProjectsOf,
  isProjectOpen,
  openProjectsOf,
  selectionAfterClose,
  withProjectClosed,
  withProjectOpen,
} from "../engine/openProjects";
import type { Project } from "../types";

/** Give `projectId` a tab if it doesn't have one. Idempotent, and cheap enough to call on every
 *  "open this project" path — which is what makes a closed project reopen from ANY surface that
 *  reveals it (the "+" flow, a concierge alert, a notification, ⌘K history, the tray). */
export function markProjectOpen(projectId: string): void {
  const ui = useUiStore.getState();
  // ALREADY OPEN → write NOTHING. Two reasons, and the second is the important one:
  //   • this runs on every tab click, so an unconditional write would churn the persisted UI blob
  //     and re-render every open-set subscriber for a state change that didn't happen;
  //   • it keeps the set `null` until the user actually CLOSES something. Seeding on an ordinary
  //     click would freeze the open set to whatever projects happened to be in the store at that
  //     instant, so any project arriving afterwards (a cross-webview merge landing late) would
  //     silently render no tab. Closing runs at user-interaction time against a fully-hydrated
  //     list, which is the only moment the seed is safe to take.
  if (isProjectOpen(projectId, ui.openProjectIds)) return;
  const allIds = useProjectStore.getState().projects.map((p) => p.id);
  ui.setOpenProjectIds(withProjectOpen(projectId, allIds, ui.openProjectIds));
}

/**
 * Close `projectId`'s tab and land the selection on a sensible neighbour (the tab to the right,
 * else the one to the left, else nothing — see engine/openProjects.selectionAfterClose).
 *
 * Closing the LAST tab leaves `selectedProjectId` null, which is a state the shell already renders
 * properly: the "Welcome to Sparkle — open a project with the + in the tab bar" hint, with the tab
 * bar reduced to its "+" and the concierge column still there. Not a blank shell.
 */
export function closeProjectTab(projectId: string): void {
  const ui = useUiStore.getState();
  const store = useProjectStore.getState();
  const allIds = store.projects.map((p) => p.id);
  // The strip AS DISPLAYED — "sensible neighbour" is about what the user is looking at.
  const displayed = openProjectsOf(store.projects, ui.openProjectIds).map((p) => p.id);
  if (!displayed.includes(projectId)) return; // no tab to close

  ui.setOpenProjectIds(withProjectClosed(projectId, allIds, ui.openProjectIds));

  // Drop the concierge pin if it named the project we just put away: the pin is persisted and
  // load-bearing (it scopes the surfaced alerts), and with no tab there is no affordance to clear
  // it — the same reasoning, and the same fix, as projectStore.removeProject.
  if (ui.pinnedProjectId === projectId) useUiStore.getState().setPinnedProject(null);

  const next = selectionAfterClose(displayed, projectId, store.selectedProjectId);
  if (next === store.selectedProjectId) return;
  // setSelectedProject, not selectProject: moving off a closed tab is housekeeping, not the user
  // opening a project, so it must not rewrite the neighbour's recency.
  store.setSelectedProject(next);
}

/** The projects that exist but have no tab — the "+" dialog's reopen list, most recently opened
 *  first so the one you just closed is the one at the top. */
export function closedProjects(
  projects: readonly Project[],
  openIds: readonly string[] | null,
): Project[] {
  return closedProjectsOf(projects, openIds).sort((a, b) =>
    (b.lastOpenedAt ?? "").localeCompare(a.lastOpenedAt ?? ""),
  );
}
