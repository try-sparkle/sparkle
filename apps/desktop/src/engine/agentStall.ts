// agentStall — telling "idle and FINISHED" apart from "idle and STALLED".
//
// Today both render gray and read identically, and that identity is what made a 153-minute stall
// invisible: the row for an agent that stopped mid-write on a file looks exactly like the row for
// an agent that shipped its PR and has nothing left to do. The human is asked to tell them apart by
// remembering what each of ~35 agents was doing.
//
// An idle agent is STALLED when it still owes work:
//   • an unmet goal (engine/agentGoal), or
//   • an open PR nobody merged, or
//   • uncommitted changes in its worktree.
// Any one of those means "not done". None of them means "done", and that is the honest reading —
// an agent with no goal, no PR and a clean tree really has nothing outstanding that we can see.
//
// WHAT THIS IS NOT. It is not a second status. `AgentTabStatus` stays exactly as it is, and this
// module is a derived OVERLAY read alongside it, for the same reason `rollupDot` was added beside
// `status` rather than folded into it: every existing consumer that branches on `idle` keeps
// working unchanged, and nothing that already reads a status silently changes meaning.
//
// EVIDENCE, NOT INFERENCE — and the difference decides the DEFAULTS. Each input is optional, and an
// ABSENT input never manufactures a stall. A window that cannot see an agent's git state must not
// paint it stalled on that ignorance: this surface exists to make a real stall findable, and a
// stall claim that fires on missing data trains the human to ignore the signal, which costs more
// than the stall did. `unknown` is a real answer here (mirroring `rollupDot`'s null arm).
import type { AgentTabStatus } from "@sparkle/ui";
import { type AgentGoal, goalStateOf } from "./agentGoal";
import { SESSION_LIMIT_FALLBACK_MS, type QuotaBlock, isQuotaBlocked } from "./quotaBlock";

/** What an idle row actually means.
 *
 *  `stalled` — idle with work outstanding. Nothing is coming to finish it on its own.
 *  `finished` — idle with nothing outstanding that we can see.
 *  `unknown`  — idle, nothing outstanding VISIBLE, but we could not see the evidence that would
 *               have shown otherwise. Distinguished from `finished` so a caller never reads
 *               "we didn't look" as "there's nothing there".
 *  `active`   — not idle at all; the question does not arise.
 *  `quota-blocked` — the agent hit an ACCOUNT limit (session window or spend cap) and cannot do
 *               anything at all until a stated wall-clock time. Reported ahead of every other arm
 *               because it is the only verdict here that is TOTAL: a stalled agent could be
 *               restarted, an active one is working, but this one is barred until the clock says
 *               otherwise. It is deliberately NOT folded into `stalled` — a stall says "nothing is
 *               coming to finish this on its own", which invites a restart, and restarting into a
 *               quota wall is precisely the waste that made this condition invisible. */
export type StallVerdict = "stalled" | "finished" | "unknown" | "active" | "quota-blocked";

/** Why a row is stalled, most-actionable first. Reported so the UI and the concierge can say what
 *  is outstanding rather than only that something is. */
export type StallCause =
  | "unmet-goal"
  | "escalated-goal"
  | "expired-goal"
  | "open-pr"
  | "unlanded-work"
  | "uncommitted-changes";

export interface StallInput {
  status: AgentTabStatus;
  now: number;
  goal: AgentGoal | undefined;
  /** An open, unmerged PR for this agent's branch. `undefined` = not looked up. */
  hasOpenPr?: boolean;
  /**
   * Committed work that has not reached `main` — `workflowStage.hasUnmergedCommittedWork`.
   * `undefined` = not looked up, EXCEPT that a `status` of `unmerged` is itself the answer: the
   * overlay writes that band only when this is true, so it needs no second lookup.
   */
  hasUnlandedWork?: boolean;
  /** Uncommitted changes in the agent's worktree. `undefined` = not looked up. */
  hasUncommittedChanges?: boolean;
  /**
   * An observed account/quota wall (engine/quotaBlock). `undefined` = none seen, NEVER "blocked".
   *
   * Consulted BEFORE the `isQuiet` gate, which is the whole point of adding it here. A quota-walled
   * agent keeps its PTY alive and keeps redrawing, so its status reads `working` — and `working` is
   * not quiet, so this module returned `active` ("not idle") and stopped. That answer is true and
   * useless: it describes the terminal rather than the agent, and it is what let a totally-blocked
   * agent read healthy for hours.
   */
  quotaBlock?: QuotaBlock;
}

