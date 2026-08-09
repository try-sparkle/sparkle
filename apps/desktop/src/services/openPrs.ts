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
  /**
   * GitHub's `updatedAt`, verbatim, or `""`/absent when the probe could not supply it.
   *
   * A CHANGE DETECTOR, not a clock — compared only for equality against the previous sighting,
   * never parsed or ordered, so a format change costs an extra read rather than a wrong answer.
   * GitHub bumps it on any comment, review, push or label, which is exactly the set of events that
   * can change a PR's knightwatch probes.
   *
   * OPTIONAL because a Rust backend predating the field omits it, and EMPTY MUST MEAN "changed":
   * treating two absent values as equal would suppress the probe read forever on a `gh` that
   * stopped returning it, silencing that PR with no signal.
   */
  updatedAt?: string;
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
   * The head commit SHA — the FINGERPRINT a dismissal is judged against.
   *
   * A dismissal means "not now", so it has to expire once the PR stops being the one that was
   * waved away, and a push is the cheapest honest signal of that. An empty or absent value means
   * "cannot compare" and never counts as unchanged: see `services/prDismissals.ts`.
   */
  headRefOid?: string;
  /**
   * Whether THIS identity may merge in the repo this PR targets — `null`/`undefined` when we could
   * not find out, which is NOT the same as `false`.
   *
   * A repo the user can open PRs into but not merge (an open-source project they do not control)
   * used to render a Merge button that could only ever come back with `GraphQL: <user> does not
   * have the correct permissions to execute MergePullRequest`. The permission is knowable before
   * the click, so the gate reads it — see `prMergeReadiness`, which blocks only on an explicit
   * `false`.
   */
  viewerCanMerge?: boolean | null;
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
  /**
   * Whether the LIST this row arrived in filled its {@link OPEN_PR_QUERY_LIMIT}-row window — i.e.
   * whether there are open pull requests this menu is NOT showing.
   *
   * A property of the PROBE, identical on every row, carried per-row for the same reason
   * `viewerCanMerge` is: it keeps the IPC reply a plain array. Losing it on an empty list costs
   * nothing, because a zero-row list cannot be truncated.
   *
   * `undefined` means the Rust side did not say (a partial fixture, or a build predating the
   * field), which is NOT `true` — see {@link prListSaturated}, which falls back to comparing the
   * count against the cap so an absent flag still cannot present a truncated list as complete.
   */
  listSaturated?: boolean;
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

/**
 * Ask GitHub to merge PR `number` with a MERGE COMMIT (the Rust `merge_pr` command). Rejects with
 * gh's own error text when the merge is declined (red required checks, a conflict, lost auth), which
 * the menu surfaces so the user sees exactly why.
 *
 * `knightwatchOverride` is a WRITTEN reason for merging a PR that still carries unanswered
 * knightwatch `[blocking]` review probes. Rust refuses that merge by default — see
 * `mergeGuard/knightwatch.ts` for why the gate lives there and not here — and a reason is what buys
 * past it. It is not a boolean and not a flag: Rust records the sentence ON THE PULL REQUEST and
 * validates that it costs one, so an override is always attributable to whoever wrote it.
 *
 * OMITTED, NOT `undefined`, when absent. The Rust parameter is an `Option<String>`, so either would
 * decode — but every existing caller and test asserts the exact payload `{ root, number }`, and a
 * key that materialises on every merge is a change to the wire for no gain. Passing a reason is the
 * exceptional path and it looks like one.
 *
 * `expectedHeadOid` is the head commit THIS merge decision was made against — the polled row's
 * `headRefOid`, i.e. the sha the checks-green/mergeable gate read. Rust turns it into
 * `gh pr merge --match-head-commit`, so a branch that moved since the poll is refused by GitHub
 * ("Head branch was modified") rather than merged at a head nobody evaluated. That window is not
 * theoretical: a commit pushed while a merge settles is absent from the default branch afterwards
 * and NOTHING looks wrong — the PR reads MERGED and the branch is there again, recreated by the
 * push. Same omit-when-absent rule, with one addition: an EMPTY string is dropped too, because
 * empty `headRefOid` means "cannot compare" everywhere else (see `services/prDismissals.ts`) and
 * `gh` would reject an empty flag value on every merge.
 */
