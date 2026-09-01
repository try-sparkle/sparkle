// The Build column's STAGE LADDER: the fixed, ordered set of sections a build row can sit in, plus
// the pure logic that buckets rows into them and applies the status filter.
//
// WHY THIS EXISTS. The column used to be one flat list sorted by `engine/agentOrdering`'s attention
// tiers, so a row's POSITION was a function of its live status. Every PTY status flip (working ⇄
// idle ⇄ waiting) moved a row across a whole tier and the list visibly re-shuffled under the cursor
// — the single most confusing thing about the column. The fix is to make position a function of
// WORKFLOW STAGE only: a row moves when its work actually advances (commit → push → PR → merge),
// which is a handful of times over its whole life, and never because it started or stopped talking.
// Status is still visible — it's the colored dot on the row — it just no longer decides where the
// row lives. Within a section, order is whatever the user dragged it to (project.agents order).
//
// Kept free of React so it's unit-tested in isolation; the rendering lives in AgentSidebar.tsx.
import type { AgentTabStatus } from "../types";
import {
  resolveStage,
  stageMeta,
  type WorkflowStageId,
  type WorkflowStageMeta,
} from "./workflowStage";
import type { BranchStatus } from "../services/branchStatus";
import { isCrossRepo, type CrossRepoReading } from "./crossRepo";

// ── The ladder ───────────────────────────────────────────────────────────────────────────────
export type BuildSectionId =
  | "tracked_elsewhere"
  | "local_none"
  | "local_uncommitted"
  | "local_committed"
  | "local_merged"
  | "remote_pushed"
  | "remote_pr"
  | "remote_merged"
  | "remote_shipped";

export interface BuildSectionMeta {
  id: BuildSectionId;
  label: string;
  // One-line explainer for the header's tooltip — plain language, no git jargon, because the
  // whole point of the Local/Remote split is to teach "is my work off this laptop yet".
  detail: string;
}

