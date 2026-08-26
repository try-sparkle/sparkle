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
// --- the LIVE admission reading the worker gate now consults. `null` is the default and is what
//     every pre-existing test below runs with, so they exercise the untouched static-ceiling path
//     byte-for-byte. `importActual` is spread first so the module's other exports (used elsewhere in
//     this import graph) keep working; only the one accessor is overridden. ---
let admissionReading: import("./memoryAdmission").ConcurrencyAdmission | null = null;
vi.mock("./memoryAdmission", async (importActual) => ({
  ...(await importActual<typeof import("./memoryAdmission")>()),
  currentMemoryAdmission: () => admissionReading,
}));

// vi.fn() with no impl → typed as Mock<any[], any>, so spreading unknown[] into it is allowed.
// (vi.fn(() => impl) would infer [] for Args and break the spread — see workerSpawn.test.ts.)
const invokeMock = vi.fn();
invokeMock.mockReturnValue(Promise.resolve()); // respond() calls .then() — must return a thenable
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

// --- mock the window identity used by spin_down's single-owner election. Default is "main" with
//     an EMPTY registry, i.e. no window owns any project → main adopts, so every pre-existing test
//     below services its spin_down exactly as before the election was added. The ownership tests
//     override `thisWindowLabel` / `registry` to put this window on the losing side. ---
let thisWindowLabel = "main";
let registry: Record<string, string> = {};
const liveWindows = new Set<string>();
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: thisWindowLabel }) }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  WebviewWindow: { getByLabel: async (l: string) => (liveWindows.has(l) ? {} : null) },
}));
vi.mock("./windowRegistry", async (orig) => ({
  ...(await orig<typeof import("./windowRegistry")>()),
  findWindowForProject: (pid: string) =>
    Object.entries(registry).find(([, v]) => v === pid)?.[0] ?? null,
  clearWindowProject: (l: string) => {
    delete registry[l];
  },
}));

