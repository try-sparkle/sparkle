// @vitest-environment jsdom
//
// The FEEDBACK pill (feedback-pill-and-filter): a build-agent row's affordance to open the Plan
// board filtered to JUST that agent's feedback — the beads labeled `agent:<id>` it created or
// commented on. It is CONDITIONAL: shown only when the agent actually has ≥1 such bead, so a row
// with nothing to show never offers a dead click. Clicking it flips to Plan → board and stamps the
// agent id into uiStore.boardAgentFilter (the channel BoardView reads to narrow its columns).
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { C } from "../theme/colors";
import { FONT_MONO, TYPE } from "../theme/scale";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}));
vi.mock("./LogoWaveform", () => ({ LogoWaveform: () => null }));
vi.mock("./HistorySearch", () => ({
  HistorySearch: () => null,
  relativeTime: () => "",
  renderSnippet: () => null,
}));
vi.mock("../services/branchStatus", () => ({
  projectAgentsStatus: vi.fn(() => Promise.resolve([])),
  refreshAgentBranch: vi.fn(() => Promise.resolve({ ok: true })),
  landAgentBranch: vi.fn(() => Promise.resolve({ ok: true })),
}));

import { AgentSidebar } from "./AgentSidebar";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import { useBeadsStore } from "../stores/beadsStore";
import { useHelperPrefs } from "../helper/helperPrefs";
import { allBandsVisible } from "../engine/buildSections";
import type { AgentTab, Project } from "../types";
import type { Bead, Board } from "../services/beads";

function mkAgent(id: string, name: string, over: Partial<AgentTab> = {}): AgentTab {
  return {
    id, name, kind: "build", parentId: null, runtime: "local",
    worktreePath: null, branch: null, baseBranch: null, lastPrompt: "",
    promptHistory: [], namePinned: true, autoNameBasis: null,
    autoNameVariants: null, shellCommand: null, ...over,
  };
}

function bead(partial: Partial<Bead> & { id: string; title: string }): Bead {
  return { description: "", status: "open", labels: [], parent: null, ...partial };
}

const emptyBoard: Board = { backlog: [], blocked: [], inProgress: [], done: [], delivered: [], archived: [] };

/** Seed one build agent "a1" plus a beads snapshot for project p1. */
function seed(beads: Bead[], over: Partial<AgentTab> = {}): Project {
  const project: Project = {
    id: "p1", name: "Demo", rootPath: "/tmp/demo", defaultBranch: "main",
    createdAt: new Date(0).toISOString(), selectedAgentId: null,
    agents: [mkAgent("a1", "Alpha", over)],
  };
  useProjectStore.setState({ projects: [project] } as never);
  useRuntimeStore.setState({
    branchStatus: {}, workflowStage: { a1: "building_saved" }, status: {},
    openAgentIds: ["a1"],
    open: vi.fn(),
    pollBranchStatus: vi.fn(() => Promise.resolve()),
  } as never);
  useBeadsStore.setState({
    byProject: { p1: { beads, board: emptyBoard, loadedAt: Date.now() } },
  } as never);
  return project;
}

const rowFor = (name: string) =>
  screen.getByText(name).closest('[data-hint="agent"]') as HTMLElement;
const pillOf = (name: string) =>
  rowFor(name).querySelector<HTMLElement>('[data-testid="row-feedback-pill"]');

beforeEach(() => {
  useUiStore.setState({
    collapsedOrchestrators: {},
    activeSpecial: null,
    workModeBySide: { left: "build", right: "build" },
    boardAgentFilter: null,
    statusFilter: allBandsVisible(),
  } as never);
  useHelperPrefs.setState({ enabled: true } as never);
});
afterEach(() => {
  cleanup();
  useBeadsStore.setState({ byProject: {} } as never);
  useUiStore.setState({ workModeBySide: { left: "build", right: "build" }, activeSpecial: null, boardAgentFilterBySide: { left: null, right: null } } as never);
});

