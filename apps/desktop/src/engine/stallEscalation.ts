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
import type { BuildSectionId } from "./buildSections";
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
 * ══ GRAY IS LEGAL ONLY WHERE THE WORK IS EFFECTIVELY FINISHED (the founder, 2026-08-19) ══════════
 *
 * His ruling, verbatim: *"Nothing should ever be gray unless it has been effectively finished. So
 * that would be like a remote merge domain or shipped status. If it's above those statuses, it
 * should never be gray and needs to be pinged with the watcher and the pusher or whatever is
 * required to get it to its final state."*
 *
 * This RESTORES the intent of this file's own header — "GRAY IS A TERMINAL STATE" — which the
 * 2026-08-06 and 2026-08-07 demotions had eroded. Those demotions are not reverted and should not
 * be: each was right about the question it answered (*which* tier a stalled row belongs in). This
 * rule answers a DIFFERENT question, which is why it is a separate floor rather than another edit
 * to {@link OUTSTANDING}.
 *
 * ── WHY A FLOOR AND NOT ANOTHER CAUSE ───────────────────────────────────────────────────────────
 * Every mechanism above it is CAUSE-DRIVEN: something must be detected — a stall verdict, an unmet
 * goal, a spent re-arm budget — before a row leaves the calm tier. That is exactly why the founder's
 * complaint survived all of it. A row resting in a pre-terminal section with NO detected cause is
 * the case the cause-driven path cannot reach by construction, and it is the case he is looking at.
 * So this asks a question no cause can answer: *is this row allowed to look finished at all?*
 *
 * ── WHY `lapsed` AND NOT `blocked` ──────────────────────────────────────────────────────────────
 * Because the token already says the true thing: `lapsed` is AMBER, labelled **"Unfinished, not
 * yours"**. A row this floor catches is unfinished BY DEFINITION (its section is short of the
 * terminal ones) and is demonstrably not the founder's problem (no `OUTSTANDING` cause fired, or it
 * would already be red). Red would re-create the wall this file's entire history is a record of
 * retreating from — 27 of 51 agents in the committed-but-unlanded band — and would page him about
 * rows nobody has claimed need him. Amber is not in the badge or banner set, so this recolours dots
 * without firing a single notification.
 *
 * ── THE ESCAPE HATCH, stated now so it is not rediscovered as a wall of amber ────────────────────
 * If this proves too loud, the cut is {@link GRAY_LEGAL_SECTIONS} — adding `remote_pr` and
 * `remote_pushed` to it confines the floor to genuinely local work, in one line, with no other file
 * involved. Do NOT instead narrow {@link GRAY_STATUSES}: `unmerged` and `idle` are the two the
 * founder is actually looking at, so removing either silently un-fixes the complaint.
 */
export const GRAY_LEGAL_SECTIONS: ReadonlySet<BuildSectionId> = new Set<BuildSectionId>([
  "remote_merged",
  "remote_shipped",
]);

/**
 * Every status that renders GRAY, per `packages/ui/tokens.ts`: "nothing is stopping you".
 *
 * Kept as an explicit set, and DELIBERATELY WIDER than {@link ESCALATABLE}. That set is the calm
 * tier a *stall* may escalate, and it excludes `done`/`stopped` because a dead PTY must never be
 * told it "needs you to unstick it". This floor makes no such claim — amber says the opposite, that
 * the row is NOT yours — so a finished-but-unlanded `done` row is exactly the population the
 * founder's rule is about, and excluding it here would leave his complaint half-fixed.
 *
 * `new` is in the set for completeness but is unreachable in practice, and that falls out of the
 * evidence rule in {@link grayFloorFor} rather than from an exemption: an unbriefed agent has no
 * stage reading, so it has no section, so the floor declines to touch it. That keeps
 * `engine/newAgentAttention`'s "spawned but never briefed is the ABSENCE of an alarm" intact by
 * construction — the same way {@link ESCALATABLE}'s own comment keeps it.
 */
export const GRAY_STATUSES: ReadonlySet<AgentTabStatus> = new Set<AgentTabStatus>([
  "idle",
  "unmerged",
  "done",
  "stopped",
  "new",
]);

