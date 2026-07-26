// Project attribution for metered AI spend. The load-bearing property here is what these resolvers
// do when they CAN'T answer: they return undefined so the ledger row carries no project and the
// Credits history shows an honest em-dash. A fallback ("Unknown", the selected project, the first
// project) would make every other row's attribution untrustworthy too.
import { beforeEach, describe, expect, it } from "vitest";
import { useProjectStore } from "../stores/projectStore";
import {
  projectName,
  projectNameForAgent,
  projectNameForPath,
  selectedProjectName,
} from "./creditProject";
import type { AgentTab, Project } from "../types";

const agent = (id: string): AgentTab =>
  ({ id, kind: "build", name: id, promptHistory: [] }) as unknown as AgentTab;

const project = (over: Partial<Project> = {}): Project =>
  ({
    id: "p1",
    name: "Sparkle Desktop",
    rootPath: "/repos/sparkle",
    defaultBranch: "main",
    createdAt: "2026-01-01",
    agents: [agent("a1")],
    selectedAgentId: "a1",
    ...over,
  }) as Project;

beforeEach(() => {
  useProjectStore.setState({
    projects: [
      project(),
      project({ id: "p2", name: "Acme", rootPath: "/repos/acme", agents: [agent("a2")] }),
    ],
    selectedProjectId: "p2",
  });
});

describe("projectName", () => {
  it("resolves a known id to its display name", () => {
    expect(projectName("p1")).toBe("Sparkle Desktop");
  });

  it("is undefined for an unknown, null, or empty id", () => {
    expect(projectName("nope")).toBeUndefined();
    expect(projectName(null)).toBeUndefined();
    expect(projectName(undefined)).toBeUndefined();
    expect(projectName("")).toBeUndefined();
  });

  it("treats a blank name as no name rather than sending an empty string", () => {
    // An empty `project` on the wire would render as a blank cell that LOOKS like a real project.
    useProjectStore.setState({ projects: [project({ name: "   " })] });
    expect(projectName("p1")).toBeUndefined();
  });
});

describe("projectNameForAgent", () => {
  it("resolves an agent to its OWNING project, not the selected one", () => {
    // a1 lives in p1 while p2 is selected — the spend belongs to the agent's project.
    expect(projectNameForAgent("a1")).toBe("Sparkle Desktop");
  });

  it("is undefined for an agent no open project owns", () => {
    expect(projectNameForAgent("ghost")).toBeUndefined();
    expect(projectNameForAgent(null)).toBeUndefined();
  });
});

describe("projectNameForPath", () => {
  it("resolves a project root path to its name", () => {
    expect(projectNameForPath("/repos/acme")).toBe("Acme");
  });

  it("is undefined for a path no open project matches", () => {
    expect(projectNameForPath("/tmp/scratch")).toBeUndefined();
    expect(projectNameForPath(undefined)).toBeUndefined();
  });

  it("still matches across a trailing separator or stray whitespace", () => {
    // Raw `===` made this a SILENT miss: "no project" is a legitimate outcome, so a caller passing
    // a normalized/trailing-slash path just lost its attribution with nothing to notice.
    expect(projectNameForPath("/repos/acme/")).toBe("Acme");
    expect(projectNameForPath("/repos/acme//")).toBe("Acme");
    expect(projectNameForPath("  /repos/acme  ")).toBe("Acme");
  });

  it("normalizes Windows separators the same way on both sides", () => {
    useProjectStore.setState({
      projects: [project({ id: "pw", name: "Winproj", rootPath: "C:\\repos\\acme\\" })],
    });
    expect(projectNameForPath("C:\\repos\\acme")).toBe("Winproj");
    expect(projectNameForPath("C:\\repos\\acme\\")).toBe("Winproj");
    expect(projectNameForPath("C:\\repos\\other")).toBeUndefined();
  });

  it("does not collapse a different project onto a matching prefix", () => {
    // Normalizing must not turn "no project" into a WRONG project — the one outcome the module
    // header forbids outright.
    expect(projectNameForPath("/repos/acme-two")).toBeUndefined();
    expect(projectNameForPath("/repos/acme/sub")).toBeUndefined();
  });
});

describe("selectedProjectName", () => {
  it("resolves the currently selected project", () => {
    expect(selectedProjectName()).toBe("Acme");
  });

  it("is undefined when nothing is selected", () => {
    useProjectStore.setState({ selectedProjectId: null });
    expect(selectedProjectName()).toBeUndefined();
  });

  it("is undefined when the selected id points at a project that is gone", () => {
    useProjectStore.setState({ selectedProjectId: "deleted" });
    expect(selectedProjectName()).toBeUndefined();
  });
});
