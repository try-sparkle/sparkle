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
import { agentClosableKind } from "@sparkle/core";
import { type AgentGoal, goalStateOf } from "./agentGoal";
import { SESSION_LIMIT_FALLBACK_MS, type QuotaBlock, isQuotaBlocked } from "./quotaBlock";
import { joinList } from "./joinList";

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
 *  is outstanding rather than only that something is.
 *
 *  ⚠️ ADDING ONE IS A COLOUR DECISION. `engine/stallEscalation` partitions this union into the RED
 *  tier (`OUTSTANDING`) and the amber one (`LIFECYCLE`), and a cause in neither renders calm gray.
 *  `redAttentionTaxonomy.test.ts` makes an unclassified cause a TYPE error rather than letting it
 *  inherit a tier by falling through — answer the question there when you add one. */
export type StallCause =
  | "human-verified-goal"
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
  // FIRST, because it is the only cause in this file that means "a human is required" — see the
  // corrected paragraph further down, which said no such cause existed until 2026-08-07.
  //
  // ── THE ONE CAUSE THAT SURVIVES "RED = THE FOUNDER IS THE ONLY ACTOR" ────────────────────────────
  // Both halves must hold, and each on its own is a false alarm the founder has already triaged:
  //
  //   1. AUTO-CONTINUE EXPLICITLY HANDED IT BACK — `escalated`, and ONLY that.
  //      • NOT `unmet`: the agent still has work left, so his verdict is not owed yet. Firing there
  //        would paint every agent carrying a sign-off red the moment it went quiet — the volume
  //        mistake this whole change is undoing, rebuilt under a better name.
  //      • NOT `expired` EITHER, and that half WAS here in the first cut (roborev 60322). Expiry is
  //        the highest-volume goal cause — every agent outliving its TTL earns one — and it is
  //        deliberately calm gray for exactly that reason (sparkle-biezi, and the founder's own
  //        2026-08-07 instruction lists it as a cause that must not be red because re-arming the
  //        clock is a CONCIERGE action). Admitting it through a composite cause would have
  //        re-reddened that population by the back door, which is the specific thing this file is
  //        being changed to stop. Escalation is the narrow signal: our machinery ran out of budget
  //        and SAID SO. A clock lapsing says nothing and asks for nothing.
  //   2. NO AGENT MAY EVER CLOSE IT — `core.agentClosableKind` is the authority and answers NO for
  //      `command` and `human`, YES for `landed`. ASKED rather than restated (the same reason that
  //      predicate itself defers to `canSelfMarkMet`): the day someone wires the command executor,
  //      `command` becomes agent-closable and this cause stops firing for it with no edit here.
  //   3. A CALLER STATED THAT CHECK FOR *THIS* GOAL — `verifyStated === true && verifyInherited !==
  //      true`. This is `controlListener`'s `chosenHere` predicate, deliberately the same expression
  //      rather than a third reading of the two provenance bits.
  //
  //      ⚠️ IT TOOK TWO ROUNDS TO GET RIGHT, and the near-miss is the instructive part. The first cut
  //      had no provenance term at all (roborev 60322): `chargeGoalDebt` MANUFACTURES
  //      `{kind:"human"}` as its fallback (`INHERITED_VERIFY`) for goal text it cannot infer a check
  //      for, so an agent wore the loudest signal in the app for a sign-off nobody asked for. The
  //      second cut added `verifyStated === true` alone, which is STILL TOO WIDE (roborev 60325):
  //      that flag answers "was a check of this kind EVER chosen", and it is carried VERBATIM through
  //      same-kind inheritance. So an owed stated `human` plus any non-landing-shaped new goal text
  //      inherits `{kind:"human"}` with `verifyStated: true` — and since `send_to_agent_terminal`
  //      records ordinary work goals with no `verify`, that inheritance is the COMMON path, not an
  //      edge case. `verifyInherited` is the narrower bit and is what closes it.
  //
  //      ⚠️ BOTH TERMS FAIL QUIET, so absent (legacy) does not qualify — the OPPOSITE default from
  //      `AgentGoal.verifyStated`'s own docstring, deliberately. There absence fails CLOSED (binding)
  //      because a wrong answer lets an agent LAUNDER away a real sign-off. Here a wrong answer only
  //      paints a dot, and the installed base is full of persisted `human` checks carrying no flag,
  //      so treating those as red would light up a population nobody can audit. Same fields,
  //      opposite question, opposite fail-safe direction — quiet when unsure, this change's rule.
  //
  // Together: our own machinery has given up and said so, and the goal carries a check that was
  // chosen for THIS work and that no agent may discharge. That is the founder's "a decision the
  // agent has explicitly escalated as his call".
  //
  // NOTE WHAT THIS DOES *NOT* CLAIM: not that a named person owes the sign-off. `goalVerify` records
  // no person, and self-binding is an advertised path, so a stated `human` is often the agent's own
  // choice. The claim is only that nothing but a human DECISION can close it.
  //
  // ══ TERM 3 IS A *RELEVANCE* JUDGEMENT, NOT AN ACTOR ONE — SAID PLAINLY (roborev 60339) ═══════════
  // The honest statement of the trade-off, because the reviewer is right on the mechanism and the
  // first draft of this comment papered over it. An INHERITED check still BINDS: `owedBinds` reads
  // `verifyStated !== false` (agentGoal), so no agent can discharge it and `agentClosableKind` still
  // answers NO. By the pure actor test, an inherited-and-escalated `human` check IS founder-only, and
  // this term declines to paint it red anyway. That is a deliberate product call, and it costs
  // something real: such a row goes amber and nothing re-raises it (an escalated goal cannot lapse).
  //
  // WHY THE CALL GOES THIS WAY:
  //   • The pure actor test cannot be applied literally without emptying the tier. The concierge's
  //     `verify: null` take-back drops ANY check unconditionally, for both provenances alike — so
  //     "could someone other than the founder clear this" is trivially YES for every goal check ever
  //     written, chosen-here included. Something narrower than the literal test has to decide.
  //   • What separates the two is whether the obligation is about THIS work. An inherited check was
  //     attached to earlier work and carried here by machinery; `send_to_agent_terminal` records
  //     ordinary work goals with no `verify`, so this is the COMMON path. Painting that red tells the
  //     founder "needs your sign-off" about work nobody ever asked him to sign off on — and he cannot
  //     act on it, because the obligation belongs to a goal that is no longer on the row. That is
  //     exactly how red stops meaning anything, which is the failure this whole file is undoing.
  //   • THE MISS IS BOUNDED AND VISIBLE. The row is not silenced: it still reports `escalated-goal`,
  //     still renders the amber tier, still carries the goal chip and the "auto-continue gave up"
  //     mark. It is findable — just not alarm-coloured. `redAttentionTaxonomy.test.ts` pins that
  //     surfacing directly, so this stays a quieter signal rather than decaying into no signal.
  // If a real inherited-sign-off row is ever missed in practice, the fix is to make INHERITANCE carry
  // less (stop manufacturing `human` for unrelated work), not to widen this term — widening it
  // reinstates the false red on the common path.
  const chosenHere = goal?.verifyStated === true && goal.verifyInherited !== true;
  if (
    goalState === "escalated" &&
    goal?.verify !== undefined &&
    chosenHere &&
    !agentClosableKind(goal.verify.kind)
  ) {
    causes.push("human-verified-goal");
  }
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
  //
  // ⚠️ THE COLOUR HALF OF THAT ARGUMENT NO LONGER HOLDS, and this comment used to imply it did
  // (roborev 57759, sparkle-biezi). `expired-goal` is NO LONGER in `stallEscalation.OUTSTANDING`, so
  // it no longer paints the row red. Everything above is still true of THIS surface — the cause is
  // still reported, the verdict is still `stalled`, and the row still renders the amber clock chip
  // and the "ran out of time — never met" badge. What changed is only which SIGNAL carries it.
  //
  // BE HONEST ABOUT WHAT THAT COSTS, because `goalStateOf` is EXCLUSIVE — `unmet` and `expired` never
  // coexist. So at `setAt + ttlMs` exactly, an agent that is genuinely stuck with a clean worktree and
  // no commits stops contributing `unmet-goal` (red) and starts contributing `expired-goal` (amber),
  // with nothing about its work having changed. That is a real de-escalation of the 09:00/09:30 case
  // above, and it is DELIBERATE: the founder's rule of 2026-08-04 is that red is reserved for "a human
  // is blocking this", and a lapsed timer is not that. The row does not go silent — it keeps the chip
  // — it just stops shouting. An agent that expires WITHOUT escalating is one auto-continue never
  // engaged with, and the fix for that belongs in goalContinuation/turn-end authority, not here.
  //
  // ⚠️ THIS PARAGRAPH USED TO END "the channel for 'this genuinely needs a human now' is
  // `escalated-goal`, which is still red". THAT IS NO LONGER TRUE (2026-08-06) and it is corrected
  // here rather than left to narrate retired behaviour. `escalated-goal` left `OUTSTANDING` too: it
  // reports that auto-continue's RETRY BUDGET ran out, which is a fact about our machinery, not a
  // claim that a human is required — the founder measured two escalated rows that needed nothing and
  // were painted red for it. It now routes to the amber `lapsed` tier (engine/stallEscalation
  // LIFECYCLE).
  //
  // ⚠️ AND THE SENTENCE AFTER IT IS NOW WRONG TOO, corrected 2026-08-07 in the same spirit. It read:
  // "There is no cause in this file that means 'a human is required' on its own; the red tier is
  // reached by the WORK causes (`unmet-goal` / `open-pr` / `unlanded-work` / `uncommitted-changes`)".
  // Every one of those WORK causes has since moved to the amber tier — the concierge lands a stranded
  // branch, the agent commits its own worktree, CI clears a PR, auto-continue drives an unmet goal —
  // so none of them is red any more. What replaced them is `human-verified-goal` above, which is
  // exactly the cause that paragraph said did not exist: it means a human is required, on its own,
  // and it is the only member of `OUTSTANDING`. The statuses `statusEngine` derives from the PTY
  // (waiting / approval / errored) are still red and still never pass through here.
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
      case "human-verified-goal":
        // Names the PERSON explicitly, because this is the one sentence on the surface that is
        // asking for something. Every other cause here describes work someone else will do.
        return (
          `its goal can only be closed by a person and nothing is coming to retry it` +
          `${goal?.text ? ` ("${goal.text}")` : ""}`
        );
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

/** Is this row one a human should be told about? True only for a confident stall. `unknown` is
 *  deliberately NOT surfaced as an alarm — see the evidence note at the top of this file. */
export function isStalled(report: StallReport): boolean {
  return report.verdict === "stalled";
}
