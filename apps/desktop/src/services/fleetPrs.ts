// THE PR MENU'S SCOPE MODEL — many repos at once, grouped by project tab.
//
// `services/openPrs.ts` answers "what is open in ONE repo, and is it safe to merge". This file is
// the layer above it: "which repos are we asking, how do their answers group, and what does the
// fleet total come to". Pure — no React, no Tauri — so the arithmetic behind the header count and
// the grouping is unit-tested without mounting anything or stubbing IPC.
//
// WHY IT EXISTS AT ALL (bead sparkle-lcx8y). The menu used to be bound to a single project, chosen
// by a precedence rule in `ConciergeHost`, and the chip rendered only when that rule produced one.
// The founder's concierge was scoped to a project with no PRs while every one of his PRs lived in
// another, so the chip resolved to a repo with nothing in it — and, one step worse, the whole
// control UNMOUNTED when no project resolved at all. Ten open PRs, six of them mergeable, and the
// only affordance that would have shown them was not on screen. A control that silently disappears
// does not read as "nothing to do here"; it reads as "this feature was removed".
//
// So scope is no longer a choice between projects. It is EVERY open project tab, and the answer is
// grouped by the tab's own name.
import { pathKey } from "../engine/projectIdentity";
import {
  prBlockerCount,
  prMergeReadiness,
  prProbeBlockedCount,
  prReadyCount,
  type JudgedPrRow,
} from "./openPrs";

/**
 * One repo the menu is asking about — an open project tab, flattened to the things the menu needs.
 * `projectName` is in here because it is RENDERED (it is the group's section header, which is the
 * founder's literal ask: "listed by project tab name"), not merely to identify the row.
 *
 * `rootPath` is nullable because a project record can carry an empty one; such a scope is listed
 * (the tab exists) but is never probed and never merged into.
 *
 * `repoKey` is the canonical `.git` common dir (`services/repoKey`, Rust `project_repo_key`) — the
 * value that says WHICH REPOSITORY this folder belongs to. It is what makes two tabs over one repo
 * fold into one section; see {@link repoIdentityOf}. Absent until the resolver has answered, and
 * never invented.
 */
export interface PrScope {
  projectId: string;
  projectName: string;
  rootPath: string | null;
  repoKey?: string | null;
}

/**
 * WHICH REPOSITORY a scope belongs to — the value two project tabs are folded ON.
 *
 * THE BUG THIS EXISTS FOR (the founder's 2026-08-06 report). The panel read "47 open pull requests
 * across 6 projects" and listed SPARKLE with 23 PRs and SPARKLE-DESKTOP with the SAME 23 — same
 * numbers, same titles, same branches. `/Users/…/Projects/sparkle-desktop` is a linked git WORKTREE
 * of `/Users/…/Projects/sparkle`: two folders, two project records, ONE repository and therefore one
 * set of pull requests. Every count here was taken per PROJECT ENTRY, so one repo registered twice
 * was counted twice — the total, the "across N projects", and the list itself.
 *
 * DELIBERATELY NOT A PATH TEST, and specifically not `[ -d "$path/.git" ]`'s shape: a linked
 * worktree's `.git` is a FILE, not a directory, so anything keyed on the path or on `.git` being a
 * directory reports these two as unrelated. `repoKey` is `git rev-parse --git-common-dir`, which
 * resolves to the SAME `<main>/.git` from either checkout and is the one signal that collapses them.
 *
 * The same rule as `engine/projectIdentity.identityKey`, and the prefix is load-bearing for the same
 * reason: a `.git` common dir is itself a real absolute path, so without a kind prefix a project
 * whose ROOT happened to be another's `.git` dir would read as the same repository.
 *
 * FALLS BACK TO THE PATH, then to the PROJECT ID. A repo key is resolved by a git subprocess, so it
 * is absent for a folder that is not a repo, for a record predating the field, and for the window
 * between hydrate and the first sweep. Falling back keeps this TOTAL and MONOTONIC: with no keys it
 * degrades to exactly the per-tab behaviour the panel had before, and every key that arrives can
 * only ever merge two sections, never split one. The project-id tier is the floor — a scope with no
 * root path has no repository at all and must never be folded into another one on the strength of
 * two empty strings.
 */
export function repoIdentityOf(scope: PrScope): string {
  const repo = scope.repoKey?.trim();
  if (repo) return `repo:${pathKey(repo)}`;
  const root = scope.rootPath?.trim();
  if (root) return `path:${pathKey(root)}`;
  return `project:${scope.projectId}`;
}

/**
 * The repo identities of `scopes`, joined — a dependency that changes exactly when the FOLDING
 * would.
 *
 * SEPARATE FROM {@link scopeSetKey}, which the poll effect keys on, and that separation is the
 * point. A repo key arrives asynchronously (the backfill sweep resolves it a beat after hydrate),
 * so the grouping has to recompute when it lands — but folding two sections into one is a rendering
 * change, not a reason to re-probe GitHub for every open repo. Putting this in `scopeSetKey` would
 * restart the 3-minute poll and spend a `gh` round trip per repo for a fact that changes nothing
 * about what to ask.
 */
