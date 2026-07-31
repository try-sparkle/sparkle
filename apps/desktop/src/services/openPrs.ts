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
   * GitHub's `mergeStateStatus`, lowercased — the axis `mergeable` cannot express.
   *
   * `mergeable` answers "would git accept this merge"; this answers "is anything else wrong".
   * They are DIFFERENT QUESTIONS and the dot used to collapse them into one colour, which is why
   * its colours read as arbitrary. `unstable` is the case that proves it: GitHub reports
   * `mergeable: "mergeable"` — you genuinely CAN merge — while a non-required check is red or
   * still running.
   *
   * `undefined` means the caller did not supply it (a partial fixture), which is NOT the same as
   * the string `"unknown"` — that is GitHub actively saying it has not finished computing. Only
   * the latter blocks.
   */
  mergeStateStatus?:
    | "clean"
    | "dirty"
    | "unstable"
    | "blocked"
    | "behind"
    | "draft"
    | "has_hooks"
    | "unknown";
  /** Names of the checks that FAILED, so the UI can say WHICH rather than "checks failing". */
  failingChecks?: string[];
  /** Names of the checks still RUNNING. A PR can have both. */
  pendingChecks?: string[];
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
 * A THIN VIEW over {@link prMergeReadiness}, which owns the whole rule; this exists so callers that
 * only need the yes/no keep a two-field answer. The list below is the summary — read that function
 * for the ordering and the reasoning.
 *
 * - `conflicting` / `dirty` → blocked: a merge would fail or force a bad resolution.
 * - `failing` checks → blocked: never merge red.
 * - `pending` checks → blocked: "wait for checks, then merge" — gh would refuse a required-check
 *   merge anyway, so blocking here is honest rather than a click that errors.
 * - `unstable`, `blocked`, `draft`, `behind` → blocked: GitHub itself says something is wrong.
 * - `unknown` mergeability → BLOCKED, and this is the part that changed. It used to be allowed
 *   ("gh is the backstop for anything the probe hasn't caught up to yet"), which is exactly how an
 *   amber dot ended up beside a live one-click Merge — the common case, since GitHub invalidates
 *   mergeability on every push to the base. A gate must not offer a confident button over an answer
 *   it does not have. The panel's Refresh re-asks rather than making the user wait out the poll.
 * - `passing`/`none` with `mergeable` and a clean merge state → allowed. Nothing else is.
 */
export function prMergeEligibility(pr: PrJudgeable): MergeEligibility {
  const r = prMergeReadiness(pr);
  return { canMerge: r.canMerge, reason: r.canMerge ? null : r.title };
}

/** The subset of a PR this module judges. The newer fields are optional so a partial fixture (or a
 *  caller predating them) still typechecks — see `mergeStateStatus` for why absent ≠ "unknown". */
export type PrJudgeable = Pick<PrRow, "checks" | "mergeable"> &
  Partial<Pick<PrRow, "mergeStateStatus" | "failingChecks" | "pendingChecks">>;

