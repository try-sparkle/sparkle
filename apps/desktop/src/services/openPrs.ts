// How many pull requests this identity has open in a project's repo — the "waiting on you" count
// behind the TopBar badge.
//
// Why this exists as a REPO-scoped probe rather than reading the agent roster: the app already
// tracks a PR per agent (workflowState.prState drives the per-agent "Merge PR" CTA), but that
// signal lives and dies with the agent. Every agent runs in its own worktree and leaves the sidebar
// when its session ends, so a PR opened by a finished agent becomes invisible — which is precisely
// the window in which it is waiting to be merged. Counting from the repo instead of the roster is
// what makes an orphaned PR visible at all.
//
// See PRD/sparkle-pr-awaiting-merge-badge.md.
import { invoke } from "@tauri-apps/api/core";

/** One open PR as surfaced to the TopBar PR menu. Mirrors the Rust `PrRow` (camelCase). `checks` is
 *  the aggregate CI rollup and `mergeable` is GitHub's async-computed conflict state; together they
 *  drive `prMergeEligibility`. */
export interface PrRow {
  number: number;
  title: string;
  headRefName: string;
  url: string;
  checks: "passing" | "pending" | "failing" | "none";
  mergeable: "mergeable" | "conflicting" | "unknown";
  /**
   * The agent that opened this PR, from the DURABLE mapping Rust's `pr_owner` keeps — or `null`
   * when nothing identifies it.
   *
   * This is what makes a PR clickable back to its owner regardless of what the branch is called.
   * It used to be derived by parsing `sparkle/agent-<id>` out of `headRefName`, which meant the
   * PRs most worth clicking into — the ones on descriptive branches like `sparkle/left-pair` —
   * resolved to nothing at all.
   *
   * NEVER infer a value for this. A pill carrying the wrong agent id opens the wrong agent, which
   * is strictly worse than no pill: the user cannot tell it went astray. `null` means "unknown",
   * not "no agent". Optional in the type so a Rust build predating the field reads as undefined.
   */
  agentId?: string | null;
  /** Which `pr_owner` source produced `agentId` ("created" | "pr-body" | "worktree-branch" |
   *  "branch-name"); absent alongside a null owner. */
  agentIdSource?: string | null;
}

/** The open PRs waiting in `root`'s repo, or null when it could not be determined (no `gh`, unauthed,
 *  offline, no remote, timeout). Null is NOT an empty list — the menu renders nothing for both, but
 *  a confident "no PRs" on a failed probe is exactly the false reassurance to avoid.
 *
 *  `projectId` scopes the ownership lookup (and its backfill), which is keyed per project so an
 *  agent id can never resolve into a project the user isn't looking at. */
export async function fetchOpenPrs(root: string, projectId: string): Promise<PrRow[] | null> {
  if (!root) return null;
  try {
    const rows = await invoke<PrRow[] | null>("project_open_prs", { root, projectId });
    return Array.isArray(rows) ? rows : null;
  } catch {
    // Best-effort by design: a probe failure must never surface as an error toast. The menu simply
    // doesn't render, which is honest — we don't know.
    return null;
  }
}

/** Who owns a PR, for one `fetchOpenPrs` could not list (someone else's, or past the 100-row cap).
 *  Mirrors the Rust `PrOwnerAnswer`: an unknown owner is `agentId: null` WITH a `reason`, never a
 *  guess, so a caller can say "unresolved" instead of pointing at the wrong agent. */
export interface PrOwnerAnswer {
  number: number;
  agentId: string | null;
  source: string | null;
  branch: string | null;
  reason: string | null;
}

/** Resolve one PR's owning agent by number. Rejects only on an IPC failure — an unresolvable owner
 *  is a successful answer with `agentId: null`. */
export function fetchPrOwner(
  root: string,
  projectId: string,
  number: number,
): Promise<PrOwnerAnswer> {
  return invoke<PrOwnerAnswer>("pr_owner", { root, projectId, number });
}

/** Ask GitHub to merge PR `number` with a MERGE COMMIT (the Rust `merge_pr` command). Rejects with
 *  gh's own error text when the merge is declined (red required checks, a conflict, lost auth), which
 *  the menu surfaces so the user sees exactly why. */
export async function mergePr(root: string, number: number): Promise<void> {
  await invoke("merge_pr", { root, number });
}

export interface MergeEligibility {
  /** Whether the menu should ENABLE the merge action. */
  canMerge: boolean;
  /** When blocked, a short human reason for the tooltip; null when mergeable. */
  reason: string | null;
}

/**
 * Whether a PR is safe to merge from the menu, and if not, why. Pure so the gate is tested without
 * Tauri. This encodes AGENTS.md's rule — never merge over red checks or a conflict, and wait for
 * checks before merging — as a UI gate: a human clicking Merge IS the deliberate gate the workflow
 * wants, but only once it is actually safe.
 *
 * - `conflicting` → blocked: a merge would fail or force a bad resolution.
 * - `failing` checks → blocked: never merge red.
 * - `pending` checks → blocked: "wait for checks, then merge" — gh would refuse a required-check
 *   merge anyway, so blocking here is honest rather than a click that errors.
 * - `passing`/`none` with a non-conflicting (incl. async-`unknown`) mergeability → allowed; gh is
 *   the backstop for anything the probe hasn't caught up to yet.
 */
export function prMergeEligibility(pr: Pick<PrRow, "checks" | "mergeable">): MergeEligibility {
  if (pr.mergeable === "conflicting")
    return { canMerge: false, reason: "Has conflicts with the base branch" };
  if (pr.checks === "failing") return { canMerge: false, reason: "Checks are failing" };
  if (pr.checks === "pending") return { canMerge: false, reason: "Checks are still running" };
  return { canMerge: true, reason: null };
}

/**
 * What the badge should read, or null to render NOTHING.
 *
 * Pure so the unknown-vs-zero rule is testable without Tauri. Both `null` (couldn't find out) and
 * `0` (nothing waiting) render nothing, but for different reasons, and conflating them is the bug
 * this guards: a confident "0 PRs" on a machine that merely failed to look is exactly the false
 * reassurance the badge exists to prevent. Zero renders nothing because an always-present "0" is
 * chrome noise; unknown renders nothing because we have nothing to say.
 */
export function formatPrBadge(count: number | null): string | null {
  if (count === null || count <= 0) return null;
  // The probe asks `gh` for at most OPEN_PR_QUERY_LIMIT rows, so a count AT the limit means "at
  // least this many" — rendering a bare "100" would silently understate, which is the same
  // false-reassurance failure the null-vs-zero rule guards against, one step further out.
  if (count >= OPEN_PR_QUERY_LIMIT) return `${OPEN_PR_QUERY_LIMIT}+ PRs waiting`;
  return count === 1 ? "1 PR waiting" : `${count} PRs waiting`;
}

/** Row cap on the `gh pr list` query, mirrored from the Rust probe. A count that reaches this is
 *  saturated, not exact — see `formatPrBadge`. Kept in sync deliberately rather than plumbed
 *  through the IPC boundary: it is a display concern, and the alternative is a second field on
 *  every reply that only ever means "was the query truncated". */
export const OPEN_PR_QUERY_LIMIT = 100;

/** How often to re-probe. This shells out to `gh` over the network, so it is deliberately far
 *  slower than the 30s sidebar poll — an unmerged PR is a slow-moving fact, and a chatty probe
 *  would spend rate limit for no added signal. */
export const OPEN_PR_POLL_MS = 180_000;
