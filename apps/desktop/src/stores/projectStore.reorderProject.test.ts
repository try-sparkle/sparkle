import { beforeEach, describe, expect, it, vi } from "vitest";

// projectStore's module graph reaches Tauri; the reorder surface under test is pure array work, so
// a stub invoke keeps the import side-effect-free.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { useProjectStore } from "./projectStore";
import type { Project } from "../types";

// Tab ORDER is projectStore.projects order — engine/openProjects.ts derives the strip from it and
// deliberately does NOT re-derive order from the open set (that would make tabs jump every time one
// was closed and reopened). So dragging a tab has to reorder THIS array.

function mkProject(over: Partial<Project> & { id: string }): Project {
  return {
    name: over.id.toUpperCase(),
    rootPath: `/tmp/${over.id}`,
    defaultBranch: null,
    createdAt: new Date(0).toISOString(),
    selectedAgentId: null,
    freshBuildAgentId: null,
    agents: [],
    ...over,
  };
}

const ids = () => useProjectStore.getState().projects.map((p) => p.id);

describe("projectStore — reorderProject", () => {
  beforeEach(() => {
    useProjectStore.setState({
      projects: [mkProject({ id: "a" }), mkProject({ id: "b" }), mkProject({ id: "c" })],
    });
  });

  it("moves a tab leftward into the target's slot", () => {
    useProjectStore.getState().reorderProject("c", "a");
    expect(ids()).toEqual(["c", "a", "b"]);
  });

  it("lands AFTER the target when dragged rightward onto the adjacent tab", () => {
    // The direction fix, and the whole reason this isn't a bare splice. Dropping onto a tab means
    // "take that tab's slot", so a tab dragged RIGHT lands after it. Inserting before
    // unconditionally makes this exact case — drag a onto its right-hand neighbour — a complete
    // no-op: `a` is removed then re-inserted at index 0, precisely where it started, and the
    // control reads as broken (the bug reorderAgent hit as roborev 53371).
    useProjectStore.getState().reorderProject("a", "b");
    expect(ids()).toEqual(["b", "a", "c"]);
  });

  it("appends when there is no tab to insert before", () => {
    useProjectStore.getState().reorderProject("a", null);
    expect(ids()).toEqual(["b", "c", "a"]);
  });

  it("appends rather than dropping the move when the anchor vanished mid-drag", () => {
    useProjectStore.getState().reorderProject("a", "gone");
    expect(ids()).toEqual(["b", "c", "a"]);
  });

  it("is a no-op for an unknown project, keeping the SAME array reference", () => {
    const before = useProjectStore.getState().projects;
    useProjectStore.getState().reorderProject("nope", "a");
    // Identical reference, not merely equal contents: handing every `projects` consumer a fresh
    // array would re-render the whole shell for a drag that changed nothing.
    expect(useProjectStore.getState().projects).toBe(before);
  });

  it("is a no-op when a tab is dropped on itself, keeping the SAME array reference", () => {
    const before = useProjectStore.getState().projects;
    useProjectStore.getState().reorderProject("b", "b");
    expect(useProjectStore.getState().projects).toBe(before);
  });

  it("leaves the projects themselves untouched — this is a pure reorder", () => {
    const a = useProjectStore.getState().projects.find((p) => p.id === "a");
    useProjectStore.getState().reorderProject("a", null);
    // Same object, not a copy: reorder must not rewrite names, selection, or agent lists.
    expect(useProjectStore.getState().projects.find((p) => p.id === "a")).toBe(a);
  });
});
