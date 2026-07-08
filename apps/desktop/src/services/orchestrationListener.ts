// Frontend half of the orchestration round-trip. The bridge (bridge.rs) emits an
// "orchestration:request" Tauri event whenever the build agent's MCP server calls a privileged op
// (spawn_worker / list_workers / spin_down) — only the React layer can create/destroy a worker TAB.
// This singleton listener services those events, scopes everything to the requesting build agent
// (buildAgentId is authoritative — supplied by the bridge, not the caller), enforces the
// maxConcurrentWorkers cap with a queue, and replies via the orchestration_respond command.
//
// read_result is NOT handled here — it is a synchronous Rust-only op the MCP server polls directly
// for wait_for_workers (see bridge.rs + apps/mcp-orchestrator).
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { safeUnlisten } from "./safeUnlisten";
import { spawnWorker, spinDownWorker } from "./workerSpawn";
import { scanWorkerManifests, type WorkerManifest } from "./worktree";
import { useProjectStore, isWorkerTearingDown } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useSettingsStore } from "../stores/settingsStore";
import { workersNeedingOpen } from "../engine/workerAttention";

const EVENT = "orchestration:request";

export interface OrchestrationRequest {
  reqId: string;
  op: "spawn_worker" | "list_workers" | "spin_down";
  buildAgentId: string;
  projectId: string;
  payload: { task?: string; workerId?: string; beadId?: string };
}

let unlisten: UnlistenFn | undefined;
let unsubStore: (() => void) | undefined;
let unsubRuntime: (() => void) | undefined;
// Single-flight start guard: a promise shared by every caller so two concurrent first-callers can't
// both register a listener (which would double-dispatch every event → doubled spawns). Reset by
// cleanup so a later start (e.g. after HMR) can re-arm.
let startPromise: Promise<() => void> | undefined;
// spawn_worker requests deferred because the build agent is at its concurrency cap. Released by
// drainQueue() whenever a worker slot frees (a spin_down, a failed/finished spawn, or a store change).
const spawnQueue: OrchestrationRequest[] = [];
// Synchronous reservation count keyed by `${projectId}:${buildAgentId}`. spawnWorker is async and
// the store's worker count only rises once it resolves, so a cap check on liveWorkerCount alone
// would let concurrent spawn_worker events (and concurrent drainQueue passes) ALL read the
// pre-spawn count and over-spawn past the cap. Reserving a slot synchronously — before the first
// await — closes that window.
const inFlight = new Map<string, number>();

function flightKey(projectId: string, buildAgentId: string): string {
  return `${projectId}:${buildAgentId}`;
}
function getInFlight(projectId: string, buildAgentId: string): number {
  return inFlight.get(flightKey(projectId, buildAgentId)) ?? 0;
}
function incInFlight(projectId: string, buildAgentId: string): void {
  const k = flightKey(projectId, buildAgentId);
  inFlight.set(k, (inFlight.get(k) ?? 0) + 1);
}
function decInFlight(projectId: string, buildAgentId: string): void {
  const k = flightKey(projectId, buildAgentId);
  const n = (inFlight.get(k) ?? 0) - 1;
  if (n <= 0) inFlight.delete(k);
  else inFlight.set(k, n);
}

/** Purge all orchestration state for a build agent whose bridge is being stopped ():
 *  reply-and-drop every one of its still-queued spawn requests (so a closed orchestrator's deferred
 *  spawns don't linger and can't fire against a torn-down bridge), and clear its in-flight slot
 *  reservations across every project (keyed `${projectId}:${buildAgentId}`) so a later reincarnation
 *  of the same build agent id starts from a clean cap. Idempotent and cheap; safe to call on every
 *  build-agent close. The Rust `stop_bridge` separately releases the blocked accept threads, so
 *  this only needs to handle the frontend-side queue + reservation bookkeeping. */
export function purgeBuildAgent(buildAgentId: string): void {
  for (let i = spawnQueue.length - 1; i >= 0; i--) {
    if (spawnQueue[i]!.buildAgentId === buildAgentId) {
      const [dropped] = spawnQueue.splice(i, 1);
      void respond(dropped!.reqId, { error: "orchestration bridge stopped" });
    }
  }
  const suffix = `:${buildAgentId}`;
  for (const key of [...inFlight.keys()]) {
    if (key.endsWith(suffix)) inFlight.delete(key);
  }
}