export interface StallReport {
  verdict: StallVerdict;
  /** Every outstanding thing found. Empty unless `verdict === "stalled"`. */
  causes: StallCause[];
  /** One sentence for a human or an LLM, so neither has to infer what the verdict establishes. */
  detail: string;
}

/** Statuses where the agent is not doing anything and nothing is scheduled to make it start.
 *
 *  `unmerged` IS ONE OF THEM, and leaving it out was a hole big enough to swallow the feature
 *  (roborev 55252). `engine/unmergedAttention.withUnmergedWork` rewrites any RESTING row
 *  (idle/done/stopped) that has committed-but-unlanded work to `unmerged`, and that overlay is
 *  applied to the maps the UI and the notification path actually read. `unmerged` is GRAY —
 *  "Needs merge", a landing state, not an alarm — and on a real fleet 27 of 51 agents sat in that
 *  band. So it is not an edge case: it is the MOST COMMON gray row, and it means "finished a unit
 *  of work that has not landed", which is the canonical stall this module exists to name. Reading
 *  it as `active` told the concierge an agent was busy while it was doing nothing, and it made the
 *  `open-pr` cause almost unreachable — an agent with an open PR is in that band by construction,
 *  so it was filtered out before `hasOpenPr` was ever consulted.
 *
 *  `waiting`/`approval`/`blocked`/`errored` are deliberately EXCLUDED even though the agent is also
 *  not working in those: they are the RED tier, already loud, already surfaced, and already
 *  understood by the human as "this one needs me". Painting them stalled as well would add a second
 *  alarm to a row that is not the problem — the whole point here is the GRAY rows nobody is
 *  looking at. `done`/`stopped` are excluded because the process is gone: a dead agent with a dirty
 *  worktree is a cleanup question, not a stall that resuming could fix. `new` is excluded because
 *  nobody has briefed it — there is no work outstanding to stall on.
 *
 *  THE ONE ASYMMETRY WITH `goalContinuation`, made deliberately. Because the overlay also relabels
 *  `done`/`stopped`, an `unmerged` row here may be an agent whose process is GONE — the same
 *  ambiguity that makes `goalContinuation` demand `processAlive` before it spends money on the
 *  band. This surface does NOT ask, and does not need to: it only tells a human that unlanded work
 *  exists, which is true whether or not the process survived, and someone still has to land or
 *  discard that branch. The two answers differ because the questions do — "should we type into this
 *  terminal" needs a live PTY, "is there work nobody is finishing" does not. What this surface must
 *  never do is promise that resuming would fix it, which is why the stalled sentence says only that
 *  nothing is coming to finish it on its own. */
function isQuiet(status: AgentTabStatus): boolean {
  return status === "idle" || status === "unmerged";
}

/**
 * Is this idle row stalled, finished, or merely unexamined?
 *
 * The `unknown` arm is the subtle one. It fires when we found NO outstanding work but were also
 * missing at least one piece of evidence — because "no evidence of work" and "evidence of no work"
 * are different claims, and only the second licenses calling an agent done. If any cause IS found,
 * missing evidence elsewhere no longer matters: the row is stalled regardless of what the
 * unexamined inputs would have said, so a partial view still produces a confident, useful answer.
 */
