// A RUNNING CHILD COUNTS AS PROGRESS — BUT ONLY WHILE IT IS FRESH (bead sparkle-n2feho.1, cause 5).
//
// MEASURED HARM: the resume ticker escalated a sweeper mid-`pnpm verify` and burned continues on
// agents whose OWN turn had closed while a background task — or a worker child — it had spawned was
// still working. Treating that quiet as "no progress" is false: the agent is delegating, not stalled.
//
// `inMotion` PARKS such an agent: NO escalate (it is progressing) and NO resume (a "continue" typed
// into a terminal whose foreground is the running child would interrupt it). But the park is BOUNDED
// by IN_MOTION_GRACE_MS: a motion signal can stick true (a killed worker still reading `working`, a
// footer count that never clears), so once it out-lasts the grace the gate FALLS THROUGH to the
// bounds and a genuinely wedged delegate reaches a human — never the silent-forever state.
//
// Every assertion drives the REAL `decideContinuation`, and each is PAIRED (motion off, or motion
// stale) — so the test fails against the pre-change code and against an UNBOUNDED park, rather than
// passing vacuously.
import { describe, expect, it } from "vitest";

import { newGoal } from "./agentGoal";
import {
  IDLE_SETTLE_MS,
  IN_MOTION_GRACE_MS,
  MAX_CONTINUES_TOTAL,
  MAX_CONTINUES_WITHOUT_PROGRESS,
  type ContinuationInput,
  decideContinuation,
  progressMark,
} from "./goalContinuation";

const T0 = 1_700_000_000_000;
const NOW = T0 + IDLE_SETTLE_MS + 1_000;

// A well-formed mark whose WORK columns are readable, so the escalation the PAIRED cases assert is
// the ordinary "no sign of progress" one rather than the blind variant.
const MARK = progressMark({ promptHistoryLength: 3, activity: "verifying", toolBursts: 4, commitsAhead: 2 });

/** A fresh child: seen just now, so its age is under the grace and the gate parks. */
const FRESH = { since: NOW } as const;
/** A stuck child: seen longer ago than the grace, so the gate hands over to the bounds. */
const STALE = { since: NOW - IN_MOTION_GRACE_MS - 1 } as const;

function ready(over: Partial<ContinuationInput> = {}): ContinuationInput {
  return {
    goal: newGoal("Ship the fix", T0),
    status: "idle",
    now: NOW,
    idleSince: T0,
    hasTurnEndAuthority: true,
    canAcceptInput: true,
    mark: MARK,
    processAlive: undefined,
    runtime: "local",
    cloud: undefined,
    ...over,
  };
}

/** A NO-progress streak: the recorded mark equals the live one (so `progressed` is false), and the
 *  two counters are already set, so the next decision is attempt n+1 and the chosen bound is reached. */
function streak(continues: number, totalContinues: number, over: Partial<ContinuationInput> = {}) {
  const goal = newGoal("Ship the fix", T0);
  return ready({ goal: { ...goal, mark: MARK, continues, totalContinues }, mark: MARK, ...over });
}

describe("in-motion: a fresh running child parks the ladder instead of escalating or resuming", () => {
  it("THE STREAK BOUND — a fresh-in-motion agent at the no-progress bound is PARKED, not escalated", () => {
    const d = decideContinuation(
      streak(MAX_CONTINUES_WITHOUT_PROGRESS, MAX_CONTINUES_WITHOUT_PROGRESS, { inMotion: FRESH }),
    );
    expect(d.action).toBe("none");
    if (d.action !== "none") return;
    expect(d.reason).toBe("in-motion");
  });

  it("PAIRED — the identical streak with NO motion still ESCALATES", () => {
    const d = decideContinuation(streak(MAX_CONTINUES_WITHOUT_PROGRESS, MAX_CONTINUES_WITHOUT_PROGRESS));
    expect(d.action).toBe("escalate");
  });

  it("THE CEILING — a fresh-in-motion agent at the per-goal ceiling is PARKED, not escalated", () => {
    const d = decideContinuation(streak(0, MAX_CONTINUES_TOTAL, { inMotion: FRESH }));
    expect(d.action).toBe("none");
    if (d.action !== "none") return;
    expect(d.reason).toBe("in-motion");
  });

  it("PAIRED — the identical ceiling with NO motion still ESCALATES", () => {
    const d = decideContinuation(streak(0, MAX_CONTINUES_TOTAL));
    expect(d.action).toBe("escalate");
  });

  it("CONTINUE-SPAM — a fresh-in-motion agent eligible for an ordinary resume is PARKED, not continued", () => {
    const d = decideContinuation(streak(0, 0, { inMotion: FRESH }));
    expect(d.action).toBe("none");
    if (d.action !== "none") return;
    expect(d.reason).toBe("in-motion");
  });

  it("PAIRED — the identical eligible agent with NO motion CONTINUES as before", () => {
    const d = decideContinuation(streak(0, 0));
    expect(d.action).toBe("continue");
  });
});

describe("in-motion: the park is BOUNDED — a stuck signal hands the agent to a human", () => {
  it("STALE at the streak bound ESCALATES rather than parking forever", () => {
    // Without a grace, the gate would park here forever — the silent-forever state. Proves the bound.
    const d = decideContinuation(
      streak(MAX_CONTINUES_WITHOUT_PROGRESS, MAX_CONTINUES_WITHOUT_PROGRESS, { inMotion: STALE }),
    );
    expect(d.action).toBe("escalate");
  });

  it("STALE at the ceiling ESCALATES rather than parking forever", () => {
    const d = decideContinuation(streak(0, MAX_CONTINUES_TOTAL, { inMotion: STALE }));
    expect(d.action).toBe("escalate");
  });

  it("UNTIMED (since: null) is not parked on — it falls through to the ordinary resume", () => {
    // A live child whose age this window cannot state must not buy an unbounded park; it behaves
    // exactly as if no motion were wired, like an UNTIMED external gate.
    const d = decideContinuation(streak(0, 0, { inMotion: { since: null } }));
    expect(d.action).toBe("continue");
  });
});
