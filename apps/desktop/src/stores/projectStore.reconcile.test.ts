// sparkle-3tqv — the rehydration MERGE must NEVER drop a worker whose worktree is live on disk.
// A cross-window rehydrate replaces in-memory `projects` with the persisted snapshot; if that
// snapshot predates a just-spawned worker (another window persisted last), the default whole-array
// replace would EVICT the live worker. mergePreservingLiveWorkers re-attaches it. These tests drive
// the pure merge directly (the same fn wired as zustand persist's `merge`).
import { describe, it, expect } from "vitest";
import { mergePreservingLiveWorkers } from "./projectStore";
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

// A minimal current state — only `projects` matters for the merge; a stub action proves functions
// survive the merge (the persisted JSON never carries them).
function currentState(projects: Project[]): any {
  return { projects, selectedProjectId: projects[0]?.id ?? null, addProject: () => "x" };
}

describe("mergePreservingLiveWorkers (sparkle-3tqv)", () => {
  it("re-attaches a live worker that the persisted snapshot dropped", () => {
    const build = agent({ id: "b1", kind: "build", branch: "main" });
    const worker = agent({
      id: "w1",
      kind: "worker",
      parentId: "b1",
      worktreePath: "/wt/w1",
      branch: "sparkle/agent-w1",
    });
    const current = currentState([project("p1", [build, worker])]);
    // Persisted snapshot from another window that never saw w1 (last-writer-wins eviction).
    const persisted = { projects: [project("p1", [build])], selectedProjectId: "p1" };

    const merged = mergePreservingLiveWorkers(persisted, current);
    const ids = merged.projects[0]!.agents.map((a) => a.id).sort();
    expect(ids).toEqual(["b1", "w1"]);
    // The action function survives the merge.
    expect(typeof (merged as any).addProject).toBe("function");
  });

  it("does NOT resurrect a worker whose parent build agent is gone from the snapshot", () => {
    const worker = agent({
      id: "w1",
      kind: "worker",
      parentId: "b1",
      worktreePath: "/wt/w1",
    });
    // In memory the worker exists but its build agent b1 does not (orchestrator closed).
    const current = currentState([project("p1", [worker])]);
    const persisted = { projects: [project("p1", [])], selectedProjectId: "p1" };
    const merged = mergePreservingLiveWorkers(persisted, current);
    expect(merged.projects[0]!.agents).toHaveLength(0);
  });

  it("does NOT preserve a worker that has no cut worktree yet (not materialized)", () => {
    const build = agent({ id: "b1", kind: "build", branch: "main" });
    const worker = agent({ id: "w1", kind: "worker", parentId: "b1", worktreePath: null });
    const current = currentState([project("p1", [build, worker])]);
    const persisted = { projects: [project("p1", [build])], selectedProjectId: "p1" };
    const merged = mergePreservingLiveWorkers(persisted, current);
    expect(merged.projects[0]!.agents.map((a) => a.id)).toEqual(["b1"]);
  });

  it("never duplicates a worker already present in the snapshot", () => {
    const build = agent({ id: "b1", kind: "build", branch: "main" });
    const worker = agent({ id: "w1", kind: "worker", parentId: "b1", worktreePath: "/wt/w1" });
    const current = currentState([project("p1", [build, worker])]);
    const persisted = { projects: [project("p1", [build, worker])], selectedProjectId: "p1" };
    const merged = mergePreservingLiveWorkers(persisted, current);
    expect(merged.projects[0]!.agents.map((a) => a.id)).toEqual(["b1", "w1"]);
  });

  it("takes the persisted value for everything else (initial hydration, empty current)", () => {
    const build = agent({ id: "b1", kind: "build", branch: "main" });
    const current = currentState([]); // fresh store, nothing in memory
    const persisted = { projects: [project("p1", [build])], selectedProjectId: "p1" };
    const merged = mergePreservingLiveWorkers(persisted, current);
    expect(merged.projects).toHaveLength(1);
    expect(merged.selectedProjectId).toBe("p1");
  });
});