/**
 * The ONE question the status dot answers: **is this PR safe to merge right now?**
 *
 * Everything the menu paints for a row — the dot's colour, the WORD beside it, whether Merge is a
 * one-click button, and whether an override is offered instead — comes from this single call, so
 * those four can never disagree with each other.
 *
 * The rule, most-blocking first:
 * - **Conflicts** (`mergeable: "conflicting"` or `mergeStateStatus: "dirty"`) → red, no merge, no
 *   override. Nothing the app can do makes this merge.
 * - **A failing check** → red, no one-click merge. An override is offered ONLY when GitHub itself
 *   says the merge would succeed (`unstable`), because there the answer is genuinely ambiguous:
 *   the failing check is not required, so GitHub would let it through.
 * - **Checks still running** → amber, no merge. This is NOT-YET rather than a warning: merging now
 *   is merging blind, which is the entire thing the checks gate exists to prevent.
 * - **Branch protection / draft** → red, no merge, no override (GitHub would refuse anyway).
 * - **Mergeability not yet computed** (`mergeable: "unknown"` / `mergeStateStatus: "unknown"`) →
 *   amber, no merge. See the note below; this is the case that produced the reported bug.
 * - **Behind the base branch** → amber, no merge and NO override; the tooltip says to update the
 *   branch. GitHub reports BEHIND only when the base requires an up-to-date head, which is the same
 *   setting that makes it refuse the merge — so an override here is a button that ends in an error.
 * - Otherwise → **green**, one-click Merge, prominent.
 *
 * **What changed and why.** This used to be two functions that disagreed on purpose. `prStatusDot`
 * treated `mergeable: "unknown"` as amber while `prMergeEligibility` returned `canMerge: true` for
 * it, on the reasoning that "blocking would strand mergeable PRs and gh is the backstop". The
 * result was an ENABLED Merge button sitting under a YELLOW dot — and since GitHub recomputes
 * mergeability asynchronously on every push to the base, that state is common, not a corner case.
 * The founder's report is exactly this: *"ready to merge means that it would be green, and it's a
 * little bit scary as a user to be clicking on a button that has a yellow dot instead of a green
 * dot."* A gate whose button contradicts its own indicator is not a gate. The invariant is now the
 * strict one: **`canMerge` implies `tone === "ready"`, and `tone === "ready"` implies `canMerge`** —
 * asserted exhaustively in the test file over every field combination.
 */
export interface PrReadiness {
  /** Green / amber / red. There is no fourth "informational" tone: every PR is either safe to
   *  merge now or it is not, and a muted dot for "no checks ran" was a third answer to a
   *  yes/no question. */
  tone: "ready" | "waiting" | "blocked";
  /**
   * The WORD shown NEXT TO the dot — "Conflicts", "1 check failing", "Checks running (3)". Never
   * null for a non-green PR, so the state never depends on colour perception alone (the founder's
   * screenshot had five dots and no words). Null exactly when green, where the enabled Merge
   * button is itself the label.
   */
  label: string | null;
  /** Full tooltip: the label plus the offending check NAMES where there are any. */
  title: string;
  /** Whether to offer a one-click Merge. True only when `tone === "ready"`. */
  canMerge: boolean;
  /**
   * Set when GitHub would accept the merge but this app will not call it safe — the `unstable`
   * case, and ONLY that one. The menu renders it as a deliberate two-step override rather than the
   * same one-click Merge, because GitHub's own answer there is genuinely ambiguous (it reports
   * `mergeable: MERGEABLE` while a non-required check is red or running) and the user should have
   * to mean it.
   *
   * `behind` used to be the second case and is not any more: the claim has to be CHECKABLE, and
   * BEHIND is reported precisely when GitHub is likely to refuse. See `githubWouldAccept`.
   */
  override: { label: string; reason: string } | null;
}