/**
 * The status a row must be repainted to so it does not render gray outside a terminal section, or
 * `undefined` to leave it exactly as it is.
 *
 * EVIDENCE, NOT INFERENCE — an `undefined` section leaves the row alone. That is the same principle
 * {@link escalationFor} applies to an `unknown` stall verdict, and it is load-bearing twice over:
 * it is what keeps a brand-new agent calm (see {@link GRAY_STATUSES}), and it is what stops a window
 * that has not read git state from repainting the whole fleet amber on its own ignorance.
 */
export function grayFloorFor(
  status: AgentTabStatus | undefined,
  section: BuildSectionId | undefined,
): AgentTabStatus | undefined {
  if (status === undefined || !GRAY_STATUSES.has(status)) return undefined;
  if (section === undefined) return undefined;
  if (GRAY_LEGAL_SECTIONS.has(section)) return undefined;
  return LAPSED_STATUS;
}

/**
 * What a LIFECYCLE-only row is escalated to instead. Amber, "Auto-continue stopped", no badge, no
 * banner, and NOT in `windowStatus.isRedStatus`.
 *
 * The whole reason there are two escalation targets: the founder, on two rows that owed nothing —
 * *"why are they red when they don't require my assistance?"* See {@link LIFECYCLE} and the token's
 * own comment in packages/ui/tokens.ts.
 */
export const LAPSED_STATUS: AgentTabStatus = "lapsed";

