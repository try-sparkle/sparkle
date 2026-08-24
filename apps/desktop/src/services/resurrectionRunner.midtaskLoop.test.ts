// A RESUME-THEN-EXIT LOOP IS PAUSED EARLY AND HANDED TO THE CONCIERGE (sparkle-y5dk8x).
//
// The bead: a build agent's Claude session exited THREE times mid-task, and every background subagent
// it had dispatched died with it, producing nothing. The daily cap (24 respawns / rolling 24h) would
// eventually bound and escalate such a loop -- but only after hours, because each mid-task exit is its
// OWN death episode and the per-episode ladder restarts fast every cycle. By then the human has been
// told nothing while every cycle lost in-flight work.
//
// So `decideResurrection` now refuses the clean-resumable mid-task loop FAR below the daily cap
// (`MAX_MIDTASK_RESUMES`), and `resurrectionRunner` hands that refusal to the concierge -- the same
// machinery `daily-cap-spent` uses, one rung earlier and cause-specific. These tests assert the SIDE
// EFFECT (the Nth mid-task exit stops the respawn loop AND escalates; a single one still recovers),
// never the decision restated.
import { beforeEach, describe, expect, it } from "vitest";

import { routeMidTaskLoop } from "@sparkle/core";
import { MAX_MIDTASK_RESUMES, MAX_RESURRECTS_PER_AGENT_PER_DAY } from "../engine/resurrection";
import {
  _resetResurrectionRunnerForTests,
  type DueAgent,
  type ResurrectionSweepOptions,
  sweepResurrections,
} from "./resurrectionRunner";
import { resetAdmittedAgents } from "./resurrectionAdmission";

const NOW = 1_754_534_400_000;

/** N respawn timestamps inside the rolling window, all OLDER than the current death, so they count as
 *  rolling-window attempts (the loop's accumulated cost) but not as attempts in THIS episode -- which
 *  is the real shape of a resume-then-exit loop: each cycle is a fresh episode. Derived from the
 *  constant so raising the ceiling cannot leave the test asserting about a count that no longer loops. */
function windowAttempts(n: number): number[] {
  // Spread across the last few hours, all before `diedAt` (NOW - 1_000).
  return Array.from({ length: n }, (_, i) => NOW - 60_000 - (i + 1) * 60_000);
}

/** A dead agent that exited mid-task cleanly (unknown + a resume banner is supplied via the harness's
 *  `resumeBannerShown`), with `attempts` respawns already spent in the rolling window. */
function looping(attempts: number, over: Partial<DueAgent> = {}): DueAgent {
  return {
    agentId: "a1",
    projectId: "proj-1",
    worktree: "/wt/a1",
    cause: "unknown",
    epoch: "epoch-that-died",
    diedAt: NOW - 1_000,
    notBeforeMs: NOW - 1_000,
    message: undefined,
    attemptsAt: windowAttempts(attempts),
    ...over,
  };
}

interface Harness {
  opts: ResurrectionSweepOptions;
  escalations: string[];
  mounted: string[];
}

function harness(due: DueAgent[], over: Partial<ResurrectionSweepOptions> = {}): Harness {
  const escalations: string[] = [];
  const mounted: string[] = [];
  return {
    escalations,
    mounted,
    opts: {
      now: NOW,
      ownsProject: () => true,
      projectTornOut: () => false,
      hasAgentRow: () => true,
      due: () => Promise.resolve(due),
      liveSessions: () => Promise.resolve([]),
      claim: () => Promise.resolve(true),
      release: () => Promise.resolve(),
      mount: (agentId) => {
        mounted.push(agentId);
        return "opened" as const;
      },
      suppress: () => {},
      // POSITIVE clean-resume witness: the pane shows Claude's `claude --resume` banner, which is what
      // makes an `unknown` death a mid-task self-exit rather than a silent crash.
      resumeBannerShown: () => true,
      escalate: (text) => {
        escalations.push(text);
        return true;
      },
      ...over,
    },
  };
}

beforeEach(() => {
  _resetResurrectionRunnerForTests();
  resetAdmittedAgents();
});

