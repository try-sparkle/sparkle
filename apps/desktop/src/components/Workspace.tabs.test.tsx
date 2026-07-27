// @vitest-environment jsdom
//
// The single-window tabbed shell (bead sparkle-qd80 / CM-U7). Three contracts that the old
// multi-window shell got for free and this one has to earn:
//
//   1. A visited project's open agents stay MOUNTED once mounted; only the selected tab's selected
//      agent is visible. A Terminal unmount kills its PTY, so unmounting the tab you leave would
//      kill that project's agents — the regression this pins. Mounting is LAZY (a project you have
//      never selected this session doesn't spawn its PTYs) but STICKY (the set never shrinks).
//   2. Clicking a tab selects that project (projectStore.selectProject) and the pane visibility
//      follows it.
//   3. Plan mode collapses columns 2+3 into one wide Plan column, laid OVER the panes (they stay
//      mounted), and Build splits them back.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// setTitle is a spy (hoisted, because vi.mock factories are) so the window-title contract below can
// assert what the shell actually named the window.
const setTitleSpy = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: () => Promise.resolve(() => {}),
    setTitle: setTitleSpy,
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
    useIsMainWindow: () => false, // avoids the launch-warm / reap paths
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
// Cloud re-attach: observed, not run. `null` is its "never got a useful answer" contract, which is
// what makes a project eligible for a retry (roborev 52648/52649).
const reattach = vi.hoisted(() => vi.fn(async (_id: string): Promise<string[] | null> => []));
vi.mock("../services/cloudAgents/startup", () => ({ reattachProjectOnOpen: reattach }));
vi.mock("../services/sparkleAgent", () => ({
  sparkleAgentIdFor: () => "sparkle",
  sparkleOpenSetWhitelist: () => [],
  shouldWarmSparkleAtLaunch: () => false,
}));

// Heavy / Tauri-bound children: stubbed so only the shell's own wiring is exercised. AgentPane
// reports which agent it mounted and whether it's visible — the assertions above depend on it.
vi.mock("./AgentPane", () => ({
  AgentPane: ({
    agent,
    visible,
    calm,
  }: {
    agent: { id: string };
    visible: boolean;
    calm?: boolean;
  }) => (
    <div
      data-testid={`pane-${agent.id}`}
      data-visible={String(visible)}
      data-calm={String(!!calm)}
    />
  ),
}));
vi.mock("./AgentSidebar", () => ({
  AgentSidebar: () => <div data-testid="sidebar" />,
  NewBuildAgentButton: () => null,
}));
vi.mock("./ConciergeHost", () => ({ ConciergeHost: () => <div data-testid="concierge" /> }));
vi.mock("./OfflineBanner", () => ({ OfflineBanner: () => null }));
vi.mock("./SparkleAgentPane", () => ({ SparkleAgentPane: () => null }));
vi.mock("./ProjectModal", () => ({ ProjectModal: () => null }));
vi.mock("./ClosePrompt", () => ({ ClosePrompt: () => null }));
vi.mock("./BoardView", () => ({ BoardView: () => <div data-testid="board" /> }));
vi.mock("./Concierge/KebabMenu", () => ({ ConciergeTopRight: () => null }));
vi.mock("./OpenPrMenu", () => ({ OpenPrMenu: () => null, agentLinkForBranch: () => null }));
vi.mock("./NewProjectDialog", () => ({ NewProjectDialog: () => null }));

import { Workspace, WINDOW_TITLE } from "./Workspace";
import { useProjectStore } from "../stores/projectStore";
import { useAuthStore } from "../stores/authStore";
import { useConnectionStore } from "../stores/connectionStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import { useSettingsStore } from "../stores/settingsStore";
import {
  onVisitedProjectsChange,
  resetVisitedProjects,
  visitedProjectsVersion,
  wasProjectVisited,
} from "../services/sessionProjects";
import type { AgentTab, Project } from "../types";

function mkAgent(id: string): AgentTab {
  return {
    id, name: id, kind: "build", parentId: null, runtime: "local",
    worktreePath: null, branch: null, baseBranch: null, lastPrompt: "",
    promptHistory: [], namePinned: false, autoNameBasis: null,
    autoNameVariants: null, shellCommand: null, pinnedIndex: null,
  };
}
function mkProject(id: string, name: string, agents: AgentTab[], selectedAgentId: string): Project {
  return {
    id, name, rootPath: `/tmp/${id}`, defaultBranch: null,
    createdAt: new Date(0).toISOString(), selectedAgentId, agents,
  };
}