// A just-clicked "New Build Agent" is added in memory (kind:"build", worktreePath:null) BEFORE it
// is flushed + propagated. A concurrent writer (another window, or a broadcast that predates it)
// can persist a snapshot that lacks it; the default whole-array replace then EVICTS the brand-new
// row — the "clicking New Build Agent doesn't create a row most of the time" report. The worker
// clause can't cover it (no worktree, no parent). The pendingAdds set protects exactly the
// not-yet-acknowledged window, without resurrecting agents that were deliberately removed elsewhere.
describe("mergePreservingLiveWorkers — pending local adds", () => {
  it("preserves a just-created build agent that the persisted snapshot predates", () => {
    const build = agent({ id: "b1", kind: "build", branch: "main" });
    const fresh = agent({ id: "b2", kind: "build", worktreePath: null }); // just clicked, no worktree
    const current = currentState([project("p1", [build, fresh])]);
    // Snapshot from a concurrent writer that never saw b2 (last-writer-wins).
    const persisted = { projects: [project("p1", [build])], selectedProjectId: "p1" };

    const merged = mergePreservingLiveWorkers(persisted, current, new Set(["b2"]));
    expect(merged.projects[0]!.agents.map((a) => a.id).sort()).toEqual(["b1", "b2"]);
  });

  it("does NOT resurrect an agent missing from the snapshot when it is not a pending add", () => {
    // Same shape, but b2 is NOT pending (e.g. it was already acknowledged, then deleted elsewhere).
    const build = agent({ id: "b1", kind: "build", branch: "main" });
    const stale = agent({ id: "b2", kind: "build", worktreePath: null });
    const current = currentState([project("p1", [build, stale])]);
    const persisted = { projects: [project("p1", [build])], selectedProjectId: "p1" };

    const merged = mergePreservingLiveWorkers(persisted, current, new Set());
    expect(merged.projects[0]!.agents.map((a) => a.id)).toEqual(["b1"]);
  });

  it("never duplicates a pending add already present in the snapshot", () => {
    const build = agent({ id: "b1", kind: "build", branch: "main" });
    const fresh = agent({ id: "b2", kind: "build" });
    const current = currentState([project("p1", [build, fresh])]);
    const persisted = { projects: [project("p1", [build, fresh])], selectedProjectId: "p1" };

    const merged = mergePreservingLiveWorkers(persisted, current, new Set(["b2"]));
    expect(merged.projects[0]!.agents.map((a) => a.id)).toEqual(["b1", "b2"]);
  });
});

// The SYMMETRIC hazard to pending adds: a locally-CLOSED agent that a concurrent writer's stale
// snapshot still carries. The user clicks × → removeAgent drops the row here → but another window
// (e.g. the hidden capture webview) broadcasts a snapshot that predates the removal, and the default
// whole-array replace RE-ADDS the just-closed agent — the "× closes the terminal but the row comes
// back" report. A removal tombstone (pendingRemovals) filters the id out of the incoming snapshot
// until the removal has propagated (a snapshot arrives without it).
describe("mergePreservingLiveWorkers — pending local removals (tombstones)", () => {
  it("does NOT resurrect a locally-removed build agent a stale snapshot still carries", () => {
    const keep = agent({ id: "b1", kind: "build", branch: "main" });
    // b2 was just closed: gone from memory, but the stale persisted snapshot still lists it.
    const current = currentState([project("p1", [keep])]);
    const persisted = {
      projects: [project("p1", [keep, agent({ id: "b2", kind: "build" })])],
      selectedProjectId: "p1",
    };

    const merged = mergePreservingLiveWorkers(persisted, current, new Set(), new Set(["b2"]));
    expect(merged.projects[0]!.agents.map((a) => a.id)).toEqual(["b1"]);
  });

  it("also filters a tombstoned worker the stale snapshot carries", () => {
    const build = agent({ id: "b1", kind: "build", branch: "main" });
    const current = currentState([project("p1", [build])]);
    const persisted = {
      projects: [
        project("p1", [
          build,
          agent({ id: "w1", kind: "worker", parentId: "b1", worktreePath: "/wt/w1" }),
        ]),
      ],
      selectedProjectId: "p1",
    };

    const merged = mergePreservingLiveWorkers(persisted, current, new Set(), new Set(["w1"]));
    expect(merged.projects[0]!.agents.map((a) => a.id)).toEqual(["b1"]);
  });

  it("does NOT filter agents that are not tombstoned", () => {
    const build = agent({ id: "b1", kind: "build", branch: "main" });
    const other = agent({ id: "b2", kind: "build" });
    const current = currentState([project("p1", [build, other])]);
    const persisted = { projects: [project("p1", [build, other])], selectedProjectId: "p1" };

    const merged = mergePreservingLiveWorkers(persisted, current, new Set(), new Set(["bX"]));
    expect(merged.projects[0]!.agents.map((a) => a.id)).toEqual(["b1", "b2"]);
  });
});

