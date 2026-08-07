import { describe, expect, it } from "vitest";

import type { AgentGoal } from "./agentGoal";
import { type DeathObservation, classifyDeath } from "./deathRecord";
import { verdictIsSupported } from "./deathTypes";
import { quotaBlocksIn } from "./quotaBlock";

// The REAL strings, copied verbatim from the founder's own transcripts. Paraphrasing them would make
// every assertion below prove something about a string this app never sees.
const SESSION_WALL = "You've hit your session limit · resets 10:30pm (America/Los_Angeles)";
const SPEND_WALL = "You've hit your monthly spend limit · raise it at claude.ai/settings/usage";
const ENOTFOUND = "API Error: Unable to connect to API (ENOTFOUND)";
const OVERLOADED = "API Error: 529 Overloaded";
const STALLED = "API Error: Response stalled mid-stream. The response above may be incomplete.";

const NOW = 1_754_534_400_000;

function obs(over: Partial<DeathObservation> = {}): DeathObservation {
  return {
    quota: undefined,
    lastFailure: undefined,
    liveness: "local",
    goal: undefined,
    blockingTool: undefined,
    terminator: "pty-exit",
    now: NOW,
    ...over,
  };
}

function goal(over: Partial<AgentGoal> = {}): AgentGoal {
  return {
    text: "land the retry PR",
    setAt: NOW - 60_000,
    ttlMs: 4 * 60 * 60_000,
    continues: 0,
    totalContinues: 0,
    ...over,
  };
}

describe("Gate 0 — a window that did not watch the agent claims nothing", () => {
  it.each(["other-window", "unknown"] as const)(
    "returns unknown/none for liveness=%s even when every other signal is loud",
    (liveness) => {
      // Everything here would otherwise produce a confident verdict. None of it may be believed,
      // because `engineRegistry` returns undefined for BOTH "healthy" and "no pane in this window" —
      // so a reading from a window that wasn't watching is not evidence of anything.
      const v = classifyDeath(
        obs({
          liveness,
          quota: quotaBlocksIn(SESSION_WALL, NOW)[0],
          lastFailure: { message: ENOTFOUND, at: NOW },
          blockingTool: "AskUserQuestion",
          goal: goal({ metAt: NOW - 1000 }),
        }),
      );
      expect(v).toEqual({ cause: "unknown", evidence: "none" });
    },
  );

  it("does observe when liveness is local", () => {
    const v = classifyDeath(obs({ lastFailure: { message: ENOTFOUND, at: NOW } }));
    expect(v.cause).toBe("transport-transient");
  });
});

describe("the two walls are told apart by resetParsed, not by a new regex", () => {
  it("classifies a session limit as wall-session and keeps its parsed reset", () => {
    const q = quotaBlocksIn(SESSION_WALL, NOW)[0];
    expect(q?.resetParsed).toBe(true); // guards the fixture: if this flips the test below is hollow

    const v = classifyDeath(obs({ quota: q, terminator: "quota-trip" }));
    expect(v.cause).toBe("wall-session");
    expect(v.wall?.resetParsed).toBe(true);
    expect(v.wall?.resetAt).toBe(q?.resetAt);
    expect(v.wall?.resetAt).toBeGreaterThan(NOW);
  });

  it("classifies a monthly spend cap as wall-spend and DROPS the fabricated reset", () => {
    const q = quotaBlocksIn(SPEND_WALL, NOW)[0];
    expect(q?.resetParsed).toBe(false);
    // quotaBlock still carries its bounded re-check value; the record must not persist it as a
    // reset instant, or a clock-armed recovery fires at a door only a human opens.
    expect(q?.resetAt).toBeGreaterThan(NOW);

    const v = classifyDeath(obs({ quota: q, terminator: "quota-trip" }));
    expect(v.cause).toBe("wall-spend");
    expect(v.wall?.resetParsed).toBe(false);
    expect(v.wall?.resetAt).toBeUndefined();
  });

  it("keeps the wall message byte-for-byte", () => {
    // Cohort correlation keys a map on exact equality. A trim or a re-case here silently prevents
    // "N agents died of one cause" from ever grouping.
    const v = classifyDeath(obs({ quota: quotaBlocksIn(SPEND_WALL, NOW)[0], terminator: "quota-trip" }));
    expect(v.wall?.message).toBe(SPEND_WALL);
    expect(v.message).toBe(SPEND_WALL);
  });

  it("finds a wall that arrived only via lastFailure, and does NOT call it transient", () => {
    // The trap: if we looked only at `o.quota`, an account limit reaching us through the failure
    // channel would classify transport-transient and be retried straight into the wall.
    const v = classifyDeath(obs({ lastFailure: { message: SESSION_WALL, at: NOW } }));
    expect(v.cause).toBe("wall-session");
    expect(v.cause).not.toBe("transport-transient");
  });
});

describe("transport faults", () => {
  it.each([ENOTFOUND, OVERLOADED, STALLED])("classifies %s as transport-transient", (message) => {
    const v = classifyDeath(obs({ lastFailure: { message, at: NOW } }));
    expect(v.cause).toBe("transport-transient");
    expect(v.evidence).toBe("api-banner");
    expect(v.message).toBe(message);
  });
});

