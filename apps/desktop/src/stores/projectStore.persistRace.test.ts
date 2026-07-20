// sparkle-pckz / sparkle-8osl — build agents silently disappear from the roster.
//
// The residual cross-window race after the pendingLocalAdds / pendingLocalProjectAdds shields:
// those shields are dropped the moment ANY snapshot carries the id (acknowledgePendingAdds). But
// one snapshot carrying it only proves ONE writer saw it. A DIFFERENT window still holding older
// in-memory state — or holding a pre-serialized value in its 400ms debounce buffer — can write a
// blob that lacks the agent AFTER the shield was dropped. The whole-array replace then evicts a
// live build agent that was never removed. Workers escape this via the worktreePath survivor
// clause; build agents have no such clause, which is exactly why BUILD agents are what vanish.
//
// The structural fix: absence from a snapshot must NEVER mean "delete". Deletion has an explicit
// signal (a tombstone), so the merge unions by id and only drops what is explicitly tombstoned.
import { describe, it, expect, beforeEach } from "vitest";
import { mergePreservingLiveWorkers, useProjectStore } from "./projectStore";
import type { AgentTab, Project } from "../types";

function agent(over: Partial<AgentTab> & { id: string; kind: AgentTab["kind"] }): AgentTab {
  return {
    name: over.id,
    parentId: null,
    runtime: "local",
    worktreePath: null,
    branch: null,
    baseBranch: null,
    lastPrompt: "",
    promptHistory: [],
    namePinned: false,
    autoNameBasis: null,
    autoNameVariants: null,
    shellCommand: null,
    pinnedIndex: null,
    ...over,
  } as AgentTab;
}

function project(id: string, agents: AgentTab[]): Project {
  return {
    id,
    name: id,
    rootPath: `/repo/${id}`,
    defaultBranch: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastOpenedAt: "2026-01-01T00:00:00.000Z",
    agents,
    selectedAgentId: agents[0]?.id ?? null,
  };
}

function currentState(projects: Project[]): any {
  return { projects, selectedProjectId: projects[0]?.id ?? null, addProject: () => "x" };
}

const ids = (s: any, pid = "p1") =>
  (s.projects.find((p: Project) => p.id === pid)?.agents ?? []).map((a: AgentTab) => a.id);

describe("mergePreservingLiveWorkers — acknowledged agents survive a stale snapshot (sparkle-pckz)", () => {
  it("keeps a build agent the incoming snapshot predates, with NO pending-add shield", () => {
    // b1 was created earlier and already acknowledged (propagated once), so it is NOT in
    // pendingAdds any more — the shield that used to protect it is gone. It was never removed.
    const b1 = agent({ id: "b1", kind: "build", branch: "main" });
    const current = currentState([project("p1", [b1])]);
    // Another window writes from state that predates b1 (stale in-memory or stale debounce buffer).
    const persisted = { projects: [project("p1", [])], selectedProjectId: "p1" };

    const merged = mergePreservingLiveWorkers(persisted, current);

    // Absence from a snapshot is NOT evidence of deletion — b1 must survive.
    expect(ids(merged)).toContain("b1");
  });

  it("keeps a project the incoming snapshot predates, with NO pending-add shield", () => {
    // The project-level analog: p2 was acknowledged, so pendingProjectAdds no longer shields it.
    const p1 = project("p1", [agent({ id: "b1", kind: "build" })]);
    const p2 = project("p2", [agent({ id: "b2", kind: "build" })]);
    const current = currentState([p1, p2]);
    const persisted = { projects: [p1], selectedProjectId: "p1" };

    const merged = mergePreservingLiveWorkers(persisted, current);

    expect(merged.projects.map((p: Project) => p.id).sort()).toEqual(["p1", "p2"]);
  });

  it("does not duplicate an agent present in BOTH the snapshot and memory", () => {
    const b1 = agent({ id: "b1", kind: "build" });
    const current = currentState([project("p1", [b1])]);
    const persisted = { projects: [project("p1", [b1])], selectedProjectId: "p1" };

    const merged = mergePreservingLiveWorkers(persisted, current);

    expect(ids(merged)).toEqual(["b1"]);
  });

  it("still adopts an agent the snapshot introduces that memory has not seen", () => {
    // The other direction: another window created b2 — a union must take it, not just keep ours.
    const b1 = agent({ id: "b1", kind: "build" });
    const b2 = agent({ id: "b2", kind: "build" });
    const current = currentState([project("p1", [b1])]);
    const persisted = { projects: [project("p1", [b1, b2])], selectedProjectId: "p1" };

    const merged = mergePreservingLiveWorkers(persisted, current);

    expect(ids(merged).sort()).toEqual(["b1", "b2"]);
  });
});

