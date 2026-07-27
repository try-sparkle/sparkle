// Pure decision logic for the close-agent Ship/Save/Discard flow. Kept React/IO-free so the
// "should closing this agent prompt, or just tear it down?" rule is unit-tested in isolation; the
// modal + lifecycle shell-outs live in components/AgentSidebar.tsx + CloseAgentPrompt.tsx.
import { stageIndex, type WorkflowStageId } from "./workflowStage";
import { firstVisibleAgentId } from "./agentOrdering";
import type { BranchStatus } from "../services/branchStatus";
import type { AgentKind } from "../types";

/** Whether closing an agent should pop the Ship/Save/Discard choice instead of silently tearing it
 *  down. Only a deliverable BUILD agent with UNMERGED work at risk prompts:
 *   - workers have their own "merged → close?" nudge, and think/shell have no worktree;
 *   - work that already landed ON ORIGIN (stage ≥ merged) is safe to close silently;
 *   - an agent that never did real work (no commits, clean tree) has nothing at risk.
 *  So we prompt iff: kind === "build" AND stage < merged AND (commits ahead OR a dirty tree).
 *  Note `merged` means ORIGIN main since the merged_local split, so work landed only on LOCAL main
 *  now prompts. That's deliberate: unpushed work IS still at risk, which is the whole reason the
 *  stage was split. */
export function shouldPromptOnClose(
  kind: string,
  stage: WorkflowStageId,
  bs: BranchStatus | undefined,
): boolean {
  if (kind !== "build") return false;
  if (stageIndex(stage) >= stageIndex("merged")) return false;
  // Status not yet polled (undefined) ⇒ we can't rule out work at risk, so err toward the choice
  // rather than a silent teardown that could discard uncommitted changes. The undefined window is
  // sub-second after open (the poll sets it immediately), so this rarely surfaces a needless prompt.
  if (!bs) return true;
  // SAFETY side of sparkle-xk3x, and the OPPOSITE call from runtimeStore's attribution gate. A
  // worktree parked on another branch still physically holds whatever was uncommitted when it
  // was moved — parking carries those files along. So a parked tree is work we cannot rule out,
  // exactly like the `!bs` case above: prompt rather than tear down. Never suppress `dirty` here
  // on the grounds that it "belongs to another branch" — the files are real and deleting the
  // worktree destroys them.
  if (bs.worktreeOnBranch === false) return true;
  return bs.ahead > 0 || bs.dirty;
}

/** Minimal agent shape `selectionAfterClose` reads. */
export type CloseSelectionAgent = {
  id: string;
  kind: AgentKind;
  parentId: string | null;
};

/**
 * Decide selection after a close. `removedRootId` (and its workers, enumerated from the
 * pre-removal `agentsBefore`) just left the store; `agentsAfter` is the post-removal list.
 *
 *  - If the agent that was OPEN (`selectedId`, or one of its workers) was torn down, re-point
 *    selection at the first visible row of the current work `mode` — or `null` (the blank
 *    first-load state with the "+ New Build Agent" CTA) when no rows remain. `removeAgent`'s own
 *    fallback is raw `agents[0]` (insertion order); this keeps the pane and sidebar in agreement.
 *  - If a row OTHER than the open one was closed, selection stays put (`reselect: false`).
 */
export function selectionAfterClose<T extends CloseSelectionAgent>(
  removedRootId: string,
  selectedId: string | null,
  agentsBefore: readonly T[],
  agentsAfter: readonly T[],
  mode: "plan" | "build",
  // The genuinely-first VISIBLE row, supplied by the caller when it knows the rendered ladder order
  // and the active status filter (the sidebar does; other callers don't). Falls back to the first
  // top-level agent in array order. Threading it as a value — rather than re-deriving an ordering
  // preference in here — is what keeps this helper pure and lets the sidebar guarantee selection
  // never lands on a row the user has filtered out of sight.
  preferredNext?: string | null,
): { reselect: boolean; next: string | null } {
  const removed = new Set<string>([removedRootId]);
  for (const a of agentsBefore) if (a.parentId === removedRootId) removed.add(a.id);
  if (!selectedId || !removed.has(selectedId)) return { reselect: false, next: selectedId };
  // Only trust `preferredNext` if that agent actually survived the close.
  const survives = preferredNext != null && agentsAfter.some((a) => a.id === preferredNext);
  return {
    reselect: true,
    next: survives ? preferredNext : firstVisibleAgentId(agentsAfter, mode),
  };
}
