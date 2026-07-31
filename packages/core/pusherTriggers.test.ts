// THE PROPERTY: a Pusher only notices things it measured, and only speaks about what it has seen
// twice.
//
// The second half is the anti-tune-out rule and it is the one worth testing hardest, because its
// failure mode is silent: a Pusher that challenges on a single observation still looks like it is
// working, it is just wrong often enough that its partner stops reading it. That degradation never
// throws.
//
// The tests also pin the contract between this module and `pusherGate`: every trigger's `challenge`
// must survive its own gate. No model composes these sentences — the template IS the message — so a
// trigger that measures a number it forgets to declare ships text its own gate refuses, and that
// trigger is then silent forever rather than merely occasionally wrong.
import { describe, it, expect } from "vitest";
import {
  evaluateTriggers,
  persistedTriggers,
  minutesBetween,
  splitHoursMinutes,
  UNPUSHED_MINUTES,
  ROBOREV_PLATEAU_ROUND,
  UNANSWERED_MINUTES,
  type Observation,
  type Trigger,
} from "./pusherTriggers";
import { gateChallenge, checkCitations } from "./pusherGate";

const NOW = 1_700_000_000_000;
const MIN = 60_000;

/** An observation in which nothing is wrong, so each test can make exactly one thing wrong. */
function obs(over: Partial<Observation> = {}): Observation {
  return {
    goalMet: false,
    roborevRounds: 0,
    now: NOW,
    ...over,
  };
}

function ids(ts: Trigger[]): string[] {
  return ts.map((t) => t.id);
}

describe("a quiet partner produces no triggers", () => {
  it("says nothing about an agent with nothing measurable wrong", () => {
    expect(evaluateTriggers(obs())).toEqual([]);
  });
});

describe("goal-expired — the design's highest-value trigger", () => {
  // `goalStateOf` returns "expired" and `decideContinuation` answers `{action:"none"}`. Nothing
  // else in the app acts on it, which is precisely why it is worth a Pusher.
  it("fires once the TTL has elapsed on an unmet goal", () => {
    const t = evaluateTriggers(obs({ goalExpiresAt: NOW - (3 * 60 + 12) * MIN }));
    expect(ids(t)).toEqual(["goal-expired"]);
    expect(t[0]!.measured).toEqual(["3", "12"]);
    expect(t[0]!.challenge).toBe("Your goal expired 3h 12m ago and is still unmet.");
  });

  it("does not fire on a goal that was MET, however long ago it expired", () => {
    expect(evaluateTriggers(obs({ goalExpiresAt: NOW - 99 * MIN, goalMet: true }))).toEqual([]);
  });

  it("does not fire before the TTL elapses", () => {
    expect(evaluateTriggers(obs({ goalExpiresAt: NOW + 1 }))).toEqual([]);
  });
});

describe("unpushed-commits", () => {
  it(`fires at ${UNPUSHED_MINUTES} minutes and cites the count, the age and the threshold`, () => {
    const t = evaluateTriggers(
      obs({ hasUnlandedWork: true, unpushedCommits: 4, oldestUnpushedAt: NOW - UNPUSHED_MINUTES * MIN }),
    );
    expect(ids(t)).toEqual(["unpushed-commits"]);
    expect(t[0]!.measured).toEqual(["4", String(UNPUSHED_MINUTES), String(UNPUSHED_MINUTES)]);
  });

  it("stays quiet one minute under the threshold", () => {
    expect(
      evaluateTriggers(obs({ hasUnlandedWork: true, unpushedCommits: 4, oldestUnpushedAt: NOW - (UNPUSHED_MINUTES - 1) * MIN })),
    ).toEqual([]);
  });

  it("stays quiet when the branch is clean however old the checkout", () => {
    expect(evaluateTriggers(obs({ hasUnlandedWork: false, unpushedCommits: 0, oldestUnpushedAt: NOW - 999 * MIN }))).toEqual(
      [],
    );
  });
});

