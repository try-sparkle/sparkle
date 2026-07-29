// @vitest-environment jsdom
//
// PROBE: does a drag on the concierge seam actually MOVE the column?
//
// `ColumnPullTab.test.tsx` proves the tab calls `onWidth` with the right number. Every one of those
// assertions runs against a `vi.fn()`, so none of them can see whether the committed width ever
// reaches the column. "The divider registers the drag but nothing moves" is exactly the symptom a
// mocked-callback suite cannot catch, so this asserts the delivered value instead.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: () => Promise.resolve(() => {}),
    setTitle: () => Promise.resolve(),
  }),
  getAllWindows: () => Promise.resolve([{}]),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve(null) }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));
vi.mock("../windowContext", async () => {
  const { useProjectStore } = await import("../stores/projectStore");
  return {
    useCurrentProjectId: () => useProjectStore((s) => s.selectedProjectId),
    useIsMainWindow: () => false,
    useCurrentWindowLabel: () => "main",
  };
});
vi.mock("../services/orchestrationListener", () => ({
  startOrchestrationListener: () => Promise.resolve(() => {}),
}));
vi.mock("../services/controlListener", () => ({
  startControlListener: () => Promise.resolve(() => {}),
}));
vi.mock("../services/crossWindowSync", () => ({ subscribeToCrossWindowSync: () => () => {} }));
vi.mock("../services/cloudAgents/startup", () => ({ reattachProjectOnOpen: async () => [] as string[] }));
vi.mock("../services/sparkleAgent", () => ({
  sparkleAgentIdFor: () => "sparkle",
  sparkleOpenSetWhitelist: () => [],
  shouldWarmSparkleAtLaunch: () => false,
}));
vi.mock("./AgentPane", () => ({ AgentPane: ({ agent }: { agent: { id: string } }) => <div data-testid={`pane-${agent.id}`} /> }));
vi.mock("./AgentSidebar", () => ({
  AgentSidebar: () => <div data-testid="sidebar" />,
  NewBuildAgentButton: () => null,
}));
// THE POINT OF THIS FILE. The cockpit suite stubs ConciergeHost as `() => <div/>`, which DROPS the
// width prop — so nothing downstream of `setConciergeWidth` is observable there. This stub applies
// the width the same way the real column does (`style.width`), so the assertion below reads the
// number that actually arrived.
vi.mock("./ConciergeHost", () => ({
  ConciergeHost: ({ width }: { width?: number }) => (
    <div data-testid="concierge" data-width={String(width)} style={{ width }} />
  ),
}));
vi.mock("./OfflineBanner", () => ({ OfflineBanner: () => null }));
vi.mock("./ZeroCreditBanner", () => ({ ZeroCreditBanner: () => null }));
vi.mock("./SparkleAgentPane", () => ({ SparkleAgentPane: () => null }));
vi.mock("./ProjectModal", () => ({ ProjectModal: () => null }));
vi.mock("./ClosePrompt", () => ({ ClosePrompt: () => null }));
vi.mock("./BoardView", () => ({ BoardView: () => <div data-testid="board" /> }));
vi.mock("./Concierge/KebabMenu", () => ({ ConciergeTopRight: () => null }));
vi.mock("./OpenPrMenu", () => ({ OpenPrMenu: () => null, agentLinkForBranch: () => null }));
vi.mock("./NewProjectDialog", () => ({ NewProjectDialog: () => null }));
vi.mock("./StatusStrip", () => ({ StatusStrip: () => null }));
vi.mock("./NewCloudAgentDialog", () => ({ NewCloudAgentDialog: () => null }));

import { Workspace } from "./Workspace";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useAuthStore } from "../stores/authStore";
import { useConnectionStore } from "../stores/connectionStore";
import { resetVisitedProjects } from "../services/sessionProjects";
import { resetCable } from "../stores/cableStore";
import type { AgentTab, Project } from "../types";

function mkAgent(id: string): AgentTab {
  return {
    id, name: id, kind: "build", parentId: null, runtime: "local",
    worktreePath: null, branch: null, baseBranch: null, lastPrompt: "",
    promptHistory: [], namePinned: false, autoNameBasis: null,
    autoNameVariants: null, shellCommand: null,
  };
}
function mkProject(id: string, name: string, agents: AgentTab[], selectedAgentId: string): Project {
  return { id, name, rootPath: `/tmp/${id}`, defaultBranch: null, createdAt: new Date(0).toISOString(), selectedAgentId, agents };
}

beforeEach(() => {
  localStorage.clear();
  useProjectStore.setState({
    projects: [mkProject("p1", "Alpha", [mkAgent("a1")], "a1")],
    selectedProjectId: "p1",
  } as never);
  useRuntimeStore.setState({ openAgentIds: ["a1"], status: {} } as never);
  useUiStore.setState({
    activeSpecial: null, workMode: "build", pinnedProjectId: null, openProjectIds: null,
    pairAssignment: {}, leftProjectId: null,
  } as never);
  useSettingsStore.setState({ beadsEnabled: true } as never);
  useAuthStore.setState({ me: null, tokenPresent: false, loading: false } as never);
  useConnectionStore.setState({ isOnline: true } as never);
  resetVisitedProjects();
  resetCable();
});
afterEach(() => { cleanup(); resetCable(); });

const conciergeWidth = () => screen.getByTestId("concierge").getAttribute("data-width");

/**
 * Begin the drag THE WAY A USER MUST, not the way jsdom permits.
 *
 * The tab is `pointerEvents: shown ? "auto" : "none"`, and `shown` only becomes true once the
 * pointer crosses the RAIL — the enter handler lives there, not on the tab. jsdom ignores
 * `pointer-events` for synthetic dispatch, so a bare `mouseDown` on the dots succeeds against a
 * control that is invisible and pointer-inert in a real browser.
 *
 * That matters here specifically: this component has ALREADY shipped a "dead reveal" once, where
 * the tab never became `shown` and the drag could not be started at all (roborev 54850). Skipping
 * the hover would let that exact regression return with this suite green — the same "nothing
 * happens" class of symptom the file was written to catch (roborev 55340).
 */
function grabSeam(clientX: number) {
  fireEvent.mouseEnter(screen.getByTestId("concierge-pull-tab"));
  // Assert the reveal actually happened, rather than assuming the hover took.
  expect(screen.getByTestId("concierge-pull-tab").getAttribute("data-shown")).toBe("true");
  expect(screen.getByTestId("concierge-pull-tab-tab").style.pointerEvents).toBe("auto");
  fireEvent.mouseDown(screen.getByTestId("concierge-pull-tab-dots"), { button: 0, clientX });
}

describe("dragging the concierge seam moves the column", () => {
  it("delivers the dragged width to the column, not just to the handler", () => {
    render(<Workspace />);
    expect(conciergeWidth()).toBe("360");

    grabSeam(500);
    fireEvent.mouseMove(window, { clientX: 540, buttons: 1 });
    fireEvent.mouseUp(window);

    expect(conciergeWidth()).toBe("400");
  });

  it("persists the dragged width so it survives a relaunch", () => {
    render(<Workspace />);
    grabSeam(500);
    fireEvent.mouseMove(window, { clientX: 560, buttons: 1 });
    fireEvent.mouseUp(window);

    expect(localStorage.getItem("sparkle-concierge-width")).toBe("420");
  });
});
