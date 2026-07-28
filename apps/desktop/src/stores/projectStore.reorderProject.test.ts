import { beforeEach, describe, expect, it, vi } from "vitest";

// projectStore's module graph reaches Tauri; the reorder surface under test is pure array work, so
// a stub invoke keeps the import side-effect-free.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { useProjectStore } from "./projectStore";
import { useUiStore } from "./uiStore";
import { openProjectsOf } from "../engine/openProjects";
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
    // `null` = the set was never seeded, so every project is open and the strip IS the full array.
    // Set explicitly rather than relying on the default, so these cases don't depend on test order.
    useUiStore.setState({ openProjectIds: null });
  });

  it("moves a tab leftward into the target's slot", () => {
    useProjectStore.getState().reorderProject("c", "a");
    expect(ids()).toEqual(["c", "a", "b"]);
  });

  // DIRECTION: `beforeProjectId` is tabDrag.ts's midpoint-derived insertion gap, NOT the tab the
  // pointer is over, so insert-before is the whole contract and there is no direction bump. These
  // two cases pin the pair that a bump would break — they are adjacent pointer ranges in the same
  // rightward drag, and a bump collapses the first into the second.
  it("does NOT move when the anchor is the tab immediately to the right", () => {
    // The pointer has left `a`'s own midpoint but not yet passed `b`'s, so the strip must sit
    // still. Carrying reorderAgent's `from < targetAt → at + 1` over produced ["b","a","c"] here —
    // a swap a full half-tab early, and the reason every rightward drop landed one slot too far.
    useProjectStore.getState().reorderProject("a", "b");
    expect(ids()).toEqual(["a", "b", "c"]);
  });

  it("swaps with the right-hand neighbour once the pointer passes ITS midpoint", () => {
    // One gap further right: anchor is now `c`, so `a` takes the slot between b and c.
    useProjectStore.getState().reorderProject("a", "c");
    expect(ids()).toEqual(["b", "a", "c"]);
  });

  it("keeps the SAME array reference when the anchor resolves to the tab's own slot", () => {
    // The no-op above must not re-render the shell either. `at === from` is the general form of the
    // dropped-on-itself guard: any anchor that puts the tab back where it started is a no-op.
    const before = useProjectStore.getState().projects;
    useProjectStore.getState().reorderProject("a", "b");
    expect(useProjectStore.getState().projects).toBe(before);
    // Same for a tab already at the end being appended.
    useProjectStore.getState().reorderProject("c", null);
    expect(useProjectStore.getState().projects).toBe(before);
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

// The load-bearing assumption of the whole tear-off feature is "tab order IS `projects` order" —
// but the strip renders openProjectsOf(projects, openIds), a FILTERED subset. So every
// `beforeProjectId` a drag produces is an OPEN tab id, while reorderProject splices the FULL array
// with closed projects interleaved. Nothing pinned that seam: a future change that clamped the
// insertion index against a RENDERED index would silently reorder against hidden entries and no
// test would fail. These are written in terms of the strip the user sees, not the raw array.
describe("projectStore — reorderProject with closed projects interleaved", () => {
  // The store resolves the strip from uiStore.openProjectIds itself (rather than taking it as an
  // argument) so no caller can forget to pass it — which means these cases have to seed it.
  beforeEach(() => {
    useUiStore.setState({ openProjectIds: ["b", "c"] });
  });

  const strip = (openIds: string[]) =>
    openProjectsOf(useProjectStore.getState().projects, openIds).map((p) => p.id);

  it("reorders the visible strip when a closed project leads the array", () => {
    useProjectStore.setState({
      projects: [mkProject({ id: "hidden" }), mkProject({ id: "b" }), mkProject({ id: "c" })],
    });
    useProjectStore.getState().reorderProject("c", "b");
    expect(strip(["b", "c"])).toEqual(["c", "b"]);
    // The closed project keeps its place; only the two open tabs moved relative to each other.
    expect(ids()).toEqual(["hidden", "c", "b"]);
  });

  it("appends past a TRAILING closed project rather than stopping in front of it", () => {
    // The beforeProjectId == null path. `b` must reach the end of the STRIP; that it also lands
    // after `hidden` in the raw array is fine — invisible entries have no strip position.
    useProjectStore.setState({
      projects: [mkProject({ id: "b" }), mkProject({ id: "c" }), mkProject({ id: "hidden" })],
    });
    useProjectStore.getState().reorderProject("b", null);
    expect(strip(["b", "c"])).toEqual(["c", "b"]);
    expect(ids()).toEqual(["c", "hidden", "b"]);
  });

  it("reorders across a closed project sitting BETWEEN the two open tabs", () => {
    // The case an index clamped against the rendered strip would get wrong: the raw gap between
    // `b` and `c` is 2, not 1.
    useProjectStore.setState({
      projects: [mkProject({ id: "b" }), mkProject({ id: "hidden" }), mkProject({ id: "c" })],
    });
    useProjectStore.getState().reorderProject("c", "b");
    expect(strip(["b", "c"])).toEqual(["c", "b"]);
    expect(ids()).toEqual(["c", "b", "hidden"]);
  });

  it("changes NOTHING when the anchor is the next OPEN tab to the right", () => {
    // The case an array-relative `at === from` guard lets through, and the reason the no-op test is
    // strip-relative. Dropping `b` before `c` with a closed project between them computes at=1,
    // from=0 — array indices say "this moved" — while the strip is visibly identical.
    useProjectStore.setState({
      projects: [mkProject({ id: "b" }), mkProject({ id: "hidden" }), mkProject({ id: "c" })],
    });
    const before = useProjectStore.getState().projects;
    useProjectStore.getState().reorderProject("b", "c");

    expect(strip(["b", "c"])).toEqual(["b", "c"]);
    // Reference identity, not just equal contents: a drag that moved nothing must not re-render the
    // shell. Asserting only strip equality is what let the array-relative guard pass green.
    expect(useProjectStore.getState().projects).toBe(before);
    // And the CLOSED project must not have been silently dragged across `b`. Closed order is
    // user-visible later — closedProjectsOf feeds the "+" reopen list, so a reshuffle here means
    // reopening `hidden` puts its tab on the wrong side of `b`.
    expect(ids()).toEqual(["b", "hidden", "c"]);
  });
});
