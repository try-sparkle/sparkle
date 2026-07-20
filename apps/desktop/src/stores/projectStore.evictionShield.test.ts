import { beforeEach, describe, expect, it } from "vitest";
import { useProjectStore, mergePreservingLiveWorkers, type ProjectState } from "./projectStore";
import type { AgentTab, Project } from "../types";

// sparkle-pckz: the ACKNOWLEDGE-THEN-CLOBBER gap.
//
// pendingLocalAdds shields a brand-new agent only until the first snapshot carrying it arrives
// (projectStore.ts merge → acknowledgePendingAdds). After that the agent's sole protection is the
// worker-with-worktreePath clause, so a plain build/think agent that has propagated ONCE is fully
// exposed to any LATER stale write that omits it — "the agent shows up, then vanishes a beat later".
//
// The disambiguator is recency: an agent created AFTER a snapshot was written cannot have been
// deliberately removed by that snapshot's writer — the writer simply didn't know about it yet.
// Absence in an OLDER snapshot is not evidence of deletion; absence in a NEWER one is.

function mkAgent(over: Partial<AgentTab> & { id: string }): AgentTab {
  return {
    name: over.id.toUpperCase(), kind: "build", parentId: null, runtime: "local",
    worktreePath: null, branch: null, baseBranch: null, lastPrompt: "",
    promptHistory: [], namePinned: false, autoNameBasis: null,
    autoNameVariants: null, shellCommand: null, pinnedIndex: null,
    ...over,
  };
}

function mkProject(over: Partial<Project> & { id: string }): Project {
  return {
    name: "P", rootPath: "/tmp/p", defaultBranch: null,
    createdAt: new Date(0).toISOString(), selectedAgentId: null,
    freshBuildAgentId: null, agents: [], ...over,
  };
}

const state = (project: Project, persistedAt?: number): ProjectState =>
  ({ projects: [project], ...(persistedAt == null ? {} : { persistedAt }) }) as unknown as ProjectState;

const ids = (s: ProjectState) => s.projects[0]!.agents.map((a) => a.id);

// No pendingAdds in ANY of these: every agent here has already been acknowledged, which is
// precisely the window the old shield left unprotected.
const NO_PENDING = new Set<string>();

describe("mergePreservingLiveWorkers — stale-snapshot eviction shield (sparkle-pckz)", () => {
  it("keeps an acknowledged agent that a snapshot written BEFORE it was created omits", () => {
    const current = state(mkProject({ id: "p1", agents: [mkAgent({ id: "a1", createdAt: 2000 })] }));
    // Concurrent window's blob: written at t=1000, before a1 existed at t=2000. Its omission of a1
    // is ignorance, not deletion.
    const persisted = state(mkProject({ id: "p1", agents: [] }), 1000);
    const merged = mergePreservingLiveWorkers(persisted, current, NO_PENDING);
    expect(ids(merged)).toContain("a1");
  });

  it("still evicts an agent a NEWER snapshot omits (a genuine cross-window removal)", () => {
    const current = state(mkProject({ id: "p1", agents: [mkAgent({ id: "a1", createdAt: 1000 })] }));
    // Written at t=2000, after a1 existed: this writer knew about a1 and dropped it on purpose.
    const persisted = state(mkProject({ id: "p1", agents: [] }), 2000);
    const merged = mergePreservingLiveWorkers(persisted, current, NO_PENDING);
    expect(ids(merged)).not.toContain("a1");
  });

  it("shields think agents too, not just build (any kind can be clobbered)", () => {
    const current = state(
      mkProject({ id: "p1", agents: [mkAgent({ id: "t1", kind: "think", createdAt: 2000 })] }),
    );
    const persisted = state(mkProject({ id: "p1", agents: [] }), 1000);
    const merged = mergePreservingLiveWorkers(persisted, current, NO_PENDING);
    expect(ids(merged)).toContain("t1");
  });

  it("does not resurrect an agent removed locally (tombstone still wins over recency)", () => {
    const current = state(mkProject({ id: "p1", agents: [mkAgent({ id: "a1", createdAt: 2000 })] }));
    const persisted = state(mkProject({ id: "p1", agents: [] }), 1000);
    const merged = mergePreservingLiveWorkers(
      persisted, current, NO_PENDING, new Set(["a1"]),
    );
    expect(ids(merged)).not.toContain("a1");
  });

  it("falls back to the old behaviour for a legacy blob with no persistedAt (no eviction change)", () => {
    // Undated snapshot: recency is unknowable, so the new clause must not fire either way — the
    // agent is evicted exactly as it is on today's main. Guards against a legacy blob silently
    // resurrecting every agent it omits.
    const current = state(mkProject({ id: "p1", agents: [mkAgent({ id: "a1", createdAt: 2000 })] }));
    const persisted = state(mkProject({ id: "p1", agents: [] }));
    const merged = mergePreservingLiveWorkers(persisted, current, NO_PENDING);
    expect(ids(merged)).not.toContain("a1");
  });

  it("leaves a legacy agent with no createdAt on the old behaviour", () => {
    const current = state(mkProject({ id: "p1", agents: [mkAgent({ id: "a1" })] }));
    const persisted = state(mkProject({ id: "p1", agents: [] }), 1000);
    const merged = mergePreservingLiveWorkers(persisted, current, NO_PENDING);
    expect(ids(merged)).not.toContain("a1");
  });

  it("does not duplicate an agent the snapshot already carries", () => {
    const current = state(mkProject({ id: "p1", agents: [mkAgent({ id: "a1", createdAt: 2000 })] }));
    const persisted = state(mkProject({ id: "p1", agents: [mkAgent({ id: "a1", createdAt: 2000 })] }), 1000);
    const merged = mergePreservingLiveWorkers(persisted, current, NO_PENDING);
    expect(ids(merged)).toEqual(["a1"]);
  });

  // The clause-2 / clause-3 boundary, pinned from both sides. Clause (2) protects the
  // not-yet-acknowledged window; clause (3) takes over after acknowledgement. A still-pending agent
  // must survive even a NEWER snapshot (it hasn't propagated yet, so that writer's omission still
  // isn't evidence of removal) — otherwise the two clauses would leave a gap at the handover.
  it("keeps a still-pending agent even when the snapshot is NEWER (clause 2 outranks recency)", () => {
    const current = state(mkProject({ id: "p1", agents: [mkAgent({ id: "a1", createdAt: 1000 })] }));
    const persisted = state(mkProject({ id: "p1", agents: [] }), 2000);
    const merged = mergePreservingLiveWorkers(persisted, current, new Set(["a1"]));
    expect(ids(merged)).toContain("a1");
  });
});

