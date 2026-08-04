// "NOT NOW" FOR A PULL REQUEST — and the rule that decides when "not now" has run out.
//
// `services/openPrs.ts` answers "is this PR safe to merge"; this file answers "should we still be
// showing it at all". The durable store is Rust's `pr_dismissal` (`<app_data>/pr-dismissals.json`);
// everything below is the IPC surface onto it plus the REVIVAL RULE, which is pure so the one part
// with a judgement in it is unit-tested without Tauri, a network, or a `gh` binary.
//
// ── WHY A DISMISSAL EXPIRES AT ALL (bead sparkle-j881r) ─────────────────────────────────────────
//
// The founder asked for a Dismiss beside Merge, because the fleet-wide chiclet surfaced pull
// requests in a repo he does not control and the app kept offering him a Merge that returns
// `GraphQL: <user> does not have the correct permissions to execute MergePullRequest`. But a
// dismissal that never comes back is the opposite failure, and the one he has been bitten by
// repeatedly: a mergeable pull request that is invisible, uncounted, and has nothing on screen to
// explain its absence. Hence two defences, and this file holds the second:
//
//   1. Every dismissal is LISTED BACK and restorable by hand — the panel's Dismissed section.
//   2. A dismissal REVIVES ITSELF the moment the reason for it stops being true.
//
// ── WHAT COUNTS AS "THE REASON WENT AWAY" ───────────────────────────────────────────────────────
//
// A dismissal stores a FINGERPRINT of the PR as it was when it was dismissed, and {@link isRevived}
// compares that to the live probe. Three triggers, each a different way of saying the pull request
// in front of you is no longer the one that was waved away:
//
//   • YOU GAINED MERGE RIGHTS. Dismissed while `viewerCanMerge` was false, and it is now true. This
//     is the founder's literal case running backwards — he is added to the repo, so the PR he could
//     do nothing about becomes one he can land.
//   • IT WAS PUSHED TO. The head commit changed. New commits mean a new proposition, whatever was
//     wrong with the old one.
//   • IT BECAME MERGEABLE. It was not green when dismissed and it is green now — checks went from
//     red or running to passing, a conflict was resolved, GitHub finished computing mergeability.
//
// A PR dismissed while ALREADY green and already un-mergeable-by-you (the exact tkmx-client case)
// therefore stays dismissed until you gain rights or someone pushes to it, which is right: nothing
// about it has changed, and re-offering it would resume the nagging the dismissal exists to stop.
//
// ── AND WHY UNKNOWN NEVER REVIVES ───────────────────────────────────────────────────────────────
//
// Every comparison here is written so that an ABSENT value is inert. An empty head SHA does not
// count as "changed" (an older Rust build supplies none, which would otherwise revive every
// dismissal on every poll — a dismissal that cannot survive a restart is not a dismissal), and a
// `null`/`undefined` `viewerCanMerge` does not count as "gained rights" (a failed `gh repo view`
// would otherwise un-dismiss the whole list). Reviving on a missing fact is how "not now" silently
// becomes "no".
import { invoke } from "@tauri-apps/api/core";
import { prMergeReadiness, type PrRow } from "./openPrs";
import { log } from "../logger";

/** One dismissed PR, mirroring the Rust `PrDismissal` (camelCase). */
export interface PrDismissal {
  number: number;
  /** The head commit at dismissal time; `""` when the probe supplied none — see the header. */
  headRefOid: string;
  /** The readiness tone at dismissal time: "ready" | "waiting" | "blocked". */
  tone: string;
  /** Whether the user could merge in this repo at dismissal time. */
  viewerCanMerge: boolean;
  /** Epoch SECONDS (Rust's unit), not milliseconds. */
  dismissedAt: number;
}

/** The fingerprint to record for `pr` — what {@link isRevived} will later be judged against. */
export function fingerprintOf(pr: PrRow): {
  headRefOid: string;
  tone: string;
  viewerCanMerge: boolean;
} {
  return {
    headRefOid: pr.headRefOid ?? "",
    tone: prMergeReadiness(pr).tone,
    // COERCED TO A BOOLEAN for storage, and `unknown` stores as `false` deliberately: the only
    // thing this field is ever read for is "did they GAIN rights", and recording an unknown as
    // `true` would make that transition unobservable for a PR dismissed during an outage.
    viewerCanMerge: pr.viewerCanMerge === true,
  };
}

/**
 * Has this dismissal run out — i.e. should `pr` come back to the ready list?
 *
 * Pure, and deliberately the ONLY place the three triggers are written down. See the module header
 * for each one and for why an absent value can never fire.
 */
