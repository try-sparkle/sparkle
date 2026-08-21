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
// (idle/done/stopped) agent to the `unmerged` status via engine/unmergedAttention.ts — gray, but
// ranked above the calm tier (it stopped being RED on 2026-07-26). "main" here is ORIGIN main:
// merged_local still counts as unmerged because the workflow lands via a PR to origin, so local-only
// work still needs you to get it the rest of the way. Pure.
export function hasUnmergedCommittedWork(stage: WorkflowStageId): boolean {
  const idx = stageIndex(stage);
  return idx >= stageIndex("building_saved") && idx < stageIndex("merged");
}

/**
 * Uncommitted changes in this agent's own worktree. `true` / `false` / `undefined` ("not looked up").
 *
 * ONE IMPLEMENTATION, THREE SURFACES. This lived privately in `components/rowAttention` while the
 * stage ladder had no opinion at all, and it now has to answer for the ladder too (sparkle-biezi):
 * `sectionOfRow` needs it to tell "this row holds unsaved edits" from "nothing has happened here".
 * `rowAttention.uncommittedEvidence` delegates here rather than keeping its own copy, for the same
 * reason `unlandedWorkEvidence` was hoisted (roborev 55525) — two copies of an evidence rule is how
 * the sidebar and the control surface came to disagree about the same agent at the same moment.
 *
 * The `worktreeOnBranch === false` arm is the subtle one, and `BranchStatus.dirty` documents the rule
 * it follows: a PARKED tree's dirt belongs to whatever branch was checked out into it, so it is not
 * evidence about THIS agent's work. That makes it neither proof of dirt nor proof of a clean tree —
 * which is precisely `undefined`. (The close-prompt reads the same field the opposite way on purpose:
 * it asks a SAFETY question, "are there files at risk", and parking carries them along. This asks an
 * ATTRIBUTION question.)
 *
 * `worktreeOnBranch === undefined` is a Rust build predating the field, not a parked tree; it takes
 * the normal path, matching every other attribution consumer's `!== false` gate.
 */
export function uncommittedWorkEvidence(bs?: BranchStatus | undefined): boolean | undefined {
  if (bs === undefined) return undefined;
  // A CLEAN TREE HOLDS NOTHING, WHOEVER IT BELONGS TO — and this arm must come FIRST (2026-08-06).
  //
  // The founder measured two rows filed under "Local: Uncommitted" — whose copy states flatly that
  // "edits exist only in the working tree — closing this agent loses them" — whose worktrees were
  // `git status --porcelain` EMPTY, fully pushed, and every PR they owned merged.
  //
  // The parked gate below is an ATTRIBUTION rule, and attribution is only ever a question about
  // dirt that EXISTS: if a tree has uncommitted files, whose work are they? When `dirty` is false
  // there is no such question to get wrong. The porcelain read is of the DIRECTORY, so `false`
  // means "no uncommitted files in this worktree", and that is true no matter which branch is
  // checked out into it. Answering `undefined` there reported a tree we HAD read as if we had not.
  //
  // Why that fired so widely: `resolve_agent_branch` reports `worktree_on_branch: false` whenever
  // the minted `sparkle/agent-<id>` ref still exists while the tree sits elsewhere — which is
  // exactly what `git checkout -b <topic>` leaves behind, and AGENTS.md actively encourages
  // descriptive branch names. Measured on this machine: 21 worktrees were off their minted branch
  // and 15 of them were spotless, so two thirds of the "parked" population was being reported as
  // unknown when it was positively, readably empty. `rollupHoldsWork` then propagates one such
  // worker to its whole orchestrator (`true > undefined > false`), which is how a head with a clean
  // tree of its own got dragged under the heading too.
  //
  // THE CAUTIOUS ARM IS UNCHANGED FOR THE CASE IT WAS WRITTEN FOR. A tree that is DIRTY and parked
  // still returns `undefined`, because whose files those are is genuinely unknown — that is the
  // sparkle-rhgm contract and the remaining 6 of those 21. This narrows the gate to the question it
  // can actually answer; it does not remove it. Nor does it touch `sectionOfRow`'s
  // `undefined → local_uncommitted` default: "we did not look" still must not buy the calm heading.
  // What changed is that a clean tree is no longer mistaken for one we did not look at.
  if (bs.dirty === false) return false;
  if (bs.worktreeOnBranch === false) return undefined;
  return bs.dirty;
}

