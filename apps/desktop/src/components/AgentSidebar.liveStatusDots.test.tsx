// @vitest-environment jsdom
//
// A row's status dot must show its TRUE status color. No filter may sit over it.
//
// This file replaces AgentSidebar.calmBand.test.tsx, which pinned the opposite contract. That test
// existed because the sidebar rendered "calm" rows — everything not asking for you — with
// `filter: grayscale(1) opacity(.72)`, a treatment lifted from the concierge prototype
// (PRD/sparkle/concierge-mode/prototype.html `.arow.p2`). The intent was that only the P0/P1 rows
// carry color so the eye lands on what needs you.
//
// The cost was larger than the benefit. `isCalmBand` deliberately includes `working` (a running
// agent is not asking you for anything), so a genuinely-working agent's GREEN dot rendered fully
// desaturated — and `sparkle-pulse` (opacity 1 → .35) compounded it to roughly a quarter opacity.
// On a fleet with live workers, that meant the one signal the column exists to carry, "what is
// actually running right now", was invisible. The filter was removed entirely rather than gated:
// a conditional would have left the same trap one `isCalmBand` edit away.
//
// So this file is the inverse pin. If a future change re-adds a filter over the rows, these fail
// and this comment says why they were written. `isCalmBand` itself still exists and is still
// correct for what it now governs — the TERMINAL's own xterm theme (Workspace.tsx), which
// desaturates a landed agent's text without ever touching the sidebar. Do not re-wire it here.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_STATUS } from "@sparkle/ui";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}));
vi.mock("./LogoWaveform", () => ({ LogoWaveform: () => null }));
vi.mock("./HistorySearch", () => ({ HistorySearch: () => null }));
vi.mock("../services/branchStatus", () => ({
  projectAgentsStatus: vi.fn(() => Promise.resolve([])),
  refreshAgentBranch: vi.fn(() => Promise.resolve({ ok: true })),
  landAgentBranch: vi.fn(() => Promise.resolve({ ok: true })),
}));

import { AgentSidebar } from "./AgentSidebar";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import type { AgentTab, AgentTabStatus, Project } from "../types";
import type { WorkflowStageId } from "../engine/workflowStage";
import { expectedDotColor, filterOn } from "./statusDotTestUtils";

function mkAgent(id: string, name: string): AgentTab {
  return {
    id, name, kind: "build", parentId: null, runtime: "local",
    worktreePath: null, branch: null, baseBranch: null, lastPrompt: "",
    promptHistory: [], namePinned: true, autoNameBasis: null,
    autoNameVariants: null, shellCommand: null,  } as AgentTab;
}

/** Three top-level agents spanning the three dot colors, so a single render covers every tier the
 *  old calm predicate split on:
 *    Unlanded — idle + committed work, which withUnmergedWork escalates to `unmerged` (GRAY, and
 *               the one status the calm predicate carved OUT of dimming).
 *    Finished — idle + already on main → `done` (GRAY; this row is the one the old test asserted
 *               WAS dimmed, so it is the direct regression case).
 *    Running  — `working` (GREEN). The whole point: the color must survive to the DOM.
 *  None is selected, so no row gets the active-row exemption the old filter had — the dots are
 *  read under exactly the conditions that used to gray them. */
function seed(): Project {
  const project: Project = {
    id: "p1", name: "Demo", rootPath: "/tmp/demo", defaultBranch: "main",
    createdAt: new Date(0).toISOString(), selectedAgentId: null,
    agents: [mkAgent("a1", "Unlanded"), mkAgent("a2", "Finished"), mkAgent("a3", "Running")],
  };
  useProjectStore.setState({ projects: [project] } as never);
  useRuntimeStore.setState({
    branchStatus: {},
    // `building_saved` is the committed-but-unlanded stage withUnmergedWork escalates on; `merged`
    // is past it.
    workflowStage: {
      a1: "building_saved", a2: "merged", a3: "merged",
    } as Record<string, WorkflowStageId>,
    status: { a1: "idle", a2: "idle", a3: "working" } as Record<string, AgentTabStatus>,
    openAgentIds: ["a1", "a2", "a3"],
    open: vi.fn(),
    pollBranchStatus: vi.fn(() => Promise.resolve()),
  } as never);
  return project;
}

/** The row element that used to carry the calm treatment, found from its visible name. */
function rowFor(name: string): HTMLElement {
  return screen.getByText(name).closest('[data-hint="agent"]') as HTMLElement;
}

beforeEach(() => {
  useUiStore.setState({ collapsedOrchestrators: {}, activeSpecial: null } as never);
});
afterEach(cleanup);

describe("AgentSidebar — no filter may sit over a row's status dot", () => {
  it("does not filter a genuinely finished row (the old treatment's main case)", () => {
    const project = seed();
    render(<AgentSidebar project={project} />);
    expect(filterOn(rowFor("Finished"))).toBe("");
  });

  it("does not filter a WORKING row — the case that made live state invisible", () => {
    const project = seed();
    render(<AgentSidebar project={project} />);
    expect(filterOn(rowFor("Running"))).toBe("");
  });

  it("does not filter a row whose work is committed but not landed", () => {
    const project = seed();
    render(<AgentSidebar project={project} />);
    expect(filterOn(rowFor("Unlanded"))).toBe("");
  });

  // The assertions above prove nothing is dimmed; this one proves the color actually ARRIVES. A row
  // could be unfiltered and still render a gray disc if the status plumbing were broken — which is
  // exactly the alternative root cause the removal had to rule out.
  it("paints the working dot the live GREEN, not a gray", () => {
    const project = seed();
    render(<AgentSidebar project={project} />);
    const dot = screen.getByTitle(AGENT_STATUS.working.label);
    expect(dot.style.background).toBe(expectedDotColor("working"));
    // …and it is not the gray every other status in this seed resolves to.
    expect(dot.style.background).not.toBe(expectedDotColor("done"));
    expect(filterOn(dot)).toBe("");
  });
});