describe("roborev-rounds", () => {
  it(`fires at round ${ROBOREV_PLATEAU_ROUND} and cites the plateau the repo measured`, () => {
    const t = evaluateTriggers(obs({ roborevRounds: ROBOREV_PLATEAU_ROUND }));
    expect(ids(t)).toEqual(["roborev-rounds"]);
    // The plateau figures are measured facts from the repo's own data, so a challenge is allowed
    // to quote them — that is why they are in `measured` and not just in the prose.
    expect(t[0]!.measured).toContain("40");
    expect(t[0]!.measured).toContain("48");
  });

  it("stays quiet one round under the plateau", () => {
    expect(evaluateTriggers(obs({ roborevRounds: ROBOREV_PLATEAU_ROUND - 1 }))).toEqual([]);
  });
});

describe("unanswered-question", () => {
  it(`fires after ${UNANSWERED_MINUTES} minutes`, () => {
    const t = evaluateTriggers(obs({ questionUnansweredSince: NOW - UNANSWERED_MINUTES * MIN }));
    expect(ids(t)).toEqual(["unanswered-question"]);
  });

  it("stays quiet one minute under the threshold", () => {
    expect(
      evaluateTriggers(obs({ questionUnansweredSince: NOW - (UNANSWERED_MINUTES - 1) * MIN })),
    ).toEqual([]);
  });
});

describe("priority order", () => {
  // A caller raising one trigger per cycle takes the first, so the order is a decision about what
  // matters most, not a presentation detail.
  it("puts work that has stopped ahead of work that is circling", () => {
    const t = evaluateTriggers(
      obs({
        goalExpiresAt: NOW - 60 * MIN,
        hasUnlandedWork: true,
        unpushedCommits: 2,
        oldestUnpushedAt: NOW - 60 * MIN,
        roborevRounds: 12,
        questionUnansweredSince: NOW - 60 * MIN,
      }),
    );
    expect(ids(t)).toEqual([
      "goal-expired",
      "unpushed-commits",
      "roborev-rounds",
      "unanswered-question",
    ]);
  });
});

describe("the two-observation rule", () => {
  const first = evaluateTriggers(obs({ roborevRounds: 9 }));

  it("suppresses a condition seen for the first time", () => {
    expect(persistedTriggers([], first)).toEqual([]);
  });

  it("admits a condition seen in both cycles", () => {
    expect(ids(persistedTriggers(first, first))).toEqual(["roborev-rounds"]);
  });

  it("drops a condition that cleared itself between cycles", () => {
    expect(persistedTriggers(first, evaluateTriggers(obs()))).toEqual([]);
  });

  // Comparing by id rather than by measured value is what lets a WORSENING condition qualify.
  // Requiring the numbers to match would mean a stall that keeps getting worse never persists,
  // which inverts the rule this exists to implement.
  it("admits a persisting condition whose numbers have moved, and cites the FRESH numbers", () => {
    const earlier = evaluateTriggers(
      obs({ hasUnlandedWork: true, unpushedCommits: 4, oldestUnpushedAt: NOW - 38 * MIN, now: NOW }),
    );
    const later = evaluateTriggers(
      obs({ hasUnlandedWork: true, unpushedCommits: 4, oldestUnpushedAt: NOW - 38 * MIN, now: NOW + 5 * MIN }),
    );
    const persisted = persistedTriggers(earlier, later);
    expect(ids(persisted)).toEqual(["unpushed-commits"]);
    expect(persisted[0]!.measured).toContain("43");
    expect(persisted[0]!.challenge).toContain("43 minutes");
  });

  it("keeps only the overlap when the two cycles disagree", () => {
    const a = evaluateTriggers(obs({ roborevRounds: 9, goalExpiresAt: NOW - MIN }));
    const b = evaluateTriggers(obs({ roborevRounds: 9 }));
    expect(ids(persistedTriggers(a, b))).toEqual(["roborev-rounds"]);
  });
});

