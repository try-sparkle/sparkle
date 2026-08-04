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
//     one line, no other file involved. That cut has already been made ONCE, for `expired-goal`
//     (sparkle-biezi): a lapsed TTL is a fact about the clock, not about the work, and it was
//     painting FINISHED agents red. The reasoning is on `OUTSTANDING` itself — read it before
//     adding any cause back.
//   • The escalation is NOT in the badge/banner set (see above), so a red dot here never becomes a
//     notification storm.
//
// The token itself is untouched: `unmerged` is still gray, and a row only leaves the calm tier when
// there is EVIDENCE of outstanding work. This is a claim about a row's state, not a recolouring of
// the taxonomy.
import type { AgentTabStatus } from "@sparkle/ui";
import type { StallCause, StallReport } from "./agentStall";
import { isAlertSuppressed, type AgentAlertRecord } from "./alertDismissal";
import { isInMotion, type MotionAgent } from "./inMotion";

/**
 * The calm (gray) statuses this overlay may escalate.
 *
 * `idle` and `unmerged` only. Excluding `done`/`stopped` here is NOT sufficient to exclude dead
 * processes, and believing it was is the trap this module fell into (roborev 55318): `withUnmergedWork`
 * relabels `done`/`stopped` rows that hold unlanded commits to `unmerged`, and this overlay runs
 * AFTER it — so every persisted tab with an unlanded branch arrives here already wearing a status
 * that is in this set, and `stallReport` answers `stalled` on the band's own evidence. The row was
 * painted "needs you to unstick it" about an agent whose PTY is gone, which is verbatim the claim
 * this docstring said must not be made. A status the upstream overlay has overwritten cannot answer
 * a liveness question; `aliveOf` does, and it is why that parameter exists.
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
 * Kept as an explicit set rather than "any cause at all" so that adding a new cause to `agentStall`
 * forces a decision here about whether it belongs in the red tier, instead of silently recolouring
 * rows. Each member is work that EXISTS and that nothing is coming to finish — which is what the
 * founder's rule licenses painting red.
 *
 * ── `expired-goal` IS DELIBERATELY ABSENT. EXPIRY IS NOT AN ALARM. ───────────────────────────────
 * It was in this set and it was the single biggest source of false red on the fleet (sparkle-biezi).
 * Verified live on agent 11a52157: status `idle`, `needsYou` false, thrash `healthy`, a spotless
 * worktree, zero commits of its own — and `stallReport` returned `stalled` with the ONE cause
 * `expired-goal`, so this set painted it "needs you to unstick it". Three more rows in the same
 * screenshot were labelled MERGED TO MAIN and red for the same reason. Four rows at once, all of
 * them finished, all of them wearing the loudest signal the app has.
 *
 * The distinction the old membership missed: every OTHER cause is a fact about the WORK (a goal
 * nobody met, a PR nobody merged, commits that never landed, files nobody committed). Expiry is a
 * fact about the CLOCK — `setAt + ttlMs` elapsed. `agentGoal.DEFAULT_GOAL_TTL_MS` bounds how long
 * auto-continue may SPEND on a goal; it says nothing about whether the work got done, and it fires
 * on a finished agent and an abandoned one identically. Attaching the strongest signal in the app to
 * the weakest available cause is what taught the founder to read the column's red as noise — which
 * costs more than every stall this module was commissioned to surface.
 *
 * WHAT THIS DOES NOT DO — and why no second rule was needed for the two halves of the founder's
 * rule ("expired + landed = gray; expired + unlanded = surfaced, never red"):
 *   • EXPIRED + LANDED → the expiry is the only cause, this set matches nothing, the row stays
 *     calm. Gray, done. That is the four-row bug above.
 *   • EXPIRED + UNLANDED → `open-pr` / `unlanded-work` / `uncommitted-changes` are still in this
 *     set and still fire on their own evidence, so that row still leaves calm — on the strength of
 *     the WORK, which is a claim that holds up, rather than on the strength of the clock.
 * So the unlanded half keeps exactly the colour it had; only the clock stops voting.
 *
 * THE CAUSE ITSELF IS UNTOUCHED, and that is the whole "surfaced, never red" half. `agentStall`
 * still reports `expired-goal`, so `rowAttention.stallChipFor` still renders the "goal expired" chip
 * and `goalBadgeFor` still renders "ran out of time — never met" in amber. The reader still learns
 * the TTL lapsed; they just no longer learn it in the colour reserved for "a human is blocking this".
 * Do NOT fix a future "expiry is invisible" report by adding it back here — the affordance exists,
 * one layer up.
 */