/**
 * The causes that mean "THE FOUNDER IS THE ONLY ACTOR WHO CAN UNBLOCK THIS, AND THE WORK IS STUCK".
 *
 * Kept as an explicit set rather than "any cause at all" so that adding a new cause to `agentStall`
 * forces a decision here about whether it belongs in the red tier, instead of silently recolouring
 * rows.
 *
 * ══ THE TEST IS A QUESTION WITH AN ANSWER, AND IT HAS TWO HALVES ════════════════════════════════
 * Membership requires BOTH: only the founder can clear it, AND the agent is genuinely stuck. The
 * members below — `blocked-on-human`, `rearms-exhausted`, `abandoned-goal` — each satisfy both.
 * `human-verified-goal` was the founder's red cause from 2026-08-07 until 2026-08-18, when he
 * refined the rule (see the `human-verified-goal` block further down): "only I can close it" is not
 * enough on its own — the WORK also has to be stuck. An agent awaiting his review-close is done, not
 * stuck, so it is amber now. What follows is the derivation that established the first half.
 * This set used to read `unmet-goal` / `open-pr` / `unlanded-work` / `uncommitted-changes`, on the
 * rule "work that EXISTS and that nothing is coming to finish". That rule turned out to be the wrong
 * question, and the founder answered it directly after triaging red rows that needed nothing from him
 * at least six separate times in one day: *"Why are all these agents red? They don't seem to need
 * anything from me."* — *"Why is Cloud Gate Dead End showing as red?"* — *"When it doesn't need
 * anything from me."*
 *
 * The right question is not *is work outstanding* but **who can clear it**:
 *
 *   • `unlanded-work` — THE CONCIERGE DOES THIS ALONE, and did, for 15 branches in one night. 'Cloud
 *     Gate Dead End' — the row he named — was red for a single stranded commit with no PR; pushing
 *     the branch, opening #1509 and merging it when green resolved it, and he was required at no
 *     step of that.
 *   • `uncommitted-changes` — the AGENT commits or discards its own worktree. He never does.
 *   • `open-pr` — CI or a reviewer clears it. Not his to press.
 *   • `unmet-goal` — the agent's own work is unfinished, and finishing it is the AGENT's job. It is
 *     also the state auto-continue is defined over (`hasUnmetGoal` gates the retry budget and is
 *     true for exactly it), so the machinery may well be driving it.
 *
 *     ⚠️ BUT DO NOT REST THE DEMOTION ON THAT SECOND SENTENCE — an earlier draft did, and it is not
 *     sound (roborev 60322). Auto-continue only runs where there is turn-end authority; an agent
 *     that stalls in a window without it is never continued AND never escalated, so it can sit
 *     `unmet` with nothing actually driving it (the 09:00/09:30 case `agentStall` describes at
 *     length). The demotion rests on the FIRST sentence, which holds either way: whether or not a
 *     retry is coming, the founder is not the actor — he cannot finish the agent's work for it, and
 *     an unmet goal asks him for nothing. If nothing is driving it, the defect is in
 *     goalContinuation/turn-end authority, and painting the row red neither fixes that nor tells
 *     him anything he can act on.
 *
 * All four are lifecycle bookkeeping, so all four moved to {@link LIFECYCLE}. What is left is the set
 * of causes where the answer is genuinely "nobody but him AND the work is STUCK". `abandoned-goal` is
 * the archetype — auto-continue has stopped AND git shows committed work nobody landed with no PR
 * carrying it, so the only thing left is a disposition call on an unfinished branch. See its
 * derivation in `agentStall`; `blocked-on-human` and `rearms-exhausted` joined it on 2026-08-18 and
 * carry their own derivations in the set below.
 *
 * ══ `human-verified-goal` LEFT THIS TIER ON 2026-08-18 — "AWAITING REVIEW-CLOSE" IS NOT "STUCK" ═══
 * It was the founder's own red cause on 2026-08-07 ("a decision the agent has explicitly escalated as
 * his call"), and he refined that instruction on 2026-08-18: a red dot is the signal he PHYSICALLY
 * acts on — he goes and checks every one — so red must mean the agent is STUCK and only he can
 * unblock it. An agent whose work is COMPLETE and is merely awaiting his verification/close is not
 * stuck: it self-reports not-blocked, "no command or permission is needed from me". The GOAL is
 * human-closeable, but the AGENT needs nothing to proceed — there is nothing to unblock, only a
 * review-close to do eventually. Painting that red trains him to expect a blocker and find a finished
 * agent, which is exactly how a red dot stops meaning anything.
 *
 * So it moved to {@link LIFECYCLE} (amber `lapsed`), which bands into `done` — off the `needs_you`
 * count and out of the alarm colour. It is NOT silenced: the cause is still raised (agentStall), the
 * row still carries the "awaiting your sign-off" chip and its own detail, so he can still find and
 * close it. The boundary is exactly "the AGENT needs nothing from me but the GOAL is human-closeable"
 * (amber) versus "the agent CANNOT proceed without me" (red). `redAttentionTaxonomy.test.ts` pins it.
 *
 * THE COST OF GETTING THIS WRONG IS NOT THE CLICKS. It is that a red row stops meaning anything, and
 * a genuine blocker then hides among the false ones. That is why the bar for membership here is the
 * strongest claim the app can make, not merely a true one.
 *
 * ⚠️ THE OPPOSITE FAILURE IS THE MORE EXPENSIVE ONE, and nothing above weakens it. Sparkle's standing
 * rule is never to hide a row that needs the founder. Three things hold it:
 *   • The genuinely-red STATUSES never pass through this module at all — `waiting`, `approval` and
 *     `errored` are derived by `statusEngine` from the PTY and are not in {@link ESCALATABLE}, so an
 *     unanswered question or a permission prompt is untouched by every line here.
 *   • `OUTSTANDING` is still tested FIRST in {@link escalationFor}, so a row that owes him a verdict
 *     stays red however much amber bookkeeping sits beside it.
 *   • `redAttentionTaxonomy.test.ts` pins BOTH directions per cause by name, and makes an
 *     unclassified new cause a type error.
 *
 * ── `expired-goal` AND `escalated-goal` ARE BOTH DELIBERATELY ABSENT — BUT NOT TO THE SAME PLACE. ─
 * `expired-goal` left first (sparkle-biezi, the argument below) and is in NEITHER set: it renders
 * calm gray, which already satisfies "not red". `escalated-goal` left on 2026-08-06 for the same
 * reason one notch further and went to {@link LIFECYCLE}, which paints AMBER. Read LIFECYCLE for why
 * the two were separated; what follows is the original expiry argument — the derivation that the
 * four work causes above eventually followed to the same place.
 *
 * ── EXPIRY IS NOT AN ALARM. ──────────────────────────────────────────────────────────────────────
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
 * one layer up, and now also in {@link LIFECYCLE}'s own amber tier.
 */
