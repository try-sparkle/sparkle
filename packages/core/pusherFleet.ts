// THE CONDITIONS A PARTNER CANNOT BE TOLD ABOUT — and why they are reported as ONE message
// about the fleet rather than as a challenge to each agent.
//
// ── WHAT THIS CLOSES ─────────────────────────────────────────────────────────────────────────────
// Two agents sat quota-blocked for hours and eight goals sat escalated, and the founder found all of
// them by looking at a screenshot. His words: *"This is the kind of thing I would expect a pusher to
// be noticing and servicing to you instead of me."* Every one of those states was already DETECTED —
// `agentStall` returns the `quota-blocked` verdict with the verbatim banner, `goalStateOf` returns
// `escalated`, `goalMetAt` is latched — and none of them was AGGREGATED. Detection that only paints a
// row is detection the human has to go and read.
//
// ── WHY THESE THREE CANNOT USE `pusherTriggers` ──────────────────────────────────────────────────
// The Phase 1 triggers all share a shape this one breaks: they describe something the PARTNER can
// act on, so the challenge goes to the partner. These do not.
//
//   • QUOTA-BLOCKED. The partner cannot execute anything at all until a wall-clock time — that is
//     what `agentStall` means by calling it the most total block the app can encounter. A message
//     into its inbox is not merely unread, it is unreadable, and it consumes one of the
//     `MAX_PER_AGENT` slots the concierge may need later. Telling the agent is strictly negative.
//   • ESCALATED. `decideContinuation` answers `already-escalated` with `{action:"none"}` and the
//     control surface refuses a Pusher's goal write by design (`mayWriteGoalFor`). The app RESERVES
//     an escalated goal for the human. So the one party who can clear it is the one party the
//     per-partner channel does not reach.
//   • DONE-BUT-OPEN. There is nothing to ask a finished agent to do. The action is to retire it,
//     which is somebody else's authority — a Pusher may never close its partner's goal.
//   • SHARED FAILURE. N agents killed by ONE event — a host sleeping or restarting takes every local
//     agent with it. Each victim's row says "errored" on its own, so the one fact worth knowing (that
//     it is a single cause) exists nowhere until something aggregates it. Telling each victim is both
//     useless and N times the noise.
//
// So the recipient is different, and once the recipient is different the batching follows: eight
// separate nudges about eight escalated goals is exactly the noise `MESSAGES_PER_HOUR` exists to
// prevent. One report, one slot, one glance.
//
// ── THE CITATION RULE, AND THE ONE PLACE IT IS WIDENED ───────────────────────────────────────────
// `pusherGate` refuses any number in the text that is not in `measured`. These conditions quote
// strings the Pusher did not compute — a limit banner, an escalation reason, an agent's name — and
// those strings contain numbers. `quotedNumbers` puts them in `measured`.
//
// That is a widening and it needs to be named as such. What justifies it: QUOTING IS NOT COMPUTING.
// The rule exists to stop a Pusher inventing a measurement, and a verbatim quote invents nothing —
// the numbers in it are facts about the string the agent actually printed. What it does NOT do is
// whitelist arithmetic: a number that appears in neither the quoted strings nor the counts is still
// refused, which is the property the tests pin. The set only ever grows by material the report
// reproduces character-for-character.
//
// ── VERBATIM IS LOAD-BEARING FOR THE RESET TIME ──────────────────────────────────────────────────
// `quotaBlock.QuotaBlock.message` is documented as verbatim because *"it is the only place the reset
// time and the remedy path appear"*. This module inherits that: the report quotes the banner rather
// than reformatting `resetAt`, so the founder reads the same sentence the agent read. And it quotes
// it ONLY when `resetParsed` is true — an unparsed reset means `resetAt` is a bounded-backoff
// fallback, and presenting a guess in the register of a measurement is the exact failure the
// citation rule exists to prevent.
//
// ── NO MODEL CALL. THIS IS NOT AN OPTIMISATION, IT IS THE REASON THIS WORKS AT ALL ───────────────
// The report is a template, like every Phase 1 challenge — see `pusherPolicy`'s note on why the
// budgeted Haiku call was removed and why there is no `model` key.
//
// That decision is what makes this feature function in the case it was built for. `claude_oneshot`
// shells out to the user's OWN authenticated `claude` CLI: it never passes `--bare` (which would
// force API-key auth), so it runs on the subscription login, and its own header says these children
// compete "with the user's REAL build agents for the SAME subscription rate limit". It has a
// `claude_usage_limit` classification for exactly this. `--model claude-haiku-4-5` selects a cheaper
// model; it does not select a different account, and a weekly limit is an ACCOUNT limit.
//
// So a Pusher that composed this report with a model call would be dead precisely when the fleet is
// quota-blocked — useless at the only moment it is most needed. A Pusher that builds it from
// arithmetic and verbatim quotes is not, because nothing in this file needs a model to run.
//
// ── PURE ────────────────────────────────────────────────────────────────────────────────────────
// No clock (callers pass `now`), no store, no I/O, no model.

import { numbersIn } from "./pusherGate";
import { splitHoursMinutes } from "./pusherTriggers";

/** The fleet-level conditions a Phase 1 Pusher may report. */
export type FleetConditionId =
  /** Agents held behind an account limit — cannot run at all, and cannot be restarted into running. */
  | "quota-blocked"
  /** Several agents killed by ONE event — same error, same moment. N victims, not N failures. */
  | "shared-failure"
  /** Its session ended with the goal unmet and uncommitted work still in the worktree. */
  | "died-holding-work"
  /** Goals auto-continue gave up on. Reserved for the human by design, so a dead end until seen. */
  | "goals-escalated"
  /** Messages queued for a concierge with nothing running to take them. Stacking, not progressing. */
  | "queue-unfanned"
  /** A standing recurring duty that has silently stopped running. */
  | "duty-overdue"
  /** An open PR that cannot merge — and therefore has never run CI at all. */
  | "pr-conflicting"
  /** Goal met, nothing unlanded — occupying a slot for no reason. */
  | "done-not-retired";

/**
 * Something the app has promised to do on a schedule — the hourly improvement pass, and anything
 * else that acquires a standing cadence later.
 *
 * ── WHY THIS IS NOT A PER-AGENT CONDITION ────────────────────────────────────────────────────────
 * Every other class here is about an agent. This one is about a CAPABILITY, and it is the only case
 * where nothing looks wrong anywhere: every agent is fine, every row is its normal colour, and a
 * thing the product promises simply is not happening. The founder found it the way you find all
 * invisible failures — by asking, and being told "nothing, for hours".
 */
export interface StandingDuty {
  /** What it is, in the user's words. Quoted verbatim, so its numbers are whitelisted. */
  name: string;
  /** How often it is supposed to run. */
  intervalMs: number;
  /**
   * When it last actually ran.
   *
   * `undefined` is NOT LOOKED and never fires — the fail-closed rule. It is also what an unseeded
   * scheduler reads as, and a duty that has never had a clock is not yet overdue.
   */
  lastRunAt?: number;
  /**
   * Why it is being held right now, if anything is holding it — quoted verbatim in the report.
   *
   * This is the half that makes the condition actionable rather than merely alarming. "The hourly
   * pass has not run for nine hours" sends someone hunting; "…because the Sparkle pane reads
   * working" names the thing to fix.
   */
  heldBy?: string;
}

/**
 * Missed intervals before a duty is called overdue.
 *
 * Not one: a single missed slot is ordinary. The pass legitimately skips a slot when the machine is
 * offline, when a pass is still running, or when the pane is briefly busy, and reporting each of
 * those would be exactly the tune-out the two-observation rule exists to prevent. Two consecutive
 * misses is a pattern rather than a skip.
 */
export const DUTY_OVERDUE_FACTOR = 2;

/**
 * HOW the producer knows a conflicting PR is untested — the complete value set of Rust's
 * `ConflictFlag.evidence` (`conflict_ladder::untested_evidence`), which is the only field that tells
 * a reading taken NOW from one inherited or never taken at all.
 *
 * The three-way rule the producer's own doc states, and the one {@link conflictCondition} follows:
 *   * FIRST-HAND now — `no-checks-ran`, `checks-are-stale`, `n/a`.
 *   * A REAL VERDICT, not read this look — `last-known`, `last-known-unconfirmed`. Act on it; say it
 *     is not current. Never silently drop it.
 *   * NO CONFIRMABLE VERDICT for this commit — `unknown`. Still not an empty row: `kind` may be
 *     inherited from a real earlier reading, so it licenses "we cannot vouch for this verdict",
 *     never "there is no verdict".
 */
export type ConflictEvidence =
  | "no-checks-ran"
  | "checks-are-stale"
  | "last-known"
  | "last-known-unconfirmed"
  | "unknown"
  | "n/a";

/**
 * One open pull request that cannot merge, or can but is drifting.
 *
 * ── WHAT NOTHING WAS WATCHING ────────────────────────────────────────────────────────────────────
 * A PR goes DIRTY and simply sits there. Five did: ~220 commits behind main, each carrying exactly
 * one commit of work — every one of them a rebase somebody could have done in a minute, and none of
 * them visible on any surface the founder looks at. An agent's row says nothing, because the agent
 * is fine; the PR page says "conflicts", which reads as a merge chore.
 *
 * ── AND WHY "CONFLICTS" IS THE WRONG WORD FOR IT ─────────────────────────────────────────────────
 * A CONFLICTING PR NEVER FIRES GITHUB'S `pull_request` EVENT, SO IT GETS NO CI AT ALL. There is no
 * merge commit to build, so no run is ever created: its checks are not failing, they are ABSENT. A
 * reader who sees "conflicts" thinks about a rebase; a reader who is told "conflicting — and
 * therefore untested" understands that the branch's correctness is unknown and has been for as long
 * as the conflict has stood. That is the fact this class exists to carry, and it is one fact rather
 * than two — which is why {@link conflictCondition} never says the first half without the second.
 *
 * ── A FROZEN CONTRACT ────────────────────────────────────────────────────────────────────────────
 * These field names are the wire shape the Rust side produces (`conflict_flags` + the
 * `conflict://detected` event, serde camelCase). Renaming one here silently empties the detector
 * rather than failing a build, because the payload crosses an `invoke` boundary that TypeScript
 * cannot check. Treat it as fixed.
 */
