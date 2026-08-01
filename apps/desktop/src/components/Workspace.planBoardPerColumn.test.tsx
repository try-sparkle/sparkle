// @vitest-environment jsdom
//
// THE PLAN BOARD BELONGS TO THE COLUMN, NOT TO THE WINDOW.
//
// The bug this pins: the board was a SINGLETON. `uiStore.workMode` and `uiStore.activeSpecial` were
// each one global value, and the board had exactly ONE renderer — hardcoded inside the RIGHT pair.
// The left pair's comment said so outright ("It carries no Sparkle pane, no Plan board"). So the
// left column's Plan chevron was pure PAINT: it wrote a global that only the right pair read. Three
// symptoms, one cause:
//
//   1. Pressing Plan on the LEFT column opened the board on the RIGHT.
//   2. Opening one column's board CLOBBERED the other's, because both read the same global.
//
// This is the same shape as the mount-cable bug: a per-column feature implemented as one global
// with a decorative per-column appearance. The guard against a regression to that shape is the
// third test — two boards open AT ONCE showing DIFFERENT projects. That is unrepresentable in a
// singleton, so it cannot pass by accident.
//
// OWNERSHIP ONLY — NOT GEOMETRY. This file used to carry a third symptom, "the board overlaid the
// whole pair instead of taking the terminal's slot", and an assertion pinning the board inside the
// terminal stage. That was a mistake bundled into an ownership fix: a board confined to one column
// of the pair left the Build column beside it completely blank, which is exactly what the founder
// rejected on 2026-07-31. The board spans the pair again, and how much it covers is now asserted in
// Workspace.planBoardSpansPair.test.tsx. Keep the two questions in the two files.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: () => Promise.resolve(() => {}),
    setTitle: () => Promise.resolve(),
  }),
  getAllWindows: () => Promise.resolve([{}]),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve(null) }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));
vi.mock("../windowContext", async () => {
  const { useProjectStore } = await import("../stores/projectStore");
  return {
    useCurrentProjectId: () => useProjectStore((s) => s.selectedProjectId),
    useIsMainWindow: () => false,
    useCurrentWindowLabel: () => "main",
  };
});
vi.mock("../services/orchestrationListener", () => ({
  startOrchestrationListener: () => Promise.resolve(() => {}),
}));
vi.mock("../services/controlListener", () => ({
  startControlListener: () => Promise.resolve(() => {}),
}));
vi.mock("../services/crossWindowSync", () => ({ subscribeToCrossWindowSync: () => () => {} }));
vi.mock("../services/cloudAgents/startup", () => ({
  reattachProjectOnOpen: async () => [] as string[],
}));
vi.mock("../services/sparkleAgent", async (orig) => ({
  ...(await orig<typeof import("../services/sparkleAgent")>()),
  sparkleAgentIdFor: () => "sparkle",
  sparkleOpenSetWhitelist: () => [],
  shouldWarmSparkleAtLaunch: () => false,
}));
vi.mock("./AgentPane", () => ({
  AgentPane: ({ agent }: { agent: { id: string } }) => <div data-testid={`pane-${agent.id}`} />,
}));
vi.mock("./AgentSidebar", () => ({
  AgentSidebar: ({ slotSide = "right" }: { slotSide?: string }) => (
    <div data-testid={`sidebar-${slotSide}`} data-slot-side={slotSide} />
  ),
  NewBuildAgentButton: () => null,
}));
vi.mock("./ConciergeHost", () => ({ ConciergeHost: () => <div data-testid="concierge" /> }));
vi.mock("./OfflineBanner", () => ({ OfflineBanner: () => null }));
vi.mock("./ZeroCreditBanner", () => ({ ZeroCreditBanner: () => null }));
vi.mock("./SparkleAgentPane", () => ({ SparkleAgentPane: () => null }));
vi.mock("./ProjectModal", () => ({ ProjectModal: () => null }));
vi.mock("./ClosePrompt", () => ({ ClosePrompt: () => null }));
// THE BOARD IS IDENTIFIED BY ITS PROJECT. A stub rendering one fixed testid could not tell "the
// left board opened" from "the right board moved", which is precisely the confusion under test.
vi.mock("./BoardView", () => ({
  BoardView: ({ project }: { project: { id: string } }) => (
    <div data-testid={`board-${project.id}`} />
  ),
}));
vi.mock("./Concierge/KebabMenu", () => ({ ConciergeTopRight: () => null }));
vi.mock("./OpenPrMenu", () => ({ OpenPrMenu: () => null, agentLinkForBranch: () => null }));
vi.mock("./NewProjectDialog", () => ({ NewProjectDialog: () => null }));
vi.mock("./StatusStrip", () => ({ StatusStrip: () => null }));
vi.mock("./NewCloudAgentDialog", () => ({ NewCloudAgentDialog: () => null }));

import { Workspace } from "./Workspace";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useAuthStore } from "../stores/authStore";
import { useConnectionStore } from "../stores/connectionStore";
import { markProjectVisited, resetVisitedProjects } from "../services/sessionProjects";
import { resetCable } from "../stores/cableStore";
import type { AgentTab, Project } from "../types";

function mkAgent(id: string): AgentTab {
  return {
    id, name: id, kind: "build", parentId: null, runtime: "local",
    worktreePath: null, branch: null, baseBranch: null, lastPrompt: "",
    promptHistory: [], namePinned: false, autoNameBasis: null,
    autoNameVariants: null, shellCommand: null,
  };
}
function mkProject(id: string, name: string, agents: AgentTab[], selectedAgentId: string): Project {
  return {
    id, name, rootPath: `/tmp/${id}`, defaultBranch: null,
    createdAt: new Date(0).toISOString(), selectedAgentId, agents,
  };
}

