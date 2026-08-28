// THE DURABLE DEAD-SESSION MIRROR the sweep publishes for the row-colour pipeline (bead sparkle-
// nu7gd9, Defect #1), and the ONE thing it must never publish: a LIVE agent (roborev 70465).
//
// `sweepResurrections` mirrors the `revival_due` list into `stores/resurrectableDeadStore` so a
// transient death this window never observed still renders amber instead of red. But the due list can
// name an agent whose PTY is ALREADY LIVE — a stale ledger record, another window's respawn — and
// `withDeadSessionCalm` repaints anything that is not exactly `working`/`lapsed` to `lapsed`, so
// publishing a live agent sitting on a `waiting`/`approval` prompt would HIDE a genuine ask. The
// live-session snapshot the sweep already reads must filter the mirror. This is the paired test that
// pins both directions: a dead agent IS published, the same agent when live is NOT.
import { beforeEach, describe, expect, it } from "vitest";

import {
  _resetResurrectionRunnerForTests,
  type DueAgent,
  type ResurrectionSweepOptions,
  sweepResurrections,
} from "./resurrectionRunner";
import { resetAdmittedAgents } from "./resurrectionAdmission";
import {
  useResurrectableDeadStore,
  _resetResurrectableDeadStoreForTests,
} from "../stores/resurrectableDeadStore";

const NOW = 1_754_534_400_000;

function dead(over: Partial<DueAgent> = {}): DueAgent {
  return {
    agentId: "a1",
    projectId: "proj-1",
    worktree: "/wt/a1",
    cause: "transport-transient",
    epoch: "epoch-that-died",
    diedAt: NOW,
    notBeforeMs: NOW,
    message: "API Error: Unable to connect to API (ENOTFOUND)",
    attemptsAt: [],
    ...over,
  };
}

function opts(
  due: DueAgent[],
  live: string[],
  over: Partial<ResurrectionSweepOptions> = {},
): ResurrectionSweepOptions {
  return {
    now: NOW,
    ownsProject: () => true,
    projectTornOut: () => false,
    due: () => Promise.resolve(due),
    liveSessions: () => Promise.resolve(live),
    claim: () => Promise.resolve(true),
    release: () => Promise.resolve(),
    mount: () => "opened" as const,
    suppress: () => {},
    ...over,
  };
}

beforeEach(() => {
  _resetResurrectionRunnerForTests();
  resetAdmittedAgents();
  _resetResurrectableDeadStoreForTests();
});

describe("the sweep publishes the durable dead-session list", () => {
  it("mirrors a dead-and-resurrectable agent's cause into the store", async () => {
    await sweepResurrections(opts([dead({ agentId: "deadonly" })], []));
    expect(useResurrectableDeadStore.getState().causes).toEqual({
      deadonly: "transport-transient",
    });
  });

  it("EXCLUDES an agent whose PTY is still live — its prompt must not be repainted amber", async () => {
    // The due list names both; only the live one is filtered. Without the guard, `liveghost` would
    // enter the store, `deathCauseForAgent` would return a resurrectable cause for a running agent,
    // and `withDeadSessionCalm` would hide a `waiting`/`approval` prompt on it.
    await sweepResurrections(
      opts([dead({ agentId: "deadonly" }), dead({ agentId: "liveghost" })], ["liveghost"]),
    );
    const { causes } = useResurrectableDeadStore.getState();
    expect(causes["deadonly"]).toBe("transport-transient");
    expect(causes["liveghost"], "a live agent must never reach the colour mirror").toBeUndefined();
  });

  it("publishes even a not-yet-due agent — colour is about the death, not the restart clock", async () => {
    // The publish is before the ladder gate, so an agent waiting for its next rung is still dead and
    // still amber. (Its restart waits; its colour does not.)
    await sweepResurrections(opts([dead({ agentId: "waiting", notBeforeMs: NOW + 60_000 })], []));
    expect(useResurrectableDeadStore.getState().causes["waiting"]).toBe("transport-transient");
  });
});
