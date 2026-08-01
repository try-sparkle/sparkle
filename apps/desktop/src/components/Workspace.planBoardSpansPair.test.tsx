// @vitest-environment jsdom
//
// THE PLAN BOARD TAKES THE WHOLE PAIR, NOT ONE COLUMN OF IT.
//
// The defect this pins, in the founder's words: "These plan columns are not taking over the builder
// row. They should be in both the terminal and the builder area." With Plan selected, the board
// rendered inside that pair's TERMINAL stage only — so the Build column beside it went completely
// blank (a dark panel carrying nothing but its own Plan/Build toggle and the Improve-Sparkle row),
// and the board was squeezed into half the width it had available. At that width the five board
// columns do not fit: Backlog and Blocked showed with their card titles wrapping, Blocked was
// clipped mid-word at the edge, and Being built / Done / Shipped were off-screen behind a scroll.
//
// The board is a per-column feature (each pair opens its own, for its own project — see
// Workspace.planBoardPerColumn.test.tsx, which this file does NOT relax). What changes here is only
// HOW MUCH of that column's pair it covers: the whole `paircols` box, both columns, as an OVERLAY.
//
// The four properties under test, each of which failed or was unrepresentable before:
//
//   1. SPANS THE PAIR. The board is a descendant of the pair's column box and NOT of the terminal
//      stage. Those two are mutually exclusive by construction, which is what makes the assertion
//      worth writing — a terminal-slot board cannot satisfy it by accident.
//   2. THE WAY BACK TO BUILD SURVIVES. Covering the Build column takes its Plan/Build toggle with
//      it, so the board carries its own — and pressing Build there really returns the pair to
//      Build. (This is the constraint that sets the paint order in `layers.ts`.)
//   3. THE LAYOUT IS NOT SPENT. Entering and leaving Plan must not touch either column's stored
//      width. An overlay cannot, which is precisely why it is an overlay and not a re-flow: nothing
//      unmounts, so no width is recomputed, no PTY is torn down, and Build comes back exactly as it
//      was left.
//   4. THE PAIRS STAY INDEPENDENT. Left in Plan while right is in Build is the founder's own
//      screenshot; the wide board on one side must leave the other side's two columns alone.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

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
// The sidebar is stubbed, but PlanBuildToggle is NOT — the toggle the board carries has to be the
// real control, or test 2 would be asserting against a fixture of itself.
//
// The stub reproduces the two things the covered-column test needs from the real column: it renders
// its own `data-hint` toggle (the duplicate the board's copy would compete with) and it honours
// `covered` the way AgentSidebar's root does. It does NOT re-implement the treatment — it applies
// the same `visibility: hidden`, so a change that drops the prop on the Workspace side fails here.
vi.mock("./AgentSidebar", () => ({
  AgentSidebar: ({ slotSide = "right", covered = false }: { slotSide?: string; covered?: boolean }) => (
    <div
      data-testid={`sidebar-${slotSide}`}
      data-slot-side={slotSide}
      data-covered={String(covered)}
      style={covered ? { visibility: "hidden", pointerEvents: "none" } : undefined}
    >
      <button data-hint="build">Build</button>
      <button data-hint="plan">Plan</button>
    </div>
  ),
  NewBuildAgentButton: () => null,
}));
vi.mock("./ConciergeHost", () => ({ ConciergeHost: () => <div data-testid="concierge" /> }));
vi.mock("./OfflineBanner", () => ({ OfflineBanner: () => null }));
vi.mock("./ZeroCreditBanner", () => ({ ZeroCreditBanner: () => null }));
vi.mock("./SparkleAgentPane", () => ({ SparkleAgentPane: () => null }));
vi.mock("./ProjectModal", () => ({ ProjectModal: () => null }));
vi.mock("./ClosePrompt", () => ({ ClosePrompt: () => null }));
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
import { buildWidthKey } from "../engine/columnResize";
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
  localStorage.clear();
  resetCable();
});

const planOn = (side: "left" | "right") =>
  act(() => useUiStore.getState().openPlanBoard(side));

