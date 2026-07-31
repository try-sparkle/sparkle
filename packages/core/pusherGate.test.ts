// THE PROPERTY: an uncited or over-budget challenge cannot leave the process, and no wording of the
// message can change that.
//
// These tests are the enforcement half of the Pusher's anti-noise design. The Pusher ships ON by
// default and attached at birth (founder decisions 3 and 4), so nothing is staged between a trigger
// bug and the whole fleet except the rules asserted here. Each test therefore asserts the REFUSAL —
// the side effect — rather than that the input looked wrong, because "the gate examined it" and
// "the gate stopped it" are different facts and only the second one contains a partner's attention.
import { describe, it, expect } from "vitest";
import {
  gateChallenge,
  checkCitations,
  numbersIn,
  hasBudget,
  spentInWindow,
  recordSend,
  MAX_RUNG,
  MESSAGES_PER_HOUR,
  BUDGET_WINDOW_MS,
  INBOX_YIELD_PCT,
  REPEAT_COOLDOWN_MS,
  recordChallenged,
  expireClearedTriggers,
  type GateInput,
  type GateVerdict,
  type Rung,
} from "./pusherGate";

const NOW = 1_700_000_000_000;

/** A challenge that passes every rule, so each test can break exactly one thing. */
function input(over: Partial<GateInput> = {}): GateInput {
  return {
    enabled: true,
    challenge: {
      rung: 1,
      triggerId: "unpushed-commits",
      text: "You have 4 commits unpushed for 38 minutes.",
      measured: ["4", "38"],
    },
    persisted: true,
    budget: { sentAt: [] },
    inbox: { used: 0, capacity: 50 },
    now: NOW,
    ...over,
  };
}

function refused(v: GateVerdict): Extract<GateVerdict, { ok: false }> {
  if (v.ok) throw new Error(`expected a refusal, got ${JSON.stringify(v)}`);
  return v;
}

describe("the baseline is a message that actually sends", () => {
  // Without this the whole file could pass against a gate that refuses everything, which would
  // "prove" the safety rules while shipping a Pusher that never speaks.
  it("clears a persisted, in-budget, fully cited challenge", () => {
    const v = gateChallenge(input());
    expect(v).toEqual({
      ok: true,
      rung: 1,
      text: "You have 4 commits unpushed for 38 minutes.",
      cited: ["4", "38"],
    });
  });
});

describe("the citation rule", () => {
  it("refuses a challenge with no number at all", () => {
    const v = refused(
      gateChallenge(input({ challenge: { rung: 1, triggerId: "t", text: "You seem stuck.", measured: ["4"] } })),
    );
    expect(v.reason).toBe("uncited");
  });

  // The rule that makes the rule above worth having. "Contains a digit" is satisfiable by inventing
  // one, and an invented number is a false measurement delivered in the register of a true one.
  it("refuses a number the observation never measured", () => {
    const v = refused(
      gateChallenge(
        input({
          challenge: {
            rung: 1,
            triggerId: "t",
            text: "You have 12 commits unpushed for 38 minutes.",
            measured: ["4", "38"],
          },
        }),
      ),
    );
    expect(v.reason).toBe("fabricated-citation");
    expect(v.fabricated).toEqual(["12"]);
  });

  it("refuses when only SOME of the numbers are measured", () => {
    const v = refused(
      gateChallenge(
        input({
          challenge: {
            rung: 1,
            triggerId: "t",
            text: "4 commits, 38 minutes, 91% of your budget.",
            measured: ["4", "38"],
          },
        }),
      ),
    );
    expect(v.reason).toBe("fabricated-citation");
    expect(v.fabricated).toEqual(["91"]);
  });

  it("treats 04, 4 and 4.0 as the same measured value", () => {
    const v = gateChallenge(
      input({ challenge: { rung: 1, triggerId: "t", text: "4.0 commits are unpushed.", measured: ["04"] } }),
    );
    expect(v.ok).toBe(true);
  });

  // An identifier is not a measurement. Refusing these would block legitimate challenges that name
  // a branch or a file, which is how a safety rule turns into a reason to switch the feature off.
  it("does not read a digit inside a word as a citation", () => {
    expect(numbersIn("sha1 v2 abc123")).toEqual([]);
    const v = refused(
      gateChallenge(
        input({ challenge: { rung: 1, triggerId: "t", text: "Your branch sha1 is stale.", measured: ["4"] } }),
      ),
    );
    expect(v.reason).toBe("uncited");
  });

  it("reads a standalone number after a # as citable", () => {
    expect(numbersIn("PR #902 is open")).toEqual(["902"]);
  });

  it("reports every fabricated number, not just the first", () => {
    const r = checkCitations("7 and 9 and 4", ["4"]);
    expect(r).toEqual({ ok: false, reason: "fabricated-citation", fabricated: ["7", "9"] });
  });
});