// Deletion must now travel as an EXPLICIT shared signal, since absence no longer implies it. The
// persisted blob carries `removedIds` (id → removedAt epoch ms); the merge drops exactly those.
// This is what keeps the union from resurrecting genuinely-closed agents in other windows.
describe("mergePreservingLiveWorkers — shared removal tombstones (sparkle-pckz)", () => {
  it("drops a live in-memory agent the incoming snapshot tombstoned (cross-window delete)", () => {
    // Window B closed b2 and published a tombstone. Window A still has b2 in memory.
    const b1 = agent({ id: "b1", kind: "build" });
    const b2 = agent({ id: "b2", kind: "build" });
    const current = currentState([project("p1", [b1, b2])]);
    const persisted = {
      projects: [project("p1", [b1])],
      selectedProjectId: "p1",
      removedIds: { b2: 1_784_000_000_000 },
    };

    const merged = mergePreservingLiveWorkers(persisted, current);

    expect(ids(merged)).toEqual(["b1"]);
  });

  it("drops a live in-memory PROJECT the incoming snapshot tombstoned", () => {
    const p1 = project("p1", []);
    const p2 = project("p2", []);
    const current = currentState([p1, p2]);
    const persisted = {
      projects: [p1],
      selectedProjectId: "p1",
      removedIds: { p2: 1_784_000_000_000 },
    };

    const merged = mergePreservingLiveWorkers(persisted, current);

    expect(merged.projects.map((p: Project) => p.id)).toEqual(["p1"]);
  });

  it("keeps this window's own tombstones when the incoming snapshot predates them", () => {
    // Symmetric direction: WE closed b2; a stale snapshot still carries it. The local tombstone
    // (carried in current.removedIds) must suppress it — the sparkle-close-resurrect guarantee.
    const b1 = agent({ id: "b1", kind: "build" });
    const b2 = agent({ id: "b2", kind: "build" });
    const current = {
      ...currentState([project("p1", [b1])]),
      removedIds: { b2: 1_784_000_000_000 },
    };
    const persisted = { projects: [project("p1", [b1, b2])], selectedProjectId: "p1" };

    const merged = mergePreservingLiveWorkers(persisted, current);

    expect(ids(merged)).toEqual(["b1"]);
    // …and the tombstone survives the merge so it keeps suppressing later stale snapshots.
    expect(merged.removedIds?.b2).toBe(1_784_000_000_000);
  });

  it("unions tombstones from both sides so neither window loses a delete", () => {
    const current = { ...currentState([project("p1", [])]), removedIds: { a: 1 } };
    const persisted = { projects: [project("p1", [])], removedIds: { b: 2 } };

    const merged = mergePreservingLiveWorkers(persisted, current);

    expect(Object.keys(merged.removedIds ?? {}).sort()).toEqual(["a", "b"]);
  });

  it("never evicts a RECENT tombstone, even far past the count cap (roborev)", () => {
    // The eviction hazard the count cap alone created: a tombstone is now the ONLY thing suppressing
    // a stale in-memory copy, so dropping a recent one lets a just-closed agent come back in a
    // window that never converged past it. Recent removals must be retained regardless of count.
    const now = Date.now();
    const many: Record<string, number> = {};
    for (let i = 0; i < 5000; i++) many[`recent${i}`] = now - 1000; // all closed a second ago
    const current = { ...currentState([project("p1", [])]), removedIds: many };
    const persisted = { projects: [project("p1", [])] };

    const kept = mergePreservingLiveWorkers(persisted, current).removedIds ?? {};

    expect(Object.keys(kept).length).toBe(5000);
    expect(kept.recent0).toBeDefined();
  });

  it("does evict tombstones old enough that every window has converged", () => {
    const ancient = Date.now() - 400 * 24 * 60 * 60 * 1000; // >1 year old
    const many: Record<string, number> = {};
    for (let i = 0; i < 600; i++) many[`old${i}`] = ancient + i;
    const current = { ...currentState([project("p1", [])]), removedIds: many };
    const persisted = { projects: [project("p1", [])] };

    const kept = mergePreservingLiveWorkers(persisted, current).removedIds ?? {};

    expect(Object.keys(kept).length).toBeLessThan(600);
    expect(kept.old0).toBeUndefined(); // oldest goes first
  });

  it("bounds the tombstone map, evicting the OLDEST removals first", () => {
    // A long session closes thousands of agents; the map must not grow without limit.
    const many: Record<string, number> = {};
    for (let i = 0; i < 600; i++) many[`old${i}`] = i + 1; // ascending removedAt
    const current = { ...currentState([project("p1", [])]), removedIds: many };
    const persisted = { projects: [project("p1", [])], removedIds: { newest: 10_000 } };

    const merged = mergePreservingLiveWorkers(persisted, current);
    const kept = merged.removedIds ?? {};

    expect(Object.keys(kept).length).toBeLessThanOrEqual(500);
    expect(kept.newest).toBe(10_000); // most recent removal is never evicted
    expect(kept.old0).toBeUndefined(); // oldest removal is the first to go
  });
});