export function scopeIdentitySetKey(scopes: readonly PrScope[]): string {
  return scopes.map(repoIdentityOf).join("\u0001");
}

/**
 * The identity of the repo a render — or an in-flight probe or merge — belongs to.
 *
 * ONE function rather than a template literal written at each site, which is not fastidiousness:
 * the two sites disagreed about their separator for one revision (a literal NUL against a space),
 * every async result compared unequal to the panel showing it, and the menu rendered NOTHING at
 * all. A guard that can silently be wrong about "is this the same repo" has to have exactly one
 * definition. The separator is a character no path or id contains, so distinct pairs cannot collide.
 *
 * It carries the PROJECT ID as well as the path on purpose: two project tabs may point at the same
 * checkout, and they are still two rows the user opened and two groups they expect to see.
 */
export function scopeKeyOf(rootPath: string | null, projectId: string): string {
  return `${rootPath ?? ""}\u0000${projectId}`;
}

/** The key for `scope`. */
export function keyOfScope(scope: PrScope): string {
  return scopeKeyOf(scope.rootPath, scope.projectId);
}

/**
 * Many scope keys joined into ONE value that changes exactly when the scope SET does — the
 * dependency the menu keys its polling and its grouping on, so a caller that rebuilds its `scopes`
 * array on every render cannot restart a 3-minute poll or re-probe GitHub.
 *
 * A DIFFERENT separator from `scopeKeyOf`'s, so the boundary between two keys can never be read as
 * the boundary between a path and a project id.
 */
export function scopeSetKey(scopes: readonly PrScope[]): string {
  return scopes.map(keyOfScope).join("\u0001");
}

/**
 * A per-PR key for the merge/arm ledgers.
 *
 * KEYED BY REPO + NUMBER, NEVER BY NUMBER. **PR numbers collide across repositories** — this is the
 * single most dangerous fact on this surface. Every repo numbers its pull requests from 1, so a
 * fleet-wide list routinely holds two different PRs both called `#12`. A ledger keyed on the number
 * alone would let an in-flight merge of one repo's `#12` grey out the other's, and — far worse —
 * would make "which PR did the user arm" ambiguous at exactly the moment the answer authorises an
 * irreversible merge.
 */
export function prKeyOf(scopeKey: string, number: number): string {
  return `${scopeKey}#${number}`;
}

/**
 * One project tab's section in the menu: its scope, the PRs in it, and whether we actually know.
 *
 * `known` is NOT `prs.length > 0`. `fetchOpenPrs` collapses every failure into `null`, so "GitHub
 * says there are no open PRs" and "we could not ask GitHub" both arrive as an empty result — and
 * they are different claims. Only `known` lets the panel say "No open pull requests" (a fact) as
 * opposed to staying quiet (an absence of one). Conflating them is how a badge confidently reports
 * zero on a machine that merely failed to look.
 */
