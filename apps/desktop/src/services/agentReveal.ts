// "Show me that agent" — the one store-write sequence every reveal path shares (a notification
// click, a tray row, a history-search hit, a ⌘K jump, a concierge nudge).
//
// Lives in its own module, rather than in useAttentionNotifications where it grew up, so that
// services/openProjectTab can use it WITHOUT the two modules importing each other: the attention
// hook now listens for the tray's "select this project" broadcast and routes it through
// openProjectTab, and that cycle would otherwise run through this function.
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { sideOf } from "../engine/pairs";
import { isProjectOpen } from "../engine/openProjects";
import { useUiStore } from "../stores/uiStore";
import { markProjectOpen } from "./projectTabs";

/**
 * WHAT A CLICK ON A REVEAL AFFORDANCE ACTUALLY DID — three outcomes, not two.
 *
 * ══ WHY A BOOLEAN COULD NOT CARRY THIS ══════════════════════════════════════════════════════════
 * `selectAndOpen` and `openProjectTab` return `true` when their WRITES RAN. `Concierge/AgentPill`
 * consumed that same `true` as "the screen changed", and its whole "a pill click is never invisible"
 * contract rests on the difference. The two files stated OPPOSITE definitions of one boolean, in
 * their own docstrings, and the pill believed the wrong one:
 *
 *   • openProjectTab — *"Returns whether the REVEAL LANDED … NOT 'whether the screen changed',
 *     which an earlier version of this comment claimed and the code does not support."*
 *   • AgentPill.onOpenAgent — *"THE RETURN VALUE IS THE CONTRACT. `false` means nothing on screen
 *     changed."*
 *
 * Every write on the reveal path is idempotent and SKIPS when its target state already holds —
 * `markProjectOpen` returns early when the tab is open, `projectStore.selectAgent` returns early on
 * a re-select, `setWorkMode` bails on an equal value. So for an agent that is ALREADY the shown
 * agent on its own side, the whole sequence writes nothing, reports `true`, and the pill — which
 * says nothing on `true` — leaves the reader looking at an unchanged screen. That is the fifth
 * dead-end state, and it is the one the founder hit (bead sparkle-ixsb3).
 *
 * It is not an exotic state either: it is precisely what the concierge's OWN spawn leaves behind.
 * `spawnBuildAgentInProject` finishes with `landInAgent`, which selects the agent, opens it, clears
 * the overlay and sets that side to Build. The concierge then names the new agent as a pill in its
 * reply. Every condition below already holds by the time the reader can click it, so the FIRST click
 * on a freshly-spawned agent's pill is the guaranteed no-op — and when that project sits on the
 * OTHER pair from the one the reader is watching, nothing they can see moves at all.
 */
export type RevealOutcome =
  /** Something the reader can see changed — a tab, a pane, a selection, an overlay coming down. */
  | "revealed"
  /** The agent is real and is already what its side is showing. Nothing was left to write. */
  | "already-showing"
  /** No such agent in that project any more. Nothing was attempted. */
  | "gone";

/**
 * PREDICT what a reveal would do, without doing it.
 *
 * A PRE-FLIGHT READ, deliberately — the same "ASK FIRST, THEN ACT" shape `paletteJump`,
 * `useAttentionNotifications` and `ConciergeHost.openAgentFromPill` already use, and for the same
 * reason: a caller that must tell the user what happened cannot ask afterwards, because by then the
 * writes have collapsed the difference between "it was already like that" and "I just made it so".
 *
 * Pure: reads the three stores and writes nothing, so calling it is free and repeatable.
 *
 * The conditions below are the WRITES `openProjectTab` + `selectAndOpen` perform, one for one, in
 * the same order. If you add a write to either, add its condition here — a missing one makes this
 * over-report `already-showing`, which puts a "nothing moved" sentence on screen next to a screen
 * that did move. The test for that lives in services/agentReveal.test.ts.
 */
