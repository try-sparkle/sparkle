// THE PROPERTY: the ORDER the pieces run in, which is the only thing the individual modules cannot
// test about themselves.
//
// Two ordering bugs would pass every existing test while behaving wrong, so both are pinned here:
// forgetting this cycle's sighting on a quiet path (the Pusher then goes permanently silent, and it
// looks exactly like a healthy fleet), and spending a budget slot on a message the gate refused or
// the transport dropped (four an hour is a small budget to spend on nothing).
import { describe, it, expect } from "vitest";
import {
  decidePusherAction,
  emptyPartnerMemory,
  type DecideInput,
  type PusherDecision,
  type PartnerMemory,
} from "./pusherDecide";
import { resolvePusherPolicy } from "./pusherPolicy";
import { MESSAGES_PER_HOUR, REPEAT_COOLDOWN_MS } from "./pusherGate";
import { evaluateTriggers, type Observation } from "./pusherTriggers";

const T0 = 1_700_000_000_000;
const MIN = 60_000;
const POLICY = resolvePusherPolicy({});

/** An observation with an expired, unmet goal — the design's highest-value trigger. */
const expiredGoal = (now = T0): Observation => ({
  goalExpiresAt: now - (3 * 60 + 12) * MIN,
  goalMet: false,
  roborevRounds: 0,
  now,
});

const quietObs = (now = T0): Observation => ({ goalMet: false, roborevRounds: 0, now });

function decide(over: Partial<DecideInput> = {}): PusherDecision {
  return decidePusherAction({
    policy: POLICY,
    observation: expiredGoal(),
    memory: emptyPartnerMemory(),
    inbox: { used: 0, capacity: 50 },
    now: T0,
    ...over,
  });
}

function sent(d: PusherDecision): Extract<PusherDecision, { action: "send" }> {
  if (d.action !== "send") throw new Error(`expected a send, got ${JSON.stringify(d)}`);
  return d;
}
function quiet(d: PusherDecision): Extract<PusherDecision, { action: "quiet" }> {
  if (d.action !== "quiet") throw new Error(`expected quiet, got ${JSON.stringify(d)}`);
  return d;
}

describe("the two-observation rule, end to end", () => {
  it("says nothing on the FIRST sighting", () => {
    expect(quiet(decide()).reason).toBe("no-persisted-trigger");
  });

  it("speaks on the second consecutive sighting", () => {
    const first = quiet(decide());
    const second = sent(decide({ memory: first.memory }));
    expect(second.triggerId).toBe("goal-expired");
    expect(second.text).toBe("Your goal expired 3h 12m ago and is still unmet.");
    expect(second.cited).toEqual(["3", "12"]);
  });

  // RULE 1. If a quiet cycle forgot what it saw, the second sighting is never the second — the
  // Pusher goes permanently silent and looks exactly like a healthy fleet.
  it("records this cycle's triggers even when it says nothing", () => {
    const first = quiet(decide());
    expect(first.memory.lastTriggers.map((t) => t.id)).toEqual(["goal-expired"]);
  });

  it("forgets a condition that cleared, so a later recurrence needs two sightings again", () => {
    const first = quiet(decide());
    const cleared = quiet(decide({ observation: quietObs(), memory: first.memory }));
    expect(cleared.reason).toBe("no-trigger");
    expect(cleared.memory.lastTriggers).toEqual([]);
    // Back again: this is a first sighting once more, not a second.
    expect(quiet(decide({ memory: cleared.memory })).reason).toBe("no-persisted-trigger");
  });
});

describe("the budget is spent only on a delivery", () => {
  // RULE 2. `memoryOnDelivered` is separate precisely so a failed transport costs nothing.
  it("does not advance the budget in the returned send itself", () => {
    const first = quiet(decide());
    const second = sent(decide({ memory: first.memory }));
    // The caller still holds the pre-send memory; only memoryOnDelivered has the slot spent.
    expect(first.memory.budget.sentAt).toEqual([]);
    expect(second.memoryOnDelivered.budget.sentAt).toEqual([T0]);
  });

  it("refuses once the hourly budget is gone, and does not spend another slot doing so", () => {
    const primed: PartnerMemory = {
      lastTriggers: evaluateTriggers(expiredGoal()),
      budget: { sentAt: Array(MESSAGES_PER_HOUR).fill(T0 - MIN) },
      lastChallengedAt: {},
    };
    const d = quiet(decide({ memory: primed }));
    expect(d.reason).toBe("budget-exhausted");
    expect(d.memory.budget.sentAt).toHaveLength(MESSAGES_PER_HOUR);
  });
});

describe("the repeat cooldown, end to end", () => {
  it("stays quiet about a latched condition already challenged", () => {
    const primed: PartnerMemory = {
      lastTriggers: evaluateTriggers(expiredGoal()),
      budget: { sentAt: [] },
      lastChallengedAt: { "goal-expired": T0 - MIN },
    };
    expect(quiet(decide({ memory: primed })).reason).toBe("repeat-suppressed");
  });

  it("speaks again once the cooldown has elapsed", () => {
    const now = T0 + REPEAT_COOLDOWN_MS;
    const primed: PartnerMemory = {
      lastTriggers: evaluateTriggers(expiredGoal(now)),
      budget: { sentAt: [] },
      lastChallengedAt: { "goal-expired": T0 },
    };
    expect(decide({ memory: primed, observation: expiredGoal(now), now }).action).toBe("send");
  });

  // The cooldown is per EPISODE: a stamp for a trigger that stopped firing is expired, so the next
  // occurrence is heard rather than being silenced by the previous one.
  it("expires the stamp of a trigger that is no longer firing", () => {
    const primed: PartnerMemory = {
      lastTriggers: [],
      budget: { sentAt: [] },
      lastChallengedAt: { "goal-expired": T0 - MIN, "unpushed-commits": T0 - MIN },
    };
    const d = quiet(decide({ memory: primed }));
    expect(Object.keys(d.memory.lastChallengedAt)).toEqual(["goal-expired"]);
  });
});

describe("the kill switch and the inbox yield reach the decision", () => {
  it("says nothing at all when disabled, whatever is wrong", () => {
    const disabled = resolvePusherPolicy({ enabled: false });
    const primed: PartnerMemory = {
      lastTriggers: evaluateTriggers(expiredGoal()),
      budget: { sentAt: [] },
      lastChallengedAt: {},
    };
    expect(quiet(decide({ policy: disabled, memory: primed })).reason).toBe("disabled");
  });

  it("yields to the concierge on a backed-up inbox", () => {
    const primed: PartnerMemory = {
      lastTriggers: evaluateTriggers(expiredGoal()),
      budget: { sentAt: [] },
      lastChallengedAt: {},
    };
    const d = quiet(decide({ memory: primed, inbox: { used: 45, capacity: 50 } }));
    expect(d.reason).toBe("inbox-yielding");
  });

  // A config that lowered the budget must bind here, not just in the resolver.
  it("honours a config-lowered budget", () => {
    const strict = resolvePusherPolicy({ messages_per_hour: 1 });
    const primed: PartnerMemory = {
      lastTriggers: evaluateTriggers(expiredGoal()),
      budget: { sentAt: [T0 - MIN] },
      lastChallengedAt: {},
    };
    expect(quiet(decide({ policy: strict, memory: primed })).reason).toBe("budget-exhausted");
  });
});

describe("a healthy partner", () => {
  it("is reported as no-trigger, distinct from being suppressed", () => {
    const d = quiet(decide({ observation: quietObs() }));
    expect(d.reason).toBe("no-trigger");
    expect(d.memory.lastTriggers).toEqual([]);
  });
});
