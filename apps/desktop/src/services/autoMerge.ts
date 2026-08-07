/**
 * WHICH pull request — if any — should be merged automatically on this sweep tick.
 *
 * WHY THIS EXISTS (bead `sparkle-7o3an`). The founder asked twice why work sits on branches instead
 * of landing on main. It is not a gate: 16 of 22 open PRs measured `MERGEABLE` + `CLEAN` at the time
 * of writing, and the app ALREADY knew — it computes a ready-count pill and a per-project
 * "Merge N ready" button. What it does not do is act. The poll driving those numbers lives in
 * `OpenPrMenu` (a component), so it only runs while the panel is mounted, and the merge itself only
 * happens when a human clicks. Work therefore lands at exactly the rate someone is watching the
 * screen, and the queue grows every time nobody is.
 *
 * THIS MODULE IS PURE. It takes rows and state, and returns a decision. Every `gh` call, every
 * `invoke`, and the interval itself live in the runner; keeping the rules here is what lets the
 * serialisation guarantee below be asserted directly in a unit test rather than inferred from
 * timing.
 *
 * ── THE CRITERION IS `prMergeReadiness(...).tone === "ready"`, AND NOTHING ELSE ─────────────────
 *
 * Confirmed with the founder: a PR is auto-mergeable exactly when it is the GREEN one the panel
 * would already offer a one-click Merge for. That predicate is not re-derived here — it is imported
 * — because a second copy of the rules is a second thing to keep in step, and the app has already
 * been bitten by a status dot and a Merge button disagreeing (PR #779). Reusing it means auto-merge
 * inherits, for free and permanently:
 *
 *   * zero unanswered `[blocking]` knightwatch probes — the founder's stated bar,
 *   * no failing checks, and nothing still running,
 *   * no conflicts, not a draft, not behind, mergeability settled, and merge rights held.
 *
 * `[open]`-severity probes deliberately WARN rather than block (`knightwatch.rs:64-71`), and that
 * decision is inherited too rather than re-litigated here.
 *
 * NOTE ON "UNKNOWN" PROBE READINGS — INHERITED DELIBERATELY, AND PINNED BY A TEST.
 * `prMergeReadiness` treats a `null` probe count as UNKNOWN and falls through, on UI-grade
 * reasoning ("one slow or unauthed `gh` would redden every row"). That reasoning does NOT transfer
 * to an unattended merge on its own — but the fall-through is still safe here, for a reason that
 * was verified rather than assumed: Rust's `decide` (`knightwatch.rs:948-950`) states *"UNKNOWN is a
 * read FAILURE, and it blocks"*, and `merge_pr` runs `knightwatch::enforce` before it shells out.
 * So a PR whose probe read failed, was unauthed, or saturated the comment window is REFUSED at the
 * Rust gate; the worst case is a wasted attempt, which `failureCooldownMs` then absorbs.
 *
 * That decision is recorded here and pinned by `does not silently CHANGE on an unknown probe read`
 * rather than left to be re-derived — if the Rust gate ever stops blocking on UNKNOWN, that test is
 * where this assumption is written down.
 *
 * ── BUT "NO CHECKS AT ALL" IS **NOT** INHERITED — IT IS THE ONE UI RULE THIS MODULE OVERRIDES ────
 *
 * `prMergeReadiness` returns `tone: "ready"` for `checks: "none"` ("No checks on this PR, and GitHub
 * reports it clean"), and Rust's `classify_checks` maps an EMPTY rollup to `"none"`. Inheriting that
 * would auto-merge a PR whose CI never ran — the window between a push and checks registering, a
 * workflow that failed to trigger, an Actions outage that created no runs, or a CONFLICTING PR,
 * which never gets a `pull_request` event at all and so sits at `[]` forever.
 *
 * That is the identical fail-open `scripts/pr-checks.sh` closed one commit earlier, on reasoning
 * that applies here verbatim: **a value that colours a dot a human reads is not a criterion that
 * gates an automated merge.** So the unattended path additionally requires POSITIVE evidence of
 * green (`checks === "passing"`), gated by `requirePassingChecks` so a repo with genuinely no CI can
 * still opt in.
 *
 * ── ONE MERGE PER TICK, AND WHY IT IS NOT A NICETY ─────────────────────────────────────────────
 *
 * Every merge to `main` fires a full ~14-job CI run that is deliberately per-SHA and never cancelled
 * (`.github/workflows/ci.yml`). The repo is on GitHub Free, whose ceiling is ~20 CONCURRENT jobs, and
 * that queue was already measured 4.5 hours deep. Merging the whole ready set at once would inject
 * ~224 jobs into a 20-slot pool in one burst and convert a cosmetic backlog into a real outage — so
 * this returns AT MOST ONE pull request per call, forever. At the 180 s sweep cadence that still
 * drains a 16-PR backlog in under an hour, which is far faster than the founder clicking.
 */
