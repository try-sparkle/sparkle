// @vitest-environment jsdom
//
// The ROW PREVIEW pill (`row-preview`) — design doc §10's condition zero: "What appears unasked is
// a pill on the agent's row — passive, in flow, steals nothing."
//
// The whole point of the pill is that it is NOT governed by the auto-open conjunction. That
// conjunction gates the PANE, which can take the screen; the pill takes nothing, so it shows
// whenever this agent has a live server — including under `auto_open = "never"`, and including on
// a row whose pair is on Plan. These tests pin that separation from both directions, because a
// future reader looking at `previewOpenOutcomeFor` will reasonably assume the pill goes through it.
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
  projectAgentsStatus: vi.fn(() => Promise.resolve([])),
  refreshAgentBranch: vi.fn(() => Promise.resolve({ ok: true })),
  landAgentBranch: vi.fn(() => Promise.resolve({ ok: true })),
}));

import { AgentSidebar } from "./AgentSidebar";
import { usePreviewStore, type PreviewEntry, type PreviewState } from "../stores/previewStore";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useUiStore } from "../stores/uiStore";
import { useHelperPrefs } from "../helper/helperPrefs";
import { allBandsVisible } from "../engine/buildSections";
import type { AgentTab, Project } from "../types";

function mkAgent(id: string, name: string, over: Partial<AgentTab> = {}): AgentTab {
  return {
    id, name, kind: "build", parentId: null, runtime: "local",
    worktreePath: "/tmp/wt", branch: null, baseBranch: null, lastPrompt: "",
    promptHistory: [], namePinned: true, autoNameBasis: null,
    autoNameVariants: null, shellCommand: null, ...over,
  };
}

function entry(over: Partial<PreviewEntry> = {}): PreviewEntry {
  return {
    id: "srv-1",
    status: "serving" as PreviewState,
    url: "http://127.0.0.1:5173",
    port: 5173,
    error: null,
    startedAt: Date.now(),
    reloadNonce: 0,
    surfacedAt: Date.now(),
    ...over,
  };
}

/** One build agent "a1" in project p1, with whatever preview state the row should see. */
function seed(preview: PreviewEntry | null, over: Partial<AgentTab> = {}): Project {
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
  usePreviewStore.setState({
    byAgent: preview ? { a1: preview } : {},
    capability: {},
    openedProjects: {},
  } as never);
  return project;
}

const rowFor = (name: string) =>
  screen.getByText(name).closest('[data-hint="agent"]') as HTMLElement;
const pillOf = (name: string) =>
  rowFor(name).querySelector<HTMLElement>('[data-testid="row-preview"]');

beforeEach(() => {
  useUiStore.setState({
    collapsedOrchestrators: {},
    activeSpecial: null,
    workModeBySide: { left: "build", right: "build" },
    statusFilter: allBandsVisible(),
  } as never);
  useSettingsStore.setState({ previewAutoOpen: "returning" } as never);
  useHelperPrefs.setState({ enabled: true } as never);
});
afterEach(() => {
  cleanup();
  usePreviewStore.setState({ byAgent: {}, capability: {}, openedProjects: {} } as never);
  useUiStore.setState({
    workModeBySide: { left: "build", right: "build" },
    activeSpecial: null,
  } as never);
});

