import { describe, expect, it } from "vitest";
import { escalateGoal, markGoalMet, newGoal } from "./agentGoal";
import { isStalled, stallReport, type StallInput } from "./agentStall";

const T0 = 1_700_000_000_000;

/** An idle agent with its git state fully READ and nothing outstanding — i.e. genuinely finished.
 *  Tests add outstanding work to it, so a "stalled" assertion proves the added work caused it. */
function finished(over: Partial<StallInput> = {}): StallInput {
  return {
    status: "idle",
    now: T0,
    goal: undefined,
    hasOpenPr: false,
    hasUnlandedWork: false,
    hasUncommittedChanges: false,
    ...over,
  };
}

describe("the distinction the whole feature rests on", () => {
  it("idle with nothing outstanding is finished", () => {
    const r = stallReport(finished());
    expect(r.verdict).toBe("finished");
    expect(isStalled(r)).toBe(false);
  });

  it("idle with an unmet goal is STALLED, not finished", () => {
    // These two rows render identically today. This is the assertion that separates them.
    const r = stallReport(finished({ goal: newGoal("write the thing", T0) }));
    expect(r.verdict).toBe("stalled");
    expect(r.causes).toEqual(["unmet-goal"]);
    expect(isStalled(r)).toBe(true);
    expect(r.detail).toContain("write the thing");
  });

  it("a met goal does not stall the row", () => {
    const goal = markGoalMet(newGoal("shipped", T0), T0 + 1);
    expect(stallReport(finished({ goal, now: T0 + 2 })).verdict).toBe("finished");
  });

  it("an EXPIRED goal still stalls the row — the mandate ran out, the work did not get done", () => {
    // This used to read `finished — genuinely done`, which is a false sentence about an agent that
    // never finished (roborev 55252). The TTL bounds auto-continue SPEND; reusing it to silence the
    // human surface went quiet on exactly the worst cases, since the 153-minute-class stalls are
    // the ones most likely to cross a 4h TTL.
    const goal = newGoal("stale", T0, 1_000);
    const r = stallReport(finished({ goal, now: T0 + 5_000 }));
    expect(r.verdict).toBe("stalled");
    expect(r.causes).toEqual(["expired-goal"]);
    expect(r.detail).toContain("ran out of time");
    expect(r.detail).not.toContain("genuinely done");
  });

  it("an ESCALATED goal still stalls the row — that is the agent most needing a human", () => {
    const goal = escalateGoal(newGoal("hard", T0), T0 + 1, "three tries, no progress");
    const r = stallReport(finished({ goal, now: T0 + 2 }));
    expect(r.verdict).toBe("stalled");
    expect(r.causes).toEqual(["escalated-goal"]);
    expect(r.detail).toContain("three tries, no progress");
  });
});

describe("the other kinds of outstanding work", () => {
  it("an open PR stalls an otherwise-idle agent", () => {
    const r = stallReport(finished({ hasOpenPr: true }));
    expect(r.verdict).toBe("stalled");
    expect(r.causes).toEqual(["open-pr"]);
  });

  it("uncommitted changes stall an otherwise-idle agent", () => {
    const r = stallReport(finished({ hasUncommittedChanges: true }));
    expect(r.verdict).toBe("stalled");
    expect(r.causes).toEqual(["uncommitted-changes"]);
  });

  it("committed work that never reached main stalls an otherwise-idle agent", () => {
    // The band's own meaning, as an explicit input for callers that read the stage directly.
    const r = stallReport(finished({ hasUnlandedWork: true }));
    expect(r.verdict).toBe("stalled");
    expect(r.causes).toEqual(["unlanded-work"]);
    expect(r.detail).toContain("never reached main");
  });

  it("reports every cause, most-actionable first", () => {
    const r = stallReport(
      finished({
        goal: newGoal("g", T0),
        hasOpenPr: true,
        hasUnlandedWork: true,
        hasUncommittedChanges: true,
      }),
    );
    // `unlanded-work` folds into `open-pr` — see the dedupe note in the module.
    expect(r.causes).toEqual(["unmet-goal", "open-pr", "uncommitted-changes"]);
    expect(r.detail).toContain(" and ");
  });
});

describe("evidence, not inference", () => {
  it("unread git state reads 'unknown', never 'finished'", () => {
    // A window that never looked must not claim the agent is done on that ignorance.
    expect(stallReport(finished({ hasOpenPr: undefined })).verdict).toBe("unknown");
    expect(stallReport(finished({ hasUnlandedWork: undefined })).verdict).toBe("unknown");
    expect(stallReport(finished({ hasUncommittedChanges: undefined })).verdict).toBe("unknown");
    expect(stallReport({ status: "idle", now: T0, goal: undefined }).verdict).toBe("unknown");
  });

  it("'unknown' is not an alarm", () => {
    // It must not page the human — a stall claim that fires on missing data trains them to ignore it.
    expect(isStalled(stallReport(finished({ hasOpenPr: undefined })))).toBe(false);
  });

  it("a found cause outranks missing evidence elsewhere", () => {
    // A partial view still gives a confident answer when it found something real.
    const r = stallReport({
      status: "idle",
      now: T0,
      goal: newGoal("g", T0),
      hasOpenPr: undefined,
      hasUncommittedChanges: undefined,
    });
    expect(r.verdict).toBe("stalled");
  });
});