// Ordered top → bottom, exactly as rendered. The Local→Remote boundary falls between
// `local_merged` and `remote_pushed`, and the sections BELOW it have positively observed a remote
// fact (pushed / PR open / on origin main / released). That is the one distinction worth teaching a
// user who doesn't know git, which is why it's in the labels rather than left implicit.
//
// ⚠️ READ THE BOUNDARY AS "REMOTE STATE CONFIRMED", NOT "NOT BACKED UP". A section above the line
// does NOT prove the work is only on this machine. `merged_local` in particular means "seen on
// LOCAL main, not yet seen on ORIGIN main" — it says nothing about whether the branch was pushed,
// and deriveLiveStage lets a pushed branch land locally and settle there (a local merge, or the
// squash/rebase `ws.landed` tree-match, both bump to merged_local and outrank `pushed`). So the
// copy below must claim only what its stage actually observed; saying "never pushed" there would
// tell a user their work is at risk when it is sitting safely on the remote.
//
// `merged_local` NOW MEANS WHAT IT SAYS. It used to also collect a second, unrelated population:
// work proven landed by PATCH-EQUIVALENCE with the location unknown. Rust's `branch_landed` has four
// arms and three are origin-scoped, but all four were collapsed into one `ws.landed` boolean, so
// deriveLiveStage could not tell them apart and parked every one of them here as the cautious
// choice. For the repo's most common shipping shape — a squash/rebase re-land under a different sha
// — that made this heading assert the OPPOSITE of the truth in both halves: the work was on ORIGIN
// main and had never been on LOCAL main. Rust now carries which arm proved it (`landedOnOrigin`),
// an origin-scoped proof reads the full `merged`, and the only rows left here are ones whose proof
// really was local. Bead `sparkle-e3lxt7`.
export const BUILD_SECTIONS: readonly BuildSectionMeta[] = [
  {
    // THE ROW WE CANNOT MEASURE FROM HERE — bead `sparkle-pgh1ue`.
    //
    // Every other rung on this ladder is a claim about how far the work got, read out of the agent's
    // BOUND-PROJECT worktree. For an agent whose task lands in a DIFFERENT repository that reading is
    // a structural zero — no commits on its bound branch, no PR, nothing landed — and the row filed
    // one rung down, under "Local: Nothing Yet", asserting that nothing had happened. The founder, on
    // an agent whose work was merged and shipped in another repo: *"why the hell is it still in
    // local? Nothing yet."*
    //
    // THIS RUNG MAKES NO PROGRESS CLAIM AT ALL, and that is the entire design. It says where the work
    // is tracked and that Sparkle cannot see it from this project — which is TRUE, unlike both the
    // alarming reading ("nothing here") and the optimistic one ("probably fine"). A row only leaves
    // it by acquiring evidence: an agent that records where it landed (`set_agent_landed`) gets a
    // real rung below, backed by an `owner/repo#N` a human can click.
    //
    // IT SITS AT SLOT 0 ON PURPOSE. The ladder is ordered by "how far toward safely on remote main",
    // and this rung has no position on that scale — interleaving an unmeasurable row among rungs that
    // do make progress claims would imply one. Above the whole ladder is the one place that implies
    // nothing about it.
    id: "tracked_elsewhere",
    label: "Tracked Elsewhere",
    detail:
      "This agent's work lands in another repository, so Sparkle can't measure it from this project. Ask it to record where it landed.",
  },
  {
    // THE ROW THAT HOLDS NOTHING — split out of `local_uncommitted` (sparkle-biezi).
    //
    // The founder, on agent 11a52157: "I don't know why it's still in local uncommitted. If it's in
    // merged-to-main as it claims to be..." Its worktree was SPOTLESS and it had authored ZERO
    // commits — it babysat somebody else's PR. `gitDerivedStage` reads `ahead === 0` as
    // `building_unsaved` whether or not the tree is dirty, so it filed under a heading that says its
    // work is one close away from being lost. There was nothing to lose.
    //
    // This rung is where a row goes when we have POSITIVELY READ its worktree and found nothing:
    // no commits, no uncommitted files. A row whose git state was never read, or whose tree is
    // parked (so its dirt is another branch's), stays in `local_uncommitted` — see `sectionOfRow`.
    // Absence of evidence does not earn the calmer heading.
    id: "local_none",
    label: "Local: Nothing Yet",
    detail: "No commits and no edits in the working tree — nothing here is at risk.",
  },
  {
    id: "local_uncommitted",
    label: "Local: Uncommitted",
    // THIS COPY IS ONLY HONEST BECAUSE `local_none` EXISTS. `sectionOfStage` folds four stages in
    // here — thought / specd / planned / building_unsaved — and `gitDerivedStage` returns
    // `building_unsaved` for `ahead === 0` REGARDLESS of `dirty`, so this rung used to hold BOTH a
    // row with unsaved edits at risk AND a row where nothing had happened at all, while asserting
    // the first about both (sparkle-biezi). `sectionOfRow` now routes the second kind to
    // `local_none`, which is what lets this sentence make a definite claim again.
    //
    // Keep the two in step: if you ever widen what lands here, widen `sectionOfRow` too or soften
    // this line back to something true of every member. A row that reads "closing this agent loses
    // them" while holding nothing is the scariest copy in the column, and it was live for months.
    // WHICH files are at risk is answered ON THE ROW, by the "uncommitted: <file>" chip
    // (rowAttention.stallChipFor) — a heading cannot name them, and a claim nobody can act on is
    // what sent the founder to a terminal to check.
    detail: "Edits exist only in the working tree — closing this agent loses them.",
  },
  {
    id: "local_committed",
    label: "Local: Committed",
    detail: "Committed to a branch on this machine. Safe from a close, not from a disk failure.",
  },
  {
    id: "local_merged",
    label: "Local: Merged to Main",
    // Deliberately says "not confirmed on the remote" rather than "never pushed": the stage proves
    // only that origin main hasn't been observed carrying this work. See the boundary note above.
    detail: "Landed on your local main. Not confirmed on the remote's main yet.",
  },
  {
    id: "remote_pushed",
    label: "Remote: Branch Pushed",
    detail: "The branch is backed up on the remote. No pull request opened yet.",
  },
  {
    id: "remote_pr",
    label: "Remote: Pull Request Open",
    detail: "A pull request is open and waiting to be reviewed and merged.",
  },
  {
    id: "remote_merged",
    label: "Remote: Merged to Main",
    detail: "Merged into main on the remote. This work has landed.",
  },
  {
    id: "remote_shipped",
    label: "Remote: Shipped to Production",
    detail: "Included in a published release — out in the world.",
  },
] as const;

export function sectionMeta(id: BuildSectionId): BuildSectionMeta {
  // Every BuildSectionId is in the table, so the fallback is unreachable in practice; it exists so
  // callers never juggle `undefined`.
  return BUILD_SECTIONS.find((s) => s.id === id) ?? (BUILD_SECTIONS[0] as BuildSectionMeta);
}

