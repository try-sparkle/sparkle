import { describe, expect, it } from "vitest";
import type { AgentTabStatus } from "@sparkle/ui";
import { AGENT_STATUS } from "@sparkle/ui";
import { newGoal } from "./agentGoal";
import { stallReport, type StallInput } from "./agentStall";
import { ESCALATED_STATUS, mustLeaveCalm, withStallAttention } from "./stallEscalation";
import { EMPTY_ALERT, alertControlKind, deEscalatedStatus } from "./alertDismissal";

const T0 = 1_700_000_000_000;
const AGENTS = [{ id: "a" }, { id: "b" }];

/** A row whose git state was fully READ and has nothing outstanding — genuinely finished. */
function resting(over: Partial<StallInput> = {}): StallInput {
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

const reportFor = (input: StallInput) => (id: string) => (id === "a" ? stallReport(input) : undefined);

describe("THE FOUNDER'S ACCEPTANCE TEST — gray is a terminal state", () => {
  // "An agent with an unmet goal, or with uncommitted changes, or with an open unmerged branch, must
  // never render gray. If your state model can produce that combination, it is not finished."
  const cases: Array<[string, StallInput]> = [
    ["an unmet goal", resting({ goal: newGoal("ship the ladder", T0) })],
    ["uncommitted changes", resting({ hasUncommittedChanges: true })],
    ["an open unmerged PR", resting({ hasOpenPr: true })],
    ["committed work that never landed", resting({ hasUnlandedWork: true })],
    ["an escalated goal", resting({ goal: { ...newGoal("hard", T0), escalatedAt: T0 + 1 } })],
    ["an expired goal", resting({ goal: newGoal("stale", T0, 1_000), now: T0 + 5_000 })],
  ];

  it.each(cases)("a row with %s does not render gray", (_label, input) => {
    const out = withStallAttention(AGENTS, { a: "idle", b: "working" }, reportFor(input));
    expect(out.a).toBe("blocked");
    // The actual requirement, asserted against the token table rather than a status name — a future
    // rename cannot quietly satisfy the letter of this test while breaking the rule.
    expect(AGENT_STATUS[out.a as AgentTabStatus].color).not.toBe(AGENT_STATUS.idle.color);
  });

  it.each(cases)("...and the same holds from the `unmerged` band, with %s", (_label, input) => {
    const out = withStallAttention(AGENTS, { a: "unmerged", b: "working" }, reportFor(input));
    expect(out.a).toBe("blocked");
  });

  it("STUCK IS RED — the founder's second complaint, asserted as colour", () => {
    // "the user also asked why an agent that is STUCK is not red. Their expectation is that stuck
    // means red, not gray."
    const out = withStallAttention(
      AGENTS,
      { a: "idle" },
      reportFor(resting({ goal: newGoal("stuck on the merge", T0) })),
    );
    expect(AGENT_STATUS[out.a as AgentTabStatus].color).toBe(AGENT_STATUS.waiting.color);
  });
});

describe("what it must NOT recolour", () => {
  it("leaves a genuinely finished row gray — gray still means something", () => {
    // If everything went red, the colour would carry no information, which is the 27-of-51 failure
    // the 2026-07-26 de-redding was about.
    const out = withStallAttention(AGENTS, { a: "idle" }, reportFor(resting()));
    expect(out.a).toBe("idle");
  });

  it("returns the SAME map reference when nothing is escalated — no render churn", () => {
    const map: Record<string, AgentTabStatus> = { a: "idle", b: "done" };
    expect(withStallAttention(AGENTS, map, reportFor(resting()))).toBe(map);
  });

  it("never touches a WORKING row, however much it owes", () => {
    // The green tier is the one colour that was already telling the truth.
    const out = withStallAttention(
      AGENTS,
      { a: "working" },
      reportFor(resting({ status: "working", goal: newGoal("g", T0) })),
    );
    expect(out.a).toBe("working");
  });

  it.each(["waiting", "approval", "errored", "blocked"] as const)(
    "leaves the already-red %s row alone — no second alarm on the row that is not the problem",
    (status) => {
      const out = withStallAttention(
        AGENTS,
        { a: status },
        reportFor(resting({ status, goal: newGoal("g", T0) })),
      );
      expect(out.a).toBe(status);
    },
  );

  it("does NOT escalate an unread git state — a red dot on ignorance trains the human to ignore it", () => {
    // verdict `unknown`: no cause was found, but nothing was looked up either.
    const unread = stallReport({ status: "idle", now: T0, goal: undefined });
    expect(unread.verdict).toBe("unknown");
    expect(mustLeaveCalm(unread)).toBe(false);
    expect(withStallAttention(AGENTS, { a: "idle" }, () => unread).a).toBe("idle");
  });

  it("does NOT escalate an agent this window has no reading for", () => {
    expect(mustLeaveCalm(undefined)).toBe(false);
    expect(withStallAttention(AGENTS, { a: "idle" }, () => undefined).a).toBe("idle");
  });

  it("leaves an unbriefed `new` agent alone", () => {
    // Not by an exclusion here but by construction: `stallReport` answers `active` for it, so no
    // report about a new agent is ever stalled. Keeps newAgentAttention's work intact.
    const out = withStallAttention(AGENTS, { a: "new" }, reportFor(resting({ status: "new" })));
    expect(out.a).toBe("new");
  });

  it("leaves a DEAD process alone — 'unstick it' is the wrong sentence for a stopped agent", () => {
    // The documented remaining gap: a stopped agent holding a dirty worktree still renders gray.
    // `stallReport` answers `active` for done/stopped, so this is what the model produces today.
    for (const status of ["done", "stopped"] as const) {
      const out = withStallAttention(
        AGENTS,
        { a: status },
        reportFor(resting({ status, hasUncommittedChanges: true })),
      );
      expect(out.a).toBe(status);
    }
  });
});

describe("the red it produces is a red the human can live with", () => {
  it("is DISMISSIBLE — the undismissable red is what sank the 2026-07-26 version", () => {
    // `unmerged` went red once before and could not be acknowledged, because the dismissal tier only
    // covered waiting|approval|errored. Escalating to `blocked` inherits the fix rather than the bug.
    // Asserted through the control the row actually offers, not a private predicate.
    expect(alertControlKind(EMPTY_ALERT, ESCALATED_STATUS)).toBe("dismiss");
    // ...and acknowledging it lands back in the calm tier rather than claiming the agent stopped.
    expect(deEscalatedStatus("blocked")).toBe("idle");
  });

  it("escalates only the rows that owe something, across a mixed fleet", () => {
    const out = withStallAttention(
      [{ id: "stalled" }, { id: "clean" }, { id: "busy" }],
      { stalled: "idle", clean: "idle", busy: "working" },
      (id) =>
        id === "stalled"
          ? stallReport(resting({ goal: newGoal("g", T0) }))
          : id === "clean"
            ? stallReport(resting())
            : undefined,
    );
    expect(out).toEqual({ stalled: "blocked", clean: "idle", busy: "working" });
  });
});