describe("the unmerged band — the most common gray row", () => {
  /** The band as a real consumer meets it: the OVERLAID status, with the stage not separately read.
   *  `hasUnlandedWork` is deliberately ABSENT here — the whole claim under test is that the status
   *  itself answers for it, so a fixture that pre-answered would make these assertions vacuous. */
  function unmergedRow(over: Partial<StallInput> = {}): StallInput {
    return {
      status: "unmerged",
      now: T0,
      goal: undefined,
      hasOpenPr: false,
      hasUncommittedChanges: false,
      ...over,
    };
  }

  // `unmergedAttention.withUnmergedWork` rewrites any resting row with committed-but-unlanded work
  // to `unmerged` (GRAY, "Needs merge"), and that overlay is applied to the maps the UI and the
  // notification path read. 27 of 51 agents sat in that band on a real fleet. Reading it as
  // `active` told the concierge an agent was busy while it was doing nothing (roborev 55252).
  it("an unmerged agent with an unmet goal is STALLED, not active", () => {
    const r = stallReport(unmergedRow({ goal: newGoal("g", T0) }));
    expect(r.verdict).toBe("stalled");
    // The goal FIRST — it is the more actionable of the two — then the band's own unlanded work.
    expect(r.causes).toEqual(["unmet-goal", "unlanded-work"]);
  });

  it("makes the open-pr cause reachable at all", () => {
    // An agent with an open PR is in the unmerged band by construction, so while `isQuiet` accepted
    // only `idle` this cause was filtered out before `hasOpenPr` was ever consulted.
    const r = stallReport(unmergedRow({ hasOpenPr: true }));
    expect(r.verdict).toBe("stalled");
    // `unlanded-work` is NOT listed beside it HERE, because it was inferred from the band and an agent
    // with an open PR has unlanded commits by construction — reporting both said the same fact twice
    // (roborev 55298). The fold is unconditional; see the next test.
    expect(r.causes).toEqual(["open-pr"]);
    expect(r.detail).not.toContain("never reached main");
  });

  it("folds even an EXPLICIT hasUnlandedWork into the open PR — same fact, one clause", () => {
    // The fold is unconditional on purpose. Scoping it to the inferred case created a distinction
    // that does not exist in production: the only producer derives `hasUnlandedWork` from the same
    // stage band the PR is in, so "explicit" carried no extra information and the duplicated sentence
    // came back for every open-PR row (roborev 55379). "Commits beyond the PR" is a real question and
    // needs its own input, not a re-reading of this one.
    const r = stallReport(unmergedRow({ hasOpenPr: true, hasUnlandedWork: true }));
    expect(r.causes).toEqual(["open-pr"]);
    expect(r.detail).not.toContain("never reached main");
  });

  it("the BAND ITSELF is outstanding work — never 'genuinely done'", () => {
    // This used to read `finished — genuinely done` for a row whose own label says "Needs merge".
    // `withUnmergedWork` writes `unmerged` ONLY where `hasUnmergedCommittedWork(stage)` held, so
    // the status is the evidence: committed work that never reached main. Saying "genuinely done"
    // about it is the same false sentence the `expired-goal` cause exists to stop, and it landed on
    // the most common gray row on the fleet. No goal, no PR, clean tree — still not done.
    const r = stallReport(unmergedRow());
    expect(r.verdict).toBe("stalled");
    expect(r.causes).toEqual(["unlanded-work"]);
    expect(r.detail).not.toContain("genuinely done");
  });

  it("an explicit `hasUnlandedWork: false` beats the band — a caller that LOOKED wins", () => {
    // The status is a default, not an override: a caller holding a fresher stage read (the work
    // landed a second ago, the map has not caught up) must be able to say so.
    expect(stallReport(unmergedRow({ hasUnlandedWork: false })).verdict).toBe("finished");
  });
});

describe("which statuses the question even applies to", () => {
  it("a working agent is 'active', never stalled", () => {
    const r = stallReport(finished({ status: "working", goal: newGoal("g", T0) }));
    expect(r.verdict).toBe("active");
    expect(r.causes).toEqual([]);
  });

  // The red tier is already loud and already understood. Adding a stall badge there would put a
  // second alarm on the row that is not the problem; the gray rows are.
  it.each(["waiting", "approval", "blocked", "errored"] as const)(
    "%s is left to the existing red alarm",
    (status) => {
      expect(stallReport(finished({ status, goal: newGoal("g", T0) })).verdict).toBe("active");
    },
  );

  // A dead process with a dirty worktree is a cleanup question, not a stall resuming could fix.
  it.each(["done", "stopped"] as const)("%s is not a stall", (status) => {
    expect(
      stallReport(finished({ status, goal: newGoal("g", T0), hasUncommittedChanges: true })).verdict,
    ).toBe("active");
  });
});