export interface PrGroup {
  /**
   * The section's PRIMARY scope — the FIRST open tab of this repository in tab order.
   *
   * "First in tab order" is the founder's choice and it costs no new state: sections already read
   * top-to-bottom in the order the tabs read left-to-right, so the primary is simply the one that
   * would have come first anyway. Everything scoped to a section — its ledger key, the root a merge
   * runs from, where a dismissal is written — comes from this one scope, so the section has exactly
   * one identity rather than a set of them.
   */
  scope: PrScope;
  /**
   * EVERY open tab folded into this section, primary first — including the primary itself, so this
   * is never empty and `members[0] === scope`.
   *
   * Carried rather than discarded because THE OTHER TABS ARE REAL. Agents live in a project entry,
   * not in a repository: the founder has agents working in `sparkle` and agents working in
   * `sparkle-desktop`, and they are distinct even though the repo is one. This is what lets the
   * section name both checkouts instead of making one of them silently vanish, and it is what the
   * row merge reads to keep every entry's ownership answer.
   */
  members: PrScope[];
  /**
   * The names of the OTHER tabs on this repository — `members` after the primary, deduplicated.
   * Empty for the ordinary one-tab-one-repo case, which is what keeps the heading unchanged there.
   *
   * RENDERED, not merely recorded. The founder's instruction was explicit: a duplicate may not
   * disappear in a way that hides which local checkout an agent is working in. So the heading says
   * `SPARKLE · also open as sparkle-desktop` — the fold is stated on screen, in the one place
   * someone looking for the missing section would look.
   */
  alsoOpenAs: string[];
  key: string;
  /** The rows the menu LISTS — everything open in this scope MINUS anything dismissed. Carries the
   *  probe reading when one has landed; see {@link JudgedPrRow}. */
  prs: JudgedPrRow[];
  /**
   * The rows the user has dismissed, in the same order the probe returned them.
   *
   * SEPARATED HERE rather than filtered out at the component, because `readyCount` and every fleet
   * total are computed from `prs` — so doing the split in one place is what makes "a dismissed PR
   * leaves the list AND stops counting toward the chiclet" one fact instead of three that have to
   * be kept in agreement. They are still carried (not dropped) so the panel's Dismissed section can
   * render what was dismissed and offer it back: a silently disappeared pull request is the one
   * failure worse than the un-pressable Merge button this feature exists to remove.
   */
  dismissed: JudgedPrRow[];
  /** A probe for this scope has succeeded at least once, so `prs` is an answer rather than a gap. */
  known: boolean;
  /** This scope's most recent probe FAILED. Says nothing about whether we have an older list —
   *  combine with `known` to get the two cases below, which need different things said about them. */
  failed: boolean;
  /** Failed, but we have an older list: what is shown may be out of date. */
  stale: boolean;
  /** Failed with NOTHING behind it: this project contributes no rows and no count, and the reader
   *  has to be told so. Collapsing this into "zero" is the confident-zero-from-a-machine-that-
   *  failed-to-look failure the whole null-vs-zero contract exists to prevent. */
  unreadable: boolean;
  /** How many of `prs` are green — the same rule the per-row Merge button follows. */
  readyCount: number;
  /**
   * How many of `prs` are blocked on unanswered knightwatch probes — the "8 blocked" the header
   * shows beside the ready count.
   *
   * A SEPARATE FACT FROM `total - readyCount`. Most non-green PRs are waiting on CI, which resolves
   * itself and needs nothing from the reader; a probe-blocked one needs them to go and answer a
   * question. Reporting them as one number is what let eleven PRs read as eleven ready ones.
   *
   * ZERO WHEN NO PROBE READ HAS LANDED, which is honest rather than optimistic: the reads arrive
   * after the list, and an unknown reading is never counted as blocked (see `prProbeBlockedCount`).
   */
  blockedCount: number;
  /**
   * How many of `prs` are red because they CONFLICT with the base branch.
   *
   * SEPARATE FROM {@link checkBlockedCount} because the two need different things from the reader,
   * and that difference is the founder's 2026-08-09 ask. A conflict needs a HUMAN to decide how to
   * rebase; a failing check needs a re-run, and often nothing at all. Reported as one red count they
   * are indistinguishable, so a reader with three of one and one of the other cannot tell whether
   * the list is waiting on them or on CI.
   */
  conflictCount: number;
  /** How many of `prs` are held by their CHECKS — failing, still running, or a rollup GitHub calls
   *  unstable. Resolves itself, unlike {@link conflictCount}. */
  checkBlockedCount: number;
}

/**
 * Build the menu's sections, in the order the scopes were given.
 *
 * ORDER IS THE CALLER'S AND IS LOAD-BEARING: the caller passes open project tabs in tab-strip
 * order, so the sections read top-to-bottom in the same order the tabs read left-to-right. Sorting
 * here — by PR count, by name, by anything — would break the one mapping that makes a grouped list
 * scannable, which is that it matches the chrome the user already knows.
 *
 * A scope with no entry in `byKey` is `known: false` with an empty list, which is the honest
 * pre-probe state rather than a claim of zero.
 *
 * `dismissedByKey` maps a scope key to the PR numbers the user has dismissed there. Absent for a
 * scope means "none dismissed", which is also what a failed read of the dismissal store degrades
 * to — showing a row the user waved away is a far better failure than hiding one they did not.
 * The numbers are per-scope because PR numbers collide across repositories; see `prKeyOf`.
 *
 * ONE SECTION PER REPOSITORY, NOT PER TAB. Scopes that resolve to the same repository — two tabs on
 * one repo, which is what a linked git worktree is — are folded into a single group whose primary is
 * the first of them in tab order, with the others named in `alsoOpenAs`. See {@link repoIdentityOf}
 * for the fold and {@link mergeRepoRows} for what merging their rows preserves. Every count in this
 * file is taken from these groups, so the fold fixes the fleet total, the per-section count and the
 * "across N projects" in one move — they were three readings of the same miscount.
 */
/**
 * How much a `pr_owner` answer is WORTH — mirrored from Rust's `pr_owner::source_rank`.
 *
 * Needed because two tabs on one repository can BOTH answer "who owns #1433" and disagree, and the
 * disagreement is systematic rather than rare. The bottom tier, `branch-name`, is the legacy
 * `sparkle/agent-<id>` convention and is the ONE source that does not consult the project id at all
 * — so every member resolves it identically. Taking the first member's answer would therefore hand
 * a weak branch-name guess the win over the authoritative `created` record held by the OTHER tab,
 * on every PR opened from the second checkout. Rank, then order.
 *
 * An unrecognised source ranks 0 — above nothing but a missing owner. A Rust build that adds a fifth
 * source must not have it silently outrank `created` here.
 */
