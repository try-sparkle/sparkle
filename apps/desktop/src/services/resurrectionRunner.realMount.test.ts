// THE FOUR FIXES FROM roborev 60241, EACH DRIVEN THROUGH THE REAL DEFAULT RATHER THAN AN INJECTION.
//
// The other four runner test files all inject `mount`, `probationEvidence` and friends, which is
// right for testing the sweep's DECISIONS. But it left the real defaults — the code that actually
// runs in the app — with no coverage at all, and three of them were broken in ways that made the
// feature a no-op or worse:
//
//   • `mount` did nothing for the common case, while still reporting `respawn` and burning a
//     durable attempt.
//   • `MAX_RESPAWNS_PER_SWEEP` never bound, so a swarm of lone deaths flooded.
//   • `defaultProbationEvidence` read a frozen pre-death status, so it failed every canary on the
//     first check and abandoned every cohort.
//
// So this file exercises the defaults deliberately.
import { beforeEach, describe, expect, it } from "vitest";

import { RESURRECT_LADDER_MS } from "../engine/resurrection";
import { RELEASE_BATCH } from "../engine/resurrectionCohort";
import {
  noteProcessExit,
  resetTurnEndAuthority,
  trackAgent,
} from "../engine/turnEndAuthority";
import { registerPaneRestart, unregisterPaneRestart } from "./paneControl";
import { type QuotaBlock, quotaBlocksIn } from "../engine/quotaBlock";
import {
  MAX_RESPAWNS_PER_SWEEP,
  type ProbationSources,
  _resetResurrectionRunnerForTests,
  type DueAgent,
  defaultProbationEvidenceForTests,
  sweepResurrections,
} from "./resurrectionRunner";
import { isAgentAdmitted, resetAdmittedAgents } from "./resurrectionAdmission";
import { useRuntimeStore } from "../stores/runtimeStore";

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

/** Sweep options with everything permissive EXCEPT `mount`, which is left to its real default. */
function realMountOpts(due: DueAgent[], now = NOW + FIRST_RUNG) {
  return {
    now,
    ownsProject: () => true,
    projectTornOut: () => false,
    due: () => Promise.resolve(due),
    liveSessions: () => Promise.resolve([]),
    claim: () => Promise.resolve(true),
    release: () => Promise.resolve(),
    suppress: () => {},
    // `mount` deliberately NOT injected.
  };
}

beforeEach(() => {
  _resetResurrectionRunnerForTests();
  resetAdmittedAgents();
  resetTurnEndAuthority();
  useRuntimeStore.setState({ openAgentIds: [], status: {} });
});

describe("the mount path actually restarts a pane that is still mounted", () => {
  it("pulls the pane's own restart lever when one is registered", async () => {
    // THE COMMON CASE, and the one that was a no-op. `classifyDeath`'s Gate 0 only writes a real
    // verdict when `liveness === "local"`, which needs a `runtimeStore.status` entry, which only a
    // MOUNTED pane produces — so every locally-observed death has a pane still sitting on its
    // "Agent exited — Start again" overlay. `runtimeStore.open` is a no-op for an id already in
    // `openAgentIds`, and nothing removes it on PTY exit, so without the restart lever nothing
    // whatsoever happened.
    const restarts: string[] = [];
    registerPaneRestart("a1", () => restarts.push("a1"));
    useRuntimeStore.setState({ openAgentIds: ["a1"] });

    const outcomes = await sweepResurrections(realMountOpts([dead()]));

    expect(outcomes).toEqual([{ agentId: "a1", action: "respawn", detail: "attempt 1" }]);
    expect(restarts, "the pane's re-spawn lever must actually be pulled").toEqual(["a1"]);
    unregisterPaneRestart("a1");
  });

  it("falls back to admitting the project when NO pane is mounted", async () => {
    // The app-restart case: the previous process died, the seal inferred it at launch, and this
    // window has never mounted anything for that agent. `restartPane` returns false, and the
    // admission set plus `open` are what make Workspace mount a fresh pane.
    expect(isAgentAdmitted("a1")).toBe(false);

    await sweepResurrections(realMountOpts([dead()]));

    expect(isAgentAdmitted("a1")).toBe(true);
    expect(useRuntimeStore.getState().openAgentIds).toContain("a1");
  });

  it("does NOT admit-and-open when the pane restart succeeded", async () => {
    // The two routes are exclusive. Doing both would put a still-mounted agent into the admission
    // set for no reason — and that set is add-only for the life of the session.
    registerPaneRestart("a1", () => {});
    useRuntimeStore.setState({ openAgentIds: ["a1"] });

    await sweepResurrections(realMountOpts([dead()]));

    expect(isAgentAdmitted("a1")).toBe(false);
    unregisterPaneRestart("a1");
  });
});

