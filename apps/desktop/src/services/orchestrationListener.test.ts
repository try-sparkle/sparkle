import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  useProjectStore,
  registerLocalRemovals,
  acknowledgeRemovals,
} from "../stores/projectStore";
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
const defaultSpawnImpl = async (args: {
  projectId: string;
  parentAgentId: string;
  task: string;
  beadId?: string;
}) => {
  const id = useProjectStore.getState().addAgent(args.projectId, {
    kind: "worker",
    parentId: args.parentAgentId,
    task: args.task,
    // The real spawnWorker persists beadId onto the worker record (workerSpawn.ts). The mock
    // omitted it, so the store's workers were bead-less here in a way they never are in the app —
    // which would have hidden the whole bead-claim guard from these tests.
    beadId: args.beadId,
  });
  const branch = `sparkle/agent-${id}`;
  const worktree = `/wt/${id}`;
  useProjectStore.getState().setAgentWorktree(args.projectId, id, worktree, branch);
  // Mirror the real spawnWorker contract: return the AUTHORITATIVE identity from the worktree cut.
  return { workerId: id, branch, worktree };
};
const spawnWorkerMock = vi.fn(defaultSpawnImpl);
const spinDownWorkerMock = vi.fn(async (args: { projectId: string; workerId: string }) => {
  useProjectStore.getState().removeAgent(args.projectId, args.workerId);
});
vi.mock("./workerSpawn", () => ({
  spawnWorker: (a: unknown) => spawnWorkerMock(a as never),
  spinDownWorker: (a: unknown) => spinDownWorkerMock(a as never),
}));

// --- mock the on-disk manifest scan (sparkle-3xus). Default: no manifests (store-only), so the
//     existing store-driven tests are unaffected. Individual tests override it to simulate an
//     evicted record that survives on disk. adoptWorker (the store method reconcile calls) is real. ---
const scanWorkerManifestsMock = vi.fn(async (_projectId: string) => [] as unknown[]);
vi.mock("./worktree", async (orig) => ({
  ...(await orig<typeof import("./worktree")>()),
  scanWorkerManifests: (...a: unknown[]) => scanWorkerManifestsMock(...(a as [string])),
}));