export function stallReport(input: StallInput): StallReport {
  const { status, now, goal, hasOpenPr, hasUncommittedChanges, quotaBlock } = input;

  // FIRST, AHEAD OF THE `isQuiet` GATE — because a quota wall is the one condition that is invisible
  // from status alone. The agent's PTY is alive and redrawing, so it reads `working`; the old first
  // line returned `active` on that and never looked further. Nothing below can be true in a useful
  // way while the agent is barred from acting, so this arm short-circuits the rest.
  if (isQuotaBlocked(quotaBlock, now) && quotaBlock !== undefined) {
    return {
      verdict: "quota-blocked",
      causes: [],
      detail: quotaBlockedDetail(quotaBlock),
    };
  }

  if (!isQuiet(status)) {
    return { verdict: "active", causes: [], detail: `Status '${status}' — not idle.` };
  }

  // The `unmerged` band IS the evidence, so it needs no lookup: `withUnmergedWork` writes it only
  // where `hasUnmergedCommittedWork(stage)` held. Without this the most common gray row on the
  // fleet reported `finished — genuinely done` about an agent whose own label read "Needs merge"
  // (roborev on ba9d662), which is the same false sentence the `expired-goal` cause exists to stop.
  //
  // THIS DOES MEAN EVERY `unmerged` ROW READS `stalled`, and roborev 55298 argued that re-creates the
  // 27-of-51 wall of red the 2026-07-26 de-redding removed. That argument was DECLINED, not missed:
  // the founder's rule of 2026-07-29 is that gray is a terminal state — "gray really should kind of
  // only ever exist at the bottom, when things have been shipped to production" — so a row holding
  // unlanded commits is precisely the row that must stop reading calm. What keeps it from being the
  // old wall is engine/stallEscalation: the escalation lands on `blocked`, which fires no badge and
  // no banner and can be dismissed. The volume concern is real and recorded there, with the one-line
  // revert, rather than being answered by making this surface lie again.
  //
  // BE HONEST ABOUT THE ORDER OF ARRIVAL: that mitigation is not composed into the rendered maps yet
  // (see the note at the top of unmergedAttention). So today this surface reports every `unmerged`
  // row as stalled while nothing recolours it — the reports are consumed by the control surfaces and
  // the concierge, not yet by the sidebar's colour. Whoever wires it inherits the volume decision.
  const hasUnlandedWork = input.hasUnlandedWork ?? (status === "unmerged" ? true : undefined);

  const causes: StallCause[] = [];
  const goalState = goalStateOf(goal, now);
  if (goalState === "unmet") causes.push("unmet-goal");
  // An ESCALATED goal is still outstanding work — auto-continue gave up on it, which makes it MORE
  // the human's problem, not less. Folding it into `finished` would hide precisely the agent the
  // escalation was raised about.
  if (goalState === "escalated") causes.push("escalated-goal");
  // An EXPIRED goal is unfinished work whose auto-continue MANDATE ran out — the two are different
  // facts, and only the first one this surface reports on (roborev 55252). The TTL is a bound on
  // SPEND (see agentGoal.DEFAULT_GOAL_TTL_MS); reusing it to silence the human surface said
  // "genuinely done" about an agent that never finished. Worse, it went quiet on exactly the worst
  // cases: a goal set at 09:00 whose agent stalled at 09:30 in a window with no turn-end authority
  // is never continued and never escalated, so it reads `stalled` until 13:00 and then flips to
  // `finished` — and the 153-minute-class stalls this feature was commissioned for are the ones
  // most likely to cross the TTL.
  if (goalState === "expired") causes.push("expired-goal");
  if (hasOpenPr === true) causes.push("open-pr");
  // FOLDED INTO `open-pr` WHENEVER BOTH HOLD. An agent with an open PR has unlanded commits by
  // construction, so reporting both said the same fact twice — "it has an open PR that nobody merged
  // and it has committed work that never reached main" (roborev 55298).
  //
  // This was briefly scoped to the INFERRED case only, on the argument that a caller asserting
  // `true` makes the stronger claim "there are commits the PR does not contain". That distinction
  // does not exist: the only production producer (`rowAttention.stallInputsFor`) always supplies the
  // field explicitly once there is any git reading, and its value is `hasUnmergedCommittedWork(stage)`
  // — a stage-BAND predicate whose band includes `pull_request`. So it is derived from the same fact
  // the PR is, and the "explicit" path existed only for test callers while production got the
  // duplicate sentence back (roborev 55379).
  //
  // "Commits beyond the PR" is a real and different question — `ahead` versus the PR head — and
  // nothing in the repo computes it. When something does, it belongs here as its OWN input rather
  // than as a re-reading of this one.
  if (hasUnlandedWork === true && hasOpenPr !== true) causes.push("unlanded-work");
  if (hasUncommittedChanges === true) causes.push("uncommitted-changes");

  if (causes.length > 0) {
    return { verdict: "stalled", causes, detail: stalledDetail(causes, goal) };
  }

  // Nothing found — but did we actually look? An input left `undefined` was never resolved.
  const unexamined =
    hasOpenPr === undefined || hasUnlandedWork === undefined || hasUncommittedChanges === undefined;
  if (unexamined) {
    return {
      verdict: "unknown",
      causes: [],
      detail:
        "Idle with no outstanding work found, but its git state was not read — this is 'not " +
        "checked', not 'nothing to do'. Do not report it as finished.",
    };
  }
  return {
    verdict: "finished",
    causes: [],
    detail:
      "Resting with no goal outstanding, no open PR, nothing unlanded and a clean worktree — " +
      "genuinely done.",
  };
}

