// @vitest-environment jsdom
//
// THE PLAN CHEVRON WRITES **ITS OWN** COLUMN — the anti-paint test.
//
// The Workspace-level test (Workspace.planBoardPerColumn.test.tsx) proves the RENDERER puts a
// board in the right column. This one proves the BUTTON does, and the two are genuinely different
// facts. That distinction is the whole lesson of the mount-cable bug on this same surface: the
// `wired` flag reached the component that PAINTED the cable while the code that actually routed
// was cable-blind, so a per-column appearance sat on top of one global. A per-column board with a
// chevron that still writes a shared value would fail in exactly that way, and a renderer-only
// test would not notice.
//
// So: render two real sidebars in two real pairs, press Plan on the LEFT one, and assert the LEFT
// entry moved and the RIGHT entry did NOT. Against the old single `workMode` the second assertion
// is impossible to satisfy — there was one value for both.
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}));
vi.mock("./LogoWaveform", () => ({ LogoWaveform: () => null }));
vi.mock("./StatusBar", () => ({ StatusBar: () => null }));
vi.mock("./HistorySearch", () => ({ HistorySearch: () => null }));
vi.mock("../services/openProjectTab", () => ({ openProjectTab: vi.fn() }));
// The Build chevron's SECOND press spawns a build agent (≡ the + button), and that is the half of
// its behavior a mode assertion cannot see — so the spawn has to be observable.
const spawnAgent = vi.fn(() => "spawned-1");
vi.mock("../hooks/useSpawnBuildAgent", () => ({ useSpawnBuildAgent: () => spawnAgent }));

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
function mkProject(id: string): Project {
  return {
    id, name: `Project ${id}`, rootPath: `/tmp/${id}`, defaultBranch: null,
    createdAt: new Date(0).toISOString(), selectedAgentId: null, agents: [mkAgent(`${id}-a1`)],
  };
}

const modes = () => useUiStore.getState().workModeBySide;

beforeEach(() => {
  // p2 lives in the LEFT pair, p1 in the right — so the two sidebars below resolve to different
  // sides through the assignment map, which is how AgentSidebar derives `pairSide`.
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
  spawnAgent.mockClear();
});
afterEach(cleanup);

