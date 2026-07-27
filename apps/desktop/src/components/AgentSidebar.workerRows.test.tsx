// @vitest-environment jsdom
//
// Workers render as indented CHILD ROWS under their orchestrator, behind a chevron.
//
// They used to have no row at all. Five separate surfaces each leaked them into the top-level list
// independently and were each patched shut (PRD/sparkle/hide-worker-agents-from-sidebar.md); the
// suppression approach was then abandoned, because a worker with no row is both unreachable and
// unattributable — `projectStore.addAgent` moves selection to a freshly-spawned worker, so a spawn
// left the terminal showing an agent that NO row was highlighting.
//
// The structural constraint these tests defend: children are rendered inside the head's own section
// wrapper, NOT fed through the ladder. `groupAgentsByStage` buckets per row by workflow stage, so a
// worker at a different stage than its parent would be torn out of the subtree and filed under some
// other section header. `topLevelAgents` therefore still excludes workers — that contract is pinned
// in engine/agentOrdering.test.ts and must not be "fixed" to make child rows work.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_STATUS } from "@sparkle/ui";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}));
vi.mock("./LogoWaveform", () => ({ LogoWaveform: () => null }));
vi.mock("./StatusBar", () => ({ StatusBar: () => null }));
vi.mock("./HistorySearch", () => ({ HistorySearch: () => null }));
vi.mock("../services/branchStatus", () => ({
  refreshAgentBranch: vi.fn(() => Promise.resolve({ ok: true })),
  landAgentBranch: vi.fn(() => Promise.resolve({ ok: true })),
}));

import { AgentSidebar } from "./AgentSidebar";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import type { AgentTab, AgentTabStatus, Project } from "../types";

function mkAgent(id: string, name: string, over: Partial<AgentTab> = {}): AgentTab {
  return {
    id, name, kind: "build", parentId: null, runtime: "local",
    worktreePath: null, branch: null, baseBranch: null, lastPrompt: "",
    promptHistory: [], namePinned: true, autoNameBasis: null,
    autoNameVariants: null, shellCommand: null,    ...over,
  };
}

const open = vi.fn();

/** One orchestrator "Alpha" with two workers. `namePinned` is set on every agent so auto-naming
 *  can't rewrite the labels the assertions look up. */
function seed(status: Record<string, AgentTabStatus> = {}): Project {
  const project: Project = {
    id: "p1", name: "Demo", rootPath: "/tmp/demo", defaultBranch: "main",
    createdAt: new Date(0).toISOString(), selectedAgentId: null,
    agents: [
      mkAgent("a1", "Alpha"),
      mkAgent("w1", "Parser Worker", { kind: "worker", parentId: "a1", baseBranch: "main" }),
      mkAgent("w2", "Lexer Worker", { kind: "worker", parentId: "a1", baseBranch: "main" }),
    ],
  };
  useProjectStore.setState({ projects: [project] } as never);
  useRuntimeStore.setState({
    branchStatus: {}, workflowStage: {}, status,
    openAgentIds: ["a1", "w1", "w2"],
    open,
    pollBranchStatus: vi.fn(() => Promise.resolve()),
  } as never);
  return project;
}

const rowFor = (name: string) =>
  screen.getByText(name).closest('[data-hint="agent"]') as HTMLElement;
const queryRow = (name: string) => screen.queryByText(name);
const chevron = () => screen.getByRole("button", { name: /workers for Alpha/i });
/** The seeded project, read back fresh from the store. Throws rather than returning undefined so a
 *  vanished project fails as itself instead of as a confusing assertion on `undefined`. */
function liveProject() {
  const p = useProjectStore.getState().projects[0];
  if (!p) throw new Error("project p1 is gone from the store");
  return p;
}

/** Expanded is the non-default state, so most tests need this. Set directly rather than by clicking
 *  the chevron, so a test of RENDERING doesn't also depend on the toggle working. */
function seedExpanded(status: Record<string, AgentTabStatus> = {}): Project {
  useUiStore.setState({ collapsedOrchestrators: { a1: false } } as never);
  return seed(status);
}

beforeEach(() => {
  useUiStore.setState({ collapsedOrchestrators: {}, activeSpecial: null } as never);
  open.mockClear();
});
afterEach(cleanup);

