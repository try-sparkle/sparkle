// THE FOUNDER'S FIRST ACCEPTANCE CRITERION, in executable form:
//
//   "an agent killed by `API Error: Unable to connect to API (ENOTFOUND)` IS respawned
//    automatically."
//
// Ten agents died that way in the measured window and NONE of them came back, because the only
// mechanism that could have brought them back — `engine/apiRecovery` — works by typing into a LIVING
// PTY and refuses anything whose process is gone. This file is the proof that the gap is closed.
//
// It fails against pre-wiring code by construction: `services/resurrectionRunner` did not exist, so
// there was nothing to import. It keeps failing against a runner whose ladder, cause gate or
// admission is broken, because it asserts the DECISION the sweep returned and the admission it
// actually performed — not that some spy was called.
import { beforeEach, describe, expect, it } from "vitest";

import { RESURRECT_LADDER_MS } from "../engine/resurrection";
import {
  _resetResurrectionRunnerForTests,
  type DueAgent,
  type ResurrectionSweepOptions,
  sweepResurrections,
} from "./resurrectionRunner";
import { admitAgent, isAgentAdmitted, resetAdmittedAgents } from "./resurrectionAdmission";

/** VERBATIM, from the founder's own transcripts. Paraphrasing it would make every assertion below
 *  prove something about a string this app never sees. */
const ENOTFOUND = "API Error: Unable to connect to API (ENOTFOUND)";

const NOW = 1_754_534_400_000;
/** The first rung of the respawn ladder — 60s. Pinned BY VALUE here, following this repo's own
 *  discipline, so an upstream edit to `REVIVE_LADDER_MS` is NOTICED rather than silently inherited. */
const FIRST_RUNG = RESURRECT_LADDER_MS[0]!;

function dead(over: Partial<DueAgent> = {}): DueAgent {
  return {
    agentId: "a1",
    projectId: "proj-1",
    worktree: "/wt/a1",
    cause: "transport-transient",
    epoch: "epoch-that-died",
    diedAt: NOW,
    // What the ledger publishes for a non-clock cause: due immediately, paced by the ladder.
    notBeforeMs: NOW,
    message: ENOTFOUND,
    attemptsAt: [],
    ...over,
  };
}

interface Harness {
  opts: ResurrectionSweepOptions;
  /** Every agent id the sweep actually let mount, in order. */
  mounted: string[];
  /** `[agentId, spawned]` for every claim given back. `spawned` is what the durable daily cap
   *  counts, so it has to be asserted separately from the mount. */
  released: Array<[string, boolean]>;
  /** Agents held off the goal sweep, and until when. */
  suppressed: Array<[string, number]>;
}

function harness(due: DueAgent[], over: Partial<ResurrectionSweepOptions> = {}): Harness {
  const mounted: string[] = [];
  const released: Array<[string, boolean]> = [];
  const suppressed: Array<[string, number]> = [];
  return {
    mounted,
    released,
    suppressed,
    opts: {
      now: NOW,
      ownsProject: () => true,
      projectTornOut: () => false,
      due: () => Promise.resolve(due),
      liveSessions: () => Promise.resolve([]),
      claim: () => Promise.resolve(true),
      release: (agentId, spawned) => {
        released.push([agentId, spawned]);
        return Promise.resolve();
      },
      mount: (agentId) => {
        mounted.push(agentId);
      },
      suppress: (agentId, untilMs) => {
        suppressed.push([agentId, untilMs]);
      },
      ...over,
    },
  };
}

beforeEach(() => {
  _resetResurrectionRunnerForTests();
  resetAdmittedAgents();
});

describe("an ENOTFOUND death is respawned automatically", () => {
  it("respawns the agent once the first rung is due", async () => {
    const h = harness([dead()]);
    const outcomes = await sweepResurrections({ ...h.opts, now: NOW + FIRST_RUNG });

    expect(outcomes).toEqual([{ agentId: "a1", action: "respawn", detail: "attempt 1" }]);
    // The SIDE EFFECT, not the decision restated: the pane was let mount.
    expect(h.mounted).toEqual(["a1"]);
    // …and the attempt was recorded DURABLY, which is the number the rolling daily cap counts.
    expect(h.released).toEqual([["a1", true]]);
  });

  it("does NOT respawn it before the first rung — the ladder is a real gate, not decoration", async () => {
    const h = harness([dead()]);
    const outcomes = await sweepResurrections({ ...h.opts, now: NOW + FIRST_RUNG - 1 });

    expect(outcomes).toEqual([
      { agentId: "a1", action: "none", detail: "waiting-for-next-rung" },
    ]);
    expect(h.mounted).toEqual([]);
    // NOTHING is released either: a claim we never took must not be given back, and an attempt must
    // never be recorded for a respawn that did not happen.
    expect(h.released).toEqual([]);
  });

  it("admits it to the mount set, which is the whole side effect", async () => {
    // The one test that drives the REAL admission set rather than a captured array, because
    // `Workspace`'s `live` memo reads exactly this and nothing else. The runtime-store half of the
    // default `mount` is left out deliberately — this file has no business standing up a store to
    // prove that a Set was written.
    const h = harness([dead()], { mount: (agentId) => admitAgent(agentId) });

    expect(isAgentAdmitted("a1")).toBe(false);
    await sweepResurrections({ ...h.opts, now: NOW + FIRST_RUNG });
    expect(isAgentAdmitted("a1")).toBe(true);
  });

  it("is a LONE death, so it skips the canary entirely", async () => {
    // One agent's death is that agent's bad luck, not an incident — `groupCohorts` returns it in no
    // cohort, and it must not be put through a 3-minute probation. Asserted by the outcome NOT being
    // a `cohort-*` refusal: a runner that treated every death as a cohort would answer
    // `cohort-canary-elected` here for two of the three sweeps.
    const h = harness([dead()]);
    const outcomes = await sweepResurrections({ ...h.opts, now: NOW + FIRST_RUNG });
    expect(outcomes[0]?.detail).not.toMatch(/^cohort-/);
    expect(outcomes[0]?.action).toBe("respawn");
  });

  it("holds the goal sweep off it for the full probation window", async () => {
    // Otherwise the pane mounts, sits idle while `claude --resume` boots, and at IDLE_SETTLE_MS the
    // goal sweep types a continue into it — spending one of its 20 continues on a turn it never
    // needed. See suppressContinuation for why that is worse still for a canary.
    const { PROBATION_MS } = await import("../engine/resurrectionCohort");
    const h = harness([dead()]);
    await sweepResurrections({ ...h.opts, now: NOW + FIRST_RUNG });
    expect(h.suppressed).toEqual([["a1", NOW + FIRST_RUNG + PROBATION_MS]]);
  });

  it("stops at the rolling daily cap rather than retrying forever", async () => {
    // The measured worst case is a session that retried into a closed door 45 times. The cap is the
    // ONLY terminal bound — the ladder plateaus at 30 minutes rather than ending — so it has to
    // hold, and it has to be counted from the DURABLE list.
    const { MAX_RESURRECTS_PER_AGENT_PER_DAY } = await import("../engine/resurrection");
    const spent = Array.from(
      { length: MAX_RESURRECTS_PER_AGENT_PER_DAY },
      (_, i) => NOW - 60_000 * (i + 1),
    );
    const h = harness([dead({ attemptsAt: spent })]);
    const outcomes = await sweepResurrections({ ...h.opts, now: NOW + FIRST_RUNG * 100 });

    expect(outcomes).toEqual([{ agentId: "a1", action: "none", detail: "daily-cap-spent" }]);
    expect(h.mounted).toEqual([]);
  });
});
