// @vitest-environment jsdom
//
// A ROW THE CHILD-TASK FILTER HIDES MUST NOT KEEP PAINTING ITS TERMINAL.
//
// `Workspace` already carries this rule for the EPIC rung, and states it at the call site: "if it
// ends up filtering the build row, just clear the terminal" (founder), because a stage still
// showing the terminal of a row the column no longer paints is the "output with no row" mismatch
// the board and preview slots each force `null` to avoid.
//
// THE CHILD RUNG IS THE SAME RULE ONE STEP DOWN, and it is a REGRESSION TEST rather than a new
// feature's test: when `beadFocusBySide` was added, the build column learned it and `Workspace` did
// not. `Workspace` went on reading `epicFocusBySide` alone, so selecting a child task hid the row
// in the column while its terminal went on painting beside the gap — worse than the epic bug it
// mirrors, because a child narrows harder and so hides the selected row far more often.
//
// ══ WHAT IS ASSERTED, AND WHY IT IS NOT THE STORE ══════════════════════════════════════════════
//
// The pane's own rendered visibility, through the REAL `paneVisibilityStyle` the production panes
// use (panes never `display: none`; they stay laid out and hide with `visibility`). Asserting
// `focusedBeadIdForSide(...)` instead would be asserting the precondition — it is true the moment
// the selector exists and stays true while nothing consumes it, which is exactly the state this
// file was written to catch.
//
// ══ AND WHY BOTH DIRECTIONS ARE HERE ═══════════════════════════════════════════════════════════
//
// "The terminal is hidden" alone passes for a change that hides the terminal under ANY focus, or
// under none — which would blank the stage for every user who ever clicks an epic. So every case
// below names the agent that must STAY on screen in the same breath as the one that must go.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  emit: vi.fn(() => Promise.resolve()),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}));
// The real `getCurrentWebview()` throws outside a Tauri window and the drop hooks call it at mount —
// an unhandled rejection that kills every case before an assertion is reached.
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));
vi.mock("../services/orchestrationListener", () => ({
  startOrchestrationListener: () => Promise.resolve(() => {}),
}));
vi.mock("../services/controlListener", () => ({
  startControlListener: () => Promise.resolve(() => {}),
}));
vi.mock("../services/crossWindowSync", () => ({ subscribeToCrossWindowSync: () => () => {} }));
vi.mock("../services/cloudAgents/startup", () => ({
  reattachProjectOnOpen: async () => [] as string[],
}));
vi.mock("../services/branchStatus", () => ({
  refreshAgentBranch: vi.fn(() => Promise.resolve({ ok: true })),
  landAgentBranch: vi.fn(() => Promise.resolve({ ok: true })),
  projectAgentsStatus: vi.fn(() => Promise.resolve([])),
}));
vi.mock("../services/sparkleAgent", async (orig) => ({
  ...(await orig<typeof import("../services/sparkleAgent")>()),
  sparkleAgentIdFor: () => "__sparkle_self__",
  sparkleOpenSetWhitelist: () => [],
  shouldWarmSparkleAtLaunch: () => false,
}));
vi.mock("../services/concierge", () => ({
  // The failure handler reads the failed turn's account via turnAccountFor(e.id); a mock that omits
  // it throws 'No turnAccountFor export' the moment an auth/quota failure reaches that branch. null =
  // 'turn not remembered', which the rotation degrades on.
  turnAccountFor: () => null,
  startConciergeTurn: vi.fn(async () => null),
  startProactiveConciergeTurn: vi.fn(async () => null),
  isProactiveTurn: () => false,
  onConciergeTool: () => () => {},
  onConciergeDelta: () => () => {},
  onConciergeDone: () => () => {},
  onConciergeError: () => () => {},
  onConciergeTurnsAbandoned: () => () => {},
  isSupersededDetail: () => false,
  SUPERSEDED_DETAILS: [],
}));
vi.mock("../services/conciergeRouter", () => ({
  routeMessage: vi.fn(async () => ({ target: "sparkle", reason: "test", source: "heuristic" })),
}));

