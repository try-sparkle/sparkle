// ONE SWEEP, ONE REPORT — the fleet-level analogue of `decidePusherAction`, composed and pure.
//
// ── WHY THE BATCH IS THE UNIT ────────────────────────────────────────────────────────────────────
// Eight escalated goals is eight facts and ONE message. Sending one per agent would spend the whole
// hourly budget twice over to deliver a list, and a list is what the reader wanted in the first
// place. So the budget is charged ONCE for the report, however many conditions and agents it covers.
//
// That is not a loophole in `MESSAGES_PER_HOUR` — it is the reading of it that makes the number mean
// anything. The budget bounds INTERRUPTIONS, and a report is one interruption.
//
// ── THE COOLDOWN IS PER CONDITION, THE MESSAGE IS PER SWEEP ──────────────────────────────────────
// These conditions latch harder than any per-partner trigger: a weekly limit stands for days, and
// `escalatedAt` never clears itself. Keyed on one id, `REPEAT_COOLDOWN_MS` would then behave in one
// of two wrong ways — silence a NEW condition that appeared during a quota block's cooldown, or
// re-send the identical quota paragraph every time an unrelated agent finished.
//
// So the cooldown is evaluated PER CONDITION and the surviving conditions are batched into one
// message. An unchanged condition drops out of the text while its neighbours are still reported;
// each is heard on its own clock.
//
// ── ...AND ONLY GROWTH STARTS A NEW EPISODE (roborev 56908, then 56973) ─────────────────────────
// Keying on the class id alone reintroduced the exact failure this feature exists to close, and it
// is worth spelling out because the bug is invisible in every test that looks at one sweep.
//
// `expireClearedTriggers` keeps a stamp alive while ANY agent is still in the class. So: sweep A
// reports "2 agents are quota-blocked". Ten minutes later four more agents hit the same wall. Every
// later sweep computes a fresh, larger condition and then discards the whole batch as
// `all-conditions-cooled`, because the original two keep the class continuously active. The founder
// hears about the four new agents up to FOUR HOURS late — "agents sat blocked for hours and I found
// them by screenshot", rebuilt inside the fix for it. Escalations latch permanently, so that class
// stamp never expires on its own at all.
//
// So the stamp records WHO it covered, and a condition becomes eligible again when the current set
// contains an agent the stamp does not — GROWTH, and growth only.
//
// THE FIRST ATTEMPT KEYED THE STAMP ON THE MEMBERSHIP SET ITSELF, which is a different rule and a
// worse one. Any change minted a new key, so a SHRINKING condition re-reported too, and because a
// key nobody is covering is expired every sweep, a set that flapped A→B→A re-sent the byte-identical
// text with no stamp left to stop it. Membership churn is not hypothetical: `retirableAgents`
// demands `hasUnlandedWork === false`, so an agent whose branch poll returns `undefined` on
// alternate sweeps toggles `done-not-retired`, and walls lift one agent at a time. Growth-only keeps
// the four-hour fix and drops all of that: a shrink and a flap-back both leave the stamp intact.
//
// A NOTE ON WHAT DOES *NOT* BOUND THIS, because the first version claimed it did. The
// two-observation rule bounds nothing here: `persistedConditions` compares CLASS IDS, so a class
// that persists with entirely different membership still passes it. `MESSAGES_PER_HOUR` is the real
// bound, and now the growth rule is the thing that keeps ordinary churn from spending it.
//
// ── HOW THE GATE STAYS THE CHOKEPOINT ────────────────────────────────────────────────────────────
// `gateChallenge` re-checks the repeat rule, and it is handed the class id plus the stamp's time —
// but the stamp is WITHHELD for a condition this module has ruled a new episode by growth. That is a
// translation of the same rule into the gate's vocabulary, not a bypass: "a new episode" and "the
// thing we already said" are different facts, and the gate has no way to express membership. What it
// still independently enforces is the TIME half, so a bug in the elapsed comparison below is caught
// there rather than by the founder. The alternative — encoding membership in the id — is what
// produced the flapping bug above, so the coarser gate key is the deliberate choice.

import {
  gateChallenge,
  recordSend,
  REPEAT_COOLDOWN_MS,
  type BudgetState,
  type GateRefusal,
  type InboxReading,
} from "./pusherGate";
import {
  evaluateFleetConditions,
  persistedConditions,
  type StandingDuty,
  type ConflictingPr,
  type FleetCondition,
  type FleetConditionId,
  type FleetSnapshot,
} from "./pusherFleet";
import type { PusherPolicy } from "./pusherPolicy";

