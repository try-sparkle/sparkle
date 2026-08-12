// @vitest-environment jsdom
//
// PREVIEW MODE SURVIVES A SELECTED AGENT — the effect half of the `reconcileWorkMode` fix.
//
// `engine/workMode.test.ts` pins the PURE answer: `reconcileWorkMode(true, "preview", false)` is
// null. That is necessary and it is not sufficient, and the gap is the reason this file exists.
// The pure test proves the helper is right; it cannot prove the SIDEBAR calls it with the widened
// value, that the widened value reaches the same store key the effect writes back to, or that no
// other effect in that column undoes it. Those are exactly the seams where a "green pure test,
// dead feature" outcome lives.
//
// What would have to break for this to go red: restore the `mode === "plan"` guard in
// `engine/workMode.ts` and this file fails on the first assertion with "build" — because the
// sidebar's reconcile effect runs on mount with a real selection and writes it. That is the whole
// defect: with an agent selected, which is the ONLY way anyone reaches Preview, the column left the
// mode on the frame it entered.
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}));
vi.mock("./LogoWaveform", () => ({ LogoWaveform: () => null }));
vi.mock("./HistorySearch", () => ({ HistorySearch: () => null }));
vi.mock("../services/openProjectTab", () => ({ openProjectTab: vi.fn() }));
vi.mock("../hooks/useSpawnBuildAgent", () => ({ useSpawnBuildAgent: () => vi.fn(() => "spawned") }));

import { AgentSidebar } from "./AgentSidebar";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useUiStore } from "../stores/uiStore";
import type { AgentTab, Project } from "../types";

function mkAgent(id: string): AgentTab {
  return {
    id, name: `Agent ${id}`, kind: "build", parentId: null, runtime: "local",
    worktreePath: null, branch: null, baseBranch: null, lastPrompt: "",
    promptHistory: [], namePinned: true, autoNameBasis: null,
    autoNameVariants: null, shellCommand: null,
  };
}
/** A project with its agent ACTUALLY SELECTED — the state the defect needs. A null selection makes
 *  `reconcileWorkMode` bail on `hasSelection` and the test passes either way. */
function mkProject(id: string): Project {
  return {
    id, name: `Project ${id}`, rootPath: `/tmp/${id}`, defaultBranch: null,
    createdAt: new Date(0).toISOString(), selectedAgentId: `${id}-a1`, agents: [mkAgent(`${id}-a1`)],
  };
}

const modes = () => useUiStore.getState().workModeBySide;

beforeEach(() => {
  useProjectStore.setState({
    projects: [mkProject("p1"), mkProject("p2")],
    selectedProjectId: "p1",
  } as never);
  useRuntimeStore.setState({ branchStatus: {}, status: {} } as never);
  useUiStore.setState({
    workModeBySide: { left: "build", right: "build" },
    pairAssignment: { p2: "left" },
    leftProjectId: "p2",
    collapsedOrchestrators: {},
    activeSpecial: null,
  } as never);
  useSettingsStore.setState({ beadsEnabled: true } as never);
});
afterEach(cleanup);

describe("a column in Preview mode stays there", () => {
  it("does not reconcile itself back to Build when an agent is selected", () => {
    useUiStore.setState({ workModeBySide: { left: "build", right: "preview" } } as never);
    const right = useProjectStore.getState().projects.find((p) => p.id === "p1")!;

    // Mount with the selection already in place — the "restored on boot" path.
    render(<AgentSidebar project={right} slotSide="right" />);
    expect(modes().right).toBe("preview");
  });

  it("stays in Preview when the mode is entered while an agent is already selected", () => {
    const right = useProjectStore.getState().projects.find((p) => p.id === "p1")!;
    const { rerender } = render(<AgentSidebar project={right} slotSide="right" />);
    expect(modes().right).toBe("build");

    // The live path: the hover-card action / toggle segment calls the store's paired write while
    // the column is mounted and showing a selected row. The effect re-runs on the mode change, so
    // this is the frame the old code overwrote.
    act(() => useUiStore.getState().openPreview("right"));
    rerender(<AgentSidebar project={right} slotSide="right" />);
    expect(modes().right).toBe("preview");
  });

  // Per-column, like every other mode write on this surface: one pair in Preview must not drag the
  // other out of whatever it was doing.
  it("leaves the other column's mode alone", () => {
    useUiStore.setState({ workModeBySide: { left: "plan", right: "build" } } as never);
    const right = useProjectStore.getState().projects.find((p) => p.id === "p1")!;
    render(<AgentSidebar project={right} slotSide="right" />);

    act(() => useUiStore.getState().openPreview("right"));
    expect(modes().right).toBe("preview");
    expect(modes().left).toBe("plan");
  });

  // The paired write, same contract as `openPlanBoard`: entering the mode in the pane-owning column
  // must also drop the Improve-Sparkle pane, or the mode moves while the stage keeps showing the
  // Sparkle terminal and `reconcileWorkMode` (a special is up) never recovers it.
  it("drops the Improve-Sparkle pane when opened in the column that owns it", () => {
    useUiStore.setState({ activeSpecial: "sparkle" } as never);
    act(() => useUiStore.getState().openPreview("right"));
    expect(modes().right).toBe("preview");
    expect(useUiStore.getState().activeSpecial).toBeNull();
  });

  it("leaves the Improve-Sparkle pane alone when opened in the OTHER column", () => {
    useUiStore.setState({ activeSpecial: "sparkle" } as never);
    act(() => useUiStore.getState().openPreview("left"));
    expect(modes().left).toBe("preview");
    expect(useUiStore.getState().activeSpecial).toBe("sparkle");
  });
});