const OWNER_SOURCE_RANK: Readonly<Record<string, number>> = {
  created: 4,
  "pr-body": 3,
  "worktree-branch": 2,
  "branch-name": 1,
};

/** The strength of one row's ownership answer. `0` means "no owner", which every real source beats;
 *  `agentId: null` is UNKNOWN and never outranks a resolved one. */
function ownerStrength(row: JudgedPrRow): number {
  if (!row.agentId) return 0;
  return OWNER_SOURCE_RANK[row.agentIdSource ?? ""] ?? 0.5;
}

/**
 * How much a knightwatch reading actually SAYS:
 * **absent < unknown < answered-clean < answered-blocking (by count)**.
 *
 * `PrProbeState.unansweredBlocking` is `null` for "could not find out" (no `gh`, unauthed, offline,
 * timed out, or a saturated comment window), which is a DIFFERENT answer from `0`. A merge of two
 * readings that only asks "is one defined" therefore lets a present-but-unknown reading beat a
 * present-and-answered one — see {@link mergeRepoRows}, where that was the first defect.
 *
 * THE TOP TWO TIERS ARE SEPARATE FOR THE SAME REASON, ONE DOOR OVER (roborev 59927). Collapsing
 * every answered reading into one rank makes two answered members TIE, and a tie resolves by
 * position — so the primary's `{unansweredBlocking: 0}` suppressed the other tab's
 * `{unansweredBlocking: 2}` and the row went green with a live one-click Merge that Rust's
 * `merge_pr` refuses. That divergence is not hypothetical: probe reads are fired per scope and
 * un-awaited, and `fetchProbeGates` caches by `updatedAt` — whose known hole (a probe answered by
 * EDITING an existing reply never bumps the PR's stamp) is precisely a mechanism for one member to
 * hold a stale-but-answered count while the other holds the fresh one.
 *
 * So the tie breaks toward the BLOCKING reading, and within blocking toward the larger count, which
 * takes position out of the answer entirely. That is this module's stated safe direction: withholding
 * a green we are unsure of costs a Refresh, while suppressing a block the app already knows about
 * costs an irreversible-looking button that fails. `overridden` counts as not-blocking, because a
 * written override is exactly the thing that unblocks it.
 */
export function probeStrength(probes: JudgedPrRow["probes"]): number {
  if (!probes) return 0;
  const unanswered = probes.unansweredBlocking;
  if (unanswered === null) return 1;
  if (probes.overridden || unanswered <= 0) return 2;
  // 3 + count, so a blocking reading always outranks a clean one AND the larger block wins.
  return 3 + unanswered;
}

/**
 * The rows of one REPOSITORY, from every tab open on it, reduced to one row per pull request.
 *
 * The lists are the same list — same repo, same `gh pr list` — so this is a de-duplication, not a
 * union of different things. What differs between them is only what is resolved PER PROJECT ENTRY,
 * and those are the fields merged here:
 *
 * - **Owner** — taken from the strongest answer across the members (see {@link ownerStrength}), not
 *   from the first. This is the field the whole fold has to be careful with: an agent lives in a
 *   project entry, so only that entry's probe can name it.
 * - **Probes** — the knightwatch reading lands asynchronously and per scope, so one member can have
 *   it while another does not, and a member that HAS one may still have failed to find anything out.
 *   Merged by {@link probeStrength}, so a less informative reading never wins: re-hiding a block the
 *   app already knows about is the one direction that costs something, and it costs a green dot over
 *   a live Merge button on a PR the Rust gate will refuse.
 * - **Saturation** — ORed. A truncated read from either member means rows are missing from this
 *   section, and `prListSaturated` must still be able to say so.
 *
 * Everything else describes the pull request itself and is identical by construction; the first
 * member's row supplies it, which keeps the section's rows in the primary's order.
 */
function mergeRepoRows(perMember: readonly (JudgedPrRow[] | null)[]): JudgedPrRow[] {
  const order: number[] = [];
  const seen = new Map<number, JudgedPrRow>();
  for (const rows of perMember) {
    for (const row of rows ?? []) {
      const prev = seen.get(row.number);
      if (!prev) {
        order.push(row.number);
        seen.set(row.number, row);
        continue;
      }
      seen.set(row.number, {
        ...prev,
        ...(ownerStrength(row) > ownerStrength(prev)
          ? { agentId: row.agentId, agentIdSource: row.agentIdSource }
          : {}),
        // BY STRENGTH, NOT BY PRESENCE (roborev 59902, Medium). `probes !== undefined` was the test,
        // and a reading that came back UNKNOWN — `unansweredBlocking: null`, which is what an
        // unauthed or timed-out `gh` produces — is present. So the primary's failed read beat the
        // other tab's answered one, and a PR the app KNEW was blocked on unanswered probes rendered
        // green with a live one-click Merge. That is the exact failure `PrProbeState` spends its
        // doc-comment warning about, reached through the fold.
        ...(probeStrength(row.probes) > probeStrength(prev.probes)
          ? { probes: row.probes }
          : {}),
        ...(row.listSaturated ? { listSaturated: true } : {}),
      });
    }
  }
  return order.map((n) => seen.get(n)!);
}