// Nav-bug fix (Unit A): clicking "New Build Agent" selects the new row in memory, but a cross-window
// rehydrate merges against a stale persisted snapshot that predates the new agent — so `pp` still
// selects the OLD row. The pendingAdds clause keeps the new row, but `selectedAgentId` used to be
// taken verbatim from `pp`, reverting selection to the previously-selected agent ("stays on a
// different row"). The merge must preserve the LIVE selection whenever it still resolves in the
// merged agent set, and only fall back to `pp`'s selection when the live selection is gone.
describe("mergePreservingLiveWorkers — preserves live selectedAgentId", () => {
  it("keeps the freshly-added agent selected when the stale snapshot selects the OLD row", () => {
    const build = agent({ id: "b1", kind: "build", branch: "main" });
    const fresh = agent({ id: "b2", kind: "build", worktreePath: null }); // just clicked "New Build Agent"
    // Live state: the new agent b2 is the selected/active row.
    const cur = currentState([project("p1", [build, fresh])]);
    cur.projects[0].selectedAgentId = "b2";
    // Concurrent writer's snapshot predates b2 and still selects the old row b1.
    const persisted = { projects: [project("p1", [build])], selectedProjectId: "p1" };
    expect(persisted.projects[0]!.selectedAgentId).toBe("b1");

    const merged = mergePreservingLiveWorkers(persisted, cur, new Set(["b2"]));
    expect(merged.projects[0]!.agents.map((a) => a.id).sort()).toEqual(["b1", "b2"]);
    // The new row stays selected — NOT reverted to the stale snapshot's b1.
    expect(merged.projects[0]!.selectedAgentId).toBe("b2");
  });

  it("falls back to the snapshot's selection when the live selection is a dangling id", () => {
    const build = agent({ id: "b1", kind: "build", branch: "main" });
    // Live state selects an agent that no longer exists anywhere (e.g. it was removed).
    const cur = currentState([project("p1", [build])]);
    cur.projects[0].selectedAgentId = "gone";
    const persisted = { projects: [project("p1", [build])], selectedProjectId: "p1" };

    const merged = mergePreservingLiveWorkers(persisted, cur);
    expect(merged.projects[0]!.selectedAgentId).toBe("b1"); // the snapshot's valid selection
  });

  it("preserves an intentional live deselect (null) over the snapshot's stale selection", () => {
    // selectAgent(projectId, null) is a supported deselect, distinct from "no opinion". A cross-window
    // snapshot that still selects a row must NOT re-select it and override the deselected window.
    const build = agent({ id: "b1", kind: "build", branch: "main" });
    const cur = currentState([project("p1", [build])]);
    cur.projects[0].selectedAgentId = null; // user deselected everything
    const persisted = { projects: [project("p1", [build])], selectedProjectId: "p1" };
    expect(persisted.projects[0]!.selectedAgentId).toBe("b1");

    const merged = mergePreservingLiveWorkers(persisted, cur);
    expect(merged.projects[0]!.selectedAgentId).toBeNull();
  });
});

