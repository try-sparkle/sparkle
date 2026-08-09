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
import type { WorkMode } from "./workMode";

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
  // The full union, not a re-listed pair: this only forwards the mode to `topLevelAgents`, whose
  // answer is the same for every mode, so narrowing it here buys nothing and costs a type error at
  // the call site every time a mode is added.
  mode: WorkMode,
  stageOf: (id: string) => WorkflowStageId,
  statusOf: (id: string) => AgentTabStatus,
  visibleBands: Record<StatusBand, boolean>,
  /** Does this row's worktree hold anything? Forwarded straight to `groupAgentsByStage`, and it MUST
   *  be the same accessor the column passes. `local_none` sorts above `local_uncommitted`, so a
   *  caller that omits it here while the sidebar supplies it computes a different first row — the
   *  exact "selection points at a row the column is not rendering" failure this module was extracted
   *  to end (roborev 53858), just reached through the section axis instead of the band axis. */
  holdsWorkOf?: (id: string) => boolean | undefined,
): string | null {
  // NO rollup accessor here, deliberately — `statusOf` already carries it.
  //
  // This briefly called `rollupBandAccessor(agents, statusOf)`, which was wrong twice over once that
  // accessor grew its `ownStatusOf` / dismissal / in-motion inputs, none of which this call site
  // had: a head whose bubbled red the user dismissed banded `done` in the column and `needs_you`
  // here, and a head in motion with a `blocked` worker banded `running` there and `needs_you` here.
  // With a band chip toggled off, that hands selection to a row the column is not rendering — the
  // precise failure this module was extracted to end (see the header).
  //
  // The fix is not to thread four more parameters through: `publishedStatusFor` composes the rollup
  // itself now (step 5, withWorkerRollupGreen), so the map every caller already passes IS the
  // rolled-up one, and plain `bandOfStatus` on it agrees with the column by construction — green via
  // the promotion, red and orange via the pre-existing bubbling, calm via withDismissedAlerts.
  // engine/workerRollup.test.ts pins that agreement as a matrix rather than leaving it to this
  // comment. Passing a NON-published map here was already a contract violation; it still is.
  const sections = groupAgentsByStage(
    topLevelAgents(agents, mode),
    stageOf,
    statusOf,
    visibleBands,
    undefined,
    holdsWorkOf,
  );
  return flattenSections(sections)[0]?.id ?? null;
}
