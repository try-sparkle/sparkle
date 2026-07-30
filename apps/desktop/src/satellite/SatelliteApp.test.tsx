// @vitest-environment jsdom
//
// The satellite's TEARDOWN ORDER, which is the part with consequences.
//
// Leaving has to run: panes unmount → wait CLOSE_SETTLE_MS → release the project → destroy the
// window. Each step guards the next. `Terminal`'s cleanup fires `transport.detach()`, an `invoke`
// dispatched synchronously from the unmount but completed in Rust a round-trip later; releasing the
// instant React came down lets main remount and `pty_spawn` the same agent id while the kill is
// still in flight, and pty.rs INSERTS rather than refusing — so the loser is not an error, it is an
// orphaned `claude` process nobody holds a handle to.
//
// So the assertions here are about SEQUENCE, not appearance: release must come after the panes are
// gone and after the timer, and destroy must never precede release.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

const destroySpy = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const closeRequestedCb = vi.hoisted(() => ({ current: null as null | ((e: { preventDefault: () => void }) => void) }));
const redockCb = vi.hoisted(() => ({ current: null as null | ((e: { payload: unknown }) => void) }));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    label: "project-2",
    setTitle: () => Promise.resolve(),
    destroy: destroySpy,
    onCloseRequested: (cb: (e: { preventDefault: () => void }) => void) => {
      closeRequestedCb.current = cb;
      return Promise.resolve(() => {});
    },
  }),
  getAllWindows: () => Promise.resolve([]),
}));
vi.mock("@tauri-apps/api/event", () => ({
  emit: () => Promise.resolve(),
  listen: (name: string, cb: (e: { payload: unknown }) => void) => {
    if (name === "sparkle://satellite-redock") redockCb.current = cb;
    return Promise.resolve(() => {});
  },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve(null) }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));
vi.mock("../services/crossWindowSync", () => ({ subscribeToCrossWindowSync: () => () => {} }));
vi.mock("../stores/presenceStore", () => ({ startPresenceTracking: () => () => {} }));

// The pane records its own mount/unmount into a shared log, so "release happened after the panes
// came down" is a real ordering assertion rather than an inference from a rendered DOM.
const events = vi.hoisted(() => [] as string[]);
vi.mock("../components/AgentPane", async () => {
  const { useEffect } = await import("react");
  return {
    AgentPane: ({ agent }: { agent: { id: string } }) => {
      useEffect(() => {
        events.push(`mount:${agent.id}`);
        return () => {
          events.push(`unmount:${agent.id}`);
        };
      }, [agent.id]);
      return <div data-testid={`pane-${agent.id}`} />;
    },
  };
});
vi.mock("../components/AgentSidebar", () => ({
  AgentSidebar: ({ project }: { project: { id: string } | null }) => (
    <div data-testid="sidebar" data-project={project?.id ?? "none"} />
  ),
}));
vi.mock("../components/BoardView", () => ({ BoardView: () => <div data-testid="board" /> }));

import { SatelliteApp, CLOSE_SETTLE_MS } from "./SatelliteApp";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import { useSettingsStore } from "../stores/settingsStore";
import { SATELLITE_REGISTRY_KEY, isTornOut, readSatellites } from "../services/satelliteWindows";
import { freezeUiPersistence } from "./uiPersistence";
import type { AgentTab, Project } from "../types";

