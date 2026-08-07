import { describe, expect, it } from "vitest";

import type { DeathCause } from "./deathTypes";
import {
  MAX_RESURRECTS_PER_AGENT_PER_DAY,
  RESURRECT_LADDER_MS,
  type ResurrectionInput,
  attemptsInWindow,
  decideResurrection,
  nextRungDueAt,
} from "./resurrection";

const NOW = 1_754_534_400_000;
const MIN = 60_000;

function input(over: Partial<ResurrectionInput> = {}): ResurrectionInput {
  return {
    cause: "transport-transient",
    processAlive: false,
    notBeforeMs: undefined,
    attemptsThisEpisode: 0,
    lastAttemptAt: undefined,
    diedAt: NOW - 10 * MIN,
    recentAttemptsAt: [],
    now: NOW,
    ...over,
  };
}

describe("the ladder", () => {
  it("is 8 rungs of 60s..30m totalling 1h26m — pinned BY VALUE, not derived", () => {
    // Pinned literally so an upstream edit to apiRecovery.REVIVE_LADDER_MS is NOTICED here rather
    // than silently inherited. If this goes red, that is the signal working, not a broken test.
    expect([...RESURRECT_LADDER_MS]).toEqual([
      60_000,
      2 * MIN,
      3 * MIN,
      5 * MIN,
      10 * MIN,
      15 * MIN,
      20 * MIN,
      30 * MIN,
    ]);
    expect(RESURRECT_LADDER_MS.length).toBe(8);
    expect(RESURRECT_LADDER_MS.reduce((a, b) => a + b, 0)).toBe(86 * MIN);
  });

  it("drops the sub-minute rungs a respawn cannot afford", () => {
    // A respawn is a worktree prep + transcript scan + `--resume` boot, not a keystroke.
    expect(Math.min(...RESURRECT_LADDER_MS)).toBeGreaterThanOrEqual(60_000);
  });

  it("measures the first rung from the death and later rungs from the last attempt", () => {
    const diedAt = NOW - 5 * MIN;
    expect(nextRungDueAt({ attemptsThisEpisode: 0, lastAttemptAt: undefined, diedAt })).toBe(
      diedAt + 60_000,
    );
    const lastAttemptAt = NOW - MIN;
    expect(nextRungDueAt({ attemptsThisEpisode: 1, lastAttemptAt, diedAt })).toBe(
      lastAttemptAt + 2 * MIN,
    );
  });

  it("PLATEAUS past the last rung instead of ending", () => {
    // A cliff here was a real bug (roborev 60067): a spend cap lifts when a human raises it, which
    // may be hours later, and an episode that stops probing has lost that agent until someone
    // notices. The ceiling is what keeps it probing.
    const ceiling = RESURRECT_LADDER_MS[RESURRECT_LADDER_MS.length - 1]!;
    for (const n of [RESURRECT_LADDER_MS.length, RESURRECT_LADDER_MS.length + 50]) {
      expect(nextRungDueAt({ attemptsThisEpisode: n, lastAttemptAt: NOW, diedAt: NOW })).toBe(
        NOW + ceiling,
      );
    }
  });
});

