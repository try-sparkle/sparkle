import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useProjectStore } from "../stores/projectStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { listen } from "@tauri-apps/api/event";

// --- mock the Tauri event/invoke layer ---
let firedHandler: ((e: { payload: unknown }) => void) | undefined;
const unlistenMock = vi.fn();
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((_event: string, cb: (e: { payload: unknown }) => void) => {
    firedHandler = cb;
    return Promise.resolve(unlistenMock);
  }),
}));
// vi.fn() with no impl → typed as Mock<any[], any>, so spreading unknown[] into it is allowed.
// (vi.fn(() => impl) would infer [] for Args and break the spread — see workerSpawn.test.ts.)
const invokeMock = vi.fn();
invokeMock.mockReturnValue(Promise.resolve()); // respond() calls .then() — must return a thenable
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

// --- mock workerSpawn so no real worktree/PTY is touched; spawnWorker registers a real tab so
//     the listener can read back branch/worktree from the store. ---
const defaultSpawnImpl = async (args: { projectId: string; parentAgentId: string; task: string }) => {
  const id = useProjectStore.getState().addAgent(args.projectId, {
    kind: "worker",
    parentId: args.parentAgentId,
    task: args.task,
  });
  useProjectStore.getState().setAgentWorktree(args.projectId, id, `/wt/${id}`, `sparkle/agent-${id}`);
  return id;
};
const spawnWorkerMock = vi.fn(defaultSpawnImpl);
const spinDownWorkerMock = vi.fn(async (args: { projectId: string; workerId: string }) => {
  useProjectStore.getState().removeAgent(args.projectId, args.workerId);
});
vi.mock("./workerSpawn", () => ({
  spawnWorker: (a: unknown) => spawnWorkerMock(a as never),
  spinDownWorker: (a: unknown) => spinDownWorkerMock(a as never),
}));

import { startOrchestrationListener, type OrchestrationRequest } from "./orchestrationListener";