describe("the row PREVIEW pill", () => {
  it("appears, naming the port, when the agent has a live server", () => {
    render(<AgentSidebar project={seed(entry())} />);
    const pill = pillOf("Alpha");
    expect(pill).toBeTruthy();
    // Short enough for the row's tail. The FULL url rides the tooltip — same split as `row-stall`,
    // whose chip shows one basename and whose title carries every path.
    expect(pill!.textContent).toContain("5173");
    expect(pill!.getAttribute("title")).toContain("http://127.0.0.1:5173");
  });

  // THE mutation-check target for the visibility guard: render it unconditionally and this finds a
  // pill.
  it("is HIDDEN when the agent has no preview at all", () => {
    render(<AgentSidebar project={seed(null)} />);
    expect(pillOf("Alpha")).toBeNull();
  });

  it("is hidden while the server is still starting — there is nothing to point at yet", () => {
    render(
      <AgentSidebar project={seed(entry({ status: "starting", url: null, port: null }))} />,
    );
    expect(pillOf("Alpha")).toBeNull();
  });

  it.each(["failed", "crashed", "stopped"] as const)(
    "is hidden for a %s server — the pill means 'there is something to see'",
    (status) => {
      render(<AgentSidebar project={seed(entry({ status }))} />);
      expect(pillOf("Alpha")).toBeNull();
    },
  );

  it("is hidden when the pane is ALREADY showing this agent's preview", () => {
    // Ambient means "there is something you are not looking at". With the preview on screen the
    // pill would be a second rendering of a fact the pane is already making unmissable.
    useUiStore.setState({ workModeBySide: { left: "build", right: "preview" } } as never);
    const project = seed(entry());
    useProjectStore.setState({
      projects: [{ ...project, selectedAgentId: "a1" }],
    } as never);
    render(<AgentSidebar project={{ ...project, selectedAgentId: "a1" }} />);
    expect(pillOf("Alpha")).toBeNull();
  });

  it("still appears while that pair previews a DIFFERENT agent", () => {
    useUiStore.setState({ workModeBySide: { left: "build", right: "preview" } } as never);
    const project: Project = {
      id: "p1", name: "Demo", rootPath: "/tmp/demo", defaultBranch: "main",
      createdAt: new Date(0).toISOString(), selectedAgentId: "a2",
      agents: [mkAgent("a1", "Alpha"), mkAgent("a2", "Beta")],
    };
    useProjectStore.setState({ projects: [project] } as never);
    useRuntimeStore.setState({
      branchStatus: {}, workflowStage: { a1: "building_saved", a2: "building_saved" }, status: {},
      openAgentIds: ["a1", "a2"],
      open: vi.fn(),
      pollBranchStatus: vi.fn(() => Promise.resolve()),
    } as never);
    usePreviewStore.setState({
      byAgent: { a1: entry() },
      capability: {},
      openedProjects: {},
    } as never);
    render(<AgentSidebar project={project} />);
    // The pane is showing Beta; Alpha's server is live and off screen, which is exactly what an
    // ambient indicator is for.
    expect(pillOf("Alpha")).toBeTruthy();
  });

  // ══ THE SEPARATION FROM THE PANE GATE ══════════════════════════════════════════════════════
  //
  // Both rows below hold states in which `previewOpenOutcomeFor` declines. If the pill were ever
  // routed through that predictor — the obvious-looking simplification — each of these goes red.

  it('shows under auto_open = "never", which governs the PANE and not the pill', () => {
    useSettingsStore.setState({ previewAutoOpen: "never" } as never);
    render(<AgentSidebar project={seed(entry())} />);
    expect(pillOf("Alpha")).toBeTruthy();
  });

  it("shows for a server whose surfacing moment is long past the auto-open TTL", () => {
    // `previewOpenOutcomeFor` answers `declined-stale` here — the pane's 5s window has closed. The
    // pill has no window: the server is still up, so there is still something to see, and history
    // is exactly what an ambient row indicator is for. (Deliberately NOT tested via `workMode:
    // "plan"`, which is the other conjunction decline: the sidebar swaps itself for the board in
    // that mode, so there is no agent row to carry a pill and the test would prove nothing.)
    render(<AgentSidebar project={seed(entry({ surfacedAt: Date.now() - 10 * 60_000 }))} />);
    expect(pillOf("Alpha")).toBeTruthy();
  });

  it("shows for a project the user has never manually previewed this session", () => {
    // `openedProjects` is empty in every seed above — condition 2 of the conjunction fails, and the
    // pill does not care. This is the whole design: the pill is how a first-time preview becomes
    // discoverable at all.
    render(<AgentSidebar project={seed(entry())} />);
    expect(usePreviewStore.getState().openedProjects).toEqual({});
    expect(pillOf("Alpha")).toBeTruthy();
  });
});
