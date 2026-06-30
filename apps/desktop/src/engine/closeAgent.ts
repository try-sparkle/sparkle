// Pure decision logic for the close-agent Ship/Save/Discard flow. Kept React/IO-free so the
// "should closing this agent prompt, or just tear it down?" rule is unit-tested in isolation; the
// modal + lifecycle shell-outs live in components/AgentSidebar.tsx + CloseAgentPrompt.tsx.
import { stageIndex, type WorkflowStageId } from "./workflowStage";
import type { BranchStatus } from "../services/branchStatus";

/** Whether closing an agent should pop the Ship/Save/Discard choice instead of silently tearing it
 *  down. Only a deliverable BUILD agent with UNMERGED work at risk prompts:
 *   - workers have their own "merged → close?" nudge, and think/shell have no worktree;
 *   - work that already landed (stage ≥ merged) is safe to close silently;
 *   - an agent that never did real work (no commits, clean tree) has nothing at risk.
 *  So we prompt iff: kind === "build" AND stage < merged AND (commits ahead OR a dirty tree). */
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
  return bs.ahead > 0 || bs.dirty;
}
