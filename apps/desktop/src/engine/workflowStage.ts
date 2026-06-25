// The "Domino's-tracker" workflow model: the five stages a unit of work passes through on its
// way from a scratch edit to landed-on-main, plus the pure logic that decides which stage an
// agent is in and how a build agent rolls up its workers. Kept free of React so it's unit-tested
// in isolation — the chevron UI lives in components/WorkflowTracker.tsx.
import type { BranchStatus } from "../services/branchStatus";
import { C } from "../theme/colors";

// Ordered earliest → final. Order is load-bearing: stageIndex/rollup/dominant all rely on it.
export type WorkflowStageId =
  | "uncommitted"
  | "committed"
  | "pull_request"
  | "main"
  | "merged";

export interface WorkflowStageMeta {
  id: WorkflowStageId;
  label: string; // full readout, e.g. "Pull Request"
  short: string; // compact label for tight columns
  color: string; // the stage's lit color once reached
}

// The path to green. Colors are chosen so the bar visibly "warms up" toward done: amber while
// the work is loose in the tree, brand cyan once it's committed, violet in review, brand blue
// when it lands on the integration branch, and success green when it's merged. Stages NOT yet
// reached render grayed out (see WorkflowTracker); reached stages light up in their own color.
// (These are literal brand hex from @sparkle/ui — safe to read in tests, no CSS var() here.)
export const WORKFLOW_STAGES: readonly WorkflowStageMeta[] = [
  { id: "uncommitted", label: "Uncommitted", short: "Uncommitted", color: C.amber }, // orange — edits in the tree, not yet saved
  { id: "committed", label: "Committed", short: "Committed", color: C.accent }, //       cyan — commits exist on the branch
  { id: "pull_request", label: "Pull Request", short: "PR", color: C.violet }, //        violet — a PR is open for review
  { id: "main", label: "On Main", short: "Main", color: C.teal }, //                     blue — landed on the integration branch
  { id: "merged", label: "Merged", short: "Merged", color: C.success }, //               green — done, the end of the path
] as const;

export function stageIndex(id: WorkflowStageId): number {
  return WORKFLOW_STAGES.findIndex((s) => s.id === id);
}

// Clamp-and-fetch so callers never juggle `undefined` (every WorkflowStageId is in range, and an
// out-of-range index — e.g. from Math.max — clamps to the ends rather than crashing).
function stageAt(idx: number): WorkflowStageMeta {
  const clamped = Math.max(0, Math.min(idx, WORKFLOW_STAGES.length - 1));
  return WORKFLOW_STAGES[clamped] as WorkflowStageMeta;
}

export function stageMeta(id: WorkflowStageId): WorkflowStageMeta {
  return stageAt(stageIndex(id));
}

// What we can prove from local git state ALONE (no network, no PR/merge knowledge):
//   - the branch has commits ahead of its base                       → Committed
//   - no commits yet, but there are changes in the tree              → Uncommitted
//   - nothing at all yet                                             → Uncommitted (the start line)
// Pull Request / On Main / Merged can't be inferred from ahead/behind/dirty — those are advanced
// explicitly via an override (see resolveStage), wired later to PR detection / the orchestration
// bridge. Committed wins over a dirty tree on purpose: once a branch HAS commits, the bar reflects
// how far the branch has gotten, and a fresh uncommitted edit on top shouldn't drag it backwards.
export function gitDerivedStage(bs?: BranchStatus | null): WorkflowStageId {
  if (!bs) return "uncommitted";
  if (bs.ahead > 0) return "committed";
  // No commits yet — a clean OR a dirty/changed tree both sit at the start line (Uncommitted).
  // There's no earlier stage to fall to, so this is the floor for any pre-commit branch.
  return "uncommitted";
}

// The stage to actually show: the furthest-along of (what git proves) and (any explicit override).
// `override` is how PR/main/merged get represented before we can derive them — null/undefined means
// "no signal, trust git". We never regress below what git proves, and never below the start line.
export function resolveStage(
  bs?: BranchStatus | null,
  override?: WorkflowStageId | null,
): WorkflowStageId {
  const derived = stageIndex(gitDerivedStage(bs));
  const ovr = override ? stageIndex(override) : -1;
  return stageAt(Math.max(derived, ovr, 0)).id;
}

export type StageCounts = Record<WorkflowStageId, number>;

export interface WorkflowRollup {
  // Overall stage for the build agent's own chevron = the LEAST-advanced worker. The whole build
  // isn't "merged" until every worker is, so the headline tracks the slowest unit — that's the
  // honest "how far along is the whole thing" the user asked for.
  stage: WorkflowStageId;
  // The most common stage among workers (ties resolve to the earliest), for the "mostly X" summary.
  dominant: WorkflowStageId;
  total: number;
  counts: StageCounts;
}

function emptyCounts(): StageCounts {
  return { uncommitted: 0, committed: 0, pull_request: 0, main: 0, merged: 0 };
}

export function rollupStages(stages: WorkflowStageId[]): WorkflowRollup | null {
  if (stages.length === 0) return null;
  const counts = emptyCounts();
  let minIdx = WORKFLOW_STAGES.length - 1;
  for (const s of stages) {
    counts[s] = (counts[s] ?? 0) + 1;
    minIdx = Math.min(minIdx, stageIndex(s));
  }
  return {
    stage: stageAt(minIdx).id,
    dominant: dominantStage(counts),
    total: stages.length,
    counts,
  };
}

// Most-represented stage; ties break to the EARLIEST stage (we only replace on a strictly greater
// count while scanning in stage order), so "3 committed, 3 merged" reads as the more cautious
// "mostly committed".
export function dominantStage(counts: StageCounts): WorkflowStageId {
  let best: WorkflowStageId = stageAt(0).id;
  let bestN = -1;
  for (const s of WORKFLOW_STAGES) {
    const n = counts[s.id] ?? 0;
    if (n > bestN) {
      bestN = n;
      best = s.id;
    }
  }
  return best;
}