/** `["a","b","c"]` → `"a, b and c"`, capped so a 12-check rollup does not produce a paragraph. */
function nameList(names: string[], cap = 3): string {
  const shown = names.slice(0, cap);
  const rest = names.length - shown.length;
  const joined =
    shown.length <= 1
      ? (shown[0] ?? "")
      : `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
  return rest > 0 ? `${joined} (+${rest} more)` : joined;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

export function prMergeReadiness(pr: PrJudgeable): PrReadiness {
  // Trust the NAME ARRAYS when present, but never let an empty array override the rollup word: an
  // older Rust build serves `checks: "failing"` with no names, and "no names" must not read as
  // "nothing wrong".
  const failing = pr.failingChecks ?? [];
  const pending = pr.pendingChecks ?? [];
  const anyFailing = failing.length > 0 || pr.checks === "failing";
  const anyPending = pending.length > 0 || pr.checks === "pending";
  const state = pr.mergeStateStatus;
  // GitHub says the merge itself would succeed — the only ground on which an override is honest.
  //
  // UNSTABLE ALONE, not `unstable || behind`. This term also gates the failing/pending branches
  // above, so admitting BEHIND here handed a "GitHub would accept this merge" override to a PR that
  // is both behind AND red — carrying the false claim into a branch that never mentions being
  // behind. UNSTABLE is checkable (GitHub reports `mergeable: MERGEABLE` beside it); BEHIND is
  // reported when the base requires an up-to-date head, i.e. when the merge is likely to be refused.
  const githubWouldAccept = pr.mergeable === "mergeable" && state === "unstable";

  if (pr.mergeable === "conflicting" || state === "dirty")
    return {
      tone: "blocked",
      label: "Conflicts",
      title: "Conflicts with the base branch — this cannot be merged until they are resolved",
      canMerge: false,
      override: null,
    };

  if (anyFailing) {
    const n = failing.length;
    const label = n > 0 ? `${n} ${plural(n, "check", "checks")} failing` : "Checks failing";
    return {
      tone: "blocked",
      label,
      title: n > 0 ? `${label}: ${nameList(failing)}` : "Checks are failing",
      canMerge: false,
      override: githubWouldAccept
        ? {
            label: "Merge anyway",
            reason:
              n > 0
                ? `GitHub would accept this merge — ${nameList(failing)} ${plural(n, "is", "are")} not a required check. Merging leaves ${plural(n, "it", "them")} red on main.`
                : "GitHub would accept this merge — the failing checks are not required. Merging leaves them red on main.",
          }
        : null,
    };
  }

  if (anyPending) {
    const n = pending.length;
    const label = n > 0 ? `Checks running (${n})` : "Checks running";
    return {
      tone: "waiting",
      label,
      title:
        n > 0
          ? `${label}: ${nameList(pending)} — merging now is merging blind`
          : "Checks are still running — merging now is merging blind",
      canMerge: false,
      override: githubWouldAccept
        ? {
            label: "Merge anyway",
            reason: `GitHub would accept this merge — ${n > 0 ? nameList(pending) : "the running checks"} ${plural(n, "is", "are")} not required. You would be merging before ${plural(n, "it reports", "they report")}.`,
          }
        : null,
    };
  }

  // UNSTABLE with nothing named. GitHub only reports UNSTABLE when a check is red or running, so
  // reaching here means the rollup and the merge state disagree — a rollup that arrived a beat
  // ahead of the state, or a check GitHub counts and the rollup does not. Withhold green either
  // way: "GitHub says something is wrong but we cannot say what" is not a green light. Without this
  // the contradictory pair (passing rollup + unstable state) fell through to READY.
  if (state === "unstable")
    return {
      tone: "blocked",
      label: "Checks not clean",
      title:
        "GitHub reports this PR as unstable — a check is failing or still running, even though the rollup looks clear",
      canMerge: false,
      override: githubWouldAccept
        ? {
            label: "Merge anyway",
            reason: "GitHub would accept this merge, but it does not consider the PR clean.",
          }
        : null,
    };

  if (state === "blocked")
    return {
      tone: "blocked",
      label: "Blocked",
      title: "Branch protection is blocking this merge (a required review or check is missing)",
      canMerge: false,
      override: null,
    };

  if (state === "draft")
    return {
      tone: "blocked",
      label: "Draft",
      title: "This PR is still a draft — mark it ready for review before merging",
      canMerge: false,
      override: null,
    };

  // NOT-YET, not a warning. GitHub computes mergeability asynchronously and invalidates it on every
  // push to the base branch, so "unknown" genuinely means "we do not know" — and the one thing a
  // merge gate must never do is offer a confident button over an answer it does not have.
  if (pr.mergeable === "unknown" || state === "unknown")
    return {
      tone: "waiting",
      label: "Checking mergeability",
      title: "GitHub has not finished working out whether this can merge — wait for it to settle",
      canMerge: false,
      override: null,
    };

  if (state === "behind")
    return {
      tone: "waiting",
      label: "Behind base",
      title: "This branch is behind the base branch — update it so it is tested against current main",
      canMerge: false,
      // NO OVERRIDE — and this is the one branch where that differs from the others.
      //
      // Every other override justifies itself with "GitHub would accept this merge", which is
      // checkable: for UNSTABLE, GitHub literally reports `mergeable: MERGEABLE` alongside it. It is
      // not checkable here, and is usually FALSE. GitHub reports BEHIND when the base requires the
      // head to be up to date — which is the same setting that makes it refuse the merge — so the
      // condition that produces this state is very nearly the condition that dooms the button.
      //
      // Rewording the override was not enough (roborev 56141): a row with an override renders it as
      // its ONLY merge affordance, so copy saying "updating the branch is the safe move" sat on the
      // one button that does the merge instead, and there is no update-branch action in the panel to
      // point at. An affordance that ends in a `gh` error after two deliberate clicks is worse than
      // none — the word "Behind base" and the tooltip say what to do.
      override: null,
    };

  return {
    tone: "ready",
    label: null,
    title:
      pr.checks === "none"
        ? "No checks on this PR, and GitHub reports it clean — ready to merge"
        : "All checks passed and there are no conflicts — ready to merge",
    canMerge: true,
    override: null,
  };
}

/** How a PR's status dot should read. A TONE rather than a colour so the rule stays pure and
 *  testable here while the palette stays a component concern. */
export type PrDotTone =
  /** Green — you can merge this RIGHT NOW. */
  | "ready"
  /** Amber — not merge-able yet (checks running, mergeability still being computed, behind base). */
  | "waiting"
  /** Red — merging is impossible or unsafe as things stand (a conflict, or a red check). */
  | "blocked";

export interface PrStatusDot {
  tone: PrDotTone;
  /** Tooltip text naming the ACTUAL blocker, not just the CI rollup. */
  title: string;
  /** The word rendered beside the dot; null exactly when green. See {@link PrReadiness.label}. */
  label: string | null;
}

/**
 * What a PR's status dot should say — derived from BOTH the CI rollup and GitHub's mergeability.
 *
 * The invariant, and the whole reason this is not a `switch` on `pr.checks`: **`tone: "ready"`
 * implies `prMergeEligibility(pr).canMerge`.** Green means "you can merge this right now" and
 * nothing else. The exhaustive test asserts that implication over every checks × mergeable pair, so
 * the dot and the Merge button cannot drift apart.
 *
 * They HAD drifted, and that is the bug this fixes: the dot was a pure function of `checks`, so PR
 * #779 — 17 passing checks, `mergeable: "conflicting"`, completely unmergeable — rendered the same
 * confident green as a PR that was ready to land. A green dot on a PR that can never merge is worse
 * than no dot: it sends the user to click a button that cannot work.
 *
 * The implication is BI-directional: `tone === "ready"` ⟺ `canMerge`. It used to be stated here as
 * one-directional, with a muted `"none"` tone for "canMerge but not green" — and that gap is
 * precisely where the bug lived, because the reverse direction is what decides whether a Merge
 * button exists. The `"none"` tone is gone from {@link PrDotTone}; a PR with no checks that GitHub
 * reports clean is GREEN, because it is in fact ready to merge. The exhaustive test asserts the
 * equivalence in both directions over every checks × mergeable × mergeStateStatus combination.
 *
 * `unknown` mergeability is deliberately `waiting`, not `ready`. GitHub computes mergeability
 * asynchronously and invalidates it on every push to the base branch, so `unknown` genuinely means
 * "we do not know yet" — and a dot that renders confident green on an unknown is the same false
 * reassurance in a narrower window. The Merge button is DISABLED there too, which is the half that
 * used to be missing: it stayed enabled on the reasoning that "blocking would strand mergeable PRs
 * and gh is the backstop", so the routine case rendered an amber dot beside a live one-click Merge.
 * Nothing is stranded — the panel's Refresh re-asks GitHub on demand rather than leaving the user
 * behind the poll interval.
 */
export function prStatusDot(pr: PrJudgeable): PrStatusDot {
  const r = prMergeReadiness(pr);
  return { tone: r.tone, title: r.title, label: r.label };
}

/**
 * How many of `prs` are GREEN — the number "Merge all ready (N)" counts and the only number the
 * small header pill shows.
 *
 * Deliberately counts `tone === "ready"` rather than "not blocked": the header said
 * "Merge all ready (1)" while offering one-click merge on four PRs that were not ready, so the app
 * already knew the right answer and simply did not act on it everywhere.
 */
export function prReadyCount(prs: readonly PrJudgeable[]): number {
  return prs.filter((p) => prMergeReadiness(p).tone === "ready").length;
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
