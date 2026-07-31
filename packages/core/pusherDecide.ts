// ONE PARTNER, ONE CYCLE, ONE ANSWER — the whole Pusher decision, composed and pure.
//
// ── WHY THIS EXISTS AS A SEPARATE MODULE ─────────────────────────────────────────────────────────
// The pieces were already testable in isolation: `evaluateTriggers` decides what is measurably
// true, `persistedTriggers` decides what has been true twice, `gateChallenge` decides what may be
// said. But nothing tested the ORDER they run in, and the order is where the remaining bugs live —
// a runner that gated before checking persistence, or recorded a send before the gate refused it,
// would pass every existing test while behaving wrong.
//
// So the composition is a function, and the impure runner around it does I/O and nothing else. The
// runner's job becomes: gather a snapshot, call this, obey the answer. That is a shape you can read
// in one screen and a shape whose every rule is already under test.
//
// ── THE TWO ORDERING RULES THAT MATTER ───────────────────────────────────────────────────────────
// 1. STATE ADVANCES EVEN WHEN NOTHING IS SENT. `lastTriggers` must be recorded on every cycle,
//    including the quiet ones, or the two-observation rule never sees a second consecutive sighting
//    and the Pusher goes permanently silent. This is the failure that would look exactly like
//    "working fine, nothing to report".
// 2. THE BUDGET IS SPENT ONLY ON A DELIVERY. Recording a send that the gate refused — or that the
//    transport then failed to deliver — burns a slot on a message nobody received. Four an hour is
//    a small budget to spend on nothing, so this module returns the NEXT state for a send and lets
//    the caller apply it only after the transport confirms.

import {
  gateChallenge,
  recordSend,
  recordChallenged,
  expireClearedTriggers,
  type BudgetState,
  type GateRefusal,
  type InboxReading,
} from "./pusherGate";
import { evaluateTriggers, persistedTriggers, type Observation, type Trigger } from "./pusherTriggers";
import type { PusherPolicy } from "./pusherPolicy";

/** What the Pusher remembers about one partner between cycles. Callers own persistence. */
export interface PartnerMemory {
  /** The triggers the PREVIOUS cycle found — the other half of the two-observation rule. */
  lastTriggers: readonly Trigger[];
  /** Delivery timestamps, for the rolling budget. */
  budget: BudgetState;
  /** trigger id → when it was last challenged, for the repeat cooldown. */
  lastChallengedAt: Readonly<Record<string, number>>;
}

/** A partner never seen before. */
export function emptyPartnerMemory(): PartnerMemory {
  return { lastTriggers: [], budget: { sentAt: [] }, lastChallengedAt: {} };
}

export interface DecisionSend {
  action: "send";
  triggerId: string;
  text: string;
  /** The measured numbers the text cites, for the log. */
  cited: string[];
  /**
   * The memory to store AFTER the transport confirms delivery.
   *
   * Separate from `memory` on the quiet path precisely because delivery can fail: applying this
   * eagerly would spend one of four hourly slots on a message that never arrived.
   */
  memoryOnDelivered: PartnerMemory;
}

export interface DecisionQuiet {
  action: "quiet";
  /** Why nothing was sent — a gate refusal, or `no-trigger` when nothing was measurably wrong. */
  reason: GateRefusal | "no-trigger";
  /** The memory to store now. Always applied: the two-observation rule depends on it. */
  memory: PartnerMemory;
}

export type PusherDecision = DecisionSend | DecisionQuiet;

export interface DecideInput {
  policy: PusherPolicy;
  observation: Observation;
  memory: PartnerMemory;
  inbox: InboxReading;
  now: number;
}

/**
 * Decide what — if anything — to say to one partner this cycle.
 *
 * Never sends, never logs, never reads a clock. The caller applies the returned memory: `memory`
 * immediately on the quiet path, `memoryOnDelivered` only once the transport confirms.
 */
export function decidePusherAction(input: DecideInput): PusherDecision {
  const { policy, observation, memory, inbox, now } = input;

  const current = evaluateTriggers(observation);

  // THE NEW MEMORY IS COMPUTED FIRST AND UNCONDITIONALLY. Every early return below carries it, so
  // there is no path on which this cycle's sighting is forgotten — which is what rule 1 in the
  // header is about. Cooldown stamps for triggers that have stopped firing are expired here too, so
  // a condition that cleared can be spoken about again the moment it returns.
  const base: PartnerMemory = {
    lastTriggers: current,
    budget: memory.budget,
    lastChallengedAt: expireClearedTriggers(
      memory.lastChallengedAt,
      current.map((t) => t.id),
    ),
  };

  const quiet = (reason: GateRefusal | "no-trigger"): DecisionQuiet => ({
    action: "quiet",
    reason,
    memory: base,
  });

  if (!policy.enabled) return quiet("disabled");

  // Nothing measurably wrong, or nothing wrong TWICE. Reported as distinct reasons because they
  // mean different things in the hit-rate log: one says the fleet is healthy, the other says the
  // anti-noise rule is doing its job.
  if (current.length === 0) return quiet("no-trigger");
  const persisted = persistedTriggers(memory.lastTriggers, current);
  if (persisted.length === 0) return quiet("no-persisted-trigger");

  // The first persisted trigger. `evaluateTriggers` orders by how directly the condition blocks
  // shipping, so "first" is a priority rather than an accident of iteration.
  const top = persisted[0]!;

  const verdict = gateChallenge({
    enabled: true,
    challenge: { rung: 1, triggerId: top.id, text: top.challenge, measured: top.measured },
    persisted: true,
    budget: base.budget,
    inbox,
    now,
    lastChallengedAt: base.lastChallengedAt,
    limits: { messagesPerHour: policy.messagesPerHour, inboxYieldPct: policy.inboxYieldPct },
  });

  if (!verdict.ok) return quiet(verdict.reason);

  return {
    action: "send",
    triggerId: top.id,
    text: verdict.text,
    cited: verdict.cited,
    memoryOnDelivered: {
      lastTriggers: base.lastTriggers,
      budget: recordSend(base.budget, now),
      lastChallengedAt: recordChallenged(base.lastChallengedAt, top.id, now),
    },
  };
}
