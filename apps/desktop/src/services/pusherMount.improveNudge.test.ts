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
  useRuntimeStore.setState({ status: {} });
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
      ready: 4,
      p1PipelineHealth: 2,
      p1PipelineHealthFingerprint: "ph-a,ph-z",
      nextReadyBead: { id: "r1", priority: 0, title: "the P0" },
    });
  });

  it("readyBacklog() returns the fail-safe empty reading when the sparkle board is unpolled", () => {
    // The absent-snapshot case: the poll has not populated the store yet. Must read as no-work (rest)
    // with a NULL fingerprint (no red finding to surface), never as a spurious nudge.
    expect(buildImproveNudgeDeps().readyBacklog()).toEqual({
      ready: 0,
      p1PipelineHealth: 0,
      p1PipelineHealthFingerprint: null,
      // No snapshot → no ready column → no code-chosen next item (fail-toward-silence: never invent one).
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

  it("returns the fail-safe zero when the sparkle board is unpolled", () => {
    expect(buildImproveNudgeDeps().unstaffedBuildableEpics()).toEqual({
      unstaffedBuildableEpicCount: 0,
    });
  });
});