// The merge above is only half the fix: the store must actually RECORD a removal, or the union has
// no delete signal to act on and closed agents come back. These drive the real store actions.
describe("store wiring — removals are recorded as persisted tombstones (sparkle-pckz)", () => {
  beforeEach(() => {
    useProjectStore.setState({ projects: [], selectedProjectId: null, removedIds: {} });
    localStorage.clear();
  });

  it("removeAgent tombstones the agent AND its workers", () => {
    const st = () => useProjectStore.getState();
    const pid = st().addProject("P", "/tmp/p");
    const build = st().addAgent(pid, { kind: "build" });
    const worker = st().addAgent(pid, { kind: "worker", parentId: build });

    st().removeAgent(pid, build);

    // Both the orchestrator and the worker it owns must be tombstoned — a worker left un-tombstoned
    // would be resurrected by any window still holding it.
    expect(st().removedIds?.[build]).toBeTypeOf("number");
    expect(st().removedIds?.[worker]).toBeTypeOf("number");
  });

  it("removeProject tombstones the project AND its agents", () => {
    const st = () => useProjectStore.getState();
    const pid = st().addProject("P", "/tmp/p");
    const build = st().addAgent(pid, { kind: "build" });

    st().removeProject(pid);

    expect(st().removedIds?.[pid]).toBeTypeOf("number");
    expect(st().removedIds?.[build]).toBeTypeOf("number");
  });

  it("a closed agent stays closed when a stale snapshot re-broadcasts it", () => {
    // End-to-end: close an agent, then rehydrate from a window that still carries it.
    const st = () => useProjectStore.getState();
    const pid = st().addProject("P", "/tmp/p");
    const build = st().addAgent(pid, { kind: "build" });
    const snapshotWithIt = JSON.parse(
      JSON.stringify({ projects: st().projects, selectedProjectId: pid }),
    );

    st().removeAgent(pid, build);
    const merged = mergePreservingLiveWorkers(snapshotWithIt, st());

    expect(merged.projects[0]?.agents.map((a) => a.id)).not.toContain(build);
  });
});

// roborev flagged that the live-selection guard now fires for ANY locally-known project the snapshot
// lacks, not just just-created ones. That is intentional (a stale writer must not yank the user off
// a project it hadn't seen), but it means a project removed in ANOTHER window stays selected here
// until its tombstone lands. Lock both halves of that convergence so the transient can't widen.
describe("live-selection convergence when a project is removed in another window", () => {
  it("holds the selection while the snapshot merely LACKS the project (not yet seen)", () => {
    const p1 = project("p1", []);
    const p2 = project("p2", []);
    const current = { ...currentState([p1, p2]), selectedProjectId: "p2" };
    const persisted = { projects: [p1], selectedProjectId: "p1" };

    const merged = mergePreservingLiveWorkers(persisted, current);

    expect(merged.selectedProjectId).toBe("p2");
  });

  it("releases the selection as soon as the removal TOMBSTONE arrives", () => {
    const p1 = project("p1", []);
    const p2 = project("p2", []);
    const current = { ...currentState([p1, p2]), selectedProjectId: "p2" };
    const persisted = { projects: [p1], selectedProjectId: "p1", removedIds: { p2: 1 } };

    const merged = mergePreservingLiveWorkers(persisted, current);

    // p2 is gone, so the window must fall back to the snapshot's selection rather than point at
    // a project that no longer exists.
    expect(merged.projects.map((p: Project) => p.id)).toEqual(["p1"]);
    expect(merged.selectedProjectId).toBe("p1");
  });
});