// ── THE PANE MOCK CARRIES THE REAL VISIBILITY STYLE ────────────────────────────────────────────
// Not a bare `<div/>`: it renders `paneVisibilityStyle(visible)`, the SAME helper the production
// panes use, so the `visibility` read below is the real contract rather than a stand-in this file
// invented. The `visible` prop still comes from the real `Workspace` → `AgentPaneList` chain, which
// is the seam under test.
vi.mock("./AgentPane", async () => {
  const { paneVisibilityStyle } = await import("./paneVisibility");
  return {
    AgentPane: ({ agent, visible }: { agent: { id: string }; visible: boolean }) => (
      <div
        data-testid={`pane-${agent.id}`}
        data-visible={String(visible)}
        style={paneVisibilityStyle(visible)}
      />
    ),
  };
});
vi.mock("./SparkleAgentPane", async () => {
  const { paneVisibilityStyle } = await import("./paneVisibility");
  return {
    SparkleAgentPane: ({ visible }: { visible: boolean }) => (
      <div data-testid="sparkle-pane" data-visible={String(visible)} style={paneVisibilityStyle(visible)} />
    ),
  };
});
vi.mock("./ConciergeHost", () => ({ ConciergeHost: () => <div data-testid="concierge" /> }));
vi.mock("./OfflineBanner", () => ({ OfflineBanner: () => null }));
vi.mock("./ZeroCreditBanner", () => ({ ZeroCreditBanner: () => null }));
vi.mock("./ProjectModal", () => ({ ProjectModal: () => null }));
vi.mock("./ClosePrompt", () => ({ ClosePrompt: () => null }));
vi.mock("./BoardView", () => ({ BoardView: () => <div data-testid="board" /> }));
vi.mock("./Concierge/KebabMenu", () => ({ ConciergeTopRight: () => null }));
vi.mock("./OpenPrMenu", () => ({ OpenPrMenu: () => null, agentLinkForBranch: () => null }));
vi.mock("./NewProjectDialog", () => ({ NewProjectDialog: () => null }));
vi.mock("./StatusStrip", () => ({ StatusStrip: () => null }));
vi.mock("./NewCloudAgentDialog", () => ({ NewCloudAgentDialog: () => null }));
vi.mock("./LogoWaveform", () => ({ LogoWaveform: () => null }));
vi.mock("./BalanceBadge", () => ({ BalanceBadge: () => null }));
vi.mock("./HistorySearch", () => ({ HistorySearch: () => null }));

import { Workspace } from "./Workspace";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useBeadsStore } from "../stores/beadsStore";
import { useConnectionStore } from "../stores/connectionStore";
import { bucketBeads, type Bead } from "../services/beads";
import { resetVisitedProjects } from "../services/sessionProjects";
import { resetCable } from "../stores/cableStore";
import { enableAiEnhancementsForTests } from "../testing/aiEnhancements";
import type { AgentTab, Project } from "../types";

function mkAgent(id: string, name: string, over: Partial<AgentTab> = {}): AgentTab {
  return {
    id, name, kind: "build", parentId: null, runtime: "local",
    worktreePath: null, branch: null, baseBranch: null, lastPrompt: "",
    promptHistory: [], namePinned: true, autoNameBasis: null,
    autoNameVariants: null, shellCommand: null, ...over,
  };
}
function bead(id: string, over: Partial<Bead> = {}): Bead {
  return { id, title: id, status: "open", labels: [], ...over } as Bead;
}

const BEADS: Bead[] = [bead("ep-1"), bead("ep-1.a"), bead("ep-1.b"), bead("ep-2"), bead("ep-2.a")];

/** ALPHA IS THE SELECTED AGENT IN EVERY CASE — it is the one whose terminal the stage is painting,
 *  so it is the one the filter has to be able to take away. BRAVO is its SIBLING task's agent, and
 *  is what makes each case a real discrimination rather than a blanket "hide everything". */
const AGENTS = [
  mkAgent("alpha", "Alpha", { beadId: "ep-1.a" }),
  mkAgent("bravo", "Bravo", { beadId: "ep-1.b" }),
  mkAgent("zulu", "Zulu", { beadId: "ep-2.a" }),
];

/** IS THIS AGENT'S TERMINAL ON SCREEN? Collapses "never portalled" and "portalled but hidden" into
 *  the one user-visible fact, so a case cannot accidentally assert which of the two occurred. */
function terminalOnScreen(id: string): boolean {
  const el = document.querySelector<HTMLElement>(`[data-testid="pane-${id}"]`);
  if (!el) return false;
  return getComputedStyle(el).visibility === "visible";
}

