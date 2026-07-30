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
vi.mock("../hooks/useNewAgent", () => ({ useNewAgent: () => spawnAgent }));

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
