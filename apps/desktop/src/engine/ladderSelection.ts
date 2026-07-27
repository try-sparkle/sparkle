// "Which row is at the TOP of the Build column right now" — the one derivation every selection
// path shares.
//
// WHY THIS EXISTS. Three places need to land selection on a visible row: switching Plan→Build
// (AgentSidebar + the Workspace's collapsed copy) and re-selecting after a close. Each had its own
// answer, and after the stage ladder landed all three were wrong in the same way — they used
// `firstVisibleAgentId`, which is plain `project.agents` order and knows nothing about the ladder
// or the status filter.
//
// That is not cosmetic. The filter decides VISIBILITY, so array-order selection can hand back a row
// the column is not rendering: hide "Done", switch to Plan and back, and the main pane shows a
// terminal for an agent with no row beside it. `reselectAfterClose` had a comment claiming it
// prevented exactly this, while itself passing a DIFFERENT status map (only the unstarted-worker
// overlay) and a DIFFERENT stage function (bare resolveStage, not the worker roll-up) than the
// render used — so it could disagree with the ladder too.
//
// One function, one set of inputs, no room for the three to drift apart again.
import type { AgentKind, AgentTabStatus } from "../types";
import type { WorkflowStageId } from "./workflowStage";
import { flattenSections, groupAgentsByStage, type StatusBand } from "./buildSections";
import { topLevelAgents } from "./agentOrdering";

/**
 * The id of the first row the Build column actually renders, or `null` when the ladder is empty
 * (no agents, or every band filtered off).
 *
 * `statusOf` MUST be the same overlaid map the sidebar filters on (see
 * useAttentionNotifications.publishedStatusFor) and `stageOf` the same worker-roll-up the sections
 * are built from — passing the raw versions is what made the old call sites disagree with the
 * column they were supposed to match.
 */
export function firstLadderRowId<
  T extends { id: string; kind: AgentKind; parentId: string | null },
>(
  agents: readonly T[],
  mode: "plan" | "build",
  stageOf: (id: string) => WorkflowStageId,
  statusOf: (id: string) => AgentTabStatus,
  visibleBands: Record<StatusBand, boolean>,
): string | null {
  const sections = groupAgentsByStage(topLevelAgents(agents, mode), stageOf, statusOf, visibleBands);
  return flattenSections(sections)[0]?.id ?? null;
}
