// THE MOUNT THAT LIED, AND THE REFUSALS NOBODY COULD SEE.
//
// Measured on the founder's live v0.95.0 install in one day: NINE `respawned a dead agent` lines,
// and for all nine agent ids `pty_spawn` count = 0 and `agent-status` events = 0. Nothing came back.
// Each fiction still spent one of the 24 durable daily attempts, moved its cohort into `probation`,
// failed 180s later on `no-turn-authority` (correctly — nothing had started), rotated the canary,
// and after three rotations abandoned the whole cohort. Two full cohort abandonments that day.
//
// The cause was not the ladder, the cohort engine or the claim: all nine agents were ABSENT from the
// projectStore. `localStorage['sparkle-projects']` held 15 projects and 75 agent rows, none of them
// these nine — their `agent-life` ledger records had outlived their UI rows. `defaultMount` route 1
// (`restartPane`) returned false because no pane had registered a lever, and route 2 is
// STRUCTURALLY INERT for a row-less agent: `Workspace.tsx` gates the project on
// `p.agents.some(a => admitted.has(a.id))` and mounts with `for (const a of p.agents)`, and an id
// naming no row matches neither. Both writes "succeeded" and nothing mounted.
//
// So every test here drives the REAL `defaultMount` and the REAL `agentRowPresent` against the REAL
// projectStore, populated through the store's own `addProject`/`addAgent` actions. Injecting either
// would prove the sweep's arithmetic while leaving the exact seam that failed uncovered — which is
// how this shipped in the first place.
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

// The abandonment path ends in a user-facing NOTIFICATION. Two of those were sent for cohorts that
// were never revivable, so "it was not sent" is an assertion this file needs to make.
vi.mock("./attention", () => ({ notifyAttention: vi.fn() }));

import { RESURRECT_LADDER_MS } from "../engine/resurrection";
import { PROBATION_MS } from "../engine/resurrectionCohort";
import { notifyAttention } from "./attention";
import { log } from "../logger";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import {
  _resetResurrectionRunnerForTests,
  cohortKeys,
  cohortPhaseFor,
  type DueAgent,
  type ResurrectionOutcome,
  type ResurrectionSweepOptions,
  agentRowPresent,
  reportSweepDecisions,
  startResurrectionRunner,
  stopResurrectionRunner,
  sweepResurrections,
} from "./resurrectionRunner";
import { isAgentAdmitted, resetAdmittedAgents } from "./resurrectionAdmission";

const notified = vi.mocked(notifyAttention);

const NOW = 1_754_534_400_000;
const FIRST_RUNG = RESURRECT_LADDER_MS[0]!;

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

/**
 * Put REAL agent rows in the REAL store, through the store's own actions.
 *
 * Hand-building a `Project` literal would test that `agentRowPresent` can read an object this test
 * wrote, which is not the question. The question is whether it reads the same place `addAgent`
 * writes — and that is the seam that was never checked at all.
 */
function seedProject(agentIds: readonly string[]): string {
  const projectId = useProjectStore.getState().addProject("proj", "/repo");
  for (const id of agentIds) useProjectStore.getState().addAgent(projectId, { id });
  return projectId;
}

interface Harness {
  opts: ResurrectionSweepOptions;
  /** `[agentId, spawned]` for every claim given back. `spawned: true` is what records a DURABLE
   *  attempt against the 24-a-day cap, so it is asserted separately from anything else. */
  released: Array<[string, boolean]>;
}

/** Permissive everywhere EXCEPT `mount` and `hasAgentRow`, which are left to their real defaults —
 *  they are the code under test. */
function harness(due: DueAgent[], over: Partial<ResurrectionSweepOptions> = {}): Harness {
  const released: Array<[string, boolean]> = [];
  return {
    released,
    opts: {
      now: NOW + FIRST_RUNG,
      ownsProject: () => true,
      projectTornOut: () => false,
      due: () => Promise.resolve(due),
      liveSessions: () => Promise.resolve([]),
      claim: () => Promise.resolve(true),
      release: (agentId, spawned) => {
        released.push([agentId, spawned]);
        return Promise.resolve();
      },
      suppress: () => {},
      ...over,
    },
  };
}

/** A cohort of exactly two: same cause, same verbatim message, same epoch, 500ms apart. Both the
 *  minimum `groupCohorts` will form and the most common real size. */
