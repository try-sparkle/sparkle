// @vitest-environment jsdom
//
// A COVERED COLUMN MUST BE UNREACHABLE, NOT MERELY UNPAINTED — against the REAL column.
//
// When a pair's Plan board is up it covers BOTH columns, so it renders its own PlanBuildToggle;
// the sidebar's copy is underneath it. That leaves two of every control in the pair, with the
// covered one FIRST in DOM order — so Tab walks controls nobody can see, AT announces two identical
// mode toggles, and the ⌃-hint overlay's key handler (first match wins) fires the HIDDEN button.
// `covered` is what closes that, and `Workspace.planBoardSpansPair.test.tsx` proves the Workspace
// passes it.
//
// THIS FILE EXISTS BECAUSE THAT ONE CANNOT PROVE THE REST. It stubs AgentSidebar, so its
// `visibility: hidden` assertion is an assertion about the stub — deleting the treatment from the
// real component left it green (roborev 57298). Everything below renders the real column.
//
// AND IT IS SPECIFICALLY THE `inert` HALF THAT NEEDED PROVING. `visibility` is INHERITED, so a
// descendant can take it back, and two here do: StatusFilterBar's Reset link is
// `visibility: filtered ? "visible" : "hidden"` and every row's strip content is
// `visibility: showOverlay ? "hidden" : "visible"`. Both compute VISIBLE under the board, which is
// why the column carries `inert` as well — that one is not overridable from inside.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  refreshAgentBranch: vi.fn(() => Promise.resolve({ ok: true })),
  landAgentBranch: vi.fn(() => Promise.resolve({ ok: true })),
}));

import { AgentSidebar } from "./AgentSidebar";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import { resetCable } from "../stores/cableStore";
import { useHelperPrefs } from "../helper/helperPrefs";
import { allBandsVisible } from "../engine/buildSections";
import type { AgentTab, Project } from "../types";

function mkAgent(id: string, name: string): AgentTab {
  return {
    id, name, kind: "build", parentId: null, runtime: "local",
    worktreePath: null, branch: null, baseBranch: null, lastPrompt: "",
    promptHistory: [], namePinned: true, autoNameBasis: null,
    autoNameVariants: null, shellCommand: null,
  };
}

function seed(): Project {
  const project: Project = {
    id: "p1", name: "Demo", rootPath: "/tmp/demo", defaultBranch: "main",
    createdAt: new Date(0).toISOString(), selectedAgentId: null,
    agents: [mkAgent("a1", "Alpha"), mkAgent("a2", "Beta")],
  };
  useProjectStore.setState({ projects: [project] } as never);
  useRuntimeStore.setState({
    branchStatus: {}, workflowStage: {}, status: {},
    openAgentIds: ["a1", "a2"],
    open: vi.fn(),
    pollBranchStatus: vi.fn(() => Promise.resolve()),
  } as never);
  return project;
}

beforeEach(() => {
  useUiStore.setState({
    collapsedOrchestrators: {},
    activeSpecial: null,
    statusFilter: allBandsVisible(),
    workModeBySide: { left: "build", right: "build" },
  } as never);
  useHelperPrefs.setState({ enabled: true } as never);
  resetCable();
});
afterEach(() => {
  cleanup();
  resetCable();
});

const column = () => screen.getByTestId("agent-sidebar-column");

describe("the Build column while a Plan board covers it", () => {
  it("is reachable at rest — no inert, no hidden — so the default costs nothing", () => {
    render(<AgentSidebar project={seed()} />);
    expect(column().dataset.covered).toBe("false");
    expect(column().hasAttribute("inert")).toBe(false);
    expect(column().style.visibility).toBe("");
  });

  it("goes inert AND hidden when covered, keeping its layout box", () => {
    render(<AgentSidebar project={seed()} covered />);
    const col = column();
    expect(col.dataset.covered).toBe("true");
    // The half a descendant cannot undo.
    expect(col.hasAttribute("inert")).toBe(true);
    // ...and the half that keeps the width the seam and the CSS clamp both read. `display` is NOT
    // touched: `display: none` would zero the measured box and lose the user's column width.
    expect(col.style.visibility).toBe("hidden");
    expect(col.style.pointerEvents).toBe("none");
    expect(col.style.display).not.toBe("none");
    // The width is still declared — this is the property the whole treatment was chosen for.
    expect(col.style.width).not.toBe("");
    expect(col.dataset.width).toBeTruthy();
  });

  // THE ONE `visibility` ALONE GETS WRONG. The Reset link re-declares `visibility: visible` the
  // moment a status filter is on, so it computes visible under the board — a tab stop behind an
  // opaque surface whose Enter clears a filter the user cannot see (`pointer-events` never enters
  // it; keyboard activation does not hit-test). `inert` on the root is what actually neutralises it.
  it("neutralises a descendant that re-declares `visibility: visible`", () => {
    // One band off → `filtered` is true → the Reset link paints itself visible.
    useUiStore.setState({ statusFilter: { ...allBandsVisible(), done: false } } as never);
    render(<AgentSidebar project={seed()} covered />);

    const reset = screen.getByTestId("status-filter-reset");
    // It really does take `visibility` back — this is the precondition that makes the test mean
    // something rather than passing on an already-hidden element.
    expect(reset.style.visibility).toBe("visible");
    // ...and it is inside the inert subtree anyway, so it is neither focusable nor announced.
    expect(reset.closest("[inert]")).toBe(column());
  });

  // The rows are the other duplicated surface: every one carries `data-hint="agent"`, so a covered
  // column used to paint a numbered badge over the board for each row nobody could see.
  it("takes the agent rows out of the hint overlay's reach", () => {
    render(<AgentSidebar project={seed()} covered />);
    const rows = column().querySelectorAll('[data-hint="agent"]');
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.closest("[inert]")).toBe(column());
  });
});