export function buildPrGroups(
  scopes: readonly PrScope[],
  byKey: ReadonlyMap<string, JudgedPrRow[] | null>,
  failedKeys: ReadonlySet<string>,
  dismissedByKey: ReadonlyMap<string, ReadonlySet<number>> = new Map(),
): PrGroup[] {
  // ── FOLD THE TABS ONTO THEIR REPOSITORIES FIRST ──────────────────────────────────────────────
  //
  // Insertion order is preserved by `Map`, so the sections still come out in tab order and each
  // repository lands where its FIRST tab was — the primary rule, for free.
  const byRepo = new Map<string, PrScope[]>();
  for (const scope of scopes) {
    const id = repoIdentityOf(scope);
    const bucket = byRepo.get(id);
    if (bucket) bucket.push(scope);
    else byRepo.set(id, [scope]);
  }

  return [...byRepo.values()].map((members) => {
    const scope = members[0]!;
    const key = keyOfScope(scope);
    // EVERY MEMBER'S PROBE IS READ, not just the primary's — this is the half that keeps agent
    // attribution intact. `project_open_prs` resolves each PR's owning agent through a store keyed
    // BY PROJECT ID (Rust `pr_owner::resolve_owner`), so the entry an agent lives in is the only one
    // that can answer for its PRs. Probing only the primary would have made every PR opened from the
    // second checkout read as owner-unknown — a silent attribution regression traded for one saved
    // `gh` call. Instead the folding is purely a presentation and counting change: the same probes
    // run as before, and their answers are merged.
    const perMember = members.map((m) => byKey.get(keyOfScope(m)) ?? null);
    const known = perMember.some((r) => r !== null);
    const all = mergeRepoRows(perMember);
    // DISMISSAL IS A STATEMENT ABOUT A PULL REQUEST, so it is a UNION across the members. One repo
    // has one #1433; waving it away in one tab and having it come straight back under the other
    // would make the dismissal look broken, and the section it would come back in no longer exists.
    const hidden = new Set<number>();
    for (const m of members) for (const n of dismissedByKey.get(keyOfScope(m)) ?? []) hidden.add(n);
    // ONE PASS, TWO BUCKETS. `prs` is what the list shows and what every count is taken from;
    // `dismissed` is what the Dismissed section offers back.
    const prs = hidden.size > 0 ? all.filter((p) => !hidden.has(p.number)) : all;
    const dismissed = hidden.size > 0 ? all.filter((p) => hidden.has(p.number)) : [];
    // A scope with no `rootPath` is listed (the tab exists) but never probed, so it is neither
    // failed nor unreadable — there is nothing we tried and could not do.
    //
    // ANY member failing marks the section stale, because a section showing merged rows is only as
    // trustworthy as its worst read. But `unreadable` still needs `!known`: if one tab answered, the
    // section HAS a list, and calling it unreadable would hide rows we are holding.
    const failed = members.some((m) => failedKeys.has(keyOfScope(m)));
    return {
      scope,
      members,
      alsoOpenAs: [...new Set(members.slice(1).map((m) => m.projectName))],
      key,
      prs,
      dismissed,
      known,
      failed,
      stale: failed && known,
      unreadable: failed && !known,
      // THROUGH THE EXPORTED HELPER, not a re-implemented filter. The two would agree by
      // construction today — the readiness invariant is `canMerge` ⟺ `tone === "ready"` — but
      // `prReadyCount` owns that rule, and a caller that recomputes it inline is a second copy
      // nothing keeps in step (roborev 56050 made exactly this point about the header pill).
      readyCount: prReadyCount(prs),
      // Same discipline as `readyCount` directly above: through the exported helper, never a
      // re-implemented filter, so the header and the rows cannot disagree about what "blocked" is.
      blockedCount: prProbeBlockedCount(prs),
      // The two shapes of RED the founder asked to be able to tell apart — same helper, same one
      // ranking, so a row that says "Conflicts" is counted as a conflict and nothing else.
      conflictCount: prBlockerCount(prs, "conflicts"),
      checkBlockedCount: prBlockerCount(prs, "checks"),
    };
  });
}

