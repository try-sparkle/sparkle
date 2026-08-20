// THE MOST IMPORTANT TEST IN THIS CHANGE.
//
// The founder will spend NOTHING outside his Claude Max subscription — not a small amount, not
// temporarily. Every row of the gate's table is one case here, and the two that matter most are the
// two that look like they could be waved through: CREDITS ARMED and AN UNREADABLE PAYLOAD. Both
// REFUSE. A gate that got either of those backwards would spend real money and nothing in the app
// would report that it had.
import { describe, expect, it } from "vitest";

import {
  checkSpendGate,
  checkSpendGateForAccounts,
  creditsMoved,
  usedCreditsDelta,
  type UsagePayloadForGate,
} from "./spendGate";

/** The confirmed-live shape, from `account_usage.rs`'s own FIXTURE — credits DISARMED. */
const disarmed: UsagePayloadForGate = {
  extraUsage: {
    isEnabled: false,
    monthlyLimit: null,
    usedCredits: null,
    utilization: null,
    spendLimitReached: false,
  },
};

describe("the zero-spend gate", () => {
  it("RUNS only when the credit meter is affirmatively DISARMED", () => {
    const v = checkSpendGate(disarmed);
    expect(v.allowed).toBe(true);
  });

  it("REFUSES when usage credits are ARMED, whatever the headroom", () => {
    const v = checkSpendGate({
      extraUsage: {
        isEnabled: true,
        // Deliberately generous: a cheaper gate might reason "there is headroom, so this call bills
        // to the subscription anyway". That is a PREDICTION about a window other agents are
        // consuming concurrently, and being wrong costs money against an instruction that admits no
        // small amount. Armed refuses regardless.
        monthlyLimit: 1000,
        usedCredits: 0,
        utilization: 0,
        spendLimitReached: false,
      },
    });
    expect(v.allowed).toBe(false);
    expect(v.allowed === false && v.reason).toBe("credits-armed");
  });

  it("REFUSES unconditionally when the spend limit is reached — even with credits disarmed", () => {
    // THE ORDERING ASSERTION. `spend_limit_reached` is checked BEFORE the `is_enabled === false`
    // permission, so it cannot be reached-past by a disarmed meter. Put the two in the other order
    // and this case returns `allowed`, which is precisely the state it must never return in.
    const v = checkSpendGate({
      extraUsage: { isEnabled: false, spendLimitReached: true },
    });
    expect(v.allowed).toBe(false);
    expect(v.allowed === false && v.reason).toBe("spend-limit-reached");
  });

  it("REFUSES an UNREADABLE payload — an unreadable meter is not permission", () => {
    for (const unreadable of [null, undefined]) {
      const v = checkSpendGate(unreadable);
      expect(v.allowed).toBe(false);
      expect(v.allowed === false && v.reason).toBe("usage-unreadable");
    }
  });

  it("REFUSES every shape where is_enabled is not an affirmative false", () => {
    // The inversion this guards against is `!extra.isEnabled`, which reads null, undefined and 0 as
    // permission — i.e. every unreadable shape would SPEND. Each row below is one way that would go
    // wrong, and all of them must refuse.
    const shapes: UsagePayloadForGate[] = [
      { extraUsage: {} }, // section present, field absent
      { extraUsage: { isEnabled: null } }, // Rust `Option::None` on the wire
      { extraUsage: { isEnabled: undefined } }, // key omitted entirely
      { extraUsage: { isEnabled: 0 as unknown as boolean } }, // wrong type, falsy
      { extraUsage: { isEnabled: "false" as unknown as boolean } }, // wrong type, truthy string
      { extraUsage: null }, // whole section null
      {}, // no section at all — an older backend, or the passthrough not yet landed
    ];
    for (const shape of shapes) {
      const v = checkSpendGate(shape);
      expect(v.allowed, JSON.stringify(shape)).toBe(false);
      expect(v.allowed === false && v.reason, JSON.stringify(shape)).toBe("usage-field-absent");
    }
  });

  it("carries the used_credits reading forward on the ONE permitting path", () => {
    // The latch's "before" must come from the SAME payload the permission was granted on — reading
    // it separately would compare two different observations of a moving meter.
    const v = checkSpendGate({ extraUsage: { isEnabled: false, usedCredits: 17 } });
    expect(v).toEqual({ allowed: true, usedCreditsBefore: 17 });
    // …and an absent reading is `null`, never 0. A 0 would compare equal to a later real 0 and read
    // as "it did not move" for an account whose field is simply not populated.
    const v2 = checkSpendGate({ extraUsage: { isEnabled: false, usedCredits: null } });
    expect(v2).toEqual({ allowed: true, usedCreditsBefore: null });
  });
});

