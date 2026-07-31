// THE PROPERTY: three conditions across many agents arrive as ONE message, charged ONCE, and each
// condition goes quiet on its own clock.
//
// The two ordering rules `pusherDecide` pins apply here verbatim and are re-pinned rather than
// assumed — this is a second composition, not the same one, and either bug would be silent. Forget
// the sighting on a quiet path and the report never fires while the fleet looks healthy; charge the
// budget for a message the transport dropped and four an hour buys three.
import { describe, it, expect } from "vitest";
import {
  decideFleetReport,
  emptyFleetMemory,
  type FleetMemory,
  type FleetReportDecision,
  type FleetReportInput,
} from "./pusherFleetReport";
import { evaluateFleetConditions, type FleetConditionId, type FleetSnapshot } from "./pusherFleet";

/** A stamp recording that `id` was reported at `at`, covering exactly `snapshots`. */
function stamp(snapshots: readonly FleetSnapshot[], id: FleetConditionId, at: number) {
  const c = evaluateFleetConditions(snapshots, T0).find((x) => x.id === id);
  if (!c) throw new Error(`no ${id} condition in fixture`);
  return { [id]: { at, agentIds: c.agentIds } };
}
import { resolvePusherPolicy } from "./pusherPolicy";
import { MESSAGES_PER_HOUR, REPEAT_COOLDOWN_MS, numbersIn } from "./pusherGate";

const T0 = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;
const POLICY = resolvePusherPolicy({});
const WEEKLY = "You've hit your weekly limit · resets Aug 4 at 11pm (America/Bogota)";

const walled = (id: string): FleetSnapshot => ({
  agentId: id,
  label: `Agent ${id}`,
  quota: { message: WEEKLY, resetAt: T0 + 4 * HOUR, resetParsed: true },
});
const escalated = (id: string): FleetSnapshot => ({
  agentId: id,
  label: `Agent ${id}`,
  escalation: { reason: "auto-continue gave up" },
});
const finished = (id: string): FleetSnapshot => ({
  agentId: id,
  label: `Agent ${id}`,
  goalMetAt: T0 - HOUR,
  hasUnlandedWork: false,
});

function decide(over: Partial<FleetReportInput> = {}): FleetReportDecision {
  return decideFleetReport({
    policy: POLICY,
    snapshots: [walled("a")],
    memory: emptyFleetMemory(),
    inbox: { used: 0, capacity: 50 },
    now: T0,
    ...over,
  });
}

/** Memory that already saw these snapshots once, so the two-observation rule is satisfied. */
function seen(snapshots: readonly FleetSnapshot[], over: Partial<FleetMemory> = {}): FleetMemory {
  return {
    ...emptyFleetMemory(),
    lastConditions: evaluateFleetConditions(snapshots, T0),
    ...over,
  };
}

describe("the batch", () => {
  const ALL = [walled("q1"), walled("q2"), escalated("e1"), escalated("e2"), finished("f1")];

  it("reports all three classes in ONE message", () => {
    const d = decide({ snapshots: ALL, memory: seen(ALL) });
    expect(d.action).toBe("send");
    if (d.action !== "send") return;
    expect(d.conditionIds).toEqual(["quota-blocked", "goals-escalated", "done-not-retired"]);
    expect(d.text).toContain("2 agents are quota-blocked");
    expect(d.text).toContain("2 goals are escalated");
    expect(d.text).toContain("1 agent has");
  });

  it("charges the hourly budget ONCE for the whole report", () => {
    const d = decide({ snapshots: ALL, memory: seen(ALL) });
    if (d.action !== "send") throw new Error("expected a send");
    expect(d.memoryOnDelivered.budget.sentAt).toEqual([T0]);
  });

  it("every number in the batched text is measured, across all three conditions", () => {
    const d = decide({ snapshots: ALL, memory: seen(ALL) });
    if (d.action !== "send") throw new Error("expected a send");
    // The gate already refused anything else; this asserts the citation set is COMPLETE rather than
    // merely non-empty, which is what a union built per-condition could silently get wrong.
    expect(new Set(d.cited)).toEqual(new Set(numbersIn(d.text)));
    expect(d.cited).toContain("11");
  });

  it("eight escalated goals cost ONE message, not eight", () => {
    const eight = Array.from({ length: 8 }, (_, i) => escalated(`e${i}`));
    const d = decide({ snapshots: eight, memory: seen(eight) });
    if (d.action !== "send") throw new Error("expected a send");
    expect(d.memoryOnDelivered.budget.sentAt).toHaveLength(1);
    expect(d.text).toContain("8 goals are escalated");
  });
});

