// The unified Think→Plan→Build lifecycle: the TEN stages a unit of work passes through, from a
// first thought to shipped-to-production, plus the pure logic that decides which stage a unit is in
// and how a build agent rolls up its workers. Kept free of React so it's unit-tested in isolation —
// the progress-line UI lives in components/WorkflowLine.tsx.
//
// Stages 1-3 (Thought/Spec'd/Planned) live in the Think + Plan tabs and are driven by what exists
// (a think doc, a spec/PRD, a bead). Stages 4-10 live in the Build tab and are derived from git/PR
// state (the proven model) plus a release "shipped" signal. A unit that's only planned (no code yet)
// sits at Planned; opening a Build agent starts there and the bar fills as work advances.
import type { BranchStatus, WorkflowState } from "../services/branchStatus";
import { C } from "../theme/colors";

// Ordered earliest → final. Order is load-bearing: stageIndex/rollup/dominant all rely on it.
export type WorkflowStageId =
  | "thought" //          1 — a Think agent exists (Think tab)
  | "specd" //            2 — a PRD/spec has been written (Think tab)
  | "planned" //          3 — decomposed into a bead (Plan tab)
  | "building_unsaved" // 4 — uncommitted changes in the tree (Build tab)
  | "building_saved" //   5 — committed to the branch (Build tab)
  | "pushed" //           6 — pushed to the remote branch (Build tab)
  | "pull_request" //     7 — a PR is open / requesting merge (Build tab)
  | "merged_local" //     8 — landed on LOCAL main, not yet on origin (Build tab)
  | "merged" //           9 — merged with origin main (Build tab)
  | "shipped"; //        10 — shipped to production / in a published release (Build tab)

export interface WorkflowStageMeta {
  id: WorkflowStageId;
  label: string; // full, friendly readout (non-technical wording)
  short: string; // compact label for tight columns
  color: string; // the stage's lit color once reached
  detail: string; // one-line explainer shown in the expanded (hovered) row
}

