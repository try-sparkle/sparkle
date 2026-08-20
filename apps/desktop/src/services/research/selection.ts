// OPENING A RESEARCH TASK IN THE MAIN PANE — the one gesture the row and the chat pill share.
//
// The founder's ask (2026-08-17): a concierge research agent should behave "exactly like any other
// worker" — click its name and the RIGHT (main) pane shows what was sent and what is happening,
// with NOTHING expanding inline in the builder column. That routing is two coordinated writes, and
// this module is the single place that knows both, so the sidebar row and the `ResearchPill` cannot
// drift into doing it two different ways (AGENTS.md: one fix, one place).
//
// WHY TWO STATES, NOT ONE:
//   • `useResearchStore.openTaskId` — WHICH task. It already existed (the pill set it to reveal a
//     child), already polls, and already drives the row's expand/scroll gesture via `openTaskSeq`.
//   • `useUiStore.activeSpecial = "research"` — that the research pane is the ACTIVE main-pane view.
//     Reusing `activeSpecial` (the same field "sparkle" uses) is what makes selecting a worker, a
//     board, or Improve Sparkle hide the research pane for free: every one of those paths already
//     clears `activeSpecial`. See the field's doc in stores/uiStore.ts.
//
// A research task is deliberately NOT put into `projectStore.selectedAgentId`: it is not an agent
// (no worktree/branch/PTY), and that field's ~5s roster reconcile would discard a non-agent id.
import { useResearchStore } from "./store";
import { useUiStore } from "../../stores/uiStore";

/**
 * Show `taskId`'s research view in the main pane. Bumps `openTaskSeq` (so the sidebar group expands
 * and scrolls the child into view, exactly as a chat-link click always has) AND marks the research
 * pane active. Idempotent enough to be a repeat-click target: `setOpenTask` bumps the seq every time,
 * so clicking the same task again after a manual collapse still produces a visible result.
 */
export function openResearchTaskInPane(taskId: string): void {
  useResearchStore.getState().setOpenTask(taskId);
  useUiStore.getState().setActiveSpecial("research");
}

/**
 * Leave the research pane. Clears BOTH the selected task and the active-view flag, so the stage
 * falls back to whatever it would otherwise show (the selected worker's terminal, an empty state).
 * Used by the pane's own close affordance and by clicking the already-open child again.
 */
export function closeResearchPane(): void {
  useResearchStore.getState().setOpenTask(null);
  useUiStore.getState().setActiveSpecial(null);
}
