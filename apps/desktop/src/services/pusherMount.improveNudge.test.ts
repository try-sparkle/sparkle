// THE PRODUCTION SEAM for the never-idle watcher — that `buildImproveNudgeDeps`'s REAL readers reach
// the live stores and resolve agent-attributable values, not that a test's injected deps do.
//
// This is the gap AGENTS.md names as the #1 fleet finding: `improveNudge.test.ts` proves the decision
// with injected deps, so deleting the body of `improveReadyBacklog` / `improveAdvanceFingerprint`, or
// pointing them at the wrong store field or the wrong agent id, would leave that suite green while the
// feature is inert in production (roborev 66020). These tests seed the stores the wiring actually
// reads and assert the bound getters return the seeded values — and, with empty stores, that they
// return the fail-safe "nothing" rather than a constant.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { buildImproveNudgeDeps } from "./pusherMount";
import { SPARKLE_AGENT_ID, SPARKLE_PROJECT_ID, PIPELINE_HEALTH_LABEL } from "./sparkleAgent";
import { useBeadsStore } from "../stores/beadsStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useProjectStore } from "../stores/projectStore";
import { localAgentCapacity } from "./agentCapacity";
import type { Bead, Board } from "./beads";
import { ORCHESTRATOR_SILENT_MS } from "../engine/orchestratorLiveness";

const bead = (over: Partial<Bead>): Bead => ({
  id: "b",
  title: "t",
  description: "",
  status: "open",
  labels: [],
  ...over,
});

const emptyBoard = (): Board => ({
  backlog: [],
  blocked: [],
  inProgress: [],
  done: [],
  delivered: [],
  archived: [],
});

// In a non-Tauri test the window label is the single-window default ("main"), so the wiring resolves
// the improve agent to the CANONICAL id — the same id the seeds below use.
const IMPROVE_ID = SPARKLE_AGENT_ID;

beforeEach(() => {
  useBeadsStore.setState({ byProject: {} });
  useRuntimeStore.setState({ status: {}, agentMovement: {} } as never);
  useProjectStore.setState({ selectedProjectId: null, projects: [] } as never);
});
afterEach(() => vi.restoreAllMocks());

