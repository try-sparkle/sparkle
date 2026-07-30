import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_GOAL_TTL_MS,
  escalateGoal,
  goalStateOf,
  markGoalMet,
  newGoal,
  noteContinue,
  resetGoalRetries,
} from "./agentGoal";
import {
  IDLE_SETTLE_MS,
  MAX_CONTINUES_TOTAL,
  MAX_CONTINUES_WITHOUT_PROGRESS,
  continuePrompt,
  decideContinuation,
  progressMark,
  type ContinuationInput,
} from "./goalContinuation";

const T0 = 1_700_000_000_000;

/** A live agent that has been idle long enough to qualify, with an unmet goal. Every test starts
 *  from a state that WOULD continue, and changes exactly one thing — so a test that expects "none"
 *  is proving that its one change caused the refusal, not that the fixture never qualified. */
function ready(over: Partial<ContinuationInput> = {}): ContinuationInput {
  return {
    goal: newGoal("Ship the auto-continue PR", T0),
    status: "idle",
    now: T0 + IDLE_SETTLE_MS + 1_000,
    idleSince: T0,
    hasTurnEndAuthority: true,
    canAcceptInput: true,
    mark: "m0",
    // `idle` needs no liveness proof, but the field is required-but-nullable so a caller cannot
    // forget to decide — see ContinuationInput.processAlive.
    processAlive: undefined,
    ...over,
  };
}

describe("the baseline actually continues", () => {
  // If this fixture ever stops qualifying, every "none" assertion below becomes vacuous — they
  // would pass against a fixture that could never have continued in the first place.
  it("restarts an idle agent whose goal is unmet", () => {
    const d = decideContinuation(ready());
    expect(d.action).toBe("continue");
    if (d.action !== "continue") throw new Error("unreachable");
    expect(d.attempt).toBe(1);
    // The prompt must carry the GOAL — a bare "continue" is what produces "continue what?" after a
    // context compaction or a relaunch.
    expect(d.prompt).toContain("Ship the auto-continue PR");
    // ...and an exit the agent can reach, or it gets resumed forever after genuinely finishing.
    expect(d.prompt).toContain("set_agent_goal");
  });
});

describe("gates — when restarting is not meaningful", () => {
  it("does nothing without a goal", () => {
    expect(decideContinuation(ready({ goal: undefined }))).toEqual({
      action: "none",
      reason: "no-goal",
    });
  });

  it("does nothing once the goal is met", () => {
    const goal = markGoalMet(newGoal("done thing", T0), T0 + 100);
    expect(decideContinuation(ready({ goal })).action).toBe("none");
    expect(decideContinuation(ready({ goal }))).toMatchObject({ reason: "goal-met" });
  });

  it("stops at the goal's TTL — a forgotten goal does not burn tokens forever", () => {
    const goal = newGoal("stale", T0);
    const justInside = decideContinuation(ready({ goal, now: T0 + DEFAULT_GOAL_TTL_MS - 1 }));
    const justOutside = decideContinuation(ready({ goal, now: T0 + DEFAULT_GOAL_TTL_MS }));
    expect(justInside.action).toBe("continue");
    expect(justOutside).toEqual({ action: "none", reason: "goal-expired" });
  });

  it("never re-continues an escalated goal", () => {
    const goal = escalateGoal(newGoal("hard", T0), T0 + 1, "gave up");
    expect(decideContinuation(ready({ goal }))).toEqual({
      action: "none",
      reason: "already-escalated",
    });
  });

  // The red tier is the agent genuinely stuck on the human. Typing "continue" there answers a
  // question the agent never read — the exact unsafe write send_to_agent_terminal refuses to make.
  it.each(["waiting", "approval", "blocked", "errored"] as const)(
    "refuses to type over a %s agent (it is stuck on the human, not stalled)",
    (status) => {
      expect(decideContinuation(ready({ status }))).toEqual({
        action: "none",
        reason: "not-idle",
      });
    },
  );

  it.each(["working", "done", "stopped", "new"] as const)("does not continue a %s agent", (status) => {
    expect(decideContinuation(ready({ status })).action).toBe("none");
  });

  it("DOES continue a LIVE `unmerged` agent — the most common gray row on a real fleet", () => {
    // `unmergedAttention` rewrites a resting row with committed-but-unlanded work to `unmerged`
    // (gray, "Needs merge"); 27 of 51 agents sat in that band on a real fleet. An agent there with
    // an unmet goal did the work and stopped before it landed -- the motivating case. Treating it
    // as not-idle meant it was never continued AND never escalated: silent forever (roborev 55252).
    expect(
      decideContinuation(ready({ status: "unmerged", processAlive: true })).action,
    ).toBe("continue");
  });

  it("tells 'the process is gone' apart from 'nobody looked'", () => {
    // Both refuse; only the sentence differs. `NoContinueReason` is what the concierge reads out to
    // a human, and reporting an unchecked agent as dead would have said "its process is gone" about
    // every live agent in the band — sending the human to close a tab whose agent is running
    // (roborev 55298). Same false-positive-from-silence that `stallReport`'s `unknown` arm avoids.
    expect(decideContinuation(ready({ status: "unmerged", processAlive: false })).action).toBe("none");
    expect(decideContinuation(ready({ status: "unmerged", processAlive: false }))).toMatchObject({
      reason: "process-gone",
    });
    expect(decideContinuation(ready({ status: "unmerged", processAlive: undefined }))).toMatchObject({
      reason: "liveness-unknown",
    });
  });

  it.each([undefined, false] as const)(
    "refuses the `unmerged` band when processAlive is %s — the overlay also covers done/stopped",
    (processAlive) => {
      // THE HOLE ACCEPTING THE BAND OPENED. `withUnmergedWork` relabels any row resting in idle,
      // done OR stopped, so `unmerged` cannot witness its own liveness the way `idle` does. Both
      // gates that look like they would catch a dead process wave it through: `canAcceptInput` is
      // true for ANY local agent, and an exited PTY is `turnEndAuthority`'s STRONGEST witness. So
      // continuing here typed `continuePrompt` into a dead terminal, burned a retry against a mark
      // that cannot move, and escalated three rounds later with a false reason. Fails CLOSED:
      // absent evidence refuses, because the cost of a wrong "yes" is real money.
      const d = decideContinuation(ready({ status: "unmerged", processAlive }));
      expect(d.action).toBe("none");
    },
  );

  it("an `idle` agent needs no liveness proof — the status IS the proof", () => {
    // `idle` is derived from a live PTY's own output stream, so it cannot be reported for a process
    // that does not exist. Demanding `processAlive` there would disable the feature on its main path.
    expect(decideContinuation(ready({ processAlive: undefined })).action).toBe("continue");
  });

  it("refuses on a GUESSED idle — quiet is not the same as finished", () => {
    // Without turn-end authority, `idle` means "no output for a while", which is equally consistent
    // with a six-minute test run. Continuing would type mid-tool-call.
    expect(decideContinuation(ready({ hasTurnEndAuthority: false }))).toEqual({
      action: "none",
      reason: "no-turn-end-authority",
    });
  });

  it("refuses when the agent cannot accept input", () => {
    expect(decideContinuation(ready({ canAcceptInput: false }))).toEqual({
      action: "none",
      reason: "cannot-accept-input",
    });
  });
});