describe("AgentSidebar — worker child rows", () => {
  it("renders one row per worker when the parent is expanded", () => {
    const project = seedExpanded();
    render(<AgentSidebar project={project} />);
    expect(queryRow("Parser Worker")).toBeTruthy();
    expect(queryRow("Lexer Worker")).toBeTruthy();
  });

  it("indents a worker row one level below its parent", () => {
    const project = seedExpanded();
    render(<AgentSidebar project={project} />);
    // depth * 16 — the head sits at 0, its children at 1.
    expect(rowFor("Alpha").style.marginLeft).toBe("0px");
    expect(rowFor("Parser Worker").style.marginLeft).toBe("16px");
  });

  // uiStore's documented default: a missing entry reads as COLLAPSED.
  it("renders no worker rows by default", () => {
    const project = seed();
    render(<AgentSidebar project={project} />);
    expect(queryRow("Alpha")).toBeTruthy();
    expect(queryRow("Parser Worker")).toBeNull();
    expect(queryRow("Lexer Worker")).toBeNull();
  });

  it("collapsing hides the children without touching the agents themselves", () => {
    const project = seedExpanded();
    render(<AgentSidebar project={project} />);
    expect(queryRow("Parser Worker")).toBeTruthy();

    fireEvent.click(chevron());

    expect(queryRow("Parser Worker")).toBeNull();
    // The workers are still in the store — collapse is a view state, not a teardown. A chevron that
    // could kill a running worker would be a catastrophic misread of the control.
    const fresh = liveProject();
    expect(fresh.agents.map((a) => a.id).sort()).toEqual(["a1", "w1", "w2"]);
  });

  it("persists the collapse choice through uiStore", () => {
    const project = seedExpanded();
    render(<AgentSidebar project={project} />);
    fireEvent.click(chevron());
    expect(useUiStore.getState().collapsedOrchestrators.a1).toBe(true);
    fireEvent.click(chevron());
    expect(useUiStore.getState().collapsedOrchestrators.a1).toBe(false);
  });

  it("reports its state to assistive tech", () => {
    const project = seedExpanded();
    render(<AgentSidebar project={project} />);
    expect(chevron().getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(chevron());
    expect(chevron().getAttribute("aria-expanded")).toBe("false");
  });

  // The row div's own onClick is openCard. Without stopPropagation a chevron click would also open
  // the hover card, covering the rows it just revealed.
  it("does not open the hover card when the chevron is clicked", () => {
    const project = seedExpanded();
    render(<AgentSidebar project={project} />);
    fireEvent.click(chevron());
    expect(screen.queryByTestId("agent-hover-card")).toBeNull();
  });

  // The hover card is pinned to the row's exact rect, and the chevron slot is a flex child in a
  // gap:8 row — so if the card omitted the slot, the disc/title/everything after it would jump 20px
  // left the instant the card opened. The slot must exist on BOTH; only the button is conditional
  // (a chevron on a floating card would toggle the rows the card is covering). roborev 53672-M.
  it("keeps the row and its hover card horizontally aligned", () => {
    const project = seedExpanded();
    render(<AgentSidebar project={project} />);
    // Both leading slots are fixed-height boxes (GLYPH_SLOT_H), which identifies them without
    // depending on nesting depth — the row and the card wrap CardHeader at different levels, so a
    // `> div > div` path would silently return [] for one of them and "pass" by comparing nothing.
    const leadingSlotWidths = (root: HTMLElement) =>
      Array.from(root.querySelectorAll<HTMLElement>("div"))
        .filter((d) => d.style.height === "20px" && d.style.width !== "")
        .map((d) => d.style.width);

    const rowSlots = leadingSlotWidths(rowFor("Alpha"));
    expect(rowSlots.length).toBeGreaterThan(0); // guard: an empty selector must not pass silently
    fireEvent.click(rowFor("Alpha"));
    const cardSlots = leadingSlotWidths(screen.getByTestId("agent-hover-card"));

    // Same leading slot widths in the same order → nothing shifts when the card stands over the row.
    expect(cardSlots).toEqual(rowSlots);
    // And the card carries no disclosure button of its own.
    expect(
      screen.getByTestId("agent-hover-card").querySelector('[aria-label*="workers for"]'),
    ).toBeNull();
  });

  it("gives no chevron to an orchestrator with no workers", () => {
    const project: Project = {
      id: "p1", name: "Demo", rootPath: "/tmp/demo", defaultBranch: "main",
      createdAt: new Date(0).toISOString(), selectedAgentId: null,
      agents: [mkAgent("solo", "Solo")],
    };
    useProjectStore.setState({ projects: [project] } as never);
    useRuntimeStore.setState({
      branchStatus: {}, workflowStage: {}, status: {},
      openAgentIds: ["solo"], open, pollBranchStatus: vi.fn(() => Promise.resolve()),
    } as never);
    render(<AgentSidebar project={project} />);
    expect(screen.queryByRole("button", { name: /workers for Solo/i })).toBeNull();
  });
});

describe("AgentSidebar — worker rows carry their own live status dot", () => {
  it("paints a working worker's dot green, and its idle sibling's gray", () => {
    const project = seedExpanded({ w1: "working", w2: "idle" });
    render(<AgentSidebar project={project} />);

    // The dot is titled with its status label (StatusDot), so this also proves the row resolves the
    // WORKER's own status rather than inheriting its parent's.
    const working = screen.getByTitle(AGENT_STATUS.working.label);
    expect(working).toBeTruthy();
    expect(screen.getByTitle(AGENT_STATUS.idle.label)).toBeTruthy();
  });

  // Workers used to render a "↳" glyph INSTEAD of a status disc, because they had no row of their
  // own and the arrow was the only thing marking nesting. The indent carries that now, so the slot
  // is spent on the status the column exists to show.
  it("shows a status disc, not the old nesting arrow", () => {
    const project = seedExpanded({ w1: "working" });
    render(<AgentSidebar project={project} />);
    expect(rowFor("Parser Worker").textContent).not.toContain("↳");
  });

  // §1's contract, restated for child rows: whatever else changes, no filter may hide their color.
  it("puts no filter over a worker row", () => {
    const project = seedExpanded({ w1: "working", w2: "idle" });
    render(<AgentSidebar project={project} />);
    expect(rowFor("Parser Worker").style.filter).toBe("");
    expect(rowFor("Lexer Worker").style.filter).toBe("");
  });
});

describe("AgentSidebar — pane attribution follows the selected row", () => {
  it("clicking a worker row selects that worker and opens its pane", () => {
    const project = seedExpanded();
    render(<AgentSidebar project={project} />);

    fireEvent.click(rowFor("Parser Worker"));

    expect(liveProject().selectedAgentId).toBe("w1");
    expect(open).toHaveBeenCalledWith("w1");
  });

  it("clicking the orchestrator row returns selection to the orchestrator", () => {
    const project = seedExpanded();
    render(<AgentSidebar project={project} />);

    fireEvent.click(rowFor("Parser Worker"));
    expect(liveProject().selectedAgentId).toBe("w1");

    fireEvent.click(rowFor("Alpha"));
    expect(liveProject().selectedAgentId).toBe("a1");
    expect(open).toHaveBeenCalledWith("a1");
  });
});

describe("AgentSidebar — a spawned worker auto-expands its parent", () => {
  // THE case the auto-expand exists for, and the one the first cut got wrong (roborev 53672-High):
  // every orchestrator starts with zero workers, so if the snapshot only records parents that
  // ALREADY have workers, the first spawn looks like a first sighting and stays collapsed. Only the
  // second worker onward would expand — while addAgent has already moved selection to the new
  // worker, reproducing the exact "terminal shows an agent no row is highlighting" bug this whole
  // change is meant to kill.
  it("expands a parent that had NO workers when its first one spawns", () => {
    const solo: Project = {
      id: "p1", name: "Demo", rootPath: "/tmp/demo", defaultBranch: "main",
      createdAt: new Date(0).toISOString(), selectedAgentId: null,
      agents: [mkAgent("a1", "Alpha")],
    };
    useProjectStore.setState({ projects: [solo] } as never);
    useRuntimeStore.setState({
      branchStatus: {}, workflowStage: {}, status: {},
      openAgentIds: ["a1"], open, pollBranchStatus: vi.fn(() => Promise.resolve()),
    } as never);
    const { rerender } = render(<AgentSidebar project={solo} />);

    const grown: Project = {
      ...solo,
      agents: [...solo.agents, mkAgent("w1", "First Worker", {
        kind: "worker", parentId: "a1", baseBranch: "main",
      })],
    };
    useProjectStore.setState({ projects: [grown] } as never);
    rerender(<AgentSidebar project={grown} />);

    expect(useUiStore.getState().collapsedOrchestrators.a1).toBe(false);
    expect(queryRow("First Worker")).toBeTruthy();
  });

  it("expands a collapsed parent when a worker appears", async () => {
    const project = seed(); // collapsed by default
    const { rerender } = render(<AgentSidebar project={project} />);
    expect(queryRow("Parser Worker")).toBeNull();

    // Spawn: a third worker joins a1. This is what spawnWorker's addAgent does to the store.
    const grown: Project = {
      ...project,
      agents: [...project.agents, mkAgent("w3", "Codegen Worker", {
        kind: "worker", parentId: "a1", baseBranch: "main",
      })],
    };
    useProjectStore.setState({ projects: [grown] } as never);
    rerender(<AgentSidebar project={grown} />);

    expect(useUiStore.getState().collapsedOrchestrators.a1).toBe(false);
    expect(queryRow("Codegen Worker")).toBeTruthy();
  });

  // The counterpart, and the reason expandOnGrowth skips a parent's first sighting: a mount must
  // not be read as growth, or every relaunch would blow open every subtree the user collapsed.
  it("does not expand on first render, so a persisted collapse survives relaunch", () => {
    useUiStore.setState({ collapsedOrchestrators: { a1: true } } as never);
    const project = seed();
    render(<AgentSidebar project={project} />);
    expect(useUiStore.getState().collapsedOrchestrators.a1).toBe(true);
    expect(queryRow("Parser Worker")).toBeNull();
  });

  it("does not re-expand a parent the user collapsed while its workers spin down", () => {
    const project = seedExpanded();
    const { rerender } = render(<AgentSidebar project={project} />);
    fireEvent.click(chevron());
    expect(useUiStore.getState().collapsedOrchestrators.a1).toBe(true);

    const shrunk: Project = { ...project, agents: project.agents.filter((a) => a.id !== "w2") };
    useProjectStore.setState({ projects: [shrunk] } as never);
    rerender(<AgentSidebar project={shrunk} />);

    expect(useUiStore.getState().collapsedOrchestrators.a1).toBe(true);
  });
});