function pairOfVictims(a: string, b: string): DueAgent[] {
  return [dead({ agentId: a, diedAt: NOW - 500 }), dead({ agentId: b })];
}

/** Every phase this window currently holds, so a test can say "none of them is X". */
function phases(): Array<string | undefined> {
  return cohortKeys().map((k) => cohortPhaseFor(k)?.phase);
}

beforeEach(() => {
  _resetResurrectionRunnerForTests();
  resetAdmittedAgents();
  notified.mockClear();
  useProjectStore.setState({ projects: [], selectedProjectId: null });
  useRuntimeStore.setState({ openAgentIds: [], status: {} });
});

describe("an agent whose projectStore row is gone can never be mounted, and nothing is spent on it", () => {
  it("refuses it by NAME and records no durable attempt", async () => {
    // The store is POPULATED — with somebody else. So the answer below comes from the row genuinely
    // being absent, not from the empty-store fail-open guard in `agentRowPresent`.
    seedProject(["someone-else"]);
    const h = harness([dead({ agentId: "ghost" })]);

    const outcomes = await sweepResurrections(h.opts);

    // The reason a human reads. `no-agent-row`, not `respawn` and not a cohort phase.
    expect(outcomes).toEqual([{ agentId: "ghost", action: "none", detail: "no-agent-row" }]);
    // THE COST THAT WAS PAID NINE TIMES. One of 24 per agent per day, gone on a mount that never
    // happened — and once spent, the agent is nearer the only terminal bound the ladder has.
    expect(
      h.released.filter(([, spawned]) => spawned),
      "a mount that cannot land must never record a durable attempt",
    ).toEqual([]);
    // …and neither of route 2's writes happened. Both are effectively permanent for the session:
    // the admission set is add-only, and nothing removes an id from `openAgentIds` on a PTY exit.
    expect(isAgentAdmitted("ghost")).toBe(false);
    expect(useRuntimeStore.getState().openAgentIds).not.toContain("ghost");
  });

  it("DOES respawn the same agent when its row exists — the paired positive", async () => {
    // One test proving absence is ambiguous: a sweep that refused everything would satisfy the one
    // above. This is the identical setup with the single difference that decides it.
    seedProject(["ghost"]);
    const h = harness([dead({ agentId: "ghost" })]);

    const outcomes = await sweepResurrections(h.opts);

    // The detail NAMES THE ROUTE, so it cannot be reported by a mount that did nothing.
    expect(outcomes).toEqual([
      { agentId: "ghost", action: "respawn", detail: "attempt 1 (opened)" },
    ]);
    expect(h.released, "a real mount MUST record the attempt").toEqual([["ghost", true]]);
    expect(isAgentAdmitted("ghost")).toBe(true);
    expect(useRuntimeStore.getState().openAgentIds).toContain("ghost");
  });

  it("catches a row DELETED between the sweep's pre-gate and the mount", async () => {
    // `defaultMount`'s own check is the LAST line of defence, and the sweep's pre-gate normally
    // reaches the same conclusion first — so without this test that check is dead code and deleting
    // it leaves the suite green. (Verified: removing it left all other tests passing.)
    //
    // This drives the one production shape where the two genuinely disagree. `claim` is the awaited
    // call between the pre-gate and `o.mount`, so deleting the row there reproduces exactly what a
    // user closing an agent mid-sweep — or a cross-window store sync landing — does. No injection:
    // the REAL `defaultMount` and the REAL `agentRowPresent` decide.
    //
    // The project keeps a SECOND agent so the store never empties, which would make
    // `agentRowPresent` fail open and answer the question for a reason that has nothing to do with
    // the mechanism under test.
    const projectId = seedProject(["vanishing", "a-survivor"]);
    const h = harness([dead({ agentId: "vanishing" })], {
      claim: () => {
        useProjectStore.getState().removeAgent(projectId, "vanishing");
        return Promise.resolve(true);
      },
    });

    const outcomes = await sweepResurrections(h.opts);

    expect(outcomes).toEqual([{ agentId: "vanishing", action: "none", detail: "no-agent-row" }]);
    expect(
      h.released,
      "the claim WAS taken, so it must be given back — but with no attempt recorded",
    ).toEqual([["vanishing", false]]);
    expect(isAgentAdmitted("vanishing")).toBe(false);
    expect(useRuntimeStore.getState().openAgentIds).not.toContain("vanishing");
  });

  it("reads the same store `addAgent` writes to, and only that store", async () => {
    // Guards the seam directly, in both directions. `agentRowPresent` answering from anywhere else
    // — a stale copy, the admission set, `openAgentIds` — would make the pair above pass while the
    // production predicate stayed wrong.
    seedProject(["real"]);
    expect(agentRowPresent("real")).toBe(true);
    expect(agentRowPresent("never-existed")).toBe(false);
  });

  it("answers 'present' for EVERYTHING while the store is empty — it fails OPEN on purpose", () => {
    // zustand's persist middleware rehydrates `sparkle-projects` asynchronously and this sweep
    // starts ticking at boot. An empty store cannot be told apart from an unrehydrated one, and
    // `false` there would mark the WHOLE FLEET orphaned for one tick — a permanent refusal that also
    // feeds `permanentlyUnfit`, so one unlucky tick would write off every dead agent on the machine.
    expect(useProjectStore.getState().projects).toEqual([]);
    expect(agentRowPresent("anything-at-all")).toBe(true);
  });
});