describe("the message budget", () => {
  it(`refuses the ${MESSAGES_PER_HOUR + 1}th message inside the window`, () => {
    const sentAt = Array.from({ length: MESSAGES_PER_HOUR }, (_, i) => NOW - i * 60_000);
    const v = refused(gateChallenge(input({ budget: { sentAt } })));
    expect(v.reason).toBe("budget-exhausted");
  });

  it("allows again once the oldest send ages out of the window", () => {
    // Exactly MESSAGES_PER_HOUR sends, but the oldest is just outside the hour.
    const sentAt = [
      NOW - BUDGET_WINDOW_MS - 1,
      ...Array.from({ length: MESSAGES_PER_HOUR - 1 }, (_, i) => NOW - i * 60_000),
    ];
    expect(spentInWindow({ sentAt }, NOW)).toBe(MESSAGES_PER_HOUR - 1);
    expect(gateChallenge(input({ budget: { sentAt } })).ok).toBe(true);
  });

  it("counts a send exactly on the window boundary as expired", () => {
    expect(hasBudget({ sentAt: Array(MESSAGES_PER_HOUR).fill(NOW - BUDGET_WINDOW_MS) }, NOW)).toBe(
      true,
    );
  });

  it("prunes aged-out timestamps on write so the record cannot grow unbounded", () => {
    const stale = { sentAt: [NOW - BUDGET_WINDOW_MS - 5_000, NOW - 1_000] };
    expect(recordSend(stale, NOW).sentAt).toEqual([NOW - 1_000, NOW]);
  });
});

describe("the inbox yield", () => {
  // The concierge's message carries human intent; the Pusher's can wait. The inbox REFUSES when
  // full rather than evicting, so a talkative Pusher can starve the concierge's route to the same
  // builder — this is the rule that stops it.
  it(`refuses at ${INBOX_YIELD_PCT}% full`, () => {
    const v = refused(gateChallenge(input({ inbox: { used: 40, capacity: 50 } })));
    expect(v.reason).toBe("inbox-yielding");
  });

  it("sends just below the threshold", () => {
    expect(gateChallenge(input({ inbox: { used: 39, capacity: 50 } })).ok).toBe(true);
  });

  it("treats an unreadable capacity as full rather than as infinite room", () => {
    const v = refused(gateChallenge(input({ inbox: { used: 0, capacity: 0 } })));
    expect(v.reason).toBe("inbox-yielding");
  });
});

describe("the rung ceiling", () => {
  it("ships rungs 0-1 and no more", () => {
    expect(MAX_RUNG).toBe(1);
  });

  // Phase 2/3 authority is not gated behind a flag — it does not exist. A caller that acquires a
  // rung-2 intent from anywhere still cannot emit one.
  it.each([2, 3] as Rung[])("refuses rung %i as not built", (rung) => {
    const v = refused(gateChallenge(input({ challenge: { ...input().challenge, rung } })));
    expect(v.reason).toBe("rung-not-built");
  });

  it("refuses rung 0, which observes and has no message to send", () => {
    const v = refused(gateChallenge(input({ challenge: { ...input().challenge, rung: 0 } })));
    expect(v.reason).toBe("rung-not-built");
  });
});

describe("the persistence requirement", () => {
  it("refuses a condition that has been observed only once", () => {
    const v = refused(gateChallenge(input({ persisted: false })));
    expect(v.reason).toBe("no-persisted-trigger");
  });
});

describe("the kill switch", () => {
  it("refuses everything when disabled", () => {
    const v = refused(gateChallenge(input({ enabled: false })));
    expect(v.reason).toBe("disabled");
  });
});

describe("refusal ordering", () => {
  // The citation check runs LAST so the log never reports "uncited" for a challenge that was never
  // eligible to be sent — that would send a reader after the message when the problem is the budget.
  it("reports the budget, not the citation, when both are wrong", () => {
    const v = refused(
      gateChallenge(
        input({
          budget: { sentAt: Array(MESSAGES_PER_HOUR).fill(NOW) },
          challenge: { rung: 1, triggerId: "t", text: "You seem stuck.", measured: [] },
        }),
      ),
    );
    expect(v.reason).toBe("budget-exhausted");
  });

  it("reports disabled ahead of every other fault", () => {
    const v = refused(
      gateChallenge(
        input({
          enabled: false,
          persisted: false,
          challenge: { rung: 3, triggerId: "t", text: "", measured: [] },
        }),
      ),
    );
    expect(v.reason).toBe("disabled");
  });
});

