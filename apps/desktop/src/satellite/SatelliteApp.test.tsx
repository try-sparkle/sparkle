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
// The per-window auto-continue/escalation runner. Spied so we can prove the satellite MOUNTS it —
// before sparkle-l7bmm it ran only in App.tsx, so a torn-out project's agents were swept by no one.
const goalRunnerSpy = vi.hoisted(() => vi.fn(() => () => {}));
vi.mock("../services/goalContinuationRunner", () => ({ startGoalContinuationRunner: goalRunnerSpy }));
// The goal's DURABLE MIRROR — `<app_data>/agent-goals/<agentId>.json`, for the SessionStart hook.
// Spied for the same reason the runner above is, and mocked as a whole module rather than left real:
// the real one imports `ownsProjectInThisWindow` from the module mocked on the line above, and this
// file's mock is partial, so loading it for real dies with "No 'ownsProjectInThisWindow' export is
// defined". Its own behavior is covered end to end in services/agentGoalDisk.test.ts, including
// against the real store and the real invoke; what belongs HERE is only that the satellite starts it.
const goalDiskSpy = vi.hoisted(() => vi.fn(() => () => {}));
vi.mock("../services/agentGoalDisk", () => ({ startAgentGoalDiskMirror: goalDiskSpy }));

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
// `covered` is FORWARDED, not destructured away. The real column's own treatment is proven against
// the real component (AgentSidebar.covered.test.tsx); what only this file can prove is that THIS
// window asks for it exactly when its board is up — see the covered/board lockstep test below.
vi.mock("../components/AgentSidebar", () => ({
  AgentSidebar: ({ project, covered }: { project: { id: string } | null; covered?: boolean }) => (
    <div data-testid="sidebar" data-project={project?.id ?? "none"} data-covered={String(!!covered)} />
  ),
}));
// The board is stubbed, but its PROPS are recorded — see the onBeadChat suite at the bottom of this
// file for why that one prop is worth capturing rather than destructuring away.
const boardProps = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock("../components/BoardView", () => ({
  BoardView: (props: Record<string, unknown>) => {
    boardProps.push(props);
    return <div data-testid="board" />;
  },
}));

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
  // Cleared per test: a leaked render from an earlier one would let the onBeadChat sweep below pass
  // on props this test never produced.
  boardProps.length = 0;
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

  it("starts the goal-continuation runner so its own project's agents are swept (sparkle-l7bmm)", () => {
    // The runner is per-window and gates each project through routeToOwningWindow, so mounting it
    // here makes the owning satellite the ONE handler for its torn-out project — main defers to it.
    // Mounted only in App.tsx before, the satellite ran nobody, so those agents were never
    // auto-continued or escalated. Asserts the mount happened; the ownership gating is proven in
    // windowOwnership's own tests.
    goalRunnerSpy.mockClear();
    render(<SatelliteApp projectId="p1" />);
    expect(goalRunnerSpy).toHaveBeenCalled();
  });

  it("starts the goal-record disk mirror, so a torn-out project's agents wake with a brief", () => {
    // Same gap as the runner above, one layer down: the goal lives in localStorage, which a shell
    // SessionStart hook cannot read, so the on-disk record is the ONLY thing an agent resuming with
    // no session context can be told what it was doing from. Mounted only in App.tsx, a torn-off
    // project's goals would never reach disk at all. The sweep's own single-owner election is what
    // keeps main and this satellite from both writing the same file; that is proven in
    // services/agentGoalDisk.test.ts. What this asserts is the MOUNT — the line that would otherwise
    // be the one call site no test drives.
    goalDiskSpy.mockClear();
    render(<SatelliteApp projectId="p1" />);
    expect(goalDiskSpy).toHaveBeenCalled();
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

describe("SatelliteApp — the board covers the agent column", () => {
  // THIS WINDOW HAS ALWAYS HAD THE SHAPE MAIN ONLY JUST GREW. The board is `absolute; inset: 0`
  // inside a wrapper that holds BOTH the agent column and the terminal stage, so it covers the
  // column too — and both render a PlanBuildToggle. Uncovered, that leaves two of every control in
  // the window with the unreachable one FIRST in DOM order: Tab walks hidden agent rows, and AT
  // announces two identical mode toggles behind an opaque surface.
  //
  // So `covered` is not decoration here, and the ONE property that makes it correct is that it
  // cannot disagree with the board's own render gate. A comment saying "these mirror each other"
  // is not a guard — assert the lockstep instead. Each case below moves ONE input and demands both
  // facts flip together; a `covered` keyed off `workMode` alone (forgetting beads) fails case 2,
  // and one that forgets `closing` fails case 4.
  const bothAgree = () => {
    const boardUp = screen.queryByTestId("plan-column") !== null;
    expect(screen.getByTestId("sidebar").getAttribute("data-covered")).toBe(String(boardUp));
    return boardUp;
  };

  it("leaves the column reachable in Build mode — the default costs nothing", () => {
    useSettingsStore.setState({ beadsEnabled: true } as never);
    render(<SatelliteApp projectId="p1" />);
    expect(bothAgree()).toBe(false);
  });

  it("stays reachable in Plan mode with Beads OFF, where no board renders to cover it", () => {
    // planBoardUp falls back to the terminal when the Beads tool is off, so a column parked in Plan
    // shows its stage. Covering it here would black out the window's only agent list for nothing.
    useUiStore.setState({ workModeBySide: { left: "build", right: "plan" } } as never);
    useSettingsStore.setState({ beadsEnabled: false } as never);
    render(<SatelliteApp projectId="p1" />);
    expect(bothAgree()).toBe(false);
  });

  it("goes unreachable exactly when the board is up", () => {
    useUiStore.setState({ workModeBySide: { left: "build", right: "plan" } } as never);
    useSettingsStore.setState({ beadsEnabled: true } as never);
    render(<SatelliteApp projectId="p1" />);
    expect(bothAgree()).toBe(true);
  });

  it("becomes reachable again the moment the board unmounts on close", () => {
    useUiStore.setState({ workModeBySide: { left: "build", right: "plan" } } as never);
    useSettingsStore.setState({ beadsEnabled: true } as never);
    render(<SatelliteApp projectId="p1" />);
    expect(bothAgree()).toBe(true); // the precondition, so this cannot pass on an already-false pair
    requestClose();
    expect(bothAgree()).toBe(false);
  });
});

describe("SatelliteApp — the board header's exit placement", () => {
  // THE SECOND HOST OF ONE ROW. BoardFilterBar.tsx's header records that this top row is rendered
  // in TWO places — PlanBoardSlot in Workspace.tsx and here — and that a change made in only one
  // DRIFTS. Until now nothing tested this half of it, so the warning was a comment rather than a
  // guard; these assertions are deliberately the same ones the Workspace copy makes, against the
  // same literal numbers, so a fix applied to one window alone fails here.
  //
  // The requirement, in the founder's words: "The build versus plan toggle should stay left
  // justified when it's in plan mode. It should stay in the same spot that it is when it's in build
  // mode … And then the filters can be to the right of the build and plan toggle, not to the left."
  //
  // Neither PlanBuildToggle nor BoardFilterBar is mocked in this file, so both testids below come
  // from the real components — this is the row that actually ships, not a fixture of itself.
  const renderBoard = () => {
    useUiStore.setState({ workModeBySide: { left: "build", right: "plan" } } as never);
    useSettingsStore.setState({ beadsEnabled: true } as never);
    render(<SatelliteApp projectId="p1" />);
    // VIA THE EXIT CONTROL'S PARENT, NOT THE ROW'S OWN TESTID — the reasoning that picked this
    // lookup still holds, only the control changed: the Build/Plan toggle was retired for a
    // "Close Planning Board" link, which is the same first-child-of-the-row position.
    const mini = screen.getByTestId("plan-column").querySelector<HTMLElement>(
      "[data-testid='plan-board-close']",
    );
    expect(mini).toBeTruthy();
    return mini!.parentElement as HTMLElement;
  };

  it("renders the exit link BEFORE the filter bar, so the filters sit to its right", () => {
    const row = renderBoard();
    const mini = row.querySelector<HTMLElement>("[data-testid='plan-board-close']");
    const filters = row.querySelector<HTMLElement>("[data-testid='board-filter-bar']");
    // Presence first: an order assertion over an absent node passes for the wrong reason.
    expect(mini).toBeTruthy();
    expect(filters).toBeTruthy();
    expect(row.dataset.testid).toBe("plan-board-header");

    // FALSE on the pre-change row, which rendered the filter bar first and the toggle last.
    expect(mini!.compareDocumentPosition(filters!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Stated again as sibling indices, so re-parenting cannot satisfy it by accident.
    const kids = Array.from(row.children);
    expect(kids.indexOf(mini!)).toBe(0);
    expect(kids.indexOf(mini!)).toBeLessThan(kids.indexOf(filters!));
  });

  it("left-justifies the row on the Build header's own inset, so the exit does not move", () => {
    // jsdom does not lay out — getBoundingClientRect is all zeroes (docs/jsdom-test-caveats.md) —
    // so the x is asserted as the declared inset rather than measured. `0 10px` + `minHeight: 34`
    // is AgentSidebar's `.bhd` band, which is the top of the Build column this board covers, so
    // matching it is what puts the exit on the same pixel in both modes — the founder's "keep it
    // where it is so I can switch between them easily", which outlived the control it was said of.
    const row = renderBoard();
    expect(row.style.justifyContent).toBe("flex-start");
    expect(row.style.paddingLeft).toBe("10px");
    expect(row.style.minHeight).toBe("34px");
    // Explicitly NOT the corner it used to be pinned to.
    expect(row.style.justifyContent).not.toBe("flex-end");
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

// ── THE SATELLITE MUST NOT OFFER A BEAD CHAT ────────────────────────────────────────────────────
//
// bead sparkle-1cpomd. The bead card's Chat button hands a draft to `composeHandoffStore`, whose
// ONLY consumer is `ConciergeHost` — and this window mounts no ConciergeHost and no composer
// anywhere in its tree. A draft handed over here would therefore land in a store with no reader and
// be dropped silently (ConciergeHost logs log.error on exactly that), so the button must not exist
// on this side at all.
//
// The hiding mechanism is deliberately NOT a window check: `BoardView`'s `onBeadChat` is optional,
// `BeadCard` renders no control for an absent callback, and THIS call site simply supplies nothing.
// (`windowContext.useIsMainWindow` could not have done the job — it is hard-coded `true`.)
//
// So the fact this file alone can prove is that the real call site passes nothing. What a BoardView
// configured each way actually RENDERS is pinned in components/BoardView.test.tsx, where both
// windows' configurations are mounted side by side in one tree.
describe("SatelliteApp — no bead chat, because there is no composer here", () => {
  it("mounts the board with NO onBeadChat", () => {
    useUiStore.setState({ workModeBySide: { left: "build", right: "plan" } } as never);
    useSettingsStore.setState({ beadsEnabled: true } as never);
    render(<SatelliteApp projectId="p1" />);
    // The board really mounted — otherwise "no onBeadChat" would be true of an empty array.
    expect(screen.getByTestId("board")).toBeTruthy();
    expect(boardProps.length).toBeGreaterThan(0);
    for (const props of boardProps) {
      expect(props.onBeadChat).toBeUndefined();
      // …and the props that ARE passed came through, so the loop above is reading a real render
      // rather than an object that happens to be empty.
      expect(props.project).toBeTruthy();
      expect(props.side).toBeTruthy();
    }
  });
});
