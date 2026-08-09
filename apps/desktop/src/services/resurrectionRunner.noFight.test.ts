// THE THREE RECOVERY MECHANISMS MUST NOT FIGHT OVER ONE AGENT.
//
// Sparkle now has three things that can act on a red row, and each of them SPENDS something:
//
//   • `engine/apiRecovery`   — types a retry into a LIVING PTY.        errored + ALIVE
//   • `engine/resurrection`  — lets a DEAD agent's pane mount again.   errored + DEAD
//   • `engine/goalContinuation` — types a continue into a resting agent that has a goal.
//
// The first two are disjoint BY CONSTRUCTION, on the liveness axis: `decideRevive` refuses anything
// whose process is not explicitly alive, `decideResurrection` refuses anything whose process is not
// explicitly DEAD. That is a real invariant and not a coincidence of the current gate order, so it
// is asserted here — over the same input, in both directions, exhaustively over the three values
// `boolean | undefined` can take. If either module's polarity is ever flipped or relaxed, one of
// these fails.
//
// The third overlaps with resurrection in TIME rather than in state, and needs a positive
// suppression instead of a mirrored gate. See the second describe block.
import { beforeEach, describe, expect, it } from "vitest";

import { classifyApiFailure, decideRevive } from "../engine/apiRecovery";
import { RESURRECT_LADDER_MS, decideResurrection } from "../engine/resurrection";
import { PROBATION_MS } from "../engine/resurrectionCohort";
import {
  _resetGoalContinuationRunnerForTests,
  continuationSuppressedUntil,
  suppressContinuation,
} from "./goalContinuationRunner";
import {
  _resetResurrectionRunnerForTests,
  type DueAgent,
  sweepResurrections,
} from "./resurrectionRunner";
import { resetAdmittedAgents } from "./resurrectionAdmission";

const NOW = 1_754_534_400_000;
const FIRST_RUNG = RESURRECT_LADDER_MS[0]!;
const ENOTFOUND = "API Error: Unable to connect to API (ENOTFOUND)";

function dead(over: Partial<DueAgent> = {}): DueAgent {
  return {
    agentId: "a1",
    projectId: "proj-1",
    worktree: "/wt/a1",
    cause: "transport-transient",
    epoch: "epoch-that-died",
    diedAt: NOW,
    notBeforeMs: NOW,
    message: ENOTFOUND,
    attemptsAt: [],
    ...over,
  };
}

beforeEach(() => {
  _resetResurrectionRunnerForTests();
  _resetGoalContinuationRunnerForTests();
  resetAdmittedAgents();
});

describe("apiRecovery and resurrection are disjoint on the liveness axis", () => {
  /** ONE agent, red on the SAME retryable banner, offered to BOTH engines. The only thing that
   *  varies between the cases below is `processAlive` — which is the point. */
  function offerToBoth(processAlive: boolean | undefined) {
    const revive = decideRevive({
      status: "errored",
      failure: classifyApiFailure(ENOTFOUND),
      now: NOW + FIRST_RUNG,
      erroredSince: NOW,
      attempts: 0,
      lastPingAt: undefined,
      canAcceptInput: true,
      processAlive,
    });
    const resurrect = decideResurrection({
      cause: "transport-transient",
      processAlive,
      notBeforeMs: NOW,
      attemptsThisEpisode: 0,
      lastAttemptAt: undefined,
      diedAt: NOW,
      recentAttemptsAt: [],
      now: NOW + FIRST_RUNG,
    });
    return { revive, resurrect };
  }

  it("an ALIVE process is apiRecovery's, and resurrection refuses it", () => {
    const { revive, resurrect } = offerToBoth(true);
    expect(revive.action).toBe("ping");
    expect(resurrect).toEqual({ action: "none", reason: "already-live" });
  });

  it("a DEAD process is resurrection's, and apiRecovery refuses it", () => {
    const { revive, resurrect } = offerToBoth(false);
    expect(revive).toEqual({ action: "none", reason: "process-gone" });
    expect(resurrect).toEqual({ action: "respawn", attempt: 1 });
  });

  it("an UNKNOWN liveness is nobody's — both fail closed", () => {
    // The third value is not a rounding error. `engineRegistry` returns undefined for BOTH "healthy"
    // and "no pane in this window", so `undefined` genuinely means "this window cannot tell". Acting
    // on a maybe is what orphans a live child, and typing into a maybe spends the whole ladder
    // writing into nothing.
    const { revive, resurrect } = offerToBoth(undefined);
    expect(revive).toEqual({ action: "none", reason: "liveness-unknown" });
    expect(resurrect).toEqual({ action: "none", reason: "already-live" });
  });

  it("exactly ONE of the two ever acts, for every value liveness can take", () => {
    // The invariant stated as a property rather than three examples, so a future fourth state (or a
    // relaxed gate) cannot satisfy the cases above while breaking the rule.
    for (const alive of [true, false, undefined] as const) {
      const { revive, resurrect } = offerToBoth(alive);
      const acting = [revive.action !== "none", resurrect.action !== "none"].filter(Boolean).length;
      expect(acting, `both engines acted for processAlive=${String(alive)}`).toBeLessThanOrEqual(1);
    }
  });
});

describe("the goal sweep is held off a freshly respawned agent", () => {
  it("suppresses it for the full probation window on respawn", async () => {
    const now = NOW + FIRST_RUNG;
    await sweepResurrections({
      now,
      ownsProject: () => true,
      projectTornOut: () => false,
      due: () => Promise.resolve([dead()]),
      liveSessions: () => Promise.resolve([]),
      claim: () => Promise.resolve(true),
      release: () => Promise.resolve(),
      mount: () => "opened" as const,
      // NOT injected — the REAL `suppressContinuation`, so this asserts the two modules are actually
      // wired together rather than that the runner called a stub.
    });

    expect(continuationSuppressedUntil("a1")).toBe(now + PROBATION_MS);
  });

  it("does not suppress an agent it did not respawn", async () => {
    // The control. Without it, a runner that suppressed unconditionally — or a
    // `suppressContinuation` that ignored its argument — would satisfy the test above.
    await sweepResurrections({
      now: NOW, // before the first rung, so nothing is admitted
      ownsProject: () => true,
      projectTornOut: () => false,
      due: () => Promise.resolve([dead()]),
      liveSessions: () => Promise.resolve([]),
      claim: () => Promise.resolve(true),
      release: () => Promise.resolve(),
      mount: () => "opened" as const,
    });

    expect(continuationSuppressedUntil("a1")).toBeUndefined();
  });

  it("covers IDLE_SETTLE_MS, which is the whole point of the window", async () => {
    // The collision is not hypothetical and it is not about the window's length in the abstract: a
    // respawned pane sits idle while `claude --resume` boots, and the goal sweep acts at
    // IDLE_SETTLE_MS. If the suppression were shorter than that, it would lapse before the sweep
    // that it exists to stop.
    const { IDLE_SETTLE_MS } = await import("../engine/goalContinuation");
    expect(PROBATION_MS).toBeGreaterThan(IDLE_SETTLE_MS);
  });

  it("only ever pushes the deadline LATER", () => {
    // A respawn landing mid-probation must not be able to SHORTEN a hold that is already running —
    // which is what a plain `set` would do, silently, on the exact path where a canary is being
    // re-elected.
    suppressContinuation("a1", NOW + 10_000);
    suppressContinuation("a1", NOW + 1_000);
    expect(continuationSuppressedUntil("a1")).toBe(NOW + 10_000);

    suppressContinuation("a1", NOW + 20_000);
    expect(continuationSuppressedUntil("a1")).toBe(NOW + 20_000);
  });
});