describe("clean-goal-met — the verdict that must never be resurrected", () => {
  it("requires a positive metAt, not merely a turn that ended", () => {
    const v = classifyDeath(obs({ goal: goal(), terminator: "pty-exit" }));
    expect(v.cause).toBe("unknown");
    expect(v.cause).not.toBe("clean-goal-met");
  });

  it("classifies a marked, quiet exit as clean-goal-met and carries the mark", () => {
    const metAt = NOW - 5_000;
    const v = classifyDeath(obs({ goal: goal({ metAt }), terminator: "pty-exit" }));
    expect(v.cause).toBe("clean-goal-met");
    expect(v.goalMetAt).toBe(metAt);
  });

  it("does NOT call it clean when a wall ended the session after the goal was met", () => {
    // A stale met-mark plus a wall is not a clean exit, and treating it as one would make the agent
    // permanently unresurrectable on the strength of that mark.
    const v = classifyDeath(
      obs({
        goal: goal({ metAt: NOW - 5_000 }),
        quota: quotaBlocksIn(SESSION_WALL, NOW)[0],
        terminator: "quota-trip",
      }),
    );
    expect(v.cause).toBe("wall-session");
  });

  it("does NOT call it clean when an API error ended the session after the goal was met", () => {
    const v = classifyDeath(
      obs({ goal: goal({ metAt: NOW - 5_000 }), lastFailure: { message: ENOTFOUND, at: NOW } }),
    );
    expect(v.cause).toBe("transport-transient");
  });

  it("does not fire for an expired or escalated goal", () => {
    const expired = classifyDeath(
      obs({ goal: goal({ setAt: NOW - 5 * 60 * 60_000, ttlMs: 60_000 }) }),
    );
    expect(expired.cause).toBe("unknown");

    const escalated = classifyDeath(obs({ goal: goal({ escalatedAt: NOW - 1000 }) }));
    expect(escalated.cause).toBe("unknown");
  });
});

describe("blocked-on-human", () => {
  it.each(["AskUserQuestion", "ExitPlanMode"] as const)(
    "classifies a %s block as blocked-on-human",
    (tool) => {
      const v = classifyDeath(obs({ blockingTool: tool }));
      expect(v.cause).toBe("blocked-on-human");
      expect(v.evidence).toBe("blocking-tool");
    },
  );

  it("is NOT triggered by the idle-ping text, which is an anti-signal", () => {
    // "Claude is waiting for your input" fires ~60s AFTER Stop and means "your turn", not "I am
    // blocked". 37 of 348 hook streams end on it; keying on it would strand every one of them.
    const v = classifyDeath(
      obs({ lastFailure: { message: "Claude is waiting for your input", at: NOW } }),
    );
    expect(v.cause).not.toBe("blocked-on-human");
    expect(v.cause).toBe("unknown");
  });

  it("loses to a wall, because the wall is what actually stops the agent", () => {
    const v = classifyDeath(
      obs({ blockingTool: "AskUserQuestion", quota: quotaBlocksIn(SPEND_WALL, NOW)[0] }),
    );
    expect(v.cause).toBe("wall-spend");
  });
});

describe("unknown is first-class and honest", () => {
  it("names the evidence for a bare PTY exit without inventing a cause", () => {
    expect(classifyDeath(obs({ terminator: "pty-exit" }))).toEqual({
      cause: "unknown",
      evidence: "pty-exit",
    });
  });

  it("names the evidence for a bare SessionEnd", () => {
    expect(classifyDeath(obs({ terminator: "session-end" }))).toEqual({
      cause: "unknown",
      evidence: "session-end-hook",
    });
  });

  it("returns no-evidence when nothing at all terminated it", () => {
    expect(classifyDeath(obs({ terminator: undefined }))).toEqual({
      cause: "unknown",
      evidence: "none",
    });
  });
});

describe("every verdict this module can produce satisfies the honesty rule", () => {
  it("holds across the whole observation space", () => {
    const quotas = [undefined, quotaBlocksIn(SESSION_WALL, NOW)[0], quotaBlocksIn(SPEND_WALL, NOW)[0]];
    const failures = [undefined, { message: ENOTFOUND, at: NOW }, { message: SPEND_WALL, at: NOW }];
    const goals = [undefined, goal(), goal({ metAt: NOW - 1000 })];
    const tools = [undefined, "AskUserQuestion" as const];
    const terms = [undefined, "pty-exit" as const, "session-end" as const, "quota-trip" as const];
    const livenesses = ["local", "other-window", "unknown"] as const;

    let checked = 0;
    for (const quota of quotas)
      for (const lastFailure of failures)
        for (const g of goals)
          for (const blockingTool of tools)
            for (const terminator of terms)
              for (const liveness of livenesses) {
                const v = classifyDeath(
                  obs({ quota, lastFailure, goal: g, blockingTool, terminator, liveness }),
                );
                expect(verdictIsSupported(v)).toBe(true);
                checked++;
              }
    // Guards against the loop silently collapsing to nothing — a green pass over zero cases is the
    // classic vacuous test.
    expect(checked).toBe(3 * 3 * 3 * 2 * 4 * 3);
  });
});