const OUTSTANDING: ReadonlySet<StallCause> = new Set<StallCause>([
  // ── THE AGENT'S OWN ANSWER, ADDED 2026-08-18 ────────────────────────────────────────────────────
  // The founder, on a row reading blocked-on-human while drawing amber: *"It seems like this should
  // be a red dot so that seems problematic that it's not showing as red when it says it's blocked on
  // human."*
  //
  // It passes this set's bar — "who can clear it" — as directly as any cause ever will: `nudge_ladder`
  // asked the agent which actor it is waiting on, and it named a person. Nothing here is inferred
  // from silence, a clock or a retry budget, which is what keeps it from re-reddening the population
  // the 2026-08-06 demotion cleared. `escalated-goal` below is untouched and still amber.
  //
  // ⚠️ IT IS NOT A REPLACEMENT FOR `human-verified-goal` — the two ask different questions, and only
  // this one is red. That cause reads the GOAL RECORD: a stated check no agent may discharge, which
  // says the goal is his to CLOSE, not that the agent is stuck (it left this tier the same day; see
  // the block below). This one reads the AGENT: it says it is stuck on a person, whatever its goal
  // says. That is a blocker on its own, and it is the distinction the whole tier now turns on.
  //
  // ⚠️ WHY THE STALE RULE DOES NOT VETO IT (the founder's second instruction, same day: a stale
  // escalation must never be red). Staleness is a property of `goal.escalationReason` — a frozen
  // SENTENCE that `chargeGoalDebt` carries onto later goal text, so it outlives what it describes and
  // `escalationQuotesStaleText` exists to say so. A nudger flag cannot acquire that property:
  // `nudger.rs::apply_flags` clears it on the first look where the agent has moved, so a live flag
  // means the agent is still silent and still standing on this answer. The veto belongs on the prose
  // path — see `rowAttention.goalBadgeFor`, which no longer renders a stale sentence as a live claim.
  "blocked-on-human",
  // ── THE STATE WHOSE COPY ALREADY SAID "YOURS" ───────────────────────────────────────────────────
  // An escalated goal whose concierge re-arm allowance is entirely spent. `goalBadgeFor` renders it
  // as "re-armed N× and stuck again — no re-arms left, this one is yours" and the row drew amber
  // anyway, because plain `escalated-goal` was the only cause raised. Strictly narrower than that
  // cause — it fires only AFTER the concierge tried and ran out — so the machine actor this tier
  // asks about has demonstrably been exhausted rather than merely assumed absent.
  "rearms-exhausted",
  // ── `human-verified-goal` IS DELIBERATELY ABSENT (LEFT 2026-08-18) ──────────────────────────────
  // It sat here from 2026-08-07 and moved to {@link LIFECYCLE}. Do not add it back to "fix" a report
  // that an awaiting-sign-off row is not red: that is the fix. The derivation is in this docblock
  // and its own comment in LIFECYCLE; `redAttentionTaxonomy.test.ts` pins the absence by name.
  // ── `abandoned-goal` IS THE "OWN CHANGE WITH ITS OWN EVIDENCE" THE EXPIRY ARGUMENT INVITES ──────
  // The block above ends "If expiry ever needs to be louder, that is its own change with its own
  // evidence." This is it, and it is NOT a promotion of `expired-goal` — that cause is untouched and
  // still in neither set. The distinction is exactly the one the expiry argument turns on: expiry is
  // a fact about the CLOCK and fires on a finished agent and an abandoned one identically, which is
  // what made it a wall of false red. This cause is a fact about the WORK, and it can only be
  // written after `goalExpiry.decideExpiry` clears seven gates — expired, local runtime, has a
  // worktree, evidence readable, worktree not parked, re-arm budget spent, no open PR, and BOTH the
  // "unlanded" and "not landed" readings agreeing. A finished agent cannot reach it by construction:
  // clean + landed is discharged three rules earlier.
  //
  // WHY RED RATHER THAN THE AMBER TIER, in this file's own terms — who can clear it. Nobody. Sparkle
  // has stopped (the budget is spent and the goal is escalated, so nothing retries it), the agent is
  // not going to restart itself, and no PR is carrying the work. What remains is a disposition call
  // on somebody's unfinished branch — land it or drop it — and that is the founder's, which is the
  // definition this tier is built on.
  //
  // ⚠️ ITS DEMOTION TRIGGER, stated now so it is not rediscovered as a false red later: the day the
  // concierge is wired to auto-land or auto-triage abandoned branches, this cause has an actor other
  // than the founder and belongs in LIFECYCLE. The reason `unlanded-work` is amber is precisely that
  // the concierge already landed 15 stranded branches in one night without him.
  "abandoned-goal",
]);