describe("the ladder and the cap are consistent — the bug roborev 60067 caught", () => {
  it("lets EVERY rung fire, so the documented curve is the one that ships", () => {
    // The cap is checked BEFORE the ladder, so a cap below the ladder's length made the last three
    // rungs unreachable. Asserted as a relationship rather than as two literals.
    expect(MAX_RESURRECTS_PER_AGENT_PER_DAY).toBeGreaterThanOrEqual(RESURRECT_LADDER_MS.length);
  });

  it("keeps probing well past 21 minutes, which is where the old cap stopped", () => {
    // Replays the exact defect: walk the ladder attempt by attempt and measure how long probing
    // survives. The old pairing died at 60s+2m+3m+5m+10m = 21m.
    let at = NOW;
    const attempts: number[] = [];
    for (let i = 0; i < MAX_RESURRECTS_PER_AGENT_PER_DAY; i++) {
      const due = nextRungDueAt({
        attemptsThisEpisode: i,
        lastAttemptAt: i === 0 ? undefined : at,
        diedAt: NOW,
      });
      at = due;
      const d = decideResurrection(
        input({
          cause: "wall-spend",
          attemptsThisEpisode: i,
          lastAttemptAt: i === 0 ? undefined : attempts[attempts.length - 1],
          recentAttemptsAt: attempts,
          now: at,
        }),
      );
      expect(d.action).toBe("respawn");
      attempts.push(at);
    }
    const survivedMs = at - NOW;
    expect(survivedMs).toBeGreaterThan(21 * MIN);
    // The DERIVED span, not a wish: the 8 ladder rungs total 86m, then the remaining attempts run at
    // the 30m ceiling — 86 + (24-8)*30 = 566 minutes, ~9.4 hours. Long enough to catch a session
    // limit and a spend cap a human raises the same working day. Asserted from the constants so a
    // change to either is noticed here.
    const derivedMs =
      RESURRECT_LADDER_MS.reduce((a, b) => a + b, 0) +
      (MAX_RESURRECTS_PER_AGENT_PER_DAY - RESURRECT_LADDER_MS.length) * 30 * MIN;
    expect(survivedMs).toBe(derivedMs);
    expect(survivedMs).toBeGreaterThanOrEqual(9 * 60 * MIN);
  });
});

describe("terminal causes are refused before anything else can mask them", () => {
  it("never resurrects an agent that finished", () => {
    const d = decideResurrection(input({ cause: "clean-goal-met" }));
    expect(d).toEqual({ action: "none", reason: "clean-goal-met" });
  });

  it("never resurrects an agent waiting on a person", () => {
    const d = decideResurrection(input({ cause: "blocked-on-human" }));
    expect(d).toEqual({ action: "none", reason: "blocked-on-human" });
  });

  it("refuses an unclassified death rather than guessing", () => {
    expect(decideResurrection(input({ cause: "unknown" }))).toEqual({
      action: "none",
      reason: "unclassified-death",
    });
  });

  it("refuses when nothing recorded the death", () => {
    expect(decideResurrection(input({ cause: undefined }))).toEqual({
      action: "none",
      reason: "no-death-record",
    });
  });

  it("reports the TERMINAL reason even when the agent is also mid-ladder and at its cap", () => {
    // The ordering guarantee: a finished agent must never be reported as "waiting-for-next-rung",
    // which would read as "it will come back shortly" for something that never should.
    const d = decideResurrection(
      input({
        cause: "clean-goal-met",
        attemptsThisEpisode: 99,
        recentAttemptsAt: Array.from({ length: 20 }, () => NOW - MIN),
      }),
    );
    expect(d).toEqual({ action: "none", reason: "clean-goal-met" });
  });
});

describe("liveness fails closed — the double-spawn guard", () => {
  it.each([true, undefined])("refuses to respawn when processAlive is %s", (processAlive) => {
    // `pty.rs`'s session map REPLACES silently, so a second spawn orphans the first child: still
    // running, still holding its worktree, still burning tokens, invisible everywhere. Only an
    // explicit `false` may pass.
    const d = decideResurrection(input({ processAlive }));
    expect(d).toEqual({ action: "none", reason: "already-live" });
  });

  it("respawns when the process is provably gone", () => {
    expect(decideResurrection(input({ processAlive: false }))).toEqual({ action: "respawn", attempt: 1 });
  });
});

