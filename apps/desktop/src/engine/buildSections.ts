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
import { stageMeta, type WorkflowStageId, type WorkflowStageMeta } from "./workflowStage";

// ── The ladder ───────────────────────────────────────────────────────────────────────────────
export type BuildSectionId =
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
export const BUILD_SECTIONS: readonly BuildSectionMeta[] = [
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
): BuildSectionId {
  const section = sectionOfStage(stage);
  if (section !== "local_uncommitted") return section;
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
  if (section !== "local_none" || stage !== "building_unsaved") return meta;
  return {
    ...meta,
    label: "Nothing Built Yet",
    short: "Empty",
    detail: "No commits and no edits in the working tree — nothing here is at risk.",
  };
}

// ── Status bands (the filter) ────────────────────────────────────────────────────────────────
// The three buckets the filter chips toggle. These are EXACTLY the three color tiers in
// packages/ui/tokens.ts AGENT_STATUS (RED / GREEN / GRAY) — deliberately so, because the row's dot
// is painted from that same taxonomy. A chip therefore hides precisely the rows whose dot matches
// its own color, which is the only mapping a user can predict without being told.
export type StatusBand = "needs_you" | "running" | "done";

export interface StatusBandMeta {
  id: StatusBand;
  label: string;
  // The AGENT_STATUS key whose color this band paints its chip with. Spelled as a status rather
  // than a hex so the chip can never drift from the dots it filters (roborev: hardcoded palette
  // copies are how the dot and its legend fall out of sync).
  colorFrom: AgentTabStatus;
}

export const STATUS_BANDS: readonly StatusBandMeta[] = [
  { id: "needs_you", label: "Needs you", colorFrom: "waiting" },
  { id: "running", label: "Running", colorFrom: "working" },
  { id: "done", label: "Done", colorFrom: "idle" },
] as const;

// Which band a status falls in. Mirrors the AGENT_STATUS color tiers exactly:
//   RED   → needs_you  (waiting/approval/blocked/errored)
//   GREEN → running    (working)
//   GRAY  → done       (idle/done/stopped/unmerged)
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
export function bandOfStatus(status: AgentTabStatus): StatusBand {
  switch (status) {
    case "waiting":
    case "approval":
    case "blocked":
    case "errored":
      return "needs_you";
    case "working":
      return "running";
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
  return { needs_you: true, running: true, done: true };
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
   *  OPTIONAL, and omitting it reproduces the pre-sparkle-biezi behaviour exactly: every such row
   *  stays in `local_uncommitted`. That is deliberate rather than lazy — a caller with no worktree
   *  reading must not be forced to invent one, and the default is the conservative arm.
   *
   *  ⚠️ BUT PASS IT CONSISTENTLY. This changes which SECTION a row lands in, and therefore the
   *  flattened row ORDER (`local_none` sorts above `local_uncommitted`). Two callers that disagree
   *  produce two different orders for the same fleet — which is precisely the drift that made
   *  `firstLadderRowId` hand selection to a row the column was not rendering (roborev 53858). The
   *  three production callers (AgentSidebar, ladderSelection, conciergeTools/sidebarView) all derive
   *  it from `runtimeStore.branchStatus` through the same `uncommittedWorkEvidence`. */
  holdsWorkOf?: (id: string) => boolean | undefined,
): BuildSectionGroup<T>[] {
  const buckets = new Map<BuildSectionId, T[]>();
  for (const agent of agents) {
    if (!visibleBands[bandOf(agent.id)]) continue;
    const section = sectionOfRow(stageOf(agent.id), holdsWorkOf?.(agent.id));
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