/** Reply to a round-trip op. The bridge wraps `result` into the socket response; a frontend-side
 *  failure is conveyed as `{ error }` (the MCP server treats that as a tool error). */
function respond(reqId: string, result: unknown): Promise<void> {
  return invoke("orchestration_respond", { reqId, result }).then(
    () => {},
    (e) => console.error("orchestration_respond failed", reqId, e),
  );
}

function liveWorkerCount(projectId: string, buildAgentId: string): number {
  const project = useProjectStore.getState().projects.find((p) => p.id === projectId);
  if (!project) return 0;
  return project.agents.filter((a) => a.kind === "worker" && a.parentId === buildAgentId).length;
}

/** Slots already taken: live tabs PLUS spawns mid-flight (reserved synchronously). The single
 *  source of truth for the cap so handleSpawn and drainQueue agree.
 *
 *  NB: the cap is PER BUILD AGENT, not global — `maxConcurrentWorkers` is the ceiling each build
 *  agent may run concurrently (matches the task brief: "count THIS build agent's live workers").
 *  With multiple build agents the machine-wide total can reach N_agents × maxConcurrentWorkers. */
function usedSlots(projectId: string, buildAgentId: string): number {
  return liveWorkerCount(projectId, buildAgentId) + getInFlight(projectId, buildAgentId);
}

/** Coarse runtime status for list_workers. Authoritative completion is wait_for_workers
 *  (result.json); this is the live tab status the build agent can glance at meanwhile. */
function workerStatus(workerId: string): "running" | "done" | "failed" {
  const s = useRuntimeStore.getState().status[workerId];
  if (s === "errored") return "failed";
  if (s === "done") return "done";
  return "running";
}

async function runSpawn(req: OrchestrationRequest): Promise<void> {
  // Reserve the slot SYNCHRONOUSLY — before the first await — so a concurrent spawn/drain sees it
  // immediately and can't also pass the cap. Released in finally.
  incInFlight(req.projectId, req.buildAgentId);
  try {
    const { workerId, branch, worktree } = await spawnWorker({
      projectId: req.projectId,
      parentAgentId: req.buildAgentId,
      task: req.payload.task ?? "",
      beadId: req.payload.beadId,
    });
    const project = useProjectStore.getState().projects.find((p) => p.id === req.projectId);
    const worker = project?.agents.find((a) => a.id === workerId);
    // Auto-start the worker: opening it adds it to openAgentIds, which mounts its AgentPane and
    // launches the PTY (worker persona + stored task). Without this the orchestrated worker sits
    // idle in the sidebar showing "Start this agent" until a human clicks it — the manual spawn
    // paths in AgentSidebar already call open() for exactly this reason. Gate on the worker record
    // existing so a never-materialized id can't be stranded in openAgentIds; the per-build-agent
    // concurrency cap is already enforced upstream (handleSpawn queues over-cap requests, and
    // runSpawn reserves its slot via incInFlight before reaching here), so opening cannot exceed it.
    // (If a reconcile race evicted the record, ensureWorkersOpen's self-heal re-opens it.)
    if (worker) useRuntimeStore.getState().open(workerId);
    // Reply with the AUTHORITATIVE identity spawnWorker captured from the worktree cut — do NOT
    // re-derive branch/worktree from the store lookup above. That record can be concurrently mutated
    // (worktreePath reset to null on relocation, or rebuilt by a cross-window reconcile) between the
    // await resolving and this read, which would silently yield empty branch/worktree and trip the
    // MCP client's "malformed reply" guard (sparkle-yk3x). The spawnWorker return is always correct.
    await respond(req.reqId, { workerId, branch, worktree });
  } catch (e) {
    await respond(req.reqId, { error: errMsg(e) });
  } finally {
    // Release the reservation and let a queued spawn proceed — including after a FAILED spawn,
    // whose freed slot would otherwise wait for the next spin_down / store change to drain.
    decInFlight(req.projectId, req.buildAgentId);
    void drainQueue();
  }
}