/** What the Pusher remembers about the FLEET between sweeps. Callers own persistence. */
export interface FleetMemory {
  /** The conditions the PREVIOUS sweep found — the other half of the two-observation rule. */
  lastConditions: readonly FleetCondition[];
  /**
   * Delivery timestamps for the REPORT channel.
   *
   * Separate from every partner's budget on purpose. The report does not go to a partner, so
   * charging one partner's four-an-hour for a message about eight OTHER agents would silence a
   * builder that had done nothing — and would make which builder gets silenced depend on iteration
   * order.
   */
  budget: BudgetState;
  /**
   * condition id → when it was last reported AND who it covered then.
   *
   * The membership is what makes the cooldown a per-EPISODE rule rather than a per-topic one: a
   * newly affected agent is news, a departing one is not. See the header for the four-hour blind
   * spot the naive class-only version cost, and for why encoding membership in the KEY was worse.
   */
  lastReported: Readonly<Record<string, ReportStamp>>;
}

/** When a condition was last reported, and exactly who it covered at that moment. */
export interface ReportStamp {
  at: number;
  agentIds: readonly string[];
}

/**
 * Has this condition grown since it was last reported? An absent stamp is not growth — it is a
 * condition that has never been reported, which the cooldown does not apply to at all.
 */
export function hasNewMember(condition: FleetCondition, stamp: ReportStamp | undefined): boolean {
  if (stamp === undefined) return false;
  const covered = new Set(stamp.agentIds);
  return condition.agentIds.some((id) => !covered.has(id));
}

/**
 * This sweep's sighting, with the cooldown stamps of every condition that is no longer firing
 * dropped — the memory to store when nothing is sent.
 *
 * Exported because THREE non-sending paths need exactly this and each one that computed its own got
 * it subtly wrong (roborev 56908): the caller's no-recipient path, its undelivered path, and every
 * quiet return below. A condition that resolves and returns must be heard immediately, and that is
 * only true if its stamp was dropped while it was absent.
 */
export function fleetObservationMemory(
  memory: FleetMemory,
  conditions: readonly FleetCondition[],
): FleetMemory {
  // Same per-episode rule `expireClearedTriggers` implements, restated because the value is a stamp
  // rather than a number. A class that is no longer firing at all has genuinely resolved, so its
  // stamp goes and its return is heard immediately.
  const active = new Set(conditions.map((c) => c.id));
  const lastReported: Record<string, ReportStamp> = {};
  for (const [id, stamp] of Object.entries(memory.lastReported)) {
    if (active.has(id as FleetConditionId)) lastReported[id] = stamp;
  }
  return { lastConditions: conditions, budget: memory.budget, lastReported };
}

/** A fleet the Pusher has not looked at yet. */
export function emptyFleetMemory(): FleetMemory {
  return { lastConditions: [], budget: { sentAt: [] }, lastReported: {} };
}

export interface FleetReportSend {
  action: "send";
  /** The condition ids this report covers, most-blocking first. */
  conditionIds: string[];
  text: string;
  /** The measured numbers the text cites, for the log. */
  cited: string[];
  /** The memory to store AFTER the transport confirms — see `pusherDecide`'s rule 2. */
  memoryOnDelivered: FleetMemory;
  /**
   * The memory to store when the transport does NOT confirm: this sweep's sighting and the expired
   * cooldowns, with no stamp and no budget spent.
   *
   * Returned rather than left to the caller to reconstruct, because reconstructing it means
   * re-deriving the cooldown expiry and the caller that tried got it wrong (roborev 56908).
   */
  memoryOnFailure: FleetMemory;
}

export interface FleetReportQuiet {
  action: "quiet";
  /**
   * Why nothing was reported.
   *
   * `no-condition` and `no-persisted-condition` are distinct for the same reason `pusherDecide`
   * keeps `no-trigger` and `no-persisted-trigger` distinct: one says the fleet is healthy, the other
   * says the anti-noise rule is working, and a hit-rate log that collapses them can answer neither
   * question. `all-conditions-cooled` is a third: everything here was already reported recently, and
   * conflating it with silence would read as "the fleet cleared up".
   */
  reason: GateRefusal | "no-condition" | "no-persisted-condition" | "all-conditions-cooled";
  /** The memory to store now. Always applied: the two-observation rule depends on it. */
  memory: FleetMemory;
}

export type FleetReportDecision = FleetReportSend | FleetReportQuiet;