function mkAgent(id: string): AgentTab {
  return {
    id, name: id, kind: "build", parentId: null, runtime: "local",
    worktreePath: null, branch: null, baseBranch: null, lastPrompt: "",
    promptHistory: [], namePinned: false, autoNameBasis: null,
    autoNameVariants: null, shellCommand: null,
  };
}
function mkProject(id: string, name: string, agents: AgentTab[]): Project {
  return {
    id, name, rootPath: `/tmp/${id}`, defaultBranch: null,
    createdAt: new Date(0).toISOString(), selectedAgentId: agents[0]?.id ?? null, agents,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  events.length = 0;
  destroySpy.mockClear();
  closeRequestedCb.current = null;
  redockCb.current = null;
  localStorage.clear();
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  useProjectStore.setState({ projects: [mkProject("p1", "Alpha", [mkAgent("a1")])] } as never);
  useRuntimeStore.setState({ openAgentIds: ["a1"], status: {} } as never);
  useUiStore.setState({ activeSpecial: null, workModeBySide: { left: "build", right: "build" } } as never);
  useSettingsStore.setState({ beadsEnabled: false } as never);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

/** Trigger the red traffic light, which the satellite intercepts into a re-dock. */
function requestClose() {
  act(() => closeRequestedCb.current?.({ preventDefault: () => {} }));
}

describe("SatelliteApp — arrival", () => {
  it("claims ownership for its own window label on mount", () => {
    render(<SatelliteApp projectId="p1" />);
    // Main normally wrote a PENDING claim before building this window; settling fills in the label.
    // Doing it from this side too is the self-heal for a window that outlived main's write.
    expect(readSatellites()).toEqual({ p1: "project-2" });
  });

  it("mounts only its own project's open agents", () => {
    render(<SatelliteApp projectId="p1" />);
    expect(screen.getByTestId("pane-a1")).toBeTruthy();
  });

  it("clears an inherited Improve Sparkle view — that agent belongs to main", () => {
    // sparkleAgentIdFor keys the agent to the window label, so mounting it here would be a second
    // pane on main's PTY. The prefs blob is main's and can arrive saying "sparkle".
    useUiStore.setState({ activeSpecial: "sparkle" } as never);
    render(<SatelliteApp projectId="p1" />);
    expect(useUiStore.getState().activeSpecial).toBeNull();
  });
});

describe("SatelliteApp — teardown ordering", () => {
  it("unmounts the panes BEFORE releasing, and releases before destroying", () => {
    render(<SatelliteApp projectId="p1" />);
    expect(events).toContain("mount:a1");

    requestClose();
    // Phase one: the stage is gone, but the project is still OURS — main must not remount yet,
    // because the detach invokes are still in flight in Rust.
    expect(events).toContain("unmount:a1");
    expect(isTornOut("p1")).toBe(true);
    expect(destroySpy).not.toHaveBeenCalled();

    // Phase two, after the settle.
    act(() => void vi.advanceTimersByTime(CLOSE_SETTLE_MS));
    expect(isTornOut("p1")).toBe(false);
    expect(destroySpy).toHaveBeenCalled();
  });

  it("does not release early — the settle timer is load-bearing, not cosmetic", () => {
    render(<SatelliteApp projectId="p1" />);
    requestClose();
    act(() => void vi.advanceTimersByTime(CLOSE_SETTLE_MS - 1));
    expect(isTornOut("p1")).toBe(true);
    expect(destroySpy).not.toHaveBeenCalled();
  });

  it("empties the sidebar as soon as closing starts", () => {
    render(<SatelliteApp projectId="p1" />);
    requestClose();
    expect(screen.getByTestId("sidebar").getAttribute("data-project")).toBe("none");
  });
});

describe("SatelliteApp — a destroy that does not land", () => {
  it("stops intercepting the red button once the project is released, so the window can still be closed", () => {
    // destroy() is fire-and-forget. If it fails, the window is blank with its project already home —
    // and the teardown is one-shot (setClosing(true) on an already-true state re-runs nothing), so
    // an unconditional preventDefault() would make the window UNCLOSEABLE, holding one of the four
    // pool labels with no ownership row for reconcileSatellites to reclaim.
    destroySpy.mockRejectedValueOnce(new Error("destroy failed"));
    render(<SatelliteApp projectId="p1" />);
    requestClose();
    act(() => void vi.advanceTimersByTime(CLOSE_SETTLE_MS));
    expect(isTornOut("p1")).toBe(false);

    // A second close request must now pass THROUGH — the handler leaves preventDefault uncalled.
    let prevented = false;
    act(() => closeRequestedCb.current?.({ preventDefault: () => { prevented = true; } }));
    expect(prevented).toBe(false);
  });

  it("still intercepts before the release — that ordering is the whole point", () => {
    render(<SatelliteApp projectId="p1" />);
    let prevented = false;
    act(() => closeRequestedCb.current?.({ preventDefault: () => { prevented = true; } }));
    expect(prevented).toBe(true);
  });
});

describe("SatelliteApp — main's re-dock request", () => {
  it("runs the SAME ordered teardown when main asks it to come back", () => {
    // This is why main asks instead of calling close_project_window: a destroyed webview runs no
    // React cleanup, so no Terminal unmount, so no PTY kill — and main would respawn those agent
    // ids over live children.
    render(<SatelliteApp projectId="p1" />);
    act(() => redockCb.current?.({ payload: { projectId: "p1" } }));
    expect(events).toContain("unmount:a1");
    act(() => void vi.advanceTimersByTime(CLOSE_SETTLE_MS));
    expect(isTornOut("p1")).toBe(false);
    expect(destroySpy).toHaveBeenCalled();
  });

  it("ignores a request aimed at a DIFFERENT project", () => {
    // The event is broadcast to every webview, so four satellites all see it.
    render(<SatelliteApp projectId="p1" />);
    act(() => redockCb.current?.({ payload: { projectId: "p2" } }));
    expect(events).not.toContain("unmount:a1");
    expect(destroySpy).not.toHaveBeenCalled();
  });
});

describe("SatelliteApp — project deleted in main", () => {
  it("re-docks rather than sitting there blank", () => {
    render(<SatelliteApp projectId="p1" />);
    act(() => useProjectStore.setState({ projects: [mkProject("p9", "Other", [])] } as never));
    act(() => void vi.advanceTimersByTime(CLOSE_SETTLE_MS));
    // Holding an ownership row for a project that no longer exists would strand the row forever.
    expect(isTornOut("p1")).toBe(false);
    expect(destroySpy).toHaveBeenCalled();
  });

  it("does NOT mistake an unhydrated store for a deletion", () => {
    // The guard is `projects.length > 0`. Without it the first frame — before the persisted store
    // rehydrates — reads as "the project is gone" and the window closes itself on every launch.
    useProjectStore.setState({ projects: [] } as never);
    render(<SatelliteApp projectId="p1" />);
    act(() => void vi.advanceTimersByTime(CLOSE_SETTLE_MS * 4));
    expect(destroySpy).not.toHaveBeenCalled();
  });
});

describe("SatelliteApp — persistence", () => {
  it("does not clobber main's sparkle-ui blob, given the freeze main.tsx installs", () => {
    // The pairing is the point, and it is split across two files: `main.tsx` calls
    // freezeUiPersistence BEFORE render precisely because this component writes uiStore as soon as
    // it mounts (clearing an inherited "sparkle" view). Rendering without the freeze — as this test
    // originally did — republishes zustand's whole partialized state over main's blob, which is the
    // clobber the freeze exists to prevent. So the freeze is set up here the way the real boot does.
    localStorage.setItem("sparkle-ui", JSON.stringify({ state: { pinnedProjectId: "keep" }, version: 0 }));
    freezeUiPersistence();
    useUiStore.setState({ activeSpecial: "sparkle" } as never);
    render(<SatelliteApp projectId="p1" />);
    expect(useUiStore.getState().activeSpecial).toBeNull(); // the write really happened…
    expect(JSON.parse(localStorage.getItem("sparkle-ui")!).state.pinnedProjectId).toBe("keep");
    // …and ownership went to its OWN map, not into the ui blob. A regression that moved ownership
    // into uiStore would fail both of these at once.
    expect(localStorage.getItem(SATELLITE_REGISTRY_KEY)).toBeTruthy();
  });
});