export interface ConflictingPr {
  /** The PR number, as GitHub numbers it. Quoted in the report, so it is citable. */
  pr: number;
  /**
   * WHICH PROJECT the PR belongs to — the producer's own project id.
   *
   * A PR number is not an identity across repos: sibling projects both have a `#12`. Without this
   * a consumer holding `pr: 12` had to ask every open repo and accept whichever answered, which is
   * a weaker answer than the producer already had in hand. The producer states it, so nothing here
   * has to infer it.
   */
  projectId: string;
  /** The head branch, VERBATIM — quoted, so `quotedNumbers` whitelists whatever digits it carries. */
  branch: string;
  /**
   * The agent that owns this PR, or `null` for UNRESOLVED — never "no agent".
   *
   * Ownership is RECORDED (`pr_owner.rs`, `pr-owners.json`), not parsed out of the branch name; the
   * five PRs this class was built for are all on descriptive branches, so a branch-name reading would
   * have resolved none of them. An unresolved owner still has to reach somebody, so it is reported
   * AS unresolved rather than dropped or guessed — a wrong id opens the wrong agent and the reader
   * cannot tell, which is strictly worse than no id at all.
   */
  ownerAgentId: string | null;
  /** `conflicting` = cannot merge. `stale` = can merge, but is behind. Only the first is untested. */
  kind: "conflicting" | "stale";
  /** How far behind the base branch. The number that says whether this is a minute or an afternoon. */
  commitsBehind: number;
  /** How long it has been in this state, as the producer measured it. Not recomputed here. */
  unresolvedSecs: number;
  /**
   * HOW we know what `kind` says — see {@link ConflictEvidence}. Mandatory, because the producer
   * always states it and because without it a reading that is NOT CURRENT is indistinguishable from
   * one taken this second: a conflicting row is equally what a directly-observed absence of CI and
   * an inherited-or-unread verdict produce, and the report used to narrate both as "no CI has ever
   * run on it". It is also the ONLY field that separates them — Rust's `untested` answers `true` for
   * both, which is why the consumer no longer carries it.
   *
   * WIDENED WITH `string` ON PURPOSE. This value set has grown three times already, so a strict
   * union would make a seventh value a PARSE FAILURE — and the parser is all-or-nothing, so one
   * unrecognised value would mute the detector for the whole fleet at once. That is the exact
   * failure the value set was split to prevent. An unrecognised value is retained verbatim and
   * narrated as NOT CURRENT, which is the weaker and therefore safe claim.
   */
  evidence: ConflictEvidence | (string & {});
  /** Whatever the producer knows is holding it, quoted verbatim. Absent when nothing is recorded. */
  blockedBy?: string;
}

/**
 * The concierge's inbound queue — messages waiting to be fanned out, and how many concierge agents
 * exist to take them.
 *
 * ── WHAT NOTHING WAS WATCHING ────────────────────────────────────────────────────────────────────
 * The founder watched six messages queue with ZERO concierge agents running. In his words: *"I want
 * the watcher to be watching whether there are any queued messages and when there are I want the
 * pusher to be pushing you to send them to concierge agents instead of letting them stack up."*
 *
 * This is the `duty-overdue` shape rather than an agent's: nothing is errored, no goal is escalated,
 * and every row on the surface is its normal colour. The queue is not BLOCKED by anything — it is
 * simply not being served, and a depth that only ever grows looks identical to a depth that is being
 * worked through unless somebody is also counting what is running.
 *
 * ── WHY THIS IS A SIBLING OF {@link StandingDuty}, NOT A FIELD ON {@link FleetSnapshot} ───────────
 * The same reason {@link ConflictingPr} is, arrived at from the other direction. A `FleetSnapshot` is
 * keyed by `agentId` and describes ONE agent, so anything living there needs an agent to hang off.
 * This queue is APP-GLOBAL — it is one thing, and in the case that motivated it the number of agents
 * it could be attributed to is exactly zero. Hanging it off a snapshot would mean either inventing a
 * carrier agent (whose id would then poison the cooldown's membership key) or, in the founder's own
 * case, having nowhere to put it at all and reporting an all-clear about the very queue the class was
 * written to find.
 *
 * ── THREE-VALUED, AND THE THIRD VALUE IS THE WHOLE INPUT ─────────────────────────────────────────
 * An `undefined` {@link ConciergeQueue} is WE DID NOT LOOK — no store read, or a store that has not
 * hydrated — and it reports nothing. That is distinct from a looked-at queue that is empty, which is
 * an all-clear. The same distinction `evaluateFleetConditions` refuses to default away for
 * `conflicts`, and for the same reason: only one of the two may be manufactured by a caller, and it
 * is not the one that says the app is fine.
 *
 * ── A PERSISTED, APP-WIDE STORE IS THE ONLY PRODUCER THAT WORKS ──────────────────────────────────
 * Recorded because this class was specified against a measured failure in a sibling one. A fleet
 * condition fires IFF its evidence lives somewhere that outlives a pane: `goals-escalated` reads
 * `agent.goal.escalatedAt` off the persisted project store and fires reliably, while `quota-blocked`
 * reads a per-window live engine registry and has never fired in production at all — the wall dies
 * with the pane that saw it. So a producer for these fields that reads a live in-memory registry
 * would type-check, test green, and be permanently silent. It has to be persisted and app-wide.
 */
export interface ConciergeQueue {
  /** How many messages are waiting to be fanned out. Counted, and quoted in the report. */
  queued: number;
  /**
   * How many concierge agents are actually RUNNING right now — not configured, not spawnable.
   *
   * This is the half that turns a depth into a condition. Six queued messages with three concierge
   * agents working is a backlog being served; six with none is a queue that will still be six
   * tomorrow. The report says both numbers for exactly that reason.
   */
  liveAgents: number;
  /**
   * When the OLDEST waiting message was enqueued, or `null` when nothing is waiting and when no
   * enqueue time was recorded.
   *
   * REQUIRED BUT NULLABLE, which is the shape the fail-closed rule needs at a call site — the same
   * choice `FleetReportInput.conflicts` makes. Optional would let a producer that simply forgot the
   * field compile into permanent silence, indistinguishable from one that genuinely has no clock;
   * `null` makes the omission a decision somebody wrote down. Either way {@link queueUnfanned}
   * declines to fire, because the age is the only thing separating a queue that has stopped moving
   * from a fan-out that is one tick away from happening.
   *
   * The producer is a persisted JSON store, so this type is a promise rather than an enforcement: a
   * payload written before the field existed arrives as `undefined`, and a corrupt one as `NaN`.
   * {@link queueUnfanned} treats all three the same way at runtime, which is what makes the promise
   * safe to write down here.
   */
  oldestAt: number | null;
}

/**
 * How long a queue must have been standing before it is worth a word.
 *
 * ── WHY A FLOOR ON TOP OF THE TWO-OBSERVATION RULE ───────────────────────────────────────────────
 * The two-observation rule bounds this by the SWEEP interval, and a sweep is short. A message that
 * arrives and is fanned out normally can easily be present for two consecutive sweeps, so without a
 * floor the ordinary, healthy path — a message lands, an agent is started, the message is taken —
 * would produce a report every time. That is precisely the tune-out the anti-noise machinery exists
 * to prevent, and it would be self-defeating here: the founder's case is a queue standing for a long
 * time, and a channel that also fires on the two-second case is one he stops reading.
 *
 * ── WHY THREE MINUTES ────────────────────────────────────────────────────────────────────────────
 * Long enough that a fan-out which is merely IN PROGRESS has finished — spawning a concierge agent
 * and handing it a message is seconds, not minutes — and short enough that the founder is told while
 * he is still looking at the screen where he noticed it. It is deliberately not the four-hour
 * cooldown's order of magnitude: this class is about something that should have happened already.
 */
export const QUEUE_UNFANNED_MIN_AGE_MS = 3 * 60_000;

/**
 * The depths at which a queue counts as materially DEEPER than it was.
 *
 * ── WHY BUCKETS AND NOT THE COUNT ────────────────────────────────────────────────────────────────
 * {@link FleetCondition.members} is an identity set and the report cooldown re-opens on GROWTH, so
 * whatever goes in it decides when a standing queue is allowed to speak again inside the four-hour
 * window. A raw `queue:depth:6` would make every single arriving message a new member — the same
 * paragraph re-sent on the queue's own timer, which is a measurement masquerading as an identity and
 * is exactly what {@link FleetCondition.members} says never to put there. Publishing nothing but a
 * bare `concierge:queue` has the opposite failure: a queue that doubles inside the cooldown is
 * invisible for four hours, which is the blind spot `pr-conflicting` had to close.
 *
 * Buckets are the middle: crossing 10 after being reported at 6 is a real change in the situation,
 * and each threshold can only be crossed once per episode. Roughly doubling, so the fifth message and
 * the fiftieth do not cost the same attention.
 */
export const QUEUE_DEPTH_BUCKETS: readonly number[] = [2, 5, 10, 20, 50];

/**
 * What one sweep knows about one agent, for the fleet report.
 *
 * Every field is optional and three-valued in the same way `PartnerSnapshot`'s are: present-and-true,
 * present-and-false, or ABSENT meaning WE DID NOT LOOK. `undefined` never satisfies anything here —
 * see `pusherObserve`'s header for why an absent input must not manufacture a claim.
 *
 * ── WHAT IS DELIBERATELY *NOT* HERE: {@link ConflictingPr} ───────────────────────────────────────
 * A conflicting PR is not a property of an agent, and putting it here would have quietly discarded
 * the exact cases the class was built for. This structure is keyed by `agentId`, so every entry
 * needs an agent to hang off — and the five PRs that motivated this class resolve to
 * `ownerAgentId: null`. They would have had nowhere to live, and the detector would have reported
 * an all-clear about the very PRs it was written to find. A parallel input (like `StandingDuty`,
 * for the same reason: it describes a CAPABILITY rather than an agent) has no such requirement, and
 * it also lets one agent own several PRs without inventing a shape for that.
 *
 * {@link ConciergeQueue} is the third, and it is the clearest case of the three: the queue is ONE
 * app-global thing, and the situation worth reporting is the one where the number of agents it could
 * be attached to is zero.
 */