export interface FleetReportInput {
  policy: PusherPolicy;
  snapshots: readonly FleetSnapshot[];
  /**
   * The app's standing recurring duties, for the `duty-overdue` condition.
   *
   * Threaded rather than defaulted at the evaluator (roborev 57323): `evaluateFleetConditions` takes
   * `duties` with a `[]` default, so a caller that simply forgot to pass them still compiles and
   * silently reports nothing. Making it a required field of this input means the omission is a type
   * error at every call site instead of a condition that can never fire.
   */
  duties: readonly StandingDuty[];
  /**
   * Open PRs that cannot merge, for the `pr-conflicting` condition — or `undefined` for WE DID NOT
   * LOOK.
   *
   * REQUIRED BUT NULLABLE, which is the shape the three-valued rule needs at a call site. Making it
   * optional would let a caller that simply forgot compile into the same state as one that genuinely
   * could not read `gh`, and the two are different facts (roborev 57323 made `duties` required for
   * the weaker version of this: an omission that silently becomes a condition which can never fire).
   * Here the omission is worse, because it is indistinguishable from an all-clear.
   */
  conflicts: readonly ConflictingPr[] | undefined;
  memory: FleetMemory;
  /** The RECIPIENT's mailbox — the surface the report is delivered to, not any partner's. */
  inbox: InboxReading;
  now: number;
}

/**
 * Decide what — if anything — to report about the fleet this sweep.
 *
 * Never sends, never logs, never reads a clock. The caller applies `memory` immediately on the quiet
 * path and `memoryOnDelivered` only once the transport confirms.
 */
export function decideFleetReport(input: FleetReportInput): FleetReportDecision {
  const { policy, snapshots, duties, conflicts, memory, inbox, now } = input;

  const current = evaluateFleetConditions(snapshots, now, duties, conflicts);

  // COMPUTED FIRST AND UNCONDITIONALLY, exactly as `decidePusherAction` does it: every early return
  // below carries this sweep's sighting, so there is no path on which the two-observation rule loses
  // a cycle and the report goes permanently silent while the fleet looks healthy.
  const base = fleetObservationMemory(memory, current);

  const quiet = (reason: FleetReportQuiet["reason"]): FleetReportQuiet => ({
    action: "quiet",
    reason,
    memory: base,
  });

  if (!policy.enabled) return quiet("disabled");

  if (current.length === 0) return quiet("no-condition");
  const persisted = persistedConditions(memory.lastConditions, current);
  if (persisted.length === 0) return quiet("no-persisted-condition");

  // Per-condition cooldown, re-opened only by GROWTH (see the header). Read from `base.lastReported`
  // rather than `memory.lastReported` so a condition that cleared and returned is heard again — the
  // stamp for an absent condition was already dropped above.
  const fresh = persisted.filter((c) => {
    const stamp = base.lastReported[c.id];
    return stamp === undefined || now - stamp.at >= REPEAT_COOLDOWN_MS || hasNewMember(c, stamp);
  });
  if (fresh.length === 0) return quiet("all-conditions-cooled");

  // `evaluateFleetConditions` orders by how totally the condition blocks work, and both filters
  // above preserve that order, so `fresh[0]` is a priority rather than an accident of iteration.
  const top = fresh[0]!;

  const text = fresh.map((c) => c.text).join("\n\n");
  // The union of every surviving condition's measured values. A number may be cited if ANY included
  // condition measured it — which is correct precisely because the text is the concatenation of those
  // same conditions, and no number enters the union without a condition having measured or quoted it.
  const measured = [...new Set(fresh.flatMap((c) => c.measured))];

  const verdict = gateChallenge({
    enabled: true,
    challenge: { rung: 1, triggerId: top.id, text, measured },
    persisted: true,
    budget: base.budget,
    inbox,
    now,
    // The stamp is withheld for a condition ruled a new episode by GROWTH — see the header. For
    // every other condition the gate re-checks the elapsed time itself.
    lastChallengedAt: hasNewMember(top, base.lastReported[top.id])
      ? {}
      : { [top.id]: base.lastReported[top.id]?.at ?? 0 },
    limits: { messagesPerHour: policy.messagesPerHour, inboxYieldPct: policy.inboxYieldPct },
  });

  if (!verdict.ok) return quiet(verdict.reason);

  // Every included condition is stamped, not just `top` — otherwise the ones batched alongside it
  // would be reported again on the very next sweep, which is the repetition the cooldown exists to
  // stop and would arrive inside the same message as the one that IS suppressed.
  const stamped: Record<string, ReportStamp> = { ...base.lastReported };
  for (const c of fresh) stamped[c.id] = { at: now, agentIds: [...c.agentIds] };

  return {
    action: "send",
    conditionIds: fresh.map((c) => c.id),
    text: verdict.text,
    cited: verdict.cited,
    memoryOnDelivered: {
      lastConditions: base.lastConditions,
      budget: recordSend(base.budget, now),
      lastReported: stamped,
    },
    memoryOnFailure: base,
  };
}