describe("the two-observation rule", () => {
  it("stays quiet the first time a condition is seen", () => {
    const d = decide();
    expect(d).toMatchObject({ action: "quiet", reason: "no-persisted-condition" });
  });

  it("reports it the second time", () => {
    expect(decide({ memory: seen([walled("a")]) }).action).toBe("send");
  });

  // RULE 1 FROM `pusherDecide`, re-pinned. Drop this and the report is silent forever while every
  // surface says the fleet is fine.
  it("records this sweep's sighting even when nothing is sent", () => {
    const d = decide();
    if (d.action !== "quiet") throw new Error("expected quiet");
    expect(d.memory.lastConditions.map((c) => c.id)).toEqual(["quota-blocked"]);
  });

  it("records the sighting on the healthy path too", () => {
    const d = decide({ snapshots: [] });
    expect(d).toMatchObject({ action: "quiet", reason: "no-condition" });
    if (d.action !== "quiet") return;
    expect(d.memory.lastConditions).toEqual([]);
  });

  it("distinguishes a healthy fleet from the anti-noise rule working", () => {
    const healthy = decide({ snapshots: [] });
    const unpersisted = decide();
    expect((healthy as { reason: string }).reason).toBe("no-condition");
    expect((unpersisted as { reason: string }).reason).toBe("no-persisted-condition");
  });
});

