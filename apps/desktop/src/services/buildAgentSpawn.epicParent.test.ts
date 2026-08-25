// EPIC PARENT LINKING — the fix for sparkle-f2tzxg ("every epic square is gray").
//
// Epic membership is a bead PARENT-CHILD edge and nothing else (`services/beads.ts`), plus the
// display-time `AgentTab.epicId`. Before this fix `spawnBuildAgentInProject` minted every auto-bead
// with parent `""` and never set `epicId`, so an agent spawned to work an epic was a top-level task
// with no edge — `agentsForEpicSlices` returned [] and `epicHealth([])` is 'gray' by definition.
//
// These tests pin the SIDE EFFECTS of spawning AGAINST an epic (not a precondition):
//   1. the minted bead carries the epic id as its PARENT (5th positional arg to createBeadFull), and
//   2. `agentsForEpicSlices` actually RETURNS the spawned agent for that epic — the exact query that
//      was returning [] and painting every square gray.
// A control case pins that a generic spawn (no epic) is UNCHANGED: empty parent, no epic link. Revert
// either half of the fix and tests 1/2 go red (see /mutation-check), so neither is vacuous.
import { describe, it, expect, beforeEach, vi } from "vitest";

const createBeadSpy = vi.fn((..._args: unknown[]): Promise<string> => Promise.resolve("bd-new"));

vi.mock("./agentBrief", () => ({
  attachBrief: () => {},
  clearBrief: () => {},
  briefForLaunch: () => undefined,
  hasUndeliveredBrief: () => false,
  resetAgentBriefs: () => {},
}));
vi.mock("./landInAgent", () => ({ landInAgent: () => {} }));
vi.mock("./tasks", () => ({ createBeadFull: (...a: unknown[]) => createBeadSpy(...a) }));

import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useSettingsStore } from "../stores/settingsStore";
import { spawnBuildAgentInProject } from "./buildAgentSpawn";
import { agentsForEpicSlices } from "./epicLadder";
import type { Project } from "../types";

const EPIC = "sparkle-epic-1";

function project(): Project {
  const id = useProjectStore.getState().addProject("Demo", "/tmp/demo");
  return useProjectStore.getState().projects.find((p) => p.id === id)!;
}

const roster = (projectId: string) =>
  useProjectStore.getState().projects.find((p) => p.id === projectId)?.agents ?? [];
const agentEpicId = (projectId: string, agentId: string) =>
  roster(projectId).find((a) => a.id === agentId)?.epicId;

beforeEach(() => {
  useProjectStore.setState({ projects: [], selectedProjectId: null });
  useRuntimeStore.setState({ branchStatus: {}, workflowStage: {}, openAgentIds: [] });
  useSettingsStore.setState({
    maxConcurrentWorkers: 3,
    effectiveMaxConcurrentWorkers: 3,
    machineMaxConcurrentWorkers: 3,
    concurrencyBound: "cpu",
    concurrencyBasis: "CPU-bound: test",
  });
  createBeadSpy.mockClear();
});

describe("spawnBuildAgentInProject: spawning AGAINST an epic links to it", () => {
  it("mints the auto-bead with the epic id as its PARENT (was `\"\"`, sparkle-f2tzxg)", () => {
    const p = project();

    const id = spawnBuildAgentInProject(p, { epicId: EPIC, prompt: "build the epic" });

    expect(id).toBeTruthy();
    // createBeadFull is called synchronously (its promise is awaited in a `.then` tail); the 5th
    // positional argument is `parent` (services/tasks.ts). This is the durable epic->agent edge.
    expect(createBeadSpy).toHaveBeenCalledTimes(1);
    expect(createBeadSpy.mock.calls[0]![4]).toBe(EPIC);
  });

  it("makes agentsForEpicSlices RETURN the agent for that epic — the query that was going gray", () => {
    const p = project();

    const id = spawnBuildAgentInProject(p, { epicId: EPIC, prompt: "build the epic" })!;

    // The exact call EpicsColumn drives (via useEpicHealthOf). Before the fix the agent carried no
    // epicId and no parent edge, so this returned [] and epicHealth([]) painted the square gray.
    // An empty beads snapshot is deliberate: the agent's own `epicId` edge alone must suffice to
    // keep it as the epic's orchestrator, which is what shows the pill before any bead resolves.
    const kept = agentsForEpicSlices(roster(p.id), [], EPIC);
    expect(kept.map((a) => a.id)).toContain(id);
  });

  it("also sets AgentTab.epicId synchronously, for the sidebar pill before the bead binds", () => {
    const p = project();

    const id = spawnBuildAgentInProject(p, { epicId: EPIC, prompt: "build the epic" })!;

    expect(agentEpicId(p.id, id)).toBe(EPIC);
  });
});

describe("spawnBuildAgentInProject: a generic spawn (no epic) is unchanged", () => {
  it("stays a top-level task — empty parent, no epic link, absent from any epic's slices", () => {
    const p = project();

    const id = spawnBuildAgentInProject(p, { prompt: "unrelated work" })!;

    expect(createBeadSpy.mock.calls[0]![4]).toBe(""); // top-level, exactly as before
    expect(agentEpicId(p.id, id)).toBeUndefined();
    expect(agentsForEpicSlices(roster(p.id), [], EPIC).map((a) => a.id)).not.toContain(id);
  });
});