// Which section a workflow stage lands a row in.
//
// The pre-build planning stages (thought/spec'd/planned) fold into `local_uncommitted`: a build row
// at one of those has a worktree with nothing committed in it, which is exactly what that section
// means to a user. `pushed` is its own rung because "backed up on the remote" is the moment the
// work stops being one disk failure from gone — the single most reassuring fact the column can show.
//
// ⚠️ ONE DELIBERATE ORDER INVERSION. `merged_local` is engine stage 8 — LATER than `pull_request`
// (7) — but sits at ladder slot 3, EARLIER than the PR section. That is intentional: the ladder
// measures "how far toward being safely on remote main", and work sitting on a local-only main is
// behind a pushed branch by that measure. The cost is that one rare transition (a row with an open
// PR that then gets merged into local main WITHOUT the PR landing) moves the row UP the ladder
// instead of down. `gh pr merge` produces `merged`, not `merged_local`, so the sanctioned flow
// never hits it. If you ever need to close that gap, give `merged_local` its own slot after the PR
// section rather than reordering the engine — the engine's monotonic index is load-bearing
// elsewhere (see deriveLiveStage).
/**
 * A row's section from its RAW git readings, or `undefined` for "this window never read it".
 *
 * ⚠️ THE `undefined` IS THE WHOLE VALUE, AND IT IS WHY THIS IS NOT `sectionOfStage(resolveStage(…))`.
 * `resolveStage` FLOORS at the first rung rather than returning `undefined`, so composing the two
 * would hand back a PRE-TERMINAL section for a row nobody polled. Any caller keyed on "is this
 * section terminal" would then treat the entire unpolled fleet as unfinished — for the terminal-gray
 * rule that means repainting every such row amber on our own ignorance. Both readings absent means
 * we did not look, and callers must render such a row unchanged.
 *
 * Exported (rather than left a closure in `AgentSidebar`) so this property is directly testable: it
 * is load-bearing for the founder's 2026-08-19 gray rule and is exactly the kind of guard that goes
 * quietly wrong.
 */
export function sectionFromReadings(
  bs: BranchStatus | undefined,
  override: WorkflowStageId | undefined,
  /** What this row knows about work living OUTSIDE the bound project — see {@link sectionOfRow}.
   *
   *  ⚠️ IT IS CONSULTED BEFORE THE `undefined` GUARD BELOW, and that ordering is the point. A
   *  cross-repo row is precisely the row whose bound-project readings are absent or all-zero, so
   *  requiring a reading first would make this parameter unreachable for its own motivating case.
   *  "We never read its git state" and "its git state is not where the work is" are different facts,
   *  and only the first is ignorance. */
  crossRepo?: CrossRepoReading | null,
): BuildSectionId | undefined {
  if (isCrossRepo(crossRepo ?? undefined)) {
    // `undefined` for `holdsWork`, because this overload genuinely has no worktree reading to pass —
    // NOT as a shortcut. `sectionOfRow` treats `undefined` as "not evidence of work at risk here",
    // which is the honest reading of "we were not given one".
    return sectionOfRow(resolveStage(bs, override), undefined, crossRepo);
  }
  if (bs === undefined && override === undefined) return undefined;
  return sectionOfStage(resolveStage(bs, override));
}

export function sectionOfStage(stage: WorkflowStageId): BuildSectionId {
  switch (stage) {
    case "thought":
    case "specd":
    case "planned":
    case "building_unsaved":
      return "local_uncommitted";
    case "building_saved":
      return "local_committed";
    case "merged_local":
      return "local_merged";
    case "pushed":
      return "remote_pushed";
    case "pull_request":
      return "remote_pr";
    case "merged":
      return "remote_merged";
    case "shipped":
      return "remote_shipped";
  }
}