describe("every challenge survives its own gate", () => {
  // The contract with `pusherGate`. A trigger that measures a number without declaring it ships a
  // challenge that IS a rule violation — emitted precisely when the composing model is unavailable,
  // i.e. when the fleet is busiest and nobody is watching.
  const everyTrigger = evaluateTriggers(
    obs({
      goalExpiresAt: NOW - (3 * 60 + 12) * MIN,
      hasUnlandedWork: true,
      unpushedCommits: 4,
      oldestUnpushedAt: NOW - 38 * MIN,
      roborevRounds: 12,
      questionUnansweredSince: NOW - 23 * MIN,
    }),
  );

  it("produced one of each trigger to check", () => {
    expect(everyTrigger).toHaveLength(4);
  });

  it.each(everyTrigger.map((t) => [t.id, t] as const))("%s", (_id, trigger) => {
    expect(checkCitations(trigger.challenge, trigger.measured)).toMatchObject({ ok: true });
    const v = gateChallenge({
      enabled: true,
      challenge: {
        rung: 1,
        triggerId: trigger.id,
        text: trigger.challenge,
        measured: trigger.measured,
      },
      persisted: true,
      budget: { sentAt: [] },
      inbox: { used: 0, capacity: 50 },
      now: NOW,
    });
    expect(v.ok).toBe(true);
  });
});

describe("time helpers", () => {
  it("floors minutes rather than rounding up to a number that has not elapsed", () => {
    expect(minutesBetween(NOW - 119_000, NOW)).toBe(1);
  });

  it("splits an elapsed span into hours and minutes", () => {
    expect(splitHoursMinutes((3 * 60 + 12) * MIN)).toEqual({ h: 3, m: 12 });
  });

  it("never reports a negative span", () => {
    expect(splitHoursMinutes(-5 * MIN)).toEqual({ h: 0, m: 0 });
  });
});

describe("unpushed-commits adapts to the evidence it actually has", () => {
  // The count lives on runtimeStore.branchStatus (displayed project only); the CONDITION lives on
  // fleetVerdict.contradictions (every open agent, app-wide, but boolean). So the trigger has to
  // work from either, and must never invent the number it does not have — the citation gate cannot
  // catch a fabricated count, because a fabricated count IS "measured" as far as it can tell.
  it("cites the count when one was measured", () => {
    const t = evaluateTriggers(
      obs({ hasUnlandedWork: true, unpushedCommits: 4, oldestUnpushedAt: NOW - 38 * MIN }),
    );
    expect(t[0]!.challenge).toBe("You have 4 commits unpushed for 38 minutes.");
    expect(t[0]!.measured).toContain("4");
  });

  it("still fires fleet-wide with no count, citing only the duration", () => {
    const t = evaluateTriggers(obs({ hasUnlandedWork: true, oldestUnpushedAt: NOW - 38 * MIN }));
    expect(ids(t)).toEqual(["unpushed-commits"]);
    expect(t[0]!.challenge).toBe("Your branch has held unlanded work for 38 minutes.");
    expect(t[0]!.measured).toEqual(["38", String(UNPUSHED_MINUTES)]);
  });

  // FAIL CLOSED. `undefined` is "we did not look", never "clean" — agentStall's rule, inherited.
  it("does NOT fire when nothing was looked up, however old the clock", () => {
    expect(evaluateTriggers(obs({ oldestUnpushedAt: NOW - 999 * MIN }))).toEqual([]);
  });

  it("does not fire on an explicit false", () => {
    expect(
      evaluateTriggers(obs({ hasUnlandedWork: false, oldestUnpushedAt: NOW - 999 * MIN })),
    ).toEqual([]);
  });

  // A count of 0 alongside a true boolean is a squash-landed branch: `ahead` does not return to
  // zero reliably, so the boolean wins and the sentence simply omits the number.
  it("omits a zero count rather than saying '0 commits'", () => {
    const t = evaluateTriggers(
      obs({ hasUnlandedWork: true, unpushedCommits: 0, oldestUnpushedAt: NOW - 38 * MIN }),
    );
    expect(t[0]!.challenge).toBe("Your branch has held unlanded work for 38 minutes.");
    expect(t[0]!.measured).not.toContain("0");
  });
});
