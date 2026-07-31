// THE THREE CONDITIONS A PARTNER CANNOT BE TOLD ABOUT — and why they are reported as ONE message
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

/** The fleet-level conditions a Phase 1 Pusher may report. */
export type FleetConditionId =
  /** Agents held behind an account limit — cannot run at all, and cannot be restarted into running. */
  | "quota-blocked"
  /** Goals auto-continue gave up on. Reserved for the human by design, so a dead end until seen. */
  | "goals-escalated"
  /** Goal met, nothing unlanded — occupying a slot for no reason. */
  | "done-not-retired";

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
 * The conditions that hold across the fleet, most-blocking first.
 *
 * ORDER IS A PRIORITY. Quota-blocked leads because it is the only one of the three where the
 * ordinary remedy is actively wrong — a human or a machine that retries a quota-walled agent spends
 * turns achieving nothing, and `agentThrash` already documents that any output after such a banner
 * is "the auto-resume being refused, not progress". Escalated is next: a dead end, but one a human
 * can clear. Done-not-retired is last: waste, but nothing is stuck behind it.
 */
export function evaluateFleetConditions(
  snapshots: readonly FleetSnapshot[],
  now: number,
): FleetCondition[] {
  const out: FleetCondition[] = [];

  const walled = snapshots.filter((s) => isQuotaWalled(s, now));
  if (walled.length > 0) out.push(quotaCondition(walled));

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
 * the cost of the rule is close to zero here, because none of these three conditions is transient.
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