export interface FleetSnapshot {
  agentId: string;
  /**
   * How the human refers to this agent. Quoted verbatim, so its numbers are whitelisted the same way
   * a banner's are — an agent named "Cockpit Resize 2" cites a 2 nobody computed.
   */
  label?: string;
  /**
   * An observed account/quota wall. Shaped after `engine/quotaBlock.QuotaBlock` but restated as a
   * plain structural type: `@sparkle/core` is a leaf and must not import from the desktop app.
   */
  quota?: {
    /** The banner VERBATIM, exactly as the agent printed it. */
    message: string;
    /** Epoch ms the wall is expected to come down. */
    resetAt: number;
    /** Did the banner actually NAME a time, or is `resetAt` the bounded fallback? */
    resetParsed: boolean;
  };
  /**
   * A failure this agent is currently sitting in, as it printed it.
   *
   * The grouping in {@link sharedFailureCohorts} is on this exact string, which is why it must be
   * verbatim and unnormalised: two agents killed by one host event print the SAME bytes, and any
   * tidying this module did would be tidying the evidence that they died together.
   */
  failure?: {
    /** The error text VERBATIM. */
    message: string;
    /** Epoch ms the failure was observed. */
    at: number;
  };
  /** Present iff the goal is escalated. `reason` is `AgentGoal.escalationReason`, quoted verbatim. */
  escalation?: { reason?: string };
  /** `goal.metAt`. Present means met, at any time. */
  goalMetAt?: number;
  /**
   * Has this agent's SESSION ENDED — the `SessionEnd` hook landed, or its PTY exited?
   *
   * Three-valued like everything else here, and the ABSENT arm is the common one rather than the
   * exceptional one. The producer projects TWO sources — the window's live status map, whose single
   * writer is a mounted pane, and the PERSISTED capture `close()` takes of the entry it deletes —
   * gated by `agentLiveness`. So `true` means one of them affirmatively said the session ended;
   * `undefined` means nothing here can tell, which covers both an agent nobody has a pane for and an
   * agent open in ANOTHER window (a capture from a previous life must not answer for a row that is
   * running again). Neither absence is "still running", so {@link diedHoldingWork} requires an
   * affirmative `true`.
   *
   * NO NEW VOCABULARY. `hookEventToStatus({event:"SessionEnd"})` already answers `done`, and that
   * mapping is pinned by test; this field is the boolean projection of it, so a session-end stays
   * one fact with one definition. The projection lives in the adapter (`pusherSnapshots`), because
   * `@sparkle/core` is a leaf and cannot name an `AgentTabStatus`.
   */
  sessionEnded?: boolean;
  /**
   * Uncommitted changes in this agent's worktree — `BranchStatus.dirty`, the RAW reading.
   *
   * DELIBERATELY NOT THE SAME QUESTION AS {@link hasUnlandedWork}, which folds `ahead` in and
   * declines to answer for a worktree parked off its own branch. `BranchStatus` states the split
   * itself: an ATTRIBUTION consumer must suppress a parked tree's dirt, a SAFETY consumer must not,
   * because parking carries the uncommitted files along and they are still on disk and still the
   * user's. This one is the safety reading, so it never filters — see `pusherSnapshots.dirtyOf`.
   */
  dirty?: boolean;
  /**
   * How many uncommitted paths — `BranchStatus.dirtyCount`, the TRUE count rather than the capped
   * `dirtyFiles` preview.
   *
   * Independently optional from {@link dirty}, because a Rust build predating the field sends
   * `dirty: true` with no count at all. Absent means the number is unknown, never zero, and
   * {@link diedHoldingWorkCondition} says so rather than printing a 0 nobody measured.
   */
  dirtyCount?: number;
  /**
   * Whether this agent is holding work that has not landed.
   *
   * For the retire claim this must be affirmatively `false` — see {@link retirableAgents}. This is
   * the one place in the Pusher where the fail-closed rule has teeth beyond noise: a "safe to
   * retire" said over missing data tells the founder to discard an agent that may be holding
   * unmerged commits.
   */
  hasUnlandedWork?: boolean;
  /**
   * Whether this agent's retro step is on file — a `RetroReceipt` exists for it.
   *
   * SAME RULE, SAME REASON AS `hasUnlandedWork`: it must be affirmatively `true` for the retire
   * claim. `undefined` means "nothing has told us", which is the normal reading today, not an
   * exceptional one.
   *
   * This field exists because the contract was already WRITTEN and not kept (knightwatch
   * 5204094441#5). `engine/retroReceiptTypes` says, in its own words, that the Pusher *"requires an
   * affirmative `true` before it will recommend retiring anything"* — while `retirableAgents`
   * checked only the goal and the unlanded work. So the report said "safe to retire" about the very
   * rows whose × then opens a dialog headed *"Retire … without its retro?"*: two surfaces, one
   * agent, opposite advice, with the founder in between.
   */
  retroSettled?: boolean;
}

/** One condition, with the arithmetic and the quotes that make it true. */
export interface FleetCondition {
  id: FleetConditionId;
  /** The agents this condition covers, in the order the report names them. */
  agentIds: string[];
  /**
   * WHAT THIS CONDITION IS ABOUT, as identity rather than as prose — the content fingerprint the
   * report cooldown compares one episode against the next.
   *
   * ── WHY `agentIds` COULD NOT BE THIS ─────────────────────────────────────────────────────────
   * The cooldown re-opens on GROWTH, and it used to read growth off `agentIds` alone. That is a
   * fingerprint only for the classes whose subject IS an agent. Two classes here have no agent, or
   * cannot resolve one:
   *
   *   • `duty-overdue` hard-codes `agentIds: []` on purpose — a duty is a CAPABILITY, and borrowing
   *     an agent id would put an unrelated agent in the cooldown's key.
   *   • `pr-conflicting` lists RESOLVED owners only, and the five PRs this class was built for all
   *     resolve to `ownerAgentId: null` (see {@link ConflictingPr}). For exactly the case that
   *     motivated it, the list is empty.
   *
   * An empty list can never gain a member, so `[].some(...)` is always false and growth was
   * UNDETECTABLE: a brand-new conflicting, untested PR appearing sixty seconds after a report was
   * invisible for the full `REPEAT_COOLDOWN_MS`, every time, forever — the four-hour blind spot
   * `pusherFleetReport`'s header says was closed for `quota-blocked`, silently rebuilt for the two
   * classes whose subject is not an agent.
   *
   * ── WHAT GOES IN IT ──────────────────────────────────────────────────────────────────────────
   * The identity of each thing the report NAMES, namespaced so two classes cannot collide:
   * `agent:<id>`, `duty:<name>`, `pr:<number>`. Never a measurement — a count that ticks up, an age
   * that grows, a commits-behind that drifts are not new members, and treating them as such would
   * re-send the same paragraph on a timer.
   *
   * ── EMPTY MEANS "CANNOT BE FINGERPRINTED", WHICH FAILS OPEN ──────────────────────────────────
   * Every class below fills this, so `[]` is reachable only for a class added later that genuinely
   * has no identity to name. `hasNewMember` treats that as a new episode and REPORTS it. Silence is
   * the failure mode this whole mechanism exists to eliminate, so an unanswerable "has it changed?"
   * must resolve to speaking, never to four more hours of quiet.
   */
  members: string[];
  /** Every number the report may quote for this condition — counts plus {@link quotedNumbers}. */
  measured: string[];
  /** The finished sentence(s). Built only from `measured`; no model composes it. */
  text: string;
}

/**
 * The fingerprint of a set of agents — the identity half of {@link FleetCondition.members} for the
 * four classes whose subject really is an agent.
 *
 * Namespaced rather than raw so that `agent:x` from one class can never be confused with a `pr:x`
 * or `duty:x` from another, and deduplicated because one agent can appear twice in a class built
 * from several cohorts (`shared-failure` flattens them).
 */
function agentMembers(snapshots: readonly FleetSnapshot[]): string[] {
  return [...new Set(snapshots.map((s) => `agent:${s.agentId}`))];
}

/**
 * Is this agent behind an account limit at `now`?
 *
 * Mirrors `engine/quotaBlock.isQuotaBlocked`: a block whose reset has passed is history, not a
 * condition, and an ABSENT block reads as "no wall" rather than as "blocked".
 */
export function isQuotaWalled(snap: FleetSnapshot, now: number): boolean {
  return snap.quota !== undefined && now < snap.quota.resetAt;
}

/**
 * Agents that are DONE and still open.
 *
 * The evidence bar is deliberately higher than anywhere else in the Pusher: the goal must be met,
 * `hasUnlandedWork` must be affirmatively `false`, AND `retroSettled` must be affirmatively `true`.
 * `undefined` — "no branch status was polled for this agent", "nothing has told us about a retro" —
 * fails all three, because the cost of being wrong here is not a noisy message. It is a
 * recommendation to retire an agent holding work nobody has merged, or whose account of what it
 * learned nobody has.
 *
 * THE THIRD CLAUSE IS NOT NEW POLICY — it is the policy `engine/retroReceiptTypes` already stated
 * and this function did not implement (knightwatch 5204094441#5). Read the consequence plainly
 * rather than as a footnote: no production path writes a `captured` receipt yet, so today this
 * condition goes QUIET for almost every agent. That is the intended reading of a fail-closed rule
 * whose input has no producer, and it is strictly better than the alternative it replaces — a
 * report telling the founder a row is "safe to retire" moments before its × asks him to retire it
 * "without its retro?". When the producer lands, the condition returns on its own.
 */
export function retirableAgents(snapshots: readonly FleetSnapshot[]): FleetSnapshot[] {
  return snapshots.filter(
    (s) => s.goalMetAt !== undefined && s.hasUnlandedWork === false && s.retroSettled === true,
  );
}

