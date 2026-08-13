// conciergeLintMetrics — an in-memory, SESSION-SCOPED tally of what the concierge reply linter
// (services/conciergeLint/) caught this run: how many violations per check id, and what the app did
// about each one. It is the "this session" half of the feedback loop; the durable half is
// `<app_data>/concierge-lint.jsonl` (src-tauri/src/concierge_lint_log.rs), read by
// scripts/concierge-lint-report.mjs.
//
// WHY IT EXISTS. The complaint the linter answers is "there's a lot of variability, it feels like
// whack-a-mole" — an impression. Nothing can tell a linter that is WORKING from a concierge that has
// merely learned to phrase around it, unless drift is a NUMBER someone can look at. A check whose
// count goes to zero while the human's experience does not improve is a check to rewrite, and that
// is only visible from a count.
//
// PRIVACY: this store holds COUNTS ONLY, keyed by non-identifying enums (the linter's check id and
// the action taken). It NEVER stores reply text, the matched span, a hash of the span, agent names,
// prompts, file paths, or turn ids. It mirrors selfReportMetrics.ts deliberately, including that
// posture: NOT persisted, NEVER hits the network, and it resets to zero on every app launch — which
// is exactly what a "this session" readout wants. The on-disk log is metadata-only for the same
// reason (services/conciergeAudit.ts: persisting concierge text "would put redacted-but-still-
// sensitive prompts on disk without anyone asking for that").
import { create } from "zustand";

/**
 * The Tier-2 checks the deterministic linter runs (plan §3). The AUTHORITATIVE list lives in the
 * linter's own registry; this union exists so a counter typechecks and so the readout can enumerate
 * every check including the ones that fired zero times — a check at zero is a real reading, and a
 * record that only grows keys on demand cannot show it.
 */
export type LintCheckId =
  // The only check here that BLOCKS, and the one the human named four times in a session: reporting
  // accurately and then asking permission instead of acting. It was added to config.rs and to the
  // linter registry but NOT to this union, so the headline check had nowhere to be counted — a
  // silent zero that would have read as "it never fires". Pinned by a test against the registry now.
  | "ask-without-action"
  // The other half of that pair: the reply that took no action and said it DID. A receipt the human
  // cannot check retires the task in their head, so this one costs more than the passivity above.
  | "unbacked-claim"
  // The third member of that family: the reply that named a DEFECT and attached nothing to it — no
  // bead, no agent, no stated reason. Unlike the two above, its trigger is not a sentence about the
  // concierge at all; it is an assertion that something is broken.
  | "defect-without-disposition"
  // The founder's own presentation rule, made structural: a reply must OPEN by quoting the message
  // it answers. Unlike the three above it judges the reply's SHAPE rather than its claims, and it is
  // the first check whose evidence is a fact about the thread (which messages are outstanding)
  // rather than about the turn.
  | "reply-without-quote"
  | "bare-agent-name"
  | "bare-pr-number"
  | "fat-pill-label"
  | "unresolved-agent-pill"
  | "relay-paste"
  | "actions-first"
  | "unreported-refusal"
  | "hedge-words"
  | "restated-state"
  | "naked-file-ref";

/**
 * What the app DID about a violation — the same vocabulary the JSONL sink accepts
 * (`concierge_lint_log.rs::ACTIONS`), because the session counters and the all-time totals are shown
 * side by side and a second vocabulary would make them silently incomparable.
 *
 * `warned` rendered the reply unchanged with a badge; `autofixed` substituted the mechanically
 * derivable compliant form; `revised` re-prompted the concierge and rendered the correction;
 * `rendered_marked` is the give-up path after the one permitted retry.
 */
export type LintAction = "warned" | "autofixed" | "revised" | "rendered_marked";

/** Every check id, in the order a readout should list them. Exported so callers never hand-maintain
 *  a second copy of the union's members (TS cannot enumerate a union at runtime). */
export const LINT_CHECK_IDS: readonly LintCheckId[] = [
  "ask-without-action",
  "unbacked-claim",
  "defect-without-disposition",
  "reply-without-quote",
  "bare-agent-name",
  "bare-pr-number",
  "fat-pill-label",
  "unresolved-agent-pill",
  "relay-paste",
  "actions-first",
  "unreported-refusal",
  "hedge-words",
  "restated-state",
  "naked-file-ref",
] as const;

