// @vitest-environment jsdom
//
// PANE OWNERSHIP when a project is torn out into its own window.
//
// This is the one contract in the tear-off feature that costs a real process if it breaks. A
// Terminal unmount calls `transport.detach()`, which for a local agent IS `kill()`; and `pty_spawn`
// inserts into its session map without checking, so a second webview mounting the same agent
// silently ORPHANS a child process rather than erroring. So "main stops rendering a torn-out
// project's panes" is not a display concern — it is what stops two xterms racing one PTY.
//
// The gate is a `continue` in Workspace's `live` memo, fed by a useSyncExternalStore subscription to
// the ownership map. What these tests pin is that it reacts SYNCHRONOUSLY to a claim, and that it
// reverses cleanly on release, since a claim can be rolled back when the window fails to build.
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
  // Reports WHICH project it was given: main must hand it `null` for a torn-out project, because
  // that project's agent list belongs to the satellite now.
  AgentSidebar: ({ project }: { project: { id: string } | null }) => (
    <div data-testid="sidebar" data-project={project?.id ?? "none"} />
  ),
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

// Only `reclaimProject` is stubbed, and only so the in-flight window can be OBSERVED: outside Tauri
// the real one releases synchronously, so the pending state would come and go inside one click and
// the guard it protects would be untestable. Everything else in the module stays real — the
// ownership map these tests read and write is the genuine one.
const reclaimResolvers = vi.hoisted(() => new Map<string, () => void>());
const reclaimSpy = vi.hoisted(() => {
  const resolvers = reclaimResolvers;
  return vi.fn(
    (id: string) =>
      new Promise<void>((resolve) => {
        resolvers.set(id, resolve);
      }),
  );
});
vi.mock("../services/satelliteWindows", async () => ({
  ...(await vi.importActual<typeof import("../services/satelliteWindows")>(
    "../services/satelliteWindows",
  )),
  reclaimProject: reclaimSpy,
}));

import { Workspace } from "./Workspace";
import { useProjectStore } from "../stores/projectStore";
import { useAuthStore } from "../stores/authStore";
import { useConnectionStore } from "../stores/connectionStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import { useSettingsStore } from "../stores/settingsStore";
import { resetVisitedProjects } from "../services/sessionProjects";
import type { AgentTab, Project } from "../types";

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
    workMode: "build",
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

import { SATELLITE_REGISTRY_KEY, releaseSatellite, claimSatellite } from "../services/satelliteWindows";

/** Seed the ownership map the way a tear-off in another render would have. */
function ownedBySatellite(projectId: string, label: string | null = "project-1") {
  localStorage.setItem(SATELLITE_REGISTRY_KEY, JSON.stringify({ [projectId]: label }));
}

beforeEach(() => localStorage.removeItem(SATELLITE_REGISTRY_KEY));