/**
 * Agents whose session ENDED with the goal unmet and uncommitted work still in the worktree.
 *
 * ── THE CASE THIS IS ────────────────────────────────────────────────────────────────────────────
 * An agent was asked for ten homepage designs. It was spawned, it ran, and its session ended
 * without a word. What it left behind was three research documents, uncommitted, and zero
 * homepages — and nothing anywhere said so. The goal was never marked met, so no surface called it
 * done; the agent was not errored, so no row went red; the work existed only as unstaged files in a
 * worktree, so nothing in git could see it either. The founder found it the way he finds all of
 * these: by looking.
 *
 * ── FAIL-CLOSED IN BOTH DIRECTIONS, WHICH IS NOT THE USUAL SHAPE ────────────────────────────────
 * Every other condition here is fail-closed against SAYING TOO MUCH. This one is fail-closed
 * against saying too much AND against saying nothing, and the two pull on different fields:
 *
 *   • `sessionEnded === true`. `undefined` is "nothing this window can read said the session ended"
 *     — no pane reported a status AND no capture stands unopposed — which is the ordinary reading
 *     for most of the fleet. Treating it as an ended session would report every unobserved agent as
 *     dead. Note the producer will not answer `true` off a stale capture for a row that is open in
 *     another window, so a resumed agent cannot arrive here looking finished.
 *   • `goalMetAt === undefined`. A met goal means the session ending is the agent FINISHING, and
 *     leftover files are then a tidy-up rather than lost work.
 *   • `dirty === true`, AFFIRMATIVELY. This is the one worth stating, because the instinct here is
 *     backwards: "we did not look" feels like the cautious moment to warn. It is not. `undefined`
 *     means the branch poll did not answer — it is not weak evidence of uncommitted work, it is no
 *     evidence at all — and a report that says work is at risk over missing data is the SAME defect
 *     {@link retirableAgents} guards against from the opposite side. There, inventing `false` tells
 *     the founder to discard an agent that is holding commits; here, inventing `true` sends him to
 *     rescue a worktree that holds nothing. Both spend the credibility that makes this channel
 *     worth reading, and a channel he stops reading is the failure this whole feature exists to
 *     close. So the poll must have answered, and it must have said yes.
 */
export function diedHoldingWork(snapshots: readonly FleetSnapshot[]): FleetSnapshot[] {
  return snapshots.filter(
    (s) => s.sessionEnded === true && s.goalMetAt === undefined && s.dirty === true,
  );
}

/**
 * Every distinct number appearing in any of `strings`, as the literal token a report may quote.
 *
 * This is the widening the header describes, and its shape is what keeps it honest: it derives the
 * whitelist FROM the text that will be reproduced, so a number can only become citable by actually
 * appearing in a string the report quotes character-for-character. Reuses `numbersIn` rather than a
 * second regex, so what counts as "a number" cannot drift from what the gate will look for.
 */
export function quotedNumbers(...strings: (string | undefined)[]): string[] {
  const out = new Set<string>();
  for (const s of strings) {
    if (s === undefined) continue;
    for (const n of numbersIn(s)) out.add(n);
  }
  return [...out];
}

/** How the report names one agent. Label when there is one; the id is never quoted (see below). */
function nameOf(snap: FleetSnapshot): string {
  return snap.label?.trim() || "an unnamed agent";
}

// AGENT IDS ARE NEVER QUOTED, and that is a citation decision rather than a style one. Ids here are
// UUIDs; `numbersIn` reads "5839d2fa" as 5839, so quoting one would either put a meaningless number
// in `measured` or — if forgotten — get the whole report refused as `fabricated-citation`. The
// founder reads names, not ids, so nothing is lost.

/**
 * Minutes within which failures count as ONE event.
 *
 * A host sleeping or restarting kills every local agent within seconds of each other; the spread
 * this absorbs is detection latency, not the event — a poll interval, a scrollback scan, an agent
 * that was mid-turn. Fifteen minutes is generous against that and still far tighter than the hours
 * that separate genuinely independent failures, which is the case it has to keep apart.
 */
export const SHARED_FAILURE_WINDOW_MINUTES = 15;

/**
 * How many agents must share a failure before it is one EVENT rather than one agent's bad luck.
 *
 * Two, and the reason is that this condition earns its place purely by AGGREGATING. A single agent
 * failing is already visible on its own row and is exactly the kind of transient the two-observation
 * rule exists to swallow; reporting it here would add noise while saving nobody a glance. At two the
 * claim being made — "this is one cause, not N problems" — becomes true and useful.
 */
export const SHARED_FAILURE_MIN_VICTIMS = 2;

/**
 * How old the most recent failure in a cohort may be before it stops being reported at all.
 *
 * ── WHY AN ABSOLUTE BOUND IS NEEDED ON TOP OF THE WINDOW (roborev 57275) ─────────────────────────
 * `SHARED_FAILURE_WINDOW_MINUTES` is RELATIVE — it measures agents against each other, not against
 * the clock. So a cohort that is entirely stale still satisfies it: the host is offline 02:00-03:00,
 * five agents record `at: 02:10`, and at 09:00 they are all still within fifteen minutes of each
 * other. Without this the report claims they stopped as if it were happening now, and re-fires every
 * `REPEAT_COOLDOWN_MS` forever. `failure` is the only field here that records a past EVENT with no
 * end time — a quota wall has `resetAt`, escalation and a met goal are genuinely latched states — so
 * it is the only one that needs bounding against `now`.
 *
 * ── WHY TWENTY-FOUR HOURS ────────────────────────────────────────────────────────────────────────
 * The bound cannot be the grouping window: the founder's case is finding these the morning after an
 * overnight restart, and the agents really are still dead. It has to outlive a night. A day also
 * bounds the repetition to at most ~6 reports at the four-hour cooldown before the cohort goes quiet
 * for good, which is the property the finding was actually about.
 *
 * The honest half of this is not the cutoff, though — it is that the report QUOTES the age, so a
 * fourteen-hour-old event never reads as a fresh one.
 */
export const SHARED_FAILURE_MAX_AGE_MINUTES = 24 * 60;

/**
 * Agents killed by the same thing at the same time, grouped — one entry per distinct cause.
 *
 * ── WHY GROUPING IS BY THE EXACT STRING, AND WHY THERE IS NO MATCHER ─────────────────────────────
 * The observed case is a host sleep or restart, which kills every local agent with
 * `API Error: Unable to connect to API (ENOTFOUND)` and expires their goals together. The obvious
 * implementation is to detect THAT — but a matcher for connectivity errors would be a second copy of
 * a rule `improvementPass.isTransientPassFailure` already owns, and the repo has been bitten twice
 * by exactly that (`quotaBlock`'s header records the count).
 *
 * It is also unnecessary, because the thing worth reporting is not "these are network errors" — it
 * is "these have ONE cause". Identical bytes at one moment establish that without classifying
 * anything, and it generalises for free: a proxy dying, an auth lapse, a bad deploy all produce the
 * same shape and are all worth one message instead of N. What is quoted is what the agents printed,
 * so the citation rule needs nothing but {@link quotedNumbers}.
 *
 * ── THE WINDOW IS ANCHORED TO THE NEWEST FAILURE ─────────────────────────────────────────────────
 * Not to the group's total span. A message that recurs over days — the same error hitting one agent
 * on Monday and another on Thursday — is NOT one event, and a span test would eventually call it
 * one. Anchoring on the most recent failure and admitting only what falls within the window of it
 * reports the current burst and lets the stale members age out on their own.
 *
 * ── QUOTA-WALLED AGENTS ARE EXCLUDED, AND THIS IS LOAD-BEARING ───────────────────────────────────
 * A limit banner is ALSO identical across agents, so without this the fleet's quota block would
 * form a cohort here and be reported twice in one message under two different headings. Quota wins
 * because it is the more specific and more actionable reading of the same evidence — it carries a
 * reset time and a do-not-retry remedy that this condition cannot express.
 */
export function sharedFailureCohorts(
  snapshots: readonly FleetSnapshot[],
  now: number,
): Array<{ message: string; agents: FleetSnapshot[]; newest: number }> {
  const byMessage = new Map<string, FleetSnapshot[]>();
  for (const s of snapshots) {
    if (s.failure === undefined || isQuotaWalled(s, now)) continue;
    const list = byMessage.get(s.failure.message);
    if (list === undefined) byMessage.set(s.failure.message, [s]);
    else list.push(s);
  }

  const windowMs = SHARED_FAILURE_WINDOW_MINUTES * 60_000;
  const maxAgeMs = SHARED_FAILURE_MAX_AGE_MINUTES * 60_000;
  const out: Array<{ message: string; agents: FleetSnapshot[]; newest: number }> = [];
  for (const [message, all] of byMessage) {
    const newest = Math.max(...all.map((s) => s.failure!.at));
    // The anchor itself must be recent. Without this the window is satisfied by any group of old
    // failures that happened near each other, however long ago — see SHARED_FAILURE_MAX_AGE_MINUTES.
    if (now - newest > maxAgeMs) continue;
    const agents = all.filter((s) => newest - s.failure!.at <= windowMs);
    if (agents.length >= SHARED_FAILURE_MIN_VICTIMS) out.push({ message, agents, newest });
  }
  // Largest cohort first, so the biggest event leads the paragraph. Every qualifying cohort is
  // reported — none is dropped for brevity, because a silent cap reads as "that was all of it".
  return out.sort((a, b) => b.agents.length - a.agents.length);
}

/**
 * Duties that have missed at least {@link DUTY_OVERDUE_FACTOR} intervals, longest-overdue first.
 *
 * Fail-closed on `lastRunAt`: a duty whose clock we never read is not reported as overdue, because
 * "we did not look" must never manufacture a claim that the product has stopped working.
 */
export function overdueDuties(
  duties: readonly StandingDuty[],
  now: number,
): Array<{ duty: StandingDuty; overdueBy: number }> {
  const out: Array<{ duty: StandingDuty; overdueBy: number }> = [];
  for (const duty of duties) {
    if (duty.lastRunAt === undefined || duty.intervalMs <= 0) continue;
    const elapsed = now - duty.lastRunAt;
    if (elapsed >= duty.intervalMs * DUTY_OVERDUE_FACTOR) out.push({ duty, overdueBy: elapsed });
  }
  return out.sort((a, b) => b.overdueBy - a.overdueBy);
}