// A manual rename (renameAgent / the sparkle-control rename_agent op) sets namePinned=true and the
// chosen name in memory, but the projects blob is persisted on a trailing 400ms debounce. A rehydrate
// that fires before the write flushes carries the SAME agent still UNPINNED with its old auto-name;
// taking the snapshot verbatim reverted both the name AND namePinned — which then re-opened the agent
// to auto-naming, so the auto-title silently won ("rename_agent returns ok but the row keeps its old
// name"). The merge must preserve a LIVE pinned identity when the incoming snapshot is not itself
// pinned. A repeatedly-written field like `activity` survived this race; a one-shot name write did not.
describe("mergePreservingLiveWorkers — preserves a live pinned name (rename revert)", () => {
  it("keeps the live pinned name/variants over a stale UNPINNED snapshot", () => {
    // In memory: the agent was just renamed — pinned, chosen name, variants cleared (see renameAgent).
    const renamed = agent({
      id: "b1",
      kind: "build",
      name: "Shortcuts & Credit Pill",
      namePinned: true,
      autoNameVariants: null,
    });
    const cur = currentState([project("p1", [renamed])]);
    // Concurrent/pre-flush snapshot: same agent, still the old auto-name, unpinned, with variants.
    const persisted = {
      projects: [
        project("p1", [
          agent({
            id: "b1",
            kind: "build",
            name: "Add keyboard shortcuts and reposition credit pill",
            namePinned: false,
            autoNameVariants: {
              title: "Add keyboard shortcuts and reposition credit pill",
              description: "",
            },
          }),
        ]),
      ],
      selectedProjectId: "p1",
    };

    const merged = mergePreservingLiveWorkers(persisted, cur);
    const b1 = merged.projects[0]!.agents.find((a) => a.id === "b1")!;
    expect(b1.name).toBe("Shortcuts & Credit Pill");
    expect(b1.namePinned).toBe(true);
    expect(b1.autoNameVariants).toBeNull();
  });

  it("keeps a live SELF-NAMED name over a stale non-self-named snapshot (sparkle-pel7)", () => {
    // A self-name (sparkle-control rename_agent) is authoritative but NOT pinned — same trailing-write
    // race as a manual rename, so the merge must shield it too. The preserved copy stays selfNamed and
    // UNpinned (never resurrect namePinned) so the row still shows no pin chip.
    const renamed = agent({
      id: "b1",
      kind: "build",
      name: "Pin Regression Fix",
      namePinned: false,
      selfNamed: true,
      autoNameVariants: null,
    });
    const cur = currentState([project("p1", [renamed])]);
    const persisted = {
      projects: [
        project("p1", [
          agent({
            id: "b1",
            kind: "build",
            name: "Build 1",
            namePinned: false,
            autoNameVariants: { title: "Build 1", description: "" },
          }),
        ]),
      ],
      selectedProjectId: "p1",
    };

    const merged = mergePreservingLiveWorkers(persisted, cur);
    const b1 = merged.projects[0]!.agents.find((a) => a.id === "b1")!;
    expect(b1.name).toBe("Pin Regression Fix");
    expect(b1.selfNamed).toBe(true);
    expect(b1.namePinned).toBe(false);
    expect(b1.autoNameVariants).toBeNull();
  });

  it("a live HUMAN pin beats a stale SELF-NAMED snapshot (self-name never reverts a human pin, sparkle-pel7)", () => {
    // Timeline: agent self-named "Foo" (persisted), then the human pinned "Bar" (in memory, not yet
    // flushed). A rehydrate carries the older self-named snapshot. The human pin MUST win — a self-name
    // is not a deliberate human action and must never revert namePinned.
    const humanPinned = agent({
      id: "b1",
      kind: "build",
      name: "Bar",
      namePinned: true,
      selfNamed: false,
      autoNameVariants: null,
    });
    const cur = currentState([project("p1", [humanPinned])]);
    const persisted = {
      projects: [
        project("p1", [
          agent({ id: "b1", kind: "build", name: "Foo", namePinned: false, selfNamed: true }),
        ]),
      ],
      selectedProjectId: "p1",
    };

    const merged = mergePreservingLiveWorkers(persisted, cur);
    const b1 = merged.projects[0]!.agents.find((a) => a.id === "b1")!;
    expect(b1.name).toBe("Bar");
    expect(b1.namePinned).toBe(true);
  });

  it("takes the snapshot's name when the snapshot is ALSO pinned (a deliberate cross-window rename wins)", () => {
    // Both pinned but different: the persisted one is another window's already-flushed rename — the
    // more recent deliberate choice — so it wins. We only shield the live name from an UNPINNED revert.
    const cur = currentState([
      project("p1", [
        agent({ id: "b1", kind: "build", name: "Local Name", namePinned: true }),
      ]),
    ]);
    const persisted = {
      projects: [
        project("p1", [
          agent({ id: "b1", kind: "build", name: "Other Window Name", namePinned: true }),
        ]),
      ],
      selectedProjectId: "p1",
    };

    const merged = mergePreservingLiveWorkers(persisted, cur);
    expect(merged.projects[0]!.agents[0]!.name).toBe("Other Window Name");
  });

  it("does NOT override an UNPINNED live agent (normal auto-naming still takes the snapshot)", () => {
    // The live agent is auto-nameable (not pinned); the snapshot's fresher auto-title must win as before.
    const cur = currentState([
      project("p1", [agent({ id: "b1", kind: "build", name: "Build 1", namePinned: false })]),
    ]);
    const persisted = {
      projects: [
        project("p1", [
          agent({ id: "b1", kind: "build", name: "Fresh Auto Title", namePinned: false }),
        ]),
      ],
      selectedProjectId: "p1",
    };

    const merged = mergePreservingLiveWorkers(persisted, cur);
    expect(merged.projects[0]!.agents[0]!.name).toBe("Fresh Auto Title");
  });
});

