// "Open this project" in the single-window concierge shell (bead sparkle-qd80 / CM-U7).
//
// This REPLACES services/projectWindows.openProjectInWindow at every live call site. There is one
// window now and every project is a TAB across its top, so "open a project" is no longer a window
// operation at all — it is a store write: select the project tab (and, when a specific agent was
// asked for, select + mount that agent inside it).
//
// Why a service and not an inline store call: several surfaces open projects (the tab bar, history
// search, the ⌘K palette, the menu-bar tray), and they must land the user in exactly the same
// place. The tray runs in its OWN webview — its store writes
// reach the main window through the cross-window sync, but the main window still has to be raised —
// so the cross-context path is kept here too, next to the in-window one.
//
// (services/projectWindows.ts, which this replaced, has since been deleted.)
import { useProjectStore } from "../stores/projectStore";
import { useUiStore } from "../stores/uiStore";
import { selectAndOpen } from "./agentReveal";
import { emitFocusAgent, emitSelectProject } from "./attention";
import { markProjectOpen } from "./projectTabs";
import { sideOf } from "../engine/pairs";

/**
 * Select `projectId`'s tab. With `agentId`, also leave any Plan/Sparkle overlay, switch to Build,
 * mount that agent's pane and select it — the same landing a notification click performs
 * (useAttentionNotifications.selectAndOpen), so every "show me that agent" path agrees.
 *
 * Selecting a tab bumps the project's recency (projectStore.selectProject), which is what keeps the
 * tab order's "most recently used" reading honest.
 *
 * It also OPENS the tab if the project was closed (services/projectTabs.markProjectOpen), so a
 * closed project is reopened by whatever reveals it — the "+" flow's folder picker and its reopen
 * list, a concierge alert, ⌘K history, the tray's select-project broadcast — rather than only by
 * one blessed path.
 *
 * "Rather than only by one blessed path" is the goal, NOT a claim that this function is the sole
 * funnel. There are THREE seams that call markProjectOpen, and each owns the paths that reach it:
 *
 *   • this one — the "+" flow, ⌘K history, a tray select-project broadcast;
 *   • `useReplaceCurrentProject` (windowContext) — "show this project instead", used by the
 *     capture hand-off and by the notification handler WHEN the reveal changes projects;
 *   • `selectAndOpen` (services/agentReveal) — every agent reveal, unconditionally.
 *
 * The third is load-bearing and was added last, after two review rounds: the notification handler
 * USED to guard its `useReplaceCurrentProject` call with `p.projectId !== mine`, so a reveal into a
 * project that was ALREADY selected but closed reopened nothing at all. That guard is GONE — both
 * of the handler's branches now write unconditionally through `selectProjectOnItsSide`, because
 * `mine` is the RIGHT pair's selection and comparing against it skipped the write entirely for a
 * left-assigned project (roborev 55192/55196). `selectAndOpen`'s own `markProjectOpen` still stands
 * on its own: the seam should not depend on every future caller remembering.
 *
 * Spelling the division out because two successively narrower versions of this comment each claimed
 * a coverage guarantee the call sites did not provide, and the second one was documenting a live bug
 * as covered.
 */
/**
 * Select a project IN THE PAIR THAT OWNS IT — the one place that rule lives.
 *
 * `projectStore.selectProject` writes the RIGHT pair's selection. For a LEFT-assigned project that
 * is not merely the wrong slot: `Workspace`'s reconcile effect snaps `selectedProjectId` back on the
 * next commit, so the write is silently reverted and `leftProjectId` never moves — the reveal is
 * invisible and the caller believes it succeeded (roborev 55149 / 55158).
 *
 * EXTRACTED BECAUSE IT WAS COPY-PASTED AT FOUR SITES, which is exactly what `openProjectTab`'s own
 * comment says not to do — *"a per-call-site fix would be eight copies of this rule, and the ones
 * nobody remembered would keep the bug."* That prediction came true inside one commit: four copies
 * landed and the reopen path was the one nobody remembered (roborev 55192). A fifth writer of a
 * selection should be a one-line call, not a re-derivation.
 *
 * Idempotent for a project already selected on its own side, so callers need no guard.
 */
export function selectProjectOnItsSide(projectId: string): void {
  const ui = useUiStore.getState();
  if (sideOf(ui.pairAssignment, projectId) === "left") ui.setLeftProject(projectId);
  else useProjectStore.getState().selectProject(projectId);
}

/**
 * Returns whether the REVEAL LANDED — i.e. whether the caller got what it asked for.
 *
 * NOT "whether the screen changed", which an earlier version of this comment claimed and the code
 * does not support: with an `agentId` that no longer exists, this still opens and selects the
 * project (and may drop the Sparkle pane) before `selectAndOpen` reports the miss, so a `false` can
 * follow a very visible navigation. A caller that must not move the user before it knows should
 * check `agentExists` FIRST — the pattern `paletteJump` and `useAttentionNotifications` already
 * follow, and what `ConciergeHost.openAgentFromPill` does (roborev 55548).
 *
 * Both early exits below are silent by design, and a caller that cannot see them cannot tell the
 * user either; the concierge agent pill's dead click came through exactly this path. Every
 * pre-existing caller ignores the value and behaves identically.
 */