import { prMergeReadiness, type PrJudgeable } from "./openPrs";

/** Merge the oldest ready PR first: lowest number = longest waiting. */
const byNumberAscending = (a: { number: number }, b: { number: number }): number => a.number - b.number;

/**
 * How long to leave a pull request alone after an attempt to merge it FAILED.
 *
 * Without this, a PR that `gh` refuses — a probe the Rust gate caught but the TS reading had not, a
 * branch that moved under `--match-head-commit`, a transient 502 — is retried on every tick forever,
 * which is one wasted `gh` subprocess every 180 s per bad PR and a log nobody can read. Ten minutes
 * is long enough that a genuine problem is not hammered and short enough that a transient one heals
 * without a restart.
 */
export const AUTO_MERGE_FAILURE_COOLDOWN_MS = 600_000;

export interface AutoMergeConfig {
  /** Off is a first-class answer: the decision reports `disabled` rather than silently never firing. */
  enabled: boolean;
  failureCooldownMs: number;
  /**
   * Require `checks === "passing"` — POSITIVE evidence of green — rather than accepting the
   * `checks: "none"` that `prMergeReadiness` also calls ready. See the header. Defaults TRUE; set it
   * false only for a repo that genuinely runs no CI, where "no checks" is the permanent steady state
   * rather than a window.
   */
  requirePassingChecks: boolean;
}

/**
 * Fill in the documented defaults. A field that is absent, non-finite or negative falls back rather
 * than propagating — a `NaN` cooldown compares false against every comparison, which would silently
 * DELETE the backoff instead of failing loudly, and this is the one place that can catch it.
 *
 * SHIPS OFF. Unlike the babysit sweep, this one MERGES TO `main` unattended, so the default may not
 * be "on unless told otherwise": turning it on has to be a decision someone made, not one they
 * failed to prevent.
 */
export function resolveAutoMergeConfig(config?: Partial<AutoMergeConfig>): AutoMergeConfig {
  const cooldown = config?.failureCooldownMs;
  return {
    enabled: config?.enabled === true,
    failureCooldownMs:
      typeof cooldown === "number" && Number.isFinite(cooldown) && cooldown >= 0
        ? cooldown
        : AUTO_MERGE_FAILURE_COOLDOWN_MS,
    // Only an explicit `false` relaxes it. An absent/garbled value must not be able to widen what
    // merges unattended — the safe direction is the default.
    requirePassingChecks: config?.requirePassingChecks !== false,
  };
}

/** Per-PR record of the last attempt that FAILED, keyed by PR number. Owned by the runner. */
export type AutoMergeFailures = Readonly<Record<number, number>>;

/** A PR the decision can act on: judgeable for readiness, plus the identity a merge needs. */
export type AutoMergeCandidate = PrJudgeable & {
  number: number;
  /** Pinned into `gh pr merge --match-head-commit`, so a branch that moved is refused, not merged. */
  headRefOid?: string;
};

/**
 * The outcome. A REASON is returned even when nothing is merged, because the failure mode this
 * feature is most likely to have is silence — "it has not merged anything for six hours" and
 * "nothing was ready for six hours" are indistinguishable from outside without this.
 */
export type AutoMergeDecision<T extends AutoMergeCandidate = AutoMergeCandidate> =
  | { kind: "disabled" }
  | { kind: "none-ready"; considered: number }
  | { kind: "all-cooling-down"; considered: number; readyCount: number }
  | { kind: "merge"; pr: T; readyCount: number; deferred: number };

