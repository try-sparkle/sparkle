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
 * What one sweep knows about one agent, for the fleet report.
 *
 * Every field is optional and three-valued in the same way `PartnerSnapshot`'s are: present-and-true,
 * present-and-false, or ABSENT meaning WE DID NOT LOOK. `undefined` never satisfies anything here —
 * see `pusherObserve`'s header for why an absent input must not manufacture a claim.
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
  /** Every number the report may quote for this condition — counts plus {@link quotedNumbers}. */
  measured: string[];
  /** The finished sentence(s). Built only from `measured`; no model composes it. */
  text: string;
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
 */
export function evaluateFleetConditions(
  snapshots: readonly FleetSnapshot[],
  now: number,
  duties: readonly StandingDuty[] = [],
): FleetCondition[] {
  const out: FleetCondition[] = [];

  const walled = snapshots.filter((s) => isQuotaWalled(s, now));
  if (walled.length > 0) out.push(quotaCondition(walled));

  const cohorts = sharedFailureCohorts(snapshots, now);
  if (cohorts.length > 0) out.push(sharedFailureCondition(cohorts, now));

  const overdue = overdueDuties(duties, now);
  if (overdue.length > 0) out.push(dutyCondition(overdue));

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