// --- mock workerSpawn so no real worktree/PTY is touched; spawnWorker registers a real tab so
//     the listener can read back branch/worktree from the store. ---
const defaultSpawnImpl = async (args: {
  projectId: string;
  parentAgentId: string;
  task: string;
  beadId?: string;
  goal?: string;
}) => {
  const id = useProjectStore.getState().addAgent(args.projectId, {
    kind: "worker",
    parentId: args.parentAgentId,
    task: args.task,
    // The real spawnWorker persists beadId onto the worker record (workerSpawn.ts). The mock
    // omitted it, so the store's workers were bead-less here in a way they never are in the app —
    // which would have hidden the whole bead-claim guard from these tests.
    beadId: args.beadId,
  })!;
  // The real spawnWorker also persists the GOAL at creation (workerSpawn.ts). Mirrored here for the
  // same reason as beadId above: a mock that drops a field the real one records would leave every
  // suite green while no worker's objective is ever persisted (roborev 55743).
  if (args.goal) useProjectStore.getState().setAgentGoal(args.projectId, id, args.goal);
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
  reapOrphanedWorkers,
  __setReaperNow,
  REAP_GRACE_MS,
  SPAWN_QUEUE_MAX_WAIT_MS,
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
    // Default election state: this is main and nothing is registered → main adopts every request.
    thisWindowLabel = "main";
    registry = {};
    liveWindows.clear();
    const store = useProjectStore.getState();
    projectId = store.addProject("Demo", "/tmp/demo");
    buildId = store.addAgent(projectId, { kind: "build" })!;
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

  // The bridge→spawnWorker hop was the last untested link in the goal chain: goalGate covers the
  // rules, tools.test the wire payload, bridge.rs the forwarded set, workerSpawn the persistence —
  // and deleting `goal: req.payload.goal` here left every one of them green (roborev 55743).
  it("spawn_worker carries the payload's goal through to the worker record", async () => {
    const goal = "nested groups parse and parser.test.ts passes";
    fire({
      reqId: "goal1",
      op: "spawn_worker",
      buildAgentId: buildId,
      projectId,
      payload: { task: "refactor the parser", goal },
    });
    await flush();
    // The SIDE EFFECT: the objective is on the record, so something other than the worker can check
    // whether it finished. Asserting the call args instead would pass even if the hop dropped it.
    const worker = useProjectStore
      .getState()
      .projects.find((p) => p.id === projectId)!
      .agents.find((a) => a.parentId === buildId)!;
    expect(worker.goal?.text).toBe(goal);
    expect(worker.goal?.metAt).toBeUndefined();
  });

  it("spawn_worker under an override leaves the worker goalless rather than inventing a goal", async () => {
    // An override means there is NO criterion. Synthesizing one from its reason would make an
    // unverifiable worker look verifiable — and goallessness is what the unlanded-work surface keys
    // on to find these, so it has to stay observable.
    fire({
      reqId: "goal2",
      op: "spawn_worker",
      buildAgentId: buildId,
      projectId,
      payload: { task: "spike the crash", goalOverrideReason: "no completion criterion exists yet" },
    });
    await flush();
    const worker = useProjectStore
      .getState()
      .projects.find((p) => p.id === projectId)!
      .agents.find((a) => a.parentId === buildId)!;
    expect(worker.goal).toBeUndefined();
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
      })!;
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

  it("spawn_worker → STILL launches the worker when a reconcile evicts its record mid-spawn (sparkle-ynytw)", async () => {
    // THE FIRST-HALF DEFECT: spawn_worker returned a clean handle for a worker that never took a
    // turn. It happens when a concurrent reconcile/relocation removes the freshly-spawned worker's
    // in-memory store record in the microtask gap after spawnWorker resolves (the sparkle-yk3x race).
    // The launch is `open(workerId)` — it mounts the pane and starts the session. The OLD code
    // re-read the store for the record and skipped open() when it was missing, so the worker was
    // never opened, never launched, and later reported never_started — yet the reply was a success.
    // spawnWorker only returns a workerId AFTER it has durably written the worker's manifest to disk,
    // so the id is proven materialized and MUST be launched even when the in-memory record is gone.
    spawnWorkerMock.mockImplementationOnce(async (args: { projectId: string; parentAgentId: string; task: string }) => {
      const id = useProjectStore.getState().addAgent(args.projectId, {
        kind: "worker",
        parentId: args.parentAgentId,
        task: args.task,
      })!;
      const branch = `sparkle/agent-${id}`;
      const worktree = `/wt/${id}`;
      useProjectStore.getState().setAgentWorktree(args.projectId, id, worktree, branch);
      // The concurrent reconcile wipes the in-memory record right after the (disk-durable) cut.
      useProjectStore.getState().removeAgent(args.projectId, id);
      return { workerId: id, branch, worktree };
    });
    fire({ reqId: "ynytw", op: "spawn_worker", buildAgentId: buildId, projectId, payload: { task: "launch me" } });
    await flush();
    const [, args] = invokeMock.mock.calls.at(-1)!;
    const result = (args as { result: { workerId: string; error?: string } }).result;
    expect(result.error).toBeUndefined();
    const workerId = result.workerId;
    expect(workerId).toBeTruthy();
    // THE SIDE EFFECT: the launch call fired despite the evicted record, so the worker's session
    // starts instead of stranding behind "Start this agent" with a phantom-success handle.
    expect(useRuntimeStore.getState().openAgentIds).toContain(workerId);
  });

  it("self-heals: a materialized worker that isn't open is auto-opened on a store change", async () => {
    // Simulate a worker that was spawned + had its worktree cut but never made it into openAgentIds
    // (the reconcile/remount eviction strand) — the listener's subscription must re-open it. The
    // orchestrator must be live for the heal to apply (a worker is live iff its orchestrator is).
    useRuntimeStore.getState().open(buildId);
    const ps = useProjectStore.getState();
    const workerId = ps.addAgent(projectId, { kind: "worker", parentId: buildId, createdAt: 1 })!;
    ps.setAgentWorktree(projectId, workerId, "/wt/heal", "sparkle/agent-heal");
    await flush();
    expect(useRuntimeStore.getState().openAgentIds).toContain(workerId);
  });

  it("self-heals after an EVICTION: re-opens a worker removed from openAgentIds", async () => {
    useRuntimeStore.getState().open(buildId);
    const ps = useProjectStore.getState();
    const workerId = ps.addAgent(projectId, { kind: "worker", parentId: buildId, createdAt: 1 })!;
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

  it("gives UP on a strand the heal can't win: bounded re-opens, then one warning", async () => {
    // The re-open/evict ping-pong. An evictor that keeps pace with the heal (a cross-window
    // rehydrate racing this window's open) makes every open() come straight back out of the shared
    // set, and each open() wakes the subscription that schedules the next heal — an exit-free loop
    // that writes persisted, cross-window state every round. The heal must bound its own attempts.
    useRuntimeStore.getState().open(buildId);
    const ps = useProjectStore.getState();
    const workerId = ps.addAgent(projectId, { kind: "worker", parentId: buildId, createdAt: 1 })!;
    ps.setAgentWorktree(projectId, workerId, "/wt/pingpong", "sparkle/agent-pingpong");
    await flush();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      let reopens = 0;
      // Far more rounds than the cap, so a heal that never gave up would keep re-opening forever.
      for (let i = 0; i < 200; i++) {
        useRuntimeStore.setState({ openAgentIds: [buildId] }); // the racer evicts it again
        await flush();
        if (useRuntimeStore.getState().openAgentIds.includes(workerId)) reopens++;
      }
      expect(reopens).toBeGreaterThan(0); // it does try
      expect(reopens).toBeLessThan(200); // …but not forever
      // And the give-up is reported once, not once per pass — otherwise the WARN is the new spin.
      const giveUps = warn.mock.calls.filter(
        (c) => typeof c[0] === "string" && c[0].includes("still stranded after"),
      );
      expect(giveUps).toHaveLength(1);
      expect(giveUps[0]).toContain(workerId);
    } finally {
      warn.mockRestore();
    }
  });

  it("a worker that comes up live gets a FRESH attempt budget if it strands again later", async () => {
    // The bound is per unresolved strand, not per lifetime. Once the worker actually goes live (it
    // has a PTY status), the earlier attempts must be forgotten — otherwise a long session would
    // eventually stop healing a worker whose every previous strand the heal resolved.
    useRuntimeStore.getState().open(buildId);
    const ps = useProjectStore.getState();
    const workerId = ps.addAgent(projectId, { kind: "worker", parentId: buildId, createdAt: 1 })!;
    ps.setAgentWorktree(projectId, workerId, "/wt/fresh", "sparkle/agent-fresh");
    await flush();
    const evictThenHeal = async (): Promise<boolean> => {
      useRuntimeStore.setState({ openAgentIds: [buildId] });
      await flush();
      return useRuntimeStore.getState().openAgentIds.includes(workerId);
    };
    for (let i = 0; i < 20; i++) expect(await evictThenHeal()).toBe(true);
    // Its PTY finally reports in — the strand is resolved, so the budget resets on the next heal
    // pass. A status write alone doesn't schedule one (the runtimeStore subscription is gated to the
    // openAgentIds slice), so nudge projectStore the way the running app does constantly.
    useRuntimeStore.setState({ status: { [workerId]: "working" } });
    useProjectStore.getState().selectAgent(projectId, buildId);
    await flush();
    // …and when a later restart clears the status and the same race strands it again, the heal is
    // willing to work for it a second time. (40 rounds total — well past a lifetime cap.)
    useRuntimeStore.setState({ status: {} });
    for (let i = 0; i < 20; i++) expect(await evictThenHeal()).toBe(true);
  });

  it("does NOT re-open a worker mid-teardown (spin_down close()→removeAgent() leaves no ghost id)", async () => {
    // The heal is deferred to a microtask so it sees the END of a synchronous mutation batch. A
    // teardown closes the worker then removes it from `agents` in the same tick; by the time the
    // microtask runs the worker is gone, so it must NOT be re-opened (which would leak a stale id
    // into openAgentIds, since removeAgent doesn't touch the open set).
    const rt = useRuntimeStore.getState();
    rt.open(buildId);
    const ps = useProjectStore.getState();
    const workerId = ps.addAgent(projectId, { kind: "worker", parentId: buildId, createdAt: 1 })!;
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
    const workerId = ps.addAgent(projectId, { kind: "worker", parentId: buildId })!;
    ps.setAgentWorktree(projectId, workerId, "/wt/closed", "sparkle/agent-closed");
    await flush();
    expect(useRuntimeStore.getState().openAgentIds).not.toContain(workerId);
  });

  it("does NOT auto-open a worker whose worktree was never cut (mid-spawn / queued)", async () => {
    useRuntimeStore.getState().open(buildId);
    const ps = useProjectStore.getState();
    const workerId = ps.addAgent(projectId, { kind: "worker", parentId: buildId })!; // no worktree
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

  it("list_workers gates 'done' on result.json, not the coarse tab status (sparkle-7kra)", async () => {
    // Root cause: workerStatus read the live UI tab status, where "done" means only that a Claude
    // TURN ended (statusRouter) — NOT process exit, commits, or result.json. A worker whose turn
    // finished but is still live with uncommitted edits therefore reported "done", which licensed
    // the orchestrator's merge → spin_down loop to land nothing and DELETE live work mid-edit.
    // Fix: derive completion from `.sparkle/result.json` — the same fact wait_for_workers blocks on.
    for (const t of ["success", "failed", "live"]) {
      fire({ reqId: `s-${t}`, op: "spawn_worker", buildAgentId: buildId, projectId, payload: { task: t } });
    }
    await flush();
    const [wSuccess, wFailed, wLive] = (useProjectStore.getState().projects
      .find((p) => p.id === projectId)!
      .agents.filter((a) => a.kind === "worker" && a.parentId === buildId));

    // ALL THREE carry a "done" TAB status — the OLD (buggy) completion signal. Under the pre-fix
    // code every one of these would read "done"; the assertions below prove the verdict now comes
    // from result.json, so wFailed and wLive diverge from what the tab status alone would produce.
    useRuntimeStore.setState({
      status: { [wSuccess!.id]: "done", [wFailed!.id]: "done", [wLive!.id]: "done" },
    });

    // Only wSuccess/wFailed have actually WRITTEN a result.json; wLive (still live, uncommitted) has none.
    const resultFor: Record<string, string> = {
      [wSuccess!.worktreePath!]: JSON.stringify({
        schemaVersion: 1, taskId: "s", branch: "b", status: "success", filesChanged: [], summary: "ok",
      }),
      [wFailed!.worktreePath!]: JSON.stringify({
        schemaVersion: 1, taskId: "f", branch: "b", status: "failed", filesChanged: [], summary: "nope",
      }),
    };
    try {
      invokeMock.mockImplementation((cmd: string, args: { worktree?: string }) =>
        Promise.resolve(cmd === "read_worker_result" ? (resultFor[args.worktree ?? ""] ?? null) : undefined),
      );

      fire({ reqId: "l7kra", op: "list_workers", buildAgentId: buildId, projectId, payload: {} });
      await flush();

      const reply = invokeMock.mock.calls.filter(([c]) => c === "orchestration_respond").at(-1)!;
      const workers = (reply[1] as { result: { workers: Array<{ workerId: string; status: string }> } })
        .result.workers;
      const statusOf = (id: string) => workers.find((w) => w.workerId === id)!.status;

      expect(statusOf(wSuccess!.id)).toBe("done"); // result.json status:"success" → done
      expect(statusOf(wFailed!.id)).toBe("failed"); // result.json status:"failed" → failed (tab said "done")
      // NO result.json → NEVER the terminal "done"/"failed" (the 7kra invariant). The live tab
      // status "done" (a turn ended, nothing landed) is remapped to the non-terminal "idle"
      // (sparkle-0an0) rather than flattened to "running" — either way it can't license spin_down.
      expect(statusOf(wLive!.id)).toBe("idle");
    } finally {
      // Restore the module-load default so the custom impl can't leak into later tests.
      invokeMock.mockReset();
      invokeMock.mockReturnValue(Promise.resolve());
    }
  });

  it("list_workers flags a COMPLETED worker that is still taking turns (sparkle-xdilh)", async () => {
    // Root cause: once result.json exists the verdict SHADOWS liveness — the row reads "done" and
    // the worker's live tab status stops being reported at all. So the roster could not express the
    // one state that costs real work: a worker that reported its result, was waited on and merged,
    // and then carried on. One such worker independently re-fixed two bugs its orchestrator was
    // fixing in parallel, producing a duplicate branch to triage and discard.
    // Fix: `stillRunning` as its OWN field, so the "done" token keeps its 7kra meaning intact.
    for (const t of ["busy", "quiet"]) {
      fire({ reqId: `sx-${t}`, op: "spawn_worker", buildAgentId: buildId, projectId, payload: { task: t } });
    }
    await flush();
    const [wBusy, wQuiet] = useProjectStore.getState().projects
      .find((p) => p.id === projectId)!
      .agents.filter((a) => a.kind === "worker" && a.parentId === buildId);

    // BOTH have written a result.json, so both are terminal "done". They differ ONLY in liveness:
    // wBusy is still actively producing output, wQuiet's turn has ended. That difference is exactly
    // what the pre-fix reply could not carry.
    useRuntimeStore.setState({ status: { [wBusy!.id]: "working", [wQuiet!.id]: "idle" } });

    const done = JSON.stringify({
      schemaVersion: 1, taskId: "t", branch: "b", status: "success", filesChanged: [], summary: "ok",
    });
    const resultFor: Record<string, string> = {
      [wBusy!.worktreePath!]: done,
      [wQuiet!.worktreePath!]: done,
    };
    try {
      invokeMock.mockImplementation((cmd: string, args: { worktree?: string }) =>
        Promise.resolve(cmd === "read_worker_result" ? (resultFor[args.worktree ?? ""] ?? null) : undefined),
      );

      fire({ reqId: "lxdilh", op: "list_workers", buildAgentId: buildId, projectId, payload: {} });
      await flush();

      const reply = invokeMock.mock.calls.filter(([c]) => c === "orchestration_respond").at(-1)!;
      const workers = (
        reply[1] as {
          result: { workers: Array<{ workerId: string; status: string; stillRunning?: boolean }> };
        }
      ).result.workers;
      const rowOf = (id: string) => workers.find((w) => w.workerId === id)!;

      // THE SIDE EFFECT: the flag travels through to the reply for the worker that is still
      // producing output. Deleting the `stillRunning` spread from handleList makes this fail.
      expect(rowOf(wBusy!.id).stillRunning).toBe(true);
      // ...and NOT for the one whose turn ended. A post-result `idle` worker is the normal,
      // harmless state; flagging it would make the signal noise the orchestrator learns to ignore.
      expect(rowOf(wQuiet!.id).stillRunning).toBeUndefined();
      // The verdict token is UNCHANGED for both — the new fact is layered on, not encoded into
      // `status`, so the 7kra invariant above still means exactly what it meant.
      expect(rowOf(wBusy!.id).status).toBe("done");
      expect(rowOf(wQuiet!.id).status).toBe("done");
    } finally {
      invokeMock.mockReset();
      invokeMock.mockReturnValue(Promise.resolve());
    }
  });

  it("list_workers surfaces each worker's live tab state, not a flat 'running' (sparkle-0an0)", async () => {
    // Root cause: with no result.json the status collapsed EVERY live state to "running", so an
    // orchestrator polling list_workers could not tell a worker mid-cargo-test from one blocked on a
    // session limit, waiting on an on-screen prompt, or awaiting approval. Real work was stranded:
    // a `waiting` worker whose PR sat green and mergeable read exactly like a busy one. Fix: while
    // result.json is still ABSENT, surface the live tab status VERBATIM (the 7kra completion gate is
    // untouched — none of these has a result.json, so none can read the terminal "done"/"failed").
    // Create the workers directly (as the spin_down tests do) so the concurrency cap/queue never
    // holds one back — this test is about how list_workers REPORTS live workers, not about spawning.
    const states = ["working", "idle", "waiting", "blocked", "approval"] as const;
    const ps = useProjectStore.getState();
    const idFor = new Map<string, string>();
    for (const s of states) {
      const id = ps.addAgent(projectId, { kind: "worker", parentId: buildId, task: s })!;
      ps.setAgentWorktree(projectId, id, `/wt/${id}`, `sparkle/agent-${id}`);
      idFor.set(s, id);
    }
    useRuntimeStore.setState({
      status: Object.fromEntries(states.map((s) => [idFor.get(s)!, s])),
    });

    // No result.json for ANY of them (default invoke → undefined), so completion never fires and the
    // returned status is purely the liveness signal this bug is about.
    invokeMock.mockClear();
    fire({ reqId: "l0an0", op: "list_workers", buildAgentId: buildId, projectId, payload: {} });
    await flush();

    const reply = invokeMock.mock.calls.filter(([c]) => c === "orchestration_respond").at(-1)!;
    const workers = (reply[1] as { result: { workers: Array<{ workerId: string; status: string }> } })
      .result.workers;
    const statusOf = (id: string) => workers.find((w) => w.workerId === id)!.status;

    // THE SIDE EFFECT: each DISTINCT live state travels through to the reply. Reverting workerStatus
    // to flatten-to-"running" collapses all five to "running" and every assertion below fails — and
    // none of these result-less workers ever leaks a terminal "done" (the 7kra invariant holds).
    for (const s of states) {
      expect(statusOf(idFor.get(s)!)).toBe(s);
      expect(statusOf(idFor.get(s)!)).not.toBe("done");
    }
  });

  it("spin_down → tears down the worker and replies spunDown:true", async () => {
    const workerId = useProjectStore.getState().addAgent(projectId, { kind: "worker", parentId: buildId })!;
    fire({ reqId: "d1", op: "spin_down", buildAgentId: buildId, projectId, payload: { workerId } });
    await flush();
    expect(spinDownWorkerMock).toHaveBeenCalledWith({ projectId, workerId });
    const [, args] = invokeMock.mock.calls.at(-1)!;
    expect((args as { result: { spunDown: boolean } }).result.spunDown).toBe(true);
  });

  it("spin_down of a worker owned by a DIFFERENT build agent is rejected (no cross-agent reach)", async () => {
    const otherBuild = useProjectStore.getState().addAgent(projectId, { kind: "build" })!;
    const foreign = useProjectStore.getState().addAgent(projectId, { kind: "worker", parentId: otherBuild })!;
    fire({ reqId: "x1", op: "spin_down", buildAgentId: buildId, projectId, payload: { workerId: foreign } });
    await flush();
    expect(spinDownWorkerMock).not.toHaveBeenCalled();
    const [, args] = invokeMock.mock.calls.at(-1)!;
    expect((args as { result: { error?: string } }).result.error).toMatch(/not owned/i);
  });

  // ── spin_down single-owner election ────────────────────────────────────────────────────────────
  // orchestration:request is broadcast to EVERY window, so before the election each open window ran
  // the whole destructive teardown for one request: N killPty, N `git worktree remove` racing over
  // one checkout, N responses to one reqId. These pin down that exactly one window acts, and that
  // the one that acts is never zero.
  describe("spin_down is serviced by exactly one window", () => {
    const spinDown = (workerId: string) =>
      fire({ reqId: "o1", op: "spin_down", buildAgentId: buildId, projectId, payload: { workerId } });

    it("a non-owning window does NOT tear down, and stays silent rather than answering the reqId", async () => {
      thisWindowLabel = "win-b";
      registry = { "win-a": projectId, "win-b": "other-project" };
      liveWindows.add("win-a");
      const workerId = useProjectStore.getState().addAgent(projectId, { kind: "worker", parentId: buildId })!;
      invokeMock.mockClear();
      spinDown(workerId);
      await flush();
      expect(spinDownWorkerMock).not.toHaveBeenCalled();
      // A second reply to one reqId is at best ignored and at worst races the owner's verdict.
      expect(invokeMock).not.toHaveBeenCalled();
    });

    it("the window the registry names as owner DOES tear down", async () => {
      thisWindowLabel = "win-a";
      registry = { "win-a": projectId, "win-b": "other-project" };
      const workerId = useProjectStore.getState().addAgent(projectId, { kind: "worker", parentId: buildId })!;
      spinDown(workerId);
      await flush();
      expect(spinDownWorkerMock).toHaveBeenCalledWith({ projectId, workerId });
    });

    it("main is NOT the owner while a live owner exists (main must not double up)", async () => {
      thisWindowLabel = "main";
      registry = { "win-a": projectId, main: "other-project" };
      liveWindows.add("win-a"); // owner is alive → main stays out
      const workerId = useProjectStore.getState().addAgent(projectId, { kind: "worker", parentId: buildId })!;
      spinDown(workerId);
      await flush();
      expect(spinDownWorkerMock).not.toHaveBeenCalled();
    });

    it("main adopts the request when the registry names an owner that no longer exists", async () => {
      // The at-LEAST-one half. A hard crash skips a window's unload cleanup, so its registry entry
      // outlives it; without the self-heal every window would decline and the build agent would
      // block on the bridge's timeout waiting for a reply that never comes.
      thisWindowLabel = "main";
      registry = { "win-dead": projectId, main: "other-project" };
      // liveWindows stays empty → win-dead probes dead, main evicts it and adopts.
      const workerId = useProjectStore.getState().addAgent(projectId, { kind: "worker", parentId: buildId })!;
      spinDown(workerId);
      await flush();
      expect(spinDownWorkerMock).toHaveBeenCalledWith({ projectId, workerId });
      expect(registry["win-dead"]).toBeUndefined(); // stale entry evicted, not just skipped
    });
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

  it("refuses a worker spawn when the CPU RUN QUEUE is saturated, not just when RAM is (sparkle-tab3nm)", async () => {
    // THE POPULATION THAT CAUSED THE MEASURED INCIDENT. 69 concurrent model processes at load 387
    // on 18 cores (21.5× per core) were ORCHESTRATOR WORKERS — and this gate, documented as "the
    // ONLY concurrency gate for worker spawns", compared against the STATIC ceiling alone. Every
    // runtime measurement was invisible to it, so the run-queue bound could not refuse the very
    // spawns it was built to refuse (roborev 68367, High).
    //
    // THE NUMBERS ENCODE THE POPULATION MISMATCH, and they have to, or this test cannot tell the
    // run-queue branch from the ordinary `min` clamp beside it. `Bound::Load`'s `effective` is
    // `in_use` — the WHOLE fleet (build agents + workers), 69 in the measurement — while
    // `globalUsedSlots()` counts `kind === "worker"` only. So: a roomy static cap of 20, a fleet
    // `in_use` of 8, and ONE live worker. Clamping `20 → 8` and comparing the worker count against
    // it gives `1 >= 8` → admits, which is exactly the silent under-bind. Reading the DIMENSION
    // instead refuses. (Verified by mutation: with the `bound === "load"` line removed this test
    // goes red; an earlier version using a cap of 4 stayed green, because there the clamp happened
    // to land on the same answer and the test proved nothing about the branch.)
    useSettingsStore.setState({ maxConcurrentWorkers: 20, effectiveMaxConcurrentWorkers: 20 });

    // Baseline: with no reading, the roomy static cap admits. This is the vacuous-test guard — it
    // proves the refusal that follows is caused by the reading and not by the seeded fixture.
    admissionReading = null;
    fire({ reqId: "l0", op: "spawn_worker", buildAgentId: buildId, projectId, payload: { task: "ok" } });
    await flush();
    expect(spawnWorkerMock).toHaveBeenCalledTimes(1);

    admissionReading = {
      // The whole fleet's `in_use`, NOT the worker count — see the note on the numbers above.
      effective: 8,
      static_max: 20,
      static_bound: "cpu",
      bound: "load",
      basis: "refused: the CPU run queue is 387.0 deep across 18 cores (21.5× per core…)",
      sampled: true,
      // NO memory sample — the realistic saturated-machine payload, since `sample_now()` forks four
      // processes and a machine at this load is one that cannot fork.
      sample: null,
    };
    invokeMock.mockClear();
    fire({ reqId: "l1", op: "spawn_worker", buildAgentId: buildId, projectId, payload: { task: "no" } });
    await flush();
    expect(spawnWorkerMock).toHaveBeenCalledTimes(1); // held: the cores are the constraint
    expect(invokeMock).not.toHaveBeenCalled(); // reply deferred until the queue drains

    // …and it RETRACTS, RELEASING THE HELD SPAWN RATHER THAN DROPPING IT. A gate that cannot release
    // is a wedged app, and one that silently discards what it queued is worse than one that refused
    // outright. So once the queue drains, BOTH the spawn held above and the new one go through — 3
    // total, not 2. (An earlier draft of this test asserted 2 and was wrong about the mechanism: the
    // deferred `l1` reply is resumed by the same drain, which is the whole point of deferring it.)
    admissionReading = null;
    fire({ reqId: "l2", op: "spawn_worker", buildAgentId: buildId, projectId, payload: { task: "again" } });
    await flush();
    expect(spawnWorkerMock).toHaveBeenCalledTimes(3);
  });

  it("ADMITS a worker while the run queue is only THROTTLING, not at its hard stop (sparkle-e57k99.1)", async () => {
    // THE OTHER HALF OF THE HARD STOP. The test above pins the 21.5x emergency; this pins the band
    // the founder's machine actually lives in. `bound === "load"` used to mean an unconditional
    // `globalUsedSlots() > 0` — every worker but the FIRST refused, machine-wide, from the moment
    // per-core load crossed 2.0x. This box's normal band with a healthy fleet is 2.6x-5.9x, so the
    // gate was shut essentially always: one worker against a static ceiling of 81.
    //
    // The discriminator is `load_headroom`, and it is the ONLY thing that differs from the fixture
    // above — same bound, same `sampled`, same absent memory sample, a roomy static cap and a live
    // worker already running. If this admits and that refuses, the branch is reading the regime and
    // not the dimension.
    useSettingsStore.setState({ maxConcurrentWorkers: 20, effectiveMaxConcurrentWorkers: 20 });

    admissionReading = null;
    fire({ reqId: "t0", op: "spawn_worker", buildAgentId: buildId, projectId, payload: { task: "ok" } });
    await flush();
    expect(spawnWorkerMock).toHaveBeenCalledTimes(1); // one worker is now live

    admissionReading = {
      effective: 9,
      load_headroom: 1, // ← throttling: the queue is deep but the fleet may still grow
      static_max: 20,
      static_bound: "cpu",
      bound: "load",
      basis:
        "throttled: the CPU run queue is 47.0 deep across 18 cores (2.6× per core, throttling past 2.0×)",
      sampled: true,
      sample: null,
    };
    fire({ reqId: "t1", op: "spawn_worker", buildAgentId: buildId, projectId, payload: { task: "more" } });
    await flush();
    expect(spawnWorkerMock).toHaveBeenCalledTimes(2); // ← admitted; under the old branch it was held

    // …and the hard stop on the SAME fleet still refuses, so this is not "the gate stopped gating".
    admissionReading = { ...admissionReading, load_headroom: 0, basis: "refused: … hard stop past 12.0×" };
    invokeMock.mockClear();
    fire({ reqId: "t2", op: "spawn_worker", buildAgentId: buildId, projectId, payload: { task: "no" } });
    await flush();
    expect(spawnWorkerMock).toHaveBeenCalledTimes(2); // held
    expect(invokeMock).not.toHaveBeenCalled(); // reply deferred until the queue drains

    // DRAIN BEFORE LEAVING, exactly as the test above does. A deferred reply is listener state that
    // outlives the test that queued it, and leaving one behind makes the NEXT test's spawn look
    // refused — which is a failure in a file nobody edited, blamed on the wrong change.
    admissionReading = null;
    fire({ reqId: "t3", op: "spawn_worker", buildAgentId: buildId, projectId, payload: { task: "again" } });
    await flush();
    expect(spawnWorkerMock).toHaveBeenCalledTimes(4); // the held t2 released, plus t3
  });

  it("keeps the MEMORY ceiling on the THROTTLE path — a load-attributed reading can still be RAM-bound", async () => {
    // The same regression on the spawn gate (roborev, High). The throttle branch returned
    // `globalUsedSlots() >= staticCap`, so with `bound === "load"` the fleet could grow to the
    // static ceiling while available RAM allowed a handful. `bound` is not a partition: a reading
    // attributed to the queue can carry a live RAM-derived `memory_admitted`.
    //
    // A roomy static cap of 20 with a memory ceiling of 1 — so the two numbers cannot be confused,
    // and only the memory clamp can produce the refusal.
    useSettingsStore.setState({ maxConcurrentWorkers: 20, effectiveMaxConcurrentWorkers: 20 });

    admissionReading = null;
    fire({ reqId: "m0", op: "spawn_worker", buildAgentId: buildId, projectId, payload: { task: "ok" } });
    await flush();
    expect(spawnWorkerMock).toHaveBeenCalledTimes(1); // one worker live, well under the static 20

    admissionReading = {
      effective: 1,
      load_headroom: 1, // throttling, NOT the hard stop — the branch under test
      memory_admitted: 1, // ← RAM allows one
      static_max: 20,
      static_bound: "cpu",
      bound: "load",
      basis: "throttled: the CPU run queue is 47.0 deep across 18 cores (2.6× per core…)",
      sampled: true,
      sample: null,
    };
    invokeMock.mockClear();
    fire({ reqId: "m1", op: "spawn_worker", buildAgentId: buildId, projectId, payload: { task: "no" } });
    await flush();
    expect(spawnWorkerMock).toHaveBeenCalledTimes(1); // held by MEMORY, on a throttling reading

    // PAIRED: the identical reading with memory not narrowing admits, so the clamp is not a latch.
    admissionReading = { ...admissionReading, memory_admitted: 20 };
    fire({ reqId: "m2", op: "spawn_worker", buildAgentId: buildId, projectId, payload: { task: "yes" } });
    await flush();
    expect(spawnWorkerMock).toHaveBeenCalledTimes(3); // m1 released by the drain, plus m2
  });

  it("counts workers MACHINE-WIDE against the RAM cap, not per build agent (sparkle-hfhs)", async () => {
    // The dimensional error behind the 33 GiB coalition. `ram_derived_concurrency` (config.rs)
    // divides the MACHINE's RAM into a machine-wide budget, but this gate applied that budget
    // PER BUILD AGENT. On a 32 GiB Mac the derived cap is (32-6)/3 ≈ 8, so three build agents
    // legally run 24 workers × 3 GiB = 72 GiB budgeted on a 32 GiB machine. Each agent is
    // individually "under the cap" while the machine is three times over it.
    useSettingsStore.setState({ maxConcurrentWorkers: 4, effectiveMaxConcurrentWorkers: 2 });
    const store = useProjectStore.getState();
    const buildB = store.addAgent(projectId, { kind: "build" })!;
    store.setAgentWorktree(projectId, buildB, "/wt/buildB", "sparkle/agent-buildB");

    // Build agent A alone fills the machine-wide budget.
    fire({ reqId: "g1", op: "spawn_worker", buildAgentId: buildId, projectId, payload: { task: "a1" } });
    await flush();
    fire({ reqId: "g2", op: "spawn_worker", buildAgentId: buildId, projectId, payload: { task: "a2" } });
    await flush();
    expect(spawnWorkerMock).toHaveBeenCalledTimes(2);

    // A DIFFERENT build agent asks for one. It has zero workers of its own, so a per-agent gate
    // waves it through — and the machine reaches 3× the per-worker heap with RAM budgeted for 2.
    invokeMock.mockClear();
    fire({ reqId: "g3", op: "spawn_worker", buildAgentId: buildB, projectId, payload: { task: "b1" } });
    await flush();
    expect(spawnWorkerMock).toHaveBeenCalledTimes(2); // held: the MACHINE is full, not this agent
    expect(invokeMock).not.toHaveBeenCalled(); // g3's reply deferred until a slot frees

    // ...and it must actually be RELEASED when the OTHER agent frees a slot. The global gate
    // introduces a cross-agent dependency that did not exist before — B's queued spawn now waits
    // on A — so the drain path has to notice. Holding forever would be its own bug.
    const aWorker = useProjectStore
      .getState()
      .projects.find((p) => p.id === projectId)!
      .agents.find((a) => a.kind === "worker" && a.parentId === buildId)!;
    fire({
      reqId: "g4",
      op: "spin_down",
      buildAgentId: buildId,
      projectId,
      payload: { workerId: aWorker.id },
    });
    // Two flushes, matching the same-agent release case below: the drain path (spin_down →
    // store update → queue scan → spawn) needs an extra microtask turn to settle. One flush
    // happens to pass today, but this assertion is the regression guard — it should not be
    // timing-dependent. The exact count still catches over-spawning: a broken gate reads 4.
    await flush();
    await flush();
    expect(spawnWorkerMock).toHaveBeenCalledTimes(3); // B's queued spawn released by A's spin_down
  });

  it("a PIN is machine-wide: a second agent does NOT get its own allowance (sparkle-axtkw)", async () => {
    // Replaces a test that asserted the opposite ("treats maxConcurrentWorkers as PER AGENT"), which
    // the founder settled machine-wide on 2026-07-30. Two things made the old assertion unsafe:
    //
    // 1. It set `maxConcurrentWorkers: 1, effectiveMaxConcurrentWorkers: 4` — a state `hydrateFromConfig`
    //    can NEVER produce, since both derive from the same pin/derived pair (`effective <= max` is
    //    an invariant, swept in settingsStore.test.ts). It pinned a semantic on unreachable input.
    // 2. The semantic it pinned is the unsafe one. A per-agent allowance is unbounded in N: each
    //    agent sits under the cap while N agents put N × the cap on one machine — the sparkle-hfhs
    //    coalition blowup, and how ~68 agents hit the macOS 256-descriptor ceiling on 2026-07-30.
    //
    // So: a REACHABLE pinned state (both fields 2, as hydrate would set them), and the second agent
    // is refused because the MACHINE is full — not waved through on an allowance of its own.
    useSettingsStore.setState({ maxConcurrentWorkers: 2, effectiveMaxConcurrentWorkers: 2 });
    const store = useProjectStore.getState();
    const buildC = store.addAgent(projectId, { kind: "build" })!;
    store.setAgentWorktree(projectId, buildC, "/wt/buildC", "sparkle/agent-buildC");

    fire({ reqId: "p1", op: "spawn_worker", buildAgentId: buildId, projectId, payload: { task: "a" } });
    await flush();
    fire({ reqId: "p2", op: "spawn_worker", buildAgentId: buildId, projectId, payload: { task: "a2" } });
    await flush();
    expect(spawnWorkerMock).toHaveBeenCalledTimes(2); // agent A fills the machine-wide pin of 2

    invokeMock.mockClear();
    fire({ reqId: "p3", op: "spawn_worker", buildAgentId: buildC, projectId, payload: { task: "c" } });
    await flush();
    // Under a per-agent reading this is 1 worker for a fresh agent — trivially allowed, and the
    // machine would reach 3 against a budget of 2. Machine-wide, it waits.
    expect(spawnWorkerMock).toHaveBeenCalledTimes(2);
    expect(invokeMock).not.toHaveBeenCalled(); // p3 deferred, not answered
  });

  it("the pin — not just the machine derivation — is what the gate enforces", async () => {
    // The hazard called out at the `globalGateBinds` call site: `WorkerLimitControl` legitimately
    // uses `machineMaxConcurrentWorkers` for its slider TRACK (roborev 55027), and a future reader
    // is likely to "fix" the gate to match. That would make a pin stop capping — pinning 2 on a
    // 36-capable Mac would admit 36. Here the machine could carry 36 and the user pinned 2; a gate
    // reading `machineMaxConcurrentWorkers` spawns both, a gate reading `enforcedWorkerCap` spawns one.
    useSettingsStore.setState({
      maxConcurrentWorkers: 1,
      effectiveMaxConcurrentWorkers: 1,
      machineMaxConcurrentWorkers: 36,
    });
    fire({ reqId: "k1", op: "spawn_worker", buildAgentId: buildId, projectId, payload: { task: "one" } });
    await flush();
    fire({ reqId: "k2", op: "spawn_worker", buildAgentId: buildId, projectId, payload: { task: "two" } });
    await flush();
    expect(spawnWorkerMock).toHaveBeenCalledTimes(1); // held at the PIN, not at the hardware's 36
  });

  it("EXPIRES a queued spawn instead of materializing a worker its caller gave up on (roborev 56186)", async () => {
    // The High. An over-cap spawn sits in `spawnQueue`; the MCP client abandons it at its own socket
    // timeout (`DEFAULT_TIMEOUT_MS = 660_000`, apps/mcp-orchestrator/src/bridgeClient.ts) and
    // destroys the socket — but nothing here removed the entry. When a slot later freed, drainQueue
    // created the worker anyway: a real worktree + branch the orchestrator was told had FAILED, so
    // it is absent from `list_workers` and the orchestrator re-spawns the unit. That is a DUPLICATE
    // worker on the same task, and `handleSpawn` deliberately does not de-duplicate an ad-hoc
    // (no-bead) spawn, so nothing catches it.
    //
    // Asserting the SIDE EFFECT — no worker is created when the slot frees — not merely that a
    // reply was sent. A test that only checked the error reply would pass while the spawn still
    // happened, which is the whole defect.
    let clock = 1_000_000;
    __setReaperNow(() => clock);
    try {
      useSettingsStore.setState({ maxConcurrentWorkers: 1, effectiveMaxConcurrentWorkers: 1 });
      fire({ reqId: "x1", op: "spawn_worker", buildAgentId: buildId, projectId, payload: { task: "holds the slot" } });
      await flush();
      expect(spawnWorkerMock).toHaveBeenCalledTimes(1);

      // Over the cap → queued, no reply.
      invokeMock.mockClear();
      fire({ reqId: "x2", op: "spawn_worker", buildAgentId: buildId, projectId, payload: { task: "abandoned" } });
      await flush();
      expect(spawnWorkerMock).toHaveBeenCalledTimes(1);
      expect(invokeMock).not.toHaveBeenCalled();

      // Its caller gives up. Push past the expiry, then free the slot.
      clock += SPAWN_QUEUE_MAX_WAIT_MS + 1;
      const live = useProjectStore
        .getState()
        .projects.find((pr) => pr.id === projectId)!
        .agents.find((a) => a.kind === "worker")!;
      fire({ reqId: "x3", op: "spin_down", buildAgentId: buildId, projectId, payload: { workerId: live.id } });
      await flush();
      await flush();

      // THE ASSERTION: the freed slot must NOT be consumed by the abandoned request.
      expect(spawnWorkerMock).toHaveBeenCalledTimes(1);
      // ...and the caller is told plainly that the unit did not start, which is what makes the
      // persona's "re-spawn it" advice sound.
      const x2 = invokeMock.mock.calls.find(([, a]) => (a as { reqId: string }).reqId === "x2");
      expect((x2![1] as { result: { error?: string } }).result.error).toMatch(/timed out waiting for a free slot/i);
      expect((x2![1] as { result: { error?: string } }).result.error).toMatch(/NOT started/i);
    } finally {
      __setReaperNow();
    }
  });

  it("expires on the REAP TICK too, so a quiet store cannot miss the deadline (roborev 56200)", async () => {
    // The expiry originally ran ONLY at the top of drainQueue, which is driven by projectStore
    // changes / runSpawn's finally / handleSpawn. The 60s reap tick did not call it, and a reap pass
    // that reclaims nothing mutates no store — so on a machine whose capacity is held by leaked
    // worker records that no longer tick the store (exactly the case this queue exists for), the
    // 600s deadline could pass unnoticed and the caller would get the MCP client's raw
    // `bridge request timeout` at 660s instead of the designed capacity error.
    //
    // The duplicate-worker hazard was already closed either way (the top-of-drain sweep runs before
    // any splice). What this pins is the ERROR REPLY, which is the premise the persona's rule rests
    // on — so it asserts the reply arrives with NO store activity whatsoever.
    // Drives `reapOrphanedWorkers` — the exported function the 60s interval, the on-cap trigger and
    // the startup pass all call — rather than the interval itself. Faking the interval is not an
    // option here: `beforeEach` starts the listener under REAL timers, so a later `vi.useFakeTimers()`
    // does not control the already-registered `setInterval` (the first draft of this test failed for
    // exactly that reason, not because the fix was wrong).
    let clock = 3_000_000;
    __setReaperNow(() => clock);
    try {
      useSettingsStore.setState({ maxConcurrentWorkers: 1, effectiveMaxConcurrentWorkers: 1 });
      fire({ reqId: "r1", op: "spawn_worker", buildAgentId: buildId, projectId, payload: { task: "holds" } });
      await flush();
      fire({ reqId: "r2", op: "spawn_worker", buildAgentId: buildId, projectId, payload: { task: "abandoned" } });
      await flush();
      invokeMock.mockClear();
      const before = spawnWorkerMock.mock.calls.length;

      // NOTHING touches the store from here on — only the clock moves and a reap pass runs. That is
      // the whole point: on a quiet store, the reaper must be what delivers the reply.
      clock += SPAWN_QUEUE_MAX_WAIT_MS + 1;
      await reapOrphanedWorkers();

      const r2 = invokeMock.mock.calls.find(([, a]) => (a as { reqId: string }).reqId === "r2");
      expect(r2, "no reply for the expired spawn — the reap pass did not sweep the queue").toBeDefined();
      expect((r2![1] as { result: { error?: string } }).result.error).toMatch(/timed out waiting for a free slot/i);
      // ...and it expired rather than being spawned.
      expect(spawnWorkerMock.mock.calls.length).toBe(before);
    } finally {
      __setReaperNow();
    }
  });

  it("still honours a queued spawn whose caller is STILL waiting (expiry must not fire early)", async () => {
    // The other half: expiring too eagerly would break the normal queue-and-drain path, which is the
    // feature. Just under the deadline, the queued spawn must run exactly as before.
    let clock = 2_000_000;
    __setReaperNow(() => clock);
    try {
      useSettingsStore.setState({ maxConcurrentWorkers: 1, effectiveMaxConcurrentWorkers: 1 });
      fire({ reqId: "y1", op: "spawn_worker", buildAgentId: buildId, projectId, payload: { task: "holds" } });
      await flush();
      fire({ reqId: "y2", op: "spawn_worker", buildAgentId: buildId, projectId, payload: { task: "still wanted" } });
      await flush();
      expect(spawnWorkerMock).toHaveBeenCalledTimes(1);

      clock += SPAWN_QUEUE_MAX_WAIT_MS - 1; // one tick INSIDE the window
      const live = useProjectStore
        .getState()
        .projects.find((pr) => pr.id === projectId)!
        .agents.find((a) => a.kind === "worker")!;
      fire({ reqId: "y3", op: "spin_down", buildAgentId: buildId, projectId, payload: { workerId: live.id } });
      await flush();
      await flush();
      expect(spawnWorkerMock).toHaveBeenCalledTimes(2); // y2 ran, as it always did
    } finally {
      __setReaperNow();
    }
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
      })!;
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

  it("releases the LONGEST-WAITING queued spawn when a slot frees, across build agents", async () => {
    // Was "does not starve a second build agent's queued spawn behind a capped head-of-queue": with a
    // per-agent gate, a head request whose own agent was at cap had to be SKIPPED so another agent
    // with a free slot could pass it. Machine-wide there is one gate, so every queued request gets
    // the same answer and skipping is meaningless — the queue is FIFO (sparkle-axtkw).
    //
    // The fairness property survives in a stronger form, and this asserts it: the freed slot goes to
    // whoever waited LONGEST, not to whichever agent the scan happens to reach first. Reintroducing
    // an agent-keyed scan would hand it to B and fail here.
    useSettingsStore.setState({ maxConcurrentWorkers: 1, effectiveMaxConcurrentWorkers: 1 });
    const buildB = useProjectStore.getState().addAgent(projectId, { kind: "build" })!;
    useProjectStore.getState().setAgentWorktree(projectId, buildB, "/wt/buildB", "sparkle/agent-buildB");

    // A fills the machine's single slot; A's second and then B's first both queue behind it.
    fire({ reqId: "a1", op: "spawn_worker", buildAgentId: buildId, projectId, payload: { task: "a-live" } });
    await flush();
    fire({ reqId: "a2", op: "spawn_worker", buildAgentId: buildId, projectId, payload: { task: "a-queued" } });
    await flush();
    fire({ reqId: "b1", op: "spawn_worker", buildAgentId: buildB, projectId, payload: { task: "b-queued" } });
    await flush();
    expect(spawnWorkerMock).toHaveBeenCalledTimes(1); // machine full — BOTH are waiting

    // Free the slot. a2 queued before b1, so a2 goes first.
    const live = useProjectStore
      .getState()
      .projects.find((p) => p.id === projectId)!
      .agents.find((a) => a.kind === "worker")!;
    invokeMock.mockClear();
    fire({ reqId: "d1", op: "spin_down", buildAgentId: buildId, projectId, payload: { workerId: live.id } });
    await flush();
    await flush();
    const reqIds = invokeMock.mock.calls.map(([, a]) => (a as { reqId: string }).reqId);
    expect(reqIds).toContain("a2"); // the longest-waiting request got the freed slot
    expect(reqIds).not.toContain("b1"); // ...and exactly one was released; b1 still waits
    expect(spawnWorkerMock).toHaveBeenCalledTimes(2);
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

  it("the deduped reply is MARKED reused, so a dropped task cannot read as a successful spawn", async () => {
    // Idempotency means "don't spawn twice"; it does not mean "let the caller believe its task ran".
    // The returned worker is executing the task from the FIRST request — "fix the P0" — and the
    // second request's task is discarded. Without this marker the two replies are
    // indistinguishable, so an orchestrator re-dispatching a bead with a corrected task reads a
    // handle, assumes dispatch, and waits on work nobody is doing.
    fire({ reqId: "m1", op: "spawn_worker", buildAgentId: buildId, projectId, payload: { task: "fix the P0", beadId: "sparkle-mark" } });
    await flush();
    // A genuine spawn carries NO marker — otherwise "reused" would be true of everything and mean
    // nothing, and this assertion would hold against the old code.
    expect(lastResult().reused).toBeUndefined();

    fire({ reqId: "m2", op: "spawn_worker", buildAgentId: buildId, projectId, payload: { task: "fix the P0 differently", beadId: "sparkle-mark" } });
    await flush();
    expect(lastResult().reused).toBe(true);
    // Still the same single worker, still running the ORIGINAL task.
    expect(spawnWorkerMock).toHaveBeenCalledTimes(1);
    expect(spawnWorkerMock.mock.calls[0]![0]).toMatchObject({ task: "fix the P0" });
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
    const otherBuild = useProjectStore.getState().addAgent(projectId, { kind: "build" })!;
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

  // ── the LIVE roster reports the branch the worker COMMITTED to (sparkle-ul7cnx) ────────────────
  //
  // Scoped deliberately to workers that are PRESENT IN THE STORE, i.e. neither evicted nor
  // disk-recovered. The two commits that landed before this one (workerScan.ts,
  // scan_worker_manifests_at) fixed only the recovery paths, and `reconcileWorkersFromDisk` SKIPS a
  // worker whose record is already present — so a test that exercised recovery would be asserting
  // against code that was already correct and would stay green with this whole change reverted.
  // Every test below spawns through the real listener path first, so the row under assertion comes
  // from the store, exactly as a live worker's does.
  describe("list_workers branch derivation", () => {
    /** Spawn one worker through the listener and hand back its id + minted spawn name. */
    const spawnLive = async (reqId: string) => {
      fire({ reqId, op: "spawn_worker", buildAgentId: buildId, projectId, payload: { task: "t" } });
      await flush();
      const worker = workersOf(projectId, buildId)[0]!;
      return { workerId: worker.id, spawnBranch: worker.branch!, worktree: worker.worktreePath! };
    };
    /** The manifest the backend scan returns — its `branch` is already HEAD-derived there. */
    const manifestOn = (w: { workerId: string; worktree: string }, branch: string) => ({
      workerId: w.workerId,
      buildAgentId: buildId,
      projectId,
      branch,
      worktree: w.worktree,
      task: "t",
      createdAt: "2026-08-25T00:00:00.000Z",
    });

    it("reports the branch a LIVE worker's HEAD is on, not the name minted at spawn", async () => {
      // THE MEASURED FAILURE. The worker followed AGENTS.md and named its branch for the work, so
      // the minted `sparkle/agent-<uuid>` was left fast-forwarded to its base. Reporting that name
      // made `git merge` answer "Already up to date" and exit 0 on a merge that moved nothing, and
      // the orchestrator concluded the worker had produced nothing. 794 lines.
      const live = await spawnLive("lulb1");
      expect(live.spawnBranch).toMatch(/^sparkle\/agent-/); // the row really is a spawn-named one
      // The store record is PRESENT, so the reconcile skips it — this is the live path, not recovery.
      scanWorkerManifestsMock.mockResolvedValueOnce([manifestOn(live, "feature/some-work")]);
      fire({ reqId: "lulb1r", op: "list_workers", buildAgentId: buildId, projectId, payload: {} });
      await flush();
      const { workers } = lastResult() as {
        workers: Array<{ workerId: string; branch: string; spawnBranch?: string }>;
      };
      expect(workers).toHaveLength(1);
      const row = workers[0]!;
      expect(row.workerId).toBe(live.workerId);
      // The row still has to name a worker the store never forgot.
      expect(workersOf(projectId, buildId).map((w) => w.id)).toContain(live.workerId);
      expect(row.branch).toBe("feature/some-work");
      // …and the minted name survives ALONGSIDE it, because teardown safety on the orchestrator
      // side assesses the union of both: a landed HEAD must not vouch for a spawn branch that still
      // holds unlanded commits, or spin_down deletes the worktree those commits live in.
      expect(row.spawnBranch).toBe(live.spawnBranch);
    });

    it("a DETACHED-HEAD worktree still reports the manifest/spawn name, never a bare sha", async () => {
      // The paired negative. `branch_from_worktree_head` requires a literal `ref: refs/heads/` line
      // and returns None otherwise, so the backend leaves the manifest's own value in place — the
      // scan hands back the spawn name and there is nothing to disagree with. Reporting the raw sha
      // AS a branch would be a different silent failure: `git merge <sha>` is not what the caller
      // meant to run, and it would ALSO manufacture a bogus spawnBranch disagreement on every
      // detached worker, which is how a warning stops being read.
      const live = await spawnLive("lulb2");
      scanWorkerManifestsMock.mockResolvedValueOnce([manifestOn(live, live.spawnBranch)]);
      fire({ reqId: "lulb2r", op: "list_workers", buildAgentId: buildId, projectId, payload: {} });
      await flush();
      const { workers } = lastResult() as {
        workers: Array<{ branch: string; spawnBranch?: string }>;
      };
      expect(workers).toHaveLength(1);
      expect(workers[0]!.branch).toBe(live.spawnBranch);
      // No disagreement → no spawnBranch. Emitting one here would put a contradiction warning on
      // every ordinary row.
      expect(workers[0]!).not.toHaveProperty("spawnBranch");
    });

    it("falls back to the store's branch when the worker has no manifest on disk", async () => {
      // Mid-spawn, or a worktree that has gone away. "We could not look" is not "we looked and it
      // is elsewhere" — an absent read must never override, and must never blank the row's branch.
      const live = await spawnLive("lulb3");
      scanWorkerManifestsMock.mockResolvedValueOnce([]);
      fire({ reqId: "lulb3r", op: "list_workers", buildAgentId: buildId, projectId, payload: {} });
      await flush();
      const { workers } = lastResult() as {
        workers: Array<{ branch: string; spawnBranch?: string }>;
      };
      expect(workers[0]!.branch).toBe(live.spawnBranch);
      expect(workers[0]!).not.toHaveProperty("spawnBranch");
    });

    it("scans disk exactly ONCE per list_workers", async () => {
      // The derivation reuses the reconcile's own scan. Two scans would be two backend round-trips
      // observing two different disks, so a worker whose HEAD moved between them would be reported
      // with a branch that never matched the adoption it was reconciled against.
      await spawnLive("lulb4");
      scanWorkerManifestsMock.mockClear();
      fire({ reqId: "lulb4r", op: "list_workers", buildAgentId: buildId, projectId, payload: {} });
      await flush();
      expect(scanWorkerManifestsMock).toHaveBeenCalledTimes(1);
    });
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
    // Retry under the SAME projectId + buildAgentId, because the claim key is
    // (projectId, buildAgentId, beadId) — retrying under a fresh project/agent would compute a
    // DIFFERENT key, never collide with the leaked one, and pass whether or not the fix exists.
    // (That was the original form of this test; roborev 41951 caught that it verified nothing.)
    // Only the cap is relaxed, so the retry has a slot but the same identity.
    useSettingsStore.setState({ maxConcurrentWorkers: 4, effectiveMaxConcurrentWorkers: 20 });
    fire({ reqId: "q3", op: "spawn_worker", buildAgentId: buildId, projectId, payload: { task: "retry", beadId: "bead-queued" } });
    await flush();
    expect(spawnWorkerMock).toHaveBeenCalledTimes(2);
  });

  it("teardown clears claims, so a restarted listener can dispatch a previously-queued bead", async () => {
    // The second leak path. Previously exercised only incidentally by afterEach(cleanup), so a
    // regression removing `claimedBeads.clear()` from teardown would not have failed anything.
    useSettingsStore.setState({ maxConcurrentWorkers: 1, effectiveMaxConcurrentWorkers: 1 });
    fire({ reqId: "t1", op: "spawn_worker", buildAgentId: buildId, projectId, payload: { task: "occupy", beadId: "bead-t-occupy" } });
    await flush();
    fire({ reqId: "t2", op: "spawn_worker", buildAgentId: buildId, projectId, payload: { task: "queued", beadId: "bead-t-queued" } });
    await flush();
    expect(spawnWorkerMock).toHaveBeenCalledTimes(1);

    cleanup?.(); // teardown — drops the queued request; its claim must not survive
    cleanup = await startOrchestrationListener();
    useSettingsStore.setState({ maxConcurrentWorkers: 4, effectiveMaxConcurrentWorkers: 20 });
    // Same project + build agent + bead as the queued request that was dropped.
    fire({ reqId: "t3", op: "spawn_worker", buildAgentId: buildId, projectId, payload: { task: "retry", beadId: "bead-t-queued" } });
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

  // ── reaper: reclaim orphaned workers (machine-wide cap leak) ───────────────────────────────────
  describe("reapOrphanedWorkers", () => {
    const T0 = 1_000_000;
    const GRACE_MS = REAP_GRACE_MS; // the real constant, not a copied literal
    let clock = T0; // the reaper reads this via the injected clock, so grace timing is deterministic

    // Inject a worker whose parent build agent is NOT in the store — the leak a crashed/force-quit
    // build agent leaves behind (its workers were never spun down, so their records occupy the
    // machine-wide cap forever). addAgent accepts an arbitrary parentId, exactly as the real spawn
    // path records it, so this reproduces the on-disk/in-memory orphan faithfully.
    const addOrphanWorker = (pid: string, ghostParent: string): string => {
      const id = useProjectStore.getState().addAgent(pid, {
        kind: "worker",
        parentId: ghostParent,
        task: "stranded work",
      })!;
      useProjectStore.getState().setAgentWorktree(pid, id, `/wt/${id}`, `sparkle/agent-${id}`);
      return id;
    };
    // Re-point an existing worker's parent (to simulate a parent vanishing / returning across a
    // cross-window sync), without going through a store action that would cascade.
    const setParent = (workerId: string, parent: string) =>
      useProjectStore.setState((s) => ({
        projects: s.projects.map((p) =>
          p.id === projectId
            ? { ...p, agents: p.agents.map((a) => (a.id === workerId ? { ...a, parentId: parent } : a)) }
            : p,
        ),
      }));

    beforeEach(async () => {
      clock = T0;
      __setReaperNow(() => clock); // one shared clock domain for every reaper caller
      await flush(); // settle the fire-and-forget startup reconcile→reap (no orphans yet → no-op)
      spinDownWorkerMock.mockClear();
    });
    afterEach(() => {
      __setReaperNow(); // restore the production default clock for the rest of the suite
    });

    it("reaps a parent-gone orphan only after >=2 observations AND the grace elapses", async () => {
      // A live worker under the real (present) build agent — must never be touched.
      fire({ reqId: "live", op: "spawn_worker", buildAgentId: buildId, projectId, payload: { task: "real work" } });
      await flush();
      const liveWorker = workersOf(projectId, buildId)[0]!;
      const orphanId = addOrphanWorker(projectId, "ghost-build-agent");
      spinDownWorkerMock.mockClear();

      // 1st observation: records the clock; a single snapshot is never enough (a transient cross-window
      // view could show a live worker as orphaned).
      expect(await reapOrphanedWorkers()).toBe(0);
      // 2nd observation immediately after: count is now 2, but no time has passed (< grace) → held.
      expect(await reapOrphanedWorkers()).toBe(0);
      expect(spinDownWorkerMock).not.toHaveBeenCalled();

      // Observed orphaned throughout, and the grace has now elapsed → reclaimed.
      clock = T0 + GRACE_MS;
      expect(await reapOrphanedWorkers()).toBe(1);
      expect(spinDownWorkerMock).toHaveBeenCalledTimes(1);
      expect(spinDownWorkerMock).toHaveBeenCalledWith({ projectId, workerId: orphanId });
      // The live worker (parent present) was never a candidate.
      expect(spinDownWorkerMock).not.toHaveBeenCalledWith({ projectId, workerId: liveWorker.id });
      expect(workersOf(projectId, buildId).some((w) => w.id === liveWorker.id)).toBe(true);
    });

    it("a single observation never reaps, even far past the grace (monotonic count guard)", async () => {
      // Guards a wall-clock suspend/resume jump that lands past the grace: one observation is never
      // enough, no matter how much time the clock claims has elapsed.
      addOrphanWorker(projectId, "ghost-build-agent");
      clock = T0 + 100 * GRACE_MS;
      expect(await reapOrphanedWorkers()).toBe(0);
      expect(spinDownWorkerMock).not.toHaveBeenCalled();
    });

    it("a suspend/resume gap breaks continuity — the grace is re-earned, not satisfied by one snapshot", async () => {
      // count=1 observed, then a >2*interval gap (suspend / clock jump), then one post-resume snapshot.
      // Without continuity handling that lone snapshot would reap (count→2, elapsed huge). It must not:
      // the record resets to a single fresh observation, exactly when cross-window rehydrate lag is worst.
      const orphanId = addOrphanWorker(projectId, "ghost-build-agent");
      expect(await reapOrphanedWorkers()).toBe(0); // obs #1 at T0
      clock = T0 + 3 * 60_000; // a 3-minute gap (> 2 * the 60s sweep interval) = lost continuity
      expect(await reapOrphanedWorkers()).toBe(0); // resets to obs #1 — a single post-resume snapshot
      expect(spinDownWorkerMock).not.toHaveBeenCalled();
      // A continuous second observation after the reset, past the grace, does reap.
      clock = clock + GRACE_MS;
      expect(await reapOrphanedWorkers()).toBe(1);
      expect(spinDownWorkerMock).toHaveBeenCalledWith({ projectId, workerId: orphanId });
    });

    it("a BACKWARDS clock step also breaks continuity (never strands a future `first`)", async () => {
      // An NTP correction / manual clock change can move time backwards. Without symmetric handling the
      // record keeps a `first` in the future, so `now - first` stays < grace forever and the orphan is
      // never reaped. A backwards step must reset the record, exactly like a forward suspend gap.
      const orphanId = addOrphanWorker(projectId, "ghost-build-agent");
      clock = T0;
      expect(await reapOrphanedWorkers()).toBe(0); // obs #1 at T0
      clock = T0 - 5_000; // clock jumps BACKWARDS 5s
      expect(await reapOrphanedWorkers()).toBe(0); // continuity broken → resets to a single obs at T0-5s
      expect(spinDownWorkerMock).not.toHaveBeenCalled();
      // From the reset point, a normal continuous run past the grace still reaps (not stranded).
      clock = T0 - 5_000 + GRACE_MS;
      expect(await reapOrphanedWorkers()).toBe(1);
      expect(spinDownWorkerMock).toHaveBeenCalledWith({ projectId, workerId: orphanId });
    });

    it("re-runs once when a trigger arrives while a pass is already in flight (single-flight blind spot)", async () => {
      // Make spinDownWorker await a barrier so the first pass is provably still in flight when a second
      // trigger arrives. The second call returns 0 (single-flight) but must set the re-run flag, and the
      // finishing pass must re-run on a microtask — otherwise a just-appeared orphan waits for the sweep.
      let release!: () => void;
      const barrier = new Promise<void>((r) => (release = r));
      const orphanA = addOrphanWorker(projectId, "ghost-a");
      // Mature orphanA so pass 1 will try to reap it (and block on the barrier mid-teardown).
      await reapOrphanedWorkers(); // obs #1
      clock = T0 + GRACE_MS; // obs #2 will be past grace
      spinDownWorkerMock.mockReset();
      spinDownWorkerMock.mockImplementationOnce(async (args: { projectId: string; workerId: string }) => {
        await barrier; // hold the first pass open
        useProjectStore.getState().removeAgent(args.projectId, args.workerId);
      });
      spinDownWorkerMock.mockImplementation(async (args: { projectId: string; workerId: string }) => {
        useProjectStore.getState().removeAgent(args.projectId, args.workerId);
      });

      const pass1 = reapOrphanedWorkers(); // enters pass 2, awaits the barrier inside spinDownWorker
      await flush();
      // A NEW orphan appears + a concurrent trigger fires while pass 1 is blocked.
      const orphanB = addOrphanWorker(projectId, "ghost-b");
      expect(await reapOrphanedWorkers()).toBe(0); // swallowed by single-flight → sets the re-run flag
      release(); // let pass 1 finish (reaps orphanA)
      expect(await pass1).toBe(1);
      expect(spinDownWorkerMock).toHaveBeenCalledWith({ projectId, workerId: orphanA }); // pass 1 reaped A
      // The re-run (microtask) now observes orphanB. Give it its first observation; without the re-run
      // it would never have been looked at until the 60s sweep. Drive it to reap to prove it's tracked.
      await flush();
      clock = clock + GRACE_MS;
      await reapOrphanedWorkers();
      expect(spinDownWorkerMock).toHaveBeenCalledWith({ projectId, workerId: orphanB });
      // restore the default spin mock for later tests
      spinDownWorkerMock.mockReset();
      spinDownWorkerMock.mockImplementation(async (args: { projectId: string; workerId: string }) => {
        useProjectStore.getState().removeAgent(args.projectId, args.workerId);
      });
    });

    it("does not reap if the parent reappears within the grace window (transient sync-lag guard)", async () => {
      const orphanId = addOrphanWorker(projectId, buildId); // parent present at first
      expect(await reapOrphanedWorkers()).toBe(0); // not even a candidate
      setParent(orphanId, "ghost"); // parent momentarily vanishes in this window's snapshot
      expect(await reapOrphanedWorkers()).toBe(0); // 1st orphaned observation → grace starts
      setParent(orphanId, buildId); // parent propagates back before the grace elapses
      clock = T0 + GRACE_MS;
      expect(await reapOrphanedWorkers()).toBe(0); // no longer orphaned → clock cleared, not reaped
      expect(spinDownWorkerMock).not.toHaveBeenCalled();
    });

    it("never reaps a PARENTLESS worker (parentId null), even past the grace", async () => {
      // addAgent defaults parentId to null. Missing data must be treated conservatively (left alone),
      // exactly as reconcileWorkersFromDisk skips it — not read as "orphaned, destroy it".
      const id = useProjectStore.getState().addAgent(projectId, { kind: "worker", task: "no parent" })!;
      useProjectStore.getState().setAgentWorktree(projectId, id, `/wt/${id}`, `sparkle/agent-${id}`);

      await reapOrphanedWorkers();
      clock = T0 + GRACE_MS;
      await reapOrphanedWorkers();
      expect(spinDownWorkerMock).not.toHaveBeenCalled();
    });

    it("does not reap an idle/'done' worker whose parent build agent is still alive", async () => {
      fire({ reqId: "d1", op: "spawn_worker", buildAgentId: buildId, projectId, payload: { task: "finished work" } });
      await flush();
      const doneWorker = workersOf(projectId, buildId)[0]!;
      // Terminal runtime status, parent still present — the "done but never spun down" duplicate
      // fleet. The reaper must leave it to its live orchestrator; only a departed parent qualifies.
      useRuntimeStore.setState({ status: { [doneWorker.id]: "done" } });
      spinDownWorkerMock.mockClear();

      await reapOrphanedWorkers();
      clock = T0 + GRACE_MS;
      await reapOrphanedWorkers();
      expect(spinDownWorkerMock).not.toHaveBeenCalled();
    });

    it("skips an orphan whose teardown is already in flight (tombstoned)", async () => {
      const orphanId = addOrphanWorker(projectId, "ghost-build-agent");
      registerLocalRemovals([orphanId]); // a spin_down is mid-flight; don't double-reap
      spinDownWorkerMock.mockClear();

      await reapOrphanedWorkers();
      clock = T0 + GRACE_MS;
      await reapOrphanedWorkers();
      expect(spinDownWorkerMock).not.toHaveBeenCalled();
      acknowledgeRemovals([orphanId]); // don't leak the tombstone into later tests
    });

    it("reaps for a spawn blocked by a PIN, not only by the hardware derivation", async () => {
      // Inverted from "does NOT reap when only this agent's OWN cap binds" (sparkle-axtkw). That test
      // guarded a `if (globalGateBinds())` condition on the reap: with a per-agent gate, a spawn could
      // be refused while machine-wide orphans were irrelevant, so scanning would be wasted work. It
      // set `maxConcurrentWorkers: 1, effectiveMaxConcurrentWorkers: 20` — effective ABOVE the pin,
      // which `hydrateFromConfig` cannot produce (see the invariant sweep in settingsStore.test.ts).
      //
      // With one machine-wide gate, reaching the queue IS the gate binding, so the condition became a
      // tautology and was dropped. The property worth pinning now is that the reap still fires when
      // the binding limit is the USER'S PIN rather than the hardware — a reader who assumed "reap
      // only when the machine is physically full" would re-add a `machineMaxConcurrentWorkers` check
      // here and strand this spawn behind dead records forever.
      vi.useFakeTimers();
      try {
        __setReaperNow(); // production clock == the (now fake) Date.now, advanced in step with timers
        vi.setSystemTime(T0);
        // Pinned at 1 on hardware that could carry 20 — a reachable hydrated state, unlike the above.
        useSettingsStore.setState({
          maxConcurrentWorkers: 1,
          effectiveMaxConcurrentWorkers: 1,
          machineMaxConcurrentWorkers: 20,
        });
        fire({ reqId: "own1", op: "spawn_worker", buildAgentId: buildId, projectId, payload: { task: "first" } });
        await vi.advanceTimersByTimeAsync(0);
        const orphanId = addOrphanWorker(projectId, "ghost-build-agent");
        spinDownWorkerMock.mockClear();

        fire({ reqId: "own2", op: "spawn_worker", buildAgentId: buildId, projectId, payload: { task: "over the pin" } });
        await vi.advanceTimersByTimeAsync(GRACE_MS * 3); // two observations + the grace → reap fires

        expect(spinDownWorkerMock).toHaveBeenCalledWith({ projectId, workerId: orphanId });
      } finally {
        vi.useRealTimers();
      }
    });

    it("on-cap reap arms a follow-up that reaps the orphan and unblocks the queued spawn", async () => {
      // Drives the REAL timer-callback path (not a setTimeout-delay assertion): machine cap = 1,
      // saturated by one orphan. The blocked spawn's on-cap reap is observation #1 and arms a
      // follow-up; advancing past the grace fires it → observation #2 → reap → drain → the real spawn.
      vi.useFakeTimers();
      try {
        __setReaperNow();
        vi.setSystemTime(T0);
        useSettingsStore.setState({ maxConcurrentWorkers: 4, effectiveMaxConcurrentWorkers: 1 });
        addOrphanWorker(projectId, "ghost-build-agent");
        spawnWorkerMock.mockClear();

        fire({ reqId: "blocked", op: "spawn_worker", buildAgentId: buildId, projectId, payload: { task: "wants a slot" } });
        await vi.advanceTimersByTimeAsync(0); // on-cap reap: obs #1, arms the follow-up
        expect(spawnWorkerMock).not.toHaveBeenCalled(); // still blocked, within grace

        await vi.advanceTimersByTimeAsync(GRACE_MS + 100); // follow-up fires → obs #2 past grace → reap → drain
        expect(spawnWorkerMock).toHaveBeenCalledTimes(1);
        expect(workersOf(projectId, buildId)).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("teardown cancels a pending grace follow-up so nothing reaps after the listener is gone", async () => {
      vi.useFakeTimers();
      try {
        __setReaperNow();
        vi.setSystemTime(T0);
        useSettingsStore.setState({ maxConcurrentWorkers: 4, effectiveMaxConcurrentWorkers: 1 });
        const orphanId = addOrphanWorker(projectId, "ghost-build-agent");
        fire({ reqId: "blocked", op: "spawn_worker", buildAgentId: buildId, projectId, payload: { task: "wants a slot" } });
        await vi.advanceTimersByTimeAsync(0); // arms the follow-up
        spinDownWorkerMock.mockClear();

        cleanup?.(); // teardown clears graceTimer + bumps the generation
        cleanup = undefined;
        await vi.advanceTimersByTimeAsync(GRACE_MS * 2); // the follow-up would have fired in here

        expect(spinDownWorkerMock).not.toHaveBeenCalledWith({ projectId, workerId: orphanId });
      } finally {
        vi.useRealTimers();
        cleanup = await startOrchestrationListener(); // restore for the outer afterEach
      }
    });

    it("is single-flight: a concurrent pass returns 0 without a second teardown", async () => {
      const orphanId = addOrphanWorker(projectId, "ghost-build-agent");
      await reapOrphanedWorkers(); // 1st observation
      clock = T0 + GRACE_MS;
      spinDownWorkerMock.mockClear();

      const p1 = reapOrphanedWorkers(); // matured → reaps, but awaits spinDownWorker (leaves reaping=true)
      const p2 = reapOrphanedWorkers(); // sees reaping=true → returns 0 immediately, no 2nd teardown
      const [r1, r2] = await Promise.all([p1, p2]);

      expect(r2).toBe(0);
      expect(r1).toBe(1);
      expect(spinDownWorkerMock).toHaveBeenCalledTimes(1);
      expect(spinDownWorkerMock).toHaveBeenCalledWith({ projectId, workerId: orphanId });
      await flush(); // p2 set the re-run flag → drain the queued microtask before teardown, no dangling pass
    });

    it("a fresh listener after teardown can still reap (state not wedged)", async () => {
      cleanup?.(); // tear down listener A (bumps the generation, resets reaping + the grace map)
      cleanup = await startOrchestrationListener(); // listener B
      await flush();
      const orphanId = addOrphanWorker(projectId, "ghost-build-agent");
      spinDownWorkerMock.mockClear();

      expect(await reapOrphanedWorkers()).toBe(0); // 1st observation on the fresh listener
      clock = T0 + GRACE_MS;
      expect(await reapOrphanedWorkers()).toBe(1); // grace elapsed → reaped (reaping wasn't left stuck)
      expect(spinDownWorkerMock).toHaveBeenCalledWith({ projectId, workerId: orphanId });
    });
  });
});
