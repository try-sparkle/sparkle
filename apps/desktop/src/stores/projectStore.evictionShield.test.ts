import { beforeEach, describe, expect, it } from "vitest";
import {
  useProjectStore,
  mergePreservingLiveWorkers,
  flushProjectsPersist,
  type ProjectState,
} from "./projectStore";
import type { AgentTab, Project } from "../types";

// sparkle-pckz: what makes an agent disappear, and what is allowed to delete one.
//
// HISTORY — this file used to pin a different mechanism. The original fix answered "which absences
// from a snapshot are real deletions?" with three narrow shield clauses (a worker with a cut
// worktree, a not-yet-acknowledged local add, and an agent created after the snapshot was written).
// Each clause was added reactively after a new way of losing an agent showed up in the field, and
// the third one went inert for any row lacking a `createdAt` — every agent created before that fix.
//
// The union merge replaces the question rather than adding a fourth guess. Absence from a snapshot
// NEVER means deletion; it only ever means "that writer hadn't seen it yet." Deletion travels as an
// explicit tombstone in `removedIds`. That is why the shield-mechanism tests are gone: `persistedAt`
// no longer exists, and `createdAt` is no longer load-bearing for eviction. The BEHAVIOURAL
// requirements they encoded are all still pinned below — an agent must not vanish, and a close must
// still propagate — they are just expressed against the mechanism that now enforces them.
//
// The failure directions are deliberately asymmetric. A missed tombstone leaves a closed row on
// screen and the user closes it again. A wrong eviction makes a LIVE agent with work on disk vanish
// from the roster. The union prefers the first, which is the recoverable one.

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

/** A store state carrying one project, plus any removal tombstones. */
const state = (project: Project, removedIds?: Record<string, number>): ProjectState =>
  ({ projects: [project], ...(removedIds == null ? {} : { removedIds }) }) as unknown as ProjectState;

const ids = (s: ProjectState) => s.projects[0]!.agents.map((a) => a.id);

/** No LOCAL removals pending. Under the union this is the third positional argument — on the old
 *  shield signature it was the fourth, behind a `pendingAdds` set the union no longer needs. */
const NO_REMOVALS = new Set<string>();

describe("mergePreservingLiveWorkers — absence never deletes (sparkle-pckz)", () => {
  it("keeps an agent a concurrent snapshot omits", () => {
    // The core inversion. The other window simply hadn't seen a1 when it wrote; its silence is
    // ignorance, not an instruction. Under the old shields this survived only if a1 happened to
    // match a clause — as a plain acknowledged build agent with no createdAt, it did not.
    const current = state(mkProject({ id: "p1", agents: [mkAgent({ id: "a1" })] }));
    const persisted = state(mkProject({ id: "p1", agents: [] }));
    const merged = mergePreservingLiveWorkers(persisted, current, NO_REMOVALS);
    expect(ids(merged)).toContain("a1");
  });

  it("keeps a legacy agent with no createdAt (the hole the recency clause could not cover)", () => {
    // Pinned as a REGRESSION of the old behaviour, deliberately. The recency clause needed a dated
    // row and fell through to eviction without one, so every agent created before that fix stayed
    // exposed forever. The union has no such carve-out.
    const current = state(mkProject({ id: "p1", agents: [mkAgent({ id: "old1" })] }));
    const persisted = state(mkProject({ id: "p1", agents: [] }));
    const merged = mergePreservingLiveWorkers(persisted, current, NO_REMOVALS);
    expect(ids(merged)).toContain("old1");
  });

  it("keeps think agents too, not just build (any kind can be clobbered)", () => {
    const current = state(
      mkProject({ id: "p1", agents: [mkAgent({ id: "t1", kind: "think" })] }),
    );
    const persisted = state(mkProject({ id: "p1", agents: [] }));
    const merged = mergePreservingLiveWorkers(persisted, current, NO_REMOVALS);
    expect(ids(merged)).toContain("t1");
  });

  it("does not duplicate an agent the snapshot already carries", () => {
    const current = state(mkProject({ id: "p1", agents: [mkAgent({ id: "a1" })] }));
    const persisted = state(mkProject({ id: "p1", agents: [mkAgent({ id: "a1" })] }));
    const merged = mergePreservingLiveWorkers(persisted, current, NO_REMOVALS);
    expect(ids(merged)).toEqual(["a1"]);
  });
});

