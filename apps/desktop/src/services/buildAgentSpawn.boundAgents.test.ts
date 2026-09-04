// THE WRITE SIDE OF THE DARK EPICS COLUMN — bead sparkle-70cu4y.
//
// ── THE TWO STAFFING QUERIES, AND WHY BOTH NEED GUARDING AT THE SPAWN ────────────────────────────
// Two different functions answer "is this epic staffed", and they read different things:
//
//   • `epicLadder.agentsForEpicSlices` — laddering: the agent's `epicId` OR its `beadId` climbing
//     `bead.parent` up to the epic. Either edge satisfies it, so it can answer YES for an agent
//     whose row carries no binding at all, purely on the bead's parent.
//   • `epicSweepRunner.boundAgentsFor` — `kind === "build" && a.epicId === epicId`. THE ROW ALONE.
//     No bead is consulted, so no parent edge can stand in for a missing `epicId`.
//
// `buildAgentSpawn.epicParent.test.ts` covers the first, and — measured, not assumed — it does also
// go red today if `setAgentEpicId` is dropped from the spawn: its `agentsForEpicSlices` call passes
// an EMPTY bead snapshot, so that assertion happens to fall through to the row. That is a real
// guard, but an incidental one: it holds only while the ladder keeps its row-first fallback and only
// while that fixture keeps no beads. It never names `boundAgentsFor`, which is the query the
// STAFFING readings actually run — the sweep's watch gate (`candidateFor`),
// `pusherMount.improveUnstaffedEpics`, and `planView.orchestratorNameForEpic`. This file asserts
// through that one directly, so the row write is pinned by the query whose answer decides whether an
// epic square lights up, rather than by a fixture detail of a different query.
//
// It also covers what nothing else did: an epic id that arrives PRESENT BUT BLANK. See the third
// block — that half is new behaviour, and both of its mutations are recorded at the bottom.
//
// ── AND WHAT THESE ASSERT IS THE EFFECT, NOT THE PRECONDITION ────────────────────────────────────
// `expect(row.epicId).toBe(EPIC)` is a precondition: it proves a field moved, not that the lookup
// the column performs can find the agent. So every test below drives the REAL
// `spawnBuildAgentInProject`, reads the REAL roster back out of the REAL `projectStore`, and asks
// the REAL `boundAgentsFor` — the composed query, never a re-derived copy of it.
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
import { log } from "../logger";
import { markProjectVisited, resetVisitedProjects } from "./sessionProjects";
import { spawnBuildAgentInProject } from "./buildAgentSpawn";
import { boundAgentsFor } from "./epicSweepRunner";
import type { Project } from "../types";

const EPIC = "sparkle-epic-1";
const LOST = "epic binding LOST";

function project(): Project {
  const id = useProjectStore.getState().addProject("Demo", "/tmp/demo");
  return useProjectStore.getState().projects.find((p) => p.id === id)!;
}

const roster = (projectId: string) =>
  useProjectStore.getState().projects.find((p) => p.id === projectId)?.agents ?? [];
const rowOf = (projectId: string, agentId: string) =>
  roster(projectId).find((a) => a.id === agentId)!;

/** Every `log.warn` message this spawn emitted, so a test can assert on the ONE line that separates
 *  a lost binding from an absent one without pinning the wording of the rest. */
function warnMessages(spy: ReturnType<typeof vi.spyOn>): string[] {
  return spy.mock.calls.map((c) => String(c[1]));
}

