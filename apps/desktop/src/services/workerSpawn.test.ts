import { describe, it, expect, beforeEach, vi } from "vitest";
import { useAuthStore } from "../stores/authStore";
import { useSettingsStore } from "../stores/settingsStore";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

// Preserve real ../pty exports (spawnWorker tests rely on real createWorkerWorktree which
// calls the already-mocked invoke above) — only override killPty.
// vi.fn() with no impl → typed as Mock<any[], any>, so spreading unknown[] into it is allowed.
// (vi.fn(() => impl) would infer [] for Args and break the spread.)
const killPtyMock = vi.fn();
vi.mock("../pty", async (orig) => ({
  ...(await orig<typeof import("../pty")>()),
  killPty: (...a: unknown[]) => killPtyMock(...a),
}));
const removeWtMock = vi.fn();
vi.mock("./worktree", async (orig) => ({
  ...(await orig<typeof import("./worktree")>()),
  removeAgentWorktree: (...a: unknown[]) => removeWtMock(...a),
}));

import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { spawnWorker, spinDownWorker } from "./workerSpawn";

describe("spawnWorker", () => {
  beforeEach(() => {
    useProjectStore.setState({ projects: [], selectedProjectId: null });
    invokeMock.mockReset();
    // Default: AI enhancements locked (anonymous) so the auto-name path stays dormant and these
    // tests assert spawn mechanics without a second (generate_agent_name) invoke.
    useAuthStore.setState({ me: null });
  });

  it("creates a worker tab under the parent, cuts a worktree from the parent branch, and persists it", async () => {
    const store = useProjectStore.getState();
    const projectId = store.addProject("Demo", "/tmp/demo");
    const buildId = store.addAgent(projectId, { kind: "build" });
    // Give the parent a known branch (as the worktree step would have).
    store.setAgentWorktree(projectId, buildId, "/wt/build", "sparkle/agent-build1");

    invokeMock.mockResolvedValueOnce({ path: "/wt/worker", branch: "sparkle/agent-w" });

    const spawned = await spawnWorker({ projectId, parentAgentId: buildId, task: "Build login" });
    const workerId = spawned.workerId;

    // The return carries the AUTHORITATIVE identity captured from the worktree cut (not re-read from
    // the store), so the orchestration reply can never degrade to empty branch/worktree (sparkle-yk3x).
    expect(spawned.branch).toBe("sparkle/agent-w");
    expect(spawned.worktree).toBe("/wt/worker");

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

  it("auto-names the worker from its task when the autoRename feature is unlocked", async () => {
    // Has credits + setting on → the same auto-name path that names build agents from their first
    // typed prompt now names a worker from its injected task (it never flows through the Composer).
    useAuthStore.setState({ me: { clerkUserId: "u", entitled: true, balanceCents: 20000, tokenVersion: 0 } });
    useSettingsStore.setState({ aiAutoRename: true });

    const store = useProjectStore.getState();
    const projectId = store.addProject("Demo", "/tmp/demo");
    const buildId = store.addAgent(projectId, { kind: "build" });
    store.setAgentWorktree(projectId, buildId, "/wt/build", "sparkle/agent-build1");

    // Key the mock on the command name (not call order): maybeAutoName fires unawaited (void), so
    // a queued mockResolvedValueOnce would be brittle to any incidental invoke landing between the
    // worktree cut and the naming call.
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "create_worker_worktree") return Promise.resolve({ path: "/wt/worker", branch: "sparkle/agent-w" });
      if (cmd === "generate_agent_name") return Promise.resolve({ title: "Login flow", description: "Build the login flow" });
      return Promise.resolve(undefined);
    });

    const { workerId } = await spawnWorker({ projectId, parentAgentId: buildId, task: "Build the login flow" });

    // The naming backend was called with the worker's task as the basis.
    await vi.waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("generate_agent_name", { prompt: "Build the login flow" }),
    );
    await vi.waitFor(() => {
      const worker = useProjectStore.getState().projects.find((p) => p.id === projectId)!
        .agents.find((a) => a.id === workerId)!;
      expect(worker.name).toBe("Login flow");
      expect(worker.autoNameVariants?.title).toBe("Login flow");
    });
  });

  it("does NOT auto-name the worker when AI enhancements are locked (anonymous trial)", async () => {
    useAuthStore.setState({ me: null }); // not entitled
    useSettingsStore.setState({ aiAutoRename: true });

    const store = useProjectStore.getState();
    const projectId = store.addProject("Demo", "/tmp/demo");
    const buildId = store.addAgent(projectId, { kind: "build" });
    store.setAgentWorktree(projectId, buildId, "/wt/build", "sparkle/agent-build1");

    invokeMock.mockResolvedValueOnce({ path: "/wt/worker", branch: "sparkle/agent-w" });

    await spawnWorker({ projectId, parentAgentId: buildId, task: "Build the login flow" });

    // Only the worktree call — no billed naming call when the feature is gated off.
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).not.toHaveBeenCalledWith("generate_agent_name", expect.anything());
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

describe("spinDownWorker", () => {
  beforeEach(() => {
    vi.restoreAllMocks(); // restore any vi.spyOn (e.g. runtime-store close) so it can't leak between tests
    useProjectStore.setState({ projects: [], selectedProjectId: null });
    useRuntimeStore.setState({ status: {}, openAgentIds: [], branchStatus: {} });
    killPtyMock.mockReset();
    killPtyMock.mockResolvedValue(undefined);
    removeWtMock.mockReset();
    removeWtMock.mockResolvedValue(undefined);
  });

  it("kills pty, removes worktree, closes runtime entry, removes tab, keeps branch", async () => {
    const store = useProjectStore.getState();
    const projectId = store.addProject("Demo", "/tmp/demo");
    const buildId = store.addAgent(projectId, { kind: "build" });
    store.setAgentWorktree(projectId, buildId, "/wt/build", "sparkle/agent-build1");
    const workerId = store.addAgent(projectId, { kind: "worker", parentId: buildId });
    store.setAgentWorktree(projectId, workerId, "/wt/w", "sparkle/agent-w");

    // Spy on the runtime store's close to assert the 4th teardown step fires.
    const runtimeCloseMock = vi.spyOn(useRuntimeStore.getState(), "close");
    await spinDownWorker({ projectId, workerId });

    expect(killPtyMock).toHaveBeenCalledWith(workerId);
    expect(removeWtMock).toHaveBeenCalledWith("/tmp/demo", projectId, workerId);
    expect(runtimeCloseMock).toHaveBeenCalledWith(workerId); // runtime entry closed
    const agents = useProjectStore.getState().projects.find((p) => p.id === projectId)!.agents;
    expect(agents.some((a) => a.id === workerId)).toBe(false); // tab gone
  });

  it("is a no-op for an unknown project or worker id (idempotent)", async () => {
    const store = useProjectStore.getState();
    const projectId = store.addProject("Demo", "/tmp/demo");

    await expect(spinDownWorker({ projectId, workerId: "ghost" })).resolves.toBeUndefined();
    await expect(spinDownWorker({ projectId: "ghost", workerId: "ghost" })).resolves.toBeUndefined();

    expect(killPtyMock).not.toHaveBeenCalled();
    expect(removeWtMock).not.toHaveBeenCalled();
  });

  it("is a no-op when passed a build agent id (worker-only contract)", async () => {
    const store = useProjectStore.getState();
    const projectId = store.addProject("Demo", "/tmp/demo");
    const buildId = store.addAgent(projectId, { kind: "build" });
    store.setAgentWorktree(projectId, buildId, "/wt/build", "sparkle/agent-build1");
    const workerId = store.addAgent(projectId, { kind: "worker", parentId: buildId });

    // Passing the build id must NOT tear anything down: removeAgent cascades to the build's
    // workers, which would orphan their PTYs/worktrees (this fn only tears down the passed id).
    await spinDownWorker({ projectId, workerId: buildId });

    expect(killPtyMock).not.toHaveBeenCalled();
    expect(removeWtMock).not.toHaveBeenCalled();
    const agents = useProjectStore.getState().projects.find((p) => p.id === projectId)!.agents;
    expect(agents.some((a) => a.id === buildId)).toBe(true); // build still present
    expect(agents.some((a) => a.id === workerId)).toBe(true); // its worker not cascade-removed
  });

  it("still removes the tab when killPty / removeAgentWorktree reject", async () => {
    const store = useProjectStore.getState();
    const projectId = store.addProject("Demo", "/tmp/demo");
    const buildId = store.addAgent(projectId, { kind: "build" });
    store.setAgentWorktree(projectId, buildId, "/wt/build", "sparkle/agent-build1");
    const workerId = store.addAgent(projectId, { kind: "worker", parentId: buildId });
    store.setAgentWorktree(projectId, workerId, "/wt/w", "sparkle/agent-w");

    killPtyMock.mockRejectedValue(new Error("pty gone"));
    removeWtMock.mockRejectedValue(new Error("git failed"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(spinDownWorker({ projectId, workerId })).resolves.toBeUndefined();

    const agents = useProjectStore.getState().projects.find((p) => p.id === projectId)!.agents;
    expect(agents.some((a) => a.id === workerId)).toBe(false); // tab removed despite failures
    warnSpy.mockRestore();
  });
});
