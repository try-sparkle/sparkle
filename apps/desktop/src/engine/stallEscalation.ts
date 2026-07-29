// stallEscalation — GRAY IS A TERMINAL STATE. A resting row that still owes work goes RED.
//
// THE FOUNDER'S RULE, verbatim (2026-07-29): "a worker should basically never be gray and local
// uncommitted. It should always be either working or blocked. So gray really should kind of only
// ever exist at the bottom, when things have been shipped to production."
//
// THE ROW THAT PROVOKED IT. Agent b2d902e0 ("Concierge Fleet Ladder") rendered GRAY in LOCAL:
// UNCOMMITTED while its terminal simultaneously showed it working — three Explore agents finished, a
// goal set, two Plan agents finished, a sparkle-control call in flight. Status is derived from
// whether Claude's spinner is on screen, so a batch of subagents completing produces a quiet gap,
// the quiet-settle fires, and a working agent is reclassified idle. The row was mid-task with an
// unmet goal and it looked done. The founder's complaint is the general one: they cannot trust the
// column at a glance, and every colour that lies costs them a terminal read to check.
//
// WHY AN OVERLAY AND NOT A NEW STATUS. Same call `unmergedAttention` and `workerAttention` made:
// `AgentTabStatus` is unchanged, so every existing branch on `idle` keeps working and nothing that
// already reads a status silently changes meaning. This composes onto the status MAP.
//
// WHY `blocked` AND NOT A NEW COLOUR. The founder named it — "working or blocked" — and it already
// means exactly this: `packages/ui/tokens.ts` defines `blocked` as RED, "went quiet / stalled —
// needs you to unstick it", and it is deliberately EXCLUDED from the dock badge and banner set
// (engine/attention.ts covers waiting/approval/errored only). So this recolours the dot and surfaces
// the row cross-project — "needs you eventually" — without firing a notification per stalled agent.
// That is the difference between making the column honest and paging the human 27 times.
//
// ── THE DECISION THIS OVERRULES, AND HOW TO PUT IT BACK ──────────────────────────────────────────
// `unmerged` was RED until 2026-07-26 and was made GRAY on purpose. The reasoning is recorded at
// tokens.ts:150-157 and pinned by engine/redTaxonomySeparation.test.ts: on a real fleet 27 of 51
// agents sat in the committed-but-unlanded band, so a wall of red said "most of your agents have a
// branch", not "these agents need you". That is a REAL cost and this module re-incurs part of it —
// the founder's rule above is the explicit overrule (the tokens comment invites it: "If the founder
// wants the hue split anyway, this is the paragraph to overrule").
//
// Two things keep it survivable, and if the wall returns, this is where to cut:
//   • `OUTSTANDING` below is the whole predicate. Dropping "unlanded-work" from it restores the
//     2026-07-26 behaviour for the 27/51 band while keeping the goal and dirty-worktree cases —
//     one line, no other file involved.
//   • The escalation is NOT in the badge/banner set (see above), so a red dot here never becomes a
//     notification storm.
//
// The token itself is untouched: `unmerged` is still gray, and a row only leaves the calm tier when
// there is EVIDENCE of outstanding work. This is a claim about a row's state, not a recolouring of
// the taxonomy.
import type { AgentTabStatus } from "@sparkle/ui";
import type { StallCause, StallReport } from "./agentStall";

/**
 * The calm (gray) statuses this overlay may escalate.
 *
 * `idle` and `unmerged` only, and that is not an oversight. `agentStall.stallReport` answers
 * `active` for `done`/`stopped` — the process is gone — so a report can never say "stalled" about
 * one, and escalating a dead agent would be a DIFFERENT claim than `blocked` makes: "clean this up",
 * not "unstick it". A stopped agent holding a dirty worktree therefore still renders gray, which the
 * founder's rule arguably also forbids; that case needs its own answer (and probably its own words
 * on the row) rather than being smuggled in under a label that says the wrong thing.
 *
 * `new` needs no exclusion of its own: an unbriefed agent has no outstanding work, so no report
 * about it is ever `stalled`. That leaves engine/newAgentAttention's careful "spawned but never
 * briefed is the ABSENCE of an alarm" work intact by construction rather than by agreement.
 */
const ESCALATABLE: ReadonlySet<AgentTabStatus> = new Set<AgentTabStatus>(["idle", "unmerged"]);

/** What a stalled row is escalated TO. Red, "needs you to unstick it", no badge, no banner. */
export const ESCALATED_STATUS: AgentTabStatus = "blocked";

/**
 * The causes that mean "this row is not finished".
 *
 * Every `StallCause` is here today, which is the point of the founder's rule: each one is work that
 * exists and that nothing is coming to finish. Kept as an explicit set rather than "any cause at
 * all" so that adding a new cause to `agentStall` forces a decision here about whether it belongs
 * in the red tier, instead of silently recolouring rows.
 */
const OUTSTANDING: ReadonlySet<StallCause> = new Set<StallCause>([
  "unmet-goal",
  "escalated-goal",
  "expired-goal",
  "open-pr",
  "unlanded-work",
  "uncommitted-changes",
]);

/** Does this report describe a row that must not render calm? */
export function mustLeaveCalm(report: StallReport | undefined): boolean {
  if (report === undefined) return false;
  // `unknown` is deliberately NOT escalated. It means "we did not read the git state", and a red dot
  // on missing evidence is the false alarm that trains the human to ignore the colour — the same
  // reason `agentStall.isStalled` is false for it. Evidence, not inference.
  if (report.verdict !== "stalled") return false;
  return report.causes.some((c) => OUTSTANDING.has(c));
}

/**
 * Escalate every calm row that still owes work to the red `blocked` tier.
 *
 * Pure, and in the same shape as `unmergedAttention.withUnmergedWork`: returns the SAME reference
 * when nothing changes (no render churn) and never mutates the input.
 *
 * COMPOSE ORDER: run this AFTER `withUnmergedWork`, so a committed-but-unlanded row has already been
 * labelled `unmerged` and is visible to `ESCALATABLE`; and BEFORE `alertDismissal.withDismissedAlerts`,
 * so a human who dismisses the row can still calm it — `blocked` IS in the dismissible set, which is
 * what stops this from being the undismissable red that sank the 2026-07-26 version.
 *
 * `reportOf` returns `undefined` for an agent this window has no stall reading for, and that never
 * escalates: a window that did not look must not paint the row red on its ignorance.
 */
export function withStallAttention<T extends { id: string }>(
  agents: readonly T[],
  statusMap: Record<string, AgentTabStatus>,
  reportOf: (id: string) => StallReport | undefined,
): Record<string, AgentTabStatus> {
  let out: Record<string, AgentTabStatus> | null = null;
  const ensure = (): Record<string, AgentTabStatus> => (out ??= { ...statusMap });
  for (const a of agents) {
    const st = statusMap[a.id];
    if (st === undefined || !ESCALATABLE.has(st)) continue;
    if (!mustLeaveCalm(reportOf(a.id))) continue;
    ensure()[a.id] = ESCALATED_STATUS;
  }
  return out ?? statusMap;
}