describe("the spinner-flap guard", () => {
  // The commissioning log caught three idle->working->idle cycles in 30 seconds on a continuously
  // working agent. Status is derived from spinner visibility, so gaps between tool calls read as
  // idle. Auto-continuing on one of those would interrupt a live turn.
  it("ignores a two-second flap", () => {
    expect(decideContinuation(ready({ idleSince: T0, now: T0 + 2_000 }))).toEqual({
      action: "none",
      reason: "idle-not-settled",
    });
  });

  it("requires the full settle window before acting", () => {
    const at = (dt: number) => decideContinuation(ready({ idleSince: T0, now: T0 + dt })).action;
    expect(at(IDLE_SETTLE_MS - 1)).toBe("none");
    expect(at(IDLE_SETTLE_MS)).toBe("continue");
  });

  it("treats a missing idleSince as not settled", () => {
    expect(decideContinuation(ready({ idleSince: undefined })).action).toBe("none");
  });
});

describe("bounds — the loop cannot spin forever", () => {
  it("escalates after N consecutive continues with no progress", () => {
    // Walk the real loop: decide and record at the SAME mark each round, which is the runner's
    // contract (it computes the mark once per sweep and uses it for both). Deciding at one mark
    // and recording at another would read as progress every round and never escalate.
    let goal = newGoal("impossible", T0);
    const actions: string[] = [];
    for (let i = 0; i < MAX_CONTINUES_WITHOUT_PROGRESS + 1; i++) {
      const d = decideContinuation(ready({ goal, mark: "stuck" }));
      actions.push(d.action);
      if (d.action === "continue") goal = noteContinue(goal, "stuck");
    }
    expect(actions).toEqual([
      ...Array(MAX_CONTINUES_WITHOUT_PROGRESS).fill("continue"),
      "escalate",
    ]);
  });

  it("the escalation names the goal, so the human knows what they now own", () => {
    let goal = newGoal("Land PR #900", T0);
    for (let i = 0; i < MAX_CONTINUES_WITHOUT_PROGRESS; i++) goal = noteContinue(goal, "stuck");
    const d = decideContinuation(ready({ goal, mark: "stuck" }));
    expect(d.action).toBe("escalate");
    if (d.action !== "escalate") throw new Error("unreachable");
    expect(d.reason).toContain("Land PR #900");
  });

  it("keeps restarting an agent that IS making progress", () => {
    // Same number of attempts as the escalating case above, but the mark moves each round. The
    // difference in outcome is what proves the counter is progress-sensitive rather than a plain
    // attempt tally.
    let goal = newGoal("long but healthy", T0);
    for (let i = 0; i < MAX_CONTINUES_WITHOUT_PROGRESS + 2; i++) {
      const d = decideContinuation(ready({ goal, mark: `m${i}` }));
      expect(d.action).toBe("continue");
      if (d.action !== "continue") throw new Error("unreachable");
      // `attempt` tracks the counter the BOUND reads, so a progressed round always reports 1.
      // It used to be derived from the un-reset counter and went 3, then 2, for consecutive
      // restarts of a healthy agent (roborev 55252).
      expect(d.attempt).toBe(1);
      goal = noteContinue(goal, `m${i}`);
    }
  });

  it("attempt climbs with the streak while there is no progress", () => {
    let goal = newGoal("stuck", T0);
    const attempts: number[] = [];
    for (let i = 0; i < MAX_CONTINUES_WITHOUT_PROGRESS; i++) {
      const d = decideContinuation(ready({ goal, mark: "stuck" }));
      if (d.action !== "continue") throw new Error("expected continue");
      attempts.push(d.attempt);
      goal = noteContinue(goal, "stuck");
    }
    expect(attempts).toEqual([1, 2, 3]);
  });

  it("still stops at the per-goal ceiling even while progress keeps resetting the streak", () => {
    // The backstop. A progress mark that flaps would reset `continues` forever; `totalContinues`
    // is the bound that no agent-side behaviour can clear.
    let goal = newGoal("flapping", T0);
    for (let i = 0; i < MAX_CONTINUES_TOTAL; i++) goal = noteContinue(goal, `m${i}`);
    expect(goal.continues).toBeLessThan(MAX_CONTINUES_WITHOUT_PROGRESS);
    expect(decideContinuation(ready({ goal, mark: "brand-new" })).action).toBe("escalate");
  });

  it("THE REQUIREMENT: an unmet goal never sits idle indefinitely", () => {
    // Drive the loop to exhaustion under the worst case — an agent that never progresses. Whatever
    // happens, the agent must never be left in the state the PRD is about: idle, goal unmet, and
    // nothing scheduled to change that. Every round is either a restart or an escalation to the
    // human; "none" would be the silent stall.
    let goal = newGoal("never finishes", T0);
    let escalated = false;
    for (let round = 0; round < MAX_CONTINUES_TOTAL * 3; round++) {
      const d = decideContinuation(ready({ goal, mark: "stuck", now: T0 + IDLE_SETTLE_MS + round }));
      if (d.action === "continue") {
        goal = noteContinue(goal, "stuck");
        continue;
      }
      expect(d.action).toBe("escalate");
      if (d.action === "escalate") goal = escalateGoal(goal, T0 + round, d.reason);
      escalated = true;
      break;
    }
    // It ended by handing the work to a human — not by quietly giving up, and not by looping.
    expect(escalated).toBe(true);
    expect(goalStateOf(goal, T0 + 1)).toBe("escalated");
    expect(goal.escalationReason).toContain("never finishes");
    // And the total spend was bounded by the ceiling, not by the test's patience.
    expect(goal.totalContinues).toBeLessThanOrEqual(MAX_CONTINUES_TOTAL);
  });
});