function handleSpawn(req: OrchestrationRequest): void {
  const cap = useSettingsStore.getState().maxConcurrentWorkers;
  if (usedSlots(req.projectId, req.buildAgentId) >= cap) {
    spawnQueue.push(req); // over cap → defer the reply until a slot frees
    return;
  }
  // runSpawn reserves the slot synchronously at its first line, so firing it (not awaiting) is
  // enough for the next synchronous event to see the reservation.
  void runSpawn(req);
}

/** Re-adopt workers whose worktree + on-disk manifest survive but whose in-memory projectStore
 *  record was evicted by a reconcile/relocation/cross-window race (sparkle-3xus). Scans each
 *  project's worktrees for `.sparkle/worker.json` manifests; for any manifest whose parent build
 *  agent still exists but whose worker record was lost, it re-inserts the worker under the
 *  manifest's buildAgentId — the self-heal that makes an evicted record recover WITHOUT an app
 *  restart. Best-effort and idempotent: an already-present worker is skipped; a manifest whose
 *  build agent is gone is skipped (don't resurrect a worker for a closed orchestrator); a failed
 *  scan of one project never blocks the others. Returns the number of workers adopted. Exported as
 *  the callable repair path and run on listener start. */
export async function reconcileWorkersFromDisk(projectId?: string): Promise<number> {
  const initial = useProjectStore.getState().projects;
  const targets = projectId ? initial.filter((p) => p.id === projectId) : initial;
  let adopted = 0;
  for (const target of targets) {
    let manifests: WorkerManifest[];
    try {
      manifests = await scanWorkerManifests(target.id);
    } catch (e) {
      // A backend scan failure (e.g. app-data unavailable) must not break list/spin_down — the
      // in-memory store still answers; disk reconcile just doesn't augment it this pass.
      console.warn("[orchestration] scanWorkerManifests failed", target.id, e);
      continue;
    }
    for (const m of manifests) {
      if (!m || !m.workerId || !m.buildAgentId || !m.worktree) continue;
      // Re-read fresh each iteration — an earlier adopt in this loop already mutated the store.
      const project = useProjectStore.getState().projects.find((p) => p.id === target.id);
      if (!project) continue;
      if (project.agents.some((a) => a.id === m.workerId)) continue; // record already present
      // Never re-adopt a worker whose row was just closed but whose worktree/manifest is still being
      // reaped in the background (spinDownWorker tombstones it): the record is gone from `agents` and
      // the manifest hasn't been deleted YET, which is exactly the shape this loop would otherwise
      // treat as an evicted worker to restore — resurrecting the row the user just closed.
      if (isWorkerTearingDown(m.workerId)) continue;
      // Only adopt under a build agent that still exists: never resurrect a worker whose
      // orchestrator was deliberately closed (that worktree is orphaned — a separate concern).
      if (!project.agents.some((a) => a.id === m.buildAgentId)) continue;
      useProjectStore.getState().adoptWorker(target.id, {
        id: m.workerId,
        parentId: m.buildAgentId,
        branch: m.branch || null,
        worktreePath: m.worktree,
        task: m.task,
        beadId: m.beadId,
      });
      adopted++;
    }
  }
  return adopted;
}

async function handleList(req: OrchestrationRequest): Promise<void> {
  try {
    // Self-heal first: re-adopt any of this build agent's workers whose store record was evicted
    // but whose worktree+manifest survive on disk, so the list reflects disk truth, not just the
    // (possibly-corrupted) in-memory store (sparkle-3xus).
    await reconcileWorkersFromDisk(req.projectId);
    const project = useProjectStore.getState().projects.find((p) => p.id === req.projectId);
    const workers = (project?.agents ?? [])
      .filter((a) => a.kind === "worker" && a.parentId === req.buildAgentId)
      .map((a) => ({
        workerId: a.id,
        branch: a.branch ?? "",
        worktree: a.worktreePath ?? "",
        status: workerStatus(a.id),
      }));
    await respond(req.reqId, { workers });
  } catch (e) {
    // Every dispatch path MUST reply exactly once — a thrown store read would otherwise leave the
    // bridge blocked for its full 600s timeout.
    await respond(req.reqId, { error: errMsg(e) });
  }
}