describe("wall handling — the session/spend asymmetry", () => {
  it("holds a session wall until its stated reset instant", () => {
    const d = decideResurrection(
      input({ cause: "wall-session", notBeforeMs: NOW + 30 * MIN }),
    );
    expect(d).toEqual({ action: "none", reason: "wall-not-yet-reset" });
  });

  it("releases a session wall once the reset has passed", () => {
    const d = decideResurrection(input({ cause: "wall-session", notBeforeMs: NOW - 1 }));
    expect(d.action).toBe("respawn");
  });

  it("NEVER holds a spend cap on a clock — it is probed, so it goes straight to the ladder", () => {
    // The correction the founder asked for: a spend cap has no reset instant, so gating it on one
    // would park the fleet forever waiting for an event that never fires. It probes instead, and
    // comes back by itself the moment a probe succeeds.
    const d = decideResurrection(
      input({ cause: "wall-spend", notBeforeMs: NOW + 5 * 60 * MIN }),
    );
    expect(d).toEqual({ action: "respawn", attempt: 1 });
  });

  it("resurrects an app-restart death immediately, with no wall to wait on", () => {
    expect(decideResurrection(input({ cause: "app-restart" })).action).toBe("respawn");
  });
});

describe("the two caps", () => {
  it("waits between rungs", () => {
    const d = decideResurrection(
      input({ attemptsThisEpisode: 1, lastAttemptAt: NOW - 30_000, diedAt: NOW - 5 * MIN }),
    );
    expect(d).toEqual({ action: "none", reason: "waiting-for-next-rung" });
  });

  it("keeps going past the last rung, at the ceiling cadence", () => {
    const past = decideResurrection(
      input({ attemptsThisEpisode: RESURRECT_LADDER_MS.length, lastAttemptAt: NOW - 60 * MIN }),
    );
    expect(past.action).toBe("respawn");

    const tooSoon = decideResurrection(
      input({ attemptsThisEpisode: RESURRECT_LADDER_MS.length, lastAttemptAt: NOW - 60_000 }),
    );
    expect(tooSoon).toEqual({ action: "none", reason: "waiting-for-next-rung" });
  });

  it("stops at the rolling daily cap — the ONLY terminal bound", () => {
    // The backstop that does not depend on episode identity being computed correctly — the reason a
    // misidentified episode cannot become the measured 45-retry loop.
    // Spaced 30 minutes apart — the ceiling cadence — so every one of them is genuinely inside the
    // rolling 24h window rather than aging out at the edge.
    const recentAttemptsAt = Array.from(
      { length: MAX_RESURRECTS_PER_AGENT_PER_DAY },
      (_, i) => NOW - (i + 1) * 30 * MIN,
    );
    const d = decideResurrection(input({ recentAttemptsAt }));
    expect(d).toEqual({ action: "none", reason: "daily-cap-spent" });
  });

  it("counts only attempts inside the rolling 24h window", () => {
    const stale = NOW - 25 * 60 * MIN;
    const fresh = NOW - 60 * MIN;
    expect(attemptsInWindow([stale, stale, fresh], NOW)).toBe(1);
    // …so an agent whose attempts have aged out is eligible again.
    expect(decideResurrection(input({ recentAttemptsAt: [stale, stale, stale] })).action).toBe("respawn");
  });

  it("bounds the measured worst case well below the 45 retries that really happened", () => {
    const attempts: number[] = [];
    let allowed = 0;
    for (let i = 0; i < 45; i++) {
      const d = decideResurrection(
        input({ recentAttemptsAt: attempts, attemptsThisEpisode: 0, lastAttemptAt: undefined }),
      );
      if (d.action !== "respawn") break;
      allowed++;
      attempts.push(NOW);
    }
    expect(allowed).toBe(MAX_RESURRECTS_PER_AGENT_PER_DAY);
    expect(allowed).toBeLessThan(45);
  });
});

describe("every resurrectable cause can actually reach a respawn", () => {
  it.each(["transport-transient", "wall-session", "wall-spend", "app-restart"] as const)(
    "%s respawns once its gates are satisfied",
    (cause: DeathCause) => {
      // Guards against a gate that refuses everything — which would make most tests above pass for
      // the wrong reason.
      expect(decideResurrection(input({ cause, notBeforeMs: NOW - 1 })).action).toBe("respawn");
    },
  );
});