/**
 * The causes ANOTHER ACTOR CAN CLEAR — the concierge, the agent itself, CI, or auto-continue.
 *
 * Amber. Not calm (the work is real and a reader should see it) and not red (the agent is not stuck
 * on him). This is where every cause lands that is not in the red set above.
 *
 * ── IT WAS ONE MEMBER UNTIL 2026-08-07 ───────────────────────────────────────────────────────────
 * It held only `escalated-goal`, and the distinction drawn was "a fact about the WORK" (red) versus
 * "a fact about Sparkle's retry budget" (amber). That line was too narrow: it moved the one cause
 * the founder had named that week and left four behind, so he kept triaging red rows that needed
 * nothing. `unmet-goal`, `open-pr`, `unlanded-work` and `uncommitted-changes` joined it — see
 * {@link OUTSTANDING} for who clears each one, which is the question that decides membership now.
 *
 * A cause here still says the row is NOT FINISHED. It says only that finishing it is not his job.
 *
 * ⚠️ `expired-goal` IS DELIBERATELY NOT HERE, and it WAS in the first cut of this change — so if you
 * are reading this because the set looks like it is missing one, it is not. Expiry is already calm
 * gray by the sparkle-biezi decision above, and gray already satisfies the founder's rule that red
 * is reserved for "a human is blocking this"; his 2026-08-06 answer said expiry must not be RED,
 * which was already true of it. Promoting it would relitigate a settled decision AND it is the
 * higher-volume cause — every agent that outlives its TTL earns one — so the tier that exists to
 * stop a wall of false red would have started building a wall of amber. `escalated-goal` is both the
 * narrower signal and the one he actually reported. If expiry ever needs to be louder, that is its
 * own change with its own evidence.
 *
 * ── WHY `escalated-goal` MOVED HERE (2026-08-06) ─────────────────────────────────────────────────
 * It was in `OUTSTANDING`, so an escalated row was repainted RED. The founder spent a day triaging
 * rows that needed nothing and asked, verbatim: *"why are they red when they don't require my
 * assistance?"* The two rows in his screenshot had spotless worktrees and every PR they owned
 * merged — and both wore the loudest signal the app has. That is how real red stops meaning
 * anything, which costs more than every stall this module was commissioned to surface.
 *
 * `expired-goal` had already been cut from `OUTSTANDING` for exactly this reason (sparkle-biezi);
 * the argument above it is the derivation. Escalation is one notch further along the same line: a
 * retry budget is even more clearly OUR machinery's business than a clock is.
 *
 * ── RED WINS OVER AMBER, AND THAT IS THE SAFETY PROPERTY ─────────────────────────────────────────
 * `withStallAttention` tests `OUTSTANDING` FIRST, so a row that owes the founder a verdict stays RED
 * however much of this set is also true of it. The ordering is what keeps making rows less red from
 * silencing a real one — the opposite failure, and the more expensive one.
 *
 * (That sentence used to run the other way — "an agent that gave up AND still holds unlanded work
 * stays RED, on the strength of the WORK" — which stopped being true when the work causes moved
 * here. Same ordering, same guarantee; what changed is which cause is doing the outranking.)
 *
 * The same ordering is mirrored one component out, in `components/rowAttention.STALL_CAUSE_RANK`,
 * so the row's single glyph leads with a work cause too. Keep the two in step. (It lived in
 * `components/agentNotices` until roborev 65642 moved it beside `STALL_CAUSE_LABEL`, because a
 * third reader — `rowAttention.stallChipFor` — needed it and the other direction was an import
 * cycle. Following this pointer to a file with no such map is what invites a local copy of the
 * partition, which is the drift `agentNotices.test.ts` documents at length.)
 */