describe("Workspace — torn-out project panes", () => {
  it("does not mount panes for a project that lives in another window", () => {
    ownedBySatellite("p1");
    render(<Workspace />);
    // p1 is the SELECTED tab and its agent is open — the two conditions that normally guarantee a
    // mounted pane. Ownership overrides both.
    expect(screen.queryByTestId("pane-a1")).toBeNull();
  });

  it("still mounts every other project's panes", async () => {
    ownedBySatellite("p1");
    render(<Workspace />);
    act(() => {
      fireEvent.click(screen.getByTestId("tab-p2"));
    });
    // The visited set is recorded in an effect, so p2's panes land on the commit after the click.
    await waitFor(() => expect(screen.getByTestId("pane-b1")).toBeTruthy());
    // …and taking one project away must not have taken any other with it.
    expect(screen.queryByTestId("pane-a1")).toBeNull();
  });

  it("drops the panes for a PENDING claim, before the window exists", () => {
    // The claim is written first and the window is built after (services/satelliteWindows' ordering
    // note). If a pending claim did not gate, main would still be holding the PTYs at the instant
    // the satellite mounts — the exact overlap the ordering exists to avoid.
    render(<Workspace />);
    expect(screen.getByTestId("pane-a1")).toBeTruthy();
    act(() => claimSatellite("p1"));
    expect(screen.queryByTestId("pane-a1")).toBeNull();
  });

  it("remounts the panes when the project is released back to main", () => {
    // Release happens on re-dock AND on a rolled-back tear-off (the window failed to build). Both
    // have to leave main rendering the project again, or the tab is dead.
    ownedBySatellite("p1");
    render(<Workspace />);
    expect(screen.queryByTestId("pane-a1")).toBeNull();
    act(() => releaseSatellite("p1"));
    expect(screen.getByTestId("pane-a1")).toBeTruthy();
  });

  it("empties the agent sidebar for a torn-out project", () => {
    ownedBySatellite("p1");
    render(<Workspace />);
    // Listing p1's agents here would offer rows whose terminals this window does not have.
    expect(screen.getByTestId("sidebar").getAttribute("data-project")).toBe("none");
  });

  it("keeps the sidebar for a project main still owns", () => {
    render(<Workspace />);
    expect(screen.getByTestId("sidebar").getAttribute("data-project")).toBe("p1");
  });

  it("offers both ways back — raise that window, or bring the project home", () => {
    ownedBySatellite("p1");
    render(<Workspace />);
    // Without these the tab is a dead end: no panes, no agents, and (if the satellite is behind the
    // main window or on an unplugged monitor) no visible window either.
    expect(screen.getByTestId("focus-satellite")).toBeTruthy();
    expect(screen.getByTestId("reclaim-satellite")).toBeTruthy();
  });

  it("does not start a SECOND reclaim while one is in flight", async () => {
    reclaimSpy.mockClear();
    // Each click emits another re-dock request and can eventually force another window close, and a
    // re-dock can take REDOCK_TIMEOUT_MS with the button otherwise looking inert — so users click it
    // again. Guarded in the handler, not only by `disabled`, because that is also the keyboard path.
    ownedBySatellite("p1");
    render(<Workspace />);
    const btn = screen.getByTestId("reclaim-satellite");
    fireEvent.click(btn);
    fireEvent.click(btn);
    fireEvent.click(btn);
    await waitFor(() => expect(btn.textContent).toContain("Bringing it back"));
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    expect(reclaimSpy).toHaveBeenCalledTimes(1);
  });

  it("does not block a DIFFERENT torn-out project's button", async () => {
    reclaimSpy.mockClear();
    // The pending state is keyed by project id. A bare boolean disabled every torn-out tab's
    // recovery button at once — including projects whose reclaim was not running at all.
    localStorage.setItem(
      SATELLITE_REGISTRY_KEY,
      JSON.stringify({ p1: "project-1", p2: "project-2" }),
    );
    render(<Workspace />);
    fireEvent.click(screen.getByTestId("reclaim-satellite"));
    await waitFor(() =>
      expect(screen.getByTestId("reclaim-satellite").textContent).toContain("Bringing it back"),
    );
    // Switch to the other torn-out project; its own button must be live.
    act(() => {
      fireEvent.click(screen.getByTestId("tab-p2"));
    });
    await waitFor(() => {
      const other = screen.getByTestId("reclaim-satellite") as HTMLButtonElement;
      expect(other.disabled).toBe(false);
      expect(other.textContent).toContain("Bring it back here");
    });
  });

  it("one reclaim finishing does not re-enable a DIFFERENT project's button", async () => {
    // The pending state is a Set, not a single slot. With a slot, this sequence bypassed the guard
    // entirely: start p1, start p2, then p1 settles (or times out after REDOCK_TIMEOUT_MS) and
    // clears the slot — p2's button re-enables while p2's reclaim is still in flight, so the next
    // click starts a SECOND reclaimProject("p2"): another re-dock request stream and potentially a
    // second close_project_window, which is the double force this state exists to prevent.
    reclaimSpy.mockClear();
    reclaimResolvers.clear();
    localStorage.setItem(
      SATELLITE_REGISTRY_KEY,
      JSON.stringify({ p1: "project-1", p2: "project-2" }),
    );
    render(<Workspace />);

    fireEvent.click(screen.getByTestId("reclaim-satellite")); // p1
    act(() => {
      fireEvent.click(screen.getByTestId("tab-p2"));
    });
    await waitFor(() =>
      expect((screen.getByTestId("reclaim-satellite") as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(screen.getByTestId("reclaim-satellite")); // p2
    await waitFor(() => expect(reclaimSpy).toHaveBeenCalledTimes(2));

    // p1 finishes. p2's is still running, so p2's button must STAY disabled.
    await act(async () => {
      reclaimResolvers.get("p1")?.();
      await Promise.resolve();
    });
    const p2Btn = screen.getByTestId("reclaim-satellite") as HTMLButtonElement;
    expect(p2Btn.disabled).toBe(true);
    fireEvent.click(p2Btn);
    expect(reclaimSpy).toHaveBeenCalledTimes(2); // no third call
  });

  it("shows no placeholder for a project main still owns", () => {
    render(<Workspace />);
    expect(screen.queryByTestId("reclaim-satellite")).toBeNull();
  });
});