/**
 * A concierge queue that is standing still because nothing is running to take it — or `undefined`.
 *
 * Returns the READING rather than a boolean, clamped to what the report may quote, so that the
 * decision and the numbers in the sentence cannot drift apart. Four things must all hold, and each
 * one is a different claim being made honestly:
 *
 *   • WE LOOKED. `undefined` in means `undefined` out — see {@link ConciergeQueue}'s header.
 *   • SOMETHING IS WAITING. A looked-at empty queue is an all-clear, and saying so is the point of
 *     distinguishing it from the case above.
 *   • NOTHING IS RUNNING. `liveAgents` must be zero. This is the claim the class exists to make: a
 *     queue with a concierge working it is a backlog being served, and reporting it would spend the
 *     founder's attention on the healthy path.
 *   • IT HAS BEEN THAT WAY A WHILE. See {@link QUEUE_UNFANNED_MIN_AGE_MS}. An unrecorded `oldestAt`
 *     fails this, because "we cannot establish the age" is not "it is old" — the same fail-closed
 *     reading `overdueDuties` gives an unseeded `lastRunAt`.
 *
 * CLAMPED AND TRUNCATED for exactly the reason `behindOf` and `dirtyCountOf` are: a negative count
 * renders as `-6`, `numbersIn` reads `6` from it while `measured` holds `-6`, the two never match,
 * and the gate refuses the WHOLE batched report as `fabricated-citation`. That refusal presents as
 * SILENCE, so one nonsensical field from the producer would mute every condition in the message.
 *
 * ── AND NON-FINITE READINGS ARE REJECTED BEFORE THE CLAMPS, NOT BY THEM ─────────────────────────
 * A clamp defends against a number that is WRONG. `NaN` is not a number that is wrong, it is not a
 * number, and it walks through every guard here: `Math.trunc(NaN)` is `NaN`, so `=== 0` is false and
 * `> 0` is false — both admit — and `NaN < QUEUE_UNFANNED_MIN_AGE_MS` is false, so the staleness
 * floor is SKIPPED rather than enforced. `undefined` reaches the same place by a different road:
 * `=== null` does not catch an absent field, and `now - undefined` is `NaN`.
 *
 * That is not a theoretical hardening. This shape crosses a hydration boundary from a persisted JSON
 * store, where TypeScript enforces nothing — a payload written before `oldestAt` existed arrives as
 * `undefined`, not as the `null` the type promises. And failing open manufactures the one claim this
 * class must never make: `liveAgents: NaN` passes the "nothing is running" test, so a queue that IS
 * being served gets reported as abandoned. The delivered sentence is no defence either — `numbersIn`
 * finds no digits in "NaN", so "waiting NaNh NaNm" is perfectly citable and would be sent.
 */
export function queueUnfanned(
  queue: ConciergeQueue | undefined,
  now: number,
): { queued: number; liveAgents: number; waitedMs: number } | undefined {
  if (queue === undefined) return undefined;
  if (!Number.isFinite(queue.queued) || !Number.isFinite(queue.liveAgents)) return undefined;
  const queued = Math.max(0, Math.trunc(queue.queued));
  const liveAgents = Math.max(0, Math.trunc(queue.liveAgents));
  if (queued === 0 || liveAgents > 0) return undefined;
  // `== null` on purpose, and it is the one place in this file that loose equality earns its keep:
  // it catches the `undefined` an older store payload sends as well as the `null` the type states.
  if (queue.oldestAt == null || !Number.isFinite(queue.oldestAt)) return undefined;
  const waitedMs = now - queue.oldestAt;
  if (waitedMs < QUEUE_UNFANNED_MIN_AGE_MS) return undefined;
  return { queued, liveAgents, waitedMs };
}

/**
 * The conditions that hold across the fleet, most-blocking first.
 *
 * ORDER IS A PRIORITY. Quota-blocked leads because it is the only one where the ordinary remedy is
 * actively wrong — a human or a machine that retries a quota-walled agent spends turns achieving
 * nothing, and `agentThrash` already documents that any output after such a banner is "the
 * auto-resume being refused, not progress". A shared failure is next because it is the largest
 * saving available: N agents stopped by ONE cause is one decision, and it is the class most likely
 * to be sitting there unnoticed (every victim's row says "errored" independently, so nothing on any
 * surface says they are the same event). Escalated follows: a dead end, but one that needs a
 * judgement per agent. Done-not-retired is last: waste, but nothing is stuck behind it.
 *
 * ── WHERE `died-holding-work` SITS, AND WHY IT OUTRANKS EVERYTHING BELOW IT ──────────────────────
 * Directly after `shared-failure`, ahead of `duty-overdue` and everything under it. One property
 * decides it, and no other condition in this list has it: THE EVIDENCE IS DESTRUCTIBLE.
 *
 * Every other class describes work that cannot PROCEED. A quota wall lifts on its own clock and the
 * agent's commits are still there when it does; an escalated goal is latched and no harder to clear
 * tomorrow; a conflicting PR only gets more expensive; a stopped duty is a capability that is off.
 * Wait a day on any of them and the thing you would have acted on is still there to act on. Wait a
 * day on this one and the ordinary act of tidying up — retiring a finished-looking agent, tearing
 * down its worktree — has deleted the very files the report was about. Uncommitted work is on no
 * branch, so nothing in git is holding it: there is no reflog entry, no dangling commit, no rescue
 * ref. It is the one condition where being told LATE is the same as never being told.
 *
 *   • BELOW quota and shared-failure, and that is a close call rather than an obvious one. Both of
 *     those stop agents from executing at all, and shared-failure carries the larger saving (N
 *     agents, one decision). What keeps them above is that neither is made worse by the delay,
 *     while this one is — so the tie breaks on which loses more by being second, and second place
 *     in a batched report costs a paragraph's distance, not four hours.
 *   • ABOVE duty-overdue, which is the comparison this class has to win to be worth its position.
 *     A stopped duty turns a promised capability off for all FUTURE work, which sounds larger. But
 *     future work is recoverable by definition — restart the duty and it happens. These files are
 *     not. A capability that is off can be switched on; a worktree that was torn down cannot be
 *     untorn.
 *   • ABOVE done-not-retired, and the two are near-inverses worth reading together. That class says
 *     "met, clean, safe to retire"; this one says "unmet, dirty, retiring is what destroys it".
 *     They are decided by the same two fields read the opposite way, which is exactly why they must
 *     never be adjacent in the text — a reader who skims the wrong one acts destructively.
 *
 * The counter-argument, recorded because it is real: nothing here is BLOCKED, and one could rank a
 * blocked fleet above a rescue. That is the trade quota and shared-failure already win. Below them,
 * "this will still be there tomorrow" is true of every remaining class except this one.
 *
 * ── WHERE `queue-unfanned` SITS, AND WHY ─────────────────────────────────────────────────────────
 * Directly after `died-holding-work` and ahead of `duty-overdue`. Three comparisons decide it:
 *
 *   • BELOW quota, shared-failure and died-holding-work, which is not close. Those are agents that
 *     cannot execute at all, and one whose evidence a spin-down deletes. Nothing is destroyed by a
 *     queue waiting, and nothing is stuck behind it either — it is work that has not started.
 *   • ABOVE `duty-overdue`, which is the comparison it has to win, and the two are near-twins: both
 *     are capabilities that have stopped while every agent row looks fine. What separates them is
 *     WHOSE work is waiting. A stopped duty is the app failing to do something it promised itself;
 *     a queued message is a person having already asked, and being neither served nor told. It also
 *     DECAYS, which a duty does not: the queue only gets deeper, and every message added is another
 *     the eventual fan-out has to place.
 *   • ABOVE `pr-conflicting` and everything under it by the same reasoning that puts `duty-overdue`
 *     there — a PR that cannot merge is past work rotting, and this is present work not starting.
 *
 * The counter-argument, recorded because it is real: nothing here is BROKEN. One concierge agent
 * started by hand clears the whole condition, which makes it the cheapest thing on this list to fix
 * — and one could rank cheap-to-fix last. That is backwards for a report whose job is to save the
 * founder a glance: a condition that is invisible, growing, and one action away from resolved is the
 * best return on a paragraph the report has.
 *
 * ── WHERE `pr-conflicting` SITS, AND WHY ─────────────────────────────────────────────────────────
 * Between `duty-overdue` and `goals-escalated`. Three comparisons decide it:
 *
 *   • BELOW quota and shared-failure, which is not close. Those agents cannot execute at all; a
 *     conflicting PR is work that has already been done. Nothing is stuck behind it — it is rotting,
 *     which is a different and lesser urgency.
 *   • BELOW duty-overdue, narrowly. A stopped duty means a capability the product promises is off
 *     for ALL future work; a conflicting PR is a bounded amount of past work that cannot land.
 *   • ABOVE goals-escalated, which is the contested one. An escalated goal is worse in the moment —
 *     an agent is stuck now — so the case rests on two properties escalation does not have. It
 *     DECAYS: every merge to main widens the gap, so the same PR costs more to rescue each hour,
 *     while an escalated goal is latched and no harder to clear tomorrow. And it is INVISIBLE: an
 *     escalated goal paints its own row, so a human scanning the fleet can find it, whereas nothing
 *     anywhere says a PR has stopped being tested. That is the same argument that earns
 *     `duty-overdue` its place — "nothing looks wrong anywhere" is what makes a condition worth
 *     aggregating.
 *   • ABOVE done-not-retired, which is not close either: that is housekeeping, and this is untested
 *     work whose correctness nobody knows.
 *
 * The counter-argument, recorded because it is real: an escalated goal is the app admitting it has
 * given up, and one could rank "we surrendered" above "this will get harder". If that is ever taken,
 * the only thing that changes is which paragraph leads the report and which id keys the gate's
 * cooldown — both classes are still batched into the same message.
 */