/**
 * The section a ROW belongs in — the stage, plus the one fact the stage cannot carry.
 *
 * `sectionOfStage` is a pure function of the stage and stays that way: every other rung is decided
 * by how far the work got, which is exactly what a stage IS. This wrapper exists for the single
 * place that is not true (sparkle-biezi): `gitDerivedStage` maps `ahead === 0` to
 * `building_unsaved` whether the tree is dirty or spotless, so "I have unsaved edits" and "nothing
 * has happened here" arrive wearing the same stage. Only a worktree reading can separate them, and
 * a stage never carries one.
 *
 * `holdsWork` is that reading, and its THREE-VALUED-NESS is the whole contract:
 *   • `true`      — dirty, attributable to this branch → `local_uncommitted`, as before.
 *   • `false`     — positively read and genuinely empty → `local_none`.
 *   • `undefined` — never polled, or a PARKED tree whose dirt belongs to another branch →
 *                   `local_uncommitted`, as before.
 *
 * That last arm is the one to preserve. "We did not look" must never buy the calmer heading: this
 * whole area exists because a row claimed something about work it had not checked, and defaulting an
 * unread row to "nothing here is at risk" would be the same lie pointing the other way. Feed it
 * `engine/workflowStage.uncommittedWorkEvidence`, which already returns exactly these three values
 * and already applies the parked-worktree gate.
 *
 * Only the `local_uncommitted` rung is ever re-routed. For every rung BELOW it the row has committed
 * work by definition, so its worktree's cleanliness cannot change where it belongs.
 *
 * ⚠️ THAT SENTENCE USED TO READ "a row at any other stage has committed work by definition", which is
 * FALSE and was called out (roborev 57842): `thought` / `specd` / `planned` sit in this rung
 * PRECISELY BECAUSE they have no commits, and a `planned` row reaches it with a spotless tree
 * routinely — the beads store is gitignored, so filing a bead dirties nothing. So those three ARE
 * re-routed by the gate below, and that is a decision, not an oversight:
 *
 *   • Leaving them behind would strand them under `local_uncommitted`, whose copy states flatly that
 *     "edits exist only in the working tree — closing this agent loses them". For a spotless planned
 *     row that is definitively false — the same lie this whole change exists to remove, just aimed at
 *     a different row.
 *   • `local_none`'s DETAIL ("no commits and no edits in the working tree") is literally true of
 *     them, and its rung is about how far the code got, which for a planned row is nowhere.
 *   • The reviewer's alternative — gating on `stage !== "building_unsaved"` — was considered and
 *     declined for exactly that reason. It trades a false claim about planning rows for a different
 *     false claim about them.
 *
 * What the label alone does under-state is that planning DID happen. That is answered one component
 * down rather than here: the row keeps its own `Planned` / `Spec'd` / `Thought` stage chip, which is
 * true and non-alarming, and `honestStageMeta` overrides ONLY `building_unsaved` — the one stage
 * whose copy this rung's reading actually falsifies.
 */
export function sectionOfRow(
  stage: WorkflowStageId,
  holdsWork: boolean | undefined,
  /** What this row knows about work living OUTSIDE the bound project (`engine/crossRepo`).
   *
   *  THE SAME SHAPE OF FIX AS `holdsWork`, ONE LEVEL FURTHER OUT. `holdsWork` exists because a stage
   *  cannot tell "I have unsaved edits" from "nothing has happened"; this exists because a stage
   *  cannot tell "nothing has happened" from "it happened somewhere I cannot see". Both are facts a
   *  stage is structurally unable to carry, and both were being asserted anyway.
   *
   *  IT ONLY EVER RE-ROUTES THE TWO BOTTOM RUNGS. A row that reached `local_committed` or beyond has
   *  measurable work in the bound project — whatever else it also did elsewhere — and moving it up to
   *  an unmeasurable rung would DISCARD a true reading in favour of "we cannot tell". The stamp is
   *  what carries a cross-repo row past those rungs, through `deriveLiveStage`, and it arrives here
   *  as an ordinary stage needing no special case. */
  crossRepo?: CrossRepoReading | null,
): BuildSectionId {
  const section = sectionOfStage(stage);
  if (section !== "local_uncommitted") return section;
  // ⚠️ `holdsWork === true` OUTRANKS THE CROSS-REPO ROUTE, and the order is the correctness.
  //
  // `true` means this row's bound worktree holds dirty, attributable, AT-RISK edits — the one
  // reading whose heading warns that closing the agent loses them. A row can honestly be both: work
  // landing in another repo AND unsaved edits sitting here. Routing that row to "Tracked Elsewhere"
  // ("Sparkle can't measure it from this project") would be measurably false — we just measured it —
  // and would drop the data-loss warning, which is the most consequential copy in the column.
  //
  // So the cross-repo rung only ever collects rows with NOTHING measurable here, which is exactly
  // what its own detail sentence claims. `false` (positively empty) and `undefined` (never read, or
  // a parked tree) both qualify: neither is evidence of work at risk in THIS repo, and for both the
  // other repo is the more informative thing to say.
  if (holdsWork !== true && isCrossRepo(crossRepo ?? undefined)) return "tracked_elsewhere";
  return holdsWork === false ? "local_none" : section;
}