const fire = (req: OrchestrationRequest) => firedHandler!({ payload: req });
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("orchestrationListener", () => {
  let cleanup: (() => void) | undefined;
  let projectId: string;
  let buildId: string;

  beforeEach(async () => {
    firedHandler = undefined;
    invokeMock.mockClear();
    // mockReset (not mockClear) so a per-test mockImplementationOnce / mockRejectedValueOnce can't
    // leak its leftover queued impl into the next test; then restore the default registering impl.
    spawnWorkerMock.mockReset();
    spawnWorkerMock.mockImplementation(defaultSpawnImpl);
    spinDownWorkerMock.mockClear();
    unlistenMock.mockClear();
    // Reset the store so projects don't accumulate across tests (liveWorkerCount scans all of them).
    useProjectStore.setState({ projects: [], selectedProjectId: null });
    useRuntimeStore.setState({ openAgentIds: [] });
    useSettingsStore.setState({ maxConcurrentWorkers: 4 });
    const store = useProjectStore.getState();
    projectId = store.addProject("Demo", "/tmp/demo");
    buildId = store.addAgent(projectId, { kind: "build" });
    store.setAgentWorktree(projectId, buildId, "/wt/build", "sparkle/agent-build");
    cleanup = await startOrchestrationListener();
  });
  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
  });

  it("spawn_worker → calls spawnWorker for this build agent and replies workerId/branch/worktree", async () => {
    fire({ reqId: "r1", op: "spawn_worker", buildAgentId: buildId, projectId, payload: { task: "build parser" } });
    await flush();
    expect(spawnWorkerMock).toHaveBeenCalledWith({ projectId, parentAgentId: buildId, task: "build parser" });
    const [, args] = invokeMock.mock.calls.at(-1)!;
    expect((args as { reqId: string }).reqId).toBe("r1");
    const result = (args as { result: { workerId: string; branch: string; worktree: string } }).result;
    expect(result.workerId).toBeTruthy();
    expect(result.branch).toMatch(/^sparkle\/agent-/);
    expect(result.worktree).toMatch(/^\/wt\//);
  });

  it("spawn_worker → auto-opens the worker (adds it to openAgentIds) so its PTY launches", async () => {
    fire({ reqId: "o1", op: "spawn_worker", buildAgentId: buildId, projectId, payload: { task: "auto-start me" } });
    await flush();
    const [, args] = invokeMock.mock.calls.at(-1)!;
    const workerId = (args as { result: { workerId: string } }).result.workerId;
    expect(workerId).toBeTruthy();
    // Opening is what mounts AgentPane and launches the worker PTY — without it the worker would
    // sit idle in the sidebar showing "Start this agent".
    expect(useRuntimeStore.getState().openAgentIds).toContain(workerId);
  });

  it("list_workers → replies with this build agent's workers only", async () => {
    fire({ reqId: "s1", op: "spawn_worker", buildAgentId: buildId, projectId, payload: { task: "a" } });
    await flush();
    invokeMock.mockClear();
    fire({ reqId: "l1", op: "list_workers", buildAgentId: buildId, projectId, payload: {} });
    await flush();
    const [, args] = invokeMock.mock.calls.at(-1)!;
    const workers = (args as { result: { workers: Array<{ workerId: string; status: string }> } }).result.workers;
    expect(workers.length).toBe(1);
    expect(workers[0]!.status).toBe("running");
  });

  it("spin_down → tears down the worker and replies spunDown:true", async () => {
    const workerId = useProjectStore.getState().addAgent(projectId, { kind: "worker", parentId: buildId });
    fire({ reqId: "d1", op: "spin_down", buildAgentId: buildId, projectId, payload: { workerId } });
    await flush();
    expect(spinDownWorkerMock).toHaveBeenCalledWith({ projectId, workerId });
    const [, args] = invokeMock.mock.calls.at(-1)!;
    expect((args as { result: { spunDown: boolean } }).result.spunDown).toBe(true);
  });

  it("spin_down of a worker owned by a DIFFERENT build agent is rejected (no cross-agent reach)", async () => {
    const otherBuild = useProjectStore.getState().addAgent(projectId, { kind: "build" });
    const foreign = useProjectStore.getState().addAgent(projectId, { kind: "worker", parentId: otherBuild });
    fire({ reqId: "x1", op: "spin_down", buildAgentId: buildId, projectId, payload: { workerId: foreign } });
    await flush();
    expect(spinDownWorkerMock).not.toHaveBeenCalled();
    const [, args] = invokeMock.mock.calls.at(-1)!;
    expect((args as { result: { error?: string } }).result.error).toMatch(/not owned/i);
  });

  it("queues spawns past the cap, then releases one when a slot frees via spin_down", async () => {
    useSettingsStore.setState({ maxConcurrentWorkers: 1 });
    // First spawn fills the only slot.
    fire({ reqId: "q1", op: "spawn_worker", buildAgentId: buildId, projectId, payload: { task: "first" } });
    await flush();
    expect(spawnWorkerMock).toHaveBeenCalledTimes(1);
    // Second spawn is over the cap → queued, no reply yet.
    invokeMock.mockClear();
    fire({ reqId: "q2", op: "spawn_worker", buildAgentId: buildId, projectId, payload: { task: "second" } });
    await flush();
    expect(spawnWorkerMock).toHaveBeenCalledTimes(1); // still queued
    expect(invokeMock).not.toHaveBeenCalled(); // q2 reply deferred
    // Free the slot: spin down the first worker. The queued q2 spawn then runs and replies.
    const firstWorker = useProjectStore
      .getState()
      .projects.find((p) => p.id === projectId)!
      .agents.find((a) => a.kind === "worker" && a.parentId === buildId)!.id;
    fire({ reqId: "d2", op: "spin_down", buildAgentId: buildId, projectId, payload: { workerId: firstWorker } });
    await flush();
    await flush();
    expect(spawnWorkerMock).toHaveBeenCalledTimes(2); // q2 released
    const reqIds = invokeMock.mock.calls.map(([, a]) => (a as { reqId: string }).reqId);
    expect(reqIds).toContain("q2");
  });

  it("does NOT over-spawn when two spawns race past the cap with no flush between them", async () => {
    useSettingsStore.setState({ maxConcurrentWorkers: 1 });
    // Model the real async gap: spawnWorker registers the worker tab only AFTER it yields, so a
    // cap check on liveWorkerCount ALONE would see the pre-spawn count (0) for BOTH events and let
    // both through. The synchronous in-flight reservation is what makes the second event queue.
    const deferredSpawn = async (args: { projectId: string; parentAgentId: string; task: string }) => {
      await Promise.resolve(); // yield before registering — neither worker exists at c2's cap check
      const id = useProjectStore.getState().addAgent(args.projectId, {
        kind: "worker",
        parentId: args.parentAgentId,
        task: args.task,
      });
      useProjectStore.getState().setAgentWorktree(args.projectId, id, `/wt/${id}`, `sparkle/agent-${id}`);
      return id;
    };
    spawnWorkerMock.mockImplementationOnce(deferredSpawn).mockImplementationOnce(deferredSpawn);
    // Fire BOTH synchronously — no flush between, so neither worker is registered yet when the
    // second event's cap check runs.
    fire({ reqId: "c1", op: "spawn_worker", buildAgentId: buildId, projectId, payload: { task: "first" } });
    fire({ reqId: "c2", op: "spawn_worker", buildAgentId: buildId, projectId, payload: { task: "second" } });
    await flush();
    await flush();
    expect(spawnWorkerMock).toHaveBeenCalledTimes(1); // second was queued — cap respected
  });

  it("a failed spawn replies an error result AND frees the slot for the next queued spawn", async () => {
    useSettingsStore.setState({ maxConcurrentWorkers: 1 });
    spawnWorkerMock.mockRejectedValueOnce(new Error("worktree cut failed"));
    fire({ reqId: "f1", op: "spawn_worker", buildAgentId: buildId, projectId, payload: { task: "boom" } });
    // Queue a second while the (failing) first still holds its reservation.
    fire({ reqId: "f2", op: "spawn_worker", buildAgentId: buildId, projectId, payload: { task: "next" } });
    await flush();
    await flush();
    // f1 got an error reply (exactly once-per-request contract holds on the failure path).
    const f1 = invokeMock.mock.calls.find(([, a]) => (a as { reqId: string }).reqId === "f1");
    expect((f1![1] as { result: { error?: string } }).result.error).toMatch(/worktree cut failed/);
    // The freed slot let the queued f2 proceed (default mock spawns it).
    expect(spawnWorkerMock).toHaveBeenCalledTimes(2);
    const reqIds = invokeMock.mock.calls.map(([, a]) => (a as { reqId: string }).reqId);
    expect(reqIds).toContain("f2");
  });

  it("does not starve a second build agent's queued spawn behind a capped head-of-queue", async () => {
    useSettingsStore.setState({ maxConcurrentWorkers: 1 });
    const buildB = useProjectStore.getState().addAgent(projectId, { kind: "build" });
    useProjectStore.getState().setAgentWorktree(projectId, buildB, "/wt/buildB", "sparkle/agent-buildB");
    // Build A fills its only slot, then queues a SECOND A spawn (A now at cap → head of queue).
    fire({ reqId: "a1", op: "spawn_worker", buildAgentId: buildId, projectId, payload: { task: "a-live" } });
    await flush();
    fire({ reqId: "a2", op: "spawn_worker", buildAgentId: buildId, projectId, payload: { task: "a-queued" } });
    await flush();
    // Build B has a free slot — its spawn must run even though A's request sits ahead in the queue.
    fire({ reqId: "b1", op: "spawn_worker", buildAgentId: buildB, projectId, payload: { task: "b-live" } });
    await flush();
    const reqIds = invokeMock.mock.calls.map(([, a]) => (a as { reqId: string }).reqId);
    expect(reqIds).toContain("b1"); // B not blocked behind A's still-capped a2
    expect(reqIds).not.toContain("a2"); // A's second is still queued (A still at cap)
  });

  it("clears the start guard on init failure so a subsequent call can re-arm the listener", async () => {
    // beforeEach already started the listener — tear it down to reset startPromise.
    cleanup?.();
    cleanup = undefined;
    await flush();

    // Make the next listen() call reject (e.g. Tauri not fully initialised yet).
    vi.mocked(listen).mockRejectedValueOnce(new Error("tauri not ready"));

    // First call must reject.
    await expect(startOrchestrationListener()).rejects.toThrow("tauri not ready");

    // Second call must succeed: the guard must have been cleared on the rejection path,
    // not left holding the permanently-rejected promise.
    cleanup = await startOrchestrationListener();
    expect(firedHandler).toBeDefined();
  });

  it("an unknown op replies an error result (never leaves the bridge hanging)", async () => {
    fire({ reqId: "u1", op: "bogus" as never, buildAgentId: buildId, projectId, payload: {} });
    await flush();
    const [, args] = invokeMock.mock.calls.at(-1)!;
    expect((args as { result: { error?: string } }).result.error).toMatch(/unknown op/i);
  });

  it("cleanup replies an error to each still-queued spawn so the bridge isn't left hanging", async () => {
    useSettingsStore.setState({ maxConcurrentWorkers: 1 });
    fire({ reqId: "k1", op: "spawn_worker", buildAgentId: buildId, projectId, payload: { task: "live" } });
    await flush();
    fire({ reqId: "k2", op: "spawn_worker", buildAgentId: buildId, projectId, payload: { task: "queued" } });
    await flush();
    invokeMock.mockClear(); // k2 has no reply yet — it's queued
    cleanup?.();
    cleanup = undefined;
    const k2 = invokeMock.mock.calls.find(([, a]) => (a as { reqId: string }).reqId === "k2");
    expect((k2![1] as { result: { error?: string } }).result.error).toMatch(/stopped/i);
  });
});