/**
 * WHICH AGENTS HAVE A PULL REQUEST THAT IS MERGE-READY RIGHT NOW, keyed by the project whose tab
 * the reader is looking at.
 *
 * This is the join the concierge's "N need merge in <project>" line was missing, and its absence is
 * the whole of bead `sparkle-mf501`. That line counts AGENTS with committed work that has not
 * reached `main` — a git fact, computed with no reference to GitHub at all — so it could state "4
 * need merge" over four pull requests of which none could be merged. `prMergeReadiness` already knew
 * the truth; nothing carried it across to the sentence.
 *
 * TWO OUTPUTS, AND KEEPING THEM SEPARATE IS THE POINT:
 *
 *  • `knownProjectIds` — projects whose probe has ANSWERED. A readiness claim may only be made about
 *    these. Absent from the set means "we did not look", which must never render as "none are
 *    ready": that is the confident-zero-from-a-machine-that-failed-to-look failure the null-vs-zero
 *    contract in `services/openPrs` spends its doc-comment on, restated one surface further out.
 *    Every MEMBER of a folded group is listed, not just the primary — two tabs on one repository
 *    share its answer, and the agents in the second tab are as answered-for as the first's.
 *
 *  • `readyAgentIds` — the agents owning a green PR. Flat rather than per-project, because
 *    `resolveAgent` answers with the AGENT's own project, which need not be the project whose repo
 *    holds the PR (an agent in `sparkle-desktop` opens PRs in `sparkle`). Keying by the PR's repo
 *    would strand exactly those agents on the wrong side of the lookup.
 *
 * `resolveAgent` returning null — a PR whose owner was never recorded, or whose owner has left the
 * roster — contributes NOTHING. That is fail-closed in the safe direction: an unattributable green
 * PR makes the line say fewer are ready than really are, which understates work available. The
 * opposite error would be the bug this function exists to remove.
 */
export interface PrReadinessSnapshot {
  knownProjectIds: string[];
  readyAgentIds: string[];
}

export function prReadinessSnapshot(
  groups: readonly PrGroup[],
  resolveAgent: (pr: JudgedPrRow) => { agentId: string } | null,
): PrReadinessSnapshot {
  const known = new Set<string>();
  const ready = new Set<string>();
  for (const g of groups) {
    if (!g.known) continue;
    for (const m of g.members) known.add(m.projectId);
    for (const pr of g.prs) {
      // THE ONE RULE, ASKED — never `pr.mergeable === "mergeable"`, which is the exact trap this
      // change is about: it means "git would not conflict", not "safe to merge", and it reads
      // MERGEABLE beside a `mergeStateStatus: UNSTABLE` whose checks are red.
      if (prMergeReadiness(pr).tone !== "ready") continue;
      const link = resolveAgent(pr);
      if (link) ready.add(link.agentId);
    }
  }
  return { knownProjectIds: [...known], readyAgentIds: [...ready] };
}

/** The fleet-wide numbers behind the chiclet and the panel's header line. */
export interface FleetTotals {
  /** Open PRs across every scope. */
  total: number;
  /** Green PRs across every scope — what the chiclet's numeral counts. */
  ready: number;
  /**
   * Open PRs the user has DISMISSED, across every scope. Excluded from `total` and `ready` — that
   * is the whole point of a dismissal — but counted here so the panel can say how many it is not
   * showing.
   *
   * WITHOUT THIS, A FULLY-DISMISSED FLEET READS AS AN EMPTY ONE. `total === 0` would take the
   * headline to a flat "No open pull requests", which is false in exactly the way this file spends
   * three other fields preventing: it states a zero that is really a hidden non-zero, with nothing
   * on screen pointing at where the rows went.
   */
  dismissed: number;
  /** At least one scope has been probed successfully, so `total` is an answer and not a gap. */
  known: boolean;
  /** Scopes that actually have PRs — the sections the panel renders. */
  groupsWithPrs: number;
  /** Scopes whose probe failed with nothing behind it. A total of 0 alongside a non-zero count
   *  here is NOT "no open pull requests" — it is "none in the projects we could read". */
  unreadable: number;
  /**
   * Scopes we have asked and not yet heard from — probed, `rootPath` present, no answer either way.
   *
   * NEEDED BECAUSE THE FAILURE PATH IS THE FAST ONE. The probes fan out concurrently and each writes
   * its own key as it resolves; a repo with no remote or an unauthed `gh` returns `null` almost
   * immediately, while a healthy `gh pr list` takes seconds. So `!known && unreadable > 0` does NOT
   * mean "everything failed" — for a second or two it routinely means "the broken one answered
   * first". Saying "couldn't reach GitHub" then is an unsupportable claim over a repo that is about
   * to answer, which is the same defect as the flat zero, pointed the other way.
   *
   * A scope with no `rootPath` is never probed, so it is never pending — otherwise it would keep the
   * fleet permanently "checking" for a question we never asked.
   */
  pending: number;
  /**
   * REPOSITORIES we could ever ask about at all — groups whose primary has a `rootPath`.
   *
   * THIS IS THE "ACROSS 6 PROJECTS" THE FOUNDER READ, and it was inflated by exactly the same fault
   * as the total beside it: two tabs on one repository counted twice. It counts groups, and groups
   * are now per repository, so a repo open in two tabs contributes one — the same number the list
   * below it now has sections.
   *
   * "NOTHING TO ASK" AND "NOT ASKED YET" ARE DIFFERENT, and without this they were the same number.
   * A fleet whose only project has no root path settles at `known: false, pending: 0, unreadable: 0`
   * — `refetch` returns early on a null path, so nothing will ever move those counters — and every
   * surface then said "Checking GitHub…" forever, for a question that was never asked and never
   * will be. That is the same wrong-tense defect as announcing a failure early, at the other end.
   */
  askable: number;
  /** Open PRs that CONFLICT with their base, fleet-wide — the ones that need a human to rebase. */
  conflicting: number;
  /** Open PRs held by their CHECKS, fleet-wide — failing, running, or an unstable rollup. */
  checkBlocked: number;
}

