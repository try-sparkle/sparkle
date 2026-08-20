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

  // ── THE PANE GATE IS GONE, AND SO ARE THE TWO ROWS THAT PINNED IT ────────────────────────────
  //
  // The pill used to hide while the pair's preview PANE showed this same agent: ambient means "there
  // is something you are not looking at", and beside a live pane the pill was a second rendering of
  // an unmissable fact. That pane no longer exists (founder, 2026-08-19: a preview is a card in the
  // concierge chat), so a live preview is ALWAYS off-screen from a sidebar row's point of view and
  // the pill is always the honest readout. The two rows that asserted the gate — hidden when the
  // pane showed this agent, shown when it showed a different one — were deleted rather than
  // rewritten, because neither state is reachable any more.
  //
  // WHAT REPLACES THEM is the row below: the pill's presence no longer depends on any work mode at
  // all, which is the property that could regress if someone re-introduced a visibility gate keyed
  // to something the sidebar cannot see.
  // THIS IS THE EXACT STATE THE OLD GATE SUPPRESSED — this agent SELECTED in its own pair — so the
  // row goes red if a visibility gate keyed to the selection is ever reintroduced. `"plan"` is not
  // worth a second iteration here: it short-circuits the row list entirely, so there would be no
  // row to carry a pill and the assertion could not distinguish the gate from the empty list.
  it("shows the pill even when this agent is the SELECTED one in its pair", () => {
    useUiStore.setState({ workModeBySide: { left: "build", right: "build" } } as never);
    const project = seed(entry());
    useProjectStore.setState({
      projects: [{ ...project, selectedAgentId: "a1" }],
    } as never);
    render(<AgentSidebar project={{ ...project, selectedAgentId: "a1" }} />);
    expect(pillOf("Alpha")).toBeTruthy();
  });

  // ══ THE SEPARATION FROM THE PANE GATE ══════════════════════════════════════════════════════
  //
  // The row below used to be one of three, each holding a state in which the retired auto-open
  // predictor declined — the guard against routing the pill through that predictor. The predictor
  // and its `auto_open` key are gone (founder, 2026-08-19: no pane, so nothing to decide), so the
  // two rows keyed to its specific declines went with them. THIS one survives because it does not
  // depend on the predictor at all: it is about the pill having no window of its own.

  it("shows for a server whose surfacing moment is long in the past", () => {
    // The server is still up, so there is still something to see. An ambient row indicator that
    // expired would be worse than none: the reader would learn that its absence means nothing.
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
