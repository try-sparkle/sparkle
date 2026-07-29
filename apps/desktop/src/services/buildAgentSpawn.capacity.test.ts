// BUG 4 of the agent-ceiling audit: the cap was enforced ASYMMETRICALLY. The concierge's
// `spawn_build_agent` refused at capacity, but the human's "+ New Build Agent" button called
// `spawnBuildAgentInProject` directly — which had no gate at all — so a project was observed
// growing 4 → 15 agents while the machine-wide count was ALREADY over the ceiling.
//
// settingsStore's `enforcedWorkerCap` doc states every concurrency gate must read it. These tests
// pin that the shared spawn implementation is itself one of those gates, so no caller can route
// around it by not asking.
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("./tasks", () => ({ createBeadFull: vi.fn(async () => "bd-new") }));

import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useSettingsStore } from "../stores/settingsStore";
import { resetVisitedProjects } from "./sessionProjects";
import { localAgentCapacity } from "./agentCapacity";
import { spawnBuildAgentInProject } from "./buildAgentSpawn";
import type { Project } from "../types";

function project(): Project {
  const id = useProjectStore.getState().addProject("Demo", "/tmp/demo");
  return useProjectStore.getState().projects.find((p) => p.id === id)!;
}

beforeEach(() => {
  useProjectStore.setState({ projects: [], selectedProjectId: null });
  useRuntimeStore.setState({ branchStatus: {}, workflowStage: {}, openAgentIds: [] });
  useSettingsStore.setState({
    maxConcurrentWorkers: 3,
    effectiveMaxConcurrentWorkers: 3,
    // Reset too, now that a test below writes it: `setState` merges, so an unreset field leaks
    // across tests and makes assertions depend on declaration order (roborev 55091).
    machineMaxConcurrentWorkers: 3,
    concurrencyBound: "cpu",
    concurrencyBasis: "CPU-bound: 18 cores × 2 agents per core",
  });
  resetVisitedProjects();
});

describe("spawnBuildAgentInProject — the shared machine-wide gate", () => {
  it("refuses once the machine is at its agent ceiling, and creates nothing", () => {
    const p = project();
    for (let i = 0; i < 3; i++) expect(spawnBuildAgentInProject(p)).toBeTruthy();
    expect(localAgentCapacity().atCapacity).toBe(true);
    const before = useProjectStore.getState().projects[0]!.agents.length;
    // The regression: this used to return a fresh id and push the count past the ceiling.
    expect(spawnBuildAgentInProject(p)).toBeNull();
    expect(useProjectStore.getState().projects[0]!.agents).toHaveLength(before);
  });

  it("counts agents in OTHER projects, so the ceiling is machine-wide and not per-project", () => {
    // The observed shape of the bug: one project climbing while the machine total was already over.
    const a = project();
    const bId = useProjectStore.getState().addProject("Other", "/tmp/other");
    const b = useProjectStore.getState().projects.find((p) => p.id === bId)!;
    for (let i = 0; i < 3; i++) expect(spawnBuildAgentInProject(b)).toBeTruthy();
    // Project A holds ZERO agents, and must still be refused.
    expect(useProjectStore.getState().projects.find((p) => p.id === a.id)!.agents).toHaveLength(0);
    expect(spawnBuildAgentInProject(a)).toBeNull();
  });

  it("binds at the ENFORCED cap — the min of the user's request and the machine's limit", () => {
    // THE SEED BELOW IS A MID-DRAG TRANSIENT, not a steady state (roborev 55068). `{max: 2,
    // effective: 5}` violates `effective <= maxConcurrentWorkers`, which `hydrateFromConfig`
    // enforces unconditionally — it is reachable only in the sub-second window after
    // `setMaxConcurrentWorkers` (settingsStore writes `maxConcurrentWorkers` alone) and before the
    // `config-changed` re-hydrate. It is kept deliberately, because it is the ONLY state that
    // discriminates `enforcedWorkerCap` from `effectiveMaxConcurrentWorkers` and so the only one
    // with mutation sensitivity; the hydrated case is pinned separately below.
    //
    // An earlier comment here called this "the reported situation (pinned 32, machine 36)" — which
    // was doubly wrong: in a hydrated store that situation holds `{32, 32}`, and the cited numbers
    // did not match the values actually seeded two lines down. Presenting a transient as steady
    // state is how the previous round's High got argued into existence.
    useSettingsStore.setState({ maxConcurrentWorkers: 2, effectiveMaxConcurrentWorkers: 5 });
    const p = project();
    expect(localAgentCapacity().limit).toBe(2);
    expect(spawnBuildAgentInProject(p)).toBeTruthy();
    expect(spawnBuildAgentInProject(p)).toBeTruthy();
    expect(spawnBuildAgentInProject(p)).toBeNull();
    // …and the MACHINE budget still binds when it is the tighter number, pin or no pin.
    useProjectStore.setState({ projects: [], selectedProjectId: null });
    useSettingsStore.setState({ maxConcurrentWorkers: 5, effectiveMaxConcurrentWorkers: 2 });
    const q = project();
    expect(localAgentCapacity().limit).toBe(2);
    expect(spawnBuildAgentInProject(q)).toBeTruthy();
    expect(spawnBuildAgentInProject(q)).toBeTruthy();
    expect(spawnBuildAgentInProject(q)).toBeNull();
  });

  // The open bead — whether `[workers].max_concurrent` is per-build-agent or machine-wide — is
  // pinned HERE, as the one assertion where its two candidate answers are DIFFERENT NUMBERS
  // (roborev 55091). An earlier attempt re-seeded `{max: 3, effective: 3}`, which `beforeEach`
  // already sets and which the first test in this file already drives to refusal — so it could not
  // fail independently, and its `machineMaxConcurrentWorkers: 81` was inert because nothing in
  // `localAgentCapacity`/`enforcedWorkerCap` reads that field. Asserting the two readings against
  // each other is what gives it discriminating signal: today the gate follows the PIN, and settling
  // the bead the other way makes `limit` become the machine number, breaking this line on purpose.
  it("today the gate follows the PIN, not the machine — the bead's two answers differ here", () => {
    useSettingsStore.setState({
      maxConcurrentWorkers: 3,
      effectiveMaxConcurrentWorkers: 3, // hydrateFromConfig: min(pin, derived)
      machineMaxConcurrentWorkers: 81, // …while the hardware could carry 81
    });
    const { limit } = localAgentCapacity();
    const machine = useSettingsStore.getState().machineMaxConcurrentWorkers;
    expect(limit).toBe(3);
    // The whole point: the two candidate semantics are 3 and 81, and the gate currently picks 3.
    expect(limit).not.toBe(machine);
  });

  it("still spawns normally below the ceiling — the gate is a cap, not a block", () => {
    const p = project();
    const id = spawnBuildAgentInProject(p);
    expect(id).toBeTruthy();
    expect(useProjectStore.getState().projects[0]!.agents).toHaveLength(1);
    expect(useRuntimeStore.getState().openAgentIds).toContain(id);
  });
});