beforeEach(() => {
  useProjectStore.setState({
    projects: [
      mkProject("p1", "Alpha", [mkAgent("a1")], "a1"),
      mkProject("p2", "Beta", [mkAgent("b1")], "b1"),
    ],
    selectedProjectId: "p1",
  } as never);
  useRuntimeStore.setState({ openAgentIds: ["a1", "b1"], status: {} } as never);
  useUiStore.setState({ activeSpecial: null, workMode: "build", pinnedProjectId: null } as never);
  useSettingsStore.setState({ beadsEnabled: true } as never);
  reattach.mockClear();
  reattach.mockResolvedValue([]);
  useAuthStore.setState({
    me: { clerkUserId: "u1", entitled: true, balanceCents: 500, tokenVersion: 1, cloudAgentsEnabled: true },
    tokenPresent: true,
    loading: false,
  } as never);
  useConnectionStore.setState({ isOnline: true } as never);
  resetVisitedProjects();
  setTitleSpy.mockClear();
});
afterEach(() => cleanup());

// The window is named for the APP, not the selected project — the tab bar is what says which
// project you're on. Regression guard: the title used to track projectName, so a repo folder called
// "sparkle-desktop" made the macOS titlebar read as a different app than the one you launched.
describe("Workspace — window title", () => {
  // The flag must stay set for the WHOLE test, not just the render (roborev 53003): the title
  // effect early-returns without `__TAURI_INTERNALS__`, so tearing it down straight after mount
  // would make the no-retitle guard below vacuous — it would pass even if the effect still had
  // `[projectName]` as its dep, which is precisely the regression it claims to pin.
  const w = window as unknown as Record<string, unknown>;
  beforeEach(() => {
    w.__TAURI_INTERNALS__ = {};
  });
  afterEach(() => {
    delete w.__TAURI_INTERNALS__;
  });

  it('titles the window "Sparkle", not the selected project', async () => {
    render(<Workspace />);
    await waitFor(() => expect(setTitleSpy).toHaveBeenCalled());
    expect(setTitleSpy).toHaveBeenCalledWith(WINDOW_TITLE);
    expect(setTitleSpy).toHaveBeenCalledWith("Sparkle");
    // "Alpha" is the selected project (see beforeEach) — it must never reach the titlebar.
    expect(setTitleSpy).not.toHaveBeenCalledWith("Alpha");
  });

  it("does not re-title when you switch tabs — the name is constant", async () => {
    render(<Workspace />);
    await waitFor(() => expect(setTitleSpy).toHaveBeenCalled());
    const callsAfterBoot = setTitleSpy.mock.calls.length;
    act(() => {
      fireEvent.click(screen.getByTestId("tab-p2"));
    });
    await waitFor(() => expect(screen.getByTestId("tab-p2").getAttribute("aria-selected")).toBe("true"));
    // Beta is now selected. A projectName-keyed effect would have fired again here.
    expect(setTitleSpy.mock.calls.length).toBe(callsAfterBoot);
    expect(setTitleSpy).not.toHaveBeenCalledWith("Beta");
  });
});