export function openProjectTab(projectId: string, agentId?: string | null): boolean {
  const store = useProjectStore.getState();
  // unknown/deleted project — no-op
  if (!store.projects.some((p) => p.id === projectId)) return false;
  markProjectOpen(projectId);
  // SELECT IT IN THE PAIR THAT ACTUALLY HOLDS IT (engine/pairs).
  //
  // `selectProject` writes `selectedProjectId`, which is the RIGHT pair's selection. Every
  // cross-app "show me this project" path lands here — attention notifications, ⌘K, history
  // search, the concierge and its tools, the tray broadcast, the "+" dialog and its reopen list —
  // so before the second pair existed, writing that one value was the whole job.
  //
  // It is not any more. For a LEFT-assigned project, writing `selectedProjectId` selects it in a
  // pair that does not list it: `resolveSideSelection` discards the id and the right pair falls
  // back to its own first project, while the left pair reads `leftProjectId` and never follows. The
  // observable bug is that clicking a notification for a left-pair agent either does nothing or
  // yanks the RIGHT pair to an unrelated project, with `selectedProjectId` pointing at something
  // invisible (roborev 55149).
  //
  // Routing here rather than at each call site is deliberate: this function exists because several
  // surfaces open projects and "they must land the user in exactly the same place". A per-call-site
  // fix would be eight copies of this rule, and the ones nobody remembered would keep the bug.
  selectProjectOnItsSide(projectId);
  const ui = useUiStore.getState();
  // `activeSpecial` is APP-global, not per-project. Improve Sparkle ("sparkle") is an app-owned
  // pane that covers column ③ — leaving it up means clicking another project's tab visibly does
  // NOTHING, because the Sparkle pane is still the thing on screen. Clear it here, on the one path
  // every tab selection goes through. "board" is deliberately kept ON THIS BRANCH: the Plan board
  // is a per-project view, so following the user onto the new project's board is what Plan mode
  // means. (The agent branch below is different — a reveal has to SHOW the agent, so selectAndOpen
  // leaves every overlay, board included, and switches to Build.)
  //
  // The two states have to move together: a column's board IS its `workMode === "plan"`, so
  // dropping the Sparkle pane while this project's column is still in Plan would leave Plan
  // selected with a Build pane on screen — a chevron that lies about what you are looking at
  // (roborev 46291-L). Scoped to the column this project actually occupies.
  //
  // UNCONDITIONAL, including when `projectId` is already selected. "Am I already on that tab?" is
  // not answerable from an id here: `addProject` selects the project it creates, so the add/clone
  // paths arrive with the ids already equal, and every cross-context caller (tray row, attention
  // notification, ⌘K, history search) means "take me to project X" whether or not X is current.
  // The one caller for which a re-click means "do nothing" is the tab bar itself, and it decides
  // that before calling in (components/ProjectTabsBar).
  if (ui.activeSpecial === "sparkle") {
    ui.setActiveSpecial(null);
    const side = sideOf(ui.pairAssignment, projectId);
    if (ui.workModeBySide[side] === "plan") ui.setWorkMode(side, "build");
  }
  // With an agent asked for, the reveal is the point: a tab selection alone, while the agent the
  // caller named is gone, is not "it worked". Without one, selecting the tab IS the whole job.
  return agentId ? selectAndOpen(projectId, agentId) : true;
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
  //
  // Deliberately NOT markProjectOpen. The open set lives in uiStore, and uiStore is NOT
  // cross-window synced — services/crossWindowSync wires projectStore and dictationStore only — so
  // the write would never reach the main window's in-memory state anyway. What it WOULD do is make
  // a secondary webview persist the whole shared `sparkle-ui` blob from its own hydrated snapshot,
  // clobbering main-window UI preferences; that hazard is exactly why the helper island keeps its
  // own small record instead (helper/helperPrefs.ts). The tab still reopens, in the right place and
  // in the main window's own uiStore: `select-project` lands in
  // useAttentionNotifications.handleSelectProject, which routes through `openProjectTab`; the
  // `focus-agent` broadcast lands in `selectAndOpen` (services/agentReveal), which calls
  // markProjectOpen itself. Naming both precisely — an earlier version of this comment credited the
  // focus-agent handler with a reopen it did not perform, which hid a real bug.
  store.selectProject(projectId);
  const target = agentId && project.agents.some((a) => a.id === agentId) ? agentId : null;
  if (target) emitFocusAgent({ projectId, agentId: target });
  else emitSelectProject({ projectId });
}