// A just-created PROJECT is added in memory BEFORE its 400ms debounced write flushes/propagates. A
// concurrent window's last-writer-wins snapshot that predates it lacks the project, and the merge
// maps over the INCOMING snapshot's projects — so the brand-new project is dropped entirely
// ("created a new project but it shows nothing / disappears", the hazel-eco report). The
// pendingProjectAdds set shields exactly the not-yet-propagated window, without resurrecting a
// project that was deliberately removed elsewhere. Symmetric to pending local (agent) adds.
describe("mergePreservingLiveWorkers — pending local PROJECT adds", () => {
  const NONE = new Set<string>();
  it("re-attaches a just-created project the persisted snapshot predates", () => {
    const p1 = project("p1", [agent({ id: "b1", kind: "build" })]);
    const p2 = project("p2", [agent({ id: "b2", kind: "build" })]); // just created in this window
    const current = currentState([p1, p2]);
    // Snapshot from a concurrent writer that never saw p2 (last-writer-wins).
    const persisted = { projects: [p1], selectedProjectId: "p1" };
    const merged = mergePreservingLiveWorkers(persisted, current, NONE, NONE, new Set(["p2"]));
    expect(merged.projects.map((p) => p.id).sort()).toEqual(["p1", "p2"]);
  });

  it("keeps the window on the just-created project when it was the live selection", () => {
    const p1 = project("p1", []);
    const p2 = project("p2", []);
    const current = { ...currentState([p1, p2]), selectedProjectId: "p2" };
    const persisted = { projects: [p1], selectedProjectId: "p1" }; // stale: still on p1
    const merged = mergePreservingLiveWorkers(persisted, current, NONE, NONE, new Set(["p2"]));
    expect(merged.projects.map((p) => p.id).sort()).toEqual(["p1", "p2"]);
    // The stale snapshot must not yank the user off the project they just created.
    expect(merged.selectedProjectId).toBe("p2");
  });

  it("does NOT resurrect a project missing from the snapshot when it is not a pending add", () => {
    // p2 removed elsewhere (or already acknowledged) — a stale snapshot lacking it must let it stay gone.
    const p1 = project("p1", []);
    const p2 = project("p2", []);
    const current = currentState([p1, p2]);
    const persisted = { projects: [p1], selectedProjectId: "p1" };
    const merged = mergePreservingLiveWorkers(persisted, current, NONE, NONE, NONE);
    expect(merged.projects.map((p) => p.id)).toEqual(["p1"]);
  });

  it("never duplicates a pending project already present in the snapshot", () => {
    const p1 = project("p1", []);
    const p2 = project("p2", []);
    const current = currentState([p1, p2]);
    const persisted = { projects: [p1, p2], selectedProjectId: "p1" }; // snapshot already carries p2
    const merged = mergePreservingLiveWorkers(persisted, current, NONE, NONE, new Set(["p2"]));
    expect(merged.projects.map((p) => p.id).sort()).toEqual(["p1", "p2"]);
  });
});