/** Every action, likewise. */
export const LINT_ACTIONS: readonly LintAction[] = [
  "warned",
  "autofixed",
  "revised",
  "rendered_marked",
] as const;

interface ConciergeLintMetricsState {
  /** check id → violations recorded this session. */
  checks: Record<LintCheckId, number>;
  /** action → violations recorded this session. Sums to the same total as `checks`. */
  actions: Record<LintAction, number>;
  /**
   * Tally one violation. `count` is how many times the check matched in that reply — the linter
   * reports a reply with three hedge words as one violation of count 3, and the counter has to agree
   * with the JSONL or the two readouts disagree. Non-finite / non-positive counts are ignored rather
   * than corrupting the tally.
   */
  recordViolation: (check: LintCheckId, action: LintAction, count?: number) => void;
  /** Zero everything (test hook + a possible future "reset session" affordance). */
  reset: () => void;
}

const emptyChecks = (): Record<LintCheckId, number> => ({
  "ask-without-action": 0,
  "unbacked-claim": 0,
  "defect-without-disposition": 0,
  "reply-without-quote": 0,
  "bare-agent-name": 0,
  "bare-pr-number": 0,
  "fat-pill-label": 0,
  "unresolved-agent-pill": 0,
  "relay-paste": 0,
  "actions-first": 0,
  "unreported-refusal": 0,
  "hedge-words": 0,
  "restated-state": 0,
  "naked-file-ref": 0,
});

const emptyActions = (): Record<LintAction, number> => ({
  warned: 0,
  autofixed: 0,
  revised: 0,
  rendered_marked: 0,
});

export const useConciergeLintMetrics = create<ConciergeLintMetricsState>((set) => ({
  checks: emptyChecks(),
  actions: emptyActions(),
  recordViolation: (check, action, count = 1) =>
    set((s) => {
      // A NaN or negative count would poison the total irrecoverably (and NaN is sticky — every
      // later increment stays NaN), so the counter refuses it instead of trusting the caller.
      const n = Number.isFinite(count) ? Math.trunc(count) : 0;
      if (n <= 0) return s;
      return {
        checks: { ...s.checks, [check]: (s.checks[check] ?? 0) + n },
        actions: { ...s.actions, [action]: (s.actions[action] ?? 0) + n },
      };
    }),
  reset: () => set({ checks: emptyChecks(), actions: emptyActions() }),
}));

/**
 * Per-check rollup: the checks that actually fired, busiest first, plus the grand total. Ties break
 * on the check id so the ordering is stable across renders (an unstable list of ten rows reorders
 * itself under the reader's cursor). Zero-count checks are excluded from `rows` — a rollup padded
 * with eight zeroes buries the two lines that matter — but `total` counts everything. Pure.
 */
export function checkTotals(checks: Record<LintCheckId, number>): {
  rows: { check: LintCheckId; count: number }[];
  total: number;
} {
  const rows = (Object.entries(checks) as [LintCheckId, number][])
    .filter(([, count]) => count > 0)
    .map(([check, count]) => ({ check, count }))
    .sort((a, b) => b.count - a.count || a.check.localeCompare(b.check));
  const total = Object.values(checks).reduce((sum, n) => sum + n, 0);
  return { rows, total };
}

/**
 * Correction rate: how much of the linter's activity was the app FIXING the reply rather than just
 * flagging it. `autofixed` and `revised` produced a compliant reply; `warned` and `rendered_marked`
 * did not (the latter is the give-up path after the one permitted retry, so it is an uncorrected
 * violation the human still had to read). `pct` is null when there is no signal yet (0/0) — a rate
 * of zero and no data at all are different facts. Pure.
 */
export function correctionRate(actions: Record<LintAction, number>): {
  corrected: number;
  uncorrected: number;
  pct: number | null;
} {
  const corrected = actions.autofixed + actions.revised;
  const uncorrected = actions.warned + actions.rendered_marked;
  const total = corrected + uncorrected;
  return { corrected, uncorrected, pct: total === 0 ? null : corrected / total };
}