async function mount() {
  render(<Workspace />);
  await screen.findAllByTestId(/^pane-/);
}

/** Writes the focus AFTER the mount, so each case is a real transition from a painted terminal to a
 *  hidden one rather than a first render that never painted it. */
function focus(epicId: string | null, beadId: string | null) {
  act(() => {
    useUiStore.setState({
      epicFocusBySide: { left: null, right: epicId },
      beadFocusBySide: { left: null, right: beadId },
    } as never);
  });
}

beforeEach(() => {
  useProjectStore.setState({
    projects: [
      {
        id: "p1", name: "Demo", rootPath: "/tmp/p1", defaultBranch: "main",
        createdAt: new Date(0).toISOString(), selectedAgentId: "alpha", agents: AGENTS,
      } as Project,
    ],
    selectedProjectId: "p1",
  } as never);
  useRuntimeStore.setState({ openAgentIds: ["alpha", "bravo", "zulu"], status: {} } as never);
  useUiStore.setState({
    activeSpecial: null,
    workModeBySide: { left: "build", right: "build" },
    epicFocusBySide: { left: null, right: null },
    beadFocusBySide: { left: null, right: null },
    pinnedProjectId: null,
    openProjectIds: null,
    pairAssignment: {},
    leftProjectId: null,
    collapsedOrchestrators: {},
  } as never);
  useBeadsStore.setState({
    byProject: { p1: { beads: BEADS, board: bucketBeads(BEADS), polledAt: 0 } },
    error: {},
  } as never);
  useSettingsStore.setState({ beadsEnabled: true } as never);
  useConnectionStore.setState({ isOnline: true } as never);
  enableAiEnhancementsForTests();
  resetVisitedProjects();
  resetCable();
});

afterEach(() => {
  cleanup();
  resetCable();
  useUiStore.setState({
    epicFocusBySide: { left: null, right: null },
    beadFocusBySide: { left: null, right: null },
  } as never);
});

describe("the stage follows the CHILD-TASK filter, not just the epic one", () => {
  // THE PREMISE. Every "it went away" below is only meaningful if it was there to begin with — and
  // this is also the guard against a fix that hides the stage whenever anything at all is focused.
  it("paints the selected agent's terminal while nothing is focused", async () => {
    await mount();
    expect(terminalOnScreen("alpha")).toBe(true);
  });

  // THE REGRESSION, stated as the founder would see it: click a sibling task and the row you were
  // reading leaves the column — so its terminal has to leave the stage with it. Before the fix this
  // stayed `true`, because `Workspace` was asking about `epicFocusBySide` alone and the epic still
  // contained Alpha.
  it("STOPS painting a terminal whose row the child filter hides", async () => {
    await mount();
    expect(terminalOnScreen("alpha")).toBe(true);
    focus("ep-1", "ep-1.b"); // Bravo's task — Alpha is not on it
    expect(terminalOnScreen("alpha")).toBe(false);
  });

  // THE OTHER HALF, and the one that stops the case above passing for "hide it under any focus".
  // Same gesture, the child Alpha IS on, and the terminal stays.
  it("KEEPS painting it when the focused child is that agent's own task", async () => {
    await mount();
    focus("ep-1", "ep-1.a"); // Alpha's own task
    expect(terminalOnScreen("alpha")).toBe(true);
  });

  // COMPOSITION, through the stage. Clearing the child returns to the EPIC — which still contains
  // Alpha — so the terminal has to come back rather than staying dark until the epic is re-picked.
  it("brings the terminal back when the child is cleared, because the epic still holds that row", async () => {
    await mount();
    focus("ep-1", "ep-1.b");
    expect(terminalOnScreen("alpha")).toBe(false);
    focus("ep-1", null);
    expect(terminalOnScreen("alpha")).toBe(true);
  });

  // AND THE EPIC RUNG IS UNTOUCHED — the behaviour that already worked, asserted here so a change
  // to the shared selector cannot quietly break it while the two new cases above stay green.
  it("still hides a terminal the EPIC filter hides, with no child selected", async () => {
    await mount();
    focus("ep-2", null); // a different epic entirely; Alpha is not in it
    expect(terminalOnScreen("alpha")).toBe(false);
  });
});