describe("empty text", () => {
  it("refuses whitespace as a message", () => {
    const v = refused(
      gateChallenge(input({ challenge: { rung: 1, triggerId: "t", text: "   \n ", measured: ["4"] } })),
    );
    expect(v.reason).toBe("empty");
  });
});

describe("a config's limits reach the gate, and only ever tighten it", () => {
  // The policy resolver already clamps, but it is one caller. The gate re-clamps so a second caller
  // that built its limits some other way cannot route around the ceiling.
  it("honours a LOWERED message budget", () => {
    const v = refused(
      gateChallenge(input({ budget: { sentAt: [NOW - 1000] }, limits: { messagesPerHour: 1 } })),
    );
    expect(v.reason).toBe("budget-exhausted");
  });

  it("refuses to let a limit RAISE the budget", () => {
    const sentAt = Array.from({ length: MESSAGES_PER_HOUR }, () => NOW - 1000);
    const v = refused(gateChallenge(input({ budget: { sentAt }, limits: { messagesPerHour: 999 } })));
    expect(v.reason).toBe("budget-exhausted");
  });

  it("honours a LOWERED inbox yield threshold", () => {
    const v = refused(
      gateChallenge(input({ inbox: { used: 15, capacity: 50 }, limits: { inboxYieldPct: 20 } })),
    );
    expect(v.reason).toBe("inbox-yielding");
  });

  it("refuses to let a limit RAISE the inbox yield threshold", () => {
    const v = refused(
      gateChallenge(input({ inbox: { used: 45, capacity: 50 }, limits: { inboxYieldPct: 100 } })),
    );
    expect(v.reason).toBe("inbox-yielding");
  });
});


describe("the repeat check — a latching trigger is said ONCE, not every window", () => {
  // goal-expired and roborev-rounds latch: once true they are true on every later observation
  // forever. The budget bounds RATE, not repetition, so without this the partner hears the identical
  // sentence 4x an hour indefinitely (~96/day) about one expired goal.
  const latched = () =>
    input({
      challenge: {
        rung: 1,
        triggerId: "goal-expired",
        text: "Your goal expired 3h 12m ago and is still unmet.",
        measured: ["3", "12"],
      },
    });

  it("sends the first time", () => {
    expect(gateChallenge(latched()).ok).toBe(true);
  });

  it("refuses the same trigger inside the cooldown", () => {
    const v = refused(
      gateChallenge({ ...latched(), lastChallengedAt: { "goal-expired": NOW - 60_000 } }),
    );
    expect(v.reason).toBe("repeat-suppressed");
  });

  it("refuses one millisecond before the cooldown expires", () => {
    const v = refused(
      gateChallenge({
        ...latched(),
        lastChallengedAt: { "goal-expired": NOW - REPEAT_COOLDOWN_MS + 1 },
      }),
    );
    expect(v.reason).toBe("repeat-suppressed");
  });

  it("sends again once the cooldown has fully elapsed", () => {
    const v = gateChallenge({
      ...latched(),
      lastChallengedAt: { "goal-expired": NOW - REPEAT_COOLDOWN_MS },
    });
    expect(v.ok).toBe(true);
  });

  // Per-trigger, not global: a DIFFERENT condition is a different thing to say, and suppressing it
  // because something else was said would silence real news.
  it("does not suppress a different trigger", () => {
    const v = gateChallenge({ ...latched(), lastChallengedAt: { "unpushed-commits": NOW - 1000 } });
    expect(v.ok).toBe(true);
  });

  // A lost record must not silence the Pusher; the budget is the bound that survives it.
  it("treats an absent record as never challenged", () => {
    expect(gateChallenge({ ...latched(), lastChallengedAt: {} }).ok).toBe(true);
    expect(gateChallenge({ ...latched(), lastChallengedAt: undefined }).ok).toBe(true);
  });

  it("recordChallenged stamps the trigger without disturbing its siblings", () => {
    const prev = { "unpushed-commits": 111 };
    expect(recordChallenged(prev, "goal-expired", NOW)).toEqual({
      "unpushed-commits": 111,
      "goal-expired": NOW,
    });
  });
});

describe("a zero inbox-yield threshold means ALWAYS yield", () => {
  // 0 is the quietest the field can express. Flooring it to 1 would make it "yield above 1% full",
  // which sends on an empty mailbox — an inversion of what the setting asks for.
  it("refuses even on a completely empty inbox", () => {
    const v = refused(
      gateChallenge(input({ inbox: { used: 0, capacity: 50 }, limits: { inboxYieldPct: 0 } })),
    );
    expect(v.reason).toBe("inbox-yielding");
  });
});

