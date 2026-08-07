// The arithmetic of verify-before-speak: which facts a finding rests on, and what a contradiction is
// allowed to change.
//
// Every assertion here is about the SIDE EFFECT — the evidence that comes back out, and the sentence
// `evaluateFleetConditions` then composes from it — never about the claim list being well-formed.
// A test that only checked "we asked about PR 1358" would have passed against the broken code too,
// because the broken code's failure is that nothing consumed the answer.

import { describe, expect, it } from "vitest";
import {
  claimKey,
  claimsForConditions,
  claimsForTriggers,
  pruneRefutedFleetEvidence,
  pruneRefutedObservation,
  verdictOf,
  type ClaimVerdicts,
  type PusherClaim,
} from "./pusherVerify";
import {
  conflictCondition,
  evaluateFleetConditions,
  type ConflictingPr,
  type FleetSnapshot,
} from "./pusherFleet";
import { evaluateTriggers, type Observation } from "./pusherTriggers";

const NOW = 1_700_000_000_000;

function conflict(over: Partial<ConflictingPr> & { pr: number }): ConflictingPr {
  return {
    branch: "feature",
    ownerAgentId: null,
    kind: "stale",
    commitsBehind: 40,
    unresolvedSecs: 7200,
    evidence: "n/a",
    ...over,
  };
}

function snapshot(over: Partial<FleetSnapshot> & { agentId: string }): FleetSnapshot {
  return { label: "Some Agent", ...over };
}

const verdicts = (entries: Array<[PusherClaim, "holds" | "refuted" | "unreadable"]>): ClaimVerdicts =>
  new Map(entries.map(([claim, v]) => [claimKey(claim), v]));

describe("claimKey", () => {
  it("keys the two OPPOSITE unlanded-work claims about one agent differently", () => {
    // The whole reason claims name an assertion rather than a subject. Collapse these and one
    // finding's verdict silently decides the other's, in the wrong direction.
    const holds = claimKey({ kind: "agent-holds-unlanded-work", agentId: "a1" });
    const hasNone = claimKey({ kind: "agent-has-no-unlanded-work", agentId: "a1" });
    expect(holds).not.toBe(hasNone);
  });
});

describe("verdictOf", () => {
  it("reads an UNASKED claim as unreadable, never as holds", () => {
    // An absent verdict and a failed read are the same fact — nothing was learned — and neither may
    // license a change. Defaulting to "holds" would be indistinguishable and would quietly restore
    // the unverified behaviour for every claim a verifier forgot to answer.
    expect(verdictOf(new Map(), { kind: "pr-open", pr: 7 })).toBe("unreadable");
  });
});

describe("claimsForConditions", () => {
  it("asks about EVERY conflicting PR, including the ones whose owner is unresolved", () => {
    // `conflictCondition.agentIds` holds RESOLVED owners only, and the five PRs that motivated the
    // class all resolve to null. Reading claims off agentIds would ask about nothing for exactly the
    // case the class exists to find.
    const conflicts = [conflict({ pr: 1358 }), conflict({ pr: 1406, ownerAgentId: "a1" })];
    const condition = conflictCondition(conflicts, []);
    const claims = claimsForConditions([condition], [], conflicts);
    expect(claims).toEqual([
      { kind: "pr-open", pr: 1358 },
      { kind: "pr-open", pr: 1406 },
    ]);
  });

  it("asks whether an escalated agent's goal is actually unmet", () => {
    const snaps = [snapshot({ agentId: "a1", escalation: { reason: "blocked" } })];
    const conditions = evaluateFleetConditions(snaps, NOW, [], undefined);
    expect(claimsForConditions(conditions, snaps, undefined)).toEqual([
      { kind: "goal-unmet", agentId: "a1" },
    ]);
  });

  it("asks BOTH halves of a retire claim — the work AND the met goal", () => {
    const snaps = [
      snapshot({ agentId: "a1", goalMetAt: NOW - 1000, hasUnlandedWork: false, retroSettled: true }),
    ];
    const conditions = evaluateFleetConditions(snaps, NOW, [], undefined);
    expect(claimsForConditions(conditions, snaps, undefined)).toEqual([
      { kind: "agent-has-no-unlanded-work", agentId: "a1" },
      { kind: "goal-unmet", agentId: "a1" },
    ]);
  });

  it("asks nothing about quota, shared failure or duties — none has a contradictable observable", () => {
    const snaps = [
      snapshot({ agentId: "a1", quota: { message: "limit", resetAt: NOW + 60_000, resetParsed: true } }),
      snapshot({ agentId: "a2", failure: { message: "ENOTFOUND", at: NOW - 1000 } }),
      snapshot({ agentId: "a3", failure: { message: "ENOTFOUND", at: NOW - 2000 } }),
    ];
    const duties = [{ name: "hourly pass", intervalMs: 3_600_000, lastRunAt: NOW - 9 * 3_600_000 }];
    const conditions = evaluateFleetConditions(snaps, NOW, duties, undefined);
    expect(conditions.map((c) => c.id)).toEqual(["quota-blocked", "shared-failure", "duty-overdue"]);
    expect(claimsForConditions(conditions, snaps, undefined)).toEqual([]);
  });
});

