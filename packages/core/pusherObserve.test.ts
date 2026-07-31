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
  it("leaves the previous state untouched", () => {
    const before = emptyObserveState();
    observeFleet([snap({ hasUnlandedWork: true })], before, T0);
    expect(before.unlandedSince.size).toBe(0);
  });
});