describe("buildImproveNudgeDeps — the real readers reach the live stores", () => {
  it("readyBacklog() reads the sparkle-self board backlog and its open P1 pipeline-health beads", () => {
    const beads: Bead[] = [
      // r1 is an explicit P0 so the self-feeding `nextReadyBead` pick below is unambiguous — the
      // highest-priority ready bead the code hands the agent, ahead of the P1s.
      bead({ id: "r1", priority: 0, title: "the P0" }),
      bead({ id: "r2", priority: 2 }),
      // Two open P1 pipeline-health beads, deliberately given ids in DESCENDING order so the fingerprint
      // assertion below proves the reader SORTS them (a stable identity), not merely concatenates.
      bead({ id: "ph-z", priority: 1, labels: [PIPELINE_HEALTH_LABEL] }),
      bead({ id: "ph-a", priority: 1, labels: [PIPELINE_HEALTH_LABEL] }),
    ];
    const board = emptyBoard();
    board.backlog = beads;
    useBeadsStore.setState({
      byProject: { [SPARKLE_PROJECT_ID]: { beads, board, loadedAt: 0 } },
    });

    const got = buildImproveNudgeDeps().readyBacklog();
    // Proves the reader reached `byProject[SPARKLE_PROJECT_ID].board.backlog` — a constant or a wrong
    // project id could not produce 4, and the P1 filter reached the label + priority fields. The
    // fingerprint proves it read the actual bead IDS and sorted them, so a changed set of red beads is a
    // changed fingerprint (what the concierge-notify dedup keys on). And `nextReadyBead` proves the
    // reader chose the highest-priority ready bead IN CODE (the P0 r1, ahead of the P1s) — the
    // self-feeding pick the never-idle nudge hands over by name (bead sparkle-n2feho.1).
    expect(got).toEqual({
      // The READABLE half of the pair with the unpolled-board case below: a real snapshot reports
      // true, so the flag distinguishes "read it, it has 4" from "could not read it" (sparkle-hrzitj).
      boardReadable: true,
      ready: 4,
      p1PipelineHealth: 2,
      p1PipelineHealthFingerprint: "ph-a,ph-z",
      nextReadyBead: { id: "r1", priority: 0, title: "the P0" },
    });
  });

  it("readyBacklog() reports an unpolled sparkle board as UNREADABLE, not as an empty one", () => {
    // THE ABSENT-SNAPSHOT CASE, and it is the P0 (bead sparkle-hrzitj). This used to read as
    // "no work, rest" — the fail-toward-silence direction — which is exactly how the Concierge came
    // to sit idle against 25 open epics: the ONE count-based stand-down downstream saw all zeros and
    // could not tell them from a genuinely drained board.
    //
    // The counts stay 0 so no caller can read a number that means something it does not. What
    // changed is that `boardReadable: false` now travels WITH them, and that is the fact the
    // decision gates on. Absence of a reading is not a reading of absence.
    expect(buildImproveNudgeDeps().readyBacklog()).toEqual({
      boardReadable: false,
      ready: 0,
      p1PipelineHealth: 0,
      p1PipelineHealthFingerprint: null,
      // Still null: no snapshot → no ready column → never invent a next item to hand over.
      nextReadyBead: null,
    });
  });

  it("paneStatus() and advanceFingerprint() read the improve agent's own runtime status", () => {
    useRuntimeStore.setState({ status: { [IMPROVE_ID]: "idle" } });
    const deps = buildImproveNudgeDeps();
    expect(deps.paneStatus()).toBe("idle");
    // The advance fingerprint is that same own-turn status — so it MOVES when the turn re-opens and is
    // flat across a sustained rest. Keyed to the improve agent, not a project-wide quantity.
    expect(deps.advanceFingerprint()).toBe("idle");
  });

  it("advanceFingerprint() is null when this window has no status reading (unreadable, not idle)", () => {
    expect(buildImproveNudgeDeps().advanceFingerprint()).toBeNull();
  });

  it("consentIsNever() reflects the live improvement-consent setting", () => {
    useSettingsStore.setState({ sparkleImprovementConsent: "never" });
    expect(buildImproveNudgeDeps().consentIsNever()).toBe(true);
    useSettingsStore.setState({ sparkleImprovementConsent: "always" });
    expect(buildImproveNudgeDeps().consentIsNever()).toBe(false);
  });

  it("capacity() projects the live localAgentCapacity — activeWorkers = used, freeSlots = max(0, limit − used)", () => {
    // Seed local build/worker ROWS so `used` is provably > 0 — a constant `{freeSlots, activeWorkers}`
    // or a reader pointed at the wrong store field could not track this. The oracle is
    // `localAgentCapacity()` itself: the wiring must PROJECT it, not re-derive a different number.
    useProjectStore.setState({
      selectedProjectId: "p1",
      projects: [
        {
          id: "p1",
          agents: [
            { id: "w1", kind: "worker", runtime: "local" },
            { id: "w2", kind: "build", runtime: "local" },
            { id: "c1", kind: "build", runtime: "cloud" }, // cloud excluded from the budget
          ],
        },
      ],
    } as never);

    const cap = localAgentCapacity();
    expect(cap.used).toBe(2); // the two local rows; the cloud row is not counted
    const got = buildImproveNudgeDeps().capacity();
    expect(got.activeWorkers).toBe(cap.used);
    expect(got.freeSlots).toBe(Math.max(0, cap.limit - cap.used));
  });

  it("capacity() SPLITS rows from work: a FINISHED agent is reclaimable, not working (bead sparkle-nu7gd9)", () => {
    // The measured failure, at production scale in miniature. Two local rows, BOTH alive, and both
    // with a goal already MET — the exact shape of the ~30 finished agents that held 79 of 81 slots
    // while nothing was being built. `activeWorkers` must still say 2 (they DO hold the slots, and
    // the admission gate depends on that), but `workingAgents` must say 0 and `reclaimableAgents` 2.
    const met = { text: "ship it", setAt: 1, metAt: 2 };
    useProjectStore.setState({
      selectedProjectId: "p1",
      projects: [
        {
          id: "p1",
          agents: [
            { id: "w1", kind: "worker", runtime: "local", goal: met },
            { id: "w2", kind: "build", runtime: "local", goal: met },
          ],
        },
      ],
    } as never);
    useRuntimeStore.setState({ status: { w1: "idle", w2: "idle" } });

    const got = buildImproveNudgeDeps().capacity();
    // Rows are unchanged — narrowing `used` here would let spawns in against slots that are taken.
    expect(got.activeWorkers).toBe(2);
    // …but NOTHING is working, which is the reading the alarm runs off.
    expect(got.workingAgents).toBe(0);
    expect(got.reclaimableAgents).toBe(2);
    // The two are counted independently and are NOT complements — see `agentIsWorking`.
    expect(got.workingAgents + got.reclaimableAgents).toBeLessThanOrEqual(got.activeWorkers);
  });

  it("capacity() counts an UNMET-goal agent as WORKING, not reclaimable — the paired absence", () => {
    // Changes exactly one term against the test above (metAt removed), so the split is proven to be
    // caused by the goal being met rather than by liveness, kind, or row count.
    useProjectStore.setState({
      selectedProjectId: "p1",
      projects: [
        {
          id: "p1",
          agents: [
            { id: "w1", kind: "worker", runtime: "local", goal: { text: "ship it", setAt: 1 } },
            { id: "w2", kind: "build", runtime: "local", goal: { text: "ship it", setAt: 1 } },
          ],
        },
      ],
    } as never);
    useRuntimeStore.setState({ status: { w1: "idle", w2: "idle" } });

    const got = buildImproveNudgeDeps().capacity();
    expect(got.activeWorkers).toBe(2);
    expect(got.workingAgents).toBe(2);
    expect(got.reclaimableAgents).toBe(0);
  });

  it("capacity() does NOT call an UNOBSERVED agent finished — an empty runtime store is not proof of idleness", () => {
    // roborev 72653 (High). `useRuntimeStore.status` is live-only and never persisted, so on the
    // first sweep after an app restart EVERY row reads unobserved. Under a `!== false` liveness test
    // every row carrying a persisted `metAt` counted as reclaimable at once, workingAgents collapsed
    // to 0, and the alarm could fire with nobody having stopped. Only a POSITIVE reading counts.
    useProjectStore.setState({
      selectedProjectId: "p1",
      projects: [
        {
          id: "p1",
          agents: [
            { id: "w1", kind: "build", runtime: "local", goal: { text: "x", setAt: 1, metAt: 2 } },
            { id: "w2", kind: "build", runtime: "local", goal: { text: "x", setAt: 1, metAt: 2 } },
          ],
        },
      ],
    } as never);
    useRuntimeStore.setState({ status: {} }); // nothing observed — the post-restart shape
    const got = buildImproveNudgeDeps().capacity();
    expect(got.reclaimableAgents).toBe(0);
    // …and with nothing reclaimable the alarm cannot fire, which is the property that matters.
    expect(got.activeWorkers).toBe(2);
    // Both rows land in the UNOBSERVED bucket, which is separately what gates the alarm.
    expect(got.unobservedAgents).toBe(2);
  });

  it("MIXED FLEET: one dead, one goal-less and one escalated row do NOT count as working — a stray row cannot silence the alarm", () => {
    // roborev 72653 (High). Deriving workingAgents as `used − reclaimable` folded every
    // not-reclaimable row into "working", so ONE unreaped dead row, ONE goal-less agent or ONE
    // expired/escalated goal held the count at >= 1 forever and silenced the alarm — the identical
    // "the arm exists but cannot fire" defect this whole change exists to remove. Every other
    // fleet-idle test uses a uniform all-finished fleet, so this is the one that guards reachability.
    useProjectStore.setState({
      selectedProjectId: "p1",
      projects: [
        {
          id: "p1",
          agents: [
            { id: "f1", kind: "build", runtime: "local", goal: { text: "x", setAt: 1, metAt: 2 } },
            { id: "f2", kind: "build", runtime: "local", goal: { text: "x", setAt: 1, metAt: 2 } },
            // the three stray shapes, none of them working, none of them reclaimable
            { id: "dead", kind: "worker", runtime: "local", goal: { text: "x", setAt: 1, metAt: 2 } },
            { id: "nogoal", kind: "worker", runtime: "local" },
            { id: "esc", kind: "build", runtime: "local", goal: { text: "x", setAt: 1, escalatedAt: 3 } },
          ],
        },
      ],
    } as never);
    useRuntimeStore.setState({
      status: { f1: "idle", f2: "idle", dead: "stopped", nogoal: "idle", esc: "idle" },
    });
    const got = buildImproveNudgeDeps().capacity();
    expect(got.workingAgents).toBe(0); // ← the alarm stays reachable
    expect(got.reclaimableAgents).toBe(2); // only the two genuinely finished rows
    expect(got.activeWorkers).toBe(5); // all five still hold slots
  });

  it("MIXED FLEET, PAIRED: add ONE genuinely working row and workingAgents is no longer 0", () => {
    // The other half of the pair. Without it the test above would pass just as well against a
    // workingAgents that is hardwired to 0 — which would make the alarm fire whenever anything is
    // reclaimable, including on a busy fleet.
    useProjectStore.setState({
      selectedProjectId: "p1",
      projects: [
        {
          id: "p1",
          agents: [
            { id: "f1", kind: "build", runtime: "local", goal: { text: "x", setAt: 1, metAt: 2 } },
            { id: "dead", kind: "worker", runtime: "local", goal: { text: "x", setAt: 1, metAt: 2 } },
            // resting BETWEEN turns, but holding a live mandate — the ordinary working shape
            { id: "live", kind: "build", runtime: "local", goal: { text: "build it", setAt: 1 } },
          ],
        },
      ],
    } as never);
    useRuntimeStore.setState({ status: { f1: "idle", dead: "stopped", live: "idle" } });
    const got = buildImproveNudgeDeps().capacity();
    expect(got.workingAgents).toBe(1);
    expect(got.reclaimableAgents).toBe(1);
  });

  it("capacity() reports UNOBSERVED rows separately — a second, unvisited project is not proof of idleness", () => {
    // roborev 72764 (High). THE SHAPE NO OTHER TEST HERE CAN SEE: every other mixed-fleet case seeds
    // a status entry for every agent. Here project A's tab is open with one finished agent while
    // project B is unvisited and its workers are building. workingAgents is 0 and reclaimableAgents
    // is 1 — which alone would fire the loudest push in the system at a busy machine — so the count
    // that stops it has to exist and has to be non-zero.
    useProjectStore.setState({
      selectedProjectId: "pA",
      projects: [
        {
          id: "pA",
          agents: [
            { id: "fin", kind: "build", runtime: "local", goal: { text: "x", setAt: 1, metAt: 2 } },
          ],
        },
        {
          id: "pB", // never visited in this window → no runtime status entries at all
          agents: [
            { id: "busy1", kind: "worker", runtime: "local", goal: { text: "y", setAt: 1 } },
            { id: "busy2", kind: "worker", runtime: "local", goal: { text: "y", setAt: 1 } },
          ],
        },
      ],
    } as never);
    useRuntimeStore.setState({ status: { fin: "idle" } }); // ONLY project A was observed

    const got = buildImproveNudgeDeps().capacity();
    expect(got.reclaimableAgents).toBe(1);
    expect(got.workingAgents).toBe(0); // ← alone, this would fire the alarm at a busy fleet
    expect(got.unobservedAgents).toBe(2); // ← the term that refuses to make the claim
    expect(got.activeWorkers).toBe(3);
  });

  it("capacity() reports ZERO unobserved when every row was looked at — the paired control", () => {
    useProjectStore.setState({
      selectedProjectId: "pA",
      projects: [
        {
          id: "pA",
          agents: [
            { id: "fin", kind: "build", runtime: "local", goal: { text: "x", setAt: 1, metAt: 2 } },
            { id: "busy", kind: "worker", runtime: "local", goal: { text: "y", setAt: 1 } },
          ],
        },
      ],
    } as never);
    useRuntimeStore.setState({ status: { fin: "idle", busy: "working" } });
    const got = buildImproveNudgeDeps().capacity();
    expect(got.unobservedAgents).toBe(0);
    expect(got.reclaimableAgents).toBe(1);
    expect(got.workingAgents).toBe(1);
  });

  it("capacity() counts a goal-less row as WORKING when its pane says so — the most direct evidence there is", () => {
    useProjectStore.setState({
      selectedProjectId: "p1",
      projects: [{ id: "p1", agents: [{ id: "w1", kind: "worker", runtime: "local" }] }],
    } as never);
    useRuntimeStore.setState({ status: { w1: "working" } });
    expect(buildImproveNudgeDeps().capacity().workingAgents).toBe(1);
  });

  it("capacity() does NOT call a DEAD agent reclaimable — a death is the recovery path's, not the reaper's", () => {
    useProjectStore.setState({
      selectedProjectId: "p1",
      projects: [
        {
          id: "p1",
          agents: [
            { id: "w1", kind: "build", runtime: "local", goal: { text: "x", setAt: 1, metAt: 2 } },
          ],
        },
      ],
    } as never);
    useRuntimeStore.setState({ status: { w1: "stopped" } }); // observed DEAD
    const got = buildImproveNudgeDeps().capacity();
    expect(got.reclaimableAgents).toBe(0);
    // …and it is not WORKING either. It is in neither bucket — the third population the counts must
    // keep separate, because calling a corpse a worker is what silences the alarm (roborev 72653).
    expect(got.workingAgents).toBe(0);
    expect(got.activeWorkers).toBe(1); // it does still hold its slot
  });

  it("capacity() reports zero active workers and full headroom when no local agents exist", () => {
    useProjectStore.setState({ selectedProjectId: null, projects: [] } as never);
    const cap = localAgentCapacity();
    const got = buildImproveNudgeDeps().capacity();
    expect(got.activeWorkers).toBe(0);
    expect(got.freeSlots).toBe(cap.limit);
    expect(got.freeSlots).toBeGreaterThan(0);
  });

  // ── THE UNSTAFFED-EPIC READER (bead sparkle-nu7gd9) — proving the REAL reader reaches beads + roster +
  //    runtime liveness, and reduces "in_progress + has children + no live orchestrator" to a count. A
  //    constant, a wrong store field, or dropping the liveness check would leave this green while inert.
  // A child bead `e1.t1` makes `childrenByParent.has("e1")` true, so `e1` reads BUILDABLE.
  const seedEpicBoard = (beads: Bead[]): void => {
    const board = emptyBoard();
    useBeadsStore.setState({ byProject: { [SPARKLE_PROJECT_ID]: { beads, board, loadedAt: 0 } } });
  };
  const seedSparkleAgents = (agents: unknown[]): void => {
    useProjectStore.setState({
      selectedProjectId: SPARKLE_PROJECT_ID,
      projects: [{ id: SPARKLE_PROJECT_ID, agents }],
    } as never);
  };

  it("counts an in_progress epic that has children but NO bound orchestrator", () => {
    seedEpicBoard([
      bead({ id: "e1", type: "epic", status: "in_progress" }),
      bead({ id: "e1.t1", status: "open" }), // a child → e1 is buildable
    ]);
    seedSparkleAgents([]); // nobody bound to e1
    expect(buildImproveNudgeDeps().unstaffedBuildableEpics()).toEqual({
      unstaffedBuildableEpicCount: 1,
    });
  });

  it("does NOT count it once a LIVE build orchestrator is bound to it (staffed)", () => {
    seedEpicBoard([
      bead({ id: "e1", type: "epic", status: "in_progress" }),
      bead({ id: "e1.t1", status: "open" }),
    ]);
    // A bound build agent with no observed status reads as alive (unknown liveness = conservative alive).
    seedSparkleAgents([{ id: "orch-1", kind: "build", epicId: "e1", runtime: "local" }]);
    useRuntimeStore.setState({ status: {} });
    expect(buildImproveNudgeDeps().unstaffedBuildableEpics()).toEqual({
      unstaffedBuildableEpicCount: 0,
    });
  });

  it("DOES count it when the bound orchestrator is observed DEAD — the binding erased/finished-and-gone case", () => {
    // The founder's actual failure: an epic whose orchestrator finished and went away. A bound agent
    // observed `done` (a DEAD status) must read UNSTAFFED, not staffed by a stale binding.
    seedEpicBoard([
      bead({ id: "e1", type: "epic", status: "in_progress" }),
      bead({ id: "e1.t1", status: "open" }),
    ]);
    seedSparkleAgents([{ id: "orch-1", kind: "build", epicId: "e1", runtime: "local" }]);
    useRuntimeStore.setState({ status: { "orch-1": "done" } }); // observed dead
    expect(buildImproveNudgeDeps().unstaffedBuildableEpics()).toEqual({
      unstaffedBuildableEpicCount: 1,
    });
  });

  // ── DEFECT #2 IS TWO INDEPENDENT AXES, COMPOSED (bead sparkle-nu7gd9). An epic reads STAFFED only if
  //    a bound orchestrator is BOTH alive-on-the-liveness-join AND not-finished. Each axis is pinned by
  //    its own case below AND mutation-proven independent: revert the liveness join and the
  //    unobserved-stale case reds; revert `!agentIsFinished` and the alive-but-finished case reds.

  // ── AXIS A: THE UNOBSERVED-AFTER-RESTART CASE (the orchestratorLiveness join, #2908's join reused).
  //    `runtimeStore.status` is live-only and never persisted, so after a fleet-wide / app-restart
  //    death — no pane left to observe — every bound orchestrator reads `undefined` there.
  //    `undefined !== false` folds to "alive"; the durable `fleet_digest` hook-log witness
  //    (`agentMovement[id].lastEventMs`) is what tells a long-dead orchestrator from a merely-unobserved one.
  const movement = (lastEventMs: number | null) => ({
    lastEvent: "PostToolUse",
    lastEventMs,
    sessionId: "s",
    toolsRecent: 1,
  });

  it("DOES count it when the bound orchestrator is UNOBSERVED and its hook-log witness is STALE (fleet-wide/restart death)", () => {
    seedEpicBoard([
      bead({ id: "e1", type: "epic", status: "in_progress" }),
      bead({ id: "e1.t1", status: "open" }),
    ]);
    seedSparkleAgents([{ id: "orch-1", kind: "build", epicId: "e1", runtime: "local" }]);
    // UNOBSERVED: this window never mounted the pane, so `status` has no entry (undefined liveness). The
    // durable witness's last hook event is 2h ago — older than the 1h silence window ⇒ observed silent.
    useRuntimeStore.setState({
      status: {},
      agentMovement: { "orch-1": movement(Date.now() - 2 * ORCHESTRATOR_SILENT_MS) },
    } as never);
    expect(buildImproveNudgeDeps().unstaffedBuildableEpics()).toEqual({
      unstaffedBuildableEpicCount: 1,
    });
  });

  it("does NOT count it when the bound orchestrator is UNOBSERVED but its hook-log witness is FRESH — pins the witness as the cause", () => {
    // SAME unobserved setup; only the witness's freshness differs. Proves the count flips on the durable
    // hook log, not on "unobserved always counts" — the paired test the guard-trap rule asks for.
    seedEpicBoard([
      bead({ id: "e1", type: "epic", status: "in_progress" }),
      bead({ id: "e1.t1", status: "open" }),
    ]);
    seedSparkleAgents([{ id: "orch-1", kind: "build", epicId: "e1", runtime: "local" }]);
    useRuntimeStore.setState({
      status: {},
      agentMovement: { "orch-1": movement(Date.now()) }, // moved just now ⇒ working
    } as never);
    expect(buildImproveNudgeDeps().unstaffedBuildableEpics()).toEqual({
      unstaffedBuildableEpicCount: 0,
    });
  });

  it("stays conservative (does NOT count) when the orchestrator is UNOBSERVED and there is NO hook-log reading at all", () => {
    // Neither witness has anything to say: no pane observed it, and `fleet_digest` holds no event for it.
    // That is `null` (cannot tell), and an unproven death must not manufacture an alarm — the existing
    // fail-toward-silence contract, preserved. (Distinguishes the fix from "unobserved ⇒ unstaffed".)
    seedEpicBoard([
      bead({ id: "e1", type: "epic", status: "in_progress" }),
      bead({ id: "e1.t1", status: "open" }),
    ]);
    seedSparkleAgents([{ id: "orch-1", kind: "build", epicId: "e1", runtime: "local" }]);
    useRuntimeStore.setState({ status: {}, agentMovement: {} } as never);
    expect(buildImproveNudgeDeps().unstaffedBuildableEpics()).toEqual({
      unstaffedBuildableEpicCount: 0,
    });
  });

  // ── AXIS B: THE ALIVE-BUT-FINISHED CASE (#2909's `!agentIsFinished`).
  it("DOES count it when the bound orchestrator is ALIVE but FINISHED — the silence bug (bead sparkle-nu7gd9)", () => {
    // ⚠️ THE CASE THAT MADE THE THREE-ALARM FIRE SILENT. This orchestrator is not dead: its process is
    // up and its pane reads `idle`. Under a pure liveness predicate it read STAFFED, so on the night
    // this was fixed all ~30 finished orchestrators read as staffed, the count was 0, and the alarm
    // said nothing while ZERO work was being done against 2148 ready beads. A finished orchestrator
    // leaves an epic exactly as unstaffed as a dead one.
    seedEpicBoard([
      bead({ id: "e1", type: "epic", status: "in_progress" }),
      bead({ id: "e1.t1", status: "open" }),
    ]);
    seedSparkleAgents([
      {
        id: "orch-1",
        kind: "build",
        epicId: "e1",
        runtime: "local",
        goal: { text: "build e1", setAt: 1, metAt: 2 },
      },
    ]);
    useRuntimeStore.setState({ status: { "orch-1": "idle" } }); // ALIVE, and done
    expect(buildImproveNudgeDeps().unstaffedBuildableEpics()).toEqual({
      unstaffedBuildableEpicCount: 1,
    });
  });

  it("PAIRED: the same alive orchestrator with an UNMET goal reads STAFFED", () => {
    // One term apart from the test above — `metAt` removed. Proves the count is caused by the goal
    // being met, not by the status, the binding, or the board shape.
    seedEpicBoard([
      bead({ id: "e1", type: "epic", status: "in_progress" }),
      bead({ id: "e1.t1", status: "open" }),
    ]);
    seedSparkleAgents([
      {
        id: "orch-1",
        kind: "build",
        epicId: "e1",
        runtime: "local",
        goal: { text: "build e1", setAt: 1 },
      },
    ]);
    useRuntimeStore.setState({ status: { "orch-1": "idle" } });
    expect(buildImproveNudgeDeps().unstaffedBuildableEpics()).toEqual({
      unstaffedBuildableEpicCount: 0,
    });
  });

  // ── THE COMPOSITION ITSELF: an axis-A death cannot be masked by an unmet goal (which is all
  //    `!agentIsFinished` alone would see). UNOBSERVED + stale witness + an explicitly UNMET goal ⇒
  //    UNSTAFFED. Under #2909-alone (`processAliveFor(...) !== false && !agentIsFinished`) this reads
  //    STAFFED — `undefined !== false` is true and an unmet goal is not finished — so the assertion
  //    REDS if the liveness-join half is dropped, the mutation proof that axis A is load-bearing here.
  it("COMPOSITION: UNOBSERVED + stale witness ⇒ unstaffed even though the goal is UNMET (not finished)", () => {
    seedEpicBoard([
      bead({ id: "e1", type: "epic", status: "in_progress" }),
      bead({ id: "e1.t1", status: "open" }),
    ]);
    seedSparkleAgents([
      {
        id: "orch-1",
        kind: "build",
        epicId: "e1",
        runtime: "local",
        goal: { text: "build e1", setAt: 1 }, // UNMET ⇒ !agentIsFinished is TRUE (would read staffed)
      },
    ]);
    useRuntimeStore.setState({
      status: {}, // UNOBSERVED
      agentMovement: { "orch-1": movement(Date.now() - 2 * ORCHESTRATOR_SILENT_MS) }, // stale ⇒ dead
    } as never);
    expect(buildImproveNudgeDeps().unstaffedBuildableEpics()).toEqual({
      unstaffedBuildableEpicCount: 1,
    });
  });

  it("does NOT count a childless (un-decomposed) in_progress epic — not buildable work", () => {
    seedEpicBoard([bead({ id: "e2", type: "epic", status: "in_progress" })]); // no children
    seedSparkleAgents([]);
    expect(buildImproveNudgeDeps().unstaffedBuildableEpics()).toEqual({
      unstaffedBuildableEpicCount: 0,
    });
  });

  it("does NOT count a CLOSED epic with children — its own status is not in_progress", () => {
    seedEpicBoard([
      bead({ id: "e3", type: "epic", status: "closed" }),
      bead({ id: "e3.t1", status: "closed" }),
    ]);
    seedSparkleAgents([]);
    expect(buildImproveNudgeDeps().unstaffedBuildableEpics()).toEqual({
      unstaffedBuildableEpicCount: 0,
    });
  });

  it("returns NULL — not zero — when the sparkle board is unpolled (bead sparkle-hrzitj)", () => {
    // 0 here is not a neutral default: it is the positive assertion "every buildable epic is
    // staffed", which is the one claim an unread board cannot make. That assertion is what silenced
    // the unstaffed-epic alarm — the LOUDEST push there is — on a machine with 25 open epics.
    expect(buildImproveNudgeDeps().unstaffedBuildableEpics()).toEqual({
      unstaffedBuildableEpicCount: null,
    });
  });
});