/**
 * Sum the groups.
 *
 * `known` is ANY rather than EVERY, deliberately. With four project tabs open and one repo
 * unreachable, "we know 9 PRs are open and could not read the tenth repo" is a far more useful
 * thing to say than falling back to "unknown" for the whole fleet — and the unreadable scope is
 * separately called out by its own `stale` flag, so nothing is hidden by counting what we do know.
 */
export function fleetTotals(groups: readonly PrGroup[]): FleetTotals {
  let total = 0;
  let ready = 0;
  let dismissed = 0;
  let known = false;
  let groupsWithPrs = 0;
  let unreadable = 0;
  let pending = 0;
  let askable = 0;
  let conflicting = 0;
  let checkBlocked = 0;
  for (const g of groups) {
    total += g.prs.length;
    ready += g.readyCount;
    dismissed += g.dismissed.length;
    conflicting += g.conflictCount;
    checkBlocked += g.checkBlockedCount;
    if (g.known) known = true;
    if (g.prs.length > 0) groupsWithPrs += 1;
    if (g.unreadable) unreadable += 1;
    if (g.scope.rootPath) askable += 1;
    if (g.scope.rootPath && !g.known && !g.failed) pending += 1;
  }
  return {
    total,
    ready,
    dismissed,
    known,
    groupsWithPrs,
    unreadable,
    pending,
    askable,
    conflicting,
    checkBlocked,
  };
}

/**
 * WHAT THE FLEET HAS TO SAY, as one value — the panel headline and the badge tooltip both render
 * from this and nothing else.
 *
 * THIS EXISTS BECAUSE THE TWO SURFACES KEPT DISAGREEING. Three separate reviews found the same
 * shape of bug: a precondition was added to one of them and not the other, or to one BRANCH and not
 * its neighbour. The headline learned to refuse a flat zero and the badge did not; then both
 * learned to wait on `pending` in their `!known` branch while their `total === 0` branch — the
 * ordinary two-healthy-repos case, where a fast repo answers `[]` while a slow one is still
 * carrying six mergeable PRs — went on claiming zero regardless. Wording that must agree cannot
 * live in two switch statements.
 */
export type FleetState =
  /** No scope has a `rootPath`: there is nothing to ask, now or ever. */
  | "nothing-askable"
  /** At least one probe is still out, and we have nothing worth reporting yet. */
  | "checking"
  /** Everything askable was asked, and all of it failed. */
  | "unreachable"
  /** Every project answered, and none of them has an open pull request. */
  | "zero"
  /** What answered is empty, but at least one project could not be read — so zero is not the claim. */
  | "zero-partial"
  /** There are open pull requests to show. */
  | "counted";

export function fleetState(totals: FleetTotals): FleetState {
  if (totals.askable === 0) return "nothing-askable";
  if (!totals.known) {
    // Nothing has answered. Only once nothing is still outstanding is a failure the settled news.
    return totals.pending === 0 && totals.unreadable > 0 ? "unreachable" : "checking";
  }
  // A real count is worth showing even while more is on its way — it only grows.
  if (totals.total > 0) return "counted";
  // ZERO IS A CLAIM, and it may not be made while a project is still answering or was never read.
  if (totals.pending > 0) return "checking";
  return totals.unreadable > 0 ? "zero-partial" : "zero";
}

/** Kept as the narrow question some callers ask; `fleetState` is the whole answer. */
export function fleetUnreachable(totals: FleetTotals): boolean {
  return fleetState(totals) === "unreachable";
}

/**
 * The panel's header line — the one sentence that says what this list covers.
 *
 * It names how many projects were ASKED once there is more than one, because a total with no scope
 * is the ambiguity this whole change is about: "6 open pull requests" read against a single-project
 * menu for as long as the menu was single-project, and would keep reading that way now that it
 * isn't.
 *
 * Returns the honest unknown ("Checking GitHub…") only when NOTHING has come back yet — see
 * {@link FleetTotals.known} for why a partial answer is still an answer.
 */