describe("Workspace — project tabs drive the shell", () => {
  it("mounts only the SELECTED project's open agents at boot (no cross-project spawn storm)", async () => {
    render(<Workspace />);
    // The panes are code-split — let the lazy chunk resolve before asserting.
    await screen.findByTestId("pane-a1");
    expect(screen.getByTestId("pane-a1").dataset.visible).toBe("true");
    // Beta was never selected this session: mounting it would spawn a PTY + `claude --resume`
    // for an agent the user hasn't looked at.
    expect(screen.queryByTestId("pane-b1")).toBeNull();
  });

  it("clicking a tab mounts that project's panes and flips which one is visible", async () => {
    render(<Workspace />);
    await screen.findByTestId("pane-a1");
    fireEvent.click(screen.getByTestId("tab-p2"));
    expect(useProjectStore.getState().selectedProjectId).toBe("p2");
    // Mounted in the SAME commit as the selection — no frame showing Beta's empty state.
    expect(screen.getByTestId("pane-b1").dataset.visible).toBe("true");
    // …and Alpha is still mounted, merely hidden: unmounting it would kill its PTY.
    expect(screen.getByTestId("pane-a1").dataset.visible).toBe("false");
  });

  it("keeps a visited project mounted after you leave it (the set only grows)", async () => {
    render(<Workspace />);
    await screen.findByTestId("pane-a1");
    fireEvent.click(screen.getByTestId("tab-p2"));
    fireEvent.click(screen.getByTestId("tab-p1"));
    // Both survive the round trip.
    expect(screen.getByTestId("pane-a1").dataset.visible).toBe("true");
    expect(screen.getByTestId("pane-b1").dataset.visible).toBe("false");
  });

  it("records the tab selection in the SHARED module, and NOTIFIES — both halves the roster needs", async () => {
    // Scope, precisely (roborev 46905): deleting the effect outright already fails the
    // lazy-mount cases above, since they mount panes through wasProjectVisited. What they do NOT
    // catch is Workspace going back to a component-LOCAL mirror of the set — the divergence
    // roborev 46351 fixed — because the panes would still mount from the mirror while the roster
    // publisher, which lives outside this tree, read an empty shared set.
    //
    // The version bump is the other half: useRosterPublisher subscribes via
    // useSyncExternalStore(onVisitedProjectsChange, visitedProjectsVersion), so a writer that adds
    // the id WITHOUT notifying leaves the publisher on its pre-visit snapshot until an unrelated
    // re-render happens to correct it — and a membership-only assertion passes in that world.
    render(<Workspace />);
    await screen.findByTestId("pane-a1");
    await waitFor(() => expect(wasProjectVisited("p1")).toBe(true));
    expect(wasProjectVisited("p2")).toBe(false);

    const versionBefore = visitedProjectsVersion();
    const notified = vi.fn();
    const off = onVisitedProjectsChange(notified);
    fireEvent.click(screen.getByTestId("tab-p2"));
    await waitFor(() => expect(wasProjectVisited("p2")).toBe(true));
    expect(visitedProjectsVersion()).toBeGreaterThan(versionBefore);
    expect(notified).toHaveBeenCalled();
    off();
  });

  it("renders a tab per project, marking the selected one", () => {
    render(<Workspace />);
    expect(screen.getByTestId("tab-p1").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("tab-p2").getAttribute("aria-selected")).toBe("false");
  });

  it("the tab pin toggles the concierge's scope (one pin at a time)", () => {
    render(<Workspace />);
    fireEvent.click(screen.getByTestId("pin-p2"));
    expect(useUiStore.getState().pinnedProjectId).toBe("p2");
    fireEvent.click(screen.getByTestId("pin-p1"));
    expect(useUiStore.getState().pinnedProjectId).toBe("p1"); // replaced, not added
    fireEvent.click(screen.getByTestId("pin-p1"));
    expect(useUiStore.getState().pinnedProjectId).toBeNull(); // pinning the pinned one unpins
  });
});

describe("Workspace — depth layers + calm desaturation", () => {
  it("hands calm to the VISIBLE pane while its agent is calm (P2)", async () => {
    render(<Workspace />);
    await screen.findByTestId("pane-a1");
    // No live status → the feed bands the agent P2 (calm).
    expect(screen.getByTestId("terminal-stage").dataset.calm).toBe("true");
    expect(screen.getByTestId("pane-a1").dataset.calm).toBe("true");
    // The desaturation is the PANE's (its terminal theme), never a filter on the stage: that
    // filter re-composited the WebGL canvas every frame and became a containing block for the
    // fixed-position overlays inside it (roborev 46254-M2/M3).
    expect(screen.getByTestId("terminal-stage").style.filter).toBe("");
  });

  it("restores color the moment that agent needs you (P0)", async () => {
    render(<Workspace />);
    await screen.findByTestId("pane-a1");
    await act(async () => useRuntimeStore.setState({ status: { a1: "waiting" } } as never));
    expect(screen.getByTestId("terminal-stage").dataset.calm).toBe("false");
    expect(screen.getByTestId("pane-a1").dataset.calm).toBe("false");
  });

  it("keeps color while the Plan board is up — calm is a property of a VISIBLE agent pane", async () => {
    render(<Workspace />);
    await screen.findByTestId("pane-a1");
    await act(async () => {
      useUiStore.getState().setActiveSpecial("board");
      useUiStore.getState().setWorkMode("plan");
    });
    // The agent behind the board is still P2, but nothing of its terminal is on screen — and the
    // stage now holds the board. Graying here would gray the board (roborev 46254-M1).
    expect(screen.getByTestId("terminal-stage").dataset.calm).toBe("false");
    expect(screen.getByTestId("pane-a1").dataset.calm).toBe("false");
  });

  it("keeps color when no agent is selected — the onboarding empty state is not a calm terminal", async () => {
    await act(async () => {
      useProjectStore.setState({
        projects: [{ ...useProjectStore.getState().projects[0]!, agents: [], selectedAgentId: null }],
      } as never);
      useRuntimeStore.setState({ openAgentIds: [] } as never);
    });
    render(<Workspace />);
    // This used to default to calm and put grayscale(1) over the whole first-run screen — the
    // "Welcome to Sparkle" copy and the teal CTA included (roborev 46254-M1).
    expect(screen.getByTestId("terminal-stage").dataset.calm).toBe("false");
  });
});