describe("the Plan chevron belongs to the column it is drawn in", () => {
  it("puts only the LEFT column into Plan, leaving the right column in Build", () => {
    const projects = useProjectStore.getState().projects;
    const left = projects.find((p) => p.id === "p2")!;
    render(<AgentSidebar project={left} slotSide="left" />);

    const plan = document.querySelector('[data-hint="plan"]');
    expect(plan).toBeTruthy();
    fireEvent.click(plan!);

    expect(modes().left).toBe("plan");
    // THE ASSERTION THAT COULD NOT PASS BEFORE. One global meant pressing Plan here moved the
    // right column too — which is what opened the board on the wrong side and clobbered it.
    expect(modes().right).toBe("build");
  });

  it("puts only the RIGHT column into Plan when pressed there", () => {
    const projects = useProjectStore.getState().projects;
    const right = projects.find((p) => p.id === "p1")!;
    render(<AgentSidebar project={right} slotSide="right" />);

    fireEvent.click(document.querySelector('[data-hint="plan"]')!);

    expect(modes().right).toBe("plan");
    expect(modes().left).toBe("build");
  });

  // THE MISSING DIRECTION. Workspace gates the primary column's board on `!sparkleActive`, so if
  // Plan does not also drop the Sparkle pane the chevron is a DEAD CONTROL while it is up: the
  // toggle highlights, the list switches to Plan and the filter bar hides, but the stage keeps
  // showing the Sparkle terminal — and `reconcileWorkMode` returns null while a special is up, so
  // nothing recovers it. The plan→sparkle order was covered; this is sparkle→plan.
  it("drops the Improve-Sparkle pane when Plan is pressed in the column that owns it", () => {
    useUiStore.setState({ activeSpecial: "sparkle" } as never);
    const right = useProjectStore.getState().projects.find((p) => p.id === "p1")!;
    render(<AgentSidebar project={right} slotSide="right" />);

    fireEvent.click(document.querySelector('[data-hint="plan"]')!);

    expect(modes().right).toBe("plan");
    expect(useUiStore.getState().activeSpecial).toBeNull();
  });

  // ...but only that column. There is ONE Sparkle pane and it lives in the primary pair's stage, so
  // a left column's Plan press must not reach across the window and close it.
  it("leaves the Sparkle pane alone when Plan is pressed in the OTHER column", () => {
    useUiStore.setState({ activeSpecial: "sparkle" } as never);
    const left = useProjectStore.getState().projects.find((p) => p.id === "p2")!;
    render(<AgentSidebar project={left} slotSide="left" />);

    fireEvent.click(document.querySelector('[data-hint="plan"]')!);

    expect(modes().left).toBe("plan");
    expect(useUiStore.getState().activeSpecial).toBe("sparkle");
  });

  // A SATELLITE IS ONE COLUMN, and the persisted pair assignment is not about that window. Without
  // the override this sidebar resolves "left" for a left-assigned project while the satellite's only
  // board reads "right", so every per-side write it makes lands where nothing renders — the mode
  // and the FEEDBACK filter both become dead controls in that window.
  it("writes the FORCED side in a satellite, ignoring the project's pair assignment", () => {
    const left = useProjectStore.getState().projects.find((p) => p.id === "p2")!;
    render(<AgentSidebar project={left} forcePairSide="right" showSparkleRow={false} />);

    fireEvent.click(document.querySelector('[data-hint="plan"]')!);

    // p2 is assigned LEFT, but this window only has a right-hand column.
    expect(modes().right).toBe("plan");
    expect(modes().left).toBe("build");
  });

  // THE BUILD MIRROR OF THE TWO PLAN CASES ABOVE. Plan had both directions covered while Build's
  // matching claims lived only in comments — and that gap is exactly what let a scoped WRITE ship
  // beside an unscoped READ.
  it("drops the Improve-Sparkle pane when Build is pressed in the column that owns it", () => {
    useUiStore.setState({ activeSpecial: "sparkle", workModeBySide: { left: "build", right: "plan" } } as never);
    const right = useProjectStore.getState().projects.find((p) => p.id === "p1")!;
    render(<AgentSidebar project={right} slotSide="right" />);

    fireEvent.click(document.querySelector('[data-hint="build"]')!);

    expect(modes().right).toBe("build");
    expect(useUiStore.getState().activeSpecial).toBeNull();
  });

  it("leaves the Sparkle pane alone when Build is pressed in the OTHER column", () => {
    useUiStore.setState({ activeSpecial: "sparkle", workModeBySide: { left: "plan", right: "build" } } as never);
    const left = useProjectStore.getState().projects.find((p) => p.id === "p2")!;
    render(<AgentSidebar project={left} slotSide="left" />);

    fireEvent.click(document.querySelector('[data-hint="build"]')!);

    expect(modes().left).toBe("build");
    // ONE pane, and it sits in the primary pair's stage. A left press must not reach across.
    expect(useUiStore.getState().activeSpecial).toBe("sparkle");
  });

  // ...and the consequence of that scoping, which is the part a mode assertion cannot see. Because
  // the left column can never clear the window-global `activeSpecial`, a handler that reads the
  // BARE global to decide "am I already here" is permanently false in that column while the pane
  // is up: second-click-spawn goes dead and every press instead re-runs the switching-INTO-Build
  // branch, re-selecting the first rendered row and yanking the cable off whatever the user had
  // patched. The read has to be scoped exactly like the write.
  it("still spawns on the second Build press in the LEFT column while the Sparkle pane is up", () => {
    useUiStore.setState({ activeSpecial: "sparkle", workModeBySide: { left: "build", right: "build" } } as never);
    const left = useProjectStore.getState().projects.find((p) => p.id === "p2")!;
    render(<AgentSidebar project={left} slotSide="left" />);

    fireEvent.click(document.querySelector('[data-hint="build"]')!);

    expect(spawnAgent).toHaveBeenCalledTimes(1);
  });

  // THE OTHER CONJUNCT. The left-column case above pins `activeSpecial !== null`; these two pin
  // `pairSide === SPARKLE_PANE_SIDE`. Without them, collapsing `paneCoversMe` to the bare
  // `pairSide === SPARKLE_PANE_SIDE` kills second-press-spawn in the RIGHT (primary) column
  // permanently — every press re-runs the switching-INTO-Build branch and re-selects the first
  // rendered row — and the suite stays green. `[data-hint="build"]` is clicked nowhere else.
  it("spawns on the second Build press in the RIGHT column when no pane is up", () => {
    useUiStore.setState({
      activeSpecial: null,
      workModeBySide: { left: "build", right: "build" },
    } as never);
    const right = useProjectStore.getState().projects.find((p) => p.id === "p1")!;
    render(<AgentSidebar project={right} slotSide="right" />);

    fireEvent.click(document.querySelector('[data-hint="build"]')!);

    expect(spawnAgent).toHaveBeenCalledTimes(1);
  });

  // ...and the negative: in the column the pane DOES cover, the first press is "get me back to the
  // stage", not "spawn". This is the half that would break if `paneCoversMe` collapsed to a
  // constant `false`.
  it("does NOT spawn on the first Build press in the RIGHT column while the Sparkle pane is up", () => {
    useUiStore.setState({
      activeSpecial: "sparkle",
      workModeBySide: { left: "build", right: "build" },
    } as never);
    const right = useProjectStore.getState().projects.find((p) => p.id === "p1")!;
    render(<AgentSidebar project={right} slotSide="right" />);

    fireEvent.click(document.querySelector('[data-hint="build"]')!);

    expect(spawnAgent).not.toHaveBeenCalled();
    expect(useUiStore.getState().activeSpecial).toBeNull();
  });

  // THE PAINT, not just the press. The row highlighting has to answer "is my stage covered" the
  // same way the chevron does — reading the bare window-global made the LEFT column paint
  // "Improve Sparkle is the active row" over its own live build terminal, and that mismatch is
  // what made the chevron's behavior read as unprovoked.
  it("does not paint the Improve-Sparkle row active in the column the pane does not cover", () => {
    useUiStore.setState({ activeSpecial: "sparkle" } as never);
    const left = useProjectStore.getState().projects.find((p) => p.id === "p2")!;
    const { container } = render(<AgentSidebar project={left} slotSide="left" />);

    const sparkleRow = container.querySelector('[data-hint="improve"]');
    expect(sparkleRow).toBeTruthy();
    expect(sparkleRow!.getAttribute("data-active")).toBe("0");
  });

  it("paints the Improve-Sparkle row active in the column that DOES own the pane", () => {
    useUiStore.setState({ activeSpecial: "sparkle" } as never);
    const right = useProjectStore.getState().projects.find((p) => p.id === "p1")!;
    const { container } = render(<AgentSidebar project={right} slotSide="right" />);

    expect(container.querySelector('[data-hint="improve"]')!.getAttribute("data-active")).toBe("1");
  });

  // THE OTHER HALF OF THE SAME LIE. The left column's build rows took `!activeSpecial`, so a pane
  // mounted in the OTHER column deselected them — the sidebar showed nothing selected while that
  // column's stage was still running the selected agent's terminal.
  it("keeps the selected build row painted in the column the pane does not cover", () => {
    const left = useProjectStore.getState().projects.find((p) => p.id === "p2")!;
    const withSelection = { ...left, selectedAgentId: "p2-a1" };
    useUiStore.setState({ activeSpecial: "sparkle" } as never);
    const { container } = render(<AgentSidebar project={withSelection} slotSide="left" />);

    const row = container.querySelector('[data-hint="agent"]');
    expect(row).toBeTruthy();
    expect(row!.getAttribute("aria-selected")).toBe("true");
  });

  it("keeps the other column's Plan mode when this one switches back to Build", () => {
    // Left already parked on its board; the user now works the right column.
    useUiStore.setState({ workModeBySide: { left: "plan", right: "plan" } } as never);
    const projects = useProjectStore.getState().projects;
    const right = projects.find((p) => p.id === "p1")!;
    render(<AgentSidebar project={right} slotSide="right" />);

    fireEvent.click(document.querySelector('[data-hint="build"]')!);

    expect(modes().right).toBe("build");
    // The left column's board stays open. Closing one board used to close both.
    expect(modes().left).toBe("plan");
  });
});