/** The board overlay for a side — the element that carries the geometry under test. */
function planColumn(side: "left" | "right"): HTMLElement {
  const cols = screen.getByTestId(`pair-cols-${side}`);
  const el = cols.querySelector<HTMLElement>("[data-testid='plan-column']");
  if (!el) throw new Error(`no plan column in the ${side} pair`);
  return el;
}

describe("the Plan board takes over the whole pair", () => {
  // ── 1 ── THE GEOMETRY. Descendant of the pair's column box, NOT of the terminal stage.
  it("spans both columns of its pair rather than occupying the terminal slot", () => {
    render(<Workspace />);
    planOn("left");

    const cols = screen.getByTestId("pair-cols-left");
    const stage = screen.getByTestId("terminal-stage-left");
    const board = screen.getByTestId("board-p2");

    // It lives in the box that holds BOTH columns...
    expect(cols.contains(board)).toBe(true);
    // ...and NOT inside the terminal, which is the half it used to be confined to. These two
    // cannot both hold: the stage is a child of the column box.
    expect(stage.contains(board)).toBe(false);

    // And it really covers, rather than sitting beside them: an inset-0 absolute layer over the
    // pair's own positioned column box.
    const overlay = planColumn("left");
    expect(overlay.style.position).toBe("absolute");
    // React writes the unitless `0` straight through, so read the shorthand rather than a
    // normalised `0px` — the claim is "inset zero on every edge", not how jsdom spells it.
    expect(overlay.style.inset).toBe("0");
    expect(cols.style.position).toBe("relative");
  });

  // ── 2 ── THE WAY BACK. Covering the Build column takes the sidebar's toggle off screen, so the
  // board must carry one — and it must actually work, not merely render.
  it("carries a reachable Plan/Build toggle, and Build returns the pair to Build", () => {
    render(<Workspace />);
    planOn("left");

    const overlay = planColumn("left");
    const build = overlay.querySelector<HTMLButtonElement>("button[data-hint='build']");
    expect(build).toBeTruthy();
    // The Plan half is there too, showing which mode you are in.
    expect(overlay.querySelector("button[data-hint='plan']")).toBeTruthy();

    fireEvent.click(build!);

    expect(useUiStore.getState().workModeBySide.left).toBe("build");
    expect(screen.queryByTestId("board-p2")).toBe(null);
    // The two columns are back, and the terminal is unobstructed.
    expect(screen.getByTestId("sidebar-left")).toBeTruthy();
    expect(screen.getByTestId("terminal-stage-left")).toBeTruthy();
  });

  // ── 3 ── THE LAYOUT IS NOT SPENT. This is the "do not lose his layout" requirement, and the
  // strongest form of it available in jsdom: nothing UNMOUNTS across the flip (same DOM nodes, so
  // no column is re-created and no PTY torn down) and no stored width is rewritten.
  it("leaves both columns mounted and their stored widths untouched across a Plan round trip", () => {
    localStorage.setItem(buildWidthKey("left"), "480");
    render(<Workspace />);

    const sidebarBefore = screen.getByTestId("sidebar-left");
    const stageBefore = screen.getByTestId("terminal-stage-left");

    planOn("left");
    // Covered, never unmounted — the identical nodes are still in the document.
    expect(screen.getByTestId("sidebar-left")).toBe(sidebarBefore);
    expect(screen.getByTestId("terminal-stage-left")).toBe(stageBefore);
    expect(localStorage.getItem(buildWidthKey("left"))).toBe("480");

    act(() => useUiStore.getState().showBuildStage("left"));
    expect(screen.getByTestId("sidebar-left")).toBe(sidebarBefore);
    expect(screen.getByTestId("terminal-stage-left")).toBe(stageBefore);
    expect(localStorage.getItem(buildWidthKey("left"))).toBe("480");
  });

  // The same requirement stated as the thing that would actually break it. The obvious wrong
  // implementation of "make the board wide" is to give it a flex slot in `paircols` — and it looks
  // right in a screenshot while silently squeezing the two columns it shares the row with, which is
  // "lose his layout". So: entering Plan must not add an IN-FLOW child. The overlay is out of flow,
  // so the row the browser lays out is the same two columns, at the same widths, in both modes.
  it("adds no in-flow column to the pair, so neither existing column is squeezed", () => {
    render(<Workspace />);
    const cols = screen.getByTestId("pair-cols-left");
    const inFlow = () =>
      Array.from(cols.children).filter((c) => (c as HTMLElement).style.position !== "absolute");

    expect(inFlow()).toHaveLength(2); // the Build column and the terminal stage

    planOn("left");
    // The board arrived...
    expect(cols.querySelector("[data-testid='plan-column']")).toBeTruthy();
    // ...and the flex row it landed on is untouched — still exactly those two columns.
    expect(inFlow()).toHaveLength(2);
  });

  // ── 3b ── COVERED IS NOT THE SAME AS GONE, and the gap between them is a real defect
  // (roborev 57292). The board must render its own Plan/Build toggle, so the pair now holds TWO —
  // and the covered one is FIRST in DOM order. Three consequences, one cause: Tab walks controls
  // nobody can see, AT announces two identical mode toggles, and the ⌃-hint overlay draws a second
  // "b" chiclet floating over the opaque board whose key fires the HIDDEN button (its handler takes
  // the first match in DOM order). So the covered column has to be unreachable, not just unpainted.
  it("makes the covered Build column unreachable, so its controls cannot win a duplicated mnemonic", () => {
    render(<Workspace />);
    const sidebar = screen.getByTestId("sidebar-left");
    expect(sidebar.dataset.covered).toBe("false");

    planOn("left");
    expect(sidebar.dataset.covered).toBe("true");
    expect(sidebar.style.visibility).toBe("hidden");
    expect(sidebar.style.pointerEvents).toBe("none");

    // Exactly ONE reachable Build control in this pair — the board's. The hidden one is still in
    // the DOM (its layout box is what preserves the column's width), so counting elements would
    // pass vacuously; count the ones that are actually visible.
    const reachable = Array.from(
      screen.getByTestId("pair-cols-left").querySelectorAll<HTMLElement>("button[data-hint='build']"),
    ).filter((b) => !b.closest("[style*='visibility: hidden']"));
    expect(reachable).toHaveLength(1);
    expect(planColumn("left").contains(reachable[0] ?? null)).toBe(true);

    // The OTHER pair is in Build, so its own toggle stays reachable — this is a per-pair state, not
    // a window-wide one.
    expect(screen.getByTestId("sidebar-right").dataset.covered).toBe("false");
  });

  // ── 4 ── THE MIXED STATE FROM THE SCREENSHOT: left pair in Plan, right pair in Build. A board
  // that spans a pair must span ITS pair and nothing else.
  it("keeps the other pair's two columns intact while this one is wide", () => {
    render(<Workspace />);
    planOn("left");

    expect(screen.getByTestId("board-p2")).toBeTruthy();
    // The right pair never asked for a board and has none...
    expect(screen.queryByTestId("board-p1")).toBe(null);
    expect(screen.getByTestId("pair-cols-right").querySelector("[data-testid='plan-column']")).toBe(
      null,
    );
    // ...so both of its columns are still there.
    expect(screen.getByTestId("sidebar-right")).toBeTruthy();
    expect(screen.getByTestId("terminal-stage")).toBeTruthy();

    // And the mirror image: the right pair goes wide without disturbing the left's Build columns.
    act(() => useUiStore.getState().showBuildStage("left"));
    planOn("right");
    expect(screen.getByTestId("pair-cols-right").contains(screen.getByTestId("board-p1"))).toBe(
      true,
    );
    expect(screen.getByTestId("terminal-stage").contains(screen.getByTestId("board-p1"))).toBe(
      false,
    );
    expect(screen.getByTestId("pair-cols-left").querySelector("[data-testid='plan-column']")).toBe(
      null,
    );
  });
});