// NOTE: an `isLocalOnlyMerge(stage)` helper was removed here. It claimed a row at `merged_local`
// was "local only (never pushed)", which the stage does not prove (see the boundary note above), and
// it drove a "local only" row qualifier that would therefore have lied to exactly the users the
// Local/Remote split exists to reassure. If you want that qualifier back, gate it on the PUSH signal
// — `BranchStatus`/`WorkflowState`, which only the caller has — not on the stage id alone.

/**
 * The stage meta a ROW may honestly render, given the rung it was filed under.
 *
 * THE CONTRADICTION THIS EXISTS TO KILL (roborev 57842 / 57877, sparkle-biezi). `sectionOfRow` files
 * a clean, commit-free row under `local_none` ("Local: Nothing Yet — nothing here is at risk"), but
 * the row itself is still at stage `building_unsaved`, whose meta reads "Unsaved" with the detail
 * "Building locally: unsaved changes — closing now loses this work." So the founder's original
 * complaint — copy claiming work will be lost about a row holding nothing — kept surviving one
 * component below whatever I had just fixed.
 *
 * IT TOOK THREE PASSES TO STOP MOVING, which is why this now lives in the engine rather than beside
 * one component. First the section header was fixed and the collapsed row's `StageChip` still lied.
 * Then the chip was fixed and the EXPANDED card's `WorkflowLine` still lied — in larger text, on the
 * row the user had actually stopped on, and reached by a different code path that called
 * `stageMeta` directly. A rule that two components must apply cannot live inside one of them.
 * Every renderer of stage copy on a row goes through here.
 *
 * ONLY `building_unsaved` IS OVERRIDDEN, and that is the point rather than a shortcut. It is the one
 * stage whose meta asserts something the `local_none` reading has just falsified. The other three
 * stages sharing that rung — `thought` / `specd` / `planned` — describe planning that genuinely
 * happened and say nothing about the worktree, so a `Planned` chip under "Nothing Yet" is two true
 * statements at different altitudes, not a contradiction. Overriding those would erase real
 * information.
 *
 * Returns `stageMeta(stage)` untouched for every other row, so nothing outside this one case moves.
 */
export function honestStageMeta(
  stage: WorkflowStageId,
  section?: BuildSectionId,
): WorkflowStageMeta {
  const meta = stageMeta(stage);
  if (stage !== "building_unsaved") return meta;
  const override = EMPTY_STAGE_COPY[section as BuildSectionId];
  return override ? { ...meta, ...override } : meta;
}

/**
 * The `building_unsaved` copy each rung may honestly show — and the TWO ENTRIES SAY DIFFERENT THINGS
 * ON PURPOSE, because the two rungs are reached under different evidence (roborev 67613).
 *
 * `local_none` requires `holdsWork === false`: a worktree we POSITIVELY READ and found empty. It has
 * earned the right to say "nothing here is at risk".
 *
 * `tracked_elsewhere` is reached on `holdsWork !== true`, which also admits `undefined` — and
 * `uncommittedWorkEvidence` returns `undefined` for a tree that is DIRTY BUT PARKED (the sparkle-rhgm
 * attribution rule: a parked tree's dirt belongs to whatever branch was checked out into it). Giving
 * that row `local_none`'s sentence would tell a user "no edits in the working tree — nothing here is
 * at risk" about a tree that is, in fact, dirty. That is the same false-reassurance class this file's
 * header spends three paragraphs on, only inverted — and it is exactly what reusing the copy did.
 *
 * So this rung's copy asserts NOTHING about the worktree. It repeats what the section itself claims —
 * the work is tracked in another repository and cannot be measured from here — which is true whether
 * the tree is empty, dirty, or unread.
 */
const EMPTY_STAGE_COPY: Partial<Record<BuildSectionId, Partial<WorkflowStageMeta>>> = {
  local_none: {
    label: "Nothing Built Yet",
    short: "Empty",
    detail: "No commits and no edits in the working tree — nothing here is at risk.",
  },
  tracked_elsewhere: {
    label: "Tracked Elsewhere",
    short: "Elsewhere",
    // Deliberately silent about the worktree — see the doc comment above.
    detail:
      "This agent's work lands in another repository, so Sparkle can't measure its progress from this project.",
  },
};

