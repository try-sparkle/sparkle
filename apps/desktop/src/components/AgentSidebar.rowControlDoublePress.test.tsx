// @vitest-environment jsdom
//
// A DOUBLE PRESS ON A ROW CONTROL IS THE CONTROL'S GESTURE, NOT THE ROW'S — roborev 63145, #2.
//
// ══ THE BUG THIS PINS ══════════════════════════════════════════════════════════════════════════
// Every control on a build row guards itself the same way: `onClick={(e) => { e.stopPropagation();
// … }}`. That guard was COMPLETE right up until the row grew an `onDoubleClick` for the concierge
// mount, because `click` and `dblclick` are SEPARATE events and stopping one says nothing about the
// other. From that commit on, double-pressing the retire mark opened the retirement confirm AND
// silently patched the cable onto that row. Nothing caught it because before the mount landed the
// row had no `dblclick` handler at all, so these controls were simply inert on a double press.
//
// ══ WHY ONLY THE RETIRE MARK, WHEN THE FINDING NAMED FIVE CHIPS ════════════════════════════════
// Because the other four cannot be pressed into the bug, and finding that out is what this file is
// for. A control only leaks if it is still on screen, inside the row, when the `dblclick` lands:
//
//   • the EPIC and FEEDBACK pills call `openPlanBoard` on their first click, which swaps this whole
//     build column for the Plan board — the row is gone before the second click. `the pills that
//     navigate away` below pins that, because it is the ONLY thing protecting them.
//   • the retire PILL is on the hover card, `createPortal`'d as a SIBLING of the row element, so it
//     is outside the row's React subtree and never reaches the handler.
//   • the notice mark patches the cable on its own first click BY DESIGN (`openNoticePill`), so a
//     double press there was never a leak — it is the feature.
//
// Markers were added to the first three and every one stayed GREEN under mutation-check: no gesture
// could reach them, so nothing could tell a working marker from a missing one. They were removed.
//
// ══ WHAT IS ASSERTED IS THE SIDE EFFECT ════════════════════════════════════════════════════════
// `useCableStore.getState().wired`. A test that asserted "the chip stops propagation" would pass
// against the BROKEN code, because the chip does stop propagation — of the click.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}));
vi.mock("./LogoWaveform", () => ({ LogoWaveform: () => null }));
vi.mock("./HistorySearch", () => ({ HistorySearch: () => null }));
vi.mock("../services/branchStatus", () => ({
  refreshAgentBranch: vi.fn(() => Promise.resolve({ ok: true })),
  landAgentBranch: vi.fn(() => Promise.resolve({ ok: true })),
  projectAgentsStatus: vi.fn(() => Promise.resolve([])),
  pollBranchStatus: vi.fn(() => Promise.resolve()),
}));
// The retire chips read the receipt cache, which crosses the Tauri boundary jsdom does not have.
// Stubbed `captured` so the mark renders in its `ready` state — this file is about where a double
// press GOES, not about what the recommendation says.
vi.mock("../services/retroReceipts", async (orig) => ({
  ...(await orig<typeof import("../services/retroReceipts")>()),
  cachedReceipt: vi.fn(() => ({ state: "captured", at: 1, source: "pr-marker", tldr: "did it" })),
}));

import { AgentSidebar } from "./AgentSidebar";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import { useBeadsStore } from "../stores/beadsStore";
import { resetCable, useCableStore } from "../stores/cableStore";
import { resetPaneFocus } from "../stores/paneFocusStore";
import { allBandsVisible } from "../engine/buildSections";
import { doubleClickRow } from "../testing/rowGestures";
import type { AgentTab, Project } from "../types";
import type { Bead, Board } from "../services/beads";

const NAME = "Alpha";

function mkAgent(): AgentTab {
  return {
    id: "a1", name: NAME, kind: "build", parentId: null, runtime: "local",
    worktreePath: null, branch: null, baseBranch: null, lastPrompt: "",
    promptHistory: [], namePinned: true, autoNameBasis: null,
    autoNameVariants: null, shellCommand: null,
  } as AgentTab;
}

function bead(partial: Partial<Bead> & { id: string; title: string }): Bead {
  return { description: "", status: "open", labels: [], parent: null, ...partial };
}

const PROJECT: Project = {
  id: "p1", name: "Demo", rootPath: "/tmp/demo", defaultBranch: "main",
  createdAt: new Date(0).toISOString(), selectedAgentId: "a1", agents: [mkAgent()],
};

const board: Board = { backlog: [], blocked: [], inProgress: [], done: [], delivered: [] };

const rowFor = () => screen.getByText(NAME).closest('[data-hint="agent"]') as HTMLElement;
const wired = () => useCableStore.getState().wired;

beforeEach(() => {
  useProjectStore.setState({ projects: [PROJECT], selectedProjectId: "p1" } as never);
  useRuntimeStore.setState({
    openAgentIds: ["a1"],
    status: {},
    // `merged` + a clean branch is what puts the retirement recommendation on the collapsed row.
    workflowStage: { a1: "merged" },
    branchStatus: {
      a1: { ahead: 0, behind: 0, dirty: false, filesChanged: 0, insertions: 0, deletions: 0 },
    },
    open: vi.fn(),
    pollBranchStatus: vi.fn(() => Promise.resolve()),
  } as never);
  useBeadsStore.setState({
    // One bead labeled `agent:a1` — the FEEDBACK pill's whole condition (it hides at a count of 0).
    byProject: {
      p1: { beads: [bead({ id: "f1", title: "Feedback one", labels: ["agent:a1"] })], board, loadedAt: 1 },
    },
  } as never);
  useUiStore.setState({
    collapsedOrchestrators: {},
    activeSpecial: null,
    workModeBySide: { left: "build", right: "build" },
    boardAgentFilter: null,
    boardAgentFilterBySide: { left: null, right: null },
    statusFilter: allBandsVisible(),
  } as never);
  resetCable();
  resetPaneFocus();
});
afterEach(() => {
  cleanup();
  useBeadsStore.setState({ byProject: {} } as never);
});