describe("claimsForTriggers", () => {
  it("maps unpushed-commits and goal-expired to their claims, and nothing else", () => {
    const obs: Observation = {
      hasUnlandedWork: true,
      oldestUnpushedAt: NOW - 60 * 60_000,
      goalExpiresAt: NOW - 60_000,
      goalMet: false,
      roborevRounds: 12,
      questionUnansweredSince: NOW - 60 * 60_000,
      now: NOW,
    };
    const triggers = evaluateTriggers(obs);
    expect(triggers.map((t) => t.id).sort()).toEqual([
      "goal-expired",
      "roborev-rounds",
      "unanswered-question",
      "unpushed-commits",
    ]);
    expect(claimsForTriggers(triggers, "a1")).toEqual([
      { kind: "goal-unmet", agentId: "a1" },
      { kind: "agent-holds-unlanded-work", agentId: "a1" },
    ]);
  });
});

describe("pruneRefutedFleetEvidence — a MERGED pr", () => {
  it("drops a merged PR so the report no longer calls it open-and-drifting", () => {
    // The founder's #1358/#1406 case: both reported as "mergeable but drifting behind main" hours
    // after they had merged. Asserted on the composed TEXT, because that is what the founder read —
    // a test that only counted the conflicts array would pass against a build that dropped the entry
    // and then composed the sentence from somewhere else.
    const conflicts = [conflict({ pr: 1358, branch: "still-open" }), conflict({ pr: 1406, branch: "merged-already" })];
    const before = evaluateFleetConditions([], NOW, [], conflicts);
    expect(before[0]!.text).toContain("#1406");
    expect(before[0]!.text).toContain("2 open PRs are behind main");

    const pruned = pruneRefutedFleetEvidence(
      { snapshots: [], conflicts },
      verdicts([[{ kind: "pr-open", pr: 1406 }, "refuted"]]),
    );
    const after = evaluateFleetConditions([], NOW, [], pruned.conflicts);
    expect(after[0]!.text).not.toContain("#1406");
    expect(after[0]!.text).toContain("#1358");
    // The HEADLINE COUNT is recomposed, not merely the line list. This is why pruning happens
    // upstream of composition: a filter applied to the finished text would leave "2 open PRs" over
    // one line and `measured` still holding a 2, which `gateChallenge` refuses wholesale.
    expect(after[0]!.text).toContain("1 open PR is behind main");
    expect(after[0]!.measured).toContain("1358");
    expect(after[0]!.measured).not.toContain("1406");
  });

  it("goes SILENT when every PR in the class turned out to be merged", () => {
    const conflicts = [conflict({ pr: 1358 }), conflict({ pr: 1406 })];
    const pruned = pruneRefutedFleetEvidence(
      { snapshots: [], conflicts },
      verdicts([
        [{ kind: "pr-open", pr: 1358 }, "refuted"],
        [{ kind: "pr-open", pr: 1406 }, "refuted"],
      ]),
    );
    expect(pruned.conflicts).toEqual([]);
    expect(evaluateFleetConditions([], NOW, [], pruned.conflicts)).toEqual([]);
  });

  it("keeps a PR whose re-read FAILED — unreadable is not a refutation", () => {
    // Cover the other direction, per the standing rule: a `gh` outage must not silence a real
    // fleet-wide block. If this ever inverts, one network blip hides every conflicting PR at once.
    const conflicts = [conflict({ pr: 1358 })];
    const pruned = pruneRefutedFleetEvidence(
      { snapshots: [], conflicts },
      verdicts([[{ kind: "pr-open", pr: 1358 }, "unreadable"]]),
    );
    expect(pruned.conflicts).toEqual(conflicts);
    expect(evaluateFleetConditions([], NOW, [], pruned.conflicts)[0]!.text).toContain("#1358");
  });

  it("never turns 'we did not look' into 'we looked and everything merges'", () => {
    const pruned = pruneRefutedFleetEvidence(
      { snapshots: [], conflicts: undefined },
      verdicts([[{ kind: "pr-open", pr: 1358 }, "refuted"]]),
    );
    expect(pruned.conflicts).toBeUndefined();
  });
});

