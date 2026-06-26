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
import { spawnWorker, spinDownWorker } from "./workerSpawn";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useSettingsStore } from "../stores/settingsStore";

const EVENT = "orchestration:request";

export interface OrchestrationRequest {
  reqId: string;
  op: "spawn_worker" | "list_workers" | "spin_down";
  buildAgentId: string;
  projectId: string;
  payload: { task?: string; workerId?: string };
}

let unlisten: UnlistenFn | undefined;
let unsubStore: (() => void) | undefined;
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
    const workerId = await spawnWorker({
      projectId: req.projectId,
      parentAgentId: req.buildAgentId,
      task: req.payload.task ?? "",
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
    if (worker) useRuntimeStore.getState().open(workerId);
    await respond(req.reqId, {
      workerId,
      branch: worker?.branch ?? "",
      worktree: worker?.worktreePath ?? "",
    });
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

async function handleList(req: OrchestrationRequest): Promise<void> {
  try {
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
  unlisten?.();
  unlisten = undefined;
  unsubStore?.();
  unsubStore = undefined;
  for (const req of spawnQueue) {
    void respond(req.reqId, { error: "orchestration listener stopped" });
  }
  spawnQueue.length = 0;
  inFlight.clear();
  startPromise = undefined; // allow a fresh start after cleanup
}

async function doStart(): Promise<() => void> {
  unlisten = await listen<OrchestrationRequest>(EVENT, (event) => dispatch(event.payload));
  // A worker leaving the store (spin_down, or a human closing a tab) may free a capped slot.
  unsubStore = useProjectStore.subscribe(() => void drainQueue());
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