/**
 * Should the ROW's stage chip stay silent entirely? Bead sparkle-tyter.
 *
 * The founder, on seeing the chip: *"If it's empty, we shouldn't say empty."* He is right, and the
 * reason is that the chip costs the same row space whatever it says. `honestStageMeta` already
 * fixed the chip's honesty problem — it stopped a `building_unsaved` row under "Nothing Yet" from
 * claiming unsaved work — but it fixed it by substituting the word "Empty", which spends a slot on
 * a row in a section whose own HEADING already says nothing is there. Two renderings of one fact,
 * the smaller one competing with the agent's name.
 *
 * So: no chip at all for that case. The information is not lost — the section heading carries it,
 * and the expanded card's `WorkflowLine` still renders the full "Nothing Built Yet" with its detail
 * sentence, which is the surface with room for it.
 *
 * IT LIVES HERE, NOT IN `StageChip`, for the reason this file's own header gives at length: the
 * copy rule took three passes to stop moving because each fix lived inside one of the components
 * that had to apply it. A predicate beside the override it is derived from cannot drift from it.
 */
export function stageChipIsSilent(stage: WorkflowStageId, section?: BuildSectionId): boolean {
  // Keyed on the SAME table `honestStageMeta` reads, so the two cannot drift apart — which is this
  // file header's whole argument for why both live here rather than inside the components that apply
  // them. A rung with an override has a heading that already carries the fact; the chip would spend a
  // row slot restating it beside the agent's name.
  return stage === "building_unsaved" && EMPTY_STAGE_COPY[section as BuildSectionId] !== undefined;
}


// ── Status bands (the filter) ────────────────────────────────────────────────────────────────
// The four buckets the filter chips toggle. These are the color tiers in packages/ui/tokens.ts
// AGENT_STATUS (RED / BLUE / GREEN / GRAY) — deliberately so, because the row's dot is painted from
// that same taxonomy. A chip therefore hides precisely the rows whose dot matches its own color,
// which is the only mapping a user can predict without being told.
//
// It was THREE until 2026-08-05, when `questions` (BLUE) became the fourth. The 1:1 pin is why THAT
// one had to become a band rather than ride inside `needs_you`: statusBandLabels.test.ts asserts
// every band is a different color and that each band's color comes from its own `colorFrom` status.
//
// ⚠️ `lapsed` (AMBER, 2026-08-06) IS THE ONE STATUS COLOR WITH NO BAND OF ITS OWN, and that is a
// decision rather than an omission. The pins above constrain BAND colors — that they are mutually
// distinct and each sourced from its own status — and say nothing about every STATUS color having a
// band. So the amber dot the founder asked for costs no fifth chip.
//
// It rides in `done` ("nothing is stopping you"), which is exactly true of it, and the only property
// this change actually needed is that it is NOT in `needs_you` — the band the concierge digest
// COUNTS and the red chip narrows. A fifth band was built first and then withdrawn: it forced a
// `lapsed: 0` into ~40 `Record<StatusBand, number>` literals across the concierge, the project tabs
// and their suites, which is a lot of churn and regression surface to buy a filter chip nobody
// asked for. If a "show me what gave up" chip is ever wanted, THAT is the change that earns the
// band — the taxonomy is ready for it, and this comment is the argument to overrule.
export type StatusBand = "needs_you" | "questions" | "running" | "done";

export interface StatusBandMeta {
  id: StatusBand;
  label: string;
  // The AGENT_STATUS key whose color this band paints its chip with. Spelled as a status rather
  // than a hex so the chip can never drift from the dots it filters (roborev: hardcoded palette
  // copies are how the dot and its legend fall out of sync).
  colorFrom: AgentTabStatus;
}

// ORDER IS THE CHIP ORDER, and `questions` sits second — after the alarm, ahead of the calm bands.
// Not first: a genuine red still outranks a question, because red means work has STOPPED and blue
// means work is about to be done right. Not last either — a question the founder never scrolls to
// is a stalled agent.
//
export const STATUS_BANDS: readonly StatusBandMeta[] = [
  { id: "needs_you", label: "Needs you", colorFrom: "waiting" },
  { id: "questions", label: "Questions", colorFrom: "questions" },
  { id: "running", label: "Running", colorFrom: "working" },
  { id: "done", label: "Done", colorFrom: "idle" },
] as const;