describe("pruneRefutedFleetEvidence — the RETIRE claim", () => {
  it("stops recommending retirement for an agent git says is mid-merge", () => {
    // Twice on 2026-08-07 an agent was reported "met their goal with no unlanded work, safe to
    // retire" while it was waiting to merge a PR. Retiring either would have destroyed work.
    const snaps = [
      snapshot({
        agentId: "a1",
        label: "One Sparkle Not Two",
        goalMetAt: NOW - 1000,
        hasUnlandedWork: false,
        retroSettled: true,
      }),
    ];
    expect(evaluateFleetConditions(snaps, NOW, [], undefined)[0]!.text).toContain("Safe to retire");

    const pruned = pruneRefutedFleetEvidence(
      { snapshots: snaps, conflicts: undefined },
      verdicts([[{ kind: "agent-has-no-unlanded-work", agentId: "a1" }, "refuted"]]),
    );
    expect(pruned.snapshots[0]!.hasUnlandedWork).toBe(true);
    expect(evaluateFleetConditions(pruned.snapshots, NOW, [], undefined)).toEqual([]);
  });

  it("still recommends retirement when git CONFIRMS the tree is clean", () => {
    const snaps = [
      snapshot({ agentId: "a1", goalMetAt: NOW - 1000, hasUnlandedWork: false, retroSettled: true }),
    ];
    const pruned = pruneRefutedFleetEvidence(
      { snapshots: snaps, conflicts: undefined },
      verdicts([
        [{ kind: "agent-has-no-unlanded-work", agentId: "a1" }, "holds"],
        [{ kind: "goal-unmet", agentId: "a1" }, "holds"],
      ]),
    );
    expect(evaluateFleetConditions(pruned.snapshots, NOW, [], undefined)[0]!.id).toBe("done-not-retired");
  });
});

describe("pruneRefutedFleetEvidence — an ESCALATED goal that is already satisfied", () => {
  it("stops reporting a finished agent as a dead end the founder must clear", () => {
    // 'Unblock The Conflicting Three' — escalated with "something is blocking it that restarting
    // cannot fix", while all three PRs it named were already mergeable with CI runs.
    const snaps = [
      snapshot({ agentId: "a1", label: "Unblock The Conflicting Three", escalation: { reason: "blocked" } }),
      snapshot({ agentId: "a2", label: "Still Genuinely Stuck", escalation: { reason: "needs a call" } }),
    ];
    expect(evaluateFleetConditions(snaps, NOW, [], undefined)[0]!.text).toContain("2 goals are escalated");

    const pruned = pruneRefutedFleetEvidence(
      { snapshots: snaps, conflicts: undefined },
      verdicts([[{ kind: "goal-unmet", agentId: "a1" }, "refuted"]]),
    );
    const after = evaluateFleetConditions(pruned.snapshots, NOW, [], undefined);
    expect(after[0]!.text).toContain("1 goal is escalated");
    expect(after[0]!.text).toContain("Still Genuinely Stuck");
    expect(after[0]!.text).not.toContain("Unblock The Conflicting Three");
  });

  it("does NOT latch goalMetAt — dropping a false report is not closing a goal", () => {
    // Writing `metAt` here would make an idle agent count as done on the strength of a report's
    // internal bookkeeping. That state change belongs to a resolver with the authority to make it.
    const snaps = [snapshot({ agentId: "a1", escalation: { reason: "blocked" } })];
    const pruned = pruneRefutedFleetEvidence(
      { snapshots: snaps, conflicts: undefined },
      verdicts([[{ kind: "goal-unmet", agentId: "a1" }, "refuted"]]),
    );
    expect(pruned.snapshots[0]!.goalMetAt).toBeUndefined();
    expect(pruned.snapshots[0]!.escalation).toBeUndefined();
  });

  it("keeps an escalation whose goal could not be re-read", () => {
    const snaps = [snapshot({ agentId: "a1", escalation: { reason: "blocked" } })];
    const pruned = pruneRefutedFleetEvidence(
      { snapshots: snaps, conflicts: undefined },
      verdicts([[{ kind: "goal-unmet", agentId: "a1" }, "unreadable"]]),
    );
    expect(evaluateFleetConditions(pruned.snapshots, NOW, [], undefined)[0]!.id).toBe("goals-escalated");
  });
});