export function evaluateFleetConditions(
  snapshots: readonly FleetSnapshot[],
  now: number,
  duties: readonly StandingDuty[] = [],
  // NO DEFAULT, unlike `duties`. `undefined` is not "none" here — it is WE DID NOT LOOK, and it is
  // the value a caller genuinely has whenever the conflict probe has not run or could not read `gh`.
  // Defaulting it to `[]` would erase the distinction at the one seam where it is load-bearing.
  conflicts?: readonly ConflictingPr[],
  // NO DEFAULT either, and for the same reason: `undefined` is WE DID NOT LOOK — no store read, or a
  // store that has not hydrated — and `{queued: 0, ...}` is a looked-at all-clear. Defaulting would
  // make a caller that forgot to thread it indistinguishable from one reporting a healthy queue.
  queue?: ConciergeQueue,
): FleetCondition[] {
  const out: FleetCondition[] = [];

  const walled = snapshots.filter((s) => isQuotaWalled(s, now));
  if (walled.length > 0) out.push(quotaCondition(walled));

  const cohorts = sharedFailureCohorts(snapshots, now);
  if (cohorts.length > 0) out.push(sharedFailureCondition(cohorts, now));

  // AHEAD OF EVERYTHING BELOW because this is the only class whose evidence a spin-down deletes —
  // see the ordering note above.
  const dead = diedHoldingWork(snapshots);
  if (dead.length > 0) out.push(diedHoldingWorkCondition(dead));

  // AHEAD OF `duty-overdue`: both are capabilities that stopped while every row looks fine, and this
  // one is the human's own request waiting rather than the app's promise to itself.
  const unfanned = queueUnfanned(queue, now);
  if (unfanned !== undefined) out.push(queueCondition(unfanned));

  const overdue = overdueDuties(duties, now);
  if (overdue.length > 0) out.push(dutyCondition(overdue));

  // FAIL CLOSED. `undefined` (never looked, or the probe failed) and `[]` (looked, nothing wrong)
  // both report nothing — but only one of them is allowed to be manufactured by a caller, and it is
  // not this one. The producer is where the two must not be conflated; see `conflictFlags.ts`.
  if (conflicts !== undefined && conflicts.length > 0) {
    out.push(conflictCondition(conflicts, snapshots));
  }

  // `goalMetAt` is a SIBLING latch on the same `AgentGoal`, not mutually exclusive with
  // `escalation` — a goal can be escalated and later marked met (sparkle-i5v42's Bug C). Exclude
  // those here, the same way `retirableAgents` and `diedHoldingWork` below both gate on
  // `goalMetAt`: a goal the roster already renders as finished must not still be reported as an
  // active, unmet escalation.
  const escalated = snapshots.filter((s) => s.escalation !== undefined && s.goalMetAt === undefined);
  if (escalated.length > 0) out.push(escalationCondition(escalated));

  const retirable = retirableAgents(snapshots);
  if (retirable.length > 0) out.push(retireCondition(retirable));

  return out;
}

function quotaCondition(walled: readonly FleetSnapshot[]): FleetCondition {
  const n = walled.length;
  const plural = n === 1 ? "agent is" : "agents are";

  // THE EARLIEST RESET, and only among blocks that actually NAMED one. `resetParsed === false` means
  // `resetAt` is `SESSION_LIMIT_FALLBACK_MS` from the sighting — a bounded re-check, not a claim
  // about when the account returns. Sorting on it would let a guess win the "earliest" slot and be
  // quoted as if measured.
  const parsed = walled.filter((s) => s.quota?.resetParsed === true);
  const earliest = parsed.reduce<FleetSnapshot | undefined>(
    (best, s) => (best === undefined || s.quota!.resetAt < best.quota!.resetAt ? s : best),
    undefined,
  );

  // The remedy sentence is the load-bearing half. Sparkle's own detection is good enough that the
  // founder was never in doubt about WHETHER these agents were stuck — what cost hours was that
  // nothing said the retry would not work.
  const notRestartable =
    "Restarting them does not help: an account limit clears on its own clock, not on a retry.";

  if (earliest?.quota !== undefined) {
    return {
      id: "quota-blocked",
      agentIds: walled.map((s) => s.agentId),
      members: agentMembers(walled),
      measured: [String(n), ...quotedNumbers(earliest.quota.message)],
      text:
        `${n} ${plural} quota-blocked and cannot run at all. The earliest reset is the one ` +
        `reported verbatim as: "${earliest.quota.message}". ${notRestartable}`,
    };
  }

  // Nothing named a time. Say the count and say plainly that the time is unknown, rather than
  // quoting a fallback instant as though the banner had stated it.
  return {
    id: "quota-blocked",
    agentIds: walled.map((s) => s.agentId),
    members: agentMembers(walled),
    measured: [String(n)],
    text:
      `${n} ${plural} quota-blocked and cannot run at all. None of the limit messages named a ` +
      `reset time, so when the account returns is not known from here. ${notRestartable}`,
  };
}

function sharedFailureCondition(
  cohorts: ReadonlyArray<{ message: string; agents: FleetSnapshot[]; newest: number }>,
  now: number,
): FleetCondition {
  const agents = cohorts.flatMap((c) => c.agents);

  // ONE LINE PER CAUSE. Usually there is exactly one, and the sentence is the whole point: the count
  // and the claim that it is a single event, followed by the bytes that prove it.
  //
  // THE AGE IS QUOTED, and that is the half of roborev 57275 that matters more than the cutoff. A
  // failure timestamp is evidence the agent died THEN; it is not evidence it is still dead now, and
  // this module has no way to learn that it recovered. Saying how long ago hands the reader the one
  // fact they need to judge it, instead of a present-tense sentence about a stale event.
  const ages = cohorts.map((c) => splitHoursMinutes(Math.max(0, now - c.newest)));
  const lines = cohorts.map((c, i) => {
    const n = c.agents.length;
    const { h, m } = ages[i]!;
    const names = c.agents.map(nameOf).join(", ");
    return (
      `  - ${n} agents died together ${h}h ${m}m ago — one event, not ${n} problems: ` +
      `"${c.message}" (${names})`
    );
  });

  const total = agents.length;
  const head =
    cohorts.length === 1
      ? `${total} agents stopped for a single shared reason, not ${total} separate ones.`
      : `${total} agents stopped across ${cohorts.length} shared causes, not ${total} separate ones.`;

  return {
    id: "shared-failure",
    agentIds: agents.map((s) => s.agentId),
    members: agentMembers(agents),
    measured: [
      String(total),
      String(cohorts.length),
      ...cohorts.map((c) => String(c.agents.length)),
      ...ages.flatMap(({ h, m }) => [String(h), String(m)]),
      ...quotedNumbers(...cohorts.map((c) => c.message), ...agents.map((s) => s.label)),
    ],
    text: `${head}\n${lines.join("\n")}`,
  };
}

/**
 * Messages waiting for a concierge that does not exist.
 *
 * ── THE SENTENCE CARRIES BOTH NUMBERS, AND THE SECOND ONE IS THE CLAIM ──────────────────────────
 * "6 messages are queued" is a backlog, and a backlog is a normal thing a reader skims past. "…and 0
 * concierge agents are running" is what makes it a condition: nobody is going to take them. The two
 * are one fact and are never split, the same discipline `conflictCondition` follows for
 * "conflicting — and therefore untested".
 *
 * ── THE ZERO IS CITED, AND SPELLING IT OUT WOULD BE WORSE THAN NOT SAYING IT ─────────────────────
 * `numbersIn` matches `\d+`, so the `0` in that clause is a number the gate will look for, and a
 * `measured` that carries only the count gets the ENTIRE batched report refused as
 * `fabricated-citation` — `decideFleetReport` unions `measured` across every fresh condition, so a
 * miss here silences `quota-blocked` and `goals-escalated` too, and the refusal presents as silence.
 * The fix is to MEASURE the zero, not to write it as "zero": the word would slip past the gate while
 * making the load-bearing half of the sentence uncheckable, which is the citation rule defeated
 * rather than satisfied.
 *
 * ── THE REMEDY CLAUSE ────────────────────────────────────────────────────────────────────────────
 * Same register as `quotaCondition`'s `notRestartable`, and load-bearing for the same reason. There,
 * the fact that cost hours was that retrying does not work; here it is that WAITING does not work. A
 * queue is the one shape a reader instinctively assumes is being drained by something, so the report
 * says plainly that nothing is draining it and that the depth is not going to fall on its own.
 */
function queueCondition(reading: {
  queued: number;
  liveAgents: number;
  waitedMs: number;
}): FleetCondition {
  const { queued, liveAgents, waitedMs } = reading;
  const { h, m } = splitHoursMinutes(Math.max(0, waitedMs));
  const plural = queued === 1 ? "message is" : "messages are";

  // The DEPTHS ALREADY CROSSED, never the raw count — see {@link QUEUE_DEPTH_BUCKETS} for why a
  // count in the fingerprint would re-send this paragraph on the queue's own timer.
  const buckets = QUEUE_DEPTH_BUCKETS.filter((b) => queued >= b).map(
    (b) => `concierge:queue:depth-${b}`,
  );

  return {
    id: "queue-unfanned",
    // A queue is not an agent, and in the case this was built for there is no agent to name — that
    // is the condition. Borrowing an id would put an unrelated agent in the cooldown's key.
    agentIds: [],
    // The bare member is what the class always publishes, so a queue that never crosses a bucket
    // still has a fingerprint and is not failed open into repeating every sweep.
    members: ["concierge:queue", ...buckets],
    measured: [String(queued), String(liveAgents), String(h), String(m)],
    text:
      `${queued} ${plural} queued and ${liveAgents} concierge agents are running. The oldest has ` +
      `been waiting ${h}h ${m}m. Nothing is errored and no goal is escalated — the messages are ` +
      `simply stacking up with nothing to take them.\n` +
      `The queue does not drain itself while nothing is running: a queued message waits for a ` +
      `concierge agent to exist, so the depth only falls once one is started. Fan them out to ` +
      `concierge agents rather than letting them stack up.`,
  };
}

