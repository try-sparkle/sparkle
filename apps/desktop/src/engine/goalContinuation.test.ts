import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_GOAL_TTL_MS,
  dischargeGoal,
  escalateGoal,
  goalStateOf,
  markGoalMet,
  newGoal,
  noteContinue,
  rearmGoal,
  resetGoalRetries,
} from "./agentGoal";
import { REARM_TTL_MS } from "./goalExpiry";
import { isSystemAuthoredPrompt } from "./agentOriginated";
import {
  CLOUD_MIN_CONTINUE_CENTS,
  IDLE_SETTLE_MS,
  MAX_CONTINUES_TOTAL,
  MAX_CONTINUES_WITHOUT_PROGRESS,
  continuePrompt,
  decideContinuation,
  progressMark,
  type CloudEvidence,
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
    // The baseline is a LOCAL agent, so it carries no cloud evidence. `readyCloud` below is the
    // cloud counterpart, and it is a separate fixture on purpose: a cloud agent must clear every
    // gate this one clears AND its own, so sharing a fixture would hide a gate that stopped running.
    runtime: "local",
    cloud: undefined,
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
    // ...and an exit the agent can ACTUALLY reach, or it gets resumed forever after genuinely
    // finishing. THE DISTINGUISHING TOKEN, not the shared prefix: this asserted
    // `toContain("set_agent_goal")`, which `set_agent_goal_met` also satisfies — so it was true for
    // the correct copy AND for the broken one, and that is precisely how the op split landed with
    // this prompt naming a call shape the MCP schema rejects, suite green (roborev 55549).
    expect(d.prompt).toContain("set_agent_goal_met");
    // And NOT the old single-op form, which no longer exists: `set_agent_goal with met: true` would
    // be refused with "goal must be a string" if an agent followed it literally.
    expect(d.prompt).not.toContain("set_agent_goal with");
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

  // -------------------------------------------------------------------------------------------
  // A REPEATED RESUME HAS TO BE READABLE AS A REPEAT.
  //
  // The bug: every resume for one goal was byte-identical, so an agent reading its transcript saw
  // one message three times with nothing to tell the copies apart — which is what a human repeating
  // themselves looks like, and the reply to that is a status report, not more work. Three of those
  // were measured against a goal whose work was finished and ready to land.
  //
  // These drive the REAL loop and assert on `d.prompt` — the text the agent actually receives —
  // rather than calling `continuePrompt` with a hand-picked number, because the defect was in the
  // WIRING (the attempt existed and was not passed), and a test that supplies the argument itself
  // would have passed against the broken code.
  // -------------------------------------------------------------------------------------------

  it("gives a resumed agent a prompt that DIFFERS from the one before it", () => {
    let goal = newGoal("stuck", T0);
    const prompts: string[] = [];
    for (let i = 0; i < MAX_CONTINUES_WITHOUT_PROGRESS; i++) {
      const d = decideContinuation(ready({ goal, mark: "stuck" }));
      if (d.action !== "continue") throw new Error("expected continue");
      prompts.push(d.prompt);
      goal = noteContinue(goal, "stuck");
    }
    // The whole point: no two resumes in one streak are the same text.
    expect(new Set(prompts).size).toBe(prompts.length);
    // And the FIRST carries no repeat banner — there is nothing yet to be confused with, so the
    // line must not be unconditional (which would make every resume identical all over again).
    expect(prompts[0]).not.toMatch(/AUTO-RESUME/);
    expect(prompts[1]).toContain(`AUTO-RESUME 2 OF ${MAX_CONTINUES_WITHOUT_PROGRESS}`);
  });

  it("a repeat banner names the ceiling it derives from, not a literal that can go stale", () => {
    // Pinned as the constant ±0 rather than "3": retuning the bound must not leave the prose
    // promising the old one. A literal here would keep passing while the copy lied.
    const prompt = continuePrompt(newGoal("g", T0), 2);
    expect(prompt).toContain(`OF ${MAX_CONTINUES_WITHOUT_PROGRESS}`);
    expect(prompt).not.toContain(`OF ${MAX_CONTINUES_WITHOUT_PROGRESS + 1}`);
    // It must tell the agent the thing it cannot otherwise know: an identical banner is the timer,
    // not the human. Without this the count alone reads as noise.
    expect(prompt).toMatch(/not the human repeating themselves/i);
  });

  it("a progressed agent is never told it is repeating itself", () => {
    // The false-accusation guard. `attempt` resets to 1 when the mark moves, so an agent that is
    // working must never see the repeat banner however many times it has been resumed.
    let goal = newGoal("long but healthy", T0);
    for (let i = 0; i < MAX_CONTINUES_WITHOUT_PROGRESS + 2; i++) {
      const d = decideContinuation(ready({ goal, mark: `m${i}` }));
      if (d.action !== "continue") throw new Error("expected continue");
      expect(d.prompt).not.toMatch(/AUTO-RESUME/);
      goal = noteContinue(goal, `m${i}`);
    }
  });

  it("stays system-authored at every attempt, so the loop detector does not go blind", () => {
    // Varying the tail is only safe because `isSystemAuthoredPrompt` matches the PREFIX. If a
    // future edit moved the banner above the marker, `agentThrash` would start counting Sparkle's
    // own sends as an agent repeating a command — the exact false "it is looping, not working"
    // badge that exclusion exists to prevent.
    for (let attempt = 1; attempt <= MAX_CONTINUES_WITHOUT_PROGRESS; attempt++) {
      expect(isSystemAuthoredPrompt(continuePrompt(newGoal("g", T0), attempt))).toBe(true);
    }
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

// ── CLOUD AGENTS ────────────────────────────────────────────────────────────────────────────────
//
// A cloud agent used to be refused categorically, one gate up: the runner fed this function
// `agentCanAcceptInput`, which is the LOCAL-PTY question and is false for every cloud agent by
// design, so the whole feature was dead for cloud — never nudged, and (the bounds sit AFTER the
// gates) never escalated either. These tests pin the two halves of the fix: a healthy cloud session
// is continued exactly like a local agent, and every way a sandbox can be un-resumable is refused
// BY NAME rather than by falling through some other arm.
describe("cloud agents", () => {
  /** A cloud agent in the same qualifying state as `ready()`: live sandbox, funded, relay up. */
  function readyCloud(over: Partial<ContinuationInput> = {}): ContinuationInput {
    return ready({
      runtime: "cloud",
      cloud: {
        sessionStatus: "active",
        balanceCents: 5_000,
        minContinueCents: undefined, // no server floor stated — the fail-open fallback applies
        relayConnected: true,
      },
      ...over,
    });
  }

  it("continues a resting cloud agent whose sandbox is active — the whole point", () => {
    const d = decideContinuation(readyCloud());
    expect(d.action).toBe("continue");
    if (d.action !== "continue") throw new Error("unreachable");
    expect(d.prompt).toContain("Ship the auto-continue PR");
  });

  it("REFUSES a hibernated sandbox by name — waking it is the user's billing decision", () => {
    expect(decideContinuation(readyCloud({ cloud: cloudWith({ sessionStatus: "paused" }) }))).toEqual({
      action: "none",
      reason: "cloud-session-paused",
    });
  });

  it("REFUSES a parked session by name — exhaustion, or it is asking its human", () => {
    expect(decideContinuation(readyCloud({ cloud: cloudWith({ sessionStatus: "waiting" }) }))).toEqual(
      { action: "none", reason: "cloud-session-waiting" },
    );
  });

  it("refuses a sandbox that has not come up yet, and one that has finished", () => {
    expect(
      decideContinuation(readyCloud({ cloud: cloudWith({ sessionStatus: "pending" }) })),
    ).toEqual({ action: "none", reason: "cloud-session-starting" });
    for (const status of ["complete", "error", "something-a-future-server-invents"]) {
      // An UNRECOGNISED lifecycle lands with the terminal ones rather than falling through to a
      // send: a status this build has never heard of is not evidence of a healthy sandbox.
      expect(decideContinuation(readyCloud({ cloud: cloudWith({ sessionStatus: status }) }))).toEqual(
        { action: "none", reason: "cloud-session-ended" },
      );
    }
  });

  it("refuses when there is no CURRENT reading of the lifecycle — absence is not `active`", () => {
    // Both shapes of ignorance, and they must agree: a window that never listed the project's
    // sessions, and one whose reading has aged out (`cloudSessionStatusOf` expires its own).
    expect(
      decideContinuation(readyCloud({ cloud: cloudWith({ sessionStatus: undefined }) })),
    ).toEqual({ action: "none", reason: "cloud-session-unknown" });
    // …and a cloud agent that arrives with NO bundle at all is refused, never waved through.
    expect(decideContinuation(readyCloud({ cloud: undefined }))).toEqual({
      action: "none",
      reason: "cloud-session-unknown",
    });
  });

  it("refuses a wallet the server would 402 — and re-explains the park it caused", () => {
    // A live sandbox we cannot afford to keep running: the wallet IS the whole story.
    const brokeActive = cloudWith({ balanceCents: CLOUD_MIN_CONTINUE_CENTS - 1 });
    expect(decideContinuation(readyCloud({ cloud: brokeActive }))).toEqual({
      action: "none",
      reason: "cloud-out-of-credits",
    });
    // And a session the server PARKED reports the cause rather than the symptom: `waiting` is either
    // exhaustion or the agent asking its human, and the balance identifies which.
    const brokeWaiting = cloudWith({
      balanceCents: CLOUD_MIN_CONTINUE_CENTS - 1,
      sessionStatus: "waiting",
    });
    expect(decideContinuation(readyCloud({ cloud: brokeWaiting }))).toMatchObject({
      reason: "cloud-out-of-credits",
    });
    // Exactly at the floor is affordable — the boundary, so a `<=` slip here fails.
    expect(
      decideContinuation(readyCloud({ cloud: cloudWith({ balanceCents: CLOUD_MIN_CONTINUE_CENTS }) }))
        .action,
    ).toBe("continue");
  });

  // THE FALLBACK, IN LITERAL CENTS. Stated as numbers on purpose: every other boundary in this file
  // is phrased as `CLOUD_MIN_CONTINUE_CENTS ± 1`, so those tests follow the constant wherever it
  // moves. An older `/me` states no resume floor, and the only defensible local bar for one of those
  // is "the wallet is empty" — 1¢, not whatever the spawn bar happens to be this quarter.
  it("falls back to ONE CENT — an empty wallet — when the server stated no resume floor", () => {
    expect(CLOUD_MIN_CONTINUE_CENTS).toBe(1); // the value, not a band around it
    expect(
      decideContinuation(readyCloud({ cloud: cloudWith({ balanceCents: 0 }) })),
    ).toEqual({ action: "none", reason: "cloud-out-of-credits" });
    expect(
      decideContinuation(readyCloud({ cloud: cloudWith({ balanceCents: 1 }) })).action,
    ).toBe("continue");
    // 99¢ is ~110 affordable minutes and is below the SERVER's $1 spawn floor. It continues — the
    // spawn bar has no business here.
    expect(
      decideContinuation(readyCloud({ cloud: cloudWith({ balanceCents: 99 }) })).action,
    ).toBe("continue");
  });

  // …AND THE DE-ALIASING ITSELF, which no value assertion above can reach. `CLOUD_MIN_START_CENTS`
  // is 1¢ TODAY (it is the client's "obviously empty" check — the $1 rule lives only in the server's
  // `me.cloudAgentPricing.minStartCents`), so restoring `= CLOUD_MIN_START_CENTS` changes no number
  // and every assertion in this file stays green. The regression is therefore invisible to behaviour
  // and has to be pinned at the SOURCE: the risk is that the client constant moves again — it was
  // 50¢ before — and silently drags the resume bar with it. Same readFileSync idiom as the
  // CONTROL_OPS check below.
  it("does not import the START floor — the resume bar cannot be dragged by it again", () => {
    const source = readFileSync(new URL("./goalContinuation.ts", import.meta.url), "utf8");
    // WHOLE STATEMENTS, not lines. The first version of this guard filtered lines matching
    // /^\s*import\b/ or /^\s*}\s*from/ — which drops the MIDDLE of a multi-line import, exactly
    // where a re-added symbol would sit:
    //
    //   import {                    ← kept
    //     CLOUD_MIN_START_CENTS,    ← matched NEITHER pattern, silently dropped
    //   } from "../services/cloudAgents/gating";   ← kept
    //
    // so the guard passed while the import it exists to forbid was present. It was verified against
    // a single-line import only, which is the shape the filter happens to catch. Match the statement
    // across newlines instead.
    const extractImports = (src: string) =>
      src.match(/^\s*import\b[\s\S]*?from\s+["'][^"']+["'];/gm) ?? [];

    // POSITIVE CONTROL — and it has to be a MULTI-LINE fixture, because that is the whole defect.
    // `goalContinuation.ts` today contains four single-line imports and no multi-line ones, so
    // "the extractor found ./agentGoal" is satisfied by the OLD line-filter just as well as by this
    // regex: it proves the extractor found something, not that it can see the middle of a wrapped
    // `import { … }` block. Revert this to a line filter, or drop the `[\s\S]` that spans newlines,
    // and every other assertion here still passes while the guard goes back to being vacuous.
    //
    // Same helper for the fixture and for the real check, deliberately: asserting a hand-copied
    // regex against the fixture would test a DUPLICATE of the mechanism and leave the real one
    // unpinned — the failure mode this whole test exists to avoid, relocated one level up.
    expect(
      extractImports(
        'import {\n  CLOUD_MIN_START_CENTS,\n} from "../services/cloudAgents/gating";',
      ).join("\n"),
    ).toContain("CLOUD_MIN_START_CENTS");

    const statements = extractImports(source);
    const imports = statements.join("\n");

    // …and that it found THIS file's real imports, so a renamed file or a changed import style
    // cannot make the negative assertion below vacuously true.
    expect(imports).toContain("./agentGoal");
    expect(imports).toContain("./quotaBlock");
    expect(statements.length).toBeGreaterThanOrEqual(4);

    // THE GUARD ITSELF.
    expect(imports).not.toContain("CLOUD_MIN_START_CENTS");
    // And the definition is a literal, not a reference to anything.
    expect(source).toMatch(/export const CLOUD_MIN_CONTINUE_CENTS = \d+;/);
  });

  // THE SERVER'S RESUME FLOOR, WHICH IS NOT ITS START FLOOR. `/me` publishes both and they differ by
  // 20× ($1 to spawn, 5¢ to resume). This arm decides a resume, so it reads `minContinueCents`; the
  // wiring that feeds it — and the money bug of feeding it `minStartCents` instead — is pinned at the
  // producer in goalContinuationRunner.cloud.test.ts. 5¢ clears the 1¢ fallback, so only a stated
  // floor can refuse these.
  it("refuses on the SERVER's resume floor when it stated one, not just the 1¢ fallback", () => {
    expect(
      decideContinuation(
        readyCloud({ cloud: cloudWith({ balanceCents: 4, minContinueCents: 5 }) }),
      ),
    ).toEqual({ action: "none", reason: "cloud-out-of-credits" });
    // Exactly at the server's floor is affordable — the boundary, so a `<=` slip fails here too.
    expect(
      decideContinuation(
        readyCloud({ cloud: cloudWith({ balanceCents: 5, minContinueCents: 5 }) }),
      ).action,
    ).toBe("continue");
    // …and no floor stated means no floor invented: 50¢ continues on the fail-open fallback rather
    // than being measured against a number this build never received.
    expect(decideContinuation(readyCloud({ cloud: cloudWith({ balanceCents: 50 }) })).action).toBe(
      "continue",
    );
  });

  it("does NOT blame the wallet for a lifecycle an empty wallet cannot explain", () => {
    // THE REMEDY-STRING BUG (roborev 58287). Run ahead of the lifecycle switch, the balance check
    // told a user to buy credits for a session that had FINISHED, or — the common case, since a lost
    // network takes the reading and the socket down together — for one this window has no reading of
    // at all. Buying credits fixes neither, and this reason string is what a human is read out.
    const broke = { balanceCents: CLOUD_MIN_CONTINUE_CENTS - 1 };
    expect(
      decideContinuation(readyCloud({ cloud: cloudWith({ ...broke, sessionStatus: "complete" }) })),
    ).toEqual({ action: "none", reason: "cloud-session-ended" });
    expect(
      decideContinuation(readyCloud({ cloud: cloudWith({ ...broke, sessionStatus: undefined }) })),
    ).toEqual({ action: "none", reason: "cloud-session-unknown" });
    expect(
      decideContinuation(readyCloud({ cloud: cloudWith({ ...broke, sessionStatus: "paused" }) })),
    ).toEqual({ action: "none", reason: "cloud-session-paused" });
    expect(
      decideContinuation(readyCloud({ cloud: cloudWith({ ...broke, sessionStatus: "pending" }) })),
    ).toEqual({ action: "none", reason: "cloud-session-starting" });
  });

  it("does NOT refuse on an unloaded balance — that would fire on every cold start", () => {
    // `undefined` here is "the /me round trip has not landed", not "empty". It needs no refusal of
    // its own because `sessionStatus` already refuses everything this window has not observed.
    expect(
      decideContinuation(readyCloud({ cloud: cloudWith({ balanceCents: undefined }) })).action,
    ).toBe("continue");
  });

  it("refuses when the relay is down — a write on a null socket is silently dropped", () => {
    expect(
      decideContinuation(readyCloud({ cloud: cloudWith({ relayConnected: false }) })),
    ).toEqual({ action: "none", reason: "cloud-offline" });
  });

  it("is not made EASIER than a local agent — every local gate still applies", () => {
    // The direction that matters. A cloud agent clears the cloud gates AND all of the ordinary
    // ones; a fix that let a healthy sandbox skip the settle window, the turn-end witness or the
    // liveness proof would be strictly more willing to spend money on cloud than on local.
    expect(decideContinuation(readyCloud({ hasTurnEndAuthority: false })).action).toBe("none");
    expect(decideContinuation(readyCloud({ idleSince: undefined })).action).toBe("none");
    expect(decideContinuation(readyCloud({ status: "waiting" })).action).toBe("none");
    expect(
      decideContinuation(readyCloud({ status: "unmerged", processAlive: false })),
    ).toEqual({ action: "none", reason: "process-gone" });
  });

  it("tells the human WHERE it is when it escalates", () => {
    // The local wording sends someone looking for a pane on this Mac. A cloud sandbox has none, and
    // it is still billing while they look — so the escalation body has to say so.
    const stuck = noteContinue(
      noteContinue(noteContinue(newGoal("land the PR", T0), "m0"), "m0"),
      "m0",
    );
    const d = decideContinuation(readyCloud({ goal: stuck, mark: "m0" }));
    expect(d.action).toBe("escalate");
    if (d.action !== "escalate") throw new Error("unreachable");
    expect(d.reason).toContain("CLOUD sandbox");
    expect(d.reason).toContain("nothing on this Mac will restart it");
    // …and a LOCAL agent's escalation is unchanged — no cloud sentence leaks into it.
    const local = decideContinuation(ready({ goal: stuck, mark: "m0" }));
    if (local.action !== "escalate") throw new Error("unreachable");
    expect(local.reason).not.toContain("CLOUD");
  });

  it("never applies the cloud gates to a LOCAL agent", () => {
    // Gated on `runtime`, not on "did a bundle arrive". A local agent is judged by the local rules
    // even if a caller hands it cloud evidence, and — the case that actually happens — a local
    // sweep that reads no relay socket and no session list is unaffected by both being absent.
    expect(decideContinuation(ready({ cloud: cloudWith({ sessionStatus: "paused" }) })).action).toBe(
      "continue",
    );
    expect(decideContinuation(ready({ cloud: undefined })).action).toBe("continue");
  });
});

/** A healthy cloud bundle with one or more facts overridden. Spelled out rather than spread from a
 *  shared object so a test that overrides `sessionStatus` cannot silently also change the balance. */
function cloudWith(over: Partial<CloudEvidence>): CloudEvidence {
  return {
    sessionStatus: "active",
    balanceCents: 5_000,
    minContinueCents: undefined, // stated, not omitted — the field is required-but-nullable
    relayConnected: true,
    ...over,
  };
}

describe("the expiry outcomes reach this gate correctly", () => {
  // These two states did not exist when the gate chain above was written, and BOTH of them arrive
  // here through `goalStateOf` rather than through any call this module makes. The chain is a
  // sequence of early returns over a union, so a new member is not a compile error — it simply falls
  // through every goal gate to the STATUS gates below them, where a resting agent qualifies. That is
  // the whole reason these tests exist: the failure is silent and it restarts finished agents.
  it("does NOT continue a goal Sparkle discharged on git's proof", () => {
    const goal = dischargeGoal(newGoal("Land the retry PR", T0), T0 + 1, "a1b2c3d", "d4e5f6a");
    const d = decideContinuation(ready({ goal }));
    expect(d.action).toBe("none");
    if (d.action !== "none") throw new Error("unreachable");
    // The REASON, not just the refusal: `goal-met` would also be a refusal, and the concierge reads
    // this field out to a human. "It said it was done" and "git showed it was done" are different
    // sentences and only one of them is checkable.
    expect(d.reason).toBe("goal-discharged");
  });

  it("DOES continue that same agent once the discharge is taken back", () => {
    // The control. Without it, the refusal above is ambiguous between "the discharge gate stopped
    // it" and "this fixture was never continuable" — and every other assertion in this file rests on
    // `ready()` qualifying.
    expect(decideContinuation(ready()).action).toBe("continue");
  });

  it("resumes a RE-ARMED goal through the ordinary path, spending an ordinary retry", () => {
    // Re-arm deliberately does not send. It returns the goal to `unmet` and leaves the resume to
    // this gate, so the restart is bound by the same budget every other restart is. If a bespoke
    // sender were ever added beside it, this test would still pass while the fleet quietly got three
    // free resumes per goal — so it asserts the ATTEMPT NUMBER, which is what the budget moves.
    //
    // ⚠️ THE GOAL MUST ARRIVE WITH RETRIES ALREADY SPENT, and that is the whole assertion. A virgin
    // goal has `continues: 0`, so `attempt === 1` holds whether or not the re-arm preserved the
    // budget — mutate `rearmGoal` to also zero `continues`/`totalContinues` (exactly the
    // "consequence someone will try to fix" its own docstring warns about) and the vacuous version
    // of this test stayed green. Spending two retries first makes the re-armed resume land on
    // attempt THREE, which is false the moment a re-arm launders the budget.
    let lapsed = newGoal("Land the retry PR", T0);
    lapsed = noteContinue(noteContinue(lapsed, "m0"), "m0");
    const now = T0 + DEFAULT_GOAL_TTL_MS;
    expect(goalStateOf(lapsed, now)).toBe("expired");

    const armed = rearmGoal(lapsed, now, REARM_TTL_MS);
    const d = decideContinuation(ready({ goal: armed, now, idleSince: now - IDLE_SETTLE_MS - 1 }));
    expect(d.action).toBe("continue");
    if (d.action !== "continue") throw new Error("unreachable");
    expect(d.attempt).toBe(3);
    expect(d.prompt).toContain("Land the retry PR");
  });

  it("and a re-armed goal at the total ceiling escalates on the very next sweep", () => {
    // The documented consequence of NOT refilling the budget, which had no test at all: re-arm
    // restores the mandate, not the retries, so a goal that had already spent its total budget is
    // handed to a human immediately rather than getting three more rounds on the clock. Without this
    // the "does NOT refill the retry budget" rule is only asserted one caller away from where it
    // actually decides anything.
    let goal = newGoal("Land the retry PR", T0);
    for (let i = 0; i < MAX_CONTINUES_TOTAL; i++) goal = noteContinue(goal, `m${i}`);
    const now = T0 + DEFAULT_GOAL_TTL_MS;
    const armed = rearmGoal(goal, now, REARM_TTL_MS);
    expect(goalStateOf(armed, now)).toBe("unmet");

    const d = decideContinuation(
      ready({ goal: armed, now, mark: "m0", idleSince: now - IDLE_SETTLE_MS - 1 }),
    );
    expect(d.action).toBe("escalate");
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// WHAT THE PREDICATE MEASURES (founder report, 2026-08-18)
//
// The escalation count went 4 → 8 in one hour while the fleet worked normally, and nearly every one
// was false: six agents paged as "no sign of progress" while holding OPEN pull requests against a
// CI queue of 16 runs on 6 runners. Two independent defects produced that, and each half is pinned
// below with its PAIR — the case that must still escalate — because a suppression test on its own
// passes just as well against a predicate that never fires at all.
// ════════════════════════════════════════════════════════════════════════════════════════════════

/** A goal that has burned the whole consecutive streak against an unmoved mark — the exact state
 *  that escalates today. Every test in this section starts here and changes ONE thing. */
function stuckGoal(text = "land the retry PR") {
  let goal = newGoal(text, T0);
  for (let i = 0; i < MAX_CONTINUES_WITHOUT_PROGRESS; i++) goal = noteContinue(goal, "stuck");
  return goal;
}

describe("an external gate is not absence of progress", () => {
  it("PAIR — with no gate known, the streak still escalates", () => {
    // THE TRUE POSITIVE. Without this the suppression test below is satisfied by a predicate that
    // has simply stopped working, which is the failure mode the founder explicitly ruled out
    // ("do NOT just raise the threshold").
    const d = decideContinuation(ready({ goal: stuckGoal(), mark: "stuck" }));
    expect(d.action).toBe("escalate");
    if (d.action !== "escalate") throw new Error("unreachable");
    expect(d.reason).toContain("no sign of progress");
  });

  it("an agent holding an OPEN PR is restarted, not paged as 'no sign of progress'", () => {
    // THE FOUNDER'S VERIFIABLE GOAL. Identical state to the pair above plus the one fact that was
    // never consulted: the work is out in front of a gate.
    const d = decideContinuation(
      ready({
        goal: stuckGoal(),
        mark: "stuck",
        externalWait: { kind: "open-pr", prNumber: 2117 },
      }),
    );
    expect(d.action).toBe("continue");
  });

  it("the gate suppresses the DIAGNOSIS, not the ceiling — it still ends at a human", () => {
    // A hole, not a gate, is the way this change could be wrong: an agent parked forever on an open
    // PR must still reach somebody. It does, through MAX_CONTINUES_TOTAL — whose sentence is about
    // the SPEND rather than the false claim that restarting cannot fix it.
    let goal = newGoal("land the retry PR", T0);
    let escalated: string | null = null;
    for (let round = 0; round < MAX_CONTINUES_TOTAL * 3; round++) {
      const d = decideContinuation(
        ready({
          goal,
          mark: "stuck",
          now: T0 + IDLE_SETTLE_MS + round,
          externalWait: { kind: "open-pr", prNumber: 2117 },
        }),
      );
      if (d.action === "continue") {
        goal = noteContinue(goal, "stuck");
        continue;
      }
      expect(d.action).toBe("escalate");
      if (d.action === "escalate") escalated = d.reason;
      break;
    }
    expect(escalated).not.toBeNull();
    expect(escalated).toContain("per-goal ceiling");
    // …and specifically NOT the diagnosis this gate exists to withhold.
    expect(escalated).not.toContain("no sign of progress");
  });

  it("the resume banner past the bound tells the agent the truth about the ceiling", () => {
    // AGENTS.md: a fix that changes WHEN something happens must update every string describing the
    // old timing. `attempt` is `consecutive + 1`, so a gated agent reaches resume 4 — and the
    // ordinary copy would read "AUTO-RESUME 4 OF 3 … at 3 this stops and escalates to a human",
    // which is arithmetically absurd AND promises an escalation the gate just cancelled.
    const d = decideContinuation(
      ready({
        goal: stuckGoal(),
        mark: "stuck",
        externalWait: { kind: "open-pr", prNumber: 2117 },
      }),
    );
    if (d.action !== "continue") throw new Error("expected a continue");
    expect(d.attempt).toBe(MAX_CONTINUES_WITHOUT_PROGRESS + 1);
    expect(d.prompt).toContain("PR #2117");
    expect(d.prompt).not.toContain(`OF ${MAX_CONTINUES_WITHOUT_PROGRESS} on this goal`);
    expect(d.prompt).toContain(String(MAX_CONTINUES_TOTAL));
    // It must not tell an agent that is waiting on CI to invent work.
    expect(d.prompt).toContain("do not invent work");
  });

  it("an ungated agent's banner is unchanged", () => {
    // The common path keeps its exact copy — `engine/agentOriginated` recognises Sparkle's own send
    // by this text, and two of the assertions above are negative, so a rewrite of the shared
    // sentence would go unnoticed without this.
    let goal = newGoal("g", T0);
    goal = noteContinue(goal, "stuck");
    const d = decideContinuation(ready({ goal, mark: "stuck" }));
    if (d.action !== "continue") throw new Error("expected a continue");
    expect(d.prompt).toContain(`THIS IS AUTO-RESUME 2 OF ${MAX_CONTINUES_WITHOUT_PROGRESS}`);
    expect(d.prompt).toContain("escalates to a human");
  });
});

describe("the mark measures WORK, not just self-reports", () => {
  const selfReports = { promptHistoryLength: 1, activity: "wiring", aiTitle: "PR work" };

  it("PAIR — an agent that moves nothing observable still escalates", () => {
    // The whole point of widening the mark is that it must stay ABLE to read "nothing happened".
    // An auto-continue deliberately does not grow `promptHistory` (`userPrompt: false`), and it is
    // not a tool call, so a wedged agent's mark is byte-identical across restarts.
    const before = progressMark({ ...selfReports, toolBursts: 12, commitsAhead: 3, prMark: "open#7" });
    const after = progressMark({ ...selfReports, toolBursts: 12, commitsAhead: 3, prMark: "open#7" });
    expect(after).toBe(before);
    const goal = { ...stuckGoal(), mark: before };
    expect(decideContinuation(ready({ goal, mark: after })).action).toBe("escalate");
  });

  it("running TOOLS is progress — the signal the six false pages could not see", () => {
    // A BURST COUNTER, not the raw windowed sample — see `noteToolActivity`. The engine only ever
    // sees the folded number; that the fold is monotone is the runner's test.
    const before = progressMark({ ...selfReports, toolBursts: 3 });
    const after = progressMark({ ...selfReports, toolBursts: 4 });
    expect(after).not.toBe(before);
    // …and that difference is what turns the escalation back into a restart.
    const goal = { ...stuckGoal(), mark: before };
    expect(decideContinuation(ready({ goal, mark: after })).action).toBe("continue");
  });

  it("COMMITTING is progress", () => {
    const goal = { ...stuckGoal(), mark: progressMark({ ...selfReports, commitsAhead: 3 }) };
    const after = progressMark({ ...selfReports, commitsAhead: 4 });
    expect(decideContinuation(ready({ goal, mark: after })).action).toBe("continue");
  });

  it("OPENING a PR, and its state moving, are both progress", () => {
    const none = progressMark({ ...selfReports, prMark: null });
    const opened = progressMark({ ...selfReports, prMark: "open#2117" });
    const merged = progressMark({ ...selfReports, prMark: "merged#2117" });
    expect(opened).not.toBe(none);
    expect(merged).not.toBe(opened);
  });

  it("'we did not look' and 'we looked and saw none' are DIFFERENT marks", () => {
    // A window with no digest for an agent reads null; a digest whose log is quiet reads 0. Folding
    // them together would let our own blind spot masquerade as a stable observation of no work —
    // the `undefined`-is-not-`false` rule the goal-reading service is built on.
    expect(progressMark({ promptHistoryLength: 1, toolBursts: null })).not.toBe(
      progressMark({ promptHistoryLength: 1, toolBursts: 0 }),
    );
    expect(progressMark({ promptHistoryLength: 1, commitsAhead: null })).not.toBe(
      progressMark({ promptHistoryLength: 1, commitsAhead: 0 }),
    );
  });

  it("the three original self-report inputs still move it", () => {
    // Widening must not have replaced them: a human typing, a narration and a re-derived title are
    // all still progress, and an all-artifact mark would have lost every agent with no worktree.
    const m = progressMark(selfReports);
    expect(progressMark({ ...selfReports, promptHistoryLength: 2 })).not.toBe(m);
    expect(progressMark({ ...selfReports, activity: "testing" })).not.toBe(m);
    expect(progressMark({ ...selfReports, aiTitle: "other" })).not.toBe(m);
  });

  it("a caller that supplies no artifact evidence gets the ORIGINAL mark", () => {
    // Back-compat, and it is load-bearing rather than tidy: `MAX_CONCIERGE_REARMS`' docs and several
    // callers reason about the three-field mark, and an unwired caller must keep today's behaviour
    // instead of silently reading every agent as having progressed.
    expect(progressMark(selfReports)).toBe(
      progressMark({ ...selfReports, toolBursts: null, commitsAhead: null, prMark: null }),
    );
  });
});

// ══ `goal-awaiting-close` — THE EXIT FOR A LANDED GOAL ONLY A PERSON MAY CLOSE ══════════════════
//
// Agent `d5d7056e` held merged work (PR #2188) behind a `{kind:"human"}` check. It could not close
// the goal itself — correctly, and that refusal is UNCHANGED — so this sweep resumed it every pass
// until `MAX_CONTINUES_WITHOUT_PROGRESS` escalated it to the founder, who read the result as a row
// blocked on him. Every restart was spent on an agent with nothing left to do.
//
// ⚠️ EVERY CASE IS A PAIR, differing in exactly ONE field from a fixture that DOES continue. A test
// that only proved "it stopped" would be satisfied by any of the dozen unrelated gates ahead of this
// one (AGENTS.md, `sparkle-rvf6n` — seen 6×), and the assertion is on the DECISION, which is the
// side effect, never on the evidence handed in.
describe("goal-awaiting-close — a landed goal awaiting a person's close stops being resumed", () => {
  const shipped = { landed: true, shippedAfterGoalSet: true } as const;
  /** The measured row's goal: live, unmet, and checkable only by a person. */
  const humanCheck = () => newGoal("PR #2188 is reviewed and merged", T0, DEFAULT_GOAL_TTL_MS, { kind: "human" });

  it("DECLINES with goal-awaiting-close — and the SAME row with no git reading still continues", () => {
    // The pair, in one test so neither half can be read in isolation. Only `awaitingClose` differs.
    const landed = decideContinuation(ready({ goal: humanCheck(), awaitingClose: shipped }));
    expect(landed).toEqual({ action: "none", reason: "goal-awaiting-close" });

    const unread = decideContinuation(
      ready({ goal: humanCheck(), awaitingClose: { landed: undefined, shippedAfterGoalSet: true } }),
    );
    expect(unread.action).toBe("continue");
  });

  it("continues exactly as before when the field is OMITTED — absence is not a refusal", () => {
    // The direction matters: this gate STOPS a resume, so a caller that forgot to look must not be
    // able to strand an agent that still had work. The cost of the omission is only the status quo.
    expect(decideContinuation(ready({ goal: humanCheck() })).action).toBe("continue");
  });

  it("stops an ESCALATED landed row too, and says so with the RIGHT reason", () => {
    // `already-escalated` would also have stopped it — and that is exactly the confusion this state
    // was added to end. The two reasons say opposite things about the agent: one is "auto-continue
    // gave up on unfinished work", the other is "the work is done". Asserting the reason, not just
    // the stop, is what makes this test able to fail.
    const escalated = escalateGoal(humanCheck(), T0 + 60_000, "The goal is still unmet");
    expect(decideContinuation(ready({ goal: escalated, awaitingClose: shipped }))).toEqual({
      action: "none",
      reason: "goal-awaiting-close",
    });
    expect(decideContinuation(ready({ goal: escalated }))).toEqual({
      action: "none",
      reason: "already-escalated",
    });
  });

  it("does NOT fire for an agent-closable check on the same landed evidence", () => {
    // A `{kind:"landed"}` goal on landed work has no person to wait for — the agent may close it
    // itself and simply has not. Resuming it is right, and it is the prompt that tells it how.
    const landedKind = newGoal("the work is on origin/main", T0, DEFAULT_GOAL_TTL_MS, { kind: "landed" });
    expect(decideContinuation(ready({ goal: landedKind, awaitingClose: shipped })).action).toBe("continue");
    expect(decideContinuation(ready({ goal: humanCheck(), awaitingClose: shipped })).action).toBe("none");
  });

  it("does NOT fire for an INHERITED human check — an ordinary work goal is never stranded", () => {
    // roborev 65987. `chargeGoalDebt` manufactures `{kind:"human"}` for any non-landing-shaped goal
    // text that inherited a binding obligation, so this is the COMMON path, not an edge. Reaching
    // the gate here would mean an agent with real work left is never auto-resumed for that goal
    // again — the "a false positive strands an agent that still had work to do" outcome
    // `AwaitingCloseEvidence` says must be avoided.
    const inherited = { ...humanCheck(), verifyInherited: true };
    expect(decideContinuation(ready({ goal: inherited, awaitingClose: shipped })).action).toBe("continue");
    expect(decideContinuation(ready({ goal: humanCheck(), awaitingClose: shipped })).action).toBe("none");
  });

  it("does NOT fire when the landing predates the goal — the next objective still gets resumed", () => {
    const stale = { landed: true, shippedAfterGoalSet: false } as const;
    expect(decideContinuation(ready({ goal: humanCheck(), awaitingClose: stale })).action).toBe("continue");
    expect(decideContinuation(ready({ goal: humanCheck(), awaitingClose: shipped })).action).toBe("none");
  });

  it("spends NO retry budget and never escalates — the streak bound is never reached", () => {
    // The failure being fixed was not only a wrong colour: the row CLIMBED to escalation. A landed
    // row sitting one continue below `MAX_CONTINUES_WITHOUT_PROGRESS` must decline, not escalate.
    let goal = humanCheck();
    for (let i = 0; i < MAX_CONTINUES_WITHOUT_PROGRESS; i += 1) goal = noteContinue(goal, "m0");
    // Same goal, same mark: without the gate this is the escalation the founder was handed.
    expect(decideContinuation(ready({ goal })).action).toBe("escalate");
    expect(decideContinuation(ready({ goal, awaitingClose: shipped }))).toEqual({
      action: "none",
      reason: "goal-awaiting-close",
    });
  });
});