describe("the gate across every registered account", () => {
  it("RUNS only when EVERY account is readable and disarmed", () => {
    expect(checkSpendGateForAccounts([disarmed, disarmed]).allowed).toBe(true);
  });

  it("REFUSES when ANY one account has credits armed", () => {
    // Unanimity, not majority and not "the first one". Which account the advisor's `claude` child
    // lands on is not a fact this layer holds, so one armed meter anywhere is a meter the call could
    // bill against.
    const armed: UsagePayloadForGate = { extraUsage: { isEnabled: true } };
    const v = checkSpendGateForAccounts([disarmed, armed, disarmed]);
    expect(v.allowed).toBe(false);
    expect(v.allowed === false && v.reason).toBe("credits-armed");
  });

  it("REFUSES when ANY one account's payload could not be read", () => {
    const v = checkSpendGateForAccounts([disarmed, null]);
    expect(v.allowed).toBe(false);
    expect(v.allowed === false && v.reason).toBe("usage-unreadable");
  });

  it("REFUSES an EMPTY list — no account to read is not permission", () => {
    // The absence of the observation the permission rests on. Left as `allowed` this would let a
    // machine with no registered accounts spend freely, which is the one state where nothing at all
    // has been checked.
    const v = checkSpendGateForAccounts([]);
    expect(v.allowed).toBe(false);
    expect(v.allowed === false && v.reason).toBe("usage-unreadable");
  });

  it("SUMS used_credits across accounts, so the latch compares one quantity", () => {
    const v = checkSpendGateForAccounts([
      { extraUsage: { isEnabled: false, usedCredits: 3 } },
      { extraUsage: { isEnabled: false, usedCredits: 4 } },
      { extraUsage: { isEnabled: false, usedCredits: null } },
    ]);
    expect(v).toEqual({ allowed: true, usedCreditsBefore: 7 });
  });
});

describe("the empirical credit latch's arithmetic", () => {
  it("reports a movement in either direction", () => {
    expect(creditsMoved(usedCreditsDelta(10, 11))).toBe(true);
    // A NEGATIVE delta counts too: a period rollover is not proof of innocence, and an unexplained
    // backwards move is exactly as much of a reason to stop and ask a human.
    expect(creditsMoved(usedCreditsDelta(10, 9))).toBe(true);
  });

  it("reports NO movement when the meter held still", () => {
    expect(creditsMoved(usedCreditsDelta(10, 10))).toBe(false);
    expect(creditsMoved(usedCreditsDelta(0, 0))).toBe(false);
  });

  it("says 'cannot tell' rather than 'did not move' when either reading is absent", () => {
    // The distinction is load-bearing in the other direction from the gate's: latching on an
    // unreadable meter would disable the advisor permanently on the first account whose payload
    // omits the field, which is a different failure from the one the latch guards.
    for (const pair of [
      [null, 5],
      [5, null],
      [null, null],
      [undefined, 5],
    ] as const) {
      expect(usedCreditsDelta(pair[0], pair[1])).toBeNull();
      expect(creditsMoved(usedCreditsDelta(pair[0], pair[1]))).toBe(false);
    }
  });
});