function dutyCondition(
  overdue: ReadonlyArray<{ duty: StandingDuty; overdueBy: number }>,
): FleetCondition {
  const lines = overdue.map(({ duty, overdueBy }) => {
    const since = splitHoursMinutes(overdueBy);
    const every = splitHoursMinutes(duty.intervalMs);
    // The HOLD is the actionable half — see `StandingDuty.heldBy`. Without one, the honest thing is
    // to say the duty is simply not happening rather than to guess at a cause.
    const why = duty.heldBy ? ` Held by: ${duty.heldBy}.` : " Nothing reports why.";
    return (
      `  - "${duty.name}" last ran ${since.h}h ${since.m}m ago; it is supposed to run every ` +
      `${every.h}h ${every.m}m.${why}`
    );
  });

  const n = overdue.length;
  const plural = n === 1 ? "duty has" : "duties have";
  return {
    id: "duty-overdue",
    // A duty is not an agent, and the report must not imply one is stuck. Empty rather than
    // borrowing an agent id, which would put an unrelated agent in the cooldown's membership key.
    agentIds: [],
    // ...which is exactly why this class needs `members`. With `agentIds: []` as the only
    // fingerprint, a SECOND duty going overdue during the cooldown could not be seen as growth and
    // went unreported for four hours. The duty's own name is its identity — it is what the line
    // names, and it is stable across sweeps in a way the overdue-by age is not.
    members: overdue.map(({ duty }) => `duty:${duty.name}`),
    measured: [
      String(n),
      ...overdue.flatMap(({ duty, overdueBy }) => {
        const since = splitHoursMinutes(overdueBy);
        const every = splitHoursMinutes(duty.intervalMs);
        return [String(since.h), String(since.m), String(every.h), String(every.m)];
      }),
      ...quotedNumbers(...overdue.flatMap(({ duty }) => [duty.name, duty.heldBy])),
    ],
    text:
      `${n} standing ${plural} stopped running. Nothing is visibly wrong — every agent looks ` +
      `fine, which is why this goes unnoticed:\n${lines.join("\n")}`,
  };
}

/**
 * How the report names the owner of one PR. Four answers, and the last three are all the same point.
 *
 * An id is never quoted (see the note above {@link SHARED_FAILURE_WINDOW_MINUTES}'s neighbours), so
 * a resolved owner can only be named by its LABEL — and there are two ways to have an id and no
 * label: the agent is not in this window's roster, or it has no name. Each says so rather than
 * printing something that reads like a name. What none of them does is omit the PR, because a PR
 * nobody is told about is exactly the state this class exists to end.
 */
/** The commits-behind count as the report may quote it — see the clamp's note in {@link conflictCondition}. */
function behindOf(c: ConflictingPr): number {
  return Math.max(0, Math.trunc(c.commitsBehind));
}

/**
 * The `evidence` values that mean WE READ THIS PR ON THIS LOOK. Everything else — the two inherited
 * states, `unknown`, and any value this build has never heard of — is a reading that is not current.
 *
 * A whitelist rather than a blacklist, and that direction is the safety property: an evidence value
 * added on the Rust side later falls into "not current" and gets the weaker sentence, instead of
 * being narrated as first-hand knowledge nobody has.
 */
const FIRST_HAND_EVIDENCE = new Set<string>([
  "no-checks-ran",
  "checks-are-stale",
  "n/a",
] satisfies ConflictEvidence[]);

/** Is this row a reading somebody actually took on the last look? Everything else is NOT current. */
const notCurrent = (c: ConflictingPr): boolean => !FIRST_HAND_EVIDENCE.has(c.evidence);

/**
 * The compound "conflicting — and therefore untested" clause for one PR, qualified by HOW the
 * producer knows it.
 *
 * ── A READING THAT IS NOT CURRENT IS STILL REPORTED, AND IS STILL SAID TO BE UNTESTED ────────────
 * It just stops claiming to have been taken now. `last-known` and `last-known-unconfirmed` carry a
 * real, recent verdict for this head; `unknown` carries one that may belong to a head that has since
 * moved. Dropping or greying any of them would suppress a genuine standing conflict for the whole of
 * a `gh` outage — and for an unrecognised `mergeStateStatus` that is every tracked PR at once, which
 * is the failure the producer's evidence split exists to prevent. So: report it, act on it, and say
 * the reading is not current.
 */
function testingPhrase(c: ConflictingPr): string {
  if (notCurrent(c)) {
    const why =
      c.evidence === "unknown"
        ? "nothing about this commit could be confirmed on the last look"
        : "the verdict is real and recent, but was not re-read on the last look";
    return `conflicting, and therefore untested — but this reading is NOT current: ${why}`;
  }
  // Checks that EXIST but ran before the conflict arose are not "no CI has ever run": they ran, and
  // they ran against a merge that no longer applies. Same conclusion — nothing current has tested
  // this PR — reached by a different route, and stating the wrong route is a citable falsehood in a
  // report whose whole credibility is that it does not overstate.
  if (c.evidence === "checks-are-stale") {
    return "conflicting, and therefore untested — its only checks ran before the conflict arose, and no new run can be created";
  }
  // The only value left that a CONFLICTING row can carry: Rust returns `"n/a"` for `!is_dirty` only.
  return "conflicting, and therefore untested — no CI has ever run on it";
}

function ownerPhrase(c: ConflictingPr, labels: ReadonlyMap<string, string | undefined>): string {
  if (c.ownerAgentId === null) return "Owner unresolved";
  if (!labels.has(c.ownerAgentId)) return "Owner recorded, but not an agent this window can see";
  const label = labels.get(c.ownerAgentId);
  return label === undefined ? "Owner recorded, but that agent has no name" : `Owner: ${label}`;
}

/**
 * Open PRs that cannot merge, and the ones drifting toward it.
 *
 * ── THE HEADLINE FACT IS COMPOUND, AND IS NEVER SPLIT ────────────────────────────────────────────
 * Every conflicting line says "conflicting — and therefore untested" together, because said apart
 * the first half is a merge chore and the reader stops reading. See {@link ConflictingPr}'s header
 * for the mechanism (no `pull_request` event → no run ever created → checks ABSENT, not failing).
 *
 * ── STALE ENTRIES ARE REPORTED, AND ARE NEVER CALLED UNTESTED ────────────────────────────────────
 * "Untested" is claimed for `kind: "conflicting"` only. A mergeable-but-behind PR has had CI; its
 * problem is that the rebase gets more expensive, not that its correctness is unknown, and blurring
 * the two would cost the headline exactly the credibility it is built on. They are still reported,
 * because the moment a drifting PR goes conflicting is the moment it is too late to have noticed.
 *
 * ── WHAT IS NOT DECIDED HERE ─────────────────────────────────────────────────────────────────────
 * `kind` and `evidence` are the producer's classification and are taken as given. Re-deriving either
 * from `commitsBehind` would be a second opinion about the same PR, invisible to the tests that
 * cover the producer — the failure `fleetVerdict` names and `pusherSnapshots` refuses for the same
 * reason. This module composes sentences from evidence; it does not re-judge it.
 */
export function conflictCondition(
  conflicts: readonly ConflictingPr[],
  snapshots: readonly FleetSnapshot[],
): FleetCondition {
  // PRESENCE and NAME are separate facts here, so the map holds `undefined` for a roster agent with
  // no label rather than collapsing it into `nameOf`'s "an unnamed agent" fallback — which would
  // have produced the sentence "owner an unnamed agent".
  const labels = new Map(snapshots.map((s) => [s.agentId, s.label?.trim() || undefined] as const));

  // Conflicting before stale, then furthest-behind first — the order the reader should act in, and
  // fixed rather than incidental so the same evidence always produces the same bytes.
  const ordered = [...conflicts].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "conflicting" ? -1 : 1;
    return b.commitsBehind - a.commitsBehind;
  });
  const conflicting = ordered.filter((c) => c.kind === "conflicting");
  const stale = ordered.filter((c) => c.kind === "stale");

  const ages = ordered.map((c) => splitHoursMinutes(Math.max(0, c.unresolvedSecs) * 1000));

  const lines = ordered.map((c, i) => {
    const { h, m } = ages[i]!;
    const held = c.blockedBy ? ` Blocked by: ${c.blockedBy}.` : "";
    const who = ownerPhrase(c, labels);
    // CLAMPED AT ZERO, and this is a citation-safety rule rather than cosmetics. A negative count
    // renders as `-5`, from which `numbersIn` reads `5` — while `measured` would hold `-5`. The two
    // never match, so `gateChallenge` refuses the WHOLE report as `fabricated-citation`, and that
    // refusal presents as silence. One nonsensical field from the producer would therefore mute the
    // detector entirely. The parser rejects negatives at the boundary too; this is the half that
    // holds for any caller.
    const behind = `${behindOf(c)} commits behind main`;
    if (c.kind === "conflicting") {
      // The compound fact, in one clause, on every line — and never stronger than `evidence` allows.
      // See {@link testingPhrase}: `kind` alone cannot tell a directly-observed absence from an
      // inherited or unread verdict, because both arrive here as `conflicting`.
      return `  - #${c.pr} ${c.branch} — ${testingPhrase(c)}. ${behind}, unresolved for ${h}h ${m}m. ${who}.${held}`;
    }
    // "Mergeable" is `is_dirty: false` AS LAST READ. A refused look carries that value forward
    // rather than re-establishing it, so a `stale` row whose evidence is not current may not claim
    // it in the present tense — the same rule the conflicting lines above already follow.
    const merges = notCurrent(c)
      ? "last known to be mergeable — that reading is NOT current — but"
      : "mergeable, but";
    return `  - #${c.pr} ${c.branch} — ${merges} ${behind} and drifting further with every merge. Unresolved for ${h}h ${m}m. ${who}.${held}`;
  });

  const nC = conflicting.length;
  const nS = stale.length;
  // AN AGGREGATE MAY BE NO STRONGER THAN THE WEAKEST ROW IT COVERS. "Never been tested" is licensed
  // by the directly-observed absence and nothing else: a `checks-are-stale` row DID run CI, and an
  // inherited or unread row is a verdict nobody re-read — so the old absolute headline contradicted
  // the very sentence `testingPhrase` composes one line below it.
  const neverRan = conflicting.every((c) => c.evidence === "no-checks-ran");
  const staleRead = stale.every((c) => !notCurrent(c));
  const head =
    nC > 0
      ? `${nC} open ${nC === 1 ? "PR cannot" : "PRs cannot"} merge — and that means ${neverRan ? `${nC === 1 ? "it has" : "they have"} never been tested` : `nothing current has tested ${nC === 1 ? "it" : "them"}`}. ` +
        `A conflicting PR never fires GitHub's pull_request event, so no CI run is ever created for it: the checks ` +
        `are not failing, they are ABSENT. Conflicting and untested are one fact, not two.` +
        (nS > 0
          ? ` ${nS} more ${staleRead ? "can still merge" : `${nS === 1 ? "was" : "were"} last known to merge`}, but ${nS === 1 ? "is" : "are"} drifting behind main.`
          : "")
      : `${nS} open ${nS === 1 ? "PR is" : "PRs are"} behind main and drifting further with every merge. ` +
        `Each ${staleRead ? "can still merge today" : "was last known to merge, on a reading that is NOT current"}; what grows is the rebase.`;

  // Only when there IS a conflict to resolve. A remedy sentence about conflicts appended to a
  // stale-only report is advice about a situation the report just said does not hold.
  const remedy =
    nC > 0
      ? `\nA conflict on a branch that is only one commit ahead of main is usually resolvable without ` +
        `judgement: rebase onto main and push, and ${neverRan ? "the CI run it has never had" : "the CI run it is missing"} arrives with it.`
      : "";

  return {
    id: "pr-conflicting",
    // RESOLVED OWNERS ONLY. `null` is UNRESOLVED, and this list is what the surface turns into agent
    // pills — a placeholder here would open the wrong agent. The unresolved PRs are not lost: they
    // are named in the text, and said to be unresolved, which is the whole reason the text carries
    // them rather than leaving the reader to infer them from a list of ids.
    agentIds: [...new Set(ordered.map((c) => c.ownerAgentId).filter((id): id is string => id !== null))],
    // THE PR NUMBER IS THE IDENTITY, and it is what makes this class's cooldown work at all. The
    // `agentIds` above are resolved owners ONLY, and the PRs this class was built for resolve to
    // none — so the growth rule had nothing to compare and a new conflicting PR was silent for four
    // hours. GitHub's number is the one handle that exists for every PR, resolved owner or not.
    //
    // A CONFLICTING PR CARRIES A SECOND MEMBER, so that a PR going stale → conflicting registers as
    // GROWTH rather than as a change the growth-only rule ignores. That transition is the moment
    // the PR stops being tested at all, which is the whole fact this class exists to carry, and it
    // would otherwise wait out the cooldown in silence. Emitting BOTH members for a conflicting PR
    // (rather than swapping one for the other) is what keeps the rule growth-only: the reverse trip
    // conflicting → stale is an IMPROVEMENT and is a strict subset of what was already said, so it
    // stays quiet, and a PR that flaps back finds the stamp already covering it.
    members: [
      ...new Set(
        ordered.flatMap((c) =>
          c.kind === "conflicting" ? [`pr:${c.pr}`, `pr:${c.pr}:conflicting`] : [`pr:${c.pr}`],
        ),
      ),
    ],
    measured: [
      String(nC),
      String(nS),
      ...ordered.flatMap((c) => [String(c.pr), String(behindOf(c))]),
      ...ages.flatMap(({ h, m }) => [String(h), String(m)]),
      // Branch names, labels and hold reasons are reproduced character-for-character, so whatever
      // digits they carry are quoted rather than computed — the widening this module's header names.
      ...quotedNumbers(
        ...ordered.flatMap((c) => [c.branch, c.blockedBy]),
        ...ordered.map((c) => (c.ownerAgentId === null ? undefined : labels.get(c.ownerAgentId))),
      ),
    ],
    text: `${head}\n${lines.join("\n")}${remedy}`,
  };
}

