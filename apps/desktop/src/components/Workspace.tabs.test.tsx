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
// PARTIAL, not a replacement: the real module also exports the reserved-id constants
// (SPARKLE_AGENT_ID / SPARKLE_PROJECT_ID / isSparkleAgentId), which other modules in this render
// tree now import transitively. A whole-module mock silently drops them, and the failure surfaces as
// an unrelated import error in whichever file happens to need one — so spread the original and
// override only the three launch decisions this suite is steering.
vi.mock("../services/sparkleAgent", async (orig) => ({
  ...(await orig<typeof import("../services/sparkleAgent")>()),
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
import { PLAN_COLUMN_Z, SIDEBAR_OVERLAY_Z } from "./layers";

function mkAgent(id: string): AgentTab {
  return {
    id, name: id, kind: "build", parentId: null, runtime: "local",
    worktreePath: null, branch: null, baseBranch: null, lastPrompt: "",
    promptHistory: [], namePinned: false, autoNameBasis: null,
    autoNameVariants: null, shellCommand: null,  };
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
  useUiStore.setState({
    activeSpecial: null,
    workModeBySide: { left: "build", right: "build" },
    pinnedProjectId: null,
    // Closable tabs: `null` = never seeded, i.e. every project is open. Reset per test so one
    // block's close can't decide another's tab bar (uiStore is a module singleton).
    openProjectIds: null,
  } as never);
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

// Closing a project tab is a VIEW operation, and this is the contract that makes that claim true.
// A Terminal unmount kills its PTY with no scrollback replay, so if putting a project away tore its
// panes down, the [x] would quietly destroy running work — the single worst way this feature could
// go wrong. Pane mounting is driven by `projects` × the visited set × `openAgentIds` (Workspace's
// `live` memo), and closing a tab writes none of them; these tests are what keep that true.
describe("Workspace — closing a tab must not kill that project's agents", () => {
  it("keeps a closed project's panes MOUNTED (its PTYs keep running)", async () => {
    render(<Workspace />);
    await screen.findByTestId("pane-a1");
    // Visit Beta so both projects have live panes, then come back to Alpha.
    fireEvent.click(screen.getByTestId("tab-p2"));
    fireEvent.click(screen.getByTestId("tab-p1"));
    expect(screen.getByTestId("pane-b1")).toBeTruthy();

    fireEvent.click(screen.getByTestId("close-p2"));

    expect(screen.queryByTestId("tab-p2")).toBeNull(); // the tab is gone…
    expect(screen.getByTestId("pane-b1")).toBeTruthy(); // …the agent is not
    expect(screen.getByTestId("pane-b1").dataset.visible).toBe("false");
    // The runtime's open set is untouched, so nothing was stopped.
    expect(useRuntimeStore.getState().openAgentIds).toContain("b1");
  });

  it("keeps the panes of the project you just closed AND were looking at", async () => {
    render(<Workspace />);
    await screen.findByTestId("pane-a1");
    fireEvent.click(screen.getByTestId("close-p1")); // closing the SELECTED tab
    expect(useProjectStore.getState().selectedProjectId).toBe("p2");
    expect(screen.getByTestId("pane-a1")).toBeTruthy();
    expect(screen.getByTestId("pane-a1").dataset.visible).toBe("false");
  });

  it("keeps them mounted even when the LAST tab closes and there is no selection at all", async () => {
    render(<Workspace />);
    await screen.findByTestId("pane-a1");
    fireEvent.click(screen.getByTestId("tab-p2"));
    fireEvent.click(screen.getByTestId("close-p1"));
    fireEvent.click(screen.getByTestId("close-p2"));
    expect(useProjectStore.getState().selectedProjectId).toBeNull();
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    // Both projects' agents are still alive behind the welcome screen.
    expect(screen.getByTestId("pane-a1")).toBeTruthy();
    expect(screen.getByTestId("pane-b1")).toBeTruthy();
    expect(useRuntimeStore.getState().openAgentIds).toEqual(["a1", "b1"]);
  });

  it("shows the welcome hint — not a blank shell — once the last tab is closed", async () => {
    render(<Workspace />);
    await screen.findByTestId("pane-a1");
    fireEvent.click(screen.getByTestId("close-p1"));
    fireEvent.click(screen.getByTestId("close-p2"));
    expect(screen.getByText("Welcome to Sparkle")).toBeTruthy();
    expect(screen.getByTestId("tab-add")).toBeTruthy(); // and the way back out of it
  });

  it("reopening a closed project shows its agent again, still the same live pane", async () => {
    render(<Workspace />);
    await screen.findByTestId("pane-a1");
    fireEvent.click(screen.getByTestId("tab-p2"));
    const paneBefore = screen.getByTestId("pane-b1");
    fireEvent.click(screen.getByTestId("close-p2"));
    act(() => {
      // The same call every reopen surface makes (the "+" dialog's list, a concierge alert, ⌘K).
      useUiStore.getState().setOpenProjectIds(["p1", "p2"]);
      useProjectStore.getState().selectProject("p2");
    });
    expect(screen.getByTestId("tab-p2")).toBeTruthy();
    expect(screen.getByTestId("pane-b1").dataset.visible).toBe("true");
    // Same DOM node throughout: the pane was never remounted, so the PTY was never restarted.
    expect(screen.getByTestId("pane-b1")).toBe(paneBefore);
  });
});

describe("Workspace — depth layers + calm desaturation", () => {
  it("hands calm to the VISIBLE pane while its agent is calm", async () => {
    render(<Workspace />);
    await screen.findByTestId("pane-a1");
    // No live status → the agent reads `stopped`, which is calm.
    expect(screen.getByTestId("terminal-stage").dataset.calm).toBe("true");
    expect(screen.getByTestId("pane-a1").dataset.calm).toBe("true");
    // The desaturation is the PANE's (its terminal theme), never a filter on the stage: that
    // filter re-composited the WebGL canvas every frame and became a containing block for the
    // fixed-position overlays inside it (roborev 46254-M2/M3).
    expect(screen.getByTestId("terminal-stage").style.filter).toBe("");
  });

  it("restores color the moment that agent needs you", async () => {
    render(<Workspace />);
    await screen.findByTestId("pane-a1");
    await act(async () => useRuntimeStore.setState({ status: { a1: "waiting" } } as never));
    expect(screen.getByTestId("terminal-stage").dataset.calm).toBe("false");
    expect(screen.getByTestId("pane-a1").dataset.calm).toBe("false");
  });

  // `unmerged` is the ONE status where the band and the calm predicate must disagree: it bands
  // `done` (so it buys no concierge nudge) but is NOT calm (unlanded work is exactly what you should
  // still see). terminalCalm used to read the BAND, so selecting an unmerged agent desaturated its
  // terminal while AgentSidebar — which asks `isCalmBand` — kept its row fully colored. Two surfaces
  // disagreeing about the one status the split exists to protect.
  it("does NOT desaturate an agent whose work is committed but not landed (unmerged)", async () => {
    render(<Workspace />);
    await screen.findByTestId("pane-a1");
    await act(async () =>
      useRuntimeStore.setState({
        // idle + committed-but-unlanded → publishedStatusFor escalates the status to `unmerged`.
        status: { a1: "idle" },
        workflowStage: { a1: "building_saved" },
        branchStatus: {},
      } as never),
    );
    expect(screen.getByTestId("terminal-stage").dataset.calm).toBe("false");
    expect(screen.getByTestId("pane-a1").dataset.calm).toBe("false");
  });

  it("DOES desaturate a genuinely landed agent, so the unmerged contrast is real", async () => {
    // Without this, the test above would pass trivially if the calm treatment broke entirely.
    // `merged` is past the unlanded band, so the status stays plain `idle`.
    render(<Workspace />);
    await screen.findByTestId("pane-a1");
    await act(async () =>
      useRuntimeStore.setState({
        status: { a1: "idle" },
        workflowStage: { a1: "merged" },
        branchStatus: {},
      } as never),
    );
    expect(screen.getByTestId("terminal-stage").dataset.calm).toBe("true");
    expect(screen.getByTestId("pane-a1").dataset.calm).toBe("true");
  });

  it("keeps a WORKING agent calm — the Running band changed sorting, not desaturation", async () => {
    render(<Workspace />);
    await screen.findByTestId("pane-a1");
    await act(async () => useRuntimeStore.setState({ status: { a1: "working" } } as never));
    expect(screen.getByTestId("terminal-stage").dataset.calm).toBe("true");
  });

  it("keeps color while the Plan board is up — calm is a property of a VISIBLE agent pane", async () => {
    render(<Workspace />);
    await screen.findByTestId("pane-a1");
    await act(async () => {
      useUiStore.getState().setWorkMode("right", "plan");
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

describe("Workspace — Plan mode fills that column’s terminal slot", () => {
  it("shows no Plan column in Build mode", () => {
    render(<Workspace />);
    expect(screen.queryByTestId("plan-column")).toBeNull();
    expect(screen.getByTestId("sidebar")).toBeTruthy();
  });

  it("lays the board over its own column’s panes, which stay mounted", async () => {
    render(<Workspace />);
    await screen.findByTestId("pane-a1");
    await act(async () => {
      useUiStore.getState().setWorkMode("right", "plan");
    });
    expect(screen.getByTestId("plan-column")).toBeTruthy();
    expect(screen.getByTestId("board")).toBeTruthy();
    // The panes are covered, not torn down — their PTYs must survive a mode flip.
    expect(screen.getByTestId("pane-a1")).toBeTruthy();
    expect(screen.getByTestId("pane-a1").dataset.visible).toBe("false");
    // The board paints at the SHARED layer, not an inline number of its own. It covers BOTH of the
    // pair's columns — including the Build column's Plan/Build toggle, whose only replacement is
    // the board's own — so it must paint over that column even when the user has floated it. The
    // ordering itself is asserted in AgentSidebar.pullTabs.test.tsx; this pins the board's end of
    // it so an inline z-index re-edit here can't slip past that assertion.
    expect(Number(screen.getByTestId("plan-column").style.zIndex)).toBe(PLAN_COLUMN_Z);
    expect(PLAN_COLUMN_Z).toBeGreaterThan(SIDEBAR_OVERLAY_Z);
  });

  it("leaves the terminal stage un-isolated so its full-window modals still escape it", () => {
    // `isolation: isolate` here looks like the tidy way to contain the stage's high z-indices
    // (PinnedPrompt 20, the drop overlay 20, the pane kebab 19-21) below the floated Build column.
    // It also demotes the whole subtree to layer 0, and the stage hosts full-window `position:
    // fixed` surfaces that MUST escape it — composer/ModalOverlay at zIndex 1000 and AgentPane's
    // click-away backdrop, both meant to cover column ①. Isolated, they lose to any `z-index: 1`
    // descendant of the concierge column: the dim backdrop gets punched through by the compose box
    // and the click-away stops dismissing. The Build column clears the stage by out-numbering it
    // (components/layers.ts) instead. Sits next to the `style.filter` assertion above, which pins
    // the other property this element must not grow for a closely-related reason.
    render(<Workspace />);
    expect(screen.getByTestId("terminal-stage").style.isolation).toBe("");
  });

  it("switching the column back to Build drops the board and re-shows the pane", async () => {
    render(<Workspace />);
    await screen.findByTestId("pane-a1");
    await act(async () => {
      useUiStore.getState().setWorkMode("right", "plan");
    });
    // The board carried a DUPLICATE PlanBuildToggle when it covered the Build column and took the
    // sidebar's header with it. It fills only the terminal slot now, so the sidebar's own toggle is
    // still on screen and is the single way back — and this suite stubs the sidebar, so the mode
    // change is driven directly rather than through a control the real column owns.
    await act(async () => useUiStore.getState().setWorkMode("right", "build"));
    expect(screen.queryByTestId("plan-column")).toBeNull();
    expect(useUiStore.getState().workModeBySide.right).toBe("build");
    expect(useUiStore.getState().activeSpecial).toBeNull();
    expect(screen.getByTestId("pane-a1").dataset.visible).toBe("true");
  });

  it("stays out of Plan mode when the Beads tool is off (no board to show)", async () => {
    useSettingsStore.setState({ beadsEnabled: false } as never);
    render(<Workspace />);
    await act(async () => useUiStore.getState().setWorkMode("right", "plan"));
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
      useUiStore.setState({ workModeBySide: { left: "build", right: "plan" } } as never);
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