describe("the per-sweep cap binds on LONE deaths, which is what it was written for", () => {
  /** N agents dying at once with DISTINCT banner texts — different codes, different request ids —
   *  so each falls below the 2-victim cohort floor and `groupCohorts` returns them all as lone
   *  deaths. All clear the same 60s rung together. */
  function loneSwarm(n: number): DueAgent[] {
    return Array.from({ length: n }, (_, i) =>
      dead({
        agentId: `lone-${i}`,
        message: `API Error: 529 Overloaded (request_id=req_${i})`,
      }),
    );
  }

  it("admits at most MAX_RESPAWNS_PER_SWEEP of them in one tick", async () => {
    const n = MAX_RESPAWNS_PER_SWEEP + 6;
    const outcomes = await sweepResurrections({
      ...realMountOpts(loneSwarm(n)),
      mount: () => {},
    });

    const admitted = outcomes.filter((o) => o.action === "respawn");
    expect(admitted).toHaveLength(MAX_RESPAWNS_PER_SWEEP);
    // …and the rest say WHY, rather than vanishing from the outcomes.
    expect(outcomes.filter((o) => o.detail === "sweep-cap")).toHaveLength(n - MAX_RESPAWNS_PER_SWEEP);
  });

  it("still admits the ones it capped on the NEXT sweep", async () => {
    // The cap must pace, not strand. Without this, a bound that admitted 4 and dropped 6 forever
    // would satisfy the test above.
    const swarm = loneSwarm(MAX_RESPAWNS_PER_SWEEP + 2);
    const revived = new Set<string>();
    const opts = {
      ...realMountOpts(swarm),
      due: () => Promise.resolve(swarm.filter((d) => !revived.has(d.agentId))),
      mount: (agentId: string) => {
        revived.add(agentId);
      },
    };

    await sweepResurrections(opts);
    expect(revived.size).toBe(MAX_RESPAWNS_PER_SWEEP);

    await sweepResurrections(opts);
    expect(revived.size).toBe(swarm.length);
  });

  it("is equal to RELEASE_BATCH, so it never becomes a cohort's binding constraint", () => {
    expect(MAX_RESPAWNS_PER_SWEEP).toBe(RELEASE_BATCH);
  });
});

describe("probation evidence is scoped to THIS run, not the death that preceded it", () => {
  const SPAWNED_AT = NOW + FIRST_RUNG;

  it("does not report `exited` from a status left over from the death", async () => {
    // THE INVERSION. `runtimeStore.status` has a single writer — a mounted `AgentPane` — so between
    // the death and the respawned pane's first write it stays frozen at `errored`, set by
    // `StatusEngine.exit()`. Reading it made the very first probation check report `exited: true`,
    // `advanceProbation` fails FAST on that with no recency guard, and three canary rotations later
    // the whole cohort was `abandoned`.
    useRuntimeStore.setState({ status: { canary: "errored" } });

    const ev = defaultProbationEvidenceForTests("canary", SPAWNED_AT, SPAWNED_AT + 15_000);

    expect(
      ev.exited,
      "a pre-death status must read as 'no reading yet', never as 'it died again'",
    ).toBe(false);
  });

  it("DOES report `exited` when the respawned process itself exits", async () => {
    // The control, and the half that keeps the fix honest: a canary that genuinely dies again must
    // still fail fast. `turnEndAuthority` is the respawn-scoped source — `dispose()` forgets the
    // agent and the new engine tracks it — so this is a reading about THIS run.
    const owner = {};
    trackAgent("canary", owner);
    noteProcessExit("canary", owner);

    const ev = defaultProbationEvidenceForTests("canary", SPAWNED_AT, SPAWNED_AT + 15_000);

    expect(ev.exited).toBe(true);
  });

  it("reports no reading at all for an agent this window has never tracked", async () => {
    const ev = defaultProbationEvidenceForTests("never-seen", SPAWNED_AT, SPAWNED_AT + 15_000);
    expect(ev.exited).toBe(false);
    expect(ev.hasTurnAuthority).toBe(false);
  });

  /** Sources with no readings at all, overridden per test. Driving `reWalled` needs a real
   *  `QuotaBlock` in BOTH directions — a test that cannot produce a wall proves nothing about the
   *  `>= spawnedAt` comparison, because `false` is also the answer when there is no wall. */
  function sources(over: Partial<ProbationSources> = {}): ProbationSources {
    return {
      quota: () => undefined,
      lastFailure: () => undefined,
      processAlive: () => undefined,
      hasAuthority: () => false,
      ...over,
    };
  }

  function wallAt(at: number): QuotaBlock {
    // The real parser, so this is the shape the app actually stores — not a hand-built object that
    // already has the field the assertion checks.
    const block = quotaBlocksIn(
      "You've hit your session limit · resets 10:30pm (America/Los_Angeles)",
      at,
    )[0];
    if (block === undefined) throw new Error("fixture must parse as a real quota block");
    return block;
  }

  it("does NOT count a wall observed before the respawn as the door shutting again", async () => {
    // A canary sent AT a wall has, by construction, a wall on its record from before it was sent.
    // Counting that as `reWalled` would fail every canary the moment it was admitted — and walls are
    // the case the canary exists for.
    const ev = defaultProbationEvidenceForTests(
      "canary",
      SPAWNED_AT,
      SPAWNED_AT + 15_000,
      sources({ quota: () => wallAt(SPAWNED_AT - 1) }),
    );
    expect(ev.reWalled).toBe(false);
  });

  it("DOES count a wall observed after the respawn — the door really did shut again", async () => {
    // The positive direction, which nothing asserted before. Without it, `.at` being the wrong
    // field or the comparison being inverted would leave `reWalled` permanently false: a re-walled
    // canary would pass its probation and release the whole cohort straight into the closed door it
    // exists to detect, with a green suite.
    const ev = defaultProbationEvidenceForTests(
      "canary",
      SPAWNED_AT,
      SPAWNED_AT + 15_000,
      sources({ quota: () => wallAt(SPAWNED_AT + 1) }),
    );
    expect(ev.reWalled).toBe(true);
  });

  it("reports no wall at all as not re-walled — the control for the pair above", async () => {
    const ev = defaultProbationEvidenceForTests("canary", SPAWNED_AT, SPAWNED_AT + 15_000, sources());
    expect(ev.reWalled).toBe(false);
  });
});
