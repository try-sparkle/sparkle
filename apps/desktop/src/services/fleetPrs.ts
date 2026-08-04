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
import { prReadyCount, type PrRow } from "./openPrs";

/**
 * One repo the menu is asking about — an open project tab, flattened to the three things the menu
 * needs. `projectName` is in here because it is RENDERED (it is the group's section header, which
 * is the founder's literal ask: "listed by project tab name"), not merely to identify the row.
 *
 * `rootPath` is nullable because a project record can carry an empty one; such a scope is listed
 * (the tab exists) but is never probed and never merged into.
 */
export interface PrScope {
  projectId: string;
  projectName: string;
  rootPath: string | null;
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
  scope: PrScope;
  key: string;
  /** The rows the menu LISTS — everything open in this scope MINUS anything dismissed. */
  prs: PrRow[];
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
  dismissed: PrRow[];
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
 */
export function buildPrGroups(
  scopes: readonly PrScope[],
  byKey: ReadonlyMap<string, PrRow[] | null>,
  failedKeys: ReadonlySet<string>,
  dismissedByKey: ReadonlyMap<string, ReadonlySet<number>> = new Map(),
): PrGroup[] {
  return scopes.map((scope) => {
    const key = keyOfScope(scope);
    const rows = byKey.get(key) ?? null;
    const all = rows ?? [];
    const hidden = dismissedByKey.get(key);
    // ONE PASS, TWO BUCKETS. `prs` is what the list shows and what every count is taken from;
    // `dismissed` is what the Dismissed section offers back.
    const prs = hidden && hidden.size > 0 ? all.filter((p) => !hidden.has(p.number)) : all;
    const dismissed = hidden && hidden.size > 0 ? all.filter((p) => hidden.has(p.number)) : [];
    const known = rows !== null;
    // A scope with no `rootPath` is listed (the tab exists) but never probed, so it is neither
    // failed nor unreadable — there is nothing we tried and could not do.
    const failed = failedKeys.has(key);
    return {
      scope,
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
    };
  });
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
   * Scopes we could ever ask about at all — those with a `rootPath`.
   *
   * "NOTHING TO ASK" AND "NOT ASKED YET" ARE DIFFERENT, and without this they were the same number.
   * A fleet whose only project has no root path settles at `known: false, pending: 0, unreadable: 0`
   * — `refetch` returns early on a null path, so nothing will ever move those counters — and every
   * surface then said "Checking GitHub…" forever, for a question that was never asked and never
   * will be. That is the same wrong-tense defect as announcing a failure early, at the other end.
   */
  askable: number;
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
  for (const g of groups) {
    total += g.prs.length;
    ready += g.readyCount;
    dismissed += g.dismissed.length;
    if (g.known) known = true;
    if (g.prs.length > 0) groupsWithPrs += 1;
    if (g.unreadable) unreadable += 1;
    if (g.scope.rootPath) askable += 1;
    if (g.scope.rootPath && !g.known && !g.failed) pending += 1;
  }
  return { total, ready, dismissed, known, groupsWithPrs, unreadable, pending, askable };
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
      return asked <= 1 ? `${totals.total} ${noun}` : `${totals.total} ${noun} across ${asked} projects`;
    }
  }
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