/**
 * Fold a head row's own "holds work?" reading together with its workers' — the same roll-up
 * `rollupStages` performs for the stage, in the same direction.
 *
 * WHY THE HEAD MUST ASK ITS WORKERS AT ALL. The ladder buckets an orchestrator by its LEAST-advanced
 * worker, so a head whose worker is mid-edit already sits at `building_unsaved`. If this answered
 * from the head's OWN tree alone it would report `false` for that head, `sectionOfRow` would file it
 * under "Local: Nothing Yet — nothing here is at risk", and the progress bar on that very row would
 * simultaneously show a worker holding uncommitted files. Two adjacent signals contradicting each
 * other is the failure the ladder's own comment (AgentSidebar, `headStageOf`) was written about.
 *
 * PRECEDENCE, and it is deliberately NOT a majority: `true` beats `undefined` beats `false`.
 *   • any `true`      → something, somewhere in this subtree, is at risk. Say so.
 *   • any `undefined` → we did not read part of this subtree, so we cannot claim it is empty.
 *   • all `false`     → positively read, genuinely nothing.
 * Only the last one earns the calm heading, which is the same "absence of evidence is not evidence
 * of absence" rule every other accessor in this file follows.
 */
export function rollupHoldsWork(
  values: readonly (boolean | undefined)[],
): boolean | undefined {
  let sawUnknown = false;
  for (const v of values) {
    if (v === true) return true;
    if (v === undefined) sawUnknown = true;
  }
  return sawUnknown ? undefined : false;
}

/** The git facts an "is there unlanded work?" question needs, each with its own "we never looked" arm. */
export interface UnlandedInputs {
  /** `runtimeStore.branchStatus[id]` — ahead/behind/dirty. Absent until the first poll lands. */
  bs?: BranchStatus | undefined;
  /** `runtimeStore.workflowState[id]` — reachability + the best-effort GitHub PR probe. */
  ws?: WorkflowState | undefined;
  /** `runtimeStore.workflowStage[id]` — the persisted monotonic stage watermark, if any. */
  stageOverride?: WorkflowStageId | undefined;
}

/**
 * Is there committed work that never reached main? `true` / `false` / `undefined` ("not looked up").
 *
 * ONE IMPLEMENTATION, TWO SURFACES (roborev 55525). This lived only in the sidebar's evidence
 * gatherer while `agentGoalReading.readUnlanded` — which feeds `get_state`'s `stall`/`stallCauses` and
 * `get_agent_status` — answered from the stage watermark alone. For the new-work cycle that meant the
 * sidebar reported `stalled` / `unlanded-work` while the control surface reported `finished` for the
 * SAME agent at the SAME moment, which is the disagreement `agentGoalReading`'s own header exists to
 * forbid, on the surface a concierge actually sweeps.
 *
 * `resolveStage` has a FLOOR — handed nothing it returns the bottom stage, which
 * `hasUnmergedCommittedWork` reads as `false`. That default is right for a progress bar and wrong
 * here: it would manufacture "nothing unlanded" for every agent whose branch has simply not been
 * polled. So at least one real reading is required before consulting it.
 */