describe("progress accounting", () => {
  it("resets the streak when the mark moves, and keeps the running total", () => {
    let goal = newGoal("g", T0);
    goal = noteContinue(goal, "a");
    goal = noteContinue(goal, "a");
    expect(goal.continues).toBe(2);
    goal = noteContinue(goal, "b"); // progress
    expect(goal.continues).toBe(1);
    expect(goal.totalContinues).toBe(3);
  });

  it("a human typing to the agent clears the retry budget and any escalation", () => {
    let goal = newGoal("g", T0);
    for (let i = 0; i < MAX_CONTINUES_WITHOUT_PROGRESS; i++) goal = noteContinue(goal, "stuck");
    goal = escalateGoal(goal, T0 + 1, "gave up");
    expect(decideContinuation(ready({ goal })).action).toBe("none");

    const revived = resetGoalRetries(goal);
    expect(goalStateOf(revived, T0 + 2)).toBe("unmet");
    expect(decideContinuation(ready({ goal: revived })).action).toBe("continue");
  });

  it("progressMark moves when any of its inputs move", () => {
    const base = { promptHistoryLength: 1, activity: "wiring", aiTitle: "PR work" };
    const m = progressMark(base);
    expect(progressMark({ ...base, promptHistoryLength: 2 })).not.toBe(m);
    expect(progressMark({ ...base, activity: "testing" })).not.toBe(m);
    expect(progressMark({ ...base, aiTitle: "other" })).not.toBe(m);
    expect(progressMark({ ...base })).toBe(m);
  });

  it("treats an absent field and an empty one as the SAME mark", () => {
    // Named for what it asserts. It used to be called "distinguishes absent from empty", which is
    // the opposite of the `activity ?? ""` the implementation actually does — a maintainer reading
    // the suite would have believed a property the code does not have (roborev 55252).
    expect(progressMark({ promptHistoryLength: 1 })).toBe(
      progressMark({ promptHistoryLength: 1, activity: "", aiTitle: null }),
    );
  });

  it("CLEARING a field that had a value does read as a change", () => {
    // The claim the mis-named test never exercised: going from "x" to "" moves the mark, so an
    // agent that drops its activity narration is not mistaken for one that never had one.
    expect(progressMark({ promptHistoryLength: 1, activity: "x" })).not.toBe(
      progressMark({ promptHistoryLength: 1, activity: "" }),
    );
  });
});