describe("a resume-then-exit loop is paused early and handed to the concierge", () => {
  it("at the MAX_MIDTASK_RESUMES'th clean-resume respawn: stops respawning AND escalates", async () => {
    const h = harness([looping(MAX_MIDTASK_RESUMES)]);
    const outcomes = await sweepResurrections(h.opts);

    // THE SIDE EFFECT: the loop is stopped (nothing mounted) and a human hears about it.
    expect(outcomes).toEqual([{ agentId: "a1", action: "none", detail: "midtask-loop" }]);
    expect(h.mounted).toEqual([]);
    expect(h.escalations).toHaveLength(1);
  });

  it("PAIRED NEGATIVE: a single mid-task exit still RECOVERS -- it is not escalated", async () => {
    // A fresh episode with no prior respawns, whose first fast rung is already due (diedAt is a couple
    // minutes back). This is the transient-hiccup case the loop ceiling must not swallow: it must come
    // back on its own rather than being handed off.
    const h = harness([
      looping(0, { diedAt: NOW - 120_000, notBeforeMs: NOW - 120_000, attemptsAt: [] }),
    ]);
    const outcomes = await sweepResurrections(h.opts);

    expect(outcomes[0]!.action).toBe("respawn");
    expect(h.mounted).toEqual(["a1"]);
    expect(h.escalations).toEqual([]);
  });

  it("PAIRED NEGATIVE: one below the ceiling does NOT yet escalate -- it respawns", async () => {
    // MAX_MIDTASK_RESUMES - 1 attempts is still under the loop bound: a few automatic recoveries are
    // free. Proves the ceiling is what fires the escalation, not merely "some attempts happened".
    const h = harness([looping(MAX_MIDTASK_RESUMES - 1)]);
    const outcomes = await sweepResurrections(h.opts);

    expect(outcomes[0]!.action).toBe("respawn");
    expect(h.escalations).toEqual([]);
  });

  it("PAIRED NEGATIVE: the SAME attempt count without a resume banner is NOT a loop-escalation", async () => {
    // No clean-resume witness -> not a mid-task self-exit (could be a silent crash), so the early
    // cause-specific ceiling does not apply. Without the banner an `unknown` death arms on the SLOWEST
    // rung, so this refuses as `waiting-for-next-rung` and stays recoverable -- it is NOT handed off.
    const h = harness([looping(MAX_MIDTASK_RESUMES)], { resumeBannerShown: () => false });
    const outcomes = await sweepResurrections(h.opts);

    expect(outcomes[0]!.detail).not.toBe("midtask-loop");
    expect(h.escalations).toEqual([]);
  });

  it("a WALL keeps its full daily budget -- the loop ceiling never shortens probing", async () => {
    // The reason the ceiling is gated on cause `unknown` alone: a spend/session wall recovers by
    // PROBING and legitimately needs all 24 attempts. MAX_MIDTASK_RESUMES attempts of a wall cause,
    // even with a resume banner present, must still respawn (probe), never loop-escalate.
    const h = harness([
      looping(MAX_MIDTASK_RESUMES, { cause: "wall-spend", message: "usage limit reached" }),
    ]);
    const outcomes = await sweepResurrections(h.opts);

    expect(outcomes[0]!.detail).not.toBe("midtask-loop");
    expect(h.escalations).toEqual([]);
  });

  it("says what the concierge needs, targets the concierge, and never pages the founder", async () => {
    const h = harness([looping(MAX_MIDTASK_RESUMES)]);
    await sweepResurrections(h.opts);
    const text = h.escalations[0]!;

    // The ROUTE decides the recipient; re-pointing it at the founder is the one change that would undo
    // this while every other assertion still passed, so it is pinned on the router itself.
    expect(routeMidTaskLoop({ label: "x", attempts: MAX_MIDTASK_RESUMES }).target).toBe("concierge");
    expect(text.toLowerCase()).toContain("mid-task");
    expect(text.toLowerCase()).not.toContain("ask the founder");
    // The real spend from the ledger, not the cap constant, and never the DAILY cap's number.
    expect(text).toContain(String(MAX_MIDTASK_RESUMES));
  });

  it("escalates ONCE while the loop stays paused, not once every 15-second sweep", async () => {
    // The refusal pauses respawns, so `diedAt` is stable across the pause -- the latch keys on it, so
    // repeated sweeps of the same paused loop hand the concierge exactly one finding.
    const h = harness([looping(MAX_MIDTASK_RESUMES)]);
    await sweepResurrections(h.opts);
    await sweepResurrections({ ...h.opts, now: NOW + 15_000 });
    await sweepResurrections({ ...h.opts, now: NOW + 30_000 });
    expect(h.escalations).toHaveLength(1);
  });

  it("a genuinely NEW loop after another chance escalates AGAIN", async () => {
    // Keyed on the death instant, not a bare boolean: an agent that got respawned, exited mid-task yet
    // again and re-crossed the ceiling is a new finding -- swallowing it would silently abandon it.
    const h = harness([looping(MAX_MIDTASK_RESUMES)]);
    await sweepResurrections(h.opts);
    expect(h.escalations).toHaveLength(1);

    const later = NOW + 3_600_000;
    await sweepResurrections({
      ...h.opts,
      now: later,
      due: () =>
        Promise.resolve([
          looping(MAX_MIDTASK_RESUMES, {
            diedAt: later - 1_000,
            notBeforeMs: later - 1_000,
            attemptsAt: Array.from({ length: MAX_MIDTASK_RESUMES }, (_, i) => later - 60_000 - (i + 1) * 60_000),
          }),
        ]),
    });
    expect(h.escalations).toHaveLength(2);
  });

  it("keeps the finding OWED when the concierge could not be told", async () => {
    // A refused hand-off is not latched -- it stays owed and comes back next sweep, the doctrine that
    // stops a lost finding.
    const refused: string[] = [];
    const h = harness([looping(MAX_MIDTASK_RESUMES)], {
      escalate: (text) => {
        refused.push(text);
        return false;
      },
    });
    await sweepResurrections(h.opts);
    await sweepResurrections({ ...h.opts, now: NOW + 15_000 });
    expect(refused).toHaveLength(2);
  });

  it("the loop ceiling sits BELOW the daily cap, so a fully spent loop is the stronger daily-cap-spent", async () => {
    // Both bounds could match a long loop; the daily cap is the stronger statement and is checked
    // first, so a loop that also spent its whole budget surfaces as `daily-cap-spent`.
    expect(MAX_MIDTASK_RESUMES).toBeLessThan(MAX_RESURRECTS_PER_AGENT_PER_DAY);
    const h = harness([
      looping(MAX_RESURRECTS_PER_AGENT_PER_DAY, {
        attemptsAt: Array.from({ length: MAX_RESURRECTS_PER_AGENT_PER_DAY }, (_, i) => NOW - 1_000 - (i + 1) * 1_000),
      }),
    ]);
    const outcomes = await sweepResurrections(h.opts);
    expect(outcomes[0]!.detail).toBe("daily-cap-spent");
  });
});