describe("Workspace — Plan mode collapses columns 2+3", () => {
  it("shows no Plan column in Build mode", () => {
    render(<Workspace />);
    expect(screen.queryByTestId("plan-column")).toBeNull();
    expect(screen.getByTestId("sidebar")).toBeTruthy();
  });

  it("lays one wide Plan column over the panes, which stay mounted", async () => {
    render(<Workspace />);
    await screen.findByTestId("pane-a1");
    await act(async () => {
      useUiStore.getState().setActiveSpecial("board");
      useUiStore.getState().setWorkMode("plan");
    });
    expect(screen.getByTestId("plan-column")).toBeTruthy();
    expect(screen.getByTestId("board")).toBeTruthy();
    // The panes are covered, not torn down — their PTYs must survive a mode flip.
    expect(screen.getByTestId("pane-a1")).toBeTruthy();
    expect(screen.getByTestId("pane-a1").dataset.visible).toBe("false");
  });

  it("the Plan column's Build chevron splits the columns back apart", async () => {
    render(<Workspace />);
    await screen.findByTestId("pane-a1");
    await act(async () => {
      useUiStore.getState().setActiveSpecial("board");
      useUiStore.getState().setWorkMode("plan");
    });
    fireEvent.click(screen.getByTitle("Build mode — your Build orchestrator agents"));
    expect(screen.queryByTestId("plan-column")).toBeNull();
    expect(useUiStore.getState().workMode).toBe("build");
    expect(useUiStore.getState().activeSpecial).toBeNull();
    expect(screen.getByTestId("pane-a1").dataset.visible).toBe("true");
  });

  it("stays out of Plan mode when the Beads tool is off (no board to show)", async () => {
    useSettingsStore.setState({ beadsEnabled: false } as never);
    render(<Workspace />);
    await act(async () => useUiStore.getState().setActiveSpecial("board"));
    expect(screen.queryByTestId("plan-column")).toBeNull();
  });
});

// The re-attach effect's retry rule. A cloud session keeps running while the laptop is closed, so
// the ONE reconciliation pass a project gets is the difference between finding your agent where you
// left it and an empty sidebar with an invisible meter still billing.
describe("Workspace — cloud re-attach is attempted once, and retried when it never answered", () => {
  it("does not even try while the cloud capability is absent (a local-only user)", async () => {
    useAuthStore.setState({ me: { clerkUserId: "u1", entitled: true, balanceCents: 0, tokenVersion: 1 }, tokenPresent: true } as never);
    render(<Workspace />);
    await waitFor(() => expect(screen.getByTestId("sidebar")).toBeTruthy());
    expect(reattach).not.toHaveBeenCalled();
  });

  it("reconciles the selected project exactly once when the answer lands", async () => {
    render(<Workspace />);
    await waitFor(() => expect(reattach).toHaveBeenCalledWith("p1"));
    const calls = reattach.mock.calls.length;
    // A re-render must not re-list: re-listing resurrects a cloud tab the user deliberately removed.
    act(() => {
      useUiStore.setState({ workMode: "plan" } as never);
    });
    expect(reattach.mock.calls.length).toBe(calls);
  });

  it("retries when AUTH settles after the first attempt (cold-boot token race)", async () => {
    useAuthStore.setState({ me: { clerkUserId: "u1", entitled: true, balanceCents: 0, tokenVersion: 1 }, tokenPresent: false } as never);
    render(<Workspace />);
    await waitFor(() => expect(screen.getByTestId("sidebar")).toBeTruthy());
    expect(reattach).not.toHaveBeenCalled();

    reattach.mockResolvedValueOnce(null); // the attempt that races the settling token
    act(() => {
      useAuthStore.setState({
        me: { clerkUserId: "u1", entitled: true, balanceCents: 0, tokenVersion: 1, cloudAgentsEnabled: true },
        tokenPresent: true,
      } as never);
    });
    await waitFor(() => expect(reattach).toHaveBeenCalledWith("p1"));
  });

  it("retries when the network comes back — the OTHER half of the retryable null", async () => {
    // An offline cold boot for an already-signed-in user: the persisted token rehydrates, so auth
    // is ready on the first frame and never transitions. Only connectivity can fire the retry.
    reattach.mockResolvedValueOnce(null);
    useConnectionStore.setState({ isOnline: false } as never);
    render(<Workspace />);
    await waitFor(() => expect(screen.getByTestId("sidebar")).toBeTruthy());
    expect(reattach).not.toHaveBeenCalled();

    act(() => {
      useConnectionStore.setState({ isOnline: true } as never);
    });
    await waitFor(() => expect(reattach).toHaveBeenCalledWith("p1"));
    expect(reattach.mock.calls.length).toBe(1);

    // …and the null it returned leaves the project eligible, so a later trigger tries again.
    act(() => {
      useConnectionStore.setState({ isOnline: false } as never);
    });
    act(() => {
      useConnectionStore.setState({ isOnline: true } as never);
    });
    await waitFor(() => expect(reattach.mock.calls.length).toBe(2));
  });
});
