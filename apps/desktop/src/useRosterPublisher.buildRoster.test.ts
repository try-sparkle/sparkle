import { describe, it, expect, beforeEach } from "vitest";
import { buildRoster, windowProjects } from "./useRosterPublisher";
import { setWindowProject, resetWindowRegistry } from "./services/windowRegistry";
import type { Project } from "./types";

const project: Project = {
  id: "p1", name: "Proj", rootPath: "/p", defaultBranch: "main",
  createdAt: "", agents: [
    { id: "a1", name: "Build", kind: "build", parentId: null,
      promptHistory: [], runtime: "local" } as any,
  ],
  selectedAgentId: null,
};

describe("buildRoster", () => {
  it("joins live status into the roster payload", () => {
    const r = buildRoster([project], { a1: "working" }, {}, {});
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(r.projects[0]!.agents[0]!).toMatchObject({
      id: "a1", kind: "build", status: "working", status_color: "#34c759",
    });
  });

  it("defaults unknown status to stopped/grey", () => {
    const r = buildRoster([project], {}, {}, {});
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(r.projects[0]!.agents[0]!.status).toBe("stopped");
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(r.projects[0]!.agents[0]!.status_color).toBe("#8aa0c4");
  });
});

// Regression guard for the window-scoping fix (roborev 19166):
// publishWindowRoster must only receive THIS window's projects — not projects open in other
// windows — otherwise cross-window agents are mis-reported as "stopped" (DEFAULT_STATUS) and
// the last-writer-wins merge in tray.rs corrupts the red/grey/green counts.
describe("window-scoping: only publish this window's projects to the tray", () => {
  const projectA: Project = {
    id: "pA", name: "ProjA", rootPath: "/a", defaultBranch: "main",
    createdAt: "", agents: [
      { id: "aA", name: "Agent A", kind: "build", parentId: null,
        promptHistory: [], runtime: "local" } as any,
    ],
    selectedAgentId: null,
  };
  const projectB: Project = {
    id: "pB", name: "ProjB", rootPath: "/b", defaultBranch: "main",
    createdAt: "", agents: [
      { id: "aB", name: "Agent B", kind: "build", parentId: null,
        promptHistory: [], runtime: "local" } as any,
    ],
    selectedAgentId: null,
  };

  beforeEach(() => {
    resetWindowRegistry();
    setWindowProject("win-A", "pA");
    setWindowProject("win-B", "pB");
  });

  it("windowProjects returns only the given window's projects", () => {
    // windowProjects is the real exported predicate used by the hook — calling it here
    // means a regression in the production filter (e.g. revert to != null) will fail this test.
    const allOpen = [projectA, projectB];
    const mine = windowProjects(allOpen, "win-A");
    expect(mine.map((p) => p.id)).toEqual(["pA"]);

    // buildRoster on the scoped list: only win-A's agent appears, with correct status.
    const r = buildRoster(mine, { aA: "working", aB: "waiting" }, {}, {});
    expect(r.projects).toHaveLength(1);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(r.projects[0]!.agents[0]!).toMatchObject({ id: "aA", status: "working" });
  });

  it("without scoping, the other window's agent would get DEFAULT_STATUS (the bug)", () => {
    // Demonstrates what the bug looked like: win-B builds a roster from all open projects
    // but only has status for its own agents — win-A's agent falls through to stopped/grey.
    const allOpen = [projectA, projectB];
    const r = buildRoster(allOpen, { aB: "waiting" }, {}, {}); // win-B's statuses only
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(r.projects.find((p) => p.id === "pA")!.agents[0]!.status).toBe("stopped"); // corrupted!
    // After scoping via windowProjects: win-B's slice excludes pA entirely.
    const fixed = buildRoster(windowProjects(allOpen, "win-B"), { aB: "waiting" }, {}, {});
    expect(fixed.projects.map((p) => p.id)).toEqual(["pB"]);
  });
});