const LIFECYCLE: ReadonlySet<StallCause> = new Set<StallCause>([
  // ── `human-verified-goal` JOINED HERE 2026-08-18 — "awaiting your review-close", not "stuck" ────
  // The founder's refined rule (see {@link OUTSTANDING}): a red dot means the agent is STUCK and only
  // he can unblock it, because he physically checks every one. An agent whose work is done and is only
  // awaiting his verification/close needs nothing to proceed — the GOAL is human-closeable, but the
  // AGENT is not blocked. So it is amber, not red: it bands into `done` (off the `needs_you` count),
  // while the raised cause keeps its "awaiting your sign-off" chip so he can still find and close it.
  //
  // It is NOT calm gray, and that is deliberate: gray is the terminal "shipped" state, and this row
  // still owes a review-close. Amber "the machinery stopped, someone acts next" is the honest read —
  // the someone here is him, at his leisure, not a blocker he must clear now.
  "human-verified-goal",
  // ── `awaiting-close` (2026-08-20) — AMBER, AND NEVER `OUTSTANDING` ──────────────────────────────
  // Strictly calmer than `human-verified-goal` directly above, for the same reason and with more
  // evidence behind it: that cause says "only a person may close this goal", while this one adds
  // that GIT ALREADY PROVED THE WORK SHIPPED for it. If awaiting a review-close is not "stuck",
  // awaiting a close on demonstrably-merged work certainly is not.
  //
  // ⚠️ IT IS ALSO WHAT DEMOTES A `blocked-on-human` ANSWER, so read this beside `OUTSTANDING`. The
  // agent's own reply is the app's loudest signal and stays red everywhere else; `agentStall`
  // re-reads it as THIS cause only for a row in `agentGoal`'s `awaiting_close` state. Adding this
  // token to `OUTSTANDING` would therefore not merely re-redden one row — it would silently undo
  // that demotion and restore the exact false red the state was introduced to remove.
  //
  // NOT CALM GRAY EITHER, on `human-verified-goal`'s argument: gray is the terminal "shipped and
  // closed" state, and this row still owes a close. Amber — "the machinery stopped, someone acts
  // next" — is the honest read, and the someone is him, at his leisure.
  "awaiting-close",
  "escalated-goal",
  "unmet-goal",
  "open-pr",
  "unlanded-work",
  "uncommitted-changes",
]);

/** Does this report describe a row that must not render calm? True for BOTH tiers — red and amber.
 *
 *  Callers that need to know WHICH tier want {@link escalationFor}; this predicate answers only
 *  "may this row stay gray", which is what the founder's original rule ("gray is a terminal state")
 *  is about. */
export function mustLeaveCalm(report: StallReport | undefined): boolean {
  return escalationFor(report) !== undefined;
}

/**
 * The status a calm row is repainted to, or `undefined` to leave it alone.
 *
 * RED FIRST, deliberately — see {@link LIFECYCLE}. A row with any `OUTSTANDING` cause is `blocked`
 * exactly as it was before this tier existed, whatever else is also true of it; only a row whose
 * ONLY causes are lifecycle facts drops to the amber `lapsed`.
 */
export function escalationFor(report: StallReport | undefined): AgentTabStatus | undefined {
  if (report === undefined) return undefined;
  // `unknown` is deliberately NOT escalated. It means "we did not read the git state", and a red dot
  // on missing evidence is the false alarm that trains the human to ignore the colour — the same
  // reason `agentStall.isStalled` is false for it. Evidence, not inference.
  if (report.verdict !== "stalled") return undefined;
  if (report.causes.some((c) => OUTSTANDING.has(c))) return ESCALATED_STATUS;
  if (report.causes.some((c) => LIFECYCLE.has(c))) return LAPSED_STATUS;
  return undefined;
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
    // …UNLESS THE AGENT ITSELF SAID A PERSON IS BLOCKING IT (2026-08-18). The refusal above is about
    // an INFERENCE: this module guesses "stalled" from a resting status, and delegation is work the
    // parent is not doing itself, so the guess is wrong for a head whose workers are grinding.
    // `blocked-on-human` is not a guess — `nudge_ladder` asked the agent what was blocking it and it
    // named a person. A busy subtree does not discharge that: an orchestrator can be waiting on a
    // decision from the founder while every worker under it runs, and on this fleet the heads most
    // likely to be blocked on him are exactly the ones with workers. Vetoing on motion would have
    // made the whole fix unreachable for orchestrators, silently — the row would stay amber with
    // nothing to indicate the signal had been dropped.
    //
    // NARROW ON PURPOSE: it is this ONE cause, not the whole red tier. `abandoned-goal` (red) and
    // `human-verified-goal` (amber since 2026-08-18) are still DERIVED facts about the goal record,
    // so a working subtree is still a good reason to hold off on them, and `roborev 55423/55434`'s
    // protection is untouched for every cause it was written about.
    const report = reportOf(a.id);
    const saidHumanBlocked = report?.causes.includes("blocked-on-human") === true;
    if (!saidHumanBlocked && isInMotion(a.id, agents, statusMap)) continue;
    // WHICH tier, not just whether. RED FIRST — a row with outstanding WORK is `blocked` even when
    // auto-continue also gave up on it; only a row whose sole causes are lifecycle facts goes amber.
    // See LIFECYCLE for why that ordering is the safety property of this whole change.
    const to = escalationFor(report);
    if (to === undefined) continue;
    ensure()[a.id] = to;
  }
  return out ?? statusMap;
}