describe("the per-condition cooldown", () => {
  const QandE = [walled("q"), escalated("e")];
  const TEN_MIN = 10 * 60_000;

  it("drops a cooled condition from the batch but still reports its neighbours", () => {
    const d = decide({
      snapshots: QandE,
      memory: seen(QandE, { lastReported: stamp(QandE, "quota-blocked", T0 - HOUR) }),
    });
    if (d.action !== "send") throw new Error("expected a send");
    expect(d.conditionIds).toEqual(["goals-escalated"]);
    expect(d.text).not.toContain("quota-blocked");
    expect(d.text).toContain("escalated");
  });

  it("goes quiet when EVERY condition is still cooling, with its own reason", () => {
    const d = decide({
      snapshots: QandE,
      memory: seen(QandE, {
        lastReported: {
          ...stamp(QandE, "quota-blocked", T0 - HOUR),
          ...stamp(QandE, "goals-escalated", T0 - HOUR),
        },
      }),
    });
    expect(d).toMatchObject({ action: "quiet", reason: "all-conditions-cooled" });
  });

  it("speaks again once the cooldown has fully elapsed", () => {
    const one = [walled("a")];
    const d = decide({
      snapshots: one,
      memory: seen(one, { lastReported: stamp(one, "quota-blocked", T0 - REPEAT_COOLDOWN_MS) }),
    });
    expect(d.action).toBe("send");
  });

  // THE FOUR-HOUR BLIND SPOT (roborev 56908). Keyed on the condition CLASS alone, the two agents
  // already reported keep the stamp alive, so four more hitting the same wall are invisible for the
  // whole cooldown — the exact "they sat blocked for hours and I found them by screenshot" failure
  // this feature exists to close, rebuilt inside the fix for it.
  it("reports again the moment a NEW agent joins a condition already reported", () => {
    const two = [walled("q1"), walled("q2")];
    const six = [...two, walled("q3"), walled("q4"), walled("q5"), walled("q6")];
    const d = decide({
      snapshots: six,
      memory: seen(six, { lastReported: stamp(two, "quota-blocked", T0 - TEN_MIN) }),
    });
    if (d.action !== "send") throw new Error("expected a send naming the new agents");
    expect(d.text).toContain("6 agents are quota-blocked");
  });

  it("does NOT report again when the same agents merely persist", () => {
    const two = [walled("q1"), walled("q2")];
    const d = decide({
      snapshots: two,
      memory: seen(two, { lastReported: stamp(two, "quota-blocked", T0 - TEN_MIN) }),
    });
    expect(d).toMatchObject({ action: "quiet", reason: "all-conditions-cooled" });
  });

  // ONLY GROWTH IS A NEW EPISODE (roborev 56973). The first fix keyed the stamp on the membership
  // SET, so any change minted a new key — and walls lift one agent at a time.
  it("does NOT report again when a condition SHRINKS", () => {
    const three = [walled("q1"), walled("q2"), walled("q3")];
    const d = decide({
      snapshots: [walled("q1"), walled("q2")],
      memory: seen([walled("q1"), walled("q2")], {
        lastReported: stamp(three, "quota-blocked", T0 - TEN_MIN),
      }),
    });
    expect(d).toMatchObject({ action: "quiet", reason: "all-conditions-cooled" });
  });

  // The flap the set-keyed version could not survive: a stamp covering the ORIGINAL set is still
  // present, so returning to it is not growth and must not re-send byte-identical text.
  it("does NOT re-report when membership flaps back to a set already reported", () => {
    const ab = [finished("f1"), finished("f2")];
    const d = decide({
      snapshots: ab,
      // Reported covering {f1,f2}; a poll dropped f2 last sweep; it is back now.
      memory: seen(ab, { lastReported: stamp(ab, "done-not-retired", T0 - TEN_MIN) }),
    });
    expect(d).toMatchObject({ action: "quiet", reason: "all-conditions-cooled" });
  });

  it("keys on the SET, not on roster order, so a reshuffle is not a new episode", () => {
    const forward = [walled("q1"), walled("q2")];
    const backward = [walled("q2"), walled("q1")];
    const d = decide({
      snapshots: backward,
      memory: seen(backward, { lastReported: stamp(forward, "quota-blocked", T0 - TEN_MIN) }),
    });
    expect(d).toMatchObject({ action: "quiet", reason: "all-conditions-cooled" });
  });

  // Stamping only the top condition would re-send every batched neighbour on the very next sweep —
  // inside the same message as the one correctly suppressed.
  it("stamps EVERY condition it included, not just the first", () => {
    const d = decide({ snapshots: QandE, memory: seen(QandE) });
    if (d.action !== "send") throw new Error("expected a send");
    expect(d.memoryOnDelivered.lastReported).toEqual({
      ...stamp(QandE, "quota-blocked", T0),
      ...stamp(QandE, "goals-escalated", T0),
    });
  });

  it("records WHO each stamp covered, so growth can be detected next sweep", () => {
    const two = [walled("q1"), walled("q2")];
    const d = decide({ snapshots: two, memory: seen(two) });
    if (d.action !== "send") throw new Error("expected a send");
    expect(d.memoryOnDelivered.lastReported["quota-blocked"]!.agentIds).toEqual(["q1", "q2"]);
  });

  it("clears the stamp of a condition that RESOLVED, so its return is heard immediately", () => {
    const only = [escalated("e")];
    const d = decide({
      snapshots: only,
      memory: seen(only, { lastReported: stamp(QandE, "quota-blocked", T0 - HOUR) }),
    });
    if (d.action !== "send") throw new Error("expected a send");
    expect(Object.keys(d.memoryOnDelivered.lastReported)).toEqual(["goals-escalated"]);
  });

  it("an undelivered report keeps the expired cooldowns, not the stale ones", () => {
    const only = [escalated("e")];
    const d = decide({
      snapshots: only,
      memory: seen(only, { lastReported: stamp(QandE, "quota-blocked", T0 - HOUR) }),
    });
    if (d.action !== "send") throw new Error("expected a send");
    expect(d.memoryOnFailure.lastReported).toEqual({});
    expect(d.memoryOnFailure.budget.sentAt).toEqual([]);
    expect(d.memoryOnFailure.lastConditions.map((c) => c.id)).toEqual(["goals-escalated"]);
  });
});

describe("the gate still binds", () => {
  it("refuses when the hourly budget is spent", () => {
    const spent = Array.from({ length: MESSAGES_PER_HOUR }, (_, i) => T0 - i * 1000);
    const d = decide({ memory: seen([walled("a")], { budget: { sentAt: spent } }) });
    expect(d).toMatchObject({ action: "quiet", reason: "budget-exhausted" });
  });

  it("yields to the concierge when the recipient's mailbox is filling", () => {
    const d = decide({ memory: seen([walled("a")]), inbox: { used: 45, capacity: 50 } });
    expect(d).toMatchObject({ action: "quiet", reason: "inbox-yielding" });
  });

  it("sends nothing at all when the Pusher is disabled", () => {
    const d = decide({
      policy: { ...POLICY, enabled: false },
      memory: seen([walled("a")]),
    });
    expect(d).toMatchObject({ action: "quiet", reason: "disabled" });
  });

  // RULE 2 FROM `pusherDecide`, re-pinned: a refusal must leave the budget untouched.
  it("a refused report costs no budget", () => {
    const d = decide({ memory: seen([walled("a")]), inbox: { used: 50, capacity: 50 } });
    if (d.action !== "quiet") throw new Error("expected quiet");
    expect(d.memory.budget.sentAt).toEqual([]);
  });
});
