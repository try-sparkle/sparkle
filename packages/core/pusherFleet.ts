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
  /** Goals auto-continue gave up on. Reserved for the human by design, so a dead end until seen. */
  | "goals-escalated"
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
   * Whether this agent is holding work that has not landed.
   *
   * For the retire claim this must be affirmatively `false` — see {@link retirableAgents}. This is
   * the one place in the Pusher where the fail-closed rule has teeth beyond noise: a "safe to
   * retire" said over missing data tells the founder to discard an agent that may be holding
   * unmerged commits.
   */
  hasUnlandedWork?: boolean;
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
 * The evidence bar is deliberately higher than anywhere else in the Pusher: the goal must be met AND
 * `hasUnlandedWork` must be affirmatively `false`. `undefined` — "no branch status was polled for
 * this agent" — fails the test, because the cost of being wrong here is not a noisy message. It is a
 * recommendation to retire an agent holding work nobody has merged.
 */
export function retirableAgents(snapshots: readonly FleetSnapshot[]): FleetSnapshot[] {
  return snapshots.filter((s) => s.goalMetAt !== undefined && s.hasUnlandedWork === false);
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
): FleetCondition[] {
  const out: FleetCondition[] = [];

  const walled = snapshots.filter((s) => isQuotaWalled(s, now));
  if (walled.length > 0) out.push(quotaCondition(walled));

  const cohorts = sharedFailureCohorts(snapshots, now);
  if (cohorts.length > 0) out.push(sharedFailureCondition(cohorts, now));

  const overdue = overdueDuties(duties, now);
  if (overdue.length > 0) out.push(dutyCondition(overdue));

  // FAIL CLOSED. `undefined` (never looked, or the probe failed) and `[]` (looked, nothing wrong)
  // both report nothing — but only one of them is allowed to be manufactured by a caller, and it is
  // not this one. The producer is where the two must not be conflated; see `conflictFlags.ts`.
  if (conflicts !== undefined && conflicts.length > 0) {
    out.push(conflictCondition(conflicts, snapshots));
  }

  const escalated = snapshots.filter((s) => s.escalation !== undefined);
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
    text:
      `${n} ${plural} escalated. Auto-continue gave up and the concierge cannot re-arm an ` +
      `escalated goal — the app reserves it for you by design, so it stays a dead end until you ` +
      `clear it:\n${lines.join("\n")}`,
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
