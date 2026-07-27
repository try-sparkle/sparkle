// @vitest-environment jsdom
//
// Closing a project tab, against the real stores. The contract this pins, in one line: closing is a
// VIEW operation — the tab goes, the project, its agents and its worktrees stay — and the selection
// lands somewhere sensible afterwards.
import { beforeEach, describe, expect, it } from "vitest";
import { closeProjectTab, closedProjects, markProjectOpen } from "./projectTabs";
import { useProjectStore } from "../stores/projectStore";
import { useUiStore } from "../stores/uiStore";
import type { AgentTab, Project } from "../types";

function mkAgent(id: string): AgentTab {
  return {
    id, name: id, kind: "build", parentId: null, runtime: "local",
    worktreePath: `/wt/${id}`, branch: null, baseBranch: null, lastPrompt: "",
    promptHistory: [], namePinned: false, autoNameBasis: null,
    autoNameVariants: null, shellCommand: null,
  };
}
function mkProject(id: string, agents: AgentTab[] = [], lastOpenedAt?: string): Project {
  return {
    id, name: id.toUpperCase(), rootPath: `/tmp/${id}`, defaultBranch: null,
    createdAt: new Date(0).toISOString(), lastOpenedAt, selectedAgentId: null, agents,
  };
}

const openIds = () => useUiStore.getState().openProjectIds;
const selected = () => useProjectStore.getState().selectedProjectId;
const projectIds = () => useProjectStore.getState().projects.map((p) => p.id);

beforeEach(() => {
  useProjectStore.setState({
    projects: [mkProject("p1"), mkProject("p2"), mkProject("p3")],
    selectedProjectId: "p1",
  } as never);
  useUiStore.setState({ openProjectIds: null, pinnedProjectId: null } as never);
});

describe("markProjectOpen", () => {
  it("writes NOTHING when the project is already open", () => {
    // Load-bearing: this runs on every tab click. Seeding the set here would freeze it to whatever
    // projects existed at that instant, so a project arriving later would render no tab — and it
    // would churn the persisted UI blob on every click for a change that didn't happen.
    markProjectOpen("p2");
    expect(openIds()).toBeNull();
  });

  it("reopens a closed project", () => {
    useUiStore.setState({ openProjectIds: ["p1"] } as never);
    markProjectOpen("p3");
    expect(openIds()).toEqual(["p1", "p3"]);
  });

  it("is idempotent", () => {
    useUiStore.setState({ openProjectIds: ["p1"] } as never);
    markProjectOpen("p3");
    markProjectOpen("p3");
    expect(openIds()).toEqual(["p1", "p3"]);
  });
});

