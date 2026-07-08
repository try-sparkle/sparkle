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
const removeWsMock = vi.fn();
vi.mock("./worktree", async (orig) => ({
  ...(await orig<typeof import("./worktree")>()),
  removeAgentWorkspace: (...a: unknown[]) => removeWsMock(...a),
}));

import { useProjectStore, isWorkerTearingDown } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { spawnWorker, spinDownWorker } from "./workerSpawn";

describe("spawnWorker", () => {
  beforeEach(() => {
    useProjectStore.setState({ projects: [], selectedProjectId: null });
    invokeMock.mockReset();
    // rollback() awaits removeAgentWorkspace(...).catch(...), so the mock must return a thenable;
    // reset per-test so the "not called" assertion isn't polluted by a prior rollback test.
    removeWsMock.mockReset();
    removeWsMock.mockResolvedValue(undefined);
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

    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "create_worker_worktree")
        return Promise.resolve({ path: "/wt/worker", branch: "sparkle/agent-w" });
      return Promise.resolve(undefined); // write_worker_manifest, etc.
    });

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

    // sparkle-hwfv: a durable manifest was written INTO the worktree before returning, carrying the
    // worker's disk-authoritative identity (task-on-disk kills the taskless-stall on eviction).
    expect(invokeMock).toHaveBeenCalledWith("write_worker_manifest", {
      worktree: "/wt/worker",
      manifest: expect.objectContaining({
        workerId,
        buildAgentId: buildId,
        projectId,
        branch: "sparkle/agent-w",
        worktree: "/wt/worker",
        task: "Build login",
      }),
    });

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

    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "create_worker_worktree")
        return Promise.resolve({ path: "/wt/worker", branch: "sparkle/agent-w" });
      return Promise.resolve(undefined);
    });

    await spawnWorker({ projectId, parentAgentId: buildId, task: "Build the login flow" });

    // The worktree cut + the durable manifest write — but NO billed naming call when gated off.
    expect(invokeMock).toHaveBeenCalledWith("create_worker_worktree", expect.anything());
    expect(invokeMock).toHaveBeenCalledWith("write_worker_manifest", expect.anything());
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

  it("rolls back the just-cut worktree AND the tab if the manifest write fails (fail-closed, a670)", async () => {
    const store = useProjectStore.getState();
    const projectId = store.addProject("Demo", "/tmp/demo");
    const buildId = store.addAgent(projectId, { kind: "build" });
    store.setAgentWorktree(projectId, buildId, "/wt/build", "sparkle/agent-build1");
    const before = useProjectStore.getState().projects.find((p) => p.id === projectId)!.agents.length;

    // Worktree cut succeeds, but persisting the durable manifest fails → the whole spawn must roll
    // back so we NEVER return a worktree for a worker that isn't fully registered.
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "create_worker_worktree")
        return Promise.resolve({ path: "/wt/worker", branch: "sparkle/agent-w" });
      if (cmd === "write_worker_manifest") return Promise.reject(new Error("disk full"));
      return Promise.resolve(undefined);
    });

    await expect(spawnWorker({ projectId, parentAgentId: buildId, task: "x" })).rejects.toThrow(
      /disk full/,
    );

    // The just-cut worktree was removed from disk (rollback), and the orphan tab is gone.
    expect(removeWsMock).toHaveBeenCalledWith("/tmp/demo", projectId, expect.any(String));
    const proj = useProjectStore.getState().projects.find((p) => p.id === projectId)!;
    expect(proj.agents.length).toBe(before);
    expect(proj.agents.some((a) => a.kind === "worker")).toBe(false);
    expect(proj.selectedAgentId).toBe(buildId);
  });

  it("does NOT try to remove a worktree when the cut itself failed (nothing to roll back)", async () => {
    const store = useProjectStore.getState();
    const projectId = store.addProject("Demo", "/tmp/demo");
    const buildId = store.addAgent(projectId, { kind: "build" });
    store.setAgentWorktree(projectId, buildId, "/wt/build", "sparkle/agent-build1");

    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "create_worker_worktree") return Promise.reject(new Error("git failed"));
      return Promise.resolve(undefined);
    });

    await expect(spawnWorker({ projectId, parentAgentId: buildId, task: "x" })).rejects.toThrow(
      /git failed/,
    );
    // No worktree exists yet, so removeAgentWorkspace must NOT be called on this path.
    expect(removeWsMock).not.toHaveBeenCalled();
  });
});

