// The STORE WIRING of the release seam — `epicSweepRunner.buildEpicStaffingDeps` and the retraction
// pass, driven against the real project/beads/runtime stores.
//
// ── WHY THIS IS A SEPARATE FILE FROM epicStaffing.test.ts ────────────────────────────────────────
// That file injects every dependency, which is exactly the shape whose production wiring nothing
// covers (bead `sparkle-lgbwf`, seen 4×): delete the line that supplies the real board reader and
// the whole suite stays green while the feature is dead. So these cases pass NO deps and let
// `buildEpicStaffingDeps` resolve them, which is the only way the `undefined`-vs-`[]` board reading
// — the fail-closed hinge of the whole change — is actually exercised.
import { beforeEach, describe, expect, it } from "vitest";
import {
  buildEpicStaffingDeps,
  noteEpicReleaseFromStores,
  reconcileEpicStaffingRecord,
} from "./epicSweepRunner";
import {
  epicStaffingRecords,
  recordEpicStaffing,
  resetEpicStaffingLedger,
  unstaffedEpicsFromReleases,
} from "./epicStaffing";
import type { Bead } from "./beads";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useBeadsStore } from "../stores/beadsStore";

const EPIC_BOARD: Bead[] = [
  { id: "e1", title: "Ship it", description: "", status: "open", type: "epic", labels: [], parent: null, commentCount: 0 },
  { id: "e1.1", title: "one", description: "", status: "open", labels: [], parent: "e1", commentCount: 0 },
  { id: "e1.2", title: "two", description: "", status: "in_progress", labels: [], parent: "e1", commentCount: 0 },
  { id: "e1.3", title: "three", description: "", status: "closed", labels: [], parent: "e1", commentCount: 0 },
];

const DONE_BOARD: Bead[] = [
  { id: "e1", title: "Ship it", description: "", status: "open", type: "epic", labels: [], parent: null, commentCount: 0 },
  { id: "e1.1", title: "one", description: "", status: "closed", labels: [], parent: "e1", commentCount: 0 },
];

function seedBoard(projectId: string, beads: Bead[] | undefined): void {
  useBeadsStore.setState({
    byProject: beads ? ({ [projectId]: { beads, board: { columns: [] } } } as never) : {},
  } as never);
}

/** A project with one build agent bound to `e1`. Returns both ids. */
function seedBoundOrchestrator(): { projectId: string; agentId: string } {
  const store = useProjectStore.getState();
  const projectId = store.addProject("Demo", "/tmp/demo");
  const agentId = store.addAgent(projectId, { kind: "build" })!;
  store.setAgentEpicId(projectId, agentId, "e1");
  return { projectId, agentId };
}

beforeEach(() => {
  resetEpicStaffingLedger();
  useProjectStore.setState({ projects: [], selectedProjectId: null } as never);
  useRuntimeStore.setState({ status: {}, openAgentIds: [], agentMovement: {}, observedAttention: {} } as never);
  useBeadsStore.setState({ byProject: {} } as never);
});

describe("buildEpicStaffingDeps — the production wiring", () => {
  it("resolves the agent, its epic and the board, and records the epic UNSTAFFED", () => {
    const { projectId, agentId } = seedBoundOrchestrator();
    seedBoard(projectId, EPIC_BOARD);

    const out = noteEpicReleaseFromStores(agentId, "goal-met");

    expect(out.kind).toBe("unstaffed");
    expect(unstaffedEpicsFromReleases()).toEqual({
      epicIds: ["e1"],
      couldNotTellEpicIds: [],
      count: 1,
    });
    // The count comes off the REAL board through `openChildCount`: two open, one closed.
    expect(epicStaffingRecords()[0]?.openChildren).toBe(2);
  });

  it("AN UNHYDRATED BOARD READS `undefined`, NOT `[]` — so it surfaces instead of reading as done", () => {
    const { projectId, agentId } = seedBoundOrchestrator();
    // No snapshot for this project: exactly the state before the first poll lands, and the state
    // `improveReadyBacklog`/`improveUnstaffedEpics` were reading as "nothing to do".
    expect(buildEpicStaffingDeps().beadsFor(projectId)).toBeUndefined();

    const out = noteEpicReleaseFromStores(agentId, "retired");

    expect(out.kind).toBe("could-not-tell");
    expect(unstaffedEpicsFromReleases().couldNotTellEpicIds).toEqual(["e1"]);
  });

  it("locate answers for an agent in ANY project, and `undefined` for one in none", () => {
    const { agentId } = seedBoundOrchestrator();
    const deps = buildEpicStaffingDeps();
    expect(deps.locate(agentId)?.agent.id).toBe(agentId);
    expect(deps.locate("no-such-agent")).toBeUndefined();
  });

  it("a torn-down agent can no longer be judged — which is why the seams call BEFORE the teardown", () => {
    const { projectId, agentId } = seedBoundOrchestrator();
    seedBoard(projectId, EPIC_BOARD);
    useProjectStore.setState({ projects: [], selectedProjectId: null } as never);

    expect(noteEpicReleaseFromStores(agentId, "retired")).toEqual({ kind: "not-bound" });
    expect(unstaffedEpicsFromReleases().count).toBe(0);
  });
});

describe("reconcileEpicStaffingRecord — the retraction the sweep performs", () => {
  const seedRecord = (): void =>
    recordEpicStaffing({
      epicId: "e1",
      projectId: "p1",
      state: "unstaffed",
      openChildren: 2,
      releasedAgentId: "a1",
      cause: "goal-met",
      at: 1,
      why: "test",
    });

  it("RETRACTS when an orchestrator is on the epic again", () => {
    seedRecord();
    expect(reconcileEpicStaffingRecord("e1", true, EPIC_BOARD)).toBe(true);
    expect(unstaffedEpicsFromReleases().count).toBe(0);
  });

  it("RETRACTS when no open children remain — the work finished without a successor", () => {
    seedRecord();
    expect(reconcileEpicStaffingRecord("e1", false, DONE_BOARD)).toBe(true);
    expect(unstaffedEpicsFromReleases().count).toBe(0);
  });

  it("KEEPS the record while the epic is unstaffed and still has open children", () => {
    seedRecord();
    expect(reconcileEpicStaffingRecord("e1", false, EPIC_BOARD)).toBe(false);
    expect(unstaffedEpicsFromReleases().count).toBe(1);
  });

  it("KEEPS it when staffing could not be established — `null` is not a successor", () => {
    seedRecord();
    expect(reconcileEpicStaffingRecord("e1", null, EPIC_BOARD)).toBe(false);
    expect(unstaffedEpicsFromReleases().count).toBe(1);
  });

  it("AN UNREADABLE BOARD CANNOT PROVE THE WORK IS DONE, so it retracts nothing", () => {
    seedRecord();
    expect(reconcileEpicStaffingRecord("e1", false, undefined)).toBe(false);
    expect(unstaffedEpicsFromReleases().count).toBe(1);
  });

  it("…but a live orchestrator still retracts on an unreadable board — that arm reads the roster", () => {
    seedRecord();
    expect(reconcileEpicStaffingRecord("e1", true, undefined)).toBe(true);
    expect(unstaffedEpicsFromReleases().count).toBe(0);
  });

  it("says false — and touches nothing — for an epic with no record", () => {
    expect(reconcileEpicStaffingRecord("e-other", true, EPIC_BOARD)).toBe(false);
  });
});
