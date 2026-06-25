import { describe, it, expect, beforeEach, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

import { useProjectStore } from "../stores/projectStore";
import { spawnWorker } from "./workerSpawn";

describe("spawnWorker", () => {
  beforeEach(() => {
    useProjectStore.setState({ projects: [], selectedProjectId: null });
    invokeMock.mockReset();
  });

  it("creates a worker tab under the parent, cuts a worktree from the parent branch, and persists it", async () => {
    const store = useProjectStore.getState();
    const projectId = store.addProject("Demo", "/tmp/demo");
    const buildId = store.addAgent(projectId, { kind: "build" });
    // Give the parent a known branch (as the worktree step would have).
    store.setAgentWorktree(projectId, buildId, "/wt/build", "sparkle/agent-build1");

    invokeMock.mockResolvedValueOnce({ path: "/wt/worker", branch: "sparkle/agent-w" });

    const workerId = await spawnWorker({ projectId, parentAgentId: buildId, task: "Build login" });

    // Tauri call used the parent's branch as the base.
    expect(invokeMock).toHaveBeenCalledWith("create_worker_worktree", expect.objectContaining({
      root: "/tmp/demo", projectId, workerId, parentBranch: "sparkle/agent-build1",
    }));

    const proj = useProjectStore.getState().projects.find((p) => p.id === projectId)!;
    const worker = proj.agents.find((a) => a.id === workerId)!;
    expect(worker.kind).toBe("worker");
    expect(worker.parentId).toBe(buildId);
    expect(worker.task).toBe("Build login");
    expect(worker.worktreePath).toBe("/wt/worker");
    expect(worker.branch).toBe("sparkle/agent-w");
    // Successful spawn selects the new worker tab (drives PTY launch in AgentPane).
    expect(proj.selectedAgentId).toBe(workerId);
  });

  it("throws if the parent has no branch yet", async () => {
    const store = useProjectStore.getState();
    const projectId = store.addProject("Demo", "/tmp/demo");
    const buildId = store.addAgent(projectId, { kind: "build" });
    await expect(spawnWorker({ projectId, parentAgentId: buildId, task: "x" }))
      .rejects.toThrow(/branch/);
  });

  it("rolls back the worker tab if worktree creation fails (no orphan)", async () => {
    const store = useProjectStore.getState();
    const projectId = store.addProject("Demo", "/tmp/demo");
    const buildId = store.addAgent(projectId, { kind: "build" });
    store.setAgentWorktree(projectId, buildId, "/wt/build", "sparkle/agent-build1");
    const before = useProjectStore.getState().projects.find((p) => p.id === projectId)!.agents.length;

    invokeMock.mockRejectedValueOnce(new Error("git failed"));
    await expect(spawnWorker({ projectId, parentAgentId: buildId, task: "x" }))
      .rejects.toThrow(/git failed/);

    const proj = useProjectStore.getState().projects.find((p) => p.id === projectId)!;
    expect(proj.agents.length).toBe(before); // orphan worker tab was removed
    expect(proj.agents.some((a) => a.kind === "worker")).toBe(false);
    // Selection is restored to the build agent the user was on before the spawn attempt.
    expect(proj.selectedAgentId).toBe(buildId);
  });
});
