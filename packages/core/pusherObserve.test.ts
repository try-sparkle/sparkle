// THE PROPERTY: a sweep turns store readings into observations without ever inventing one.
//
// Two failure directions, both silent. Fail-OPEN (treating "we did not look" as a finding) produces
// challenges about agents nothing was ever known about — and the citation gate cannot catch it,
// because a duration derived from missing data really was "measured". Fail-SHUT (dropping quiet
// partners from the result) breaks `persistedTriggers`, which needs an empty trigger list to notice
// a condition CLEARED; without it every resolved condition looks like a partner that vanished, and
// the two-observation rule silently stops working.
import { describe, it, expect } from "vitest";
import { observeFleet, emptyObserveState, type PartnerSnapshot } from "./pusherObserve";
import { evaluateTriggers, UNPUSHED_MINUTES, UNANSWERED_MINUTES } from "./pusherTriggers";

const T0 = 1_700_000_000_000;
const MIN = 60_000;

const snap = (over: Partial<PartnerSnapshot> = {}): PartnerSnapshot => ({ agentId: "a", ...over });

describe("fail-closed on absent evidence", () => {
  it("starts no clock for a partner nothing was looked up on", () => {
    const { observations, next } = observeFleet([snap()], emptyObserveState(), T0);
    expect(next.unlandedSince.size).toBe(0);
    expect(next.awaitingSince.size).toBe(0);
    const o = observations.get("a")!;
    expect(o.oldestUnpushedAt).toBeUndefined();
    expect(o.questionUnansweredSince).toBeUndefined();
  });

  // `=== true`, not truthiness: "did not look" and "looked, it is false" must behave identically
  // here, and neither may start a clock.
  it("starts no clock on an explicit false either", () => {
    const { next } = observeFleet(
      [snap({ hasUnlandedWork: false, awaitingAnswer: false })],
      emptyObserveState(),
      T0,
    );
    expect(next.unlandedSince.size).toBe(0);
  });

  it("produces no trigger from an observation with no evidence, however long the sweep runs", () => {
    let st = emptyObserveState();
    for (let i = 0; i < 20; i++) {
      st = observeFleet([snap()], st, T0 + i * 5 * MIN).next;
    }
    const { observations } = observeFleet([snap()], st, T0 + 100 * MIN);
    expect(evaluateTriggers(observations.get("a")!)).toEqual([]);
  });
});

describe("the clocks feed the duration triggers", () => {
  it("reports an onset far enough back to fire unpushed-commits", () => {
    let st = emptyObserveState();
    st = observeFleet([snap({ hasUnlandedWork: true })], st, T0).next;
    const { observations } = observeFleet(
      [snap({ hasUnlandedWork: true, unpushedCommits: 4 })],
      st,
      T0 + UNPUSHED_MINUTES * MIN,
    );
    const t = evaluateTriggers(observations.get("a")!);
    expect(t.map((x) => x.id)).toEqual(["unpushed-commits"]);
    expect(t[0]!.challenge).toBe(`You have 4 commits unpushed for ${UNPUSHED_MINUTES} minutes.`);
  });

  it("reports an onset far enough back to fire unanswered-question", () => {
    let st = emptyObserveState();
    st = observeFleet([snap({ awaitingAnswer: true })], st, T0).next;
    const { observations } = observeFleet(
      [snap({ awaitingAnswer: true })],
      st,
      T0 + UNANSWERED_MINUTES * MIN,
    );
    expect(evaluateTriggers(observations.get("a")!).map((x) => x.id)).toEqual([
      "unanswered-question",
    ]);
  });

  // The episode rule, end to end: comply, re-offend, and the age is of the SECOND episode.
  it("times a cleared-and-returned condition from its second onset", () => {
    let st = emptyObserveState();
    st = observeFleet([snap({ hasUnlandedWork: true })], st, T0).next;
    st = observeFleet([snap({ hasUnlandedWork: false })], st, T0 + 90 * MIN).next; // pushed
    st = observeFleet([snap({ hasUnlandedWork: true })], st, T0 + 100 * MIN).next; // new commits
    const { observations } = observeFleet(
      [snap({ hasUnlandedWork: true })],
      st,
      T0 + 100 * MIN + UNPUSHED_MINUTES * MIN,
    );
    // 30 minutes into the SECOND episode, not 130 into the first — the number in the sentence is
    // the assertion, because it is the only thing that distinguishes the two.
    const t = evaluateTriggers(observations.get("a")!);
    expect(t[0]!.challenge).toBe(`Your branch has held unlanded work for ${UNPUSHED_MINUTES} minutes.`);
    expect(t[0]!.measured).toContain(String(UNPUSHED_MINUTES));
    expect(t[0]!.challenge).not.toContain("130");
  });
});