// TWO PAIRS, TWO PROJECTS: p1 on the right (the primary pair), p2 on the left.
beforeEach(() => {
  useProjectStore.setState({
    projects: [
      mkProject("p1", "Alpha", [mkAgent("a1")], "a1"),
      mkProject("p2", "Beta", [mkAgent("a2")], "a2"),
    ],
    selectedProjectId: "p1",
  } as never);
  useRuntimeStore.setState({ openAgentIds: ["a1", "a2"], status: {} } as never);
  useUiStore.setState({
    activeSpecial: null,
    workModeBySide: { left: "build", right: "build" },
    pinnedProjectId: null, openProjectIds: null,
    pairAssignment: { p2: "left" }, leftProjectId: "p2",
  } as never);
  useSettingsStore.setState({ beadsEnabled: true } as never);
  useAuthStore.setState({ me: null, tokenPresent: false, loading: false } as never);
  useConnectionStore.setState({ isOnline: true } as never);
  resetVisitedProjects();
  markProjectVisited("p1");
  markProjectVisited("p2");
  resetCable();
});
afterEach(() => {
  cleanup();
  resetCable();
});

const planOn = (side: "left" | "right") =>
  act(() => useUiStore.getState().setWorkMode(side, "plan"));

describe("the plan board is owned by the column that opened it", () => {
  // DEFECT 1 — pressing Plan on the LEFT column put the board on the RIGHT.
  it("opens the left column's board in the LEFT pair, scoped to the left project", () => {
    render(<Workspace />);
    planOn("left");

    // The left pair's board shows the LEFT project (p2) — not the right pair's project.
    expect(screen.getByTestId("board-p2")).toBeTruthy();
    // ...and the right pair, which was never asked for a board, has none.
    expect(screen.queryByTestId("board-p1")).toBe(null);
  });

  // DEFECT 2 — the board opens in the pair whose chevron was pressed, and covers THAT pair. It
  // used to be written once inside the right pair, so the left pair could not show one at all.
  //
  // HOW MUCH of the pair it covers is a separate question with its own file: the board spans BOTH
  // columns (Workspace.planBoardSpansPair.test.tsx). This test deliberately asserts only that the
  // board is inside the LEFT pair and that the right pair still has none — the containment that
  // distinguishes "which pair" from "which pair" — so the two files cannot contradict each other
  // when the geometry moves. It briefly asserted the opposite (containment in the terminal stage),
  // which is what pinned the founder's blank build column in place.
  it("renders the board in the pair whose chevron was pressed, over that pair's columns", () => {
    render(<Workspace />);
    planOn("left");

    const board = screen.getByTestId("board-p2");
    expect(screen.getByTestId("pair-cols-left").contains(board)).toBe(true);
    expect(screen.getByTestId("pair-cols-right").contains(board)).toBe(false);
  });

  // DEFECT 3 — THE DIAGNOSTIC ONE, and the regression guard. Two boards, different content, open
  // at the same time with no interaction. Impossible to satisfy with a single global.
  it("leaves the right column's board intact when the left column opens its own", () => {
    render(<Workspace />);

    planOn("right");
    expect(screen.getByTestId("board-p1")).toBeTruthy();

    planOn("left");
    // The left board opened...
    expect(screen.getByTestId("board-p2")).toBeTruthy();
    // ...and the right board is STILL THERE, still showing its own project. This is the assertion
    // that fails against a singleton: opening the left board used to overwrite this one.
    expect(screen.getByTestId("board-p1")).toBeTruthy();

    // Each in ITS OWN pair — the containment that makes "two boards" mean two independent boards
    // rather than one component rendered twice from the same global.
    expect(screen.getByTestId("pair-cols-left").contains(screen.getByTestId("board-p2"))).toBe(true);
    expect(screen.getByTestId("pair-cols-right").contains(screen.getByTestId("board-p1"))).toBe(
      true,
    );
  });

  // AN INVARIANT THE SPLIT REMOVED, restored explicitly. The board and the Improve-Sparkle pane
  // used to be two values of ONE enum, so they could not both be up — setting either cleared the
  // other. They are independent state now and render into the SAME right-hand stage, so without a
  // gate the Sparkle pane mounts invisibly behind the board (TERMINAL_PANE_Z vs PLAN_COLUMN_Z) and
  // clicking Improve Sparkle from the board looks like it did nothing at all.
  it("yields the right stage to the Improve-Sparkle pane rather than stacking behind it", () => {
    render(<Workspace />);
    planOn("right");
    expect(screen.getByTestId("board-p1")).toBeTruthy();

    act(() => useUiStore.getState().setActiveSpecial("sparkle"));
    expect(screen.queryByTestId("board-p1")).toBe(null);

    // ...and the column is still in Plan, so leaving Sparkle brings the user's board back rather
    // than silently dropping them into Build.
    expect(useUiStore.getState().workModeBySide.right).toBe("plan");
    act(() => useUiStore.getState().setActiveSpecial(null));
    expect(screen.getByTestId("board-p1")).toBeTruthy();
  });

  // The LEFT pair carries no Sparkle pane, so its board must not be gated on a right-pair surface.
  it("keeps the left column's board up while the Sparkle pane owns the right stage", () => {
    render(<Workspace />);
    planOn("left");
    act(() => useUiStore.getState().setActiveSpecial("sparkle"));
    expect(screen.getByTestId("board-p2")).toBeTruthy();
  });

  // The other direction of independence: closing one column's board must not close the other's.
  it("closing the left board leaves the right board open", () => {
    render(<Workspace />);
    planOn("right");
    planOn("left");

    act(() => useUiStore.getState().setWorkMode("left", "build"));

    expect(screen.queryByTestId("board-p2")).toBe(null);
    expect(screen.getByTestId("board-p1")).toBeTruthy();
  });
});