/**
 * The status whose COLOUR a row should RENDER, given its own status and its build section — or
 * `undefined` to render exactly what it already has.
 *
 * ══ RECOLOUR, NEVER REPLACE — AND THAT DISTINCTION IS THE WHOLE DESIGN ═══════════════════════════
 *
 * The first cut of this rule was a map overlay that rewrote `unmerged` → `lapsed` in the published
 * status map. It was WRONG, and wrong in a way this repo had already paid for once (roborev 53886,
 * recorded on `workerRollup.ts`): `withUnmergedWork` writes `unmerged` ONLY for stages in
 * `[building_saved, merged)`, and every one of those maps to a pre-terminal section — so the overlay
 * floored EVERY `unmerged` row and made the value effectively unreachable downstream. A dozen live
 * consumers key on that literal and would all have silently read zero: the "Needs merge" label
 * (`WorkerPeek`), `isOwedAction` / `accountedUnmerged` / `owedCounts.unmerged` (`conciergeFeed`),
 * the digest's `unmerged` variant, `workerExpansion.isOwedAsk`, and BOTH of `workerRollup`'s locks.
 *
 * The status VALUE carries semantics other systems depend on. Only its COLOUR is what the founder
 * was looking at. So this returns a status to PAINT WITH and never touches the map: nothing
 * downstream can lose a fact it was relying on.
 *
 * ── THE RULE (the founder, 2026-08-19) ──────────────────────────────────────────────────────────
 * *"Nothing should ever be gray unless it has been effectively finished. So that would be like a
 * remote merge domain or shipped status. If it's above those statuses, it should never be gray."*
 *
 * ── WHY `lapsed` IS THE PAINT ───────────────────────────────────────────────────────────────────
 * Its token already says the true thing — AMBER, labelled "Unfinished, not yours". A row this
 * catches is unfinished by definition (its section is short of the terminal pair) and is not the
 * founder's to act on, or a cause would already have reddened it. Amber is deliberately outside the
 * badge and banner sets, so this recolours dots without firing one notification.
 *
 * ── EVIDENCE, NOT INFERENCE ─────────────────────────────────────────────────────────────────────
 * An `undefined` section renders unchanged. `resolveStage` FLOORS at the first rung rather than
 * returning `undefined`, so a caller that routed through it would manufacture a pre-terminal section
 * for a row nobody polled and paint the fleet amber on its own ignorance. This is also what keeps a
 * brand-new agent calm without an exemption written for it.
 */
export function displayStatusFor(
  status: AgentTabStatus | undefined,
  section: BuildSectionId | undefined,
): AgentTabStatus | undefined {
  return grayFloorFor(status, section);
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
    // BOTH TIERS THIS MODULE PRODUCES, not just the red one. An amber `lapsed` row is acknowledgeable
    // exactly like an escalated `blocked` row — `alertDismissal.AlertingStatus` includes it, and
    // `withDismissedAlerts` deliberately does NOT (it would flatten the row to `idle` and lose the
    // band it came from), so this pass is the only thing that can hand a dismissed amber row back.
    const escalated = escalatedMap[a.id];
    if (escalated !== ESCALATED_STATUS && escalated !== LAPSED_STATUS) continue;
    // Only a row THIS pass escalated: an agent whose own status is genuinely `blocked` (statusEngine's
    // stall timer, improvementPass) is not ours to restore, and `calmMap` would say `blocked` for it
    // anyway, so the guard is about intent rather than about the value. Compared against the row's
    // OWN escalated value rather than the constant, so the same reasoning covers the amber tier.
    const calm = calmMap[a.id];
    if (calm === undefined || calm === escalated) continue;
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
    if (a.alert?.lastRed !== escalated) continue;
    if (!isAlertSuppressed(a.alert, escalated)) continue;
    ensure()[a.id] = calm;
  }
  return out ?? escalatedMap;
}
