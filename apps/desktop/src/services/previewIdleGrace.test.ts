// @vitest-environment jsdom
//
// `reconcilePreviewIdleGrace` decides which agents' preview servers are COVERED (the pane that was
// showing them is not, right now) and, for each one, arms a stop timer — cancelling it if the pane
// comes back before the grace window elapses. Every row here breaks exactly one condition of
// "covered", which is what makes it falsifiable: delete that condition and precisely one test fails.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./preview", () => ({
  stopPreviewForAgent: vi.fn().mockResolvedValue(null),
}));

import { stopPreviewForAgent } from "./preview";
import {
  reconcilePreviewIdleGrace,
  resetPreviewIdleGraceStateForTests,
  setPreviewIdleGraceMinutesForTests,
  visiblePreviewAgentIds,
} from "./previewIdleGrace";
import { usePreviewStore } from "../stores/previewStore";
import { useProjectStore } from "../stores/projectStore";
import { useUiStore } from "../stores/uiStore";

function seedServing(agentId: string) {
  usePreviewStore.setState({
    byAgent: {
      [agentId]: {
        id: "srv1",
        status: "serving",
        url: "http://127.0.0.1:5199",
        port: 5199,
        error: null,
        startedAt: 0,
        reloadNonce: 0,
      },
    },
  } as never);
}

/** Same shape as `seedServing`, but `installing` — the state that has no port/url yet
 *  (`PreviewManager::reserve_or_reattach` has nothing to report before a port is allocated). */
function seedInstalling(agentId: string) {
  usePreviewStore.setState({
    byAgent: {
      [agentId]: {
        id: "srv1",
        status: "installing",
        url: null,
        port: null,
        error: null,
        startedAt: 0,
        reloadNonce: 0,
      },
    },
  } as never);
}

/** The agent's pane IS on screen: left side, Preview mode, this project, this agent selected. */
function seedVisible(projectId: string, agentId: string) {
  useUiStore.setState({
    workModeBySide: { left: "preview", right: "build" },
    leftProjectId: projectId,
    activeSpecial: null,
  } as never);
  useProjectStore.setState({
    projects: [{ id: projectId, name: "p", agents: [{ id: agentId, name: "a" }], selectedAgentId: agentId }],
    selectedProjectId: null,
  } as never);
}

beforeEach(() => {
  resetPreviewIdleGraceStateForTests();
  setPreviewIdleGraceMinutesForTests(10);
  usePreviewStore.setState({ byAgent: {}, capability: {} } as never);
  useUiStore.setState({
    workModeBySide: { left: "build", right: "build" },
    leftProjectId: null,
    activeSpecial: null,
  } as never);
  useProjectStore.setState({ projects: [], selectedProjectId: null } as never);
  vi.useFakeTimers();
  vi.mocked(stopPreviewForAgent).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("visiblePreviewAgentIds", () => {
  it("reports the left agent when its side is in preview mode with that agent selected", () => {
    seedVisible("p1", "ag1");
    expect(visiblePreviewAgentIds()).toEqual(new Set(["ag1"]));
  });

  it("reports nothing when the side is not in preview mode", () => {
    seedVisible("p1", "ag1");
    useUiStore.setState({ workModeBySide: { left: "build", right: "build" } } as never);
    expect(visiblePreviewAgentIds().size).toBe(0);
  });

  it("reports nothing when no project is assigned to that side", () => {
    useUiStore.setState({ workModeBySide: { left: "preview", right: "build" }, leftProjectId: null } as never);
    expect(visiblePreviewAgentIds().size).toBe(0);
  });

  it("reports nothing for the right side while the Improve-Sparkle special is active", () => {
    useUiStore.setState({
      workModeBySide: { left: "build", right: "preview" },
      activeSpecial: "sparkle",
    } as never);
    useProjectStore.setState({
      projects: [{ id: "p1", name: "p", agents: [{ id: "ag1", name: "a" }], selectedAgentId: "ag1" }],
      selectedProjectId: "p1",
    } as never);
    expect(visiblePreviewAgentIds().size).toBe(0);
  });
});

describe("reconcilePreviewIdleGrace", () => {
  it("does nothing for an agent with no preview entry", () => {
    reconcilePreviewIdleGrace();
    vi.advanceTimersByTime(60 * 60_000);
    expect(stopPreviewForAgent).not.toHaveBeenCalled();
  });

  it("does not arm a timer while the agent's pane is visible", () => {
    seedVisible("p1", "ag1");
    seedServing("ag1");
    reconcilePreviewIdleGrace();
    vi.advanceTimersByTime(60 * 60_000);
    expect(stopPreviewForAgent).not.toHaveBeenCalled();
  });

  it("arms a timer once the pane covering it is gone, and stops the server when it fires", () => {
    seedServing("ag1"); // no seedVisible — nothing shows this agent
    reconcilePreviewIdleGrace();
    vi.advanceTimersByTime(10 * 60_000 - 1);
    expect(stopPreviewForAgent).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(stopPreviewForAgent).toHaveBeenCalledWith("ag1");
  });

  it("arms a timer for a covered pane that is still `installing` (roborev 63963)", () => {
    // `installing` was added to `preview.rs`'s `live_for_reattach` — the states worth treating as
    // live — without a matching update to this module's own `LIVE_STATES` mirror. A pane covered
    // while its preview was still waiting on `node_modules` (up to 300s on the Rust side) therefore
    // armed no timer at all: `liveAgentIds()` never counted it as live, so it never entered the
    // "covered and worth timing" set in the first place.
    seedInstalling("ag1"); // no seedVisible — nothing shows this agent
    reconcilePreviewIdleGrace();
    vi.advanceTimersByTime(10 * 60_000 - 1);
    expect(stopPreviewForAgent).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(stopPreviewForAgent).toHaveBeenCalledWith("ag1");
  });

  it("cancels the timer if the pane becomes visible again before the grace window elapses", () => {
    seedServing("ag1");
    reconcilePreviewIdleGrace(); // covered -> timer armed
    vi.advanceTimersByTime(5 * 60_000);
    seedVisible("p1", "ag1");
    reconcilePreviewIdleGrace(); // visible again -> timer cancelled
    vi.advanceTimersByTime(10 * 60_000);
    expect(stopPreviewForAgent).not.toHaveBeenCalled();
  });

  it("does not re-arm a timer that is already pending for the same agent", () => {
    seedServing("ag1");
    reconcilePreviewIdleGrace();
    vi.advanceTimersByTime(9 * 60_000);
    reconcilePreviewIdleGrace(); // still covered; must not push the deadline out further
    vi.advanceTimersByTime(1 * 60_000);
    expect(stopPreviewForAgent).toHaveBeenCalledTimes(1);
  });

  it("cancels the timer once the entry is no longer live (e.g. it already stopped or failed)", () => {
    seedServing("ag1");
    reconcilePreviewIdleGrace();
    vi.advanceTimersByTime(5 * 60_000);
    usePreviewStore.setState({
      byAgent: { ag1: { ...usePreviewStore.getState().byAgent.ag1, status: "stopped" } },
    } as never);
    reconcilePreviewIdleGrace();
    vi.advanceTimersByTime(10 * 60_000);
    expect(stopPreviewForAgent).not.toHaveBeenCalled();
  });

  it("respects a configured idle_grace_min other than the default", () => {
    setPreviewIdleGraceMinutesForTests(1);
    seedServing("ag1");
    reconcilePreviewIdleGrace();
    vi.advanceTimersByTime(1 * 60_000 - 1);
    expect(stopPreviewForAgent).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(stopPreviewForAgent).toHaveBeenCalledWith("ag1");
  });
});