/** What the runner knows beyond the PR rows themselves. An object, not positional arguments, so a
 *  future input cannot be bolted on in an order that silently re-reads an existing call site. */
export interface AutoMergeInputs {
  /** PR number → epoch ms of the last FAILED merge attempt. */
  failures?: AutoMergeFailures;
  /**
   * PRs whose dismissal is STILL IN FORCE.
   *
   * A CONTRACT, not a convenience, and taken here rather than left to the runner. Dismissal is the
   * app's durable "not now", and a dismissal taken while the PR was ALREADY green survives it
   * *staying* green — so a dismissed PR is exactly the shape this decision would otherwise select,
   * and auto-merging it would land the work the user hid to stop being offered.
   *
   * Stated that narrowly on purpose: it is NOT true that dismissals survive green in general.
   * `isRevived`'s third trigger is "green now, not green then" (`prDismissals.ts:100-106`:
   * `tone === "ready" && dismissal.tone !== "ready"`), so a red→green transition REVIVES the
   * dismissal. Getting that backwards is what would make a runner author think the partition below
   * is redundant — "green PRs stay dismissed either way" — and pass the raw stored list.
   *
   * DERIVE IT THE WAY THE PANEL DOES — the partition FIRST, then the numbers:
   *
   *     dismissedNumbers(partitionDismissals(stored, rows).active)
   *
   * `dismissedNumbers(stored)` is the WRONG input and it fails silently. It maps the raw stored list
   * straight to numbers and applies NO revival logic, so a PR the user dismissed while it was red —
   * precisely the case `isRevived` exists to clear once it goes green — would be excluded from
   * auto-merge PERMANENTLY, with no event that ever removes it. The direction is fail-safe, but the
   * symptom is the one this module's `AutoMergeDecision` reasons exist to prevent: it reports
   * `none-ready` forever, and "nothing is ready" is indistinguishable from "one PR was silently
   * retired". `OpenPrMenu.tsx` runs the partition before it calls `dismissedNumbers`; so must the
   * runner.
   *
   * Not partitioned in here because that needs a full `PrRow` (`isRevived` reads the head-OID
   * fingerprint), and `AutoMergeCandidate` is deliberately the narrow judgeable subset.
   */
  dismissed?: ReadonlySet<number>;
  /** Epoch ms, injected so the cooldown is testable without fake timers. */
  now?: number;
}

/**
 * Choose AT MOST ONE pull request to merge now.
 *
 * @param prs    every open PR in scope, already decorated with probe readings where available
 * @param config resolved config; `enabled: false` short-circuits before any work
 * @param inputs the runner's side data — failures, dismissals, clock
 */
export function chooseAutoMerge<T extends AutoMergeCandidate>(
  prs: readonly T[],
  config: AutoMergeConfig,
  inputs: AutoMergeInputs = {},
): AutoMergeDecision<T> {
  if (!config.enabled) return { kind: "disabled" };
  const { failures = {}, dismissed, now = Date.now() } = inputs;

  const ready = prs
    .filter((pr) => {
      // The imported single source of truth — see the header for why it is not re-derived.
      if (prMergeReadiness(pr).tone !== "ready") return false;
      // ...plus the two rules that are NOT safe to inherit from a UI predicate.
      if (config.requirePassingChecks && pr.checks !== "passing") return false;
      if (dismissed?.has(pr.number)) return false;
      return true;
    })
    .sort(byNumberAscending);
  if (ready.length === 0) return { kind: "none-ready", considered: prs.length };

  const eligible = ready.filter((pr) => {
    const failedAt = failures[pr.number];
    // A cooldown is only in force while it has not elapsed. An absent record is not a cooldown, and
    // neither is a non-finite one — a corrupt entry must not be able to retire a PR permanently.
    if (typeof failedAt !== "number" || !Number.isFinite(failedAt)) return true;
    return now - failedAt >= config.failureCooldownMs;
  });

  if (eligible.length === 0) {
    return { kind: "all-cooling-down", considered: prs.length, readyCount: ready.length };
  }

  // ONE. Never a batch — see the header for why this bound is load-bearing rather than cosmetic.
  return {
    kind: "merge",
    pr: eligible[0]!,
    readyCount: ready.length,
    deferred: eligible.length - 1,
  };
}