describe("a row-less member never becomes a canary and never costs a cohort its budget", () => {
  it("does not move the cohort into probation for a row-less canary", async () => {
    seedProject(["someone-else"]);
    const h = harness(pairOfVictims("g1", "g2"));

    const outcomes = await sweepResurrections(h.opts);

    // The cohort must genuinely EXIST, or everything below is vacuous.
    expect(cohortKeys(), "these two must group, or this test proves nothing").toHaveLength(1);
    expect(phases(), "a canary that cannot mount must not start a 180s probation").not.toContain(
      "probation",
    );
    // Both members are refused by name rather than by cohort phase.
    expect(outcomes.map((o) => o.detail)).toEqual(["no-agent-row", "no-agent-row"]);
    expect(h.released.filter(([, spawned]) => spawned)).toEqual([]);
  });

  it("DOES enter probation for the same cohort when the rows exist — the paired positive", async () => {
    seedProject(["g1", "g2"]);
    const h = harness(pairOfVictims("g1", "g2"));

    const outcomes = await sweepResurrections(h.opts);

    expect(cohortKeys()).toHaveLength(1);
    expect(phases(), "a real canary MUST be put on probation").toEqual(["probation"]);
    // Exactly one canary went, and the other waits on it.
    expect(outcomes.filter((o) => o.action === "respawn")).toHaveLength(1);
    expect(h.released.filter(([, spawned]) => spawned)).toHaveLength(1);
  });

  it("never abandons a cohort whose members are ALL row-less", async () => {
    // THE FAILURE THIS FILE IS NAMED FOR. `abandoned` is sticky for the life of the key —
    // `decideCohortAdmission` returns `[]` forever after — and it fires a "N agents could not be
    // brought back" notification. Two of those went out in one day for cohorts that were never
    // revivable, because `permanentlyUnfit` feeds `everyoneFinished` and an orphan is permanently
    // unfit. Swept enough times, with evidence that would fail any probation instantly, that a
    // cohort with a real canary budget would have exhausted it several times over.
    seedProject(["someone-else"]);
    const h = harness(pairOfVictims("g1", "g2"));

    for (let i = 0; i < 6; i += 1) {
      await sweepResurrections({
        ...h.opts,
        now: NOW + FIRST_RUNG + i * PROBATION_MS,
        probationEvidence: () => ({
          exited: true,
          reWalled: false,
          apiBannerAt: undefined,
          hasTurnAuthority: false,
          didWork: false,
        }),
      });
    }

    expect(phases()).not.toContain("abandoned");
    expect(
      notified,
      "nobody may be told 2 agents could not be brought back when none was ever sent",
    ).not.toHaveBeenCalled();
  });

  it("STILL abandons a MIXED cohort whose real victim burned out — the guard is narrow", async () => {
    // The control that keeps the guard above from becoming a blanket "never abandon". A cohort
    // holding one real victim and one orphan IS honestly abandoned once the real one has failed:
    // the door really is shut and a human really is needed. Suppressing that would hide a genuine
    // outage behind one stale record.
    seedProject(["real"]);
    const h = harness(pairOfVictims("real", "ghost"));

    for (let i = 0; i < 6; i += 1) {
      await sweepResurrections({
        ...h.opts,
        now: NOW + FIRST_RUNG + i * PROBATION_MS,
        probationEvidence: () => ({
          exited: true,
          reWalled: false,
          apiBannerAt: undefined,
          hasTurnAuthority: false,
          didWork: false,
        }),
      });
    }

    expect(phases(), "a real canary that failed must still reach abandonment").toContain(
      "abandoned",
    );
    expect(notified).toHaveBeenCalled();
  });
});

