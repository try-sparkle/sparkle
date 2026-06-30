// @vitest-environment jsdom
//
// The cross-window red-agents block: red agents from OTHER open windows render above this window's
// own list, each with a project pill, and clicking one routes to the owning window (emitFocusAgent
// for an already-open window). Heavy leaf components + Tauri opener are mocked so the sidebar renders.
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("./LogoWaveform", () => ({ LogoWaveform: () => null }));
vi.mock("./StatusBar", () => ({ StatusBar: () => null }));
vi.mock("../services/workerSpawn", () => ({ spawnWorker: vi.fn() }));

const emitFocusAgent = vi.fn();
vi.mock("../services/attention", () => ({ emitFocusAgent: (...a: unknown[]) => emitFocusAgent(...a) }));

const openProjectInWindow = vi.fn().mockResolvedValue(undefined);
vi.mock("../services/projectWindows", () => ({
  openProjectInWindow: (...a: unknown[]) => openProjectInWindow(...a),
  defaultDeps: () => ({}),
}));

import { AgentSidebar } from "./AgentSidebar";
import { useSettingsStore } from "../stores/settingsStore";
import { useAuthStore } from "../stores/authStore";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { publishWindowRedAgents, resetWindowStatus } from "../services/windowStatus";
import { setWindowProject, resetWindowRegistry } from "../services/windowRegistry";
import type { Project } from "../types";

const entitledMe = { clerkUserId: "u", entitled: true, balanceCents: 20000, tokenVersion: 1 };

const project: Project = {
  id: "p1",
  name: "Demo",
  rootPath: "/tmp/demo",
  defaultBranch: null,
  createdAt: new Date(0).toISOString(),
  selectedAgentId: null,
  agents: [],
};

beforeEach(() => {
  localStorage.clear();
  resetWindowStatus();
  resetWindowRegistry();
  emitFocusAgent.mockClear();
  openProjectInWindow.mockClear();
  useSettingsStore.getState().setAllAiFeatures(true);
  useAuthStore.setState({ me: entitledMe, tokenPresent: true, loading: false });
});
afterEach(() => cleanup());

describe("AgentSidebar — cross-window red agents", () => {
  it("renders no block when there are no other-window red agents", () => {
    render(<AgentSidebar project={project} />);
    expect(screen.queryByText("Other Proj")).toBeNull();
  });

  it("shows an other-window red agent with its project pill, and routes a click via emitFocusAgent", () => {
    // Window B is open (registered) and has a waiting agent.
    setWindowProject("win-B", "projB");
    publishWindowRedAgents("win-B", "projB", "Other Proj", [
      { id: "agentB", name: "Worker B", status: "waiting" },
    ]);

    render(<AgentSidebar project={project} />);

    // Pill (project name) + agent name are both present.
    expect(screen.getByText("Other Proj")).toBeTruthy();
    const row = screen.getByText("Worker B");
    expect(row).toBeTruthy();

    fireEvent.click(row);
    expect(emitFocusAgent).toHaveBeenCalledWith({ projectId: "projB", agentId: "agentB" });
    expect(openProjectInWindow).not.toHaveBeenCalled();
  });

  it("focuses in place when the other window happens to show THIS window's project", () => {
    // win-B is a different window but coincidentally shows the same project (p1). Clicking should
    // select+open the agent here, not raise another window.
    const selectAgent = vi.spyOn(useProjectStore.getState(), "selectAgent");
    const open = vi.spyOn(useRuntimeStore.getState(), "open");
    setWindowProject("win-B", "p1");
    publishWindowRedAgents("win-B", "p1", "Demo", [
      { id: "agentSame", name: "Same Proj Worker", status: "waiting" },
    ]);

    render(<AgentSidebar project={project} />);
    fireEvent.click(screen.getByText("Same Proj Worker"));

    expect(selectAgent).toHaveBeenCalledWith("p1", "agentSame");
    expect(open).toHaveBeenCalledWith("agentSame");
    expect(emitFocusAgent).not.toHaveBeenCalled();
    expect(openProjectInWindow).not.toHaveBeenCalled();
    selectAgent.mockRestore();
    open.mockRestore();
  });

  it("falls back to opening a window when the owning window has closed (render→click race)", () => {
    // Published but NOT registered: the open-window check excludes it from the rendered block, so to
    // exercise the fallback we register at render time then close before the click.
    setWindowProject("win-B", "projB");
    publishWindowRedAgents("win-B", "projB", "Other Proj", [
      { id: "agentB", name: "Worker B", status: "errored" },
    ]);
    render(<AgentSidebar project={project} />);
    const row = screen.getByText("Worker B");

    // Window B closes between render and click.
    resetWindowRegistry();
    fireEvent.click(row);
    expect(emitFocusAgent).not.toHaveBeenCalled();
    expect(openProjectInWindow).toHaveBeenCalledWith("projB", "new", expect.anything(), "agentB");
  });
});