describe("the goal fields", () => {
  it("derives expiry from setAt + ttlMs", () => {
    const { observations } = observeFleet(
      [snap({ goalSetAt: T0, goalTtlMs: 4 * 60 * MIN })],
      emptyObserveState(),
      T0,
    );
    expect(observations.get("a")!.goalExpiresAt).toBe(T0 + 4 * 60 * MIN);
  });

  // A partial read is not a goal that never expires.
  it.each([
    [{ goalSetAt: T0 }],
    [{ goalTtlMs: 1000 }],
    [{}],
  ])("leaves expiry undefined on a partial read %o", (over) => {
    const { observations } = observeFleet([snap(over)], emptyObserveState(), T0);
    expect(observations.get("a")!.goalExpiresAt).toBeUndefined();
  });

  it("reads goalMet from the presence of metAt", () => {
    const got = (over: Partial<PartnerSnapshot>) =>
      observeFleet([snap(over)], emptyObserveState(), T0).observations.get("a")!.goalMet;
    expect(got({ goalMetAt: T0 })).toBe(true);
    expect(got({})).toBe(false);
  });
});

describe("quiet partners are still observed", () => {
  // persistedTriggers needs an EMPTY trigger list to see that a condition cleared. Dropping quiet
  // partners would make every resolved condition indistinguishable from a partner that vanished.
  it("returns an observation for every snapshot, including the uneventful ones", () => {
    const { observations } = observeFleet(
      [snap({ agentId: "quiet" }), snap({ agentId: "busy", hasUnlandedWork: true })],
      emptyObserveState(),
      T0,
    );
    expect([...observations.keys()].sort()).toEqual(["busy", "quiet"]);
  });

  it("garbage-collects an agent that left the roster", () => {
    let st = emptyObserveState();
    st = observeFleet(
      [snap({ agentId: "gone", hasUnlandedWork: true }), snap({ agentId: "here", hasUnlandedWork: true })],
      st,
      T0,
    ).next;
    st = observeFleet([snap({ agentId: "here", hasUnlandedWork: true })], st, T0 + MIN).next;
    expect([...st.unlandedSince.keys()]).toEqual(["here"]);
  });
});

describe("state is returned, never mutated", () => {
  // A sweep that throws part-way must not leave a half-advanced clock behind.
  //
  // The previous version of this test seeded an EMPTY state and asserted it was still empty, which
  // was true before `observeFleet` ran — a precondition, not a side effect, and exactly the vacuous
  // shape this repo warns about (roborev 56346). `prev` has to hold something damageable for the
  // assertion to mean anything, and both damage shapes have to be checked: an in-place DELETE of a
  // cleared key, and an in-place RE-STAMP of a surviving one.
  it("does not delete a cleared key from the PREVIOUS state", () => {
    const before = observeFleet([snap({ hasUnlandedWork: true })], emptyObserveState(), T0).next;
    expect(before.unlandedSince.get("a")).toBe(T0);

    const { next } = observeFleet([snap({ hasUnlandedWork: false })], before, T0 + MIN);

    expect(before.unlandedSince.get("a")).toBe(T0); // untouched
    expect(next.unlandedSince.has("a")).toBe(false); // and correctly cleared in the new state
  });

  it("does not re-stamp a surviving key in the PREVIOUS state", () => {
    const before = observeFleet([snap({ hasUnlandedWork: true })], emptyObserveState(), T0).next;
    const { next } = observeFleet([snap({ hasUnlandedWork: true })], before, T0 + 30 * MIN);
    expect(before.unlandedSince.get("a")).toBe(T0);
    expect(next.unlandedSince.get("a")).toBe(T0); // onset preserved, not advanced
  });
});

describe("a measured COUNT alone is evidence (roborev 56346)", () => {
  // The observer and the trigger must agree on what "holding work" means. They did not: the
  // observer keyed on the boolean alone, so a partner whose branch-status poll supplied a count
  // with no fleet-wide boolean never started a clock — and the count-only branch of
  // `evaluateTriggers` was dead code through the only producer of observations.
  it("starts the clock on a count with no boolean", () => {
    const { next } = observeFleet([snap({ unpushedCommits: 4 })], emptyObserveState(), T0);
    expect(next.unlandedSince.get("a")).toBe(T0);
  });

  it("carries that partner all the way to a challenge", () => {
    let st = emptyObserveState();
    st = observeFleet([snap({ unpushedCommits: 4 })], st, T0).next;
    const { observations } = observeFleet(
      [snap({ unpushedCommits: 4 })],
      st,
      T0 + UNPUSHED_MINUTES * MIN,
    );
    const t = evaluateTriggers(observations.get("a")!);
    expect(t.map((x) => x.id)).toEqual(["unpushed-commits"]);
    expect(t[0]!.challenge).toBe(`You have 4 commits unpushed for ${UNPUSHED_MINUTES} minutes.`);
  });

  // Still fail-closed: a count of ZERO is not evidence of work, it is evidence of none.
  it("does not start a clock on a zero count", () => {
    const { next } = observeFleet([snap({ unpushedCommits: 0 })], emptyObserveState(), T0);
    expect(next.unlandedSince.size).toBe(0);
  });
});