describe("a zero message budget silences the Pusher entirely", () => {
  it("refuses the FIRST message, not just the fifth", () => {
    const v = refused(gateChallenge(input({ budget: { sentAt: [] }, limits: { messagesPerHour: 0 } })));
    expect(v.reason).toBe("budget-exhausted");
  });

  it("hasBudget agrees on an empty history", () => {
    expect(hasBudget({ sentAt: [] }, NOW, 0)).toBe(false);
  });
});

describe("the cooldown is per EPISODE, not per topic", () => {
  // Only two of the four triggers latch. A cooldown keyed on the id alone is right for those and
  // wrong for the ones that clear and recur — it would silence a partner for having COMPLIED.
  it("clears the cooldown for a trigger that is no longer firing", () => {
    const prev = { "unpushed-commits": NOW - 60_000, "goal-expired": NOW - 60_000 };
    expect(expireClearedTriggers(prev, ["goal-expired"])).toEqual({ "goal-expired": NOW - 60_000 });
  });

  it("keeps the cooldown for a LATCHING trigger, which never goes absent", () => {
    const prev = { "goal-expired": NOW - 60_000 };
    expect(expireClearedTriggers(prev, ["goal-expired"])).toEqual(prev);
  });

  it("drops everything when nothing is firing", () => {
    expect(expireClearedTriggers({ "unpushed-commits": NOW }, [])).toEqual({});
  });

  it("tolerates an absent record", () => {
    expect(expireClearedTriggers(undefined, ["goal-expired"])).toEqual({});
  });

  // The end-to-end property: comply, then re-offend, and the Pusher may speak again immediately.
  it("lets a RESOLVED-then-recurring condition be challenged again inside the cooldown", () => {
    const challenge = {
      rung: 1 as const,
      triggerId: "unpushed-commits",
      text: "You have 3 commits unpushed for 31 minutes.",
      measured: ["3", "31"],
    };
    let stamps = recordChallenged(undefined, "unpushed-commits", NOW - 60_000);

    // Still inside the cooldown, condition still firing -> suppressed.
    expect(
      refused(gateChallenge(input({ challenge, lastChallengedAt: stamps }))).reason,
    ).toBe("repeat-suppressed");

    // The partner pushed: the trigger stops firing, so its cooldown is cleared...
    stamps = expireClearedTriggers(stamps, []);
    // ...and new commits are a new episode, heard at once despite being inside the 4h window.
    expect(gateChallenge(input({ challenge, lastChallengedAt: stamps })).ok).toBe(true);
  });
});

describe("a SECOND, different instance is news — not a repeat (roborev 56234)", () => {
  // The reviewer's exact scenario: ask question A, hear the challenge, get an answer, ask question
  // B, be ignored 40 minutes. A 4h id-scoped cooldown would drop that — genuinely new news, at a
  // trigger whose own threshold is 20 minutes. What makes it work is that the condition CLEARED in
  // between, which is the signal expireClearedTriggers keys on.
  const ask = (mins: number) => ({
    rung: 1 as const,
    triggerId: "unanswered-question",
    text: `You asked a question ${mins} minutes ago; no reply is recorded in your inbox.`,
    measured: [String(mins), "20"],
  });

  it("challenges question B after question A was answered", () => {
    let stamps = recordChallenged(undefined, "unanswered-question", NOW - 30 * 60_000);

    // A is still unanswered 5 minutes later — same episode, correctly suppressed.
    expect(
      refused(gateChallenge(input({ challenge: ask(35), lastChallengedAt: stamps }))).reason,
    ).toBe("repeat-suppressed");

    // A gets answered: the trigger stops firing this cycle.
    stamps = expireClearedTriggers(stamps, []);

    // B goes unanswered for 40 minutes — well inside the 4h window, and heard.
    expect(gateChallenge(input({ challenge: ask(40), lastChallengedAt: stamps })).ok).toBe(true);
  });

  // The other half, so the fix cannot be "clear everything always": a condition that never lapsed
  // is the same episode and stays suppressed.
  it("still suppresses a condition that never cleared", () => {
    const stamps = expireClearedTriggers(
      recordChallenged(undefined, "unanswered-question", NOW - 30 * 60_000),
      ["unanswered-question"],
    );
    expect(
      refused(gateChallenge(input({ challenge: ask(50), lastChallengedAt: stamps }))).reason,
    ).toBe("repeat-suppressed");
  });
});