describe("spinDownWorker", () => {
  beforeEach(() => {
    vi.restoreAllMocks(); // restore any vi.spyOn (e.g. runtime-store close) so it can't leak between tests
    useProjectStore.setState({ projects: [], selectedProjectId: null });
    useRuntimeStore.setState({ status: {}, openAgentIds: [], branchStatus: {} });
    killPtyMock.mockReset();
    killPtyMock.mockResolvedValue(undefined);
    removeWsMock.mockReset();
    removeWsMock.mockResolvedValue(undefined);
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
    expect(removeWsMock).toHaveBeenCalledWith("/tmp/demo", projectId, workerId);
    expect(runtimeCloseMock).toHaveBeenCalledWith(workerId); // runtime entry closed
    const agents = useProjectStore.getState().projects.find((p) => p.id === projectId)!.agents;
    expect(agents.some((a) => a.id === workerId)).toBe(false); // tab gone
  });

  it("drops the worker row SYNCHRONOUSLY, before the worktree reap resolves (row can't linger on a contended repo lock)", async () => {
    const store = useProjectStore.getState();
    const projectId = store.addProject("Demo", "/tmp/demo");
    const buildId = store.addAgent(projectId, { kind: "build" });
    store.setAgentWorktree(projectId, buildId, "/wt/build", "sparkle/agent-build1");
    const workerId = store.addAgent(projectId, { kind: "worker", parentId: buildId });
    store.setAgentWorktree(projectId, workerId, "/wt/w", "sparkle/agent-w");

    // removeAgentWorkspace serializes on the shared repo lock; simulate a contended lock by making it
    // never resolve. The OLD ordering awaited it BEFORE removeAgent, so the row lingered for as long
    // as the lock was held. The fix drops the row synchronously and reaps in the background.
    let releaseReap!: () => void;
    removeWsMock.mockReturnValue(new Promise<void>((r) => (releaseReap = () => r(undefined))));

    const pending = spinDownWorker({ projectId, workerId }); // NB: not awaited — reap is still stuck

    // Row is already gone and the id is tombstoned, even though removeAgentWorkspace hasn't resolved.
    const agentsNow = useProjectStore.getState().projects.find((p) => p.id === projectId)!.agents;
    expect(agentsNow.some((a) => a.id === workerId)).toBe(false);
    expect(isWorkerTearingDown(workerId)).toBe(true);

    releaseReap(); // let the background reap finish
    await pending;
    // Tombstone clears once the worktree (and its manifest) is gone, so a legit orphan can reconcile later.
    expect(isWorkerTearingDown(workerId)).toBe(false);
    expect(removeWsMock).toHaveBeenCalledWith("/tmp/demo", projectId, workerId);
  });

  it("clears the tombstone even if the worktree reap rejects (never shields a ghost id forever)", async () => {
    const store = useProjectStore.getState();
    const projectId = store.addProject("Demo", "/tmp/demo");
    const buildId = store.addAgent(projectId, { kind: "build" });
    store.setAgentWorktree(projectId, buildId, "/wt/build", "sparkle/agent-build1");
    const workerId = store.addAgent(projectId, { kind: "worker", parentId: buildId });
    store.setAgentWorktree(projectId, workerId, "/wt/w", "sparkle/agent-w");

    removeWsMock.mockRejectedValue(new Error("git failed"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await spinDownWorker({ projectId, workerId });

    expect(isWorkerTearingDown(workerId)).toBe(false);
    warnSpy.mockRestore();
  });

  it("is a no-op for an unknown project or worker id (idempotent)", async () => {
    const store = useProjectStore.getState();
    const projectId = store.addProject("Demo", "/tmp/demo");

    await expect(spinDownWorker({ projectId, workerId: "ghost" })).resolves.toBeUndefined();
    await expect(spinDownWorker({ projectId: "ghost", workerId: "ghost" })).resolves.toBeUndefined();

    expect(killPtyMock).not.toHaveBeenCalled();
    expect(removeWsMock).not.toHaveBeenCalled();
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
    expect(removeWsMock).not.toHaveBeenCalled();
    const agents = useProjectStore.getState().projects.find((p) => p.id === projectId)!.agents;
    expect(agents.some((a) => a.id === buildId)).toBe(true); // build still present
    expect(agents.some((a) => a.id === workerId)).toBe(true); // its worker not cascade-removed
  });

  it("still removes the tab when killPty / removeAgentWorkspace reject", async () => {
    const store = useProjectStore.getState();
    const projectId = store.addProject("Demo", "/tmp/demo");
    const buildId = store.addAgent(projectId, { kind: "build" });
    store.setAgentWorktree(projectId, buildId, "/wt/build", "sparkle/agent-build1");
    const workerId = store.addAgent(projectId, { kind: "worker", parentId: buildId });
    store.setAgentWorktree(projectId, workerId, "/wt/w", "sparkle/agent-w");

    killPtyMock.mockRejectedValue(new Error("pty gone"));
    removeWsMock.mockRejectedValue(new Error("git failed"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(spinDownWorker({ projectId, workerId })).resolves.toBeUndefined();

    const agents = useProjectStore.getState().projects.find((p) => p.id === projectId)!.agents;
    expect(agents.some((a) => a.id === workerId)).toBe(false); // tab removed despite failures
    warnSpy.mockRestore();
  });
});
