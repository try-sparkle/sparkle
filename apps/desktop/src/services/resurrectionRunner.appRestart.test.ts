// THE MEASURED EVENT, REPLAYED. 2026-08-06, 18:20 PT.
//
//   "the app quit. 54 `SessionEnd` in ONE minute. 18:21 — it relaunched; 45 panes resumed."
//
// Forty-five simultaneous `claude --resume` boots against one account is not a recovery strategy; it
// is the same fleet-wide retry that burns a reset. Twenty-six minutes later the app was down again,
// taking 49 more agents, and exactly ONE came back.
//
// So this file drives the real sweep over 54 records sealed under ONE dead epoch and asserts the
// three properties the founder named:
//
//   1. EXACTLY ONE respawn in the first three minutes — the canary, and nobody else.
//   2. A DRAINED release after it survives — a bounded batch per interval, not a flood.
//   3. NEVER 54 simultaneous. At no point in the whole replay does one sweep admit more than
//      RELEASE_BATCH agents.
//
// It fails against pre-wiring code by construction (the runner did not exist), and it keeps failing
// against a runner that skips the canary, loses the cohort's identity as its members leave, or drops
// the per-sweep bound.
import { beforeEach, describe, expect, it } from "vitest";

import { RESURRECT_LADDER_MS } from "../engine/resurrection";
import { PROBATION_MS, RELEASE_BATCH } from "../engine/resurrectionCohort";
import {
  _resetResurrectionRunnerForTests,
  type DueAgent,
  sweepResurrections,
} from "./resurrectionRunner";
import { resetAdmittedAgents } from "./resurrectionAdmission";

const NOW = 1_754_534_400_000;
const FIRST_RUNG = RESURRECT_LADDER_MS[0]!;
const DEAD_EPOCH = "epoch-2026-08-06T18-00";
const FLEET_SIZE = 54;
/** The sweep's own cadence, so the replay ticks the way the app does. */
const SWEEP = 15_000;

/**
 * The fleet as the ledger publishes it after `seal_stale_at` has run.
 *
 * `cause: "app-restart"` with NO message — nobody was alive to print one, which is the whole reason
 * `cohortKeyOf` groups a restart on its dead EPOCH instead. Deaths spread over the measured ONE
 * minute, ordered so `a00` is oldest (and therefore the canary `electCanary` picks).
 */
function sealedFleet(): DueAgent[] {
  return Array.from({ length: FLEET_SIZE }, (_, i) => ({
    agentId: `a${String(i).padStart(2, "0")}`,
    projectId: `proj-${i % 7}`,
    worktree: `/wt/a${i}`,
    cause: "app-restart" as const,
    epoch: DEAD_EPOCH,
    diedAt: NOW + i * 1_000,
    // What `derive` publishes for an app-restart with no wall riding along: due immediately, so the
    // ladder is the only thing pacing it.
    notBeforeMs: NOW,
    message: null,
    attemptsAt: [],
  }));
}

/** A canary that booted, connected and ran a turn. The two positive fields are the ones
 *  `advanceProbation` judges AT the deadline, and a spinner cannot fake either. */
const HEALTHY_CANARY = {
  exited: false,
  reWalled: false,
  apiBannerAt: undefined,
  hasTurnAuthority: true,
  didWork: true,
} as const;

interface Replay {
  /** `[t, ids]` for every sweep that admitted anyone. */
  admissions: Array<[number, string[]]>;
  /** Everything admitted, in order. */
  all: string[];
}

/**
 * Run the sweep every 15s from `NOW` to `NOW + durationMs`, with the ledger behaving as it really
 * does: an agent that has been respawned is ALIVE, so it leaves the due list.
 *
 * That departure is not incidental — it is the hardest part of the whole feature. The canary is
 * elected because it is the oldest death, and `groupCohorts` anchors a cluster's key on its oldest
 * death, so the canary is ALWAYS the member whose leaving would re-key its own cohort. If
 * `stabilizeCohortKeys` did not pin identity outside the grouping, this replay would restart the
 * probation after every single agent and 54 agents would come back one every three minutes.
 */
async function replay(durationMs: number): Promise<Replay> {
  const fleet = sealedFleet();
  const revived = new Set<string>();
  const admissions: Replay["admissions"] = [];
  const all: string[] = [];

  for (let t = 0; t <= durationMs; t += SWEEP) {
    const now = NOW + t;
    const outcomes = await sweepResurrections({
      now,
      ownsProject: () => true,
      projectTornOut: () => false,
      due: () => Promise.resolve(fleet.filter((d) => !revived.has(d.agentId))),
      // The respawned agents' PTYs are live; the rest are not. This is also what makes the
      // double-spawn backstop real in this replay rather than vacuous.
      liveSessions: () => Promise.resolve([...revived]),
      claim: () => Promise.resolve(true),
      release: () => Promise.resolve(),
      mount: (agentId) => {
        revived.add(agentId);
              return "opened" as const;
      },
      suppress: () => {},
      probationEvidence: () => HEALTHY_CANARY,
    });
    const admitted = outcomes.filter((o) => o.action === "respawn").map((o) => o.agentId);
    if (admitted.length > 0) admissions.push([t, admitted]);
    all.push(...admitted);
  }
  return { admissions, all };
}