describe("closeProjectTab", () => {
  it("removes the tab WITHOUT deleting the project or its agents", () => {
    useProjectStore.setState({
      projects: [mkProject("p1", [mkAgent("a1"), mkAgent("a2")]), mkProject("p2")],
      selectedProjectId: "p2",
    } as never);
    closeProjectTab("p1");
    expect(openIds()).toEqual(["p2"]);
    // The project record is untouched — this is a close, not the destructive removeProject.
    const p1 = useProjectStore.getState().projects.find((p) => p.id === "p1");
    expect(p1).toBeTruthy();
    expect(p1!.agents.map((a) => a.id)).toEqual(["a1", "a2"]);
    expect(p1!.agents.map((a) => a.worktreePath)).toEqual(["/wt/a1", "/wt/a2"]);
  });

  it("does not tombstone the project — a tombstone would make the close permanent", () => {
    // projectStore's union merge drops exactly what `removedIds` names. If closing wrote one, the
    // project could never come back, and a cross-webview merge would evict it outright.
    closeProjectTab("p1");
    expect(useProjectStore.getState().removedIds ?? {}).toEqual({});
  });

  it("seeds the open set from the FULL project list, so closing one closes only one", () => {
    expect(openIds()).toBeNull(); // never seeded — every project is open
    closeProjectTab("p2");
    expect(openIds()).toEqual(["p1", "p3"]);
    expect(projectIds()).toEqual(["p1", "p2", "p3"]); // nothing left the store
  });

  it("leaves the selection alone when an UNSELECTED tab is closed", () => {
    closeProjectTab("p3");
    expect(selected()).toBe("p1");
  });

  it("selects the tab to the RIGHT when the selected tab is closed", () => {
    useProjectStore.setState({ selectedProjectId: "p2" } as never);
    closeProjectTab("p2");
    expect(selected()).toBe("p3");
  });

  it("falls back to the LEFT neighbour when the selected LAST tab is closed", () => {
    useProjectStore.setState({ selectedProjectId: "p3" } as never);
    closeProjectTab("p3");
    expect(selected()).toBe("p2");
  });

  it("closing the last remaining tab leaves no selection (the welcome state)", () => {
    useUiStore.setState({ openProjectIds: ["p2"] } as never);
    useProjectStore.setState({ selectedProjectId: "p2" } as never);
    closeProjectTab("p2");
    expect(openIds()).toEqual([]);
    expect(selected()).toBeNull();
    // …and all three projects are still there, so every one of them is reopenable.
    expect(projectIds()).toEqual(["p1", "p2", "p3"]);
    expect(closedProjects(useProjectStore.getState().projects, openIds()).map((p) => p.id).sort())
      .toEqual(["p1", "p2", "p3"]);
  });

  it("does not bump the neighbour's recency — moving off a closed tab is housekeeping", () => {
    // selectProject stamps lastOpenedAt (it drives "most recently used"); a forced move must not
    // claim the user opened that project.
    useProjectStore.setState({
      projects: [mkProject("p1", [], "2020-01-01T00:00:00.000Z"), mkProject("p2", [], "2020-01-02T00:00:00.000Z")],
      selectedProjectId: "p1",
    } as never);
    closeProjectTab("p1");
    expect(selected()).toBe("p2");
    expect(useProjectStore.getState().projects.find((p) => p.id === "p2")!.lastOpenedAt).toBe(
      "2020-01-02T00:00:00.000Z",
    );
  });

  it("clears the concierge pin when the pinned project's tab is closed", () => {
    // The pin scopes the concierge's surfaced P0/P1 and is persisted. With no tab there is no
    // affordance to clear it, so a dangling pin would silently zero the vitals.
    useUiStore.setState({ pinnedProjectId: "p2" } as never);
    closeProjectTab("p2");
    expect(useUiStore.getState().pinnedProjectId).toBeNull();
  });

  it("leaves a pin that names a DIFFERENT project alone", () => {
    useUiStore.setState({ pinnedProjectId: "p1" } as never);
    closeProjectTab("p2");
    expect(useUiStore.getState().pinnedProjectId).toBe("p1");
  });

  it("is a no-op for a project that has no tab", () => {
    useUiStore.setState({ openProjectIds: ["p1"] } as never);
    closeProjectTab("p3");
    expect(openIds()).toEqual(["p1"]);
    expect(selected()).toBe("p1");
  });
});

describe("closedProjects", () => {
  it("lists the tabless projects most-recently-opened first", () => {
    const projects = [
      mkProject("old", [], "2020-01-01T00:00:00.000Z"),
      mkProject("recent", [], "2024-06-01T00:00:00.000Z"),
      mkProject("mid", [], "2022-03-01T00:00:00.000Z"),
    ];
    expect(closedProjects(projects, []).map((p) => p.id)).toEqual(["recent", "mid", "old"]);
  });

  it("tolerates a project that has never been opened", () => {
    const projects = [mkProject("never"), mkProject("seen", [], "2024-06-01T00:00:00.000Z")];
    expect(closedProjects(projects, []).map((p) => p.id)).toEqual(["seen", "never"]);
  });

  it("is empty while nothing has been closed", () => {
    expect(closedProjects(useProjectStore.getState().projects, null)).toEqual([]);
  });
});