export function isRevived(dismissal: PrDismissal, pr: PrRow): boolean {
  // 1. Rights gained. Requires an explicit `true` now against a recorded `false` — an unknown is
  //    not a grant, or a failed permission probe would un-dismiss everything.
  if (pr.viewerCanMerge === true && !dismissal.viewerCanMerge) return true;
  // 2. Pushed to. BOTH SHAs must be present: comparing against an empty one would make every
  //    dismissal revive on the next poll under a Rust build that does not supply `headRefOid`.
  const live = pr.headRefOid ?? "";
  if (live !== "" && dismissal.headRefOid !== "" && live !== dismissal.headRefOid) return true;
  // 3. Became mergeable — green now, not green then.
  //
  // JUDGED WITH MERGE RIGHTS RESOLVED, not with the raw row. `prMergeReadiness` blocks first on
  // `viewerCanMerge === false`, so a row whose permission probe merely FAILED (undefined/null)
  // falls through to "ready" on its checks alone — and a PR dismissed for having no merge rights
  // would then revive itself on every poll that could not reach `gh repo view`, which is a
  // dismissal that quietly cannot survive an outage. Falling back to the rights the dismissal
  // recorded keeps an unknown inert, exactly as it is in triggers 1 and 2: only trigger 1 may
  // conclude anything from merge rights, and only from an explicit `true`.
  const rights = pr.viewerCanMerge ?? dismissal.viewerCanMerge;
  return (
    prMergeReadiness({ ...pr, viewerCanMerge: rights }).tone === "ready" &&
    dismissal.tone !== "ready"
  );
}

/**
 * Split a project's dismissals against its live rows: which are still in force, and which have
 * revived and must be dropped from the store.
 *
 * A dismissal whose PR is ABSENT from `rows` is left in `active` untouched. That is not an
 * oversight: absent means either "closed or merged upstream" — which the Rust side prunes, from a
 * probe it knows to be complete — or "we could not read this repo just now", and reviving on the
 * second would make a failed `gh` call quietly undo the user's dismissals.
 */
export function partitionDismissals(
  dismissals: readonly PrDismissal[],
  rows: readonly PrRow[],
): { active: PrDismissal[]; revived: PrDismissal[] } {
  const byNumber = new Map(rows.map((r) => [r.number, r]));
  const active: PrDismissal[] = [];
  const revived: PrDismissal[] = [];
  for (const d of dismissals) {
    const pr = byNumber.get(d.number);
    (pr && isRevived(d, pr) ? revived : active).push(d);
  }
  return { active, revived };
}

/** The dismissed PR numbers, as the set the grouping layer filters on. */
export function dismissedNumbers(dismissals: readonly PrDismissal[]): ReadonlySet<number> {
  return new Set(dismissals.map((d) => d.number));
}

// ── IPC ─────────────────────────────────────────────────────────────────────────────────────────
//
// All three swallow their failures to a null/empty answer rather than throwing, for the same reason
// `fetchOpenPrs` does: this is ambient chrome polled every three minutes, and a store write that
// fails must not surface as a toast over whatever the user is actually doing. The cost of a
// swallowed failure here is bounded — a row stays visible, or reappears — which is the direction
// this feature is allowed to fail in.

/**
 * The dismissals recorded for `projectId`.
 *
 * `openNumbers` is what a SUCCESSFUL probe found open, and passing it lets Rust prune records for
 * PRs since merged or closed. Pass `undefined` after a FAILED probe — reading a failure as "nothing
 * is open" would erase every dismissal the user has made.
 */
export async function fetchDismissals(
  projectId: string,
  openNumbers?: readonly number[],
): Promise<PrDismissal[]> {
  try {
    const rows = await invoke<PrDismissal[] | null>("pr_dismissals", {
      projectId,
      openNumbers: openNumbers ? [...openNumbers] : null,
    });
    return Array.isArray(rows) ? rows : [];
  } catch (e) {
    log.warn("pr-dismissals", `could not read dismissals for ${projectId}`, e);
    return [];
  }
}

/** Dismiss `pr` in `projectId`, returning the project's whole dismissal set, or null on failure. */
export async function dismissPr(projectId: string, pr: PrRow): Promise<PrDismissal[] | null> {
  const fp = fingerprintOf(pr);
  try {
    const rows = await invoke<PrDismissal[] | null>("dismiss_pr", {
      projectId,
      number: pr.number,
      headRefOid: fp.headRefOid,
      tone: fp.tone,
      viewerCanMerge: fp.viewerCanMerge,
    });
    return Array.isArray(rows) ? rows : [];
  } catch (e) {
    log.warn("pr-dismissals", `could not dismiss #${pr.number} in ${projectId}`, e);
    return null;
  }
}

/** Un-dismiss `number` — the user's Restore, and the revival path. */
export async function restorePr(
  projectId: string,
  number: number,
): Promise<PrDismissal[] | null> {
  try {
    const rows = await invoke<PrDismissal[] | null>("restore_pr", { projectId, number });
    return Array.isArray(rows) ? rows : [];
  } catch (e) {
    log.warn("pr-dismissals", `could not restore #${number} in ${projectId}`, e);
    return null;
  }
}