async function handleSpinDown(req: OrchestrationRequest): Promise<void> {
  const workerId = req.payload.workerId ?? "";
  // Consult disk before deciding ownership: an evicted in-memory record would otherwise be
  // (wrongly) reported "not owned by this build agent" even though its manifest — under THIS
  // buildAgentId — still exists on disk. Reconcile re-adopts it so the check below passes and the
  // worktree is actually torn down (sparkle-3xus).
  await reconcileWorkersFromDisk(req.projectId);
  const project = useProjectStore.getState().projects.find((p) => p.id === req.projectId);
  const worker = project?.agents.find((a) => a.id === workerId);
  // Bound to the build agent's OWN workers — reject any cross-agent target.
  if (!worker || worker.kind !== "worker" || worker.parentId !== req.buildAgentId) {
    await respond(req.reqId, { error: "worker not owned by this build agent" });
    return;
  }
  try {
    await spinDownWorker({ projectId: req.projectId, workerId });
    await respond(req.reqId, { spunDown: true });
  } catch (e) {
    await respond(req.reqId, { error: errMsg(e) });
  } finally {
    void drainQueue();
  }
}

/** Release queued spawns whose build agent has a free slot. Cheap no-op when the queue is empty
 *  (called on every store change), so it is safe to wire to a broad subscription. Concurrent callers
 *  are safe: each splice + runSpawn reservation is synchronous, so a second drain sees the updated
 *  queue and inFlight before it can act.
 *
 *  Scans for the first ELIGIBLE request rather than bailing on the head: the queue is shared across
 *  every build agent (global singleton), so a head request whose agent is still at cap must not
 *  starve a later request belonging to a different agent that has a free slot. */
async function drainQueue(): Promise<void> {
  for (;;) {
    const cap = useSettingsStore.getState().maxConcurrentWorkers;
    const idx = spawnQueue.findIndex((r) => usedSlots(r.projectId, r.buildAgentId) < cap);
    if (idx === -1) return; // no queued request has a free slot
    const [next] = spawnQueue.splice(idx, 1);
    await runSpawn(next!);
  }
}

/** Self-healing invariant: re-open any worker that was spawned + had its worktree cut but is no
 *  longer live (not in openAgentIds, no PTY status). runSpawn open()s a worker exactly once at spawn;
 *  if a reconcile()/remount race then evicts it from the cross-window-shared openAgentIds before its
 *  pane mounts, that one-shot is silently undone and the worker strands behind "Start this agent",
 *  blocking its orchestrator with no signal. Re-asserting open() converges the system back to "every
 *  materialized worker is live", regardless of which race evicted it. Opening is idempotent and
 *  bounded — once re-opened the worker has a status entry, so it isn't re-opened again (and the
 *  per-build-agent cap already counts these workers, so this can't exceed it). */
function ensureWorkersOpen(): void {
  const { projects } = useProjectStore.getState();
  const rt = useRuntimeStore.getState();
  const openIds = new Set(rt.openAgentIds);
  for (const project of projects) {
    for (const worker of workersNeedingOpen(project.agents, rt.status, openIds)) {
      // A worker mid-teardown (× just closed it; manifest still being reaped) can momentarily still
      // look "stranded" — in the roster, not open, no status — before removeAgent has fully
      // propagated. Re-opening it here is what resurrected the just-closed row; skip tombstoned ids.
      if (isWorkerTearingDown(worker.id)) {
        console.debug("[orchestration] skip re-open of tearing-down worker", worker.id);
        continue;
      }
      console.debug("[orchestration] re-opening stranded worker", worker.id);
      rt.open(worker.id);
      openIds.add(worker.id); // keep the local view current so a strand isn't opened twice
    }
  }
}