describe("every sweep says WHY, and stops saying it once nothing has changed", () => {
  /** Only the summary line — `respawned a dead agent` and friends also go through `log.info`. */
  function summaries(spy: ReturnType<typeof vi.spyOn>): unknown[][] {
    return spy.mock.calls.filter((c) => c[1] === "resurrection sweep decisions");
  }

  afterEach(() => {
    stopResurrectionRunner();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("logs the grouped reasons through the REAL tick, then goes quiet while they hold", async () => {
    // Driven through `startResurrectionRunner` rather than by calling `reportSweepDecisions`
    // directly, because the defect was that the tick DISCARDED the sweep's return value. A test that
    // called the reporter itself would pass against a tick that still throws the outcomes away.
    vi.useFakeTimers();
    const info = vi.spyOn(log, "info");
    // BOTH agents get real rows, so the refusal reported below is the per-agent gate's own reason.
    // Without them the orphan gate answers first (`no-agent-row`), which is correct behaviour but
    // would make this test about the wrong refusal.
    seedProject(["waiting-1", "waiting-2"]);
    // `blocked-on-human` is a refusal that can hold for days — exactly the steady state that would
    // have written 5,760 identical lines a day — and it never reaches a mount, so the only `log.info`
    // this sweep can produce is the summary.
    const stuck = [
      dead({ agentId: "waiting-1", cause: "blocked-on-human" }),
      dead({ agentId: "waiting-2", cause: "blocked-on-human" }),
    ];
    const due = { current: stuck };

    startResurrectionRunner(1_000, {
      now: NOW + FIRST_RUNG,
      ownsProject: () => true,
      projectTornOut: () => false,
      due: () => Promise.resolve(due.current),
      liveSessions: () => Promise.resolve([]),
      claim: () => Promise.resolve(true),
      release: () => Promise.resolve(),
      suppress: () => {},
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(summaries(info), "the first sweep must say why both agents were left alone").toHaveLength(
      1,
    );
    // The COUNTS and the AGENT IDS, grouped by reason — the thing the founder asked for.
    expect(summaries(info)[0]?.[2]).toEqual({
      total: 2,
      reasons: {
        "blocked-on-human": { count: 2, agentIds: ["waiting-1", "waiting-2"] },
      },
    });

    // Three more ticks reaching the identical conclusion. A steady state must not spam.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(summaries(info), "an unchanged answer must not be re-logged every 15s").toHaveLength(1);

    // …and a genuine change IS news. The paired positive: without it, a reporter that logged once
    // and never again would satisfy everything above.
    due.current = [stuck[0]!];
    await vi.advanceTimersByTimeAsync(1_000);
    expect(summaries(info), "one agent leaving the due list is a change").toHaveLength(2);
    expect(summaries(info)[1]?.[2]).toEqual({
      total: 1,
      reasons: { "blocked-on-human": { count: 1, agentIds: ["waiting-1"] } },
    });
  });

  it("treats the same reasons in a different ORDER as unchanged", () => {
    // The due list is a BTreeMap walk on the Rust side but is re-grouped here, so ordering is not
    // guaranteed to be stable across sweeps. Without sorting both axes, a steady state would re-log
    // whenever the order happened to shuffle — which is the noise this whole mechanism avoids.
    const a: ResurrectionOutcome[] = [
      { agentId: "x", action: "none", detail: "daily-cap-spent" },
      { agentId: "y", action: "none", detail: "daily-cap-spent" },
    ];
    const reversed: ResurrectionOutcome[] = [a[1]!, a[0]!];

    expect(reportSweepDecisions(a), "the first summary is always news").toBe(true);
    expect(reportSweepDecisions(reversed), "a reordering is not a change").toBe(false);
    expect(
      reportSweepDecisions([...a, { agentId: "z", action: "none", detail: "blocked-on-human" }]),
      "a new agent under a new reason IS a change",
    ).toBe(true);
  });

  it("writes nothing at all for a machine with nothing due", () => {
    // The ordinary case, and the one that runs for hours. Seeded at the empty signature so the
    // steady quiet state never costs a line.
    const info = vi.spyOn(log, "info");
    expect(reportSweepDecisions([])).toBe(false);
    expect(info).not.toHaveBeenCalled();
  });
});