// The path to shipped. Friendly, non-technical labels (this is a platform for people who aren't
// git-savvy). Colors warm from teal → blue along the sparkle.ai logo gradient; un-reached stages
// render grayed out (see WorkflowLine). Literal brand hex (no CSS var()) so tests can read them.
export const WORKFLOW_STAGES: readonly WorkflowStageMeta[] = [
  { id: "thought", label: "Thought", short: "Thought", color: C.accent, detail: "Thought: an idea being explored in the Think tab." },
  { id: "specd", label: "Spec'd", short: "Spec'd", color: C.accent, detail: "Spec'd: a spec/PRD has been written for this idea." },
  { id: "planned", label: "Planned", short: "Planned", color: C.accent, detail: "Planned: broken into a tracked task on the Plan board." },
  { id: "building_unsaved", label: "Building Locally (Unsaved)", short: "Unsaved", color: C.amber, detail: "Building locally: unsaved changes — closing now loses this work." },
  { id: "building_saved", label: "Building Locally (Committed & Saved)", short: "Saved", color: C.accent, detail: "Saved: committed to this task's branch — closing keeps the branch." },
  { id: "pushed", label: "Pushed to Remote Branch", short: "Pushed", color: C.accent, detail: "Pushed: the branch is backed up on the remote." },
  { id: "pull_request", label: "Requesting to be merged (Pull Request Issued)", short: "In PR", color: C.violet, detail: "Pull Request: requesting to be merged into main, under review." },
  { id: "merged_local", label: "Merged with Local Main", short: "Local Main", color: C.teal, detail: "Merged locally: landed on your local main — not yet pushed to the remote." },
  { id: "merged", label: "Merged with Main", short: "Merged", color: C.teal, detail: "Merged: this work has landed on the remote main." },
  { id: "shipped", label: "Shipped to Production", short: "Shipped", color: C.success, detail: "Shipped: included in a published release / deployed to production." },
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
//   - the branch has commits ahead of its base      → Building (Committed & Saved)
//   - no commits yet, but there are changes / clean  → Building (Unsaved) — the build start line
// Pushed / PR / Merged / Shipped can't be inferred from ahead/behind/dirty — those come from
// explicit signals (see deriveLiveStage). Committed wins over a dirty tree on purpose: once a
// branch HAS commits, the bar reflects how far it's gotten; a fresh edit on top shouldn't regress.
export function gitDerivedStage(bs?: BranchStatus | null): WorkflowStageId {
  if (!bs) return "building_unsaved";
  if (bs.ahead > 0) return "building_saved";
  return "building_unsaved";
}

// The stage to actually show: the furthest-along of (what git proves) and (any explicit override).
// `override` is how pushed/PR/merged/shipped get represented before/independently of git derivation —
// null/undefined means "no signal, trust git". We never regress below what git proves.
export function resolveStage(
  bs?: BranchStatus | null,
  override?: WorkflowStageId | null,
): WorkflowStageId {
  const derived = stageIndex(gitDerivedStage(bs));
  const ovr = override ? stageIndex(override) : -1;
  return stageAt(Math.max(derived, ovr, 0)).id;
}

// Does this stage mean "there IS committed work that hasn't landed on (origin) main yet"? True for
// the committed-but-unlanded band — building_saved (5) through merged_local (8, on LOCAL main only) —
// and false below it (no commits: thought…building_unsaved) and at/above `merged` (9, on origin main)
// and `shipped` (10). This is the "needs you to open/merge the PR" signal that escalates a finished
// (idle/done/stopped) agent's dot to RED via engine/unmergedAttention.ts. "main" here is ORIGIN main:
// merged_local still counts as unmerged because the workflow lands via a PR to origin, so local-only
// work still needs you to get it the rest of the way. Pure.
export function hasUnmergedCommittedWork(stage: WorkflowStageId): boolean {
  const idx = stageIndex(stage);
  return idx >= stageIndex("building_saved") && idx < stageIndex("merged");
}

// Everything we know about a unit of work at poll time, fed into the live stage derivation below.
export interface LiveStageInputs {
  // "build" | "worker" | etc. Only "worker" uses the parent-branch / parent-reached-main signals.
  kind: string;
  bs?: BranchStatus | null; // ahead/behind/dirty (drives Unsaved/Saved)
  ws?: WorkflowState | null; // reachability + PR probe (drives PR/Merged)
  prev?: WorkflowStageId | null; // the stage already recorded — derivation never regresses below it
  parentReachedMain?: boolean; // worker: has the parent orchestrator's own work reached main (local or origin)?
  // worker: is the parent's work on ORIGIN main specifically? A worker's own tip is only ever in its
  // PARENT's branch, so it can never observe origin main itself — it inherits the fact from the
  // parent. Without this a worker would cap at merged_local forever, so its bead would never close
  // (beadLifecycle closes at >= merged) and the sidebar ✓ would never show.
  parentOnOriginMain?: boolean;
  // ── Planning floors (Think/Plan tabs) — a unit sits at the highest of these until code work
  //    raises it. A planned-but-unstarted bead floors at Planned even with no git work.
  hasThinkDoc?: boolean; // a Think agent/conversation exists  → floor Thought
  hasSpec?: boolean; //     a PRD/spec has been written         → floor Spec'd
  hasBead?: boolean; //     a bead exists for this unit         → floor Planned
  // ── Build signals not derivable from ahead/behind/dirty:
  pushed?: boolean; //  the branch is pushed to its remote      → at least Pushed
  shipped?: boolean; // included in a published release/deploy  → Shipped
}

// The floor stage implied by the planning signals (Think/Plan), independent of any git work.
function planningFloor(input: LiveStageInputs): number {
  if (input.hasBead) return stageIndex("planned");
  if (input.hasSpec) return stageIndex("specd");
  if (input.hasThinkDoc) return stageIndex("thought");
  return -1;
}

// Derive the live stage from all available signals, monotonically (never below `prev`). Precedence,
// strongest first: shipped → PR-merged → reachability-into-main → PR-open → pushed → git committed/
// unsaved → planning floor. The reachability gate (`committedSeen`) avoids a fresh no-op branch
// reading as "landed" (its tip is just main's HEAD). The monotonic watermark (`prev`) absorbs the
// post-merge `ahead→0` dip, except when a NEW work cycle starts (prior work landed, but fresh
// un-landed commits exist) — then the bar tracks the new cycle rather than staying pinned green.
export function deriveLiveStage(input: LiveStageInputs): WorkflowStageId {
  const { kind, bs, ws, prev, parentReachedMain, parentOnOriginMain } = input;
  // Git floor only when a worktree/branch exists (bs present). With no worktree yet there is no
  // build signal, so the planning floor (Thought/Spec'd/Planned) decides where the unit sits.
  let idx = bs ? stageIndex(gitDerivedStage(bs)) : -1;
  const prevIdx = prev ? stageIndex(prev) : -1;
  // "Real committed work has existed at some point" — the gate that stops a no-op branch (trivially
  // tree-identical to main, hence inLocalMain/landed) from reading as merged. Sourced from git ahead,
  // the persisted watermark, OR authored-vs-base commits. After a relaunch the stage store is empty
  // (no watermark) and a squash-landed branch has ahead→0 AND aheadOfBase→0, which used to collapse a
  // genuinely-landed row back to "Building Locally (Unsaved) — closing loses this work". So we also
  // trust EXPLICIT action signals: a branch that was PUSHED to its remote or ever had a PR must have
  // carried real work — and, unlike inLocalMain/landed, neither is ever true for a no-op branch, so
  // the no-op guard stays intact (sparkle bug-2, trust-live-signal).
  const committedSeen =
    idx >= stageIndex("building_saved") ||
    prevIdx >= stageIndex("building_saved") ||
    (ws?.aheadOfBase ?? 0) > 0 ||
    input.pushed === true ||
    ws?.prState != null;

  const bump = (id: WorkflowStageId) => {
    idx = Math.max(idx, stageIndex(id));
  };

  // A pushed branch is at least Pushed (a PR implies the branch was pushed).
  if (input.pushed || ws?.prState != null) bump("pushed");

  if (ws) {
    if (ws.prState === "merged") bump("merged");
    else if (ws.prState === "open") bump("pull_request");

    // Build agent: landing on LOCAL main is `merged_local`; only reaching ORIGIN main (or a
    // GitHub-merged PR, which implies origin has it) is the full `merged`. Splitting these is what
    // lets the CTA say "Push to Origin Main" instead of falsely offering Close on unpushed work.
    // `ws.landed` is the SQUASH/REBASE case — the tip isn't an ancestor but its tree already
    // matches. It can't distinguish local from origin, so it settles at the cautious `merged_local`.
    // The committedSeen gate is what keeps a no-op branch (also tree-identical) from reading landed.
    if (committedSeen && kind !== "worker") {
      if (ws.inLocalMain || ws.landed) bump("merged_local");
      if (ws.inOriginMain) bump("merged");
    }
  }

  // A worker is "Merged with Main" ONLY once BOTH are true: (a) this worker's OWN branch is actually
  // in the parent/orchestrator branch (`inParent`, or the squash `landed` case where its work is
  // already there but its tip isn't an ancestor), AND (b) the parent orchestrator's work has itself
  // reached main (`parentReachedMain`). Requiring `inParent`/`landed` is what stops a FRESHLY spawned
  // worker — one that has only just made its first commit and was never integrated — from falsely
  // reading as merged just because the parent had EVER reached main (which is sticky/monotonic): that
  // was the "Close this worker? Your code has been pushed to main" false pop-up. The committedSeen
  // gate (bs.ahead, ws.aheadOfBase, or the prior watermark) additionally keeps a no-op worker from
  // skipping the build stages to read as landed.
  // A worker integrates into its PARENT branch, which is a LOCAL merge, so on its own that's only
  // merged_local. But once the PARENT's work is on ORIGIN main, this worker's work is on origin main
  // too (it's contained in the parent), so it earns the full `merged` — which is what lets its bead
  // close and its sidebar ✓ light. A worker can never observe origin main directly: its tip is in
  // the parent's branch, not the default branch, so it inherits the fact from the parent's stage.
  const ownWorkInParent = (ws?.inParent ?? false) || (ws?.landed ?? false);
  if (kind === "worker" && committedSeen && ownWorkInParent && parentReachedMain) {
    bump(parentOnOriginMain ? "merged" : "merged_local");
  }

  // Shipped is the authoritative top — only meaningful once real work landed.
  if (input.shipped && committedSeen) bump("shipped");

  // New-cycle detection: prior work already landed (prev ≥ Merged) but live signals fell back AND
  // there are fresh un-landed commits — track the new cycle instead of staying pinned at Merged.
  // Work that landed only LOCALLY counts as "landed before" too — otherwise an agent that landed on
  // local main and then started a fresh cycle would stay pinned at merged_local.
  const landedBefore = prevIdx >= stageIndex("merged_local");
  const freshWork = (bs?.ahead ?? 0) > 0 || (ws?.aheadOfBase ?? 0) > 0;
  const newCycle = landedBefore && idx < prevIdx && freshWork;
  idx = newCycle
    ? Math.max(idx, stageIndex("building_saved"))
    : Math.max(idx, prevIdx);

  // Apply the planning floor (Think/Plan): raises a planning-only unit to Thought/Spec'd/Planned,
  // but never drags a unit with real git/PR progress backwards (floor only raises a lower idx).
  idx = Math.max(idx, planningFloor(input));
  // No signal at all (no git, no planning, no PR) → the build start line. In production
  // deriveLiveStage is only called for build/worker agents (runtimeStore skips think/shell), so
  // this is their floor; a planning-only unit always carries a planning floor and never reaches here.
  if (idx < 0) idx = stageIndex("building_unsaved");
  return stageAt(idx).id;
}

export type StageCounts = Record<WorkflowStageId, number>;

export interface WorkflowRollup {
  // Overall stage for the build agent's own line = the LEAST-advanced worker (the whole thing
  // isn't done until every unit is), so the headline tracks the slowest unit.
  stage: WorkflowStageId;
  dominant: WorkflowStageId; // most common stage among workers (ties → earliest)
  total: number;
  counts: StageCounts;
}

function emptyCounts(): StageCounts {
  return {
    thought: 0,
    specd: 0,
    planned: 0,
    building_unsaved: 0,
    building_saved: 0,
    pushed: 0,
    pull_request: 0,
    merged_local: 0,
    merged: 0,
    shipped: 0,
  };
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

// ── Progress-line palette ────────────────────────────────────────────────────────────────────
// The line reproduces the sparkle.ai wordmark's gradient: the teal of the "S" on the left warming
// to the deep blue of the "i" (its dotted eye) on the right. It fills left→right as work advances
// through the ten stages, so a glance reads "how far toward shipped" from BOTH the fill length and
// its color deepening from teal to blue. These are the literal stops of the logo's linearGradient.
export const LINE_FROM = "#34e0f0"; // the "S" — teal/cyan, left end of the logo gradient
export const LINE_TO = "#2f6bff"; //   the "i"/eye — deepest blue, right end of the logo gradient

// Fraction of the bar filled at a given stage. Stage 1 (Thought) shows a short stub (1/10) so a
// brand-new idea reads as "started", and Shipped fills the whole bar (10/10).
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

// The color the line has reached at a given stage (its rightmost filled pixel): Thought sits near
// the teal "S"; Shipped lands on the deep blue "i".
export function stageLineColor(stage: WorkflowStageId): string {
  return lineColorAt(stageFraction(stage));
}

// Most-represented stage; ties break to the EARLIEST stage, so "3 saved, 3 merged" reads as the
// more cautious "mostly saved".
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