export function unlandedWorkEvidence(ev: UnlandedInputs): boolean | undefined {
  if (ev.bs === undefined && ev.stageOverride === undefined) return undefined;
  // LIVE COMMITS OUTRANK THE WATERMARK (roborev 55334). `resolveStage` takes the MAX of the
  // git-derived stage and the persisted watermark, and the watermark is monotonic. So the new-work
  // cycle — merge PR #1, keep working on the same branch, commit three more times — had
  // `stageOverride: "merged"` outranking `ahead: 3`, and the row rendered pixel-identical to a shipped
  // agent while carrying three unlanded commits. `deriveLiveStage` handles this case explicitly;
  // `resolveStage` deliberately does not, so the caller must.
  //
  // BUT `ahead` DOES NOT RETURN TO ZERO WHEN WORK LANDS (roborev 55456). It is
  // `rev-list --left-right --count <base>...<branch>`, so it only reaches 0 once the branch TIP is an
  // ancestor of the base. A squash/rebase merge defeats that permanently: the work is in main, the tip
  // is not, and `ahead` stays N forever. Unguarded, this paints a landed agent red `blocked` with
  // nothing able to clear it — a manufactured POSITIVE, costlier than the stall it was chasing.
  //
  // So it yields to direct reachability: `landed` is the squash case by name (Rust
  // `merge_adds_nothing` — tip not an ancestor, merging adds nothing), `inOriginMain`/`inLocalMain` the
  // ancestor case. Each is `true` only from a reading that ran, so this yields to evidence, never a gap.
  //
  // ⚠️ `prState === "merged"` IS DELIBERATELY NOT IN THAT LIST. It is the state of the branch's PR, not
  // of the branch: merge PR #1, keep committing, and until a second PR exists the probe still answers
  // "merged" while commits sit unlanded. Vetoing on it would restore the false negative above — a calm
  // gray row over outstanding work, which the founder's rule names a bug on its face. `deriveLiveStage`
  // carries its own ⚠️ about how narrowly this field may be trusted; reachability is the durable signal.
  //
  // No `worktreeOnBranch` gate: `BranchStatus` documents that `dirty` is the SOLE field parking
  // corrupts, because every other one is computed from the branch REF and is immune to what got
  // checked out into the tree. Gating `ahead` on it would discard sound evidence and re-open this hole
  // for a parked worktree — a real state here (sparkle-rhgm), not a hypothetical.
  //
  // ⚠️ `inLocalMain` IS NOT IN THIS VETO, and that is the same origin-scoping the guard below
  // documents, applied to the gate it sits beside. `ahead` is measured against `base_for_ahead`,
  // which is `origin/<default>` whenever that ref exists — so letting a LOCAL proof suppress a
  // positive derived from an ORIGIN-scoped counter is exactly the conflation this function must not
  // make. Left in, the second lap of a lands-locally-without-pushing repo reads as nothing
  // outstanding: lap 1 crosses origin and latches the watermark at `merged`, lap 2 merges three
  // commits into local main without pushing, and with `inLocalMain` vetoing here the fall-through
  // consults that stale `merged` watermark and answers `false` over three unpushed commits. Dropping
  // it costs nothing: when the base IS local (no origin ref) a branch contained in local main has
  // `ahead === 0`, so this can't fire; when the base is origin, `ahead > 0` over a locally-merged
  // branch is a CORRECT positive.
  const alreadyInBase = ev.ws?.landed === true || ev.ws?.inOriginMain === true;
  if (!alreadyInBase && ev.bs !== undefined && ev.bs.ahead > 0) return true;
  // A LIVE READING BEATS A STALE WATERMARK (bead `sparkle-qh6j7g`). `alreadyInBase` used to veto
  // only the `ahead` early return above, so the line below could still manufacture unlanded work out
  // of `stageOverride` alone — and that watermark is MONOTONIC and only moves when a poll OBSERVES a
  // crossing. An agent whose PR merged while nothing was watching keeps a watermark at
  // `pull_request`, `hasUnmergedCommittedWork` reads that as outstanding work, and the row reports
  // unlanded commits over a branch whose tip is IN origin main with `ahead` and `aheadOfBase` both
  // zero. That combination is what the goal verifier then renders as "git says it is not on
  // origin/main yet" — a claim git contradicts. Reachability plus two live zeroes is a stronger
  // reading than a stale latch, so let it win.
  //
  // `landedOnOrigin` is named separately because a SQUASH land leaves both counters at N forever
  // (the tip is an ancestor of nothing — see the roborev 55456 note above), so the zeroes can never
  // speak for it. It is the cherry-equivalence proof — "merging this branch into origin would add
  // NOTHING" — which is precisely "nothing outstanding", and it falls back to false the moment a new
  // commit means merging WOULD add something. So the new-work cycle still reports `true` through
  // both arms: fresh commits make `landedOnOrigin` false AND move `ahead` off zero.
  //
  // ⚠️ ORIGIN-SCOPED, and NOT `alreadyInBase` — which also carries the two LOCAL proofs. Where
  // `origin/<default>` has no remote-tracking ref Rust falls back to the LOCAL default for
  // `base_for_ahead`, so a branch merged into local main reports `inLocalMain: true` with both
  // counters at zero. `deriveLiveStage` puts that branch at `merged_local`, and
  // `hasUnmergedCommittedWork` calls `merged_local` OUTSTANDING on purpose — local-only work still
  // needs someone to get it the rest of the way. Reusing `alreadyInBase` here would answer `false`
  // for it, silently retiring the unmerged chip, the `unlanded-work` stall cause and the `mayRetire`
  // input for exactly the lands-locally-without-pushing repos that are called out elsewhere as a
  // population not to regress.
  const inBaseOnOrigin = ev.ws?.inOriginMain === true || ev.ws?.landedOnOrigin === true;
  const nothingOutstanding =
    ev.ws?.landedOnOrigin === true ||
    ((ev.bs?.ahead ?? 0) === 0 && (ev.ws?.aheadOfBase ?? 0) === 0);
  if (inBaseOnOrigin && nothingOutstanding) return false;
  return hasUnmergedCommittedWork(resolveStage(ev.bs, ev.stageOverride));
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
  //
  // ⚠️ `prState` CARRIES ITS WEIGHT HERE ONLY BECAUSE RUST GUARANTEES IT IS AGENT-SCOPED. That
  // invariant was silently broken once: the tip-relative probe (`probe_pr_by_commit`) asks GitHub
  // which PR contains a COMMIT, and a branch that has authored nothing is sitting on main's HEAD —
  // the merge commit of the last merged PR. So a seconds-old agent reported prState "merged", which
  // both established committedSeen here AND bumped straight to `merged`; the row filed itself under
  // "Remote: Merged to Main". The fix is upstream in `worktree.rs`
  // (`branch_carries_no_own_work` suppresses the commit probe and the release-tag check for a branch
  // with no work of its own), so DON'T re-derive that here — but if you ever add another PR/shipped
  // source, it owes the same guarantee before it may feed this gate.
  const committedSeen =
    idx >= stageIndex("building_saved") ||
    prevIdx >= stageIndex("building_saved") ||
    (ws?.aheadOfBase ?? 0) > 0 ||
    input.pushed === true ||
    ws?.prState != null;

  const bump = (id: WorkflowStageId) => {
    idx = Math.max(idx, stageIndex(id));
  };

  // AUTHORED COMMITS ARE COMMITTED WORK, WHEREVER THEY LIVE (bead `sparkle-d5muhf`).
  //
  // `gitDerivedStage` reads ONE number — `bs.ahead`, measured on the single branch the agent's
  // worktree is checked out on — so an agent whose work sits anywhere else lands on
  // `building_unsaved`, and `sectionOfStage` files that under "LOCAL: UNCOMMITTED" with an
  // "Unsaved" chip whose copy says closing now loses the work. `ws.aheadOfBase` is the wider
  // reading: since Rust adopts the branches of worktrees NESTED under the agent's own checkout
  // (`nested_branch_checkouts`), it answers "commits this agent authored that are not in the base"
  // for the whole subtree, not just for the one branch the row happens to name.
  //
  // Measured case: an agent's PR had merged and its own branch was ahead=0, while a nested checkout
  // held four unlanded commits. The row said "Unsaved" — false in both directions at once, since
  // the merged work was safe and the four commits were not even visible.
  //
  // This can only RAISE the floor and it never claims landedness: `building_saved` is the honest
  // "there are commits, and closing keeps the branch". `committedSeen` above already trusts the
  // same field, so nothing new is being believed here — the number simply now moves the bar as
  // well as the gate.
  if ((ws?.aheadOfBase ?? 0) > 0) bump("building_saved");

  // A pushed branch is at least Pushed (a PR implies the branch was pushed).
  if (input.pushed || ws?.prState != null) bump("pushed");

  if (ws) {
    if (ws.prState === "merged") bump("merged");
    else if (ws.prState === "open") bump("pull_request");

    // Build agent: landing on LOCAL main is `merged_local`; only reaching ORIGIN main (or a
    // GitHub-merged PR, which implies origin has it) is the full `merged`. Splitting these is what
    // lets the CTA say "Push to Origin Main" instead of falsely offering Close on unpushed work.
    // `ws.landed` is the SQUASH/REBASE case — the tip isn't an ancestor but its tree already matches.
    //
    // `ws.landedOnOrigin` IS THE MISSING HALF OF THAT SIGNAL (bead `sparkle-e3lxt7`). This comment
    // used to say `ws.landed` "can't distinguish local from origin, so it settles at the cautious
    // merged_local" — but Rust always knew: three of `branch_landed`'s four arms are explicitly
    // origin-scoped, and the answer was collapsed to one boolean before it reached the wire. It is
    // now carried, so an ORIGIN-scoped proof reads the full `merged`.
    //
    // This is a correction, not a nicety, because patch-equivalence is the NORMAL path to shipped in
    // this repo (it squashes and rebases, so work re-lands under a different sha). In that shape
    // inLocalMain and inOriginMain are BOTH false, so the row landed in `merged_local` — whose
    // documented meaning in buildSections.ts is "seen on LOCAL main, not yet seen on ORIGIN main" —
    // while neither half of that was true. Treating the repo's ordinary shipping path as the
    // uncertain fallback mislabelled most shipped work.
    //
    // `merged_local` is now honest by its own definition: only a LOCAL-scoped proof reaches it, and
    // every local-scoped arm implies the work really is on local main. The committedSeen gate still
    // keeps a no-op branch (also trivially tree-identical) from reading landed at all.
    if (committedSeen && kind !== "worker") {
      if (ws.inLocalMain || ws.landed) bump("merged_local");
      if (ws.inOriginMain || ws.landedOnOrigin) bump("merged");
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
// Spelled as the brand TOKENS, not as copies of their hex. Both are literals at runtime (the
// theme layer only var()-ifies the themed tokens), so the lerp below can still parse them — but a
// retune of the brand palette now moves the line with it instead of leaving two stale strings.
export const LINE_FROM = C.accent; // the "S" — teal/cyan, left end of the logo gradient
export const LINE_TO = C.teal; //    the "i"/eye — deepest blue, right end of the logo gradient

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
