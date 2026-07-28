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
// left the terminal showing an agent that NO row was highlighting. That guarantee is now carried by
// the SELECTION-reveal rule ("a selected worker always has a row", below) rather than by the subtree
// opening on spawn — subtrees open only when a worker needs you.
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

/** Re-render with `next` as the live project, exactly as a store update would. */
function advance(
  rerender: ReturnType<typeof render>["rerender"],
  next: Project,
  status?: Record<string, AgentTabStatus>,
) {
  useProjectStore.setState({ projects: [next] } as never);
  if (status) useRuntimeStore.setState({ status } as never);
  rerender(<AgentSidebar project={next} />);
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

// Subtrees default CLOSED and open by themselves for exactly ONE reason: a worker under them enters
// the needs_you band. They used to open on GROWTH — every spawn popped the subtree — which is the
// behavior these cases now invert. Nothing is hidden by a subtree that stays shut: a collapsed
// orchestrator whose worker is red already shows that red on its own head row (see
// AgentSidebar.redWorker.test.tsx).
describe("AgentSidebar — a subtree opens when a worker needs you, not when one spawns", () => {
  // The inversion. A spawn is not an event that requires the user, so it must leave the parent
  // exactly as the user left it — closed.
  /** A one-orchestrator project, seeded with whatever selection the case is about. */
  function seedSolo(selectedAgentId: string | null): Project {
    const solo: Project = {
      id: "p1", name: "Demo", rootPath: "/tmp/demo", defaultBranch: "main",
      createdAt: new Date(0).toISOString(), selectedAgentId,
      agents: [mkAgent("a1", "Alpha")],
    };
    useProjectStore.setState({ projects: [solo] } as never);
    useRuntimeStore.setState({
      branchStatus: {}, workflowStage: {}, status: {},
      openAgentIds: ["a1"], open, pollBranchStatus: vi.fn(() => Promise.resolve()),
    } as never);
    return solo;
  }

  it("does NOT expand a parent when its first worker spawns", () => {
    // The user is reading the orchestrator that's about to fan out.
    const solo = seedSolo("a1");
    const { rerender } = render(<AgentSidebar project={solo} />);

    // What the store ACTUALLY looks like after spawnWorker: the worker is appended and the
    // selection is untouched — services/workerSpawn passes `select: false`, which never moves it.
    const grown: Project = {
      ...solo,
      agents: [...solo.agents, mkAgent("w1", "First Worker", {
        kind: "worker", parentId: "a1", baseBranch: "main",
      })],
    };
    advance(rerender, grown, { w1: "working" });

    expect(useUiStore.getState().collapsedOrchestrators.a1).not.toBe(false);
    expect(queryRow("First Worker")).toBeNull();
  });

  // The null-selection variant, which is where `select: false` used to invert itself: the store
  // backfilled the empty slot with the new worker, and a SELECTED worker trips the selection-reveal
  // effect below, forcing the subtree open. `select: false` is absolute now, so a null selection
  // survives the spawn and nothing reveals anything.
  it("does NOT expand a parent when a worker spawns into a project with nothing selected", () => {
    const solo = seedSolo(null);
    const { rerender } = render(<AgentSidebar project={solo} />);

    const grown: Project = {
      ...solo,
      agents: [...solo.agents, mkAgent("w1", "First Worker", {
        kind: "worker", parentId: "a1", baseBranch: "main",
      })],
    };
    advance(rerender, grown, { w1: "working" });

    expect(liveProject().selectedAgentId).toBeNull();
    expect(useUiStore.getState().collapsedOrchestrators.a1).not.toBe(false);
    expect(queryRow("First Worker")).toBeNull();
  });

  it("does NOT expand a collapsed parent when another (calm) worker appears", () => {
    const project = seed({ w1: "working", w2: "working" }); // collapsed by default
    const { rerender } = render(<AgentSidebar project={project} />);
    expect(queryRow("Parser Worker")).toBeNull();

    // Spawn: a third worker joins a1, with the user's tab restored to the orchestrator — the exact
    // store shape services/workerSpawn leaves behind.
    const grown: Project = {
      ...project,
      selectedAgentId: "a1",
      agents: [...project.agents, mkAgent("w3", "Codegen Worker", {
        kind: "worker", parentId: "a1", baseBranch: "main",
      })],
    };
    advance(rerender, grown, { w1: "working", w2: "working", w3: "working" });

    expect(useUiStore.getState().collapsedOrchestrators.a1).not.toBe(false);
    expect(queryRow("Codegen Worker")).toBeNull();
  });

  // THE case the auto-expand now exists for.
  it("expands a collapsed parent when one of its workers goes red", () => {
    const project = seed({ w1: "working", w2: "working" });
    const { rerender } = render(<AgentSidebar project={project} />);
    expect(queryRow("Parser Worker")).toBeNull();

    advance(rerender, project, { w1: "waiting", w2: "working" });

    expect(useUiStore.getState().collapsedOrchestrators.a1).toBe(false);
    expect(queryRow("Parser Worker")).toBeTruthy();
  });

  // TRANSITION, NOT STATE. The effect re-runs on every status/agents change, so a worker that merely
  // STAYS red must not re-assert the expansion — otherwise collapsing a subtree with a red worker in
  // it would undo itself on the next render and the chevron would read as broken.
  it("does not re-expand after the user collapses a subtree whose worker is still red", () => {
    const project = seed({ w1: "working", w2: "working" });
    const { rerender } = render(<AgentSidebar project={project} />);

    advance(rerender, project, { w1: "errored", w2: "working" });
    expect(useUiStore.getState().collapsedOrchestrators.a1).toBe(false);

    toggleAlpha(); // the user shuts it again, red and all
    expect(useUiStore.getState().collapsedOrchestrators.a1).toBe(true);

    // w1 is still errored; an unrelated change ticks the effect.
    advance(rerender, project, { w1: "errored", w2: "idle" });
    expect(useUiStore.getState().collapsedOrchestrators.a1).toBe(true);
    expect(queryRow("Parser Worker")).toBeNull();
  });

  // The counterpart, and the reason the helper skips a parent's first sighting: a mount must not be
  // read as a transition, or every relaunch would blow open every subtree the user collapsed. The
  // red is not lost — the head row carries it.
  it("does not expand on first render even when a worker is ALREADY red", () => {
    useUiStore.setState({ collapsedOrchestrators: { a1: true } } as never);
    const project = seed({ w1: "errored" });
    render(<AgentSidebar project={project} />);
    expect(useUiStore.getState().collapsedOrchestrators.a1).toBe(true);
    expect(queryRow("Parser Worker")).toBeNull();
  });

  // Expansion is automatic; COLLAPSING stays the user's gesture — never yank a subtree shut while
  // they are reading it.
  it("does not collapse the subtree when the red clears", () => {
    const project = seed({ w1: "errored" });
    const { rerender } = render(<AgentSidebar project={project} />);
    advance(rerender, project, { w1: "idle" });
    // The red never triggered an expand (first sighting), so open it as the user would.
    toggleAlpha();
    expect(useUiStore.getState().collapsedOrchestrators.a1).toBe(false);

    advance(rerender, project, { w1: "working" });
    expect(useUiStore.getState().collapsedOrchestrators.a1).toBe(false);
    expect(queryRow("Parser Worker")).toBeTruthy();
  });

  it("does not re-expand a parent the user collapsed while its workers spin down", () => {
    const project = seedExpanded();
    const { rerender } = render(<AgentSidebar project={project} />);
    toggleAlpha();
    expect(useUiStore.getState().collapsedOrchestrators.a1).toBe(true);

    const shrunk: Project = { ...project, agents: project.agents.filter((a) => a.id !== "w2") };
    advance(rerender, shrunk);

    expect(useUiStore.getState().collapsedOrchestrators.a1).toBe(true);
  });

  // A STRAND — worktree cut, never mounted, no live status — is painted red by
  // withUnstartedWorkerAttention. That red is synthetic and its open/evict ping-pong can toggle many
  // times a second, so it must not drive the subtree. The signal is not lost: the orchestrator's own
  // head row goes red (AgentSidebar.redWorker.test.tsx pins that).
  it("does not expand for a stranded worker's SYNTHETIC red", () => {
    const project = seed({ w1: "working", w2: "working" });
    const { rerender } = render(<AgentSidebar project={project} />);

    const strandParent: Project = {
      ...project,
      agents: [...project.agents, mkAgent("w3", "Stranded Worker", {
        kind: "worker", parentId: "a1", baseBranch: "main", worktreePath: "/wt/w3",
      })],
    };
    // w3 has a worktree, is NOT in openAgentIds and has no status → isUnstartedWorker → synthetic
    // `approval`. Its parent a1 is open, which is the other half of the strand condition.
    advance(rerender, strandParent, { w1: "working", w2: "working" });

    expect(useUiStore.getState().collapsedOrchestrators.a1).not.toBe(false);
    expect(queryRow("Stranded Worker")).toBeNull();
  });

  // effectiveStatus (not the raw map) is the status source, so an alarm the user DISMISSED is
  // already de-escalated out of the red tier by the time the rule sees it.
  it("does not expand for a red the user has DISMISSED", () => {
    const project = seed({ w1: "working", w2: "working" });
    const { rerender } = render(<AgentSidebar project={project} />);

    const dismissed: Project = {
      ...project,
      agents: project.agents.map((a) =>
        a.id === "w1" ? { ...a, alert: { seq: 1, lastRed: "errored" as const, dismissedSeq: 1 } } : a,
      ),
    };
    advance(rerender, dismissed, { w1: "errored", w2: "working" });

    expect(useUiStore.getState().collapsedOrchestrators.a1).not.toBe(false);
    expect(queryRow("Parser Worker")).toBeNull();
  });
});

// Orthogonal to attention, and what makes dropping auto-expand-on-spawn safe: `addAgent` moves
// selection to the freshly-spawned worker, so a selected worker inside a collapsed subtree would
// leave the terminal showing an agent that NO row is highlighting — the bug that made workers get
// rows in the first place.
describe("AgentSidebar — a selected worker always has a row", () => {
  it("expands the parent when selection moves to a worker in a collapsed subtree", () => {
    const project = seed({ w1: "working", w2: "working" }); // collapsed by default
    const { rerender } = render(<AgentSidebar project={project} />);
    expect(queryRow("Parser Worker")).toBeNull();

    // What projectStore.addAgent does at the end of a spawn.
    const selected: Project = { ...project, selectedAgentId: "w1" };
    useProjectStore.setState({ projects: [selected] } as never);
    rerender(<AgentSidebar project={selected} />);

    expect(useUiStore.getState().collapsedOrchestrators.a1).toBe(false);
    expect(queryRow("Parser Worker")).toBeTruthy();
  });

  it("renders the row on a relaunch that restores a worker selection", () => {
    useUiStore.setState({ collapsedOrchestrators: { a1: true } } as never);
    const project = { ...seed({ w1: "working" }), selectedAgentId: "w1" };
    useProjectStore.setState({ projects: [project] } as never);
    render(<AgentSidebar project={project} />);
    expect(queryRow("Parser Worker")).toBeTruthy();
  });

  // Selection is a CHANGE trigger, not a state one: having selected a worker must not stop the user
  // from shutting the subtree afterwards.
  it("stays collapsed after the user closes a subtree holding the selected worker", () => {
    const project = seedExpanded({ w1: "working", w2: "working" });
    const selected: Project = { ...project, selectedAgentId: "w1" };
    useProjectStore.setState({ projects: [selected] } as never);
    const { rerender } = render(<AgentSidebar project={selected} />);

    toggleAlpha();
    expect(useUiStore.getState().collapsedOrchestrators.a1).toBe(true);

    // An unrelated tick, selection unchanged.
    useRuntimeStore.setState({ status: { w1: "working", w2: "idle" } } as never);
    rerender(<AgentSidebar project={selected} />);
    expect(useUiStore.getState().collapsedOrchestrators.a1).toBe(true);
  });

  it("leaves subtrees alone when the selection is a top-level agent", () => {
    const project = seed({ w1: "working" });
    const { rerender } = render(<AgentSidebar project={project} />);

    const selected: Project = { ...project, selectedAgentId: "a1" };
    useProjectStore.setState({ projects: [selected] } as never);
    rerender(<AgentSidebar project={selected} />);

    expect(useUiStore.getState().collapsedOrchestrators.a1).not.toBe(false);
  });

  // ONE AgentSidebar stays mounted across project switches (Workspace renders it once with `project`
  // as a prop), so a last-seen-id ref would read a round trip as two selection changes and re-open a
  // subtree the user shut — even though this project's selection never moved.
  it("does not re-expand after a project switch away and back", () => {
    const project = seedExpanded({ w1: "working", w2: "working" });
    const a: Project = { ...project, selectedAgentId: "w1" };
    const b: Project = {
      id: "p2", name: "Other", rootPath: "/tmp/other", defaultBranch: "main",
      createdAt: new Date(0).toISOString(), selectedAgentId: "b1",
      agents: [mkAgent("b1", "Bravo")],
    };
    useProjectStore.setState({ projects: [a, b] } as never);
    const { rerender } = render(<AgentSidebar project={a} />);

    toggleAlpha();
    expect(useUiStore.getState().collapsedOrchestrators.a1).toBe(true);

    rerender(<AgentSidebar project={b} />); // switch away…
    rerender(<AgentSidebar project={a} />); // …and back

    expect(useUiStore.getState().collapsedOrchestrators.a1).toBe(true);
  });

  // A selection can name an id before its record lands (a cross-window adopt). Dropping the reveal
  // then would strand it permanently, because every later agents-array update looks unchanged.
  it("reveals a selection whose agent record arrives late", () => {
    const project = seed({ w1: "working", w2: "working" });
    const pending: Project = { ...project, selectedAgentId: "w9" };
    useProjectStore.setState({ projects: [pending] } as never);
    const { rerender } = render(<AgentSidebar project={pending} />);
    expect(useUiStore.getState().collapsedOrchestrators.a1).not.toBe(false);

    const adopted: Project = {
      ...pending,
      agents: [...pending.agents, mkAgent("w9", "Adopted Worker", {
        kind: "worker", parentId: "a1", baseBranch: "main",
      })],
    };
    advance(rerender, adopted);

    expect(useUiStore.getState().collapsedOrchestrators.a1).toBe(false);
    expect(queryRow("Adopted Worker")).toBeTruthy();
  });
});
