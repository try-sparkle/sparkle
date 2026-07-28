// @vitest-environment jsdom
//
// Workers render as indented CHILD ROWS under their orchestrator, folded behind the parent's row.
//
// The disclosure CHEVRON these tests were originally written against is gone. It sat ahead of the
// status disc and cost 20px of left gutter on every row in the column — including the childless
// ones, where the slot was reserved but empty just to keep the discs on one vertical line. Its two
// jobs were split: the row's own left click now toggles the subtree (it already selected the agent,
// so the fold is free), and a `+N` badge beside the title says how many workers are hidden rather
// than merely that some are. The collapse STATE and its persistence are unchanged, so most of what
// this file pins still holds — only the control that drives it moved.
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
/** Fold/unfold Alpha's subtree. This is a plain left click on the head row — the same gesture that
 *  selects it — since the chevron that used to own the toggle is gone. */
const toggleAlpha = () => fireEvent.click(rowFor("Alpha"));
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
    // depth * DEPTH_INDENT — the head sits at 0, its children at 1. The indent went 16 → 32 when the
    // chevron slot was removed, so that a worker's DISC lands where its parent's TITLE starts rather
    // than at some arbitrary offset. AgentSidebar.rowChrome.test.tsx pins the arithmetic.
    expect(rowFor("Alpha").style.marginLeft).toBe("0px");
    expect(rowFor("Parser Worker").style.marginLeft).toBe("32px");
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

    toggleAlpha();

    expect(queryRow("Parser Worker")).toBeNull();
    // The workers are still in the store — collapse is a view state, not a teardown. A fold that
    // could kill a running worker would be a catastrophic misread of the control.
    const fresh = liveProject();
    expect(fresh.agents.map((a) => a.id).sort()).toEqual(["a1", "w1", "w2"]);
  });

  it("persists the collapse choice through uiStore", () => {
    const project = seedExpanded();
    render(<AgentSidebar project={project} />);
    toggleAlpha();
    expect(useUiStore.getState().collapsedOrchestrators.a1).toBe(true);
    toggleAlpha();
    expect(useUiStore.getState().collapsedOrchestrators.a1).toBe(false);
  });

  // Removing the chevron BUTTON must not remove the fold from assistive tech: the row inherited the
  // job, so it inherits aria-expanded. Without this the change reads to a screen reader as "the
  // feature is gone" rather than "the control moved".
  it("reports its state to assistive tech", () => {
    const project = seedExpanded();
    render(<AgentSidebar project={project} />);
    expect(rowFor("Alpha").getAttribute("aria-expanded")).toBe("true");
    toggleAlpha();
    expect(rowFor("Alpha").getAttribute("aria-expanded")).toBe("false");
  });

  // Left click folds and selects; it does NOT throw the detail card over the rows it just revealed.
  // The card moved to right-click for exactly this reason.
  it("does not open the hover card when the row is clicked", () => {
    const project = seedExpanded();
    render(<AgentSidebar project={project} />);
    toggleAlpha();
    expect(screen.queryByTestId("agent-hover-card")).toBeNull();
  });

  // The hover card is pinned to the row's exact rect and its leading slot is a flex child in a gap:8
  // row — so if the card sized that slot differently, the disc/title/everything after it would jump
  // sideways the instant the card opened. Originally this guarded the chevron slot (roborev
  // 53672-M); with the chevron gone it guards the disc slot, which is the same contract.
  it("keeps the row and its hover card horizontally aligned", () => {
    const project = seedExpanded();
    render(<AgentSidebar project={project} />);
    // Both leading slots are fixed-height boxes (GLYPH_SLOT_H), which identifies them without
    // depending on nesting depth — the row and the card wrap CardHeader at different levels, so a
    // `> div > div` path would silently return [] for one of them and "pass" by comparing nothing.
    // The FIRST fixed-height slot only. The card also grows a TRAILING slot of the same size (the ×
    // close control, which lives there on an expanded/active row), so comparing every slot would
    // compare the row's one against the card's two and fail on a difference that is not a shift.
    // What must not move is where the disc — and therefore the title after it — begins.
    const leadingSlotWidth = (root: HTMLElement) =>
      Array.from(root.querySelectorAll<HTMLElement>("div")).find(
        (d) => d.style.height === "20px" && d.style.width !== "",
      )?.style.width;

    const rowSlot = leadingSlotWidth(rowFor("Alpha"));
    expect(rowSlot).toBeTruthy(); // guard: an empty selector must not pass silently
    fireEvent.contextMenu(rowFor("Alpha"));
    const cardSlot = leadingSlotWidth(screen.getByTestId("agent-hover-card"));

    // Same leading slot width → nothing shifts when the card stands over the row.
    expect(cardSlot).toEqual(rowSlot);
    // And no disclosure control survives anywhere — not on the row, not on the card.
    expect(document.querySelector('[aria-label*="workers for"]')).toBeNull();
  });

  it("gives an orchestrator with no workers neither a fold nor a count", () => {
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
    expect(rowFor("Solo").getAttribute("aria-expanded")).toBeNull();
    expect(rowFor("Solo").textContent).not.toContain("+");
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
    toggleAlpha();
    expect(useUiStore.getState().collapsedOrchestrators.a1).toBe(true);

    const shrunk: Project = { ...project, agents: project.agents.filter((a) => a.id !== "w2") };
    useProjectStore.setState({ projects: [shrunk] } as never);
    rerender(<AgentSidebar project={shrunk} />);

    expect(useUiStore.getState().collapsedOrchestrators.a1).toBe(true);
  });
});