describe("a double press on a row CONTROL does not mount the concierge", () => {
  // THE POSITIVE CONTROL, and it is not optional. Every other case asserts an ABSENCE, and an
  // absence proves nothing on its own: deleting `onDoubleClick` outright would satisfy them all.
  // This is the one that fails if the bail is ever widened until it swallows the row.
  it("…but a double press on the ROW ITSELF still does", () => {
    render(<AgentSidebar project={PROJECT} />);
    doubleClickRow(rowFor());
    expect(wired()).toBe("right");
  });

  it("the retire MARK — the one control that is inside the row and stays there", () => {
    render(<AgentSidebar project={PROJECT} />);
    doubleClickRow(screen.getByTestId("row-retire-mark"));
    expect(wired()).toBe("off");
  });

  it("…and the mark's OWN gesture still happens — this is one press with one outcome", () => {
    // THE FINDING'S EXACT SCENARIO. The bug was not "the cable moved" but "the confirm opened AND
    // the cable moved" — a double press meaning two unrelated things at once. Suppressing the mount
    // by breaking the mark would satisfy the case above and fail this one.
    render(<AgentSidebar project={PROJECT} />);
    doubleClickRow(screen.getByTestId("row-retire-mark"));
    expect(screen.getByRole("button", { name: /^Retire/ })).toBeTruthy();
    expect(wired()).toBe("off");
  });

  it("…and does not move a cable that is ALREADY live either", () => {
    // PRE-PATCHED TO THE OTHER SIDE, and that is the whole load-bearing detail (roborev 63236).
    //
    // This pre-patched "right" — the SAME side the row mounts onto (the positive control above
    // pins the pane side) — so a leaked mount re-patched the value it already held. `patchCable`
    // returns the same object for a no-op and zustand skips an `Object.is`-equal write, so the
    // store was identity-equal to `before` whether the bail ran or not: the one case covering
    // "the cable is already live" covered nothing at all.
    //
    // "left" makes a leak a REAL move, observable as a side flip, which is what a reader would
    // have to look at anyway. Identity stays as the secondary assertion — it additionally pins
    // that the bail happens before the store is touched — but it can no longer be the whole test.
    render(<AgentSidebar project={PROJECT} />);
    useCableStore.getState().patch("left", null);
    const before = useCableStore.getState();
    doubleClickRow(screen.getByTestId("row-retire-mark"));
    expect(wired()).toBe("left");
    expect(useCableStore.getState()).toBe(before);
  });

  it("a control marked with a NON-button interactive role is protected too", () => {
    // FINDING 2's half of roborev 63236. The selector recognised `role="button"` alone, so a chip
    // carrying any other real interactive role cleared the documented bar and leaked the mount
    // anyway. Driven through a role the app does not use on this row today precisely because the
    // point is the NEXT chip: this is the case that goes red if the list is ever narrowed back.
    render(<AgentSidebar project={PROJECT} />);
    const mark = screen.getByTestId("row-retire-mark");
    mark.setAttribute("role", "switch");
    useCableStore.getState().patch("left", null);
    doubleClickRow(mark);
    expect(wired()).toBe("left");
  });

  it("a row that ITSELF matches the selector still mounts — the currentTarget bound", () => {
    // THIS CASE HAS TO CREATE THE CONDITION IT NAMES (roborev 63316). Written as a plain double
    // press on the row it proved nothing about the bound: the row is `role="treeitem"`, which is
    // NOT in `ROW_CONTROL_SELECTOR`, so `closest` returns null and the guard short-circuits on the
    // falsy `hit` before either half of `hit !== currentTarget && currentTarget.contains(hit)` is
    // evaluated. Deleting the whole bound left it green — a near-duplicate of the positive control
    // at the top of this describe, differing only by an unrelated pre-patch.
    //
    // Giving the row a role the selector DOES match is what makes `hit === currentTarget` the only
    // thing standing between this gesture and a dead column: without `hit !== e.currentTarget`,
    // every press on the row reads as a press on a control and mounting stops entirely.
    render(<AgentSidebar project={PROJECT} />);
    const row = rowFor();
    row.setAttribute("role", "tab");
    doubleClickRow(row);
    expect(wired()).toBe("right");
  });

  it("…and so does a row nested under a matching ANCESTOR — the contains half", () => {
    // The other half of the bound. `closest` walks to the document root, so an ancestor carrying an
    // interactive role would otherwise match on every press and kill mounting for the whole column
    // at once — the failure mode that is worst precisely because it is not row-specific.
    render(<AgentSidebar project={PROJECT} />);
    const row = rowFor();
    row.parentElement?.setAttribute("role", "tab");
    doubleClickRow(row);
    expect(wired()).toBe("right");
  });

  it("the pills that navigate away are protected by leaving, not by the bail", () => {
    // WHY THE FEEDBACK AND EPIC PILLS CARRY NO GUARD. Their first click swaps this column for the
    // Plan board, so there is no row left for a `dblclick` to reach. That is load-bearing and
    // invisible — if either pill ever stops navigating, it becomes a leak with nothing stopping it,
    // and this case is what goes red. Asserted as the two facts a reader needs: the column left
    // Build, and the row is gone from the document.
    render(<AgentSidebar project={PROJECT} />);
    fireEvent.click(screen.getByTestId("row-feedback-pill"), { detail: 1 });
    expect(useUiStore.getState().workModeBySide.right).toBe("plan");
    expect(document.querySelector('[data-hint="agent"]')).toBeNull();
  });
});