describe("mergePreservingLiveWorkers — a tombstone is what deletes (sparkle-pckz)", () => {
  it("evicts an agent the incoming snapshot tombstoned (the cross-window close)", () => {
    // The requirement the old "a NEWER snapshot omits it" test was really protecting: closing an
    // agent in window A must remove it from window B. It now travels as a tombstone the other
    // window wrote, rather than being inferred from its absence.
    const current = state(mkProject({ id: "p1", agents: [mkAgent({ id: "a1" })] }));
    const persisted = state(mkProject({ id: "p1", agents: [] }), { a1: 5000 });
    const merged = mergePreservingLiveWorkers(persisted, current, NO_REMOVALS);
    expect(ids(merged)).not.toContain("a1");
  });

  it("does not resurrect an agent removed locally before the tombstone propagated", () => {
    // The local mirror covers the window between "user clicked ×" and "our blob was written."
    const current = state(mkProject({ id: "p1", agents: [mkAgent({ id: "a1" })] }));
    const persisted = state(mkProject({ id: "p1", agents: [mkAgent({ id: "a1" })] }));
    const merged = mergePreservingLiveWorkers(persisted, current, new Set(["a1"]));
    expect(ids(merged)).not.toContain("a1");
  });

  it("unions tombstones from both sides so neither window loses a delete", () => {
    // A closed here, B closed there, neither has seen the other. Both must stay closed.
    const current = state(
      mkProject({ id: "p1", agents: [mkAgent({ id: "a1" }), mkAgent({ id: "b1" })] }),
      { a1: 1000 },
    );
    const persisted = state(
      mkProject({ id: "p1", agents: [mkAgent({ id: "a1" }), mkAgent({ id: "b1" })] }),
      { b1: 2000 },
    );
    const merged = mergePreservingLiveWorkers(persisted, current, NO_REMOVALS);
    expect(ids(merged)).toEqual([]);
  });

  it("a tombstone outlives a snapshot that still carries the agent", () => {
    // The resurrection race: the other window's blob predates the close and still lists a1. The
    // tombstone must win, or the row comes back every time that window writes.
    const current = state(mkProject({ id: "p1", agents: [] }), { a1: 9000 });
    const persisted = state(mkProject({ id: "p1", agents: [mkAgent({ id: "a1" })] }));
    const merged = mergePreservingLiveWorkers(persisted, current, NO_REMOVALS);
    expect(ids(merged)).not.toContain("a1");
  });
});

// The merge is only half the mechanism: under the union a tombstone is the ONLY thing that deletes,
// so it is inert unless removal actually writes one. These pin the producers — the same role
// be21ca79 played for the old timestamps — so a refactor that stops tombstoning fails here rather
// than silently making every close un-propagatable in production.
describe("removal tombstones are actually produced (sparkle-pckz)", () => {
  beforeEach(() => {
    useProjectStore.setState({ projects: [], selectedProjectId: null, removedIds: {} });
    localStorage.clear();
  });

  it("removeAgent tombstones the closed agent", () => {
    const pid = useProjectStore.getState().addProject("P", "/tmp/p");
    const id = useProjectStore.getState().addAgent(pid, { kind: "build" });
    useProjectStore.getState().removeAgent(pid, id);
    expect(useProjectStore.getState().removedIds).toHaveProperty(id);
  });

  it("removeAgent tombstones the closed build agent's workers too", () => {
    // Workers belong to their orchestrator, so closing it closes them — and each needs its own
    // tombstone or the union re-adopts the orphans from any window that still lists them.
    const pid = useProjectStore.getState().addProject("P", "/tmp/p");
    const parent = useProjectStore.getState().addAgent(pid, { kind: "build" });
    useProjectStore.getState().adoptWorker(pid, {
      id: "w1", parentId: parent, branch: "b", worktreePath: "/tmp/wt",
    });
    useProjectStore.getState().removeAgent(pid, parent);
    expect(useProjectStore.getState().removedIds).toHaveProperty("w1");
  });

  it("removeProject tombstones the project AND its agents", () => {
    const pid = useProjectStore.getState().addProject("P", "/tmp/p");
    const id = useProjectStore.getState().addAgent(pid, { kind: "build" });
    useProjectStore.getState().removeProject(pid);
    const removed = useProjectStore.getState().removedIds!;
    expect(removed).toHaveProperty(pid);
    expect(removed).toHaveProperty(id);
  });

  it("tombstones survive the persist round-trip (they must cross windows)", () => {
    // The whole model rests on this: a tombstone kept only in memory would delete the agent in
    // this window and let every other window keep resurrecting it.
    //
    // The write is trailing-debounced by PROJECTS_PERSIST_DEBOUNCE_MS, so flush explicitly rather
    // than sleeping. In the app that flush is driven by crossWindowSync, which wires
    // flushProjectsPersist for exactly this class of structural change; the in-window gap before it
    // lands is covered by the module-scoped local-removal mirror.
    const pid = useProjectStore.getState().addProject("P", "/tmp/p");
    const id = useProjectStore.getState().addAgent(pid, { kind: "build" });
    useProjectStore.getState().removeAgent(pid, id);
    flushProjectsPersist();

    const written = localStorage.getItem(useProjectStore.persist.getOptions().name!);
    expect(written, "the store must have persisted something").toBeTruthy();
    expect(JSON.parse(written!).state.removedIds).toHaveProperty(id);
  });
});