// True while the listener is started; a heal microtask scheduled just before teardown bails on it.
let listenerLive = false;
let healPending = false;
/** Run ensureWorkersOpen on a microtask, coalescing a burst of store changes into one pass. The
 *  deferral is load-bearing: it observes the END of the current synchronous store-mutation batch, so
 *  it can tell a reconcile EVICTION (the worker stays in `agents` → re-open it) apart from a TEARDOWN
 *  (spin_down / project relocation call close() THEN removeAgent() synchronously → by the microtask
 *  the worker is gone from `agents` → leave it alone). A synchronous heal would instead race the
 *  close() notification and re-open a worker that's being removed, leaking a ghost id into
 *  openAgentIds on every spin-down. The deferral also removes the open()→notify→heal re-entrancy. */
function scheduleEnsureWorkersOpen(): void {
  if (healPending) return;
  healPending = true;
  queueMicrotask(() => {
    healPending = false;
    if (listenerLive) ensureWorkersOpen();
  });
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function dispatch(req: OrchestrationRequest): void {
  switch (req.op) {
    case "spawn_worker":
      handleSpawn(req);
      break;
    case "list_workers":
      void handleList(req);
      break;
    case "spin_down":
      void handleSpinDown(req);
      break;
    default:
      void respond(req.reqId, { error: `unknown op ${(req as OrchestrationRequest).op}` });
  }
}

/** Tear down the listener: unsubscribe, unblock every still-queued request (so mid-session cleanup
 *  / HMR doesn't strand them for the bridge's 600s timeout), and reset all module state. */
function teardown(): void {
  // safeUnlisten swallows the Tauri teardown race (window close / HMR tearing down the listeners
  // map) so cleanup can't surface as an unhandled rejection.
  listenerLive = false; // a heal microtask already queued will see this and bail
  void safeUnlisten(unlisten);
  unlisten = undefined;
  unsubStore?.();
  unsubStore = undefined;
  unsubRuntime?.();
  unsubRuntime = undefined;
  for (const req of spawnQueue) {
    void respond(req.reqId, { error: "orchestration listener stopped" });
  }
  spawnQueue.length = 0;
  inFlight.clear();
  startPromise = undefined; // allow a fresh start after cleanup
}

async function doStart(): Promise<() => void> {
  unlisten = await listen<OrchestrationRequest>(EVENT, (event) => dispatch(event.payload));
  // A projectStore change can mean a worker left (spin_down → free a capped slot → drainQueue) or a
  // worker's worktree just got cut (→ ensure it's open). Both run on every change.
  listenerLive = true;
  unsubStore = useProjectStore.subscribe(() => {
    void drainQueue();
    scheduleEnsureWorkersOpen();
  });
  // The eviction that strands a worker mutates runtimeStore.openAgentIds, NOT projectStore — so the
  // projectStore subscription alone would miss it. Re-assert the self-healing invariant whenever the
  // open set changes (gated to that slice so frequent status/branch ticks don't trigger a re-scan).
  let prevOpen = useRuntimeStore.getState().openAgentIds;
  unsubRuntime = useRuntimeStore.subscribe((s) => {
    if (s.openAgentIds === prevOpen) return;
    prevOpen = s.openAgentIds;
    scheduleEnsureWorkersOpen();
  });
  scheduleEnsureWorkersOpen(); // heal anything already stranded when the listener (re)starts
  // Re-adopt from disk any workers whose in-memory record was lost before this listener started
  // (e.g. a crash/restart mid-spawn): the manifest-backed self-heal, fire-and-forget so a slow or
  // failing scan can't delay listener startup (sparkle-3xus).
  void reconcileWorkersFromDisk().catch((e) =>
    console.warn("[orchestration] startup reconcile failed", e),
  );
  return teardown;
}

/** Start the singleton orchestration listener. Idempotent and race-safe: every call while running
 *  shares one start promise, so the listener is registered exactly once. Resolves to a cleanup fn
 *  that unsubscribes, drains/errors the queue, and resets state. If the start itself fails (e.g.
 *  the Tauri event bus is transiently unavailable), the guard is cleared so the caller can retry. */
export function startOrchestrationListener(): Promise<() => void> {
  if (startPromise) return startPromise;
  startPromise = doStart().catch((e: unknown) => {
    startPromise = undefined; // allow a retry after a transient init failure
    throw e;
  });
  return startPromise;
}