describe("pruneRefutedObservation", () => {
  it("stops challenging a partner about work git says is already on origin/main", () => {
    // "an agent whose branch is an ancestor of origin/main must not be reported as having unlanded
    // work" — telling a partner to push finished work is advice to redo it.
    const obs: Observation = {
      hasUnlandedWork: true,
      unpushedCommits: 4,
      oldestUnpushedAt: NOW - 90 * 60_000,
      goalMet: false,
      roborevRounds: 0,
      now: NOW,
    };
    expect(evaluateTriggers(obs).map((t) => t.id)).toContain("unpushed-commits");

    const pruned = pruneRefutedObservation(
      obs,
      "a1",
      verdicts([[{ kind: "agent-holds-unlanded-work", agentId: "a1" }, "refuted"]]),
    );
    expect(evaluateTriggers(pruned)).toEqual([]);
  });

  it("corrects BOTH pieces of evidence — a surviving count would re-raise the trigger alone", () => {
    // `isHoldingWork` fires on either half, so clearing only the boolean leaves the trigger up on
    // `unpushedCommits: 4`. This is the assertion that would go green if the fix touched one field.
    const obs: Observation = {
      hasUnlandedWork: true,
      unpushedCommits: 4,
      oldestUnpushedAt: NOW - 90 * 60_000,
      goalMet: false,
      roborevRounds: 0,
      now: NOW,
    };
    const pruned = pruneRefutedObservation(
      obs,
      "a1",
      verdicts([[{ kind: "agent-holds-unlanded-work", agentId: "a1" }, "refuted"]]),
    );
    expect(pruned.hasUnlandedWork).toBe(false);
    expect(pruned.unpushedCommits).toBe(0);
  });

  it("stops challenging an expired goal whose condition is already satisfied", () => {
    const obs: Observation = {
      goalExpiresAt: NOW - 3 * 60 * 60_000,
      goalMet: false,
      roborevRounds: 0,
      now: NOW,
    };
    expect(evaluateTriggers(obs).map((t) => t.id)).toEqual(["goal-expired"]);

    const pruned = pruneRefutedObservation(
      obs,
      "a1",
      verdicts([[{ kind: "goal-unmet", agentId: "a1" }, "refuted"]]),
    );
    expect(evaluateTriggers(pruned)).toEqual([]);
  });

  it("returns the SAME object when nothing was refuted", () => {
    const obs: Observation = { goalMet: false, roborevRounds: 0, now: NOW };
    expect(
      pruneRefutedObservation(obs, "a1", verdicts([[{ kind: "goal-unmet", agentId: "a1" }, "holds"]])),
    ).toBe(obs);
  });

  it("leaves a roborev-rounds challenge alone — it rests on no re-readable claim", () => {
    const obs: Observation = { goalMet: false, roborevRounds: 12, now: NOW };
    const pruned = pruneRefutedObservation(
      obs,
      "a1",
      verdicts([
        [{ kind: "agent-holds-unlanded-work", agentId: "a1" }, "refuted"],
        [{ kind: "goal-unmet", agentId: "a1" }, "refuted"],
      ]),
    );
    expect(evaluateTriggers(pruned).map((t) => t.id)).toEqual(["roborev-rounds"]);
  });
});
