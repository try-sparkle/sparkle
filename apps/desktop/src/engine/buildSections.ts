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
import { type WorkflowStageId, stageIndex } from "./workflowStage";

// ── The ladder ───────────────────────────────────────────────────────────────────────────────
export type BuildSectionId =
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
    id: "local_uncommitted",
    label: "Local: Uncommitted",
    detail: "Changes exist only in the working tree — closing this agent loses them.",
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

// NOTE: an `isLocalOnlyMerge(stage)` helper was removed here. It claimed a row at `merged_local`
// was "local only (never pushed)", which the stage does not prove (see the boundary note above), and
// it drove a "local only" row qualifier that would therefore have lied to exactly the users the
// Local/Remote split exists to reassure. If you want that qualifier back, gate it on the PUSH signal
// — `BranchStatus`/`WorkflowState`, which only the caller has — not on the stage id alone.

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
): BuildSectionGroup<T>[] {
  const buckets = new Map<BuildSectionId, T[]>();
  for (const agent of agents) {
    if (!visibleBands[bandOfStatus(statusOf(agent.id))]) continue;
    const section = sectionOfStage(stageOf(agent.id));
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