beforeEach(() => {
  _resetResurrectionRunnerForTests();
  resetAdmittedAgents();
});

describe("the 2026-08-06 18:20 app restart — 54 agents under one dead epoch", () => {
  it("sends EXACTLY ONE agent back in the first three minutes", async () => {
    const { all, admissions } = await replay(PROBATION_MS);

    expect(all).toEqual(["a00"]);
    // …and it is the CANARY: oldest death first, which is `electCanary`'s documented order.
    expect(admissions).toEqual([[FIRST_RUNG, ["a00"]]]);
  });

  it("sends nobody at all before the first rung — not even the canary", async () => {
    const { all } = await replay(FIRST_RUNG - SWEEP);
    expect(all).toEqual([]);
  });

  it("never admits more than one batch in a single sweep, across the whole recovery", async () => {
    // THE HEADLINE PROPERTY. "45 panes resumed in one minute" is the thing this feature exists to
    // make impossible, and it is asserted over EVERY sweep rather than at the end — a check on the
    // total alone would pass for a run that flooded once and then went quiet.
    const { admissions, all } = await replay(20 * 60_000);

    for (const [t, ids] of admissions) {
      expect(
        ids.length,
        `sweep at t+${t / 1000}s admitted ${ids.length} agents: ${ids.join(",")}`,
      ).toBeLessThanOrEqual(RELEASE_BATCH);
    }
    // The whole fleet does come back — a bound that recovers nobody would also satisfy the loop
    // above, which is exactly the vacuous shape this repo calls its #1 finding.
    expect(new Set(all).size).toBe(FLEET_SIZE);
  });

  it("drains the remaining 53 over minutes, not in one tick", async () => {
    const { admissions } = await replay(20 * 60_000);

    // The canary alone, then a drain that takes many sweeps. 53 agents at RELEASE_BATCH per
    // RELEASE_BATCH_INTERVAL_MS (20s) cannot finish in fewer than ~13 batches.
    const afterCanary = admissions.filter(([, ids]) => !(ids.length === 1 && ids[0] === "a00"));
    expect(afterCanary.length).toBeGreaterThanOrEqual(13);

    const last = admissions[admissions.length - 1]![0];
    expect(
      last,
      "the fleet must come back over minutes; finishing inside one probation window would mean the drain is not bounded",
    ).toBeGreaterThan(PROBATION_MS);
  });

  it("holds every non-canary back while the canary is on probation", async () => {
    // The middle of the window, not just its edges: at t = first rung + half a probation the canary
    // is running and NOBODY else may go, whatever the ladder says about them individually.
    const { all } = await replay(FIRST_RUNG + PROBATION_MS / 2);
    expect(all).toEqual(["a00"]);
  });

  it("releases the fleet only AFTER the canary has served its full probation", async () => {
    const justBefore = await replay(FIRST_RUNG + PROBATION_MS - SWEEP);
    expect(justBefore.all).toEqual(["a00"]);

    _resetResurrectionRunnerForTests();
    resetAdmittedAgents();

    const justAfter = await replay(FIRST_RUNG + PROBATION_MS + SWEEP);
    expect(justAfter.all.length).toBeGreaterThan(1);
  });

  it("keeps the cohort's identity when the canary — its own anchor — leaves the due list", async () => {
    // If identity were re-derived from the current death list each tick, the canary's departure
    // would mint a fresh key, orphan the `released` phase, elect a NEW canary and start another full
    // probation — degrading a 54-agent recovery into one agent every three minutes, serialized.
    //
    // Asserted through the observable consequence rather than by reading the key: 20 minutes in, the
    // whole fleet is back. Under the re-derive bug that number is 7 (20 min / 3 min probation).
    const { all } = await replay(20 * 60_000);
    expect(new Set(all).size).toBe(FLEET_SIZE);
  });

  it("does not send back an agent whose PTY is somehow already live", async () => {
    // The process-global backstop, inside the replay: a torn-off satellite (or a straggler from the
    // dying app) already has `a00`'s session. `pty.rs`'s `sessions.insert` REPLACES silently, so
    // admitting it here would orphan a still-running child.
    const fleet = sealedFleet();
    const outcomes = await sweepResurrections({
      now: NOW + FIRST_RUNG,
      ownsProject: () => true,
      projectTornOut: () => false,
      due: () => Promise.resolve(fleet),
      liveSessions: () => Promise.resolve(["a00"]),
      claim: () => Promise.resolve(true),
      release: () => Promise.resolve(),
      mount: () => {
        throw new Error("nothing may be mounted in this sweep");
      },
      suppress: () => {},
      probationEvidence: () => HEALTHY_CANARY,
    });

    expect(outcomes.filter((o) => o.action === "respawn")).toEqual([]);
    expect(outcomes.find((o) => o.agentId === "a00")?.detail).toBe("already-live");
  });
});
