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

  it("a DISCHARGED goal is finished too — on git's proof rather than the agent's word", () => {
    // The gate tested only `met`, so a goal `goalExpiry` discharged (git PROVED the work is in the
    // default branch and the tree is clean) fell through to a resurrectable cause and the fleet could
    // restart work already confirmed landed — the "undoes a completed decision" failure this gate is
    // FIRST in order to prevent, arriving through the one door it did not check. `GoalState` is a
    // union but this is a VALUE comparison, so adding the state was not a compile error here.
    const dischargedAt = NOW - 5_000;
    const v = classifyDeath(
      obs({
        goal: goal({ dischargedAt, dischargedSha: "a1b2c3d", dischargedBaseSha: "d4e5f6a" }),
        terminator: "pty-exit",
      }),
    );
    expect(v.cause).toBe("clean-goal-met");
    expect(v.goalMetAt).toBe(dischargedAt);
    // The evidence names WHICH claimant proved it — the agent's own assertion and git's are different
    // facts, and a reader deciding whether to resurrect should be able to tell them apart.
    expect(v.evidence).toBe("goal-discharged-on-git-proof");
  });

  it("…but a goal in NEITHER finished state still falls through — the pair, not a blanket calm", () => {
    // The control leg. Without it, "discharged is finished" is satisfied by an implementation that
    // calls every goal finished.
    const v = classifyDeath(obs({ goal: goal({ escalatedAt: NOW - 5_000 }), terminator: "pty-exit" }));
    expect(v.cause).not.toBe("clean-goal-met");
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

// The RETAINED banner (`recentFailure`) as a pure input. The test that reproduces the RACE which
// makes this field necessary lives in `services/deathRecordWriter.test.ts` and drives a real
// `StatusEngine` — a hand-built observation cannot reproduce a sequence of calls inside the engine,
// so it would prove nothing about the bug. What belongs HERE is the gate arithmetic: given the field,
// which gate claims it, and — the part that is easy to get wrong — which gates must ignore it.
describe("the retained banner is a strict FALLBACK, admitted only where the live signals said nothing", () => {
  it("classifies transport-transient when only the retained banner is left", () => {
    const v = classifyDeath(obs({ recentFailure: { message: ENOTFOUND, at: NOW - 1_000 } }));
    expect(v).toEqual({
      cause: "transport-transient",
      evidence: "api-banner",
      message: ENOTFOUND,
    });
  });

  it("prefers the LIVE banner when both are present — it is the stronger evidence", () => {
    // The live reading means the agent was still sitting in the failure when it died. The retained
    // one only means it printed that at some point inside the window, so a stale retained copy must
    // never speak over a current one.
    const v = classifyDeath(
      obs({
        lastFailure: { message: OVERLOADED, at: NOW },
        recentFailure: { message: ENOTFOUND, at: NOW - 200_000 },
      }),
    );
    expect(v).toMatchObject({ cause: "transport-transient", message: OVERLOADED });
  });

  it("NEVER demotes a clean-goal-met — a finished agent must not be resurrected", () => {
    // THE REGRESSION THIS FIELD COULD HAVE CAUSED, and the reason Gate 1 reads only the live
    // signals. An agent that blipped, recovered, did its work, marked its goal met and exited
    // cleanly still carries a retained banner for up to TRANSPORT_FAILURE_WINDOW_MS. If that reached
    // Gate 1 the agent would be recorded under a RESURRECTABLE cause and the fleet would restart
    // work that was already finished — the "undoes a completed decision" failure Gate 1 is first to
    // prevent. The paired positive is the test above: the same banner DOES decide when no goal was
    // met, so this is a statement about gate order rather than about the field being ignored.
    const metAt = NOW - 1_000;
    const v = classifyDeath(
      obs({
        goal: goal({ metAt }),
        recentFailure: { message: ENOTFOUND, at: NOW - 1_000 },
        terminator: "pty-exit",
      }),
    );
    expect(v).toEqual({ cause: "clean-goal-met", evidence: "goal-met-marked", goalMetAt: metAt });
  });

  it("routes a retained ACCOUNT WALL to wall-session, never to transport-transient", () => {
    // Defence in depth rather than a path the line-scanner can produce today: `apiErrorFramesIn` is
    // anchored to `^api error:` and `ACCOUNT_LIMIT_OPENER` to `^you've hit your`, so no single
    // captured line can satisfy both and the engine's own capture cannot currently retain a terminal
    // message. The gate exists anyway, for the same reason `effectiveWall` re-parses `lastFailure`:
    // the field is typed as "a banner", any future capture site could put a wall in it, and the cost
    // of being wrong here is retrying against a door no keystroke opens — the measured 45-retry
    // failure. Re-parsed through `quotaBlocksIn`, the SAME function, never a second matcher.
    const v = classifyDeath(obs({ recentFailure: { message: SESSION_WALL, at: NOW - 1_000 } }));
    expect(v).toMatchObject({ cause: "wall-session", evidence: "quota-block" });
    expect(v.wall).toMatchObject({ message: SESSION_WALL, resetParsed: true });
  });

  it("routes a retained SPEND cap to wall-spend, with no invented reset instant", () => {
    const v = classifyDeath(obs({ recentFailure: { message: SPEND_WALL, at: NOW - 1_000 } }));
    expect(v).toMatchObject({ cause: "wall-spend" });
    expect(v.wall?.resetAt, "a spend cap has no reset and one must never be persisted").toBeUndefined();
  });

  it("still refuses to claim anything when this window did not watch the agent", () => {
    // Gate 0 is unconditional and FIRST, so the new field cannot become a way around it.
    const v = classifyDeath(
      obs({ liveness: "other-window", recentFailure: { message: ENOTFOUND, at: NOW } }),
    );
    expect(v).toEqual({ cause: "unknown", evidence: "none" });
  });

  it("is outranked by a person waiting — a respawn re-asks nothing", () => {
    const v = classifyDeath(
      obs({ blockingTool: "AskUserQuestion", recentFailure: { message: ENOTFOUND, at: NOW } }),
    );
    expect(v).toEqual({ cause: "blocked-on-human", evidence: "blocking-tool" });
  });

  it("PAIRED NEGATIVE — no retained banner still yields unknown", () => {
    // Without this, every assertion above is compatible with a bug that returned a cause for any
    // pty-exit at all.
    expect(classifyDeath(obs({ recentFailure: undefined }))).toEqual({
      cause: "unknown",
      evidence: "pty-exit",
    });
  });

  it.each([ENOTFOUND, OVERLOADED, STALLED])(
    "accepts every retryable banner shape the fleet actually prints: %s",
    (message) => {
      expect(classifyDeath(obs({ recentFailure: { message, at: NOW } }))).toMatchObject({
        cause: "transport-transient",
        message,
      });
    },
  );
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