describe("the FEEDBACK pill", () => {
  it("appears with its count when the agent has beads labeled agent:<id>", () => {
    render(<AgentSidebar project={seed([
      bead({ id: "p1-f1", title: "Feedback one", labels: ["agent:a1"] }),
      bead({ id: "p1-f2", title: "Feedback two", labels: ["agent:a1", "epic:improve-sparkle"] }),
      bead({ id: "p1-x1", title: "Not mine", labels: ["agent:other"] }),
    ])} />);
    const pill = pillOf("Alpha");
    expect(pill).toBeTruthy();
    // The count is the number of the agent's OWN feedback beads (2), not the other agent's.
    expect(pill!.textContent).toBe("FEEDBACK 2");
  });

  // THE mutation-check target: removing the `feedbackCount > 0` guard (rendering the pill
  // unconditionally) makes this query find a pill, failing the toBeNull().
  it("is HIDDEN when the agent has no feedback beads", () => {
    render(<AgentSidebar project={seed([
      bead({ id: "p1-x1", title: "Someone elses", labels: ["agent:other"] }),
    ])} />);
    expect(pillOf("Alpha")).toBeNull();
  });

  it("is hidden on a non-build (shell) row even when a labeled bead exists", () => {
    render(<AgentSidebar project={seed(
      [bead({ id: "p1-f1", title: "Feedback one", labels: ["agent:a1"] })],
      { kind: "shell", shellCommand: "zsh" },
    )} />);
    expect(pillOf("Alpha")).toBeNull();
  });

  it("clicking it flips THIS COLUMN to the Plan board and filters it to this agent", () => {
    render(<AgentSidebar project={seed([
      bead({ id: "p1-f1", title: "Feedback one", labels: ["agent:a1"] }),
    ])} />);
    const pill = pillOf("Alpha")!;
    fireEvent.click(pill);
    // The observable side effect of both setters, each a real change from its default. There used
    // to be a third (`activeSpecial = "board"`): the board is a column's own `workMode === "plan"`
    // now, so the mode IS the board and the second global is gone.
    const ui = useUiStore.getState();
    expect(ui.workModeBySide.right).toBe("plan");
    // ...and the OTHER column is untouched — a left-pair row's pill cannot open the right's board.
    expect(ui.workModeBySide.left).toBe("build");
    expect(ui.boardAgentFilterBySide.right).toBe("a1");
  });

  // The pill means "show me the board", and the filter it records is useless against a board the
  // Improve-Sparkle pane is covering — the column moves to Plan, the filter is stored, and the
  // stage keeps showing the Sparkle terminal.
  it("makes the Improve-Sparkle pane yield so the filtered board is actually on screen", () => {
    useUiStore.setState({ activeSpecial: "sparkle" } as never);
    render(<AgentSidebar project={seed([
      bead({ id: "p1-f1", title: "Feedback one", labels: ["agent:a1"] }),
    ])} />);

    fireEvent.click(pillOf("Alpha")!);

    expect(useUiStore.getState().workModeBySide.right).toBe("plan");
    expect(useUiStore.getState().activeSpecial).toBeNull();
    expect(useUiStore.getState().boardAgentFilterBySide.right).toBe("a1");
  });

  it("is DRAWN not filled (mono/micro, bordered, no fill) but reads as an action (cursor:pointer)", () => {
    render(<AgentSidebar project={seed([
      bead({ id: "p1-f1", title: "Feedback one", labels: ["agent:a1"] }),
    ])} />);
    const pill = pillOf("Alpha")!;
    expect(pill.style.fontFamily).toBe(FONT_MONO);
    expect(pill.style.fontSize).toBe(`${TYPE.micro}px`);
    // An accent border reading as an action, not the neutral status ink of the stage chip.
    expect(pill.style.color).toBe(C.accentInk);
    expect(pill.style.background).toBe("");
    expect(pill.style.cursor).toBe("pointer");
  });
});