// The merge clause is only half the mechanism: it is inert unless the two timestamps are actually
// written. These pin the producers, so a refactor that drops either stamp fails here rather than
// silently leaving the shield dead in production while every merge test still passes.
describe("eviction shield — the timestamps are actually produced (sparkle-pckz)", () => {
  beforeEach(() => {
    useProjectStore.setState({ projects: [], selectedProjectId: null });
    localStorage.clear();
  });

  it("partialize stamps persistedAt on every write", () => {
    const partialize = useProjectStore.persist.getOptions().partialize;
    expect(partialize).toBeTypeOf("function");
    const before = Date.now();
    const out = partialize!(useProjectStore.getState()) as { persistedAt?: number };
    expect(typeof out.persistedAt).toBe("number");
    expect(out.persistedAt!).toBeGreaterThanOrEqual(before);
  });

  it("partialize passes the rest of the state through (it must not filter fields)", () => {
    const pid = useProjectStore.getState().addProject("P", "/tmp/p");
    const partialize = useProjectStore.persist.getOptions().partialize;
    const out = partialize!(useProjectStore.getState()) as ProjectState;
    expect(out.projects.map((p) => p.id)).toEqual([pid]);
  });

  it("addAgent dates the new row", () => {
    const pid = useProjectStore.getState().addProject("P", "/tmp/p");
    const before = Date.now();
    const id = useProjectStore.getState().addAgent(pid, { kind: "build" });
    const agent = useProjectStore.getState().projects[0]!.agents.find((a) => a.id === id)!;
    expect(typeof agent.createdAt).toBe("number");
    expect(agent.createdAt!).toBeGreaterThanOrEqual(before);
  });

  it("adoptWorker dates the adopted row", () => {
    const pid = useProjectStore.getState().addProject("P", "/tmp/p");
    const parent = useProjectStore.getState().addAgent(pid, { kind: "build" });
    const before = Date.now();
    useProjectStore.getState().adoptWorker(pid, {
      id: "w1", parentId: parent, branch: "b", worktreePath: "/tmp/wt",
    });
    const worker = useProjectStore.getState().projects[0]!.agents.find((a) => a.id === "w1")!;
    expect(typeof worker.createdAt).toBe("number");
    expect(worker.createdAt!).toBeGreaterThanOrEqual(before);
  });
});