describe("goal state machine", () => {
  it("a met goal stays met past its TTL", () => {
    // Otherwise an agent that succeeded would be reported as expired/stalled four hours later.
    const goal = markGoalMet(newGoal("g", T0), T0 + 10);
    expect(goalStateOf(goal, T0 + DEFAULT_GOAL_TTL_MS * 10)).toBe("met");
  });

  it("marking met twice keeps the first timestamp", () => {
    const once = markGoalMet(newGoal("g", T0), T0 + 10);
    expect(markGoalMet(once, T0 + 999).metAt).toBe(T0 + 10);
  });

  it("escalating twice keeps the first reason", () => {
    const once = escalateGoal(newGoal("g", T0), T0 + 1, "first");
    expect(escalateGoal(once, T0 + 2, "second").escalationReason).toBe("first");
  });
});

// ---------------------------------------------------------------------------------------------
// `continuePrompt` names a control op, and that op has to EXIST.
//
// This is the only instruction an agent ever receives about how to get out of auto-continue, so an
// op name in it is not documentation — it is the exit. It named `set_agent_goal with met: true`,
// which cannot work: `set_agent_goal` requires a `goal` and has no `met`, so an agent that obeyed
// either failed validation or clobbered its own goal record with a fresh, never-met one. It could
// not stop being resumed, and burned continues until the bound escalated to a human with a false
// "still unmet" — precisely what the prompt exists to prevent.
//
// The allowlist is in RUST (`bridge.rs`) and the prompt is in TypeScript, with no shared type
// between them, so nothing but reading the source keeps the two in step. Same technique as
// `agentGoalShape.test.ts` and the CONTROL_KEYS pins: parse, don't import.
// ---------------------------------------------------------------------------------------------

describe("continuePrompt names an op the control surface actually has", () => {
  /** The string literals of `const CONTROL_OPS: &[&str] = &[ … ];` in the Rust bridge. */
  function controlOps(): string[] {
    const source = readFileSync(
      fileURLToPath(new URL("../../src-tauri/src/bridge.rs", import.meta.url)),
      "utf8",
    );
    const start = source.indexOf("const CONTROL_OPS: &[&str] = &[");
    if (start < 0) throw new Error("could not find CONTROL_OPS in bridge.rs — was it renamed?");
    const end = source.indexOf("];", start);
    if (end < 0) throw new Error("unterminated CONTROL_OPS literal");
    const ops = [...source.slice(start, end).matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
    // A parse that silently found nothing would make every assertion below vacuous.
    if (ops.length < 5) throw new Error(`CONTROL_OPS parse found only ${ops.length} ops`);
    return ops;
  }

  it("points at set_agent_goal_met — the op that can actually mark a goal met", () => {
    const prompt = continuePrompt(newGoal("land the guardrails", T0));
    expect(prompt).toContain("set_agent_goal_met");
    // `set_agent_goal` is a PREFIX of `set_agent_goal_met`, so a bare `toContain` would pass on the
    // broken text too. Pin the wrong pairing itself: the op followed by a `met:` argument it has no
    // field for.
    expect(prompt).not.toMatch(/set_agent_goal\b(?!_met)[^.]*met:/);
  });

  it("every op it names is in the Rust allowlist", () => {
    const ops = controlOps();
    const named = [...continuePrompt(newGoal("g", T0)).matchAll(/sparkle-control:\s*([a-z_]+)/g)].map(
      (m) => m[1]!,
    );
    expect(named.length).toBeGreaterThan(0);
    for (const op of named) expect(ops, `${op} is not in CONTROL_OPS`).toContain(op);
  });
});
