// EPIC LINKAGE AT SPAWN — bead sparkle-f2tzxg.
//
// `spawnBuildAgentInProject` used to mint its auto-bead with `parent: ""`, unconditionally. Epic
// membership in this app is the bead parent-child edge and `AgentTab.epicId` and NOTHING else, so
// that one empty string made every agent started here invisible to `epicLadder.agentsForEpicSlices`
// — which makes `engine/epicHealth` answer `gray` BY DEFINITION and the ladder rung `unstaffed`.
// "Every epic square is gray" and "zero epics are in Build: Active" were one symptom of it.
//
// ── WHY THESE TESTS ASSERT THROUGH `agentsForEpicSlices` RATHER THAN ON THE MOCK'S ARGUMENTS ──────
// Asserting `createBeadFull` was called with the epic id proves the argument moved; it does NOT
// prove the resulting graph is one the epic column can read. Those are different claims, and the
// second is the one the bug was about — a bead created with the right parent is still useless if the
// agent row is not in the list the health rule is fed. So each test drives the REAL spawn entry
// point, reads the REAL agent row back out of the REAL projectStore, builds the bead snapshot from
// exactly the arguments the spawn handed `bd`, and asks the REAL membership query whether the epic
// is staffed. Nothing here re-derives epic membership (scripts/lib/epic-membership-guard.sh) —
// `agentsForEpicSlices` is composed, not copied.
import { describe, it, expect, beforeEach, vi } from "vitest";

/** Every `createBeadFull` call, positionally, so the `parent` argument can be read back. */
let beadCalls: unknown[][] = [];
let nextBeadId = "bd-auto-1";

vi.mock("./agentBrief", () => ({
  attachBrief: () => {},
  clearBrief: () => {},
  briefForLaunch: () => undefined,
  hasUndeliveredBrief: () => false,
  resetAgentBriefs: () => {},
}));
vi.mock("./landInAgent", () => ({ landInAgent: () => {} }));
vi.mock("./tasks", () => ({
  createBeadFull: async (...a: unknown[]) => {
    beadCalls.push(a);
    return nextBeadId;
  },
}));

import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useSettingsStore } from "../stores/settingsStore";
import { resetVisitedProjects } from "./sessionProjects";
import { spawnBuildAgentInProject } from "./buildAgentSpawn";
import { agentsForEpicSlices } from "./epicLadder";
import type { Bead } from "./beads";
import type { AgentTab, Project } from "../types";

const EPIC_ID = "sparkle-epic1";

function project(): Project {
  const id = useProjectStore.getState().addProject("Demo", "/tmp/demo");
  return useProjectStore.getState().projects.find((p) => p.id === id)!;
}

function agentRow(projectId: string, agentId: string): AgentTab {
  const row = useProjectStore
    .getState()
    .projects.find((p) => p.id === projectId)
    ?.agents.find((a) => a.id === agentId);
  if (!row) throw new Error(`no agent row ${agentId}`);
  return row;
}

/** The 5th positional argument of `createBeadFull` — `parent` (services/tasks.GenerateDeps). */
function parentOfLastBead(): unknown {
  const last = beadCalls.at(-1);
  if (!last) throw new Error("createBeadFull was never called");
  return last[4];
}

/**
 * The bead snapshot the Plan board would poll, built from what the spawn actually told `bd`.
 *
 * Deliberately derived from `beadCalls` rather than hand-written: a fixture that hardcodes
 * `parent: EPIC_ID` would go on passing after the production line stopped sending it, which is the
 * vacuous shape this repo's contract calls its #1 finding.
 */
function beadsAsBdWouldReturn(): Bead[] {
  const epic: Bead = {
    id: EPIC_ID,
    title: "The epic",
    description: "",
    status: "open",
    type: "epic",
    labels: [],
  };
  const minted: Bead[] = beadCalls.map((call, i) => ({
    id: i === beadCalls.length - 1 ? nextBeadId : `bd-auto-${i}`,
    title: String(call[1]),
    description: String(call[2]),
    status: "open",
    type: String(call[3]),
    labels: String(call[6]).split(",").filter(Boolean),
    // `parent` carries EXACTLY what the spawn passed — `""` included, normalized to absent the way
    // bd itself reports a parentless bead.
    ...((call[4] as string) ? { parent: call[4] as string } : {}),
  }));
  return [epic, ...minted];
}