const OUTSTANDING: ReadonlySet<StallCause> = new Set<StallCause>([
  "unmet-goal",
  "escalated-goal",
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
 * COMPOSE ORDER: after `withUnmergedWork` (so a committed-but-unlanded row is already wearing
 * `unmerged` and is visible to `ESCALATABLE`), then feed the result to the alert-episode recorder,
 * then {@link withDismissedStallAttention}, and only then `alertDismissal.withDismissedAlerts` for
 * the ordinary reds. This function escalates UNCONDITIONALLY — acknowledgement is undone by that
 * second pass, for the reason recorded on it.
 *
 * THREE THINGS A CALLER MUST GET RIGHT, each of which was a real defect:
 *
 *  1. `aliveOf` is REQUIRED, and `engine/turnEndAuthority.processAliveOf` is the producer. A `false`
 *     refuses escalation. Without it, dead persisted tabs relabelled `unmerged` upstream were painted
 *     "needs you to unstick it" (roborev 55318).
 *  2. `reportOf` MUST be built from the agent's OWN pre-escalation status. Feed it this function's
 *     OUTPUT and the reports collapse: `stallReport` answers `active` for the whole red tier, so a
 *     row that escalated to `blocked` would report no causes at all — the row would go red and
 *     simultaneously lose the sentence saying WHY, which is the entire value of the escalation.
 *  3. The ALERT path must be fed this function's OUTPUT, with acknowledged rows undone afterwards by
 *     {@link withDismissedStallAttention} rather than by a check in here. `alertControlKind`, `advanceAlerts` and
 *     `dismissAlert` all take a status, and if they are handed the raw map they see `idle`/`unmerged`,
 *     return `null`, and render no Dismiss control — a red the human cannot acknowledge, which is
 *     exactly the undismissable `unmerged` red that had to be rolled back on 2026-07-26 (roborev
 *     55318). `blocked` is in the dismissible set; that only helps if the control sees it.
 *
 * `reportOf` returns `undefined` for an agent this window has no stall reading for, and that never
 * escalates: a window that did not look must not paint the row red on its ignorance.
 */
export function withStallAttention<T extends MotionAgent & { id: string; alert?: AgentAlertRecord }>(
  agents: readonly T[],
  statusMap: Record<string, AgentTabStatus>,
  reportOf: (id: string) => StallReport | undefined,
  aliveOf: (id: string) => boolean | undefined,
): Record<string, AgentTabStatus> {
  let out: Record<string, AgentTabStatus> | null = null;
  const ensure = (): Record<string, AgentTabStatus> => (out ??= { ...statusMap });
  for (const a of agents) {
    const st = statusMap[a.id];
    if (st === undefined || !ESCALATABLE.has(st)) continue;
    // A KNOWN-DEAD process is never escalated. `undefined` still escalates: an `idle` row is derived
    // from a live PTY's own output, and refusing on absent evidence here would re-open the gray lie
    // this module exists to close (the opposite trade-off from `goalContinuation`, which fails closed
    // because a wrong "yes" there SPENDS money; a wrong "yes" here only colours a dot).
    if (aliveOf(a.id) === false) continue;
    // AN ORCHESTRATOR WHOSE SUBTREE IS WORKING IS NOT STALLED, and this is the same refusal
    // `withRedWorkerAttention` makes with the same predicate (roborev 55423/55434). A head resting at
    // `idle`/`unmerged` while one of its workers is `working` was painted "needs you to unstick it"
    // about a subtree visibly making progress — precisely the false alarm this module's header says it
    // must avoid, and the class of red that made the previous version worthless. The row's own status
    // cannot see this: delegation is work the PARENT is not doing itself.
    if (isInMotion(a.id, agents, statusMap)) continue;
    if (!mustLeaveCalm(reportOf(a.id))) continue;
    ensure()[a.id] = ESCALATED_STATUS;
  }
  return out ?? statusMap;
}

/**
 * Return the rows whose escalation the human has ACKNOWLEDGED to the band they came from.
 *
 * Run this AFTER `withStallAttention` and after `advanceAlerts` has seen the escalated map. Compose
 * it INSTEAD of letting `withDismissedAlerts` handle an escalated row, because that path
 * de-escalates `blocked` to `idle` unconditionally: a dismissed row that came from `unmerged` would
 * come back as `idle`, losing its "Needs merge" label, losing its ordering band, and — because
 * `agentStall` reads `status === "unmerged"` as the EVIDENCE of unlanded work — making the next stall
 * report read `unknown` instead of `stalled`. One acknowledgement would have erased the fact that the
 * branch exists, which is the false calm this module was written to abolish (roborev 55318).
 *
 * WHY THIS IS A SEPARATE PASS, and not a check inside the escalation above. It WAS such a check, and
 * that inverted the whole `alertDismissal` design (roborev 55379). The episode counter only advances
 * from the status a row actually PRESENTS, so an escalation that skips itself when suppressed never
 * presents `blocked`, `seq` never moves past `dismissedSeq`, and the suppression becomes a ratchet no
 * new stall can lift. Worse, `isAlertSuppressed` does not say WHICH red was acknowledged — only that
 * the dismissal matches the current episode — so a `waiting` alarm dismissed weeks ago left
 * `dismissedSeq === seq` forever and silently suppressed the row's first-ever stall. Escalating
 * unconditionally and undoing it here keeps the counter honest: the record always sees `blocked`, so
 * a dismissal is about THIS alarm and a genuinely new episode still re-raises it.
 */
export function withDismissedStallAttention<T extends { id: string; alert?: AgentAlertRecord }>(
  agents: readonly T[],
  escalatedMap: Record<string, AgentTabStatus>,
  calmMap: Record<string, AgentTabStatus>,
): Record<string, AgentTabStatus> {
  let out: Record<string, AgentTabStatus> | null = null;
  const ensure = (): Record<string, AgentTabStatus> => (out ??= { ...escalatedMap });
  for (const a of agents) {
    if (escalatedMap[a.id] !== ESCALATED_STATUS) continue;
    // Only a row THIS pass escalated: an agent whose own status is genuinely `blocked` (statusEngine's
    // stall timer, improvementPass) is not ours to restore, and `calmMap` would say `blocked` for it
    // anyway, so the guard is about intent rather than about the value.
    const calm = calmMap[a.id];
    if (calm === undefined || calm === ESCALATED_STATUS) continue;
    // THE DISMISSAL MUST BE ABOUT THIS ALARM. `isAlertSuppressed` only says "the acknowledgement
    // matches the current episode"; it never says WHICH red was acknowledged. So an agent that went
    // `waiting` once, had it dismissed, and recovered carries `dismissedSeq === seq` FOREVER (leaving
    // red clears `lastRed` without moving `seq`), and its first-ever stall would have been undone on
    // the strength of an acknowledgement about something else entirely (roborev 55379/55423).
    //
    // `lastRed` is the episode's own kind, so requiring it to BE the escalated status is what ties the
    // acknowledgement to this alarm. Escalating unconditionally is what keeps that field truthful:
    // the recorder is handed the pre-undo map, so a genuinely stalled row always presents `blocked`
    // to it.
    if (a.alert?.lastRed !== ESCALATED_STATUS) continue;
    if (!isAlertSuppressed(a.alert, ESCALATED_STATUS)) continue;
    ensure()[a.id] = calm;
  }
  return out ?? escalatedMap;
}
