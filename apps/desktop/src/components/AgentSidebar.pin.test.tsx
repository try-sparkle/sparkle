// @vitest-environment jsdom
//
// AGENT PINNING, AND ITS REMOVAL. `namePinned` used to mean two things — "don't auto-rename" AND
// "hold this row's position". Row anchoring went first (rows group by workflow stage; order within
// a stage is the human's drag arrangement), which left a pin chip that pinned nothing. The founder
// removed the affordance outright; this file now pins the ABSENCE of the chip and the survival of
// the flag behind it. The ordering assertions that used to live here went with pinnedIndex; the
// property that replaced them — that status never moves a row — is in engine/buildSections.test.ts.
//
// PROJECT-TAB pinning (components/ProjectTabs) is a different, live feature and is not in scope.
// Heavy leaf components + the Tauri opener are mocked so the sidebar renders.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}));
vi.mock("./LogoWaveform", () => ({ LogoWaveform: () => null }));
vi.mock("./StatusBar", () => ({ StatusBar: () => null }));
vi.mock("./HistorySearch", () => ({ HistorySearch: () => null }));

import { AgentSidebar } from "./AgentSidebar";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import type { AgentTab, Project } from "../types";

function mkAgent(id: string, name: string, over: Partial<AgentTab> = {}): AgentTab {
  return {
    id, name, kind: "build", parentId: null, runtime: "local",
    worktreePath: null, branch: null, baseBranch: null, lastPrompt: "",
    promptHistory: [], namePinned: false, autoNameBasis: null,
    autoNameVariants: null, shellCommand: null, ...over,
  };
}

function seed(agents: AgentTab[]): Project {
  const project: Project = {
    id: "p1", name: "Demo", rootPath: "/tmp/demo", defaultBranch: null,
    createdAt: new Date(0).toISOString(), selectedAgentId: null, agents,
  };
  useProjectStore.setState({ projects: [project] } as never);
  return project;
}

beforeEach(() => useRuntimeStore.setState({ status: {} }));
afterEach(() => cleanup());

describe("AgentSidebar — agent pinning is REMOVED", () => {
  it("renaming a top-level agent freezes its name but does NOT anchor its row", () => {
    const project = seed([mkAgent("a1", "Alpha"), mkAgent("a2", "Beta")]);
    render(<AgentSidebar project={project} />);
    fireEvent.doubleClick(screen.getByText("Alpha"));
    const input = screen.getByDisplayValue("Alpha");
    fireEvent.change(input, { target: { value: "Alpha2" } });
    fireEvent.blur(input);
    const a1 = useProjectStore.getState().projects[0]!.agents.find((a) => a.id === "a1")!;
    expect(a1.name).toBe("Alpha2");
    // THE FLAG SURVIVED THE AFFORDANCE, deliberately. It is what stops the auto-namer overwriting
    // a human rename seconds later; deleting it along with the chip would have made every rename
    // temporary. Only the pin UI and the unpin path are gone.
    expect(a1.namePinned).toBe(true);
    // The row did not move: array order is untouched by a rename.
    expect(useProjectStore.getState().projects[0]!.agents.map((a) => a.id)).toEqual(["a1", "a2"]);
  });

  // The chip used to render whenever `namePinned` was set, and clicking it released the freeze.
  // Both are gone: rows no longer reorder, so a pin anchored nothing, and what was left merely
  // restated that the user had renamed the agent — which the name already says.
  //
  // ASSERTED ON A ROW THAT WOULD DEFINITELY HAVE SHOWN IT (`namePinned: true`), so this fails if
  // the chip comes back, rather than passing vacuously on a row that never had one.
  it("renders no pin chip on a build row whose name IS frozen", () => {
    const project = seed([mkAgent("a1", "Alpha", { namePinned: true })]);
    render(<AgentSidebar project={project} />);
    expect(screen.queryByTitle(/^Renamed by you/)).toBeNull();
    expect(screen.queryByTitle(/pin/i)).toBeNull();
  });

  // The freeze is still real even though nothing in the column reports or releases it.
  it("keeps the freeze with no way to release it from the row", () => {
    const project = seed([mkAgent("a1", "Alpha", { namePinned: true })]);
    render(<AgentSidebar project={project} />);
    expect(
      useProjectStore.getState().projects[0]!.agents.find((a) => a.id === "a1")!.namePinned,
    ).toBe(true);
  });
});