// Which band a status falls in. Mirrors the AGENT_STATUS color tiers exactly:
//   RED   → needs_you  (waiting/approval/blocked/errored)
//   BLUE  → questions  (questions)
//   GREEN → running    (working)
//   GRAY  → done       (idle/done/stopped/unmerged)
//
// `questions` gets its own band rather than joining `needs_you`, and the difference is not cosmetic:
// `needs_you` is the band the concierge digest COUNTS and the red filter chip narrows, so folding
// questions into it would make "N agents need you" include the agents that are working exactly as
// intended — the same false-alarm inflation that `new` and `unmerged` were moved out of that band
// to fix. A question is an ask, but it is not an alarm.
// `unmerged` is GRAY and therefore lands in "done", which is correct here: it means "finished, but
// the work hasn't landed" — and WHERE that work got to is now carried by the stage section it sits
// in, not by its status. That's the whole division of labor: section = how far the work got,
// dot = whether the agent needs you.
//
// `new` (spawned, never briefed — engine/newAgentAttention) also lands in "done", and what matters
// is which band it is kept OUT of: "needs_you" is the band the concierge digest COUNTS and the
// filter chip narrows, so banding an un-briefed agent there produces exactly the false "N agents
// need you" that status was added to kill. "done" overstates it slightly — nothing was done — but
// the vocabulary is three-valued (see STATUS_BANDS) and "nothing is stopping you" is the right one
// of the three.
/** Is the column narrowed to the ASKING bands and nothing else — the state the "Needs you" pill
 *  renders as pressed, and the thing its click toggles?
 *
 *  ONE SEAM, because there were two copies and they drifted the moment a band was added. Both spelled
 *  `needs_you && !running && !done`, which silently answered "yes" while the `questions` band was
 *  also showing, and — worse — the toggle they guarded narrowed to `needs_you` ALONE, switching blue
 *  off. `questions` means the agent cannot proceed without you exactly as `waiting`/`approval` do
 *  (engine/attention has always classified it that way), so that hid owed work behind a control the
 *  founder reads as "show me what needs me". Derived from STATUS_BANDS rather than listed, so a
 *  fifth band is a compile-time decision here instead of a silent omission (bead sparkle-qogah). */
export const ASKING_BANDS: readonly StatusBand[] = ["needs_you", "questions"];

export function isAskingIsolated(filter: Record<StatusBand, boolean>): boolean {
  return STATUS_BANDS.every((b) => filter[b.id] === ASKING_BANDS.includes(b.id));
}

export function bandOfStatus(status: AgentTabStatus): StatusBand {
  switch (status) {
    case "waiting":
    case "approval":
    case "blocked":
    case "errored":
      return "needs_you";
    case "questions":
      return "questions";
    case "working":
      return "running";
    // AMBER → `done`, and the load-bearing half is which band it is kept OUT of. `needs_you` is the
    // band the concierge digest COUNTS and the red chip narrows, and an agent whose auto-continue
    // budget ran out is not asking the human for anything — banding it there would re-create the
    // exact "N agents need you" inflation this tier was added to answer. `done` ("nothing is
    // stopping you") is true of it; the amber DOT is what carries "the machinery stopped", the same
    // division of labor `unmerged` and `new` already use. See the StatusBand comment above for why
    // it has no band of its own.
    case "lapsed":
    case "idle":
    case "done":
    case "stopped":
    case "unmerged":
    case "new":
      return "done";
  }
}

// All bands visible — the default, and the shape the filter state is stored in.
export function allBandsVisible(): Record<StatusBand, boolean> {
  return { needs_you: true, questions: true, running: true, done: true };
}

// NOTE: the band's LABELS and COLORS live in engine/statusBandLabels (bandLabel / bandColor /
// bandCountLabel). This module owns the vocabulary — which bands exist, which status falls in
// which — and deliberately not how they are written or painted, so a rendering tweak never touches
// the taxonomy every surface derives from.

// ── Grouping ─────────────────────────────────────────────────────────────────────────────────
export interface BuildSectionGroup<T> {
  id: BuildSectionId;
  meta: BuildSectionMeta;
  rows: T[];
}

/**
 * Bucket `agents` into the stage ladder, preserving each agent's INPUT ORDER within its section
 * (that order is the user's own drag arrangement — see projectStore.reorderAgent), and dropping
 * rows whose status band is filtered off.
 *
 * Returns only NON-EMPTY sections, in ladder order: an empty section renders nothing at all, so the
 * column shows just the rungs that currently have work on them. A section emptied by the filter is
 * therefore hidden too — same rule, applied consistently.
 *
 * Pure and id-preserving: the union of the returned `rows` is a subset (a permutation of the
 * unfiltered rows), so selection — tracked by id, never by position — is never disturbed.
 */
