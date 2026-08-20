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
import {
  type AgentGoal,
  escalationQuotesStaleText,
  goalStateOf,
  mayRearmGoal,
} from "./agentGoal";
import { SESSION_LIMIT_FALLBACK_MS, type QuotaBlock, isQuotaBlocked } from "./quotaBlock";
import type { HumanBlock } from "./humanBlock";
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
  /** THE AGENT SAID SO ITSELF. `nudge_ladder.rs` asked a silent agent which actor it is waiting on
   *  and it answered `blocked-on-human`, which Rust routed to `Escalation::Founder`. Relayed here by
   *  `engine/humanBlock`, which requires BOTH the reply and the founder target — several
   *  blocked-shaped replies (`no-task-assigned`, `out-of-context`) are deliberately concierge
   *  matters and must not reach this tier.
   *
   *  ⚠️ THIS IS THE ONLY CAUSE SOURCED FROM THE AGENT'S OWN WORDS RATHER THAN FROM GIT OR THE GOAL
   *  RECORD, and that is what makes it narrow enough to be red. It is not inferred from silence, a
   *  clock, or a retry budget: something asked, and it answered. Before it existed the app's only
   *  expression of "a person is blocking me" was free prose in `goal.escalationReason`, which the
   *  colour system cannot read — so a row printed "blocked on human" while drawing amber, which is
   *  the founder's 2026-08-18 report. */
  | "blocked-on-human"
  | "human-verified-goal"
  /** The goal lapsed its whole re-arm budget and git POSITIVELY showed committed work the default
   *  branch does not contain, with no PR carrying it. Sparkle has stopped, cannot restart it, and
   *  nobody else is coming for the branch — so what is left is a disposition call (land it or drop
   *  it) on someone's unfinished work, which is the founder's.
   *
   *  ⚠️ This is the ONLY expiry-shaped cause in the RED tier, and its narrowness is the entire
   *  argument for it — see `engine/goalExpiry.decideExpiry`, which is the only writer of the latch it
   *  reads. Plain `expired-goal` below stays calm gray exactly as it was. */
  | "abandoned-goal"
  /** The goal is escalated AND the concierge has spent its ENTIRE re-arm allowance
   *  (`agentGoal.MAX_CONCIERGE_REARMS`), so no machine actor may restart it again.
   *
   *  ⚠️ ITS COPY ALREADY SAID THIS AND THE COLOUR DID NOT. `rowAttention.goalBadgeFor` renders this
   *  exact state as *"re-armed N× and stuck again — no re-arms left, this one is yours"* — a
   *  sentence addressed to the founder — while the row drew amber, because plain `escalated-goal`
   *  was the only cause it raised. A row that says "yours" and colours "not yours" is the same
   *  text/colour split as {@link blocked-on-human} above, in the app's own copy rather than in an
   *  agent's prose.
   *
   *  WHY RED, in `stallEscalation`'s own terms — who can clear it. Nobody but him: auto-continue has
   *  given up (escalated) and the one machine actor allowed to overrule that has exhausted its
   *  budget. It is strictly narrower than `escalated-goal`, which stays amber: this fires only after
   *  the concierge has tried and run out, so it cannot rebuild the 2026-08-06 wall of false red. */
  | "rearms-exhausted"
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
  /**
   * The agent's own `blocked-on-human` answer to a nudge (engine/humanBlock). `undefined` = it never
   * said so, NEVER "we did not ask" — this is the loudest tier the app has, so absence is silence.
   *
   * PASSED IN, not looked up here, for the same reason {@link quotaBlock} is: it is an observation
   * from the Rust nudger's own ledger rather than git evidence, and this module stays pure.
   */
  humanBlock?: HumanBlock;
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
  // FIRST OF ALL, because it is the only cause here the AGENT ITSELF asserted. Every other cause on
  // this surface is something we inferred about it from git, the goal record or a clock; this one is
  // its answer to a direct question, so it is both the most actionable and the least deniable.
  //
  // NOT GATED ON THE GOAL, deliberately. An agent can be blocked on a person with no goal set at
  // all, with a met goal, or with one nobody escalated — `nudge_ladder` asks every silent agent
  // regardless. Requiring an escalated goal here would have made this cause unreachable for exactly
  // the rows that never got one, which is the population the nudger exists to find.
  //
  // ⚠️ IT *IS* GATED ON STATUS, THOUGH — stated rather than left to be rediscovered (roborev 65339).
  // This sits below the `isQuiet` gate, so a flagged agent whose status is `working` (or absent, and
  // therefore defaulted to `stopped` by every caller) returns `active` and never reaches here.
  //
  // THAT IS DELIBERATE, and the alternative was considered: `quotaBlock` IS hoisted above the gate,
  // because a quota-walled agent keeps redrawing and so reads `working` while being totally barred —
  // its status is actively misleading. This case is different in two ways. First, escalation cannot
  // follow anyway: `stallEscalation.ESCALATABLE` is `idle`/`unmerged` only, so hoisting would change
  // no dot. Second, the flag is self-correcting — `nudger.rs::apply_flags` clears it on the first
  // look where the agent has moved, and an agent whose status reads `working` is one producing
  // output — so the disagreement window closes itself. Reporting `stalled` for a row the app
  // simultaneously calls `working` would put a contradiction into the roster to buy nothing.
  if (input.humanBlock !== undefined) causes.push("blocked-on-human");
  const goalState = goalStateOf(goal, now);
  // NEXT AFTER THE AGENT'S OWN ANSWER, because it is the cause that identifies "the goal can only be
  // closed by a person" — the "awaiting your review-close" state. It led this list until the agent's
  // own `blocked-on-human` answer was added above it. Its TIER moved on 2026-08-18 as well: it is
  // AMBER now, not red (see stallEscalation.LIFECYCLE), because an agent awaiting the founder's
  // sign-off is DONE, not stuck. The detection below is unchanged; only what the cause MEANS to the
  // colour tier changed.
  //
  // ── THE CAUSE THAT IDENTIFIES "AWAITING A HUMAN CLOSE" ───────────────────────────────────────────
  // Both halves must hold, and each on its own is a false signal the founder has already triaged:
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
  // RIDES ALONGSIDE `escalated-goal` rather than replacing it, exactly as `abandoned-goal` does and
  // for the same reason: the amber cause is a FLOOR, so if this red one is ever demoted the row
  // still cannot fall back to calm.
  //
  // GATED ON THE STATE, like every other goal cause here. `mayRearmGoal` reads a spent counter that
  // nothing decrements, so read on its own it would fire forever, in every goal state — including on
  // an agent whose goal was later met. `goalStateOf` answers `met` before `escalated`, so gating on
  // the state lets a re-armed-and-then-finished agent clear itself.
  if (goalState === "escalated" && !mayRearmGoal(goal)) causes.push("rearms-exhausted");
  // READ OFF THE LATCH, not re-derived from evidence. `goalExpiry.decideExpiry` is the sole writer,
  // and it only reaches an abandon after clearing seven gates (expired, local runtime, has a
  // worktree, evidence readable, worktree not parked, budget spent, no open PR, and BOTH the
  // unlanded and not-landed readings agreeing). Recomputing any of that here would be a second copy
  // of a rule whose whole safety property is that it is stated once — and the two copies would
  // disagree in exactly the case that paints a row red by mistake.
  //
  // It rides ALONGSIDE `escalated-goal` rather than replacing it: `abandonGoal` writes through
  // `escalateGoal`, so an abandoned goal is always also escalated. That is deliberate — the amber
  // cause is a FLOOR, so if this red cause is ever demoted the row still cannot fall back to calm.
  //
  // ⚠️ AND IT IS GATED ON THAT STATE STILL HOLDING, which every other goal cause here already is.
  // Read off the raw latch alone, this fired in EVERY goal state, forever, on a point-in-time git
  // reading nothing re-evaluates. The gate fixes ONE of the two false reds it was written for, and
  // the second is stated here rather than implied fixed:
  //
  //   ✅ FIXED — `goalStateOf` returns `met` BEFORE `escalated`, and `markGoalMet` does not clear
  //      `abandonedAt`. So an abandoned agent whose branch is later landed, and whose
  //      `{kind:"landed"}` goal then self-marks met, pushed `abandoned-goal` while `escalated-goal`
  //      was skipped: RED, alone, claiming "it gave up holding work nobody landed" about work that
  //      demonstrably landed — and with the amber floor GONE, so a later demotion would drop the row
  //      straight to calm. Gating on the state follows `markGoalMet`, so this case now clears itself.
  //
  //   ❌ NOT FIXED — the concierge landing the stranded branch. Nothing auto-verifies a
  //      `{kind:"landed"}` goal (`pusherVerifier` says so in terms), the only production writer of
  //      `metAt` is the MCP tool an agent calls about ITSELF, and `escalatedAt`'s only clearer is
  //      `resetGoalRetries`, reachable solely from a human-authored prompt. So when someone else
  //      lands the work and nobody types to the agent, `goalStateOf` keeps answering `escalated` and
  //      the row stays red until a human touches it. Tracked as `sparkle-xv9ge`. The real fix is a
  //      clearer driven by the landed proof, not a second gate here.
  //
  // The latch itself stays as the evidence for WHY this escalation happened.
  if (goalState === "escalated" && goal?.abandonedAt !== undefined) causes.push("abandoned-goal");
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
  // so none of them is red any more. `human-verified-goal` above was briefly the red replacement
  // (2026-08-07) but joined the amber tier on 2026-08-18: an agent awaiting the founder's review-close
  // is DONE, not stuck, so it must not wear the "a human is blocking this" colour. What `OUTSTANDING`
  // holds now is the causes where the agent is genuinely STUCK and he is the only actor —
  // `blocked-on-human` (it said so when asked), `rearms-exhausted` (no machine may restart it) and
  // `abandoned-goal` (it gave up holding work nobody landed). The statuses `statusEngine` derives
  // from the PTY (waiting / approval / errored) are still red and still never pass through here.
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
      case "blocked-on-human":
        // QUOTES THE MECHANISM, not just the conclusion. This sentence is the loudest claim the
        // surface can make about a person, and the reader's first question is "says who" — so it
        // names the fact that the agent was ASKED and answered, which is what separates this from
        // the free prose in `goal.escalationReason` that used to make the same claim unbacked.
        return "it was asked what is blocking it and answered that a person is";
      case "rearms-exhausted":
        return "the concierge has no re-arms left for its goal, so nothing may restart it again";
      case "human-verified-goal":
        // Names the PERSON explicitly, because it is one of the few sentences on this surface that
        // asks HIM for something. It asks CALMLY, though: since 2026-08-18 the cause is amber, so
        // the sentence describes a review-close he owes at his leisure, not a blocker to clear now.
        return (
          `its goal can only be closed by a person and nothing is coming to retry it` +
          `${goal?.text ? ` ("${goal.text}")` : ""}`
        );
      case "abandoned-goal":
        // The EVIDENCE, verbatim, because this is the loudest sentence the surface can say and the
        // reader's first question is "on what basis". `abandonedEvidence` already names the shas and
        // the count, written by the only code that can reach this latch.
        return (
          `it gave up holding work nobody landed` +
          `${goal?.abandonedEvidence ? ` — ${goal.abandonedEvidence}` : ""}`
        );
      case "unmet-goal":
        return `its goal is not met ("${goal?.text ?? ""}")`;
      case "escalated-goal":
        // ⚠️ THE REASON IS SUPPRESSED WHEN IT IS THE ABANDON EVIDENCE, because the two causes ALWAYS
        // coexist (`abandonGoal` writes through `escalateGoal` with the SAME string in both fields)
        // and this detail is attached verbatim to every pill. Unguarded, a reader saw the same
        // ~40-word evidence paragraph twice in one string, and twice per pill. Same "said the same
        // fact twice" defect that folded `unlanded-work` into `open-pr` (roborev 55298); the
        // abandoned-goal arm above already carries the evidence, so this one keeps the short clause.
        if (goal?.abandonedEvidence !== undefined && goal.escalationReason === goal.abandonedEvidence)
          return "auto-continue gave up on its goal";
        // ⚠️ A STALE SENTENCE IS DROPPED HERE TOO (roborev 65339, a Medium). Gating only the goal
        // BADGE's label left this string — the stall chip's tooltip and the composer pill's `detail`
        // — still interpolating the same frozen prose as a live claim, on the same row, about the
        // same escalation. Half a fix reads as a whole one precisely because the surface that still
        // lies is the one nobody re-checked. `escalationQuotesStaleText` is the same predicate the
        // badge uses, asked once here rather than restated.
        if (escalationQuotesStaleText(goal)) return "auto-continue gave up on its goal";
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