beforeEach(() => {
  useProjectStore.setState({ projects: [], selectedProjectId: null });
  useRuntimeStore.setState({ branchStatus: {}, workflowStage: {}, openAgentIds: [] });
  useSettingsStore.setState({
    maxConcurrentWorkers: 3,
    effectiveMaxConcurrentWorkers: 3,
    machineMaxConcurrentWorkers: 3,
    concurrencyBound: "cpu",
    concurrencyBasis: "CPU-bound: 18 cores × 2 agents per core",
  });
  resetVisitedProjects();
  beadCalls = [];
  nextBeadId = "bd-auto-1";
});

describe("spawnBuildAgentInProject: an agent spawned AGAINST AN EPIC is linked to it", () => {
  it("mints its auto-bead with the epic as PARENT and stamps the row's epicId", async () => {
    const p = project();

    const id = spawnBuildAgentInProject(p, { epicId: EPIC_ID });

    expect(id).not.toBeNull();
    // The row half: readable immediately, before `bd` has answered. This is what the sidebar epic
    // pill and `epicLadder.epicIdForAgent` read.
    expect(agentRow(p.id, id!).epicId).toBe(EPIC_ID);
    // The bead half: the durable edge, and the one that outlives the tab. `createBeadFull` is
    // fire-and-forget inside the spawn, so let its microtask land before reading the calls.
    await vi.waitFor(() => expect(beadCalls.length).toBe(1));
    expect(parentOfLastBead()).toBe(EPIC_ID);
  });

  it("…so the epic is STAFFED — agentsForEpicSlices returns that agent for it", async () => {
    // THE SIDE EFFECT THE BUG WAS ABOUT. `engine/epicHealth` is fed exactly this list; `[]` is
    // `gray`/`unstaffed` by definition, which is why an assertion on the argument alone would not
    // have caught the defect that shipped.
    const p = project();

    const id = spawnBuildAgentInProject(p, { epicId: EPIC_ID });
    await vi.waitFor(() => expect(beadCalls.length).toBe(1));
    // Bind the minted bead the way the spawn's own `.then` does, so the roster under test is the
    // one the board would actually hold.
    useProjectStore.getState().setAgentBeadId(p.id, id!, nextBeadId);

    const roster = useProjectStore.getState().projects.find((x) => x.id === p.id)!.agents;
    const staffing = agentsForEpicSlices(roster, beadsAsBdWouldReturn(), EPIC_ID);

    expect(staffing.map((a) => a.id)).toContain(id!);
  });
});

describe("spawnBuildAgentInProject: NO epic context is a normal, supported state", () => {
  it("mints a PARENTLESS bead and leaves epicId unset — exactly as before", async () => {
    // THE PAIRED TEST. One test proving linkage is ambiguous on its own: a spawn that stamped every
    // agent with some epic would pass it. This pins that the epic is written only when the caller
    // supplied one, so "+ New Build Agent" keeps producing a standalone agent.
    const p = project();

    const id = spawnBuildAgentInProject(p);

    expect(id).not.toBeNull();
    expect(agentRow(p.id, id!).epicId).toBeUndefined();
    await vi.waitFor(() => expect(beadCalls.length).toBe(1));
    expect(parentOfLastBead()).toBe("");
  });

  it("and that agent staffs NO epic — the parentless bead is not a member of one", async () => {
    const p = project();

    const id = spawnBuildAgentInProject(p);
    await vi.waitFor(() => expect(beadCalls.length).toBe(1));
    useProjectStore.getState().setAgentBeadId(p.id, id!, nextBeadId);

    const roster = useProjectStore.getState().projects.find((x) => x.id === p.id)!.agents;

    expect(agentsForEpicSlices(roster, beadsAsBdWouldReturn(), EPIC_ID)).toEqual([]);
  });
});