beforeEach(() => {
  vi.restoreAllMocks();
  resetVisitedProjects();
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

// ── THE EFFECT ───────────────────────────────────────────────────────────────────────────────────
describe("a build agent spawned OUTSIDE sendToBuild is found by boundAgentsFor", () => {
  it("returns the agent for the epic it was spawned against", () => {
    const p = project();

    // NOT `sendToBuild`. This is the path the fleet takes — the epic-focused sidebar's "+ New Build
    // Agent", the concierge's `spawn_build_agent`, `applyEpicDrop`'s promote — and the one bead
    // sparkle-70cu4y recorded as carrying no `epicId`, which is why `boundAgentsFor` returned
    // nothing and every epic square sat gray.
    const id = spawnBuildAgentInProject(p, { epicId: EPIC, prompt: "build the epic" })!;

    expect(boundAgentsFor(roster(p.id), EPIC).map((a) => a.id)).toEqual([id]);
  });

  it("does not leak that agent into a DIFFERENT epic's bound set", () => {
    const p = project();

    const id = spawnBuildAgentInProject(p, { epicId: EPIC, prompt: "build the epic" })!;

    // A binding that matched every epic would light the whole column and be just as useless as one
    // that matched none — the read has to be an equality on THIS epic, not a truthiness on the row.
    expect(boundAgentsFor(roster(p.id), "sparkle-epic-2").map((a) => a.id)).not.toContain(id);
  });

  it("still binds when the spawn is a BACKGROUND one — nobody asked, the epic is still staffed", () => {
    const p = project();
    // Background REFUSES a project the human has not looked at this session (it may not write the
    // visited set itself — see `SpawnBuildAgentOpts.background`), so satisfy that precondition the
    // way `Workspace` does. Measured: without it the spawn returns null, and every assertion below
    // would be vacuously true of an agent that was never created.
    markProjectVisited(p.id);

    const id = spawnBuildAgentInProject(p, {
      epicId: EPIC,
      prompt: "sweep restart",
      background: true,
      dispatchedBy: "machine",
    });

    // A machine dispatch drops everything that moves the founder's eyes; it must NOT drop the
    // binding. This is the shape a sweep restarts an epic with, and an unbound restart would leave
    // the sweep re-restarting an epic it had just staffed, forever.
    expect(id).toBeTruthy();
    expect(boundAgentsFor(roster(p.id), EPIC).map((a) => a.id)).toEqual([id]);
  });
});

// ── THE PAIRED CASE: A GENUINELY EPIC-LESS AGENT IS NOT FORCED INTO A BINDING ────────────────────
// One test proving presence is ambiguous — a spawn that stamped EVERY agent with whatever epic was
// last seen would satisfy the block above. These pin the other direction, and the first pins that
// "no epic" is REPRESENTABLE rather than merely unobserved.
describe("a free-standing build agent stays unbound", () => {
  it("is returned for no epic at all, and carries an ABSENT epicId — not an empty one", () => {
    const p = project();

    // The babysit dispatcher's shape, and the plain "+ New Build Agent" button's: no epic exists to
    // name. This is a legitimate state, not a lost binding.
    const id = spawnBuildAgentInProject(p, { prompt: "watch PR #123" })!;

    expect(boundAgentsFor(roster(p.id), EPIC).map((a) => a.id)).not.toContain(id);
    // ABSENT, not `""`. `boundAgentsFor(agents, "")` is an equality like any other, so a row stamped
    // with the empty string is bound to the "" epic rather than to nothing — the collapse of "no
    // epic" into "an epic whose id I do not have" that this bead was filed about.
    expect(rowOf(p.id, id).epicId).toBeUndefined();
    expect(boundAgentsFor(roster(p.id), "").map((a) => a.id)).not.toContain(id);
  });

  it("says nothing about a binding, because none was ever asked for", () => {
    const p = project();
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});

    spawnBuildAgentInProject(p, { prompt: "watch PR #123" });

    // The silence is the point: a warning on every ordinary spawn would bury the one below.
    expect(warnMessages(warn).filter((m) => m.includes(LOST))).toEqual([]);
  });
});

// ── AN ABSENT BINDING AND A LOST ONE ARE DIFFERENT FACTS ────────────────────────────────────────
// A caller that HAD an epic and resolved it to blank is not the same as a caller that never had one,
// and the two used to be indistinguishable in both directions: `""` fell through the truthiness
// guard and looked exactly like the honest spawn above, while a whitespace id was TRUTHY and stamped
// the row with a binding no epic can ever match.
describe("a PRESENT but blank epicId is a LOST binding, never a silent absent one", () => {
  for (const blank of ["", "   ", "\t\n"]) {
    const label = JSON.stringify(blank);

    it(`writes no garbage binding for ${label}`, () => {
      const p = project();
      vi.spyOn(log, "warn").mockImplementation(() => {});

      const id = spawnBuildAgentInProject(p, { epicId: blank, prompt: "build the epic" })!;

      // THE EFFECT: the row is bound to nothing at all — not to the blank string. Before the fix
      // `"   "` reached `setAgentEpicId` unchanged, so the row claimed to staff an epic named "   "
      // while every real epic still read unstaffed.
      expect(rowOf(p.id, id).epicId).toBeUndefined();
      expect(boundAgentsFor(roster(p.id), blank).map((a) => a.id)).not.toContain(id);
      // …and the auto-bead is top-level rather than parented to the blank id (5th positional arg to
      // `createBeadFull`), so the row and the bead cannot disagree about whether an epic was named.
      expect(createBeadSpy.mock.calls[0]![4]).toBe("");
    });

    it(`SAYS a binding was lost for ${label}`, () => {
      const p = project();
      const warn = vi.spyOn(log, "warn").mockImplementation(() => {});

      spawnBuildAgentInProject(p, { epicId: blank, prompt: "build the epic" });

      // This line is the ONLY thing that distinguishes this spawn from the honest epic-less one
      // above — both produce an unbound row, and only one of them is a defect. Without it the epic
      // the caller meant to staff sits dark with nothing anywhere recording that anyone tried.
      expect(warnMessages(warn).filter((m) => m.includes(LOST))).toHaveLength(1);
    });
  }
});

// ── MUTATION EVIDENCE (measured, scripts/mutation-check.sh and by hand) ─────────────────────────
// Every mutation below was applied to `buildAgentSpawn.ts` on disk and this file re-run:
//   • comment out `store.setAgentEpicId(project.id, id, epicBinding)` → CAUGHT
//     (mutation-check.sh --line, "line 345 CAUGHT"). `buildAgentSpawn.epicParent.test.ts` goes red
//     under the same mutation too — 4 of its 8 — so this file is not the only thing holding that
//     line; it is the only thing holding it through `boundAgentsFor`.
//   • `const epicBinding = opts.epicId` (skip the trim) → CAUGHT, 5 red: both `"   "` and `"\t\n"`
//     stamp the row with the whitespace and `boundAgentsFor(blank)` finds it, and the `""` case
//     stops warning because the blank is no longer normalised to `undefined`.
//   • replace the lost-binding guard with `if (false)` → CAUGHT, exactly the 3 `SAYS a binding was
//     lost` arms. The three `writes no garbage binding` arms stay GREEN under it, which is the
//     point: those two facts are separable, and the warning is the only one that tells a lost
//     binding from an absent one.
