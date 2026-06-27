// @vitest-environment jsdom
//
// The "Close this worker?" auto-nudge: it pops the moment a worker's branch transitions to Merged,
// it stays quiet for a worker that is ALREADY merged when the sidebar mounts (seed-on-first-sight),
// and "keep it open" dismisses without closing the worker. Heavy leaf components + the Tauri opener
// and worktree teardown are mocked so the sidebar renders without a backend.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("./LogoWaveform", () => ({ LogoWaveform: () => null }));
vi.mock("./StatusBar", () => ({ StatusBar: () => null }));
vi.mock("../services/workerSpawn", () => ({ spawnWorker: vi.fn() }));
vi.mock("../services/worktree", () => ({ removeAgentWorkspace: vi.fn(() => Promise.resolve()) }));

import { AgentSidebar } from "./AgentSidebar";
import { useSettingsStore } from "../stores/settingsStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import type { AgentTab, Project } from "../types";

function worker(id: string): AgentTab {
  return {
    id,
    name: "Enhance Waveform",
    kind: "worker",
    parentId: "build1",
    runtime: "local",
    worktreePath: `/tmp/wt/${id}`,
    branch: `sparkle/agent-${id}`,
    baseBranch: "sparkle/agent-build1",
    lastPrompt: "",
    promptHistory: [],
    namePinned: false,
    autoNameBasis: null,
    autoNameVariants: null,
    shellCommand: null,
  };
}

function projectWith(...agents: AgentTab[]): Project {
  return {
    id: "p1",
    name: "Demo",
    rootPath: "/tmp/demo",
    defaultBranch: null,
    createdAt: new Date(0).toISOString(),
    selectedAgentId: null,
    agents,
  };
}

beforeEach(() => {
  useSettingsStore.getState().setAllAiFeatures(true);
  // Reset the live stage map between tests so a prior test's "merged" can't leak in.
  useRuntimeStore.setState({ branchStatus: {}, workflowStage: {}, openAgentIds: [] });
});
afterEach(() => cleanup());

const PROMPT = "Close this worker?";

describe("AgentSidebar — merged worker close nudge", () => {
  it("pops when a worker transitions to Merged", () => {
    render(<AgentSidebar project={projectWith(worker("w1"))} />);
    // First real datum is a non-merged stage (worker mid-flight) → seeds silently, no modal.
    act(() => useRuntimeStore.getState().setWorkflowStage("w1", "committed"));
    expect(screen.queryByText(PROMPT)).toBeNull();
    // Then it crosses the edge into Merged → nudge appears.
    act(() => useRuntimeStore.getState().setWorkflowStage("w1", "merged"));
    expect(screen.getByText(PROMPT)).toBeTruthy();
  });

  it("stays quiet when the first poll after mount reports a worker already Merged", () => {
    // Fresh-launch path: the live stores aren't persisted, so they're empty at mount and the
    // first poll is this worker's first real datum. "merged" as that first datum means it was
    // already merged before launch — a seed, not a live edge — so it must not nag.
    render(<AgentSidebar project={projectWith(worker("w1"))} />);
    expect(screen.queryByText(PROMPT)).toBeNull();
    act(() => useRuntimeStore.getState().setWorkflowStage("w1", "merged"));
    expect(screen.queryByText(PROMPT)).toBeNull();
  });

  it("stays quiet for a worker already Merged at mount", () => {
    useRuntimeStore.getState().setWorkflowStage("w1", "merged");
    render(<AgentSidebar project={projectWith(worker("w1"))} />);
    expect(screen.queryByText(PROMPT)).toBeNull();
  });

  it("stays quiet for an already-Merged worker even after later store updates re-run the effect", () => {
    // Regression guard: detection must be a non-merged→merged EDGE, not merely "is merged".
    // A worker already Merged at mount seeds silently; later, unrelated polls must not nag it.
    useRuntimeStore.getState().setWorkflowStage("w1", "merged");
    render(<AgentSidebar project={projectWith(worker("w1"), worker("w2"))} />);
    expect(screen.queryByText(PROMPT)).toBeNull();
    // An unrelated worker's status update re-runs the effect…
    act(() => useRuntimeStore.getState().setWorkflowStage("w2", "committed"));
    expect(screen.queryByText(PROMPT)).toBeNull();
    // …and a poll re-confirming w1 is still Merged is not an edge either.
    act(() => useRuntimeStore.getState().setWorkflowStage("w1", "merged"));
    expect(screen.queryByText(PROMPT)).toBeNull();
  });

  it("queues a second worker that merges while the first prompt is open", () => {
    render(<AgentSidebar project={projectWith(worker("w1"), worker("w2"))} />);
    // Both observed non-merged first (real data), so the later merges are genuine edges.
    act(() => {
      useRuntimeStore.getState().setWorkflowStage("w1", "committed");
      useRuntimeStore.getState().setWorkflowStage("w2", "committed");
    });
    act(() => useRuntimeStore.getState().setWorkflowStage("w1", "merged"));
    expect(screen.getAllByText(PROMPT)).toHaveLength(1); // exactly one modal
    // Second worker merges while the first modal is still up → queued, not a second modal.
    act(() => useRuntimeStore.getState().setWorkflowStage("w2", "merged"));
    expect(screen.getAllByText(PROMPT)).toHaveLength(1);
    // Dismiss the first → the queued one is shown.
    fireEvent.click(screen.getByRole("button", { name: "keep it open" }));
    expect(screen.getAllByText(PROMPT)).toHaveLength(1);
    // Dismiss the second → none remain.
    fireEvent.click(screen.getByRole("button", { name: "keep it open" }));
    expect(screen.queryByText(PROMPT)).toBeNull();
  });

  it("queues two workers that cross the edge in the same effect run", () => {
    render(<AgentSidebar project={projectWith(worker("w1"), worker("w2"))} />);
    act(() => {
      useRuntimeStore.getState().setWorkflowStage("w1", "committed");
      useRuntimeStore.getState().setWorkflowStage("w2", "committed");
    });
    // Both reach Merged inside ONE act → a single effect run queues both before either shows.
    act(() => {
      useRuntimeStore.getState().setWorkflowStage("w1", "merged");
      useRuntimeStore.getState().setWorkflowStage("w2", "merged");
    });
    expect(screen.getAllByText(PROMPT)).toHaveLength(1); // one at a time
    fireEvent.click(screen.getByRole("button", { name: "keep it open" }));
    expect(screen.getAllByText(PROMPT)).toHaveLength(1); // the queued second drains in
    fireEvent.click(screen.getByRole("button", { name: "keep it open" }));
    expect(screen.queryByText(PROMPT)).toBeNull();
  });

  it("'keep it open' dismisses and does not re-nag", () => {
    render(<AgentSidebar project={projectWith(worker("w1"))} />);
    act(() => useRuntimeStore.getState().setWorkflowStage("w1", "committed"));
    act(() => useRuntimeStore.getState().setWorkflowStage("w1", "merged"));
    fireEvent.click(screen.getByRole("button", { name: "keep it open" }));
    expect(screen.queryByText(PROMPT)).toBeNull();
    // A later poll that re-confirms Merged must not bring the modal back.
    act(() => useRuntimeStore.getState().setWorkflowStage("w1", "merged"));
    expect(screen.queryByText(PROMPT)).toBeNull();
  });
});