export function revealOutcomeFor(projectId: string, agentId: string): RevealOutcome {
  const ps = useProjectStore.getState();
  const project = ps.projects.find((p) => p.id === projectId);
  const agent = project?.agents.find((a) => a.id === agentId);
  if (!project || !agent) return "gone";
  const ui = useUiStore.getState();
  const side = sideOf(ui.pairAssignment, projectId);
  const alreadyShowing =
    // markProjectOpen — the tab already exists
    isProjectOpen(projectId, ui.openProjectIds) &&
    // selectProjectOnItsSide — and it is the project selected ON ITS OWN SIDE. Read per side, never
    // from `selectedProjectId` alone: that value is the RIGHT pair's selection, so comparing a
    // left-assigned project against it answers about a pair that does not hold it.
    (side === "left" ? ui.leftProjectId === projectId : ps.selectedProjectId === projectId) &&
    // selectAgent — and it is that project's shown agent
    project.selectedAgentId === agentId &&
    // runtime.open — and its pane is mounted
    useRuntimeStore.getState().openAgentIds.includes(agentId) &&
    // setActiveSpecial(null) — no app-global overlay is covering the pane
    ui.activeSpecial === null &&
    // setWorkMode(side, "build") — and that column is on Build, not the Plan board
    ui.workModeBySide[side] === "build";
  return alreadyShowing ? "already-showing" : "revealed";
}

/** Mount the agent (so its pane exists) and make it the selected tab — and crucially REVEAL it.
 *  A cross-window "needs attention" jump lands here in the owning window, but that window may be
 *  showing a special overlay (Sparkle/Plan board) or sitting on a chevron whose mode filter HIDES
 *  this agent (the publish side advertises every red agent regardless of kind/mode, while the
 *  sidebar only paints the current mode's rows). Selecting alone would leave the agent filtered out
 *  of view — the "it's red somewhere but I can't find it" report. So leave any special overlay and
 *  switch the chevron to the agent's kind first, so the agent is actually surfaced and shown. */
/**
 * Returns whether the reveal actually LANDED — false means nothing on screen changed.
 *
 * The bail below is correct and stays, but it used to be invisible to the caller, and a caller that
 * cannot tell a reveal from a no-op cannot tell the user either. That is how a concierge agent pill
 * became a dead link: it called through here, the id was gone, and the click produced nothing at
 * all with no way for the pill to know (see Concierge/AgentPill). Reporting the outcome is what
 * lets a caller say "that agent is closed" instead of appearing to do something.
 *
 * Every existing caller ignores the value and is unaffected.
 */
export function selectAndOpen(projectId: string, agentId: string): boolean {
  const agent = useProjectStore
    .getState()
    .projects.find((p) => p.id === projectId)
    ?.agents.find((a) => a.id === agentId);
  // A gone agent means there is nothing to reveal: bail BEFORE touching any overlay, so a stale
  // id can't drop the Plan board while leaving workMode on plan (roborev 46353), and never enters
  // `openAgentIds` as a phantom.
  if (!agent) return false;
  // A revealed agent's project MUST have a tab, or the shell shows that agent while the tab bar has
  // no tab for it and every tab reads aria-selected="false" — and it self-heals the wrong way, since
  // the next × treats a selection with no tab as stale and yanks the user elsewhere
  // (engine/openProjects.selectionAfterClose).
  //
  // It lives HERE, in the shared seam, rather than in the callers, because a caller's own reopen is
  // not guaranteed to run. useAttentionNotifications USED to guard its `setProject` with
  // `p.projectId !== mine`, so a reveal into a project that was ALREADY selected but closed reopened
  // nothing. Both of its branches now write unconditionally through `selectProjectOnItsSide` — which
  // is idempotent — so that particular hole is closed at the source; this call stays because the
  // seam should not depend on every future caller remembering. The race it was written for is
  // reachable, not theoretical — requestProjectTabFromOtherWindow writes
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
  // THE REVEALED AGENT'S OWN COLUMN. Switching a window-global mode used to yank whichever pair
  // happened to render the board out of Plan; the agent lives in exactly one pair, and that is the
  // only one whose chevron this reveal has any business moving.
  useUiStore.getState().setWorkMode(sideOf(useUiStore.getState().pairAssignment, projectId), "build");
  useRuntimeStore.getState().open(agentId);
  useProjectStore.getState().selectAgent(projectId, agentId);
  return true;
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