export async function mergePr(
  root: string,
  number: number,
  knightwatchOverride?: string,
  expectedHeadOid?: string,
): Promise<void> {
  await invoke("merge_pr", {
    root,
    number,
    ...(knightwatchOverride === undefined ? {} : { knightwatchOverride }),
    ...(expectedHeadOid ? { expectedHeadOid } : {}),
  });
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

/**
 * What a knightwatch probe read said about one PR, reduced to the three facts a merge gate needs.
 *
 * Mirrors the Rust `ProbeGate` (`knightwatch.rs`), which is the authority — this is deliberately a
 * PROJECTION of it, not a second model. The full reading carries each probe's text, specialist and
 * comment URL; a readiness rule needs none of that, and pulling it in here would put kilobytes of
 * review prose behind a function that runs on every render.
 *
 * THE FIELD THAT MATTERS IS `unansweredBlocking`, AND `null` IS NOT ZERO. `null` means the read did
 * not answer — `gh` absent, unauthed, offline, timed out, or the comment window saturated at 100
 * (`knightwatch.rs` treats exactly-100 as unknown, because a truncated window is not an empty one).
 * A consumer that collapses `null` into 0 is claiming a PR is probe-clean on the strength of a read
 * that failed, which is the single failure mode this whole module is written against.
 */
export interface PrProbeState {
  /**
   * How many `[blocking]` probes on this PR are still unanswered, or `null` for "could not find
   * out". `0` is a real and different answer: asked, and there are none.
   */
  unansweredBlocking: number | null;
  /**
   * Does the PR already carry a written override record NEWER than its newest knightwatch review?
   *
   * Honoured because ignoring it produces the worst possible refusal: a red row telling the reader
   * to go and do the thing they have already done. A new review re-arms the gate, which is what
   * stops one override silencing a PR forever.
   */
  overridden: boolean;
  /** Did this PR carry any knightwatch review at all? `false` means the gate does not apply here —
   *  the state every non-Sparkle project is in — and is never a synonym for "clean". */
  applicable: boolean;
}

/** The subset of a PR this module judges. The newer fields are optional so a partial fixture (or a
 *  caller predating them) still typechecks — see `mergeStateStatus` for why absent ≠ "unknown". */
export type PrJudgeable = Pick<PrRow, "checks" | "mergeable"> &
  Partial<Pick<PrRow, "mergeStateStatus" | "failingChecks" | "pendingChecks" | "viewerCanMerge">> & {
    /** Absent = the probe read has not landed yet (or this caller does not do probe reads at all).
     *  Treated exactly like an unknown read: it withholds nothing and manufactures nothing. */
    probes?: PrProbeState;
  };

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
/**
 * WHICH fact this PR's row is reporting — the single most-blocking one, after the ranking in
 * {@link prMergeReadiness} has run.
 *
 * Exists so a caller that needs "is this one blocked ON PROBES specifically" asks the RULE instead
 * of writing a second rule. The header's blocked count did exactly that and drifted immediately: it
 * counted any PR carrying unanswered probes, including ones whose row said "Conflicts" because
 * conflicts outrank probes — so the header sent the reader to answer a probe on a PR whose visible
 * blocker was something else entirely. One ranking, one answer.
 */
export type PrBlocker =
  | "merge-rights"
  | "conflicts"
  | "probes"
  | "checks"
  | "protection"
  | "draft"
  | "mergeability"
  | "behind"
  | null;

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
  /** The one fact this row reports. Null exactly when green. See {@link PrBlocker}. */
  blocker: PrBlocker;
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

  // ── NO MERGE RIGHTS — FIRST, BECAUSE NOTHING BELOW CAN RESCUE IT (bead sparkle-j881r) ────────
  //
  // Every other branch describes something that could CHANGE: checks finish, a conflict is
  // resolved, GitHub settles a mergeability it had not computed. This one cannot. If the identity
  // has no write access to the repo, no state of the checks makes `gh pr merge` succeed — it comes
  // back `GraphQL: <user> does not have the correct permissions to execute MergePullRequest`, every
  // time, forever. So it is the most-blocking fact on the list and it is checked first: reporting
  // "checks running" on a PR the user could never merge sends them to wait for a button that will
  // still not work when the wait ends.
  //
  // AND THERE IS NO OVERRIDE. An override's whole justification on this surface is "GitHub would
  // accept this merge" (see `githubWouldAccept`), which is precisely the claim that is false here.
  // An override would be two deliberate clicks ending in the same 403.
  //
  // ONLY AN EXPLICIT `false` BLOCKS. `undefined`/`null` means the probe could not tell us — `gh`
  // absent, unauthed, offline, timed out — and must behave exactly as this gate did before the
  // field existed. Blocking on unknown would let one slow `gh repo view` disable every Merge button
  // in the app. That is the same rule the `mergeable: "unknown"` case follows, pointed the other
  // way: not knowing may withhold a confident YES, but it may never manufacture a confident NO.
  if (pr.viewerCanMerge === false)
    return {
      tone: "blocked",
      label: "No merge rights",
      blocker: "merge-rights",
      title:
        "You don't have permission to merge in this repository — someone with write access has to merge it, or you can dismiss it to stop it being offered here",
      canMerge: false,
      override: null,
    };

  if (pr.mergeable === "conflicting" || state === "dirty")
    return {
      tone: "blocked",
      label: "Conflicts",
      blocker: "conflicts",
      title: "Conflicts with the base branch — this cannot be merged until they are resolved",
      canMerge: false,
      override: null,
    };

  // ── UNANSWERED KNIGHTWATCH PROBES — ABOVE EVERY CHECK STATE (the founder's 2026-08-05 report) ──
  //
  // THE BUG THIS FIXES. This function judged `checks`/`mergeable`/`mergeStateStatus`/`viewerCanMerge`
  // and nothing else, so it could not see probes AT ALL. A probe-blocked PR with clean CI rendered
  // GREEN with a live one-click Merge, counted toward `prReadyCount`, and sat inside "Merge all
  // ready"'s scope; the ones in the founder's screenshot read amber "Checking mergeability" only
  // because GitHub had not settled their mergeability yet. Either way the row claimed something the
  // Rust gate would refuse — the app learned the truth ONLY by attempting the merge and catching
  // `merge_pr`'s refusal, into a ledger wiped on every Refresh.
  //
  // WHY IT OUTRANKS THE CHECK BRANCHES (the founder chose this ordering explicitly). Every check
  // state below describes something that RESOLVES ITSELF: checks finish, GitHub settles a
  // mergeability it had not computed. A probe block does not. When the checks finish this PR still
  // cannot merge, so "Checks running" — amber, NOT-YET — is a promise the row cannot keep. Same
  // reasoning as the `viewerCanMerge` branch above: most-blocking first means most-DURABLE first.
  // Nothing is hidden by the reordering; the other outstanding facts are named in the tooltip.
  //
  // WHY IT SITS BELOW CONFLICTS AND MERGE RIGHTS. Those cannot be answered or overridden away.
  // Naming the probe on a conflicting PR would send the reader to answer a question that still
  // leaves them unable to merge, with the real reason no longer on screen.
  //
  // AND NO `override` AFFORDANCE. The generic one means "GitHub would accept this merge", which is
  // both true and beside the point here — Rust refuses it regardless, and the only way past is a
  // WRITTEN reason recorded on the PR. That is its own deliberate two-step in the menu; offering
  // the one-click "Merge anyway" beside it would be the cheaper path, and the gate would be worth
  // nothing.
  const probes = pr.probes;
  const unansweredProbes = probes?.unansweredBlocking ?? null;
  // `null`/absent is UNKNOWN and must fall straight through. Not knowing may withhold a confident
  // YES, but it may never manufacture a confident NO — the same rule `viewerCanMerge` follows, and
  // it matters practically: one slow or unauthed `gh` would otherwise redden every row in the panel
  // and disable every Merge button. Nothing is risked by falling through, because Rust's `merge_pr`
  // gate is the real backstop and cannot be routed around from here.
  if (probes && unansweredProbes !== null && unansweredProbes > 0 && !probes.overridden) {
    const label = `Blocked: ${unansweredProbes} ${plural(unansweredProbes, "probe", "probes")}`;
    // The tooltip carries what the LABEL had to give up to stay one short phrase. A probe-blocked
    // PR with red CI is still a PR with red CI, and the reader must not have to click Merge to
    // rediscover that.
    const also: string[] = [];
    if (anyFailing)
      also.push(
        failing.length > 0
          ? `${failing.length} ${plural(failing.length, "check is", "checks are")} also failing (${nameList(failing)})`
          : "checks are also failing",
      );
    if (anyPending)
      also.push(
        pending.length > 0
          ? `${pending.length} ${plural(pending.length, "check is", "checks are")} also still running (${nameList(pending)})`
          : "checks are also still running",
      );
    if (state === "behind") also.push("the branch is also behind its base");
    if (state === "draft") also.push("it is also still a draft");
    return {
      tone: "blocked",
      label,
      blocker: "probes",
      title:
        `${unansweredProbes} unanswered [blocking] knightwatch ${plural(unansweredProbes, "probe", "probes")} — ` +
        `reply on the PR citing the probe by its durable id, or merge with a written override reason` +
        (also.length > 0 ? `. ${also.join("; ")}` : ""),
      canMerge: false,
      override: null,
    };
  }

  if (anyFailing) {
    const n = failing.length;
    const label = n > 0 ? `${n} ${plural(n, "check", "checks")} failing` : "Checks failing";
    return {
      tone: "blocked",
      label,
      blocker: "checks",
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
      blocker: "checks",
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
      blocker: "checks",
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
      blocker: "protection",
      title: "Branch protection is blocking this merge (a required review or check is missing)",
      canMerge: false,
      override: null,
    };

  if (state === "draft")
    return {
      tone: "blocked",
      label: "Draft",
      blocker: "draft",
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
      blocker: "mergeability",
      title: "GitHub has not finished working out whether this can merge — wait for it to settle",
      canMerge: false,
      override: null,
    };

  if (state === "behind")
    return {
      tone: "waiting",
      label: "Behind base",
      blocker: "behind",
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
    blocker: null,
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
 * A listed PR plus the probe reading the panel fetched for it SEPARATELY.
 *
 * `PrRow` mirrors the Rust `PrRow` field for field and must keep doing so — `project_open_prs` does
 * not return probe data and should not start, because probes cost a `gh` subprocess per PR and the
 * PR list is on the panel's critical path. So the reading is a decoration applied client-side after
 * `fetchProbeGates` lands, and this type is the honest name for the result.
 */
export type JudgedPrRow = PrRow & { probes?: PrProbeState };

/**
 * How many of `prs` report `blocker` as the ONE fact their row states.
 *
 * DELIBERATELY NOT "not ready minus ready", and never a second predicate of its own. Every PR that
 * is not green is blocked on SOMETHING, and the whole point of {@link PrBlocker} is that the ranking
 * picks exactly one. Counting "PRs that have a conflict" by re-testing `mergeable` would put a PR
 * whose visible row reads "No merge rights" into a conflict tally, and send the reader to rebase a
 * branch whose actual problem is an access token.
 *
 * WHY THE CALLERS NEED THIS SPLIT AT ALL (the founder's 2026-08-09 report). His summary said four
 * PRs needed merging; three were red because CI had failed and one because it conflicts. Those are
 * two different asks — the first three needed a re-run he had already triggered, the fourth needs a
 * human to decide how to rebase — and one undifferentiated "4" told him neither.
 */
export function prBlockerCount(
  prs: readonly PrJudgeable[],
  blocker: Exclude<PrBlocker, null>,
): number {
  return prs.filter((p) => prMergeReadiness(p).blocker === blocker).length;
}

/**
 * How many of `prs` are blocked on unanswered knightwatch probes — the "8 blocked" in the header.
 *
 * Kept as its own name because the header's sentence is about probes specifically; it delegates so
 * there is one implementation of "count the rows whose stated blocker is X".
 */
export function prProbeBlockedCount(prs: readonly PrJudgeable[]): number {
  return prBlockerCount(prs, "probes");
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
export function formatPrBadge(
  count: number | null,
  saturated = false,
): string | null {
  if (count === null || count <= 0) return null;
  // A TRUNCATED COUNT IS A FLOOR, AND MUST READ AS ONE. `gh pr list --limit N` gives no truncation
  // signal, so a full window means "at least this many" — and rendering a bare "100" against 400
  // waiting PRs is the same false reassurance the null-vs-zero rule guards against, one step
  // further out, on a number that counts work the founder OWES (bead sparkle-qogah).
  //
  // Two ways to know: the flag the Rust probe now stamps on every row (authoritative, and correct
  // at any cap), and the count-vs-cap comparison (a BACKSTOP for a reply that carries no flag —
  // a partial fixture, or a build predating the field). Either is enough to hedge.
  if (saturated || count >= OPEN_PR_QUERY_LIMIT) return `${count}+ PRs waiting`;
  return count === 1 ? "1 PR waiting" : `${count} PRs waiting`;
}

/**
 * Does this list of rows come from a probe that FILLED its window — i.e. are there open pull
 * requests missing from it?
 *
 * Reads the flag Rust stamps on every row, and falls back to the row count against the cap when no
 * row carries one. The fallback is the load-bearing half of the "absent is not false" rule: an
 * `undefined` flag on a list that is exactly cap-length must not be read as "complete", or an older
 * reply silently reinstates the very truncation this discloses.
 *
 * Takes `readonly PrRow[] | null` because that is what callers hold: `null` is "we could not ask",
 * which is unknown-not-saturated — there is no list to have truncated.
 */
export function prListSaturated(rows: readonly PrRow[] | null): boolean {
  if (!rows || rows.length === 0) return false;
  return (
    rows.some((r) => r.listSaturated === true) ||
    rows.length >= OPEN_PR_QUERY_LIMIT
  );
}

/** Row cap on the `gh pr list` query, mirrored from the Rust probe's `OPEN_PR_LIST_LIMIT`. A count
 *  that reaches this is saturated, not exact — see `formatPrBadge`.
 *
 *  The mirror is PINNED from the Rust side by `the_js_side_mirrors_the_same_open_pr_row_cap`, which
 *  reads this file. It used to be "kept in sync deliberately", i.e. by a comment — and a comment
 *  cannot fail, so a stale copy here would silently understate the badge. The saturation FLAG on
 *  each row is the authoritative channel now; this constant is the backstop for a reply that has
 *  none. */
export const OPEN_PR_QUERY_LIMIT = 300;

/** How often to re-probe. This shells out to `gh` over the network, so it is deliberately far
 *  slower than the 30s sidebar poll — an unmerged PR is a slow-moving fact, and a chatty probe
 *  would spend rate limit for no added signal. */
export const OPEN_PR_POLL_MS = 180_000;
