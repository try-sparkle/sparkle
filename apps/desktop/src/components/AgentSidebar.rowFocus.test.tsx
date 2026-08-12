// @vitest-environment jsdom
//
// TWO SIGNALS ON THE SELECTED ROW, AND NEITHER IS COLOUR.
//
//  1. THE CIRCUIT REACHES BOTH WAYS. The selected row bleeds out of the Build column into its
//     terminal AND (once wired) into the concierge. The terminal half was invisible in the shipped
//     app: the pane is later in the DOM than the column and `paneVisibilityStyle` gives it
//     `TERMINAL_PANE_Z`, while the column carried no z-index at all — so the pane painted over the
//     overhang every time. The row read as plugged in at the concierge end and dead flat at the
//     terminal end, which is exactly what the user screenshotted.
//
//     `layers.ts` had described this fix since the pair lift landed, `BUILD_COLUMN_Z` existed, and
//     NOTHING APPLIED IT. The only guard was `paneVisibility.test.ts` comparing the two constants —
//     `BUILD_COLUMN_Z > TERMINAL_PANE_Z` — which is true whether or not either number ever reaches
//     an element. That is the "assertion was already true before the change" shape AGENTS.md names
//     as the #1 fleet-wide finding, and it let a documented, tested fix be absent from the running
//     app. So the case below reads the DOM, not the module.
//
//  2. FOCUS IS WEIGHT, NOT COLOUR. Colour is fully committed to STATUS in this app; weight was
//     unused. Regular on every row, bold on the active one.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FONT_WEIGHT } from "@sparkle/ui";

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
import { BUILD_COLUMN_Z } from "./layers";
import { paneVisibilityStyle } from "./paneVisibility";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import { useHelperPrefs } from "../helper/helperPrefs";
import { allBandsVisible } from "../engine/buildSections";
import { resetCable } from "../stores/cableStore";
import type { AgentTab, Project } from "../types";

function mkAgent(id: string, name: string, over: Partial<AgentTab> = {}): AgentTab {
  return {
    id, name, kind: "build", parentId: null, runtime: "local",
    worktreePath: null, branch: null, baseBranch: null, lastPrompt: "",
    promptHistory: [], namePinned: true, autoNameBasis: null,
    autoNameVariants: null, shellCommand: null, ...over,
  };
}

function seed(selectedAgentId: string | null = null): Project {
  const project: Project = {
    id: "p1", name: "Demo", rootPath: "/tmp/demo", defaultBranch: "main",
    createdAt: new Date(0).toISOString(), selectedAgentId,
    agents: [mkAgent("a1", "Alpha"), mkAgent("a2", "Beta")],
  };
  useProjectStore.setState({ projects: [project], selectedProjectId: "p1" } as never);
  useRuntimeStore.setState({
    branchStatus: {}, workflowStage: {}, status: {},
    openAgentIds: ["a1", "a2"],
    open: vi.fn(),
    pollBranchStatus: vi.fn(() => Promise.resolve()),
  } as never);
  return project;
}

const rowFor = (name: string) =>
  screen.getByText(name).closest('[data-hint="agent"]') as HTMLElement;
const titleOf = (name: string) => screen.getByText(name) as HTMLElement;
const column = () => screen.getByTestId("agent-sidebar-column");

beforeEach(() => {
  useUiStore.setState({
    collapsedOrchestrators: {}, activeSpecial: null,
    statusFilter: allBandsVisible(), pairAssignment: {}, leftProjectId: null,
  } as never);
  useHelperPrefs.setState({ enabled: true } as never);
  resetCable();
});
afterEach(() => {
  cleanup();
  resetCable();
});

describe("the row's bleed actually reaches the terminal", () => {
  it("lifts the Build column ABOVE the terminal pane, on the DOM", () => {
    // The assertion the constants-only guard could not make: the number is ON the column.
    render(<AgentSidebar project={seed("a1")} />);
    expect(Number(column().style.zIndex)).toBe(BUILD_COLUMN_Z);
    // …and it genuinely out-ranks what the visible pane carries, which is what stops the pane
    // painting over the row's overhang. Read from the real style helper, not from a literal.
    expect(Number(column().style.zIndex)).toBeGreaterThan(paneVisibilityStyle(true).zIndex);
  });

  it("keeps that lift regardless of which row is selected, or whether any is", () => {
    // Geometry and layering belong to the COLUMN, never to `.row.on` — the same rule the row box
    // follows. A lift that appeared only when something was selected would make the whole column
    // re-stack on every click.
    // ASSERTED AGAINST THE CONSTANT IN BOTH RENDERS, not against each other. Comparing the two
    // reads passes when the lift is DELETED — both are "" and "" equals "" — which is the
    // already-true-before-the-change shape this file's own header exists to guard against.
    render(<AgentSidebar project={seed(null)} />);
    expect(Number(column().style.zIndex)).toBe(BUILD_COLUMN_Z);
    cleanup();
    render(<AgentSidebar project={seed("a1")} />);
    expect(Number(column().style.zIndex)).toBe(BUILD_COLUMN_Z);
  });
});

describe("focus is carried by WEIGHT", () => {
  it("gives every unselected row title REGULAR, not semibold", () => {
    // "They are currently bold and too heavy" — a list where every line is heavy has no hierarchy.
    render(<AgentSidebar project={seed("a1")} />);
    expect(titleOf("Beta").style.fontWeight).toBe(String(FONT_WEIGHT.regular));
  });

  it("gives the ACTIVE row title BOLD", () => {
    render(<AgentSidebar project={seed("a1")} />);
    expect(titleOf("Alpha").style.fontWeight).toBe(String(FONT_WEIGHT.bold));
  });

  it("moves the bold with the selection rather than pinning it to a position", () => {
    // Driven through the REAL selection path — the click writes `selectedAgentId` to the store, and
    // the sidebar takes its project as a prop, so the shell re-renders it from the store. Re-reading
    // here is what the shell does; asserting against the stale prop snapshot would test nothing.
    const { rerender } = render(<AgentSidebar project={seed("a1")} />);
    fireEvent.click(rowFor("Beta"));
    rerender(<AgentSidebar project={useProjectStore.getState().projects[0]!} />);

    expect(titleOf("Beta").style.fontWeight).toBe(String(FONT_WEIGHT.bold));
    expect(titleOf("Alpha").style.fontWeight).toBe(String(FONT_WEIGHT.regular));
  });

  it("spends NO colour on focus — the two titles share one ink", () => {
    // The load-bearing half of the decision. Colour is committed to STATUS (the dots); if focus
    // also moved the title colour, "not focused" and "not available" would look the same, and the
    // status vocabulary would have two meanings. Weight is the whole signal here.
    render(<AgentSidebar project={seed("a1")} />);
    expect(titleOf("Alpha").style.color).toBe(titleOf("Beta").style.color);
  });

  it("is REINFORCEMENT, not the only signal — the selected row still floods", () => {
    // Stated as a test so a later "simplify" cannot drop the flood and leave weight carrying it
    // alone: a user who cannot resolve 400 vs 700 must still see which row is live.
    render(<AgentSidebar project={seed("a1")} />);
    expect(rowFor("Alpha").style.background).not.toBe(rowFor("Beta").style.background);
  });
});
