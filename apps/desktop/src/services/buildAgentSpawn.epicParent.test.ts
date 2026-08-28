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
const closeBeadSpy = vi.fn((..._args: unknown[]): Promise<void> => Promise.resolve());

vi.mock("./agentBrief", () => ({
  attachBrief: () => {},
  clearBrief: () => {},
  briefForLaunch: () => undefined,
  hasUndeliveredBrief: () => false,
  resetAgentBriefs: () => {},
}));
vi.mock("./landInAgent", () => ({ landInAgent: () => {} }));
vi.mock("./tasks", () => ({ createBeadFull: (...a: unknown[]) => createBeadSpy(...a) }));
// PARTIALLY mocked, never wholesale: `buildAgentSpawn` also imports `AUTO_LABEL` and
// `isBeadsUnavailable` from here, and a whole-module stub would silently hand the spawn an
// `undefined` label — a passing test over a bead the board could no longer tell from real backlog.
vi.mock("./beads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./beads")>();
  return { ...actual, closeBead: (...a: unknown[]) => closeBeadSpy(...a) };
});

import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useSettingsStore } from "../stores/settingsStore";
import { spawnBuildAgentInProject } from "./buildAgentSpawn";
import { agentsForEpicSlices } from "./epicLadder";
import { epicHealth, rungForEpicHealth } from "../engine/epicHealth";
import type { RollupDot } from "../engine/workerRollup";
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
const agentBeadId = (projectId: string, agentId: string) =>
  roster(projectId).find((a) => a.id === agentId)?.beadId;

/** Let the `.then` tail of a resolved `createBeadFull` run. Two microtask turns, not one: the tail
 *  itself awaits nothing, but the promise it is chained to resolves on the first. */
const flushTail = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

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
  closeBeadSpy.mockClear();
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

// ── THE CLOBBER GUARD ────────────────────────────────────────────────────────────────────────────
// `createBeadFull` is a `bd` shell-out that resolves seconds later, and TWO other writers can bind
// `row.beadId` inside that window: `sendToBuild` (the epic's own human-filed bead) and
// `runtimeStore.syncBeadLifecycle`'s create branch. An unconditional `.then` write replaces a real,
// correctly-parented id with this path's auto-minted one — which is why `runtimeStore.ts`'s own
// reconciler header says *"the only place to arbitrate two writers is the spawn itself"*.
//
// These two arms are a PAIR on purpose (AGENTS.md: one test proving absence is ambiguous). The
// negative arm alone would pass for a spawn that never writes a bead id at all; the positive arm
// runs the IDENTICAL setup minus the competing writer and pins that the write still happens.
describe("spawnBuildAgentInProject: a late auto-bead never clobbers an id already bound", () => {
  /** Hand back the `createBeadFull` resolver, so the test — not the scheduler — decides the
   *  interleaving. Without this the shell-out resolves before anything can race it and the window
   *  the guard exists for is unreachable from a test. */
  function deferredCreate(): (beadId: string) => void {
    let resolve!: (beadId: string) => void;
    createBeadSpy.mockImplementationOnce(
      () => new Promise<string>((r) => { resolve = r; }),
    );
    return (beadId) => resolve(beadId);
  }

  it("keeps the id a competing writer bound, and CLOSES the auto-bead that lost", async () => {
    const p = project();
    const settle = deferredCreate();

    const id = spawnBuildAgentInProject(p, { epicId: EPIC, prompt: "build the epic" })!;
    // The race: another writer binds a REAL, correctly-parented bead while `bd` is still running.
    useProjectStore.getState().setAgentBeadId(p.id, id, "bd-real");

    settle("bd-auto");
    await flushTail();

    // THE SIDE EFFECT, not the precondition: the row still carries the bead the winner bound.
    expect(agentBeadId(p.id, id)).toBe("bd-real");
    // …and our loser is closed rather than left an open, unreferenced CHILD OF THE EPIC, which
    // `engine/epicGoalRollup` would report `stranded` for good.
    expect(closeBeadSpy).toHaveBeenCalledWith("/tmp/demo", "bd-auto");
  });

  it("still writes when the row is EMPTY — the same setup, minus the competing writer", async () => {
    const p = project();
    const settle = deferredCreate();

    const id = spawnBuildAgentInProject(p, { epicId: EPIC, prompt: "build the epic" })!;
    expect(agentBeadId(p.id, id)).toBeUndefined(); // nobody raced us

    settle("bd-auto");
    await flushTail();

    expect(agentBeadId(p.id, id)).toBe("bd-auto");
    expect(closeBeadSpy).not.toHaveBeenCalled();
  });
});