import {
  startOrchestrationListener,
  purgeBuildAgent,
  type OrchestrationRequest,
} from "./orchestrationListener";

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
    useSettingsStore.setState({ maxConcurrentWorkers: 4, effectiveMaxConcurrentWorkers: 20 });
    scanWorkerManifestsMock.mockReset();
    scanWorkerManifestsMock.mockResolvedValue([]); // default: nothing on disk to reconcile
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

  it("spawn_worker reply uses spawnWorker's authoritative identity, not a racy store re-read (sparkle-yk3x)", async () => {
    // Reproduce the malformed-reply race: a concurrent reconcile/relocation removes the freshly
    // spawned worker's store record (or nulls its worktreePath) in the microtask gap between
    // spawnWorker resolving and the listener assembling its reply. The OLD code re-read branch/
    // worktree from that record and degraded to "" — an empty reply the MCP client rejects as
    // "malformed reply". The reply must instead carry the authoritative ids spawnWorker returned.
    spawnWorkerMock.mockImplementationOnce(async (args: { projectId: string; parentAgentId: string; task: string }) => {
      const id = useProjectStore.getState().addAgent(args.projectId, {
        kind: "worker",
        parentId: args.parentAgentId,
        task: args.task,
      });
      const branch = `sparkle/agent-${id}`;
      const worktree = `/wt/${id}`;
      useProjectStore.getState().setAgentWorktree(args.projectId, id, worktree, branch);
      // Simulate the concurrent reconcile wiping the record right after the worktree cut.
      useProjectStore.getState().removeAgent(args.projectId, id);
      return { workerId: id, branch, worktree };
    });
    fire({ reqId: "yk3x", op: "spawn_worker", buildAgentId: buildId, projectId, payload: { task: "race me" } });
    await flush();
    const [, args] = invokeMock.mock.calls.at(-1)!;
    const result = (args as { result: { workerId: string; branch: string; worktree: string; error?: string } }).result;
    expect(result.error).toBeUndefined();
    expect(result.workerId).toBeTruthy();
    expect(result.branch).toMatch(/^sparkle\/agent-/); // non-empty despite the wiped store record
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

  it("self-heals: a materialized worker that isn't open is auto-opened on a store change", async () => {
    // Simulate a worker that was spawned + had its worktree cut but never made it into openAgentIds
    // (the reconcile/remount eviction strand) — the listener's subscription must re-open it. The
    // orchestrator must be live for the heal to apply (a worker is live iff its orchestrator is).
    useRuntimeStore.getState().open(buildId);
    const ps = useProjectStore.getState();
    const workerId = ps.addAgent(projectId, { kind: "worker", parentId: buildId });
    ps.setAgentWorktree(projectId, workerId, "/wt/heal", "sparkle/agent-heal");
    await flush();
    expect(useRuntimeStore.getState().openAgentIds).toContain(workerId);
  });

  it("self-heals after an EVICTION: re-opens a worker removed from openAgentIds", async () => {
    useRuntimeStore.getState().open(buildId);
    const ps = useProjectStore.getState();
    const workerId = ps.addAgent(projectId, { kind: "worker", parentId: buildId });
    ps.setAgentWorktree(projectId, workerId, "/wt/evict", "sparkle/agent-evict");
    await flush();
    expect(useRuntimeStore.getState().openAgentIds).toContain(workerId);
    // A reconcile() race strips the worker from the cross-window-shared open set (the orchestrator
    // stays open)…
    useRuntimeStore.setState({ openAgentIds: [buildId] });
    await flush();
    // …and the runtimeStore subscription heals it back.
    expect(useRuntimeStore.getState().openAgentIds).toContain(workerId);
  });

  it("does NOT re-open a worker mid-teardown (spin_down close()→removeAgent() leaves no ghost id)", async () => {
    // The heal is deferred to a microtask so it sees the END of a synchronous mutation batch. A
    // teardown closes the worker then removes it from `agents` in the same tick; by the time the
    // microtask runs the worker is gone, so it must NOT be re-opened (which would leak a stale id
    // into openAgentIds, since removeAgent doesn't touch the open set).
    const rt = useRuntimeStore.getState();
    rt.open(buildId);
    const ps = useProjectStore.getState();
    const workerId = ps.addAgent(projectId, { kind: "worker", parentId: buildId });
    ps.setAgentWorktree(projectId, workerId, "/wt/td", "sparkle/agent-td");
    await flush();
    expect(useRuntimeStore.getState().openAgentIds).toContain(workerId);
    // Mirror spinDownWorker's synchronous close()-then-removeAgent() teardown.
    useRuntimeStore.getState().close(workerId);
    useProjectStore.getState().removeAgent(projectId, workerId);
    await flush();
    expect(useRuntimeStore.getState().openAgentIds).not.toContain(workerId);
  });

  it("does NOT auto-open a worker whose orchestrator is closed (e.g. relocating the project)", async () => {
    // buildId is NOT opened: the worker is materialized but its orchestrator isn't live, so the
    // self-heal must leave it alone instead of fighting a deliberate teardown.
    const ps = useProjectStore.getState();
    const workerId = ps.addAgent(projectId, { kind: "worker", parentId: buildId });
    ps.setAgentWorktree(projectId, workerId, "/wt/closed", "sparkle/agent-closed");
    await flush();
    expect(useRuntimeStore.getState().openAgentIds).not.toContain(workerId);
  });

  it("does NOT auto-open a worker whose worktree was never cut (mid-spawn / queued)", async () => {
    useRuntimeStore.getState().open(buildId);
    const ps = useProjectStore.getState();
    const workerId = ps.addAgent(projectId, { kind: "worker", parentId: buildId }); // no worktree
    ps.selectAgent(projectId, buildId); // force a store change to run the heal
    await flush();
    expect(useRuntimeStore.getState().openAgentIds).not.toContain(workerId);
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

  it("queues spawns past the RAM-derived cap even when the configured cap is higher (sparkle-01xv)", async () => {
    // The P0 blowup: the machine only has RAM for 1 agent, but the user configured 4. Spawning to
    // the configured number is what put 24 agents × ~4 GiB on one Mac and got system daemons
    // jetsam-killed. The gate must honor whichever cap is lower.
    useSettingsStore.setState({ maxConcurrentWorkers: 4, effectiveMaxConcurrentWorkers: 1 });
    fire({ reqId: "m1", op: "spawn_worker", buildAgentId: buildId, projectId, payload: { task: "first" } });
    await flush();
    expect(spawnWorkerMock).toHaveBeenCalledTimes(1);
    invokeMock.mockClear();
    fire({ reqId: "m2", op: "spawn_worker", buildAgentId: buildId, projectId, payload: { task: "second" } });
    await flush();
    expect(spawnWorkerMock).toHaveBeenCalledTimes(1); // held at the RAM cap, not the configured 4
    expect(invokeMock).not.toHaveBeenCalled(); // m2's reply deferred until a slot frees
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
      return { workerId: id, branch: `sparkle/agent-${id}`, worktree: `/wt/${id}` };
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

  it("cleanup swallows the Tauri unlisten teardown race instead of throwing", () => {
    // The window closing tears down Tauri's listeners map; the unlisten fn then throws the
    // "handlerId" race. teardown routes it through safeUnlisten, so cleanup must not throw.
    unlistenMock.mockImplementationOnce(() => {
      throw new Error("Cannot read properties of undefined (reading 'handlerId')");
    });
    expect(() => cleanup?.()).not.toThrow();
    expect(unlistenMock).toHaveBeenCalled();
    cleanup = undefined;
  });

  it("list_workers re-adopts a worker from its on-disk manifest when the store record was evicted (sparkle-3xus)", async () => {
    // The store has NO record for this worker (a reconcile/relocation race evicted it), but its
    // durable manifest survives on disk under THIS build agent. list_workers must consult disk,
    // re-adopt it, and report it — self-heal with no app restart.
    const ghostId = "worker-ghost-3xus";
    scanWorkerManifestsMock.mockResolvedValueOnce([
      {
        workerId: ghostId,
        buildAgentId: buildId,
        projectId,
        branch: "sparkle/agent-ghost",
        worktree: "/wt/ghost",
        task: "resurrect me",
        createdAt: "2026-07-06T00:00:00.000Z",
      },
    ]);
    fire({ reqId: "l3x", op: "list_workers", buildAgentId: buildId, projectId, payload: {} });
    await flush();
    const [, args] = invokeMock.mock.calls.at(-1)!;
    const workers = (args as { result: { workers: Array<{ workerId: string; worktree: string }> } })
      .result.workers;
    expect(workers.map((w) => w.workerId)).toContain(ghostId);
    // And the record is back in the store (re-derived from disk).
    const proj = useProjectStore.getState().projects.find((p) => p.id === projectId)!;
    const adopted = proj.agents.find((a) => a.id === ghostId);
    expect(adopted).toBeTruthy();
    expect(adopted!.task).toBe("resurrect me"); // task-on-disk restored (kills the taskless stall)
    expect(adopted!.worktreePath).toBe("/wt/ghost");
  });

  it("spin_down of an evicted worker is NOT rejected 'not owned' — its manifest re-derives ownership (sparkle-3xus)", async () => {
    // The worker's store record is gone but its manifest (under buildId) is on disk. spin_down must
    // reconcile from disk, find it owned by this build agent, and tear it down — not falsely reject.
    const ghostId = "worker-spin-3xus";
    scanWorkerManifestsMock.mockResolvedValueOnce([
      {
        workerId: ghostId,
        buildAgentId: buildId,
        projectId,
        branch: "sparkle/agent-spin",
        worktree: "/wt/spin",
        task: "t",
        createdAt: "2026-07-06T00:00:00.000Z",
      },
    ]);
    fire({ reqId: "d3x", op: "spin_down", buildAgentId: buildId, projectId, payload: { workerId: ghostId } });
    await flush();
    expect(spinDownWorkerMock).toHaveBeenCalledWith({ projectId, workerId: ghostId });
    const [, args] = invokeMock.mock.calls.at(-1)!;
    const result = (args as { result: { spunDown?: boolean; error?: string } }).result;
    expect(result.error).toBeUndefined();
    expect(result.spunDown).toBe(true);
  });

  it("reconcile does NOT re-adopt a worker that is mid-teardown, even though its manifest still exists (the 'x closes the worker but the row comes back' bug)", async () => {
    // The worker's row was just closed (removeAgent) but its background worktree+manifest reap hasn't
    // finished — so its manifest is still on disk AND its parent build agent still lives. Without the
    // teardown tombstone, reconcile would see "manifest present, record absent, parent alive" and
    // re-adopt it — resurrecting the row the user just closed. The tombstone must suppress that until
    // the manifest is gone.
    const tearingId = "worker-mid-teardown";
    const manifest = [
      {
        workerId: tearingId,
        buildAgentId: buildId,
        projectId,
        branch: "sparkle/agent-td",
        worktree: "/wt/td",
        task: "closing",
        createdAt: "2026-07-08T00:00:00.000Z",
      },
    ];

    registerLocalRemovals([tearingId]);
    scanWorkerManifestsMock.mockResolvedValueOnce(manifest);
    fire({ reqId: "ltd", op: "list_workers", buildAgentId: buildId, projectId, payload: {} });
    await flush();
    // NOT re-adopted while tombstoned.
    expect(
      useProjectStore.getState().projects.find((p) => p.id === projectId)!.agents.some((a) => a.id === tearingId),
    ).toBe(false);

    // Once teardown completes (manifest would normally be gone too), the shield lifts — proving the
    // tombstone, not some other filter, was what suppressed the adopt.
    acknowledgeRemovals([tearingId]);
    scanWorkerManifestsMock.mockResolvedValueOnce(manifest);
    fire({ reqId: "ltd2", op: "list_workers", buildAgentId: buildId, projectId, payload: {} });
    await flush();
    expect(
      useProjectStore.getState().projects.find((p) => p.id === projectId)!.agents.some((a) => a.id === tearingId),
    ).toBe(true);
  });

  it("reconcile does NOT resurrect a worker whose parent build agent is gone", async () => {
    // A manifest for a build agent that no longer exists in the store must be ignored — we don't
    // re-open workers for a deliberately-closed orchestrator.
    scanWorkerManifestsMock.mockResolvedValueOnce([
      {
        workerId: "orphan-w",
        buildAgentId: "build-that-was-closed",
        projectId,
        branch: "sparkle/agent-orphan",
        worktree: "/wt/orphan",
        task: "t",
        createdAt: "2026-07-06T00:00:00.000Z",
      },
    ]);
    fire({ reqId: "l-orphan", op: "list_workers", buildAgentId: buildId, projectId, payload: {} });
    await flush();
    const proj = useProjectStore.getState().projects.find((p) => p.id === projectId)!;
    expect(proj.agents.some((a) => a.id === "orphan-w")).toBe(false);
  });

  // ── the bead claim guard ──────────────────────────────────────────────────────────────────────
  // Observed in production: a restart re-dispatched already-claimed units — five agents
  // independently solving one P0, two more duplicating other work, ~7 wasted agents in a single
  // run. `beadId` was threaded end-to-end (MCP → bridge → listener → store → disk manifest) and
  // never once COMPARED: every occurrence in the spawn path was an assignment. An idempotency guard
  // already existed for workerId; there was no beadId equivalent, and list_workers stripped beadId
  // so a resumed orchestrator could not see which bead any live worker owned.
  const workersOf = (pid: string, parent: string) =>
    (useProjectStore.getState().projects.find((p) => p.id === pid)?.agents ?? []).filter(
      (a) => a.kind === "worker" && a.parentId === parent,
    );
  const lastResult = () =>
    (invokeMock.mock.calls.at(-1)![1] as { result: Record<string, unknown> }).result;

  it("a second spawn for the SAME bead does not spawn again — it returns the existing worker", async () => {
    fire({ reqId: "b1", op: "spawn_worker", buildAgentId: buildId, projectId, payload: { task: "fix the P0", beadId: "sparkle-01xv" } });
    await flush();
    const first = lastResult() as { workerId: string };
    expect(workersOf(projectId, buildId)).toHaveLength(1);

    fire({ reqId: "b2", op: "spawn_worker", buildAgentId: buildId, projectId, payload: { task: "fix the P0 again", beadId: "sparkle-01xv" } });
    await flush();
    // Still ONE worker, and the reply is idempotent — the caller learns the bead is already
    // claimed and by whom, rather than getting an error it might retry into another duplicate.
    expect(workersOf(projectId, buildId)).toHaveLength(1);
    expect(spawnWorkerMock).toHaveBeenCalledTimes(1);
    expect(lastResult().workerId).toBe(first.workerId);
  });

  it("two spawns for one bead RACING (before the first resolves) still yield one worker", async () => {
    // The store-only check is not sufficient: runSpawn awaits spawnWorker, so the worker record does
    // not exist yet when a second request arrives in the same tick. Both would pass a store check
    // and both would spawn — which is precisely the burst a restart produces.
    fire({ reqId: "r-a", op: "spawn_worker", buildAgentId: buildId, projectId, payload: { task: "t", beadId: "sparkle-race" } });
    fire({ reqId: "r-b", op: "spawn_worker", buildAgentId: buildId, projectId, payload: { task: "t", beadId: "sparkle-race" } });
    await flush();
    await flush();
    expect(spawnWorkerMock).toHaveBeenCalledTimes(1);
    expect(workersOf(projectId, buildId)).toHaveLength(1);
  });

  it("a DIFFERENT bead spawns normally — the guard is per work unit, not a global lock", async () => {
    fire({ reqId: "d1", op: "spawn_worker", buildAgentId: buildId, projectId, payload: { task: "a", beadId: "bead-a" } });
    await flush();
    fire({ reqId: "d2", op: "spawn_worker", buildAgentId: buildId, projectId, payload: { task: "b", beadId: "bead-b" } });
    await flush();
    expect(spawnWorkerMock).toHaveBeenCalledTimes(2);
    expect(workersOf(projectId, buildId)).toHaveLength(2);
  });

  it("spawns with NO beadId are never deduped — anonymous work has no identity to compare", async () => {
    // Ad-hoc spawns carry no bead. Collapsing them would silently drop legitimate parallel work,
    // which is a worse failure than the duplication this guard prevents.
    fire({ reqId: "n1", op: "spawn_worker", buildAgentId: buildId, projectId, payload: { task: "one" } });
    await flush();
    fire({ reqId: "n2", op: "spawn_worker", buildAgentId: buildId, projectId, payload: { task: "two" } });
    await flush();
    expect(spawnWorkerMock).toHaveBeenCalledTimes(2);
    expect(workersOf(projectId, buildId)).toHaveLength(2);
  });

  it("the same bead under a DIFFERENT build agent is allowed — claims are per orchestrator", async () => {
    const otherBuild = useProjectStore.getState().addAgent(projectId, { kind: "build" });
    fire({ reqId: "s1", op: "spawn_worker", buildAgentId: buildId, projectId, payload: { task: "t", beadId: "shared" } });
    await flush();
    fire({ reqId: "s2", op: "spawn_worker", buildAgentId: otherBuild, projectId, payload: { task: "t", beadId: "shared" } });
    await flush();
    expect(spawnWorkerMock).toHaveBeenCalledTimes(2);
    expect(workersOf(projectId, buildId)).toHaveLength(1);
    expect(workersOf(projectId, otherBuild)).toHaveLength(1);
  });

  it("list_workers reports beadId, so a resumed orchestrator can see its own claims", async () => {
    // Without this the roster is N anonymous workers: the orchestrator cannot tell which bead any
    // of them owns, so after a restart it re-dispatches everything it still sees in `bd ready`.
    fire({ reqId: "lb", op: "spawn_worker", buildAgentId: buildId, projectId, payload: { task: "t", beadId: "sparkle-visible" } });
    await flush();
    fire({ reqId: "lb2", op: "list_workers", buildAgentId: buildId, projectId, payload: {} });
    await flush();
    const { workers } = lastResult() as { workers: Array<{ workerId: string; beadId?: string }> };
    expect(workers).toHaveLength(1);
    expect(workers[0]!.beadId).toBe("sparkle-visible");
  });

  it("a queued bead's claim is released when its build agent is purged (roborev 41945)", async () => {
    // A QUEUED request holds its claim but never reaches runSpawn, where the release lives. Without
    // an explicit release on the drop path the key leaks in a module-level Set — and since a build
    // agent id can be reincarnated, its legitimate re-spawn would be refused forever with no worker
    // and nothing in flight. That is the exact failure the claim exists to prevent.
    useSettingsStore.setState({ maxConcurrentWorkers: 1, effectiveMaxConcurrentWorkers: 1 });
    fire({ reqId: "q1", op: "spawn_worker", buildAgentId: buildId, projectId, payload: { task: "occupy the slot", beadId: "bead-occupy" } });
    await flush();
    // Second bead is over cap → queued, holding its claim.
    fire({ reqId: "q2", op: "spawn_worker", buildAgentId: buildId, projectId, payload: { task: "queued", beadId: "bead-queued" } });
    await flush();
    expect(spawnWorkerMock).toHaveBeenCalledTimes(1);

    purgeBuildAgent(buildId);
    // Room again, and the purged claim must not linger.
    useSettingsStore.setState({ maxConcurrentWorkers: 4, effectiveMaxConcurrentWorkers: 20 });
    useProjectStore.setState({ projects: [], selectedProjectId: null });
    const p2 = useProjectStore.getState().addProject("Demo2", "/tmp/demo2");
    const b2 = useProjectStore.getState().addAgent(p2, { kind: "build" });
    fire({ reqId: "q3", op: "spawn_worker", buildAgentId: b2, projectId: p2, payload: { task: "retry", beadId: "bead-queued" } });
    await flush();
    expect(spawnWorkerMock).toHaveBeenCalledTimes(2);
  });

  it("an already-claimed bead whose worker is mid-relocation refuses rather than replying malformed", async () => {
    // A worker record can be concurrently mutated to a null worktreePath by relocation/reconcile
    // (sparkle-yk3x). Replying with empty branch/worktree trips the MCP client's malformed-reply
    // guard, which surfaces as an error the orchestrator may RETRY — defeating idempotency. The
    // claim must still hold; we just can't name the worker yet.
    fire({ reqId: "m1", op: "spawn_worker", buildAgentId: buildId, projectId, payload: { task: "t", beadId: "bead-reloc" } });
    await flush();
    const w = workersOf(projectId, buildId)[0]!;
    useProjectStore.getState().setAgentWorktree(projectId, w.id, "", "");
    fire({ reqId: "m2", op: "spawn_worker", buildAgentId: buildId, projectId, payload: { task: "t", beadId: "bead-reloc" } });
    await flush();
    // No second spawn, and the reply is an explanatory error rather than an empty identity.
    expect(spawnWorkerMock).toHaveBeenCalledTimes(1);
    const res = lastResult() as { error?: string; branch?: string };
    expect(res.error).toContain("bead-reloc");
    expect(res.branch).toBeUndefined();
  });

  it("a freed bead can be re-dispatched after its worker is spun down", async () => {
    // The guard must not be a permanent tombstone: once the claim is released, the unit is
    // dispatchable again (a genuine retry after a failure goes through spin_down first).
    fire({ reqId: "f1", op: "spawn_worker", buildAgentId: buildId, projectId, payload: { task: "t", beadId: "bead-free" } });
    await flush();
    const w = workersOf(projectId, buildId)[0]!;
    fire({ reqId: "f2", op: "spin_down", buildAgentId: buildId, projectId, payload: { workerId: w.id } });
    await flush();
    fire({ reqId: "f3", op: "spawn_worker", buildAgentId: buildId, projectId, payload: { task: "t", beadId: "bead-free" } });
    await flush();
    expect(spawnWorkerMock).toHaveBeenCalledTimes(2);
  });
});