export function groupAgentsByStage<T extends { id: string }>(
  agents: readonly T[],
  stageOf: (id: string) => WorkflowStageId,
  statusOf: (id: string) => AgentTabStatus,
  visibleBands: Record<StatusBand, boolean>,
  /** Which band a row belongs to for FILTERING. Defaults to the row's own status, which is what
   *  every caller wanted until orchestrator heads started rolling their workers up: a head with a
   *  blocked worker is painted red but is itself `idle`, so filtering on its own status hid it from
   *  the very chip a user clicks to find blocked work. Callers that paint a rolled-up disc pass the
   *  matching accessor so the dot and the chip agree — see engine/workerRollup.bandOfRollup.
   *
   *  Optional rather than required so `statusOf`-only callers keep working unchanged; pass BOTH
   *  consistently, though, since a caller whose dot and filter disagree is the bug this exists to
   *  prevent. */
  bandOf: (id: string) => StatusBand = (id) => bandOfStatus(statusOf(id)),
  /** Does this row's worktree hold anything? `undefined` = not looked up (or parked). Only consulted
   *  for rows that would land in `local_uncommitted` — see {@link sectionOfRow}.
   *
   *  ⚠️ REQUIRED, THOUGH `undefined` IS STILL A LEGAL VALUE — and the difference between those two
   *  facts is the whole point (bead `sparkle-l5fi7`). Passing `undefined` reproduces the
   *  pre-sparkle-biezi behaviour exactly (every such row stays in `local_uncommitted`), so a caller
   *  with no worktree reading is still not forced to invent one. What it can no longer do is OMIT
   *  the argument by accident: this used to be `holdsWorkOf?`, which made deleting the wiring from
   *  a production call site neither a type error nor a test failure, and the rung was reachable
   *  only through it. A comment asserting that drift is impossible is not a mechanism; an arity
   *  error is. The tests are the second mechanism — one per call site, each mutation-checked by
   *  actually deleting the argument (AgentSidebar.ladderAccessorWiring.test.tsx).
   *
   *  ⚠️ BUT PASS IT CONSISTENTLY. This changes which SECTION a row lands in, and therefore the
   *  flattened row ORDER (`local_none` sorts above `local_uncommitted`). Two callers that disagree
   *  produce two different orders for the same fleet — which is precisely the drift that made
   *  `firstLadderRowId` hand selection to a row the column was not rendering (roborev 53858). The
   *  three production callers (AgentSidebar, ladderSelection, conciergeTools/sidebarView) all derive
   *  it from `runtimeStore.branchStatus` through the same `uncommittedWorkEvidence`. */
  holdsWorkOf: ((id: string) => boolean | undefined) | undefined,
  /** Does this row's work live outside the bound project? See {@link sectionOfRow}.
   *
   *  ⚠️ SAME CONSISTENCY RULE AS `holdsWorkOf`, for the same reason: it changes which section a row
   *  lands in and therefore the flattened row ORDER, so two callers that disagree hand selection to a
   *  row the column is not rendering. Every production caller derives it from the same
   *  `engine/crossRepo.crossRepoReading` over the same agent record.
   *
   *  ⚠️ REQUIRED for the same reason as `holdsWorkOf` above — pass `undefined` to mean "no reading",
   *  never nothing at all. */
  crossRepoOf: ((id: string) => CrossRepoReading | undefined) | undefined,
): BuildSectionGroup<T>[] {
  const buckets = new Map<BuildSectionId, T[]>();
  for (const agent of agents) {
    if (!visibleBands[bandOf(agent.id)]) continue;
    const section = sectionOfRow(
      stageOf(agent.id),
      holdsWorkOf?.(agent.id),
      crossRepoOf?.(agent.id),
    );
    const arr = buckets.get(section);
    if (arr) arr.push(agent);
    else buckets.set(section, [agent]);
  }
  // Iterate BUILD_SECTIONS (not the map) so the output is always in ladder order regardless of the
  // order rows happened to arrive in.
  return BUILD_SECTIONS.filter((s) => (buckets.get(s.id)?.length ?? 0) > 0).map((s) => ({
    id: s.id,
    meta: s,
    rows: buckets.get(s.id) as T[],
  }));
}

/** The flat, rendered row order — every visible row, ladder order, drag order within a section. */
export function flattenSections<T extends { id: string }>(
  groups: readonly BuildSectionGroup<T>[],
): T[] {
  return groups.flatMap((g) => g.rows);
}