function escalationCondition(escalated: readonly FleetSnapshot[]): FleetCondition {
  const n = escalated.length;
  const plural = n === 1 ? "goal is" : "goals are";

  // Each agent's blocker, one per line — the founder's ask was that ONE glance clears eight, and a
  // count with no blockers would send him back to the eight rows he was already not reading.
  const lines = escalated.map((s) => {
    const reason = s.escalation?.reason?.trim();
    return reason ? `  - ${nameOf(s)} — ${reason}` : `  - ${nameOf(s)} — no reason was recorded`;
  });

  return {
    id: "goals-escalated",
    agentIds: escalated.map((s) => s.agentId),
    members: agentMembers(escalated),
    measured: [
      String(n),
      ...quotedNumbers(...escalated.flatMap((s) => [s.label, s.escalation?.reason])),
    ],
    // ── WHAT THE READER IS BEING TOLD IS WHY *THEY* ARE THE ONE HOLDING IT ─────────────────────────
    // This sentence used to read "the concierge cannot re-arm an escalated goal — the app reserves
    // it for you by design", which was true until the concierge got a BOUNDED re-arm lever
    // (agentGoal's `rearmGoal` / MAX_CONCIERGE_REARMS). It can now clear a machine give-up, twice,
    // and each clear spends one of an allowance ONLY a human refills by typing to the agent.
    //
    // So the honest claim is no longer "nothing but you can retry this" — it is that retrying has
    // either already been spent here or was never the answer. Deliberately vague about WHICH:
    // `FleetSnapshot.escalation` carries a reason and nothing else, so this function cannot tell the
    // two apart, and inventing a per-row verdict it has not measured is exactly what the citation
    // gate exists to stop.
    //
    // NO DIGITS. The bound is stated in words rather than as `2` because every number rendered here
    // must appear in `measured`, and the constant lives in the desktop app (which depends on this
    // package, not the other way round) — so a numeral would either be a hardcoded copy that can
    // drift from the engine or a fabricated citation that mutes the whole report.
    text:
      `${n} ${plural} escalated. The concierge may re-arm a goal a bounded number of times, and ` +
      `only your typing to the agent refills that allowance — so these have either run out of ` +
      `re-arms or need a person rather than another retry:\n${lines.join("\n")}`,
  };
}

/**
 * The uncommitted-file count as the report may quote it.
 *
 * CLAMPED AND TRUNCATED for exactly the reason `behindOf` is, and the failure is the same shape: a
 * negative renders as `-3`, from which `numbersIn` reads `3` while `measured` holds `-3`. The two
 * never match, so the gate refuses the WHOLE report as `fabricated-citation` — and a refusal
 * presents as SILENCE, so one nonsensical field from the producer would mute the one condition
 * whose evidence a spin-down deletes.
 */
function dirtyCountOf(snap: FleetSnapshot): number | undefined {
  return snap.dirtyCount === undefined ? undefined : Math.max(0, Math.trunc(snap.dirtyCount));
}

/**
 * Sessions that ended holding work nobody has committed.
 *
 * ── THE SENTENCE HAS TO NAME THE DECISION, NOT THE STATE ────────────────────────────────────────
 * The reader is being asked to decide something before doing something else, so the text carries
 * three things and drops none of them: WHICH agent, HOW MANY uncommitted files, and that the files
 * are gone if the worktree is torn down. Nothing here reads as housekeeping — this is deliberately
 * not phrased like `done-not-retired`, whose whole content is "safe to retire". Retiring one of
 * THESE agents is the destructive act, and a sentence that let a hurried reader mistake one for the
 * other would be worse than no sentence at all.
 *
 * ── THE COUNT IS NEVER INVENTED ─────────────────────────────────────────────────────────────────
 * `dirtyCount` is independently optional from `dirty` (an older Rust build sends one without the
 * other), and an absent count is UNKNOWN rather than zero. Printing a 0 there would say the exact
 * opposite of the fact the line exists to carry, so the line says the number was not recorded and
 * still names the agent — the founder can still go and look, which is the whole point.
 */
function diedHoldingWorkCondition(dead: readonly FleetSnapshot[]): FleetCondition {
  const n = dead.length;
  const counts = dead.map(dirtyCountOf);

  const lines = dead.map((s, i) => {
    const c = counts[i];
    const files =
      c === undefined
        ? "uncommitted files (this build did not record how many)"
        : `${c} uncommitted file${c === 1 ? "" : "s"}`;
    return `  - ${nameOf(s)} — ${files}, committed to no branch. Its goal was never marked met.`;
  });

  const plural = n === 1 ? "agent's session ended" : "agents' sessions ended";
  const those = n === 1 ? "that agent" : "those agents";
  return {
    id: "died-holding-work",
    agentIds: dead.map((s) => s.agentId),
    members: agentMembers(dead),
    measured: [
      String(n),
      ...counts.filter((c): c is number => c !== undefined).map(String),
      ...quotedNumbers(...dead.map((s) => s.label)),
    ],
    text:
      `${n} ${plural} while the goal was still unmet, leaving uncommitted work that exists ` +
      `nowhere but the worktree:\n${lines.join("\n")}\n` +
      `Retiring ${those} — or tearing the worktree down — DELETES that work; it is on no branch, ` +
      `so nothing else in git is holding it. Decide what to keep, and commit or copy it out, ` +
      `before anything is torn down.`,
  };
}

function retireCondition(retirable: readonly FleetSnapshot[]): FleetCondition {
  const n = retirable.length;
  const plural = n === 1 ? "agent has" : "agents have";
  const lines = retirable.map((s) => `  - ${nameOf(s)}`);

  return {
    id: "done-not-retired",
    agentIds: retirable.map((s) => s.agentId),
    members: agentMembers(retirable),
    measured: [String(n), ...quotedNumbers(...retirable.map((s) => s.label))],
    text:
      `${n} ${plural} met their goal with no unlanded work, and are still open — each one holds a ` +
      `slot and is retried on every resume. Safe to retire:\n${lines.join("\n")}`,
  };
}

/**
 * The condition ids present in BOTH the previous sweep and this one.
 *
 * The same two-observation rule `persistedTriggers` applies, and for the same reason — but note that
 * the cost of the rule is close to zero here, because none of these conditions is transient.
 * A quota wall stands for hours, an escalation is latched, and a met goal stays met. The rule earns
 * its keep against a partial read: a store mid-refresh that reports an empty roster, or a branch
 * poll that has not landed yet, clears itself by the next sweep and never reaches the founder.
 */
export function persistedConditions(
  previous: readonly FleetCondition[],
  current: readonly FleetCondition[],
): FleetCondition[] {
  const before = new Set(previous.map((c) => c.id));
  return current.filter((c) => before.has(c.id));
}