// ── GATE B: THE SQUARE IS THE BUILD ROW'S DISC, NOT A SECOND GATE ────────────────────────────────
// `sparkle-f2tzxg` closed with an OPEN GAP it refused to assume away: "Gate B is a live PTY status
// (runtimeStore.status, live-only, never persisted) […] If the Build column's own discs are also
// gray, fixing linkage alone will NOT turn the squares green." The verdict, with its evidence, is
// PRD/epic-linkage-gate-b.md; this is the assertion that keeps it true.
//
// It is fine, because Gate B is not a second gate. `engine/epicHealth.markOf` is the IDENTITY on the
// agent's rolled-up dot (epicHealth.ts:169-171) and `EpicHealth` is a type ALIAS of `RollupDot`
// (:72) — the founder's colour-parity hard rule, quoted in that file's header. So once linkage holds
// (Gate A), the square is EXACTLY the disc the Build column paints for the same agent, and there is
// no epic-side precondition left that could hold it gray on its own.
//
// PURE ON PURPOSE. No component is mounted and no runtime store is faked: the spawn is real, the
// epic↔agent edge is the real `agentsForEpicSlices`, and the dot is supplied as the parameter it
// genuinely is. What this guards is the one edit that would make Gate B a second gate — an
// epic-only arm in `markOf`, which `epicHealth.ts:165-167` predicts by name ("the next reader
// tempted to add 'a small epic-only exception' has to add it HERE").
describe("spawnBuildAgentInProject: a linked epic's square is its build row's own disc", () => {
  const ALL_DOTS: readonly RollupDot[] = ["red", "orange", "blue", "green", "gray"];

  it("passes every RollupDot straight through — no epic-only re-derivation", () => {
    const p = project();
    const id = spawnBuildAgentInProject(p, { epicId: EPIC, prompt: "build the epic" })!;

    // Gate A holds: linkage puts the agent in the epic's slice list, so `epicHealth` is no longer
    // being handed the `[]` that is gray BY DEFINITION.
    const kept = agentsForEpicSlices(roster(p.id), [], EPIC);
    expect(kept.map((a) => a.id)).toContain(id);

    for (const dot of ALL_DOTS) {
      // The exact shape `hooks/useEpicHealthOf` builds (`dot: dotOf(a.id)`, the Build column's own
      // sanctioned accessor). Only `dot` decides a colour — `status` is read by nothing.
      const readings = kept.map((a) => ({ id: a.id, parentId: a.parentId, dot }));
      expect(epicHealth(readings)).toBe(dot);
    }
  });

  it("so a GREEN build row lands the epic in Build: Active, and only a gray one leaves it unstaffed", () => {
    const p = project();
    const id = spawnBuildAgentInProject(p, { epicId: EPIC, prompt: "build the epic" })!;
    const kept = agentsForEpicSlices(roster(p.id), [], EPIC);
    const readingsWith = (dot: RollupDot) => kept.map((a) => ({ id: a.id, parentId: a.parentId, dot }));

    // THE BEAD'S QUESTION, answered as a value: with linkage fixed, a working build agent DOES turn
    // the square non-gray. Nothing else has to happen.
    expect(epicHealth(readingsWith("green"))).toBe("green");
    expect(rungForEpicHealth(epicHealth(readingsWith("green")))).toBe("inProgress");
    // …and gray stays gray, which is the honest reading of an epic nobody is working on right now —
    // the founder's rule, not a defect of this surface.
    expect(rungForEpicHealth(epicHealth(readingsWith("gray")))).toBe("unstaffed");
    expect(id).toBeTruthy();
  });
});
