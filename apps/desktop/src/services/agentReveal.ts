// "Show me that agent" — the one store-write sequence every reveal path shares (a notification
// click, a tray row, a history-search hit, a ⌘K jump, a concierge nudge).
//
// Lives in its own module, rather than in useAttentionNotifications where it grew up, so that
// services/openProjectTab can use it WITHOUT the two modules importing each other: the attention
// hook now listens for the tray's "select this project" broadcast and routes it through
// openProjectTab, and that cycle would otherwise run through this function.
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import { markProjectOpen } from "./projectTabs";

/** Mount the agent (so its pane exists) and make it the selected tab — and crucially REVEAL it.
 *  A cross-window "needs attention" jump lands here in the owning window, but that window may be
 *  showing a special overlay (Sparkle/Plan board) or sitting on a chevron whose mode filter HIDES
 *  this agent (the publish side advertises every red agent regardless of kind/mode, while the
 *  sidebar only paints the current mode's rows). Selecting alone would leave the agent filtered out
 *  of view — the "it's red somewhere but I can't find it" report. So leave any special overlay and
 *  switch the chevron to the agent's kind first, so the agent is actually surfaced and shown. */
export function selectAndOpen(projectId: string, agentId: string): void {
  const agent = useProjectStore
    .getState()
    .projects.find((p) => p.id === projectId)
    ?.agents.find((a) => a.id === agentId);
  // A gone agent means there is nothing to reveal: bail BEFORE touching any overlay, so a stale
  // id can't drop the Plan board while leaving workMode on plan (roborev 46353), and never enters
  // `openAgentIds` as a phantom.
  if (!agent) return;
  // A revealed agent's project MUST have a tab, or the shell shows that agent while the tab bar has
  // no tab for it and every tab reads aria-selected="false" — and it self-heals the wrong way, since
  // the next × treats a selection with no tab as stale and yanks the user elsewhere
  // (engine/openProjects.selectionAfterClose).
  //
  // It lives HERE, in the shared seam, rather than in the callers, because the callers only reopen
  // CONDITIONALLY: useAttentionNotifications guards its `setProject` with `p.projectId !== mine`
  // (:504 and :525), so a reveal into a project that is ALREADY selected but closed reopened
  // nothing. That case is reachable, not theoretical — requestProjectTabFromOtherWindow writes
  // `selectedProjectId` before emitting `focus-agent`, and projectStore IS cross-window synced with
  // synchronous storage, so the main window can already be on that project when the event lands.
  // Repro: close Beta's tab, then click Beta's agent row in the tray popover.
  //
  // Deliberately AFTER the `!agent` bail: a stale id must not resurrect a tab for a reveal that
  // isn't going to happen. Idempotent (markProjectOpen writes nothing when already open), so it is
  // free on the common path.
  markProjectOpen(projectId);
  useUiStore.getState().setActiveSpecial(null);
  // Every agent's pane is a terminal now, surfaced under the Build chevron — switch to it so the
  // revealed agent is actually shown (rather than sitting behind the Plan board).
  useUiStore.getState().setWorkMode("build");
  useRuntimeStore.getState().open(agentId);
  useProjectStore.getState().selectAgent(projectId, agentId);
}

/** Does this (projectId, agentId) pair still name a real agent? Every cross-webview broadcast is
 *  validated through this before anything is raised or opened: a stale tray row or a rogue emit
 *  would otherwise raise the window and push a phantom id into `openAgentIds` (roborev 46249-L1). */
export function agentExists(projectId: string, agentId: string): boolean {
  return (
    useProjectStore
      .getState()
      .projects.find((p) => p.id === projectId)
      ?.agents.some((a) => a.id === agentId) === true
  );
}
