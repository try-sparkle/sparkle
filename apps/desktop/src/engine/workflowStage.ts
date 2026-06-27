// The "Domino's-tracker" workflow model: the five stages a unit of work passes through on its
// way from a scratch edit to landed-on-main, plus the pure logic that decides which stage an
// agent is in and how a build agent rolls up its workers. Kept free of React so it's unit-tested
// in isolation — the chevron UI lives in components/WorkflowTracker.tsx.
import type { BranchStatus, WorkflowState } from "../services/branchStatus";
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
  detail: string; // one-line explainer shown in the expanded (hovered) row
}

// The path to green. Colors are chosen so the bar visibly "warms up" toward done: amber while
// the work is loose in the tree, brand cyan once it's committed, violet in review, brand blue
// when it lands on the integration branch, and success green when it's merged. Stages NOT yet
// reached render grayed out (see WorkflowTracker); reached stages light up in their own color.
// (These are literal brand hex from @sparkle/ui — safe to read in tests, no CSS var() here.)
export const WORKFLOW_STAGES: readonly WorkflowStageMeta[] = [
  { id: "uncommitted", label: "Uncommitted", short: "Uncommitted", color: C.amber, detail: "Uncommitted: if you close this agent now, you'll lose this work." }, // orange — edits in the tree, not yet saved
  { id: "committed", label: "Committed", short: "Committed", color: C.accent, detail: "Committed: saved to this agent's branch — closing keeps the branch." }, //       cyan — commits exist on the branch
  { id: "pull_request", label: "Pull Request", short: "PR", color: C.violet, detail: "Pull Request: a PR is open for review on GitHub." }, //        violet — a PR is open for review
  { id: "main", label: "On Main", short: "Main", color: C.teal, detail: "On Main: merged into the integration branch (main)." }, //                     blue — landed on the integration branch
  { id: "merged", label: "Merged", short: "Merged", color: C.success, detail: "Merged: done — this work has shipped to main." }, //               green — done, the end of the path
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

// Everything we know about an agent at poll time, fed into the live stage derivation below.
export interface LiveStageInputs {
  // "build" | "worker" | etc. Only "worker" uses the parent-branch / parent-reached-main signals;
  // every other worktree-bearing kind lands relative to the project's own main.
  kind: string;
  bs?: BranchStatus | null; // ahead/behind/dirty (drives Uncommitted/Committed)
  ws?: WorkflowState | null; // reachability + PR probe (drives Pull Request/On Main/Merged)
  prev?: WorkflowStageId | null; // the stage already recorded — derivation never regresses below it
  // For a worker: has its parent orchestrator's OWN work reached main? That's the worker's "Merged"
  // under worktree-relative semantics (its work shipped once the orchestrator's branch landed).
  parentReachedMain?: boolean;
}

// Derive the live stage from all available signals, monotonically (never below `prev`). The order
// of precedence, strongest first:
//   • GitHub PR merged                      → Merged      (authoritative)
//   • reachability into main/origin/parent  → On Main / Merged  (best-effort, GATED on real work)
//   • GitHub PR open                        → Pull Request
//   • local git ahead/dirty                 → Committed / Uncommitted
// The reachability gate ("did this agent actually do work?") is `committedSeen`: a fresh branch's
// tip trivially sits in main, so we only believe "landed" once we've observed commits. We take that
// from three angles so the gate matches its intent regardless of which base `bs.ahead` was measured
// against: `bs.ahead>0` (ahead of the agent's baseBranch), `ws.aheadOfBase>0` (commits the agent
// authored vs the ref it was cut from — origin/<default> when present; matters when baseBranch ≠
// default, and counts only authored work so a stale local default can't read as landed), or the
// in-session watermark `prev ≥
// Committed`. The watermark is why `prev` matters beyond monotonicity: it remembers work existed
// after a merge drops `ahead` to 0. KNOWN false-positive: if an agent commits, then hard-RESETS its
// branch back to main HEAD (work discarded, not merged), the watermark still believes it landed and
// shows "On Main". That's a rare, deliberate user action; we accept it rather than persisting a
// per-commit merge proof.
export function deriveLiveStage(input: LiveStageInputs): WorkflowStageId {
  const { kind, bs, ws, prev, parentReachedMain } = input;
  let idx = stageIndex(gitDerivedStage(bs));
  const prevIdx = prev ? stageIndex(prev) : -1;
  const committedSeen =
    idx >= stageIndex("committed") ||
    prevIdx >= stageIndex("committed") ||
    (ws?.aheadOfBase ?? 0) > 0;

  const bump = (id: WorkflowStageId) => {
    idx = Math.max(idx, stageIndex(id));
  };

  if (ws) {
    // PR probe — authoritative where present.
    if (ws.prState === "merged") bump("merged");
    else if (ws.prState === "open") bump("pull_request");

    // Reachability — only trusted once we know real work exists (else a no-op branch reads as
    // landed, since its tip is just main's HEAD).
    if (committedSeen) {
      if (kind === "worker") {
        if (ws.inParent) bump("main"); // merged into the orchestrator's branch
        if (parentReachedMain) bump("merged"); // …and the orchestrator's work reached main
      } else {
        if (ws.inLocalMain) bump("main"); // merged into local main
        if (ws.inOriginMain) bump("merged"); // …and pushed/landed on origin/main
      }
    }
  }

  idx = Math.max(idx, prevIdx, 0); // monotonic within a session
  return stageAt(idx).id;
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

// ── Progress-line palette (the thin line that replaced the chevrons) ─────────────────────────
// The line reproduces the sparkle.ai wordmark's gradient: the cyan of the "S" on the left
// (#34E0F0) warming to the blue of the "i" (its dotted "eye") on the right (#3E7BFF). It fills
// left→right as work advances through the five stages, so a glance reads "how far toward merged"
// from BOTH the fill length and its color deepening from cyan to blue. These two endpoints are the
// literal stops of the logo's `linearGradient` (see public/sparkle-logo.svg).
export const LINE_FROM = "#34e0f0"; // the "S" — cyan, left end of the logo gradient
export const LINE_TO = "#3e7bff"; //   the "i"/eye — blue, right end of the logo gradient

// Fraction of the bar filled at a given stage. Uncommitted already shows a short cyan stub (1/5)
// so a brand-new branch reads as "started", and Merged fills the whole bar (5/5).
export function stageFraction(stage: WorkflowStageId): number {
  return (stageIndex(stage) + 1) / WORKFLOW_STAGES.length;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
function rgbToHex(r: number, g: number, b: number): string {
  return "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
}

// Linear-interpolate the logo gradient at t∈[0,1]. Used for BOTH the fill's right edge and the
// status label, so the readout is exactly the color the line has reached at that stage.
export function lineColorAt(t: number): string {
  const clamp = Math.max(0, Math.min(1, t));
  const from = hexToRgb(LINE_FROM);
  const to = hexToRgb(LINE_TO);
  const mix = (a: number, b: number) => Math.round(a + (b - a) * clamp);
  return rgbToHex(mix(from.r, to.r), mix(from.g, to.g), mix(from.b, to.b));
}

// The color the line has reached at a given stage (its rightmost filled pixel): Uncommitted sits
// near the cyan "S"; Merged lands on the blue "i".
export function stageLineColor(stage: WorkflowStageId): string {
  return lineColorAt(stageFraction(stage));
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
