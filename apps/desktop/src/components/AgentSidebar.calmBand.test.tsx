// @vitest-environment jsdom
//
// The sidebar must not DIM an agent whose work simply hasn't landed yet.
//
// `unmerged` stopped being red on 2026-07-26 so it would stop competing for the eye. The first
// attempt did that by leaving it in the concierge's calm band — and the sidebar derives its `calm`
// flag from that band and renders calm rows `grayscale(1) opacity(.72)`, so "not red" silently became
// "greyed out like idle". The fix for THAT moved it to P1, which handed every unlanded agent a
// concierge nudge card instead. It resolved only once the two questions were separated:
// `conciergePriority` (an interruption budget) and `isCalmBand` (a legibility treatment).
//
// engine/redTaxonomySeparation.test.ts unit-tests `isCalmBand` itself. This file exists because that
// is not enough: roborev pointed out that reverting AgentSidebar's single call site back to
// `conciergePriority(...) === 2` re-dims every "Needs merge" row with a fully green suite. So the
// WIRING gets its own assertion, at the enforcement site, against the rendered style.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
import type { WorkflowStageId } from "../engine/workflowStage";

function mkAgent(id: string, name: string): AgentTab {
  return {
    id, name, kind: "build", parentId: null, runtime: "local",
    worktreePath: null, branch: null, baseBranch: null, lastPrompt: "",
    promptHistory: [], namePinned: true, autoNameBasis: null,
    autoNameVariants: null, shellCommand: null, pinnedIndex: null,
  } as AgentTab;
}

/** Two top-level agents: `Unlanded` (idle + committed work → escalates to `unmerged`) and `Finished`
 *  (idle + already on main → genuinely calm). Rendering both in one tree means the assertion is a
 *  CONTRAST, so it can't pass just because nothing is dimmed at all. */
function seed(): Project {
  const project: Project = {
    id: "p1", name: "Demo", rootPath: "/tmp/demo", defaultBranch: "main",
    createdAt: new Date(0).toISOString(), selectedAgentId: null,
    agents: [mkAgent("a1", "Unlanded"), mkAgent("a2", "Finished")],
  };
  useProjectStore.setState({ projects: [project] } as never);
  useRuntimeStore.setState({
    branchStatus: {},
    // `building_saved` is the committed-but-unlanded band withUnmergedWork escalates on; `merged` is
    // past it. Both agents are `idle`, so the stage is the ONLY difference between them.
    workflowStage: { a1: "building_saved", a2: "merged" } as Record<string, WorkflowStageId>,
    status: { a1: "idle", a2: "idle" } as Record<string, AgentTabStatus>,
    openAgentIds: ["a1", "a2"],
    open: vi.fn(),
    pollBranchStatus: vi.fn(() => Promise.resolve()),
  } as never);
  return project;
}

/** The row element carrying the calm treatment, found from its visible name. */
function rowFor(name: string): HTMLElement {
  return screen.getByText(name).closest('[data-hint="agent"]') as HTMLElement;
}

/** Is this row (or an ancestor inside the sidebar) rendered with the calm grayscale filter? The
 *  treatment is applied via inline style, so read it rather than guessing at class names. */
function isDimmed(row: HTMLElement): boolean {
  let el: HTMLElement | null = row;
  for (let i = 0; el && i < 4; i++, el = el.parentElement) {
    if ((el.style.filter ?? "").includes("grayscale")) return true;
  }
  return false;
}

beforeEach(() => {
  useUiStore.setState({ collapsedOrchestrators: {}, activeSpecial: null } as never);
});
afterEach(cleanup);

describe("AgentSidebar — the calm band drives dimming, and unmerged is not in it", () => {
  it("does NOT dim a row whose work is committed but not landed", () => {
    const project = seed();
    render(<AgentSidebar project={project} />);
    expect(isDimmed(rowFor("Unlanded"))).toBe(false);
  });

  it("DOES dim a genuinely finished row, so the contrast is real", () => {
    // Without this, the test above would pass trivially if dimming broke entirely.
    const project = seed();
    render(<AgentSidebar project={project} />);
    expect(isDimmed(rowFor("Finished"))).toBe(true);
  });
});