/**
 * The human-facing sentence for a quota wall.
 *
 * IT QUOTES THE AGENT'S OWN MESSAGE VERBATIM, and that is the requirement rather than a nicety: the
 * message is the only place the reset time and the remedy path (`/usage-credits`,
 * `claude.ai/settings/usage`) appear, and both are what let the human decide between waiting,
 * switching accounts, and raising the cap. A summary that says "it hit a limit" sends them to go and
 * find the terminal, which is the work this app exists to remove.
 *
 * It also says plainly that restarting cannot help. The auto-resume loop that made this block
 * invisible did so by looking busy, and a reader who has just been told an agent is blocked will
 * otherwise reach for exactly that lever.
 */
function quotaBlockedDetail(block: QuotaBlock): string {
  const when = block.resetParsed
    ? `It clears on its own at the stated time`
    : `The message names no reset time, so this will be re-checked within ${Math.round(
        SESSION_LIMIT_FALLBACK_MS / 3_600_000,
      )}h`;
  return (
    `Blocked on an account limit — it cannot do anything until it clears. The agent said, ` +
    `verbatim: "${block.message}". ${when}; restarting it changes nothing before then.`
  );
}

/** The human-facing sentence for a stalled row. Names the outstanding work, because "stalled" on
 *  its own tells the reader to go investigate, and the investigation is the expensive part. */
function stalledDetail(causes: StallCause[], goal: AgentGoal | undefined): string {
  const parts = causes.map((c) => {
    switch (c) {
      case "unmet-goal":
        return `its goal is not met ("${goal?.text ?? ""}")`;
      case "escalated-goal":
        return `auto-continue gave up on its goal${goal?.escalationReason ? ` — ${goal.escalationReason}` : ""}`;
      case "expired-goal":
        return `its goal ran out of time without being met ("${goal?.text ?? ""}")`;
      case "open-pr":
        return "it has an open PR that nobody merged";
      case "unlanded-work":
        return "it has committed work that never reached main";
      case "uncommitted-changes":
        return "it has uncommitted changes";
    }
  });
  return `Resting, but not done: ${joinList(parts)}. Nothing is coming to finish this on its own.`;
}

/** "a", "a and b", "a, b and c" — the serial comma is omitted to match the app's existing copy. */
function joinList(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** Is this row one a human should be told about? True only for a confident stall. `unknown` is
 *  deliberately NOT surfaced as an alarm — see the evidence note at the top of this file. */
export function isStalled(report: StallReport): boolean {
  return report.verdict === "stalled";
}