export function fleetHeadline(totals: FleetTotals): string {
  // AGREEMENT COMES FROM `askable`, NEVER FROM THE TAB COUNT. This used to take `scopes.length`,
  // which counts projects the app cannot probe at all — so with a rootPath-less tab beside one
  // failing repo it said "Couldn't reach GitHub for any of these PROJECTS", which is false: one of
  // the two was never asked. `counted` had the same slip, spreading a fleet total "across 2
  // projects" when only one could ever contribute to it, which implies a zero for the other exactly
  // the way the flat zero this series exists to remove does. Taking the count from the same object
  // as the state is what stops a second source of truth reappearing (roborev 57739).
  const asked = totals.askable;
  switch (fleetState(totals)) {
    case "nothing-askable":
      return "No project with a GitHub remote";
    case "checking":
      return "Checking GitHub…";
    case "unreachable":
      return asked <= 1 ? "Couldn't reach GitHub" : "Couldn't reach GitHub for any of these projects";
    case "zero-partial":
      return "No open pull requests in the projects we could read";
    case "zero":
      // Deliberately unhedged. A scope with no `rootPath` has no repository to hold a pull request,
      // so excluding it from the zero is not a claim we are failing to make — unlike `unreadable`,
      // which is a repo that may well have PRs we simply could not read.
      //
      // DISMISSALS ARE THE ONE HEDGE IT DOES CARRY, because they are the only case where the zero
      // is a choice the user made rather than a fact about GitHub. A flat "No open pull requests"
      // over three dismissed rows is the same false claim the rest of this switch exists to avoid,
      // and it points at nothing — the Dismissed section below is exactly where those rows went.
      return totals.dismissed > 0
        ? `No open pull requests — ${totals.dismissed} dismissed`
        : "No open pull requests";
    case "counted": {
      const noun = totals.total === 1 ? "open pull request" : "open pull requests";
      const scoped =
        asked <= 1 ? `${totals.total} ${noun}` : `${totals.total} ${noun} across ${asked} projects`;
      return `${scoped} · ${readyClause(totals)}`;
    }
  }
}

/**
 * THE HALF OF THE HEADLINE THAT SAYS WHAT YOU CAN ACTUALLY DO — "2 ready to merge", or, when none
 * are, what is holding them.
 *
 * THE BUG THIS FIXES (bead `sparkle-mf501`, the founder's 2026-08-09 report). The panel said "4 open
 * pull requests" and not one of them could be merged: three were red on checks and the fourth
 * conflicts. Every one of those facts was already computed — `prMergeReadiness` had ranked all four,
 * the per-group "Merge all ready" correctly offered zero — and the one sentence at the top of the
 * panel reported none of it. An OPEN count and a READY count are two different predicates, and for
 * as long as they wore the same number the reader had to open four rows to learn what the header
 * could have told them in four words.
 *
 * IT NAMES THE BLOCKER ONLY WHEN THERE IS EXACTLY ONE KIND, and that restraint is deliberate. "none
 * ready — 4 waiting on checks" is actionable; "none ready — 3 waiting on checks, 1 conflicting, 2
 * blocked on probes" is a paragraph in a line that already ellipsizes, and the rows below say it
 * better. A mixed list gets the honest bare "none ready to merge" and the reader scans the rows.
 *
 * NEVER STATES A ZERO IT DID NOT EARN. This is only ever reached from the `counted` branch, i.e.
 * after a probe answered with at least one PR — the `!known` and `pending` states are handled above
 * and say "Checking GitHub…" instead, because "none ready" over a list we could not read is the same
 * confident-zero-from-a-machine-that-failed-to-look this file's whole state machine exists to refuse.
 */
function readyClause(totals: FleetTotals): string {
  if (totals.ready > 0) return `${totals.ready} ready to merge`;
  const blocked = totals.total;
  if (totals.conflicting === blocked)
    return blocked === 1 ? "none ready — it conflicts" : `none ready — all ${blocked} conflict`;
  if (totals.checkBlocked === blocked)
    return blocked === 1 ? "none ready — waiting on checks" : `none ready — all waiting on checks`;
  return "none ready to merge";
}

/**
 * The names of the projects whose latest probe failed — for the staleness notice.
 *
 * NAMED, not counted. The notice exists so the reader can tell which part of the list they should
 * not trust; "1 project could not be read" leaves them re-checking all of them.
 */
export function staleProjectNames(groups: readonly PrGroup[]): string[] {
  return groups.filter((g) => g.stale).map((g) => g.scope.projectName);
}

/**
 * The names of the projects we could not read AT ALL — failed with no earlier list behind them.
 *
 * SEPARATE FROM {@link staleProjectNames} because the two need different sentences. A stale scope
 * has rows on screen that may be out of date; an unreadable one has NO rows and no count, so its
 * absence from the list is not evidence of anything. Saying "may be out of date" about a project
 * showing nothing would be describing a list that isn't there.
 */
export function unreadableProjectNames(groups: readonly PrGroup[]): string[] {
  return groups.filter((g) => g.unreadable).map((g) => g.scope.projectName);
}
