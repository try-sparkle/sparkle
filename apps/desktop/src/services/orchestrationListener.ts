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
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { safeUnlisten } from "./safeUnlisten";
import { shouldHandleInThisWindow } from "./windowOwnership";
import { findWindowForProject, clearWindowProject } from "./windowRegistry";
import { spawnWorker, spinDownWorker } from "./workerSpawn";
import { startWorkerAutosave, stopWorkerAutosave } from "./workerAutosave";
import { scanWorkerManifests, type WorkerManifest } from "./worktree";
import { parseWorkerResult } from "./buildAgent";
import { useProjectStore, isLocallyRemoved } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import type { AgentTabStatus } from "../types";
import { useSettingsStore, enforcedWorkerCap } from "../stores/settingsStore";
import { currentMemoryAdmission } from "./memoryAdmission";
import { workersNeedingOpen, isNotYetLiveWorker } from "../engine/workerAttention";

const EVENT = "orchestration:request";

export interface OrchestrationRequest {
  reqId: string;
  op: "spawn_worker" | "list_workers" | "spin_down";
  buildAgentId: string;
  projectId: string;
  // `goal` is the worker's objectively verifiable completion criterion; `goalOverrideReason` is the
  // recorded absence of one (see mcp-orchestrator/src/goalGate.ts). Both are forwarded by
  // bridge.rs's `frontend_op_payload`; exactly one of them is present on a spawn that passed the gate.
  payload: {
    task?: string;
    workerId?: string;
    beadId?: string;
    goal?: string;
    goalOverrideReason?: string;
  };
}

let unlisten: UnlistenFn | undefined;
let unsubStore: (() => void) | undefined;
let unsubRuntime: (() => void) | undefined;
// Single-flight start guard: a promise shared by every caller so two concurrent first-callers can't
// both register a listener (which would double-dispatch every event → doubled spawns). Reset by
// cleanup so a later start (e.g. after HMR) can re-arm.
let startPromise: Promise<() => void> | undefined;
// spawn_worker requests deferred because the machine is at its concurrency cap. Released by
// drainQueue() whenever a worker slot frees (a spin_down, a failed/finished spawn, or a store change).
const spawnQueue: OrchestrationRequest[] = [];
// When each queued request was deferred, keyed by reqId. Cleared at every removal site.
const queuedAt = new Map<string, number>();
// How long a spawn may sit queued before we stop honouring it.
//
// MUST stay BELOW the MCP client's socket timeout (`DEFAULT_TIMEOUT_MS = 660_000` in
// apps/mcp-orchestrator/src/bridgeClient.ts). Before this existed, an over-cap request outlived its
// caller: the client gave up at 660s and destroyed the socket, but NOTHING here noticed — the entry
// stayed queued and `drainQueue` created the worker minutes later, for a caller that had already
// been told the spawn failed. That worker is absent from the orchestrator's registry, so the
// orchestrator re-spawns the unit and gets a DUPLICATE worktree + branch doing the same work — the
// most expensive recurring failure AGENTS.md names, and un-deduplicated for an ad-hoc (no-bead)
// spawn, which `handleSpawn` deliberately does not claim (roborev 56186, High).
//
// Expiring UNDER the client timeout (not over it) is what makes the persona's rule true: the caller
// receives a real `{ error }` reply instead of a socket timeout, and the unit genuinely did not
// start — so "an error means it did not start, re-spawn it" is sound advice for THAT reply.
//
// The budget has to clear the SWEEP GRANULARITY, not just the deadline (roborev 56222). Delivery on
// a quiet store comes from the reap tick, which is anchored to listener start rather than to enqueue
// — so an entry queued just after a tick expires on time but is not swept for up to another
// REAP_INTERVAL_MS, and `respond` then adds its own round trip. At 600_000 that was a dead heat with
// the 660s socket: 600 + 60 = 660 exactly, leaving nothing for the reply itself. The invariant is
// `SPAWN_QUEUE_MAX_WAIT_MS + REAP_INTERVAL_MS < DEFAULT_TIMEOUT_MS`, with real headroom — pinned by
// orchestrationListener.bridgeBound.test.ts, which reads the bridge's own constant rather than
// trusting a copy of it (the agentBrief.bridgeBound.test.ts pattern, and for the same reason: a
// copied number is exactly what drifts).
//
// The cost of the lower value is 60s of legitimate queue time. That is the right trade: a spawn that
// has waited nine minutes for a slot is not about to get one, and an ambiguous socket timeout is far
// more expensive than an early honest error — it forces the orchestrator into the "did it start?"
// branch, which is where duplicate workers come from.
export const SPAWN_QUEUE_MAX_WAIT_MS = 540_000;
// Synchronous reservation count keyed by `${projectId}:${buildAgentId}`. spawnWorker is async and
// the store's worker count only rises once it resolves, so a cap check on liveWorkerCount alone
// would let concurrent spawn_worker events (and concurrent drainQueue passes) ALL read the
// pre-spawn count and over-spawn past the cap. Reserving a slot synchronously — before the first
// await — closes that window.
const inFlight = new Map<string, number>();

function flightKey(projectId: string, buildAgentId: string): string {
  return `${projectId}:${buildAgentId}`;
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

// ── bead claims ──────────────────────────────────────────────────────────────────────────────────
// Which work UNITS this process has accepted a spawn for but not yet materialized as a worker
// record. Keyed `${projectId}\0${buildAgentId}\0${beadId}`.
//
// Why this exists: a restart re-dispatched already-claimed units — five agents independently
// solving one P0, two more duplicating other work. `beadId` was threaded end-to-end (MCP → bridge →
// listener → store → disk manifest) and never COMPARED; every occurrence in the spawn path was an
// assignment. An idempotency guard existed for `workerId`, but none for the bead.
//
// The store alone cannot close this: `runSpawn` awaits `spawnWorker`, so a second request arriving
// in the same tick sees no worker record yet and passes a store-only check — exactly the burst a
// restart produces. So the claim is taken SYNCHRONOUSLY at accept time, mirroring `incInFlight`.
//
// Taken in `handleSpawn` (which covers the QUEUED path too — `drainQueue` calls `runSpawn`
// directly, so a claim released before queueing would let a duplicate slip in behind it) and
// released in `runSpawn`'s finally. Releasing on completion is deliberate: by then either a worker
// record exists (and the store check below catches duplicates) or the spawn failed (and a genuine
// retry must be possible). This is a claim, never a tombstone.
const claimedBeads = new Set<string>();

function beadKey(projectId: string, buildAgentId: string, beadId: string): string {
  return `${projectId}\u0000${buildAgentId}\u0000${beadId}`;
}

/** The live worker already carrying `beadId` for this build agent, or undefined. Scoped per
 *  orchestrator on purpose: two different build agents working the same bead is a higher-level
 *  coordination question, not something this transport-level guard should silently collapse. */
function workerForBead(
  projectId: string,
  buildAgentId: string,
  beadId: string,
): { workerId: string; branch: string; worktree: string } | undefined {
  const project = useProjectStore.getState().projects.find((p) => p.id === projectId);
  const hit = project?.agents.find(
    (a) => a.kind === "worker" && a.parentId === buildAgentId && a.beadId === beadId,
  );
  return hit
    ? { workerId: hit.id, branch: hit.branch ?? "", worktree: hit.worktreePath ?? "" }
    : undefined;
}

function releaseBeadClaim(req: OrchestrationRequest): void {
  const beadId = req.payload.beadId;
  if (beadId) claimedBeads.delete(beadKey(req.projectId, req.buildAgentId, beadId));
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
      queuedAt.delete(dropped!.reqId);
      // Release the bead claim with the request. A QUEUED request holds its claim (taken in
      // handleSpawn, released in runSpawn's finally) — but a dropped request never reaches
      // runSpawn, so without this the key leaks permanently in a module-level Set. A build agent
      // id can be reincarnated, and the reincarnation's legitimate spawn for that same bead would
      // then be refused as "already being spawned" with no worker and nothing in flight: the exact
      // cannot-re-dispatch-a-freed-unit failure the claim is designed to avoid. (roborev 41945)
      releaseBeadClaim(dropped!);
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

/** Every worker on the MACHINE: all projects, all build agents, plus all in-flight reservations.
 *
 *  `effectiveMaxConcurrentWorkers` is derived from the MACHINE's hardware — `min(what its RAM
 *  holds, cores x AGENTS_PER_CORE)`, see `config.rs auto_concurrency_bound` — so it is a
 *  machine-wide budget and has to be compared against a machine-wide count. Comparing it per
 *  build agent is a dimensional error: every agent sits happily under the cap while N agents put
 *  N x the cap on one machine. On a 32 GiB Mac the RAM side derives (32-6) GiB / 1.5 GiB = 17, so
 *  three build agents at a per-agent cap of 8 would legally run 24 workers on a machine budgeted
 *  for 17 — the coalition blowup in sparkle-hfhs, and the same arithmetic behind the original
 *  jetsam incident. (The RAM divisor is `agent_ram_budget_mb`, a measured working set, NOT
 *  `agent_heap_mb`; dividing by the heap ceiling over-reserved by ~6x.) */
function globalUsedSlots(): number {
  const live = useProjectStore
    .getState()
    .projects.reduce((n, p) => n + p.agents.filter((a) => a.kind === "worker").length, 0);
  let flight = 0;
  for (const n of inFlight.values()) flight += n;
  return live + flight;
}

/** True when a spawn must wait. ONE limit, MACHINE-WIDE: every worker on the box counted against
 *  `enforcedWorkerCap`. `[workers].max_concurrent` is a machine-wide ceiling, ratified 2026-07-30
 *  (bead `sparkle-axtkw`) — see `globalGateBinds` for why this is one gate and not two. */
function atCapacity(): boolean {
  return globalGateBinds();
}

/** True when the machine-wide gate binds. The ONLY concurrency gate for worker spawns, and shared
 *  with the on-cap reaper trigger so the two can't drift.
 *
 *  ### Why `enforcedWorkerCap` and NOT `machineMaxConcurrentWorkers`
 *
 *  This is the trap. `components/WorkerLimitControl.tsx` uses `machineMaxConcurrentWorkers` for its
 *  slider TRACK, for a good reason (roborev 55027): `effective` is already clamped by the user's own
 *  pin, and dragging the slider PERSISTS a pin, so a track derived from it ratchets DOWN and never
 *  back up. That precedent is easy to find and **must not be applied here**. A track and a gate want
 *  opposite numbers: the track wants the pin-INDEPENDENT hardware ceiling so the control can always
 *  reach the machine's real range; the gate wants the pin-DEPENDENT enforced number, because
 *  honouring the pin is the entire point of the pin. Switching this expression to
 *  `machineMaxConcurrentWorkers` would make a pin stop capping — pinning 2 on a 36-capable Mac would
 *  admit 36 — i.e. a cap that silently stops capping. That is not theoretical: on 2026-07-30 ~68
 *  concurrent agents hit the macOS per-process file-descriptor ceiling of 256.
 *
 *  ### Why one gate, not a per-agent one as well
 *
 *  There used to be a second, per-build-agent branch here. It could never bind first:
 *  `hydrateFromConfig` sets `maxConcurrentWorkers = pinned ?? derived` and `effective = pinned ===
 *  null ? derived : min(pinned, derived)`, so `enforcedWorkerCap(s) === effectiveMaxConcurrentWorkers`
 *  identically in every hydrated state (pinned by `settingsStore.test.ts`), while
 *  `usedSlots(oneAgent) <= globalUsedSlots()` always. Same threshold, smaller count — dead code
 *  wearing the costume of a safeguard, and the two gates' comments contradicted each other about
 *  what the setting MEANT (roborev 55068).
 *
 *  ### It counts WORKERS ONLY — which does not match `localAgentCapacity`
 *
 *  `globalUsedSlots()` counts `kind === "worker"`. `services/agentCapacity.localAgentCapacity` — the
 *  reading the UI and the concierge quote — counts build agents AND workers, because a build agent
 *  runs its own Claude Code with its own V8 heap and costs what a worker costs. Same threshold,
 *  different populations, and the difference is UNRESOLVED rather than deliberate (roborev 56166,
 *  bead `sparkle-dv65b`): with `max_concurrent = 4`, 3 build agents and 1 worker live, this gate sees
 *  1 of 4 and admits 3 more workers — 7 model processes on a machine budgeted for 4. The RAM
 *  derivation divides the machine by a per-AGENT budget, so excluding build agents under-counts
 *  against the very budget the number came from. Left as-is here only because widening it is a
 *  capacity change beyond this ratification, not because it is right.
 *
 *  Taking the min rather than `effectiveMaxConcurrentWorkers` also keeps this strictly TIGHTER than
 *  the two-gate version it replaces: in the few hundred ms between `setMaxConcurrentWorkers` and the
 *  `config-changed` re-hydrate the pin can sit below `effective`, and this clamps down to it. This
 *  change can only ever refuse a spawn the old pair would have allowed, never admit one they refused.
 *
 *  If a genuine per-agent limit is ever wanted ("no single orchestrator monopolises the box"), it
 *  needs its OWN key — e.g. `[workers].max_per_agent` — because one key cannot carry both dimensions.
 *  That ambiguity is the defect this ratification closes; do not re-overload this one. */
function globalGateBinds(): boolean {
  const staticCap = Math.max(1, enforcedWorkerCap(useSettingsStore.getState()));
  const admission = currentMemoryAdmission();

  // ── THE RUNTIME NARROWING REACHES WORKER SPAWNS TOO (roborev 68367, High) ────────────────────
  //
  // Until this, the static `enforcedWorkerCap` was the ONLY thing this gate compared against, so
  // every runtime measurement — the pre-existing memory narrowing and the run-queue bound alike —
  // was invisible to the one gate that admits workers. `localAgentCapacity` consulted it; this did
  // not. That mattered because the 69 concurrent model processes in the measurement behind
  // `Bound::Load` WERE orchestrator workers: the gate that could have refused them was the gate
  // reading a number computed once at startup from hardware.
  //
  // STRICTLY TIGHTER, NEVER LOOSER — the same one-directional contract the Rust side and
  // `localAgentCapacity` are built on. `Math.min` against `staticCap` means a backend bug, a version
  // skew or a tampered payload cannot RAISE a ceiling that exists to stop the machine being
  // jetsam-killed; and an absent, stale or unsampled reading leaves this expression byte-for-byte
  // what it was before. An unmeasured machine is not a squeezed one.
  if (!admission || !admission.sampled) return globalUsedSlots() >= staticCap;

  // A SATURATED RUN QUEUE REFUSES OUTRIGHT rather than through the count, and the asymmetry with the
  // memory bounds is deliberate. The memory dimensions are QUANTITIES: `effective` is a genuine
  // "this many fit", so comparing a count against it is meaningful. `Bound::Load` is a RATE, and its
  // `effective` is `in_use` plus a trickle — counted over a DIFFERENT population than
  // `globalUsedSlots()` (which counts `kind === "worker"` only; see the unresolved mismatch
  // documented above and in bead `sparkle-dv65b`). Comparing a worker-only count against a
  // whole-fleet `in_use` would silently under-bind — 40 workers against an `in_use` of 69 admits
  // more workers onto a machine at 21.5x per-core load, which is the exact spawn this bound exists
  // to refuse. So the run queue's verdict is read off the DIMENSION rather than off two counts that
  // do not mean the same thing.
  //
  // WHICH VERDICT, THOUGH — and reading it as an unconditional "no more" was half of bead
  // `sparkle-e57k99.1`. `> 0` refuses every worker but the first from the moment per-core load
  // crosses 2.0x, and this machine's NORMAL band with a healthy fleet is 2.6x-5.9x, so the gate was
  // shut essentially always: one worker machine-wide, on a box whose static ceiling is 81. The
  // dimension now distinguishes two regimes and this must not flatten them back. `load_headroom`
  // is what separates them and it arrives ON THE WIRE, stated by the side that owns the threshold:
  // above zero is a THROTTLE (the fleet may still grow, one per sample), zero is the HARD STOP.
  //
  // Deliberately NOT re-derived here as `effective` minus some count of this module's own: every
  // count on this side is a different population than the `in_use` the ceiling was built on — this
  // gate's is workers only — and spending a whole-fleet allowance against a worker-only count is the
  // dimensional error the paragraph above warns about. An absent field reads as 0, i.e. refuses.
  //
  // `globalUsedSlots() > 0` keeps the "you can always start the first one" floor that
  // `load_narrowed` establishes on the Rust side: a loaded-but-worker-less box still admits one, so
  // a busy machine can never present as an app that refuses everything.
  if (admission.bound === "load") {
    if ((admission.load_headroom ?? 0) <= 0) return globalUsedSlots() > 0;
    // Throttling, not stopping: the run queue has no worker-denominated ceiling to offer here, so
    // the static cap governs and the queue's opinion is carried by the basis sentence a refusal
    // quotes.
    return globalUsedSlots() >= staticCap;
  }

  const narrowed = Math.max(1, Math.min(staticCap, Math.floor(admission.effective)));
  return globalUsedSlots() >= narrowed;
}

/** Status token surfaced by list_workers: the terminal completion VERDICT when the worker has
 *  finished, otherwise its live TAB state. A superset of the two terminal verdicts plus every
 *  `AgentTabStatus` the orchestrator might need to tell a busy worker from a stuck one. */
export type WorkerStatus = "running" | "done" | "failed" | AgentTabStatus;

/** Status for list_workers, layering TWO independent facts so an orchestrator can act on both:
 *
 *  1. COMPLETION — derived from the SAME authoritative fact wait_for_workers blocks on: the worker's
 *     `<worktree>/.sparkle/result.json` (read_result → read_worker_result_at). `resultRaw` is that
 *     file's contents, or null/undefined when it is absent or unreadable.
 *       - result present, status "failed"            → "failed"
 *       - result present, status "success"/"partial" → "done"
 *
 *     The coarse live TAB status is deliberately NOT the completion verdict. `statusRouter` marks a
 *     worker "done" the instant a Claude turn ENDS (Stop hook / screen scraper) — but a turn ending
 *     is not process exit, not a commit, and not result.json: the process can still be live with
 *     uncommitted edits and zero commits. Reporting that worker "done" licensed the orchestrator's
 *     merge → spin_down loop to land a branch with NO commits and then DELETE a live worker's
 *     worktree mid-edit (sparkle-7kra). So **absence of a valid result.json can NEVER read "done" or
 *     "failed"** — that gate is preserved verbatim.
 *
 *  2. LIVENESS — when the worker has NOT completed (no valid result.json), the old code flattened
 *     every live state to "running". That is the sparkle-0an0 bug: an orchestrator polling
 *     list_workers then could not tell a worker mid-cargo-test from one blocked on a session limit,
 *     waiting on an on-screen prompt, or awaiting approval — so a `waiting` worker whose PR sat green
 *     and mergeable read as `running` and its work was stranded. So instead of flattening, we surface
 *     the live TAB status (`working` | `idle` | `waiting` | `approval` | `blocked` | …) VERBATIM,
 *     with two guards that keep the 7kra invariant intact:
 *       - The live TAB status `"done"` is remapped to `"idle"` (turn ended, nothing landed): a
 *         result-less worker must never surface the terminal `"done"` token this way. `"failed"` is
 *         not an `AgentTabStatus` (the runtime crash state is `"errored"`), so no such collision
 *         exists on the failure side.
 *       - No known live status → "running" — we know only that it has not completed. */
function workerStatus(
  resultRaw: string | null | undefined,
  liveStatus: AgentTabStatus | undefined,
): WorkerStatus {
  if (resultRaw != null) {
    try {
      return parseWorkerResult(resultRaw).status === "failed" ? "failed" : "done";
    } catch {
      // The file exists but is not a valid result yet (e.g. a partial write caught mid-flush). An
      // invalid completion record is NOT completion → fall through to the live-status path rather
      // than declare a false terminal that could license a premature spin_down.
    }
  }
  // No valid result.json → the worker has NOT completed. Surface its live state so a stalled worker
  // is distinguishable from a busy one, but never emit a terminal verdict from here (sparkle-7kra).
  if (liveStatus === undefined) return "running";
  if (liveStatus === "done") return "idle"; // turn ended, nothing landed — NOT the terminal "done"
  return liveStatus;
}

/** Has this worker reported a terminal result AND kept going anyway? (sparkle-xdilh)
 *
 *  `workerStatus` above deliberately lets the result.json verdict SHADOW the live tab status: once
 *  the file exists the row reads "done"/"failed" and the worker's liveness stops being reported at
 *  all. That is right for the verdict — but it means `list_workers` cannot express the one state
 *  that burns an orchestrator: a worker that wrote its result, was waited on, was merged, and then
 *  carried on taking turns. Observed cost: such a worker independently re-fixed two bugs the
 *  orchestrator was fixing in parallel, producing a duplicate branch that had to be triaged and
 *  discarded — plus a wasted roborev cycle. `wait_for_workers` returning success READS as terminal,
 *  and nothing anywhere told the caller the session was still live.
 *
 *  So report it as its OWN field rather than by bending the status token. The token's meaning is
 *  load-bearing (sparkle-7kra: a result-less worker must never read "done"), and widening it here
 *  would re-open exactly that hole. A separate boolean layers the third fact — liveness AFTER
 *  completion — onto the two the row already carries.
 *
 *  Positive evidence ONLY, and narrow on purpose: `working` means "actively producing output", so
 *  it is the one live status that proves the session is still doing work. `idle`/`waiting` mean the
 *  turn ENDED — the session is up but is not producing anything, which is the normal, harmless
 *  post-result state and must not be flagged. An unknown live status (worker not open in this
 *  window) is not evidence of anything and stays silent. */
export function sessionStillRunning(
  status: WorkerStatus,
  liveStatus: AgentTabStatus | undefined,
): boolean {
  const completed = status === "done" || status === "failed";
  return completed && liveStatus === "working";
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
      // Carried through so the worker's objective is persisted at creation. Absent only when the
      // dispatch used a recorded override (`goalOverrideReason`), which is deliberately NOT
      // substituted in as a goal — an override means there is no criterion, and inventing one from
      // its reason would make an unverifiable worker look verifiable.
      goal: req.payload.goal,
    });
    // Auto-start the worker: opening it adds it to openAgentIds, which mounts its AgentPane and
    // launches the PTY (worker persona + stored task). Without this the orchestrated worker sits
    // idle in the sidebar showing "Start this agent" until a human clicks it — the manual spawn
    // paths in AgentSidebar already call open() for exactly this reason.
    //
    // OPEN THE AUTHORITATIVE id UNCONDITIONALLY — this is the FIRST half of sparkle-ynytw
    // ("verify the session actually started before returning a handle"). `spawnWorker` returns a
    // workerId only AFTER writeWorkerManifest has durably persisted the worker to disk
    // (.sparkle/worker.json — see workerSpawn.ts), so a returned id is PROVEN materialized. The
    // previous guard here re-read the store for the record and skipped open() when it was missing —
    // but the one way it is missing on THIS path is a concurrent reconcile/relocation evicting the
    // in-memory record in the microtask gap after the await (the sparkle-yk3x race). That is exactly
    // the case that MUST launch: the record is durable on disk and reconcileWorkersFromDisk will
    // re-adopt it, but the re-adopted pane only mounts (and the session only takes its first turn)
    // if the id is already in openAgentIds. The old guard instead returned a clean success handle
    // for a worker that never launched — spawn_worker's core defect: a handle with no turn, later
    // reported never_started. The guard's stated fear (a "never-materialized id stranded in
    // openAgentIds") cannot occur on the success path, because a spawnWorker that failed to
    // materialize throws and is caught below, never reaching here with a workerId. The per-build-agent
    // concurrency cap is enforced upstream (handleSpawn queues over-cap requests; runSpawn reserves
    // its slot via incInFlight before reaching here), so opening cannot exceed the bound.
    useRuntimeStore.getState().open(workerId);
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
    // Release the bead claim too. On success the worker record now carries the bead, so
    // `workerForBead` takes over as the guard; on failure the unit becomes dispatchable again.
    releaseBeadClaim(req);
    void drainQueue();
  }
}

function handleSpawn(req: OrchestrationRequest): void {
  // Bead claim guard — BEFORE the cap check, so a duplicate is rejected rather than occupying a
  // queue slot behind the cap. Only applies to bead-identified work: an ad-hoc spawn carries no
  // bead, and collapsing anonymous spawns would silently drop legitimate parallel work — a worse
  // failure than the duplication this prevents.
  const beadId = req.payload.beadId;
  if (beadId) {
    const existing = workerForBead(req.projectId, req.buildAgentId, beadId);
    if (existing) {
      // Idempotent: hand back the worker that already owns this bead. An error here would invite a
      // retry, and a retry is how one unit becomes five.
      //
      // But only when the record is fully addressable. A worker record can be concurrently mutated
      // to a null worktreePath during relocation/reconcile (sparkle-yk3x — the same hazard that
      // stops runSpawn re-reading the store for ITS reply), and an empty branch/worktree trips the
      // MCP client's malformed-reply guard. That surfaces as an error the orchestrator may retry —
      // defeating the idempotency this path exists for. So when the record is mid-relocation we
      // still REFUSE (the claim holds), we just can't name it yet.
      //
      // Mark the reply REUSED. Idempotency is about not spawning twice; it is not a licence to let
      // the caller believe its task was dispatched. This worker is executing the task it was
      // ORIGINALLY spawned with — the task in THIS request was dropped on the floor. Without a
      // marker the reply is byte-indistinguishable from a fresh spawn, so an orchestrator that
      // re-dispatches a bead with a corrected or expanded task reads a successful handle and waits
      // forever on work nobody is doing.
      if (existing.branch && existing.worktree) {
        void respond(req.reqId, { ...existing, reused: true });
      } else {
        void respond(req.reqId, {
          error: `bead ${beadId} is already claimed by worker ${existing.workerId}, whose worktree is not currently resolvable`,
        });
      }
      return;
    }
    const key = beadKey(req.projectId, req.buildAgentId, beadId);
    if (claimedBeads.has(key)) {
      // Accepted but not yet materialized (in flight, or queued behind the cap). We cannot name the
      // worker yet, so say so plainly rather than spawning a second one.
      void respond(req.reqId, {
        error: `a worker for bead ${beadId} is already being spawned for this build agent`,
      });
      return;
    }
    claimedBeads.add(key);
  }
  if (atCapacity()) {
    spawnQueue.push(req); // machine is at its ceiling → defer until a slot frees
    queuedAt.set(req.reqId, reaperNow()); // so it can EXPIRE rather than outlive its caller
    // A spawn blocked by LEAKED machine-wide capacity — orphaned workers from a build agent that
    // departed without spinning them down — would otherwise wait behind dead records forever. Kick a
    // reap so any reclaimable slot frees and drains this request via the store subscription.
    //
    // This used to be guarded by `if (globalGateBinds())`, to skip the scan when only the per-agent
    // gate bound (reclaiming machine-wide orphans could not unblock that case). With one machine-wide
    // gate, reaching here IS `globalGateBinds()` being true, so the guard was a tautology — dropped
    // rather than left to read as a live condition. The grace + single-flight inside
    // reapOrphanedWorkers keep a burst of queued spawns cheap. Fire-and-forget (handleSpawn is sync);
    // it self-throttles, so overlapping triggers are harmless.
    void reapOrphanedWorkers().catch((e) => console.warn("[orchestration] on-cap reap failed", e));
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
  return (await reconcileFromDisk(projectId)).adopted;
}

/** The scan + adopt pass, returning BOTH the adopt count and the manifests it actually read.
 *
 *  Split out so `handleList` can derive each LIVE worker's real branch from the SAME scan it
 *  already pays for (sparkle-ul7cnx). Scanning twice would be wasteful, but the load-bearing
 *  reason is subtler: the scan is one backend round-trip per project, and two of them can observe
 *  two different disks — a worker whose HEAD moved between them would be reported with a branch
 *  that never matched the adoption it was reconciled against. One read, one truth. */
async function reconcileFromDisk(
  projectId?: string,
): Promise<{ adopted: number; manifests: WorkerManifest[] }> {
  const initial = useProjectStore.getState().projects;
  const targets = projectId ? initial.filter((p) => p.id === projectId) : initial;
  let adopted = 0;
  const seen: WorkerManifest[] = [];
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
    seen.push(...manifests.filter((m): m is WorkerManifest => !!m));
    for (const m of manifests) {
      if (!m || !m.workerId || !m.buildAgentId || !m.worktree) continue;
      // Re-read fresh each iteration — an earlier adopt in this loop already mutated the store.
      const project = useProjectStore.getState().projects.find((p) => p.id === target.id);
      if (!project) continue;
      if (project.agents.some((a) => a.id === m.workerId)) continue; // record already present
      // Never re-adopt a worker the user just closed manually: its manifest lingers on disk until
      // the worktree teardown completes, but the tombstone means the row must stay gone
      // (sparkle-close-resurrect). adoptWorker also refuses it — this just skips the wasted work.
      if (isLocallyRemoved(m.workerId)) continue;
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
  return { adopted, manifests: seen };
}

/** What the roster should say a worker's branch is, and — when that CONTRADICTS the name minted at
 *  spawn — the spawn name alongside it (sparkle-ul7cnx / sparkle-m15bfj).
 *
 *  THE DEFECT THIS CLOSES. `agent.branch` is written ONCE, at spawn, and never re-derived. But
 *  AGENTS.md instructs every agent to name its branch for the WORK and never for an agent id, so a
 *  worker doing exactly the right thing cuts `feature/<topic>`, commits there, and leaves the
 *  minted `sparkle/agent-<uuid>` fast-forwarded to its base. The roster then reported the minted
 *  name, `git merge sparkle/agent-<uuid>` answered "Already up to date" and exited 0, and the
 *  orchestrator concluded the worker had produced nothing. Measured: 794 committed lines. Every
 *  step reads exactly like success.
 *
 *  THE HEAD READ IS NOT REPEATED HERE. `head` comes from the manifest scan, whose `branch` the
 *  backend already overwrites with `branch_from_worktree_head` (worktree.rs) — packed refs, a
 *  linked worktree's per-worktree HEAD, and the DETACHED case all handled there. A detached HEAD
 *  has no `ref: refs/heads/` line, so the backend returns the manifest's own value: the spawn name
 *  stands and this function sees no disagreement, which is exactly right. Reporting a raw sha AS a
 *  branch would be a different silent failure — `git merge <sha>` is not what the caller meant.
 *
 *  THE SPAWN NAME IS PRESERVED, NEVER ERASED, and that is load-bearing rather than informational:
 *  `apps/mcp-orchestrator/src/tools.ts` assesses teardown safety on the UNION of both branches, so
 *  a worker whose HEAD sits on an already-landed branch while its spawn branch still holds unlanded
 *  commits must not assess as safe on HEAD alone — that trades a merge which does nothing for a
 *  deletion which loses work. The field name matches `RosterEntry.spawnBranch` there deliberately;
 *  the bridge reply is spread straight into that shape, so it needs no translation and the
 *  `branchNote` sentence is derived from it on the far side.
 *
 *  FILLING IN AN EMPTY SPAWN NAME IS NOT A DISAGREEMENT. There was nothing to contradict, so no
 *  `spawnBranch` is emitted — a warning that fires on ordinary rows stops being read, which is how
 *  the measured incident survived every surface that could have reported it. */
export function deriveReportedBranch(
  spawnName: string | undefined,
  head: string | undefined,
): { branch: string; spawnBranch?: string } {
  const spawn = (spawnName ?? "").trim();
  const h = (head ?? "").trim();
  // "We could not look" and "we looked and it is elsewhere" are different facts. An absent HEAD
  // never overrides — manufacturing certainty from a failed read is the same mistake in the mirror.
  if (!h) return { branch: spawn };
  if (!spawn || h === spawn) return { branch: h };
  return { branch: h, spawnBranch: spawn };
}

// ── reaper: reclaim orphaned workers (the machine-wide cap leak) ───────────────────────────────────
export const REAP_INTERVAL_MS = 60_000;
// Grace: an orphan must be observed orphaned across at least REAP_MIN_OBSERVATIONS passes of ONE
// continuous run AND for at least REAP_GRACE_MS before it is torn down. The listener is per-window and
// `projectStore` syncs across windows through a debounced persist (~400ms) + a 300ms rehydrate
// coalesce, so a single snapshot can momentarily show a worker whose (live) parent build agent hasn't
// propagated yet; reaping on one snapshot could kill a LIVE worker's uncommitted work. Both an
// observation COUNT and an elapsed floor must hold — and "continuous" is enforced: if the gap since a
// worker's last observation exceeds REAP_CONTINUITY_GAP_MS (a suspend or a wall-clock jump), its record
// is reset to a single fresh observation, so the grace can't be satisfied by one snapshot taken right
// after a resume — exactly when rehydrate lag is worst. A genuinely departed orchestrator re-earns the
// grace within a few seconds of sweeps; a blip or a clock jump does not.
export const REAP_GRACE_MS = 30_000;
const REAP_MIN_OBSERVATIONS = 2;
// A gap between two observations larger than this means the process was suspended or the clock jumped,
// so prior observations no longer prove continuous orphanhood — the grace is re-earned from scratch.
const REAP_CONTINUITY_GAP_MS = 2 * REAP_INTERVAL_MS;
let reapTimer: ReturnType<typeof setInterval> | undefined;
// One-shot follow-up scheduled while orphans are still maturing, so a spawn blocked purely by leaked
// capacity is unblocked ~grace later instead of waiting for the next 60s sweep. `graceTimerAt` is its
// absolute target time, so a later pass that computes a SOONER maturity can re-arm rather than being
// dropped by coalescing. Both cleared in teardown.
let graceTimer: ReturnType<typeof setTimeout> | undefined;
let graceTimerAt: number | undefined;
// Single-flight within THIS window: overlapping triggers (startup + interval + on-cap + follow-up)
// collapse to one in-flight pass so we never issue two concurrent spin-downs for the same id.
let reaping = false;
// Set when a trigger arrives while a pass is already running: the running pass computed its candidates
// from an OLDER snapshot, so an orphan (or blocked spawn) that appeared meanwhile would otherwise be
// missed until the 60s sweep. The finishing pass re-runs once to observe the newer state.
let reapRerunRequested = false;
// Bumped by teardown. A pass captures it and stops acting the moment it changes, so an in-flight pass
// cannot keep tearing down worktrees on behalf of a listener that has already been torn down.
let reapGen = 0;
// Injectable so every caller shares ONE clock domain (production = wall clock). Passing a per-call
// `nowMs` previously let a value seeded in one domain be compared against another and silently never
// reap; a single module clock removes that whole class of bug.
let reaperNow: () => number = () => Date.now();
/** Test-only: override the reaper clock so grace timing is deterministic. Call with no argument to
 *  restore the production default, so a test can never leave a stale clock installed. */
export function __setReaperNow(fn?: () => number): void {
  reaperNow = fn ?? (() => Date.now());
}
// workerId → { first: first-observed time, count: observations this continuous run, last: latest
// observation time }. Cleared for any worker no longer orphaned, so a re-orphaning restarts the grace.
const orphanSeen = new Map<string, { first: number; count: number; last: number }>();

/** Arm a follow-up reap to fire at absolute time `targetAt` (the earliest orphan's maturity), so a
 *  still-maturing orphan gets reclaimed as soon as it is eligible rather than up to a full grace late —
 *  and so a leaked-slot spawn isn't left waiting for the 60s sweep. If a timer is already pending it is
 *  KEPT unless `targetAt` is sooner, in which case it is re-armed (so the earliest maturity in a burst
 *  wins, not just the first one seen). Gated on `listenerLive`; cleared in teardown. */
function scheduleGraceFollowup(targetAt: number): void {
  if (!listenerLive) return;
  if (graceTimer !== undefined && graceTimerAt !== undefined && targetAt >= graceTimerAt) return; // pending one is sooner
  if (graceTimer !== undefined) clearTimeout(graceTimer);
  graceTimerAt = targetAt;
  graceTimer = setTimeout(() => {
    graceTimer = undefined;
    graceTimerAt = undefined;
    if (listenerLive) {
      void reapOrphanedWorkers().catch((e) => console.warn("[orchestration] grace-followup reap failed", e));
    }
  }, Math.max(1, targetAt - reaperNow()));
}

/** Reclaim workers stranded by a build agent that is GONE from the store — the machine-wide cap
 *  leak. `globalUsedSlots` counts every `kind:"worker"` record until `removeAgent`, but a build
 *  agent that crashed, was force-quit, or had its bridge die WITHOUT a clean cascading close
 *  (closeBuildAgent) never spun its workers down, so those records (and their worktrees) occupy cap
 *  slots forever. On a 32 GiB Mac the machine-derived `effectiveMaxConcurrentWorkers` is ~17, so a
 *  handful of leaked workers saturate the machine and EVERY build agent's next spawn is refused —
 *  recoverable before this only by a manual cap bump or an app restart (and reconcile even
 *  re-adopts leaked workers across restarts, so the restart didn't reliably help either).
 *
 *  `reconcileWorkersFromDisk` already treats a worker whose parent build agent is gone as
 *  un-adoptable ("orphaned — a separate concern", see the guard in that fn). This IS that concern,
 *  in the REMOVAL direction — the exact inverse condition, so the two can never fight: reconcile
 *  only ADOPTS workers whose parent EXISTS; reap only REMOVES workers whose parent is GONE.
 *
 *  Safety — a worker is torn down ONLY when all of these hold:
 *    - it has a non-empty `parentId` that is absent from the SAME project. A PARENTLESS record
 *      (`parentId` null/empty — `addAgent` defaults it to null) is LEFT ALONE, never reaped: missing
 *      data is treated conservatively, exactly as reconcile skips rather than destroys it.
 *    - it has stayed orphaned across >= REAP_MIN_OBSERVATIONS passes AND for >= REAP_GRACE_MS (see
 *      those constants) — enough to rule out a transient cross-window snapshot where a LIVE parent
 *      simply hadn't propagated yet.
 *    - it is not tombstoned (isLocallyRemoved) — a teardown is already mid-flight.
 *    - a final re-read of the LIVE store right before teardown still shows it orphaned (another
 *      window may have reclaimed it, or its parent may have returned, in the gap).
 *  A worker whose parent still exists — however idle, "done", or duplicated — is left ENTIRELY alone;
 *  reclaiming a live orchestrator's work is never this function's call. `spinDownWorker` KEEPS the
 *  branch, so an orphan's COMMITTED work survives on its branch; only the worktree + dead record are
 *  reclaimed (an orphan still mid-run past the grace is genuinely abandoned — its orchestrator is
 *  gone — so its PTY is killed and only committed work is preserved, same as a clean close).
 *
 *  Single-flight and idempotent. Each `spinDownWorker` drops the record synchronously (removeAgent →
 *  projectStore change → drainQueue), so a spawn blocked purely by leaked capacity proceeds on the
 *  next drain; while orphans are still maturing a one-shot follow-up (`scheduleGraceFollowup`) drives
 *  the eventual reclaim without waiting for the 60s sweep. */
export async function reapOrphanedWorkers(): Promise<number> {
  // No listener running → nothing to reclaim on its behalf. Checked BEFORE the single-flight flag or
  // any `orphanSeen` mutation, so a call that lands after teardown (the fire-and-forget startup chain,
  // a queued microtask / timer / interval whose listener has since stopped) is a clean no-op and can't
  // wedge `reaping`. This is a liveness gate, not an identity one — if a NEW listener has already
  // started (HMR / window re-open), this pass runs under it, which is safe: pass 1 re-reads the live
  // store every time, so its observations are always about the CURRENT state, never stale data. (A
  // captured-generation compare here would be a no-op tautology — pass 1 is synchronous, so there is
  // no yield for the generation to change across; pass 2 is where the gen guard actually earns its keep.)
  if (!listenerLive) return 0;
  // Settle the spawn queue on every reap pass, BEFORE the single-flight guard below — this is a
  // synchronous, idempotent sweep, so it must not be skipped just because another reap is mid-flight.
  //
  // Why it lives here and not only in drainQueue (roborev 56200): drainQueue is driven by
  // projectStore changes / runSpawn's finally / handleSpawn, and a reap pass that reclaims nothing
  // mutates no store. The case the queue exists for is capacity held by leaked worker records that
  // no longer tick the store — exactly the quiet-store case — so relying on drainQueue alone could
  // let the 600s deadline pass and hand the caller the MCP client's raw `bridge request timeout` at
  // 660s instead of the designed capacity error. Hanging it off the reaper puts it on the 60s
  // interval, the on-cap trigger, and the startup pass at once.
  //
  // The duplicate-worker hazard is closed by the drainQueue sweep regardless; this guarantees the
  // ERROR REPLY, which is the premise the orchestrator persona's rule rests on.
  expireStaleQueuedSpawns();
  if (reaping) {
    // A pass is already running and computed its candidates from an OLDER snapshot. Whatever triggered
    // this call (an orphan or a blocked spawn that materialised since) would be missed until the 60s
    // sweep — so ask the finishing pass to re-run once against the newer state.
    reapRerunRequested = true;
    return 0;
  }
  reaping = true;
  const gen = reapGen; // captured for pass 2, which re-checks it around each await (teardown bumps it)
  try {
    const now = reaperNow();
    // Pass 1 — identify current orphans and advance each one's observation record. Collect (don't act
    // yet): spinDownWorker mutates the store, and mutating while iterating this snapshot skips neighbours.
    const candidates: Array<{ projectId: string; workerId: string }> = [];
    const seenNow = new Set<string>();
    let maturing = false;
    let earliestMaturityAt = Infinity; // absolute time the soonest still-maturing orphan becomes reapable
    for (const project of useProjectStore.getState().projects) {
      const agentIds = new Set(project.agents.map((a) => a.id));
      for (const a of project.agents) {
        if (a.kind !== "worker") continue;
        if (!a.parentId) continue; // parentless → conservatively LEFT ALONE (never destroy on missing data)
        if (agentIds.has(a.parentId)) continue; // parent present → not an orphan
        // Record the observation BEFORE the tombstone bail: if an in-flight teardown later fails and
        // its tombstone is acknowledged, the orphan should resume its grace clock, not restart it.
        seenNow.add(a.id);
        const prev = orphanSeen.get(a.id);
        // Continuity: only extend the record when the gap since the last observation is within the
        // window AND non-negative. A gap > window (suspend) OR a BACKWARDS step (`now < prev.last`, e.g.
        // an NTP correction) both break continuity → start over from a single fresh observation, so the
        // grace can't be satisfied by one snapshot right after a resume (when rehydrate lag is worst)
        // and a backwards jump can't strand a future `first` that makes `now - first` perpetually < grace.
        const gap = prev ? now - prev.last : undefined;
        orphanSeen.set(
          a.id,
          prev && gap !== undefined && gap >= 0 && gap <= REAP_CONTINUITY_GAP_MS
            ? { first: prev.first, count: prev.count + 1, last: now }
            : { first: now, count: 1, last: now },
        );
        if (isLocallyRemoved(a.id)) continue; // teardown already in flight → not a reap candidate
        candidates.push({ projectId: project.id, workerId: a.id });
      }
    }
    // Forget anything no longer orphaned so a future re-orphaning restarts its grace from scratch.
    for (const id of [...orphanSeen.keys()]) if (!seenNow.has(id)) orphanSeen.delete(id);

    // Pass 2 — reap only orphans past BOTH grace conditions, re-checking the LIVE store immediately
    // before each teardown (another window / its own teardown may have removed it, or its parent may
    // have returned, in the gap). This shrinks the cross-window double-spin-down race to near-zero;
    // spinDownWorker is also a no-op on an absent record and swallows an already-gone worktree.
    let reaped = 0;
    for (const o of candidates) {
      if (reapGen !== gen) break; // listener torn down mid-pass → stop acting on its behalf
      const seen = orphanSeen.get(o.workerId);
      if (!seen || seen.count < REAP_MIN_OBSERVATIONS || now - seen.first < REAP_GRACE_MS) {
        maturing = true; // needs another observation and/or more elapsed time before it can be reaped
        // Track the ABSOLUTE time it could first become reapable, so the follow-up is armed for the
        // real remaining grace even though arming happens at the END of the pass (after the awaits
        // below). An orphan past grace but SHORT on observations matures only after another pass, so
        // floor its target a short step ahead (not 1ms) to avoid busy-arming.
        const graceAt = (seen?.first ?? now) + REAP_GRACE_MS;
        const observeAt = seen && seen.count < REAP_MIN_OBSERVATIONS ? now + 250 : 0;
        earliestMaturityAt = Math.min(earliestMaturityAt, Math.max(graceAt, observeAt));
        continue;
      }
      const proj = useProjectStore.getState().projects.find((p) => p.id === o.projectId);
      const w = proj?.agents.find((x) => x.id === o.workerId);
      if (!w || w.kind !== "worker") {
        orphanSeen.delete(o.workerId);
        continue; // already gone
      }
      if (w.parentId && proj!.agents.some((x) => x.id === w.parentId)) {
        orphanSeen.delete(o.workerId);
        continue; // parent returned in the gap — no longer an orphan
      }
      if (isLocallyRemoved(o.workerId)) continue; // a teardown started in the gap
      try {
        await spinDownWorker(o); // keeps the branch; tolerates an already-gone worktree
        orphanSeen.delete(o.workerId);
        reaped++;
      } catch (e) {
        console.warn("[orchestration] reapOrphanedWorkers: spinDownWorker failed", o.workerId, e);
      }
    }
    // Drive the eventual reclaim: arm the follow-up for the absolute moment the earliest orphan matures
    // (+50ms slack so a timer that fires a hair early doesn't miss the boundary and re-arm a grace).
    // scheduleGraceFollowup reads a fresh clock at arm time, so the awaits above can't push it late.
    if (maturing && reapGen === gen) scheduleGraceFollowup(earliestMaturityAt + 50);
    if (reaped > 0) console.info(`[orchestration] reaped ${reaped} orphaned worker(s) (parent gone > grace)`);
    return reaped;
  } finally {
    // Only release the single-flight flag if no teardown started a new generation meanwhile; a
    // teardown resets `reaping` itself, and a stale pass must not clobber the live listener's state.
    if (reapGen === gen) {
      reaping = false;
      // A trigger arrived mid-pass (from an older snapshot's blind spot). Re-run once on a microtask
      // against the now-current state so a just-appeared orphan / blocked spawn isn't missed until the
      // 60s sweep. Cleared first so the re-run only fires for triggers received DURING this pass.
      if (reapRerunRequested) {
        reapRerunRequested = false;
        queueMicrotask(() => {
          if (listenerLive) {
            void reapOrphanedWorkers().catch((e) => console.warn("[orchestration] reaper re-run failed", e));
          }
        });
      }
    }
  }
}

async function handleList(req: OrchestrationRequest): Promise<void> {
  try {
    // Self-heal first: re-adopt any of this build agent's workers whose store record was evicted
    // but whose worktree+manifest survive on disk, so the list reflects disk truth, not just the
    // (possibly-corrupted) in-memory store (sparkle-3xus).
    //
    // The manifests come back too, because THIS is the live-roster path and the branch each row
    // reports has to be derived from the worktree's HEAD rather than from the name minted at spawn
    // (sparkle-ul7cnx — see deriveReportedBranch). The reconcile itself SKIPS a worker already
    // present in the store, so without this the fix that landed for evicted/disk-recovered workers
    // reached every row EXCEPT the live ones actually doing the work.
    const { manifests } = await reconcileFromDisk(req.projectId);
    // The manifest scan's `branch` is already HEAD-derived by the backend, keyed by workerId. A
    // worker with no manifest on disk (mid-spawn, worktree gone) simply has no entry, and
    // deriveReportedBranch then leaves the store's name standing.
    const headBranchByWorker = new Map(
      manifests
        .filter((m) => m?.workerId && m.branch)
        .map((m) => [m.workerId, m.branch] as const),
    );
    const project = useProjectStore.getState().projects.find((p) => p.id === req.projectId);
    const agents = (project?.agents ?? []).filter(
      (a) => a.kind === "worker" && a.parentId === req.buildAgentId,
    );
    // Read each worker's authoritative completion fact from disk — the SAME `.sparkle/result.json`
    // wait_for_workers blocks on — before deriving status, so a turn-ended-but-uncommitted worker is
    // never reported "done" (sparkle-7kra). A read failure (worktree gone, backend hiccup, or no
    // worktree path yet) is treated as "no result" → "running", never a false terminal.
    const workers = await Promise.all(
      agents.map(async (a) => {
        // Same backend op wait_for_workers uses (read_result → read_worker_result_at): returns the
        // result.json contents, or null when it is absent. Called directly rather than through
        // pty.readWorkerResult so this service stays off the React/UI module graph.
        const resultRaw = a.worktreePath
          ? await invoke<string | null>("read_worker_result", { worktree: a.worktreePath }).catch(() => null)
          : null;
        // Read once — the verdict and the still-running check must describe the SAME observation.
        const liveStatus = useRuntimeStore.getState().status[a.id];
        const status = workerStatus(resultRaw, liveStatus);
        // The branch an orchestrator would actually merge — HEAD's, not the spawn-time name — with
        // the minted name carried alongside it when the two disagree (sparkle-ul7cnx).
        const derived = deriveReportedBranch(a.branch ?? "", headBranchByWorker.get(a.id));
        return {
          workerId: a.id,
          branch: derived.branch,
          // Present ONLY on a real disagreement. `spin_down` / `list_workers` on the orchestrator
          // side assess teardown safety on the union of both names, so erasing this one would let a
          // landed HEAD vouch for a spawn branch that still holds unlanded commits.
          ...(derived.spawnBranch !== undefined ? { spawnBranch: derived.spawnBranch } : {}),
          worktree: a.worktreePath ?? "",
          // Pair the result.json completion verdict with the worker's LIVE tab status so a
          // result-less worker reports its real state (working / idle / waiting / blocked / approval)
          // instead of a flat "running" (sparkle-0an0). The live status map is per-window and
          // live-only; an unknown entry (worker not open here) falls back to "running".
          status,
          // Completed BUT still taking turns (sparkle-xdilh) — the verdict shadows liveness, so
          // without this the roster cannot say it. Omitted (not `false`) when not observed, so
          // "not still running" and "liveness unknown" stay the same falsy answer.
          ...(sessionStillRunning(status, liveStatus) ? { stillRunning: true } : {}),
          // The bead this worker owns. Without it the roster is N ANONYMOUS workers: a resumed
          // orchestrator cannot tell which unit any live worker is already handling, so it
          // re-dispatches everything still showing in `bd ready`. Omitted (rather than "") when the
          // worker carries no bead, so "no claim" stays distinguishable from "claim unknown".
          ...(a.beadId ? { beadId: a.beadId } : {}),
        };
      }),
    );
    await respond(req.reqId, { workers });
  } catch (e) {
    // Every dispatch path MUST reply exactly once — a thrown store read would otherwise leave the
    // bridge blocked for its full 600s timeout.
    await respond(req.reqId, { error: errMsg(e) });
  }
}

/** Resolve the single window that services a request for `projectId`. Split out so the IO deps
 *  (registry / WebviewWindow) are swappable in tests; see the note above `handleSpinDown`. */
async function ownsRequest(projectId: string): Promise<boolean> {
  const label = getCurrentWindow().label; // read once — both fields must describe the SAME window
  return shouldHandleInThisWindow(projectId, {
    myLabel: label,
    isMain: label === "main",
    findWindowForProject: (pid) => findWindowForProject(pid),
    isWindowAlive: async (l) => (await WebviewWindow.getByLabel(l)) !== null,
    evictWindow: (l) => clearWindowProject(l),
  });
}

/** Tear a worker down — the one op here whose side effects are DESTRUCTIVE and machine-global
 *  (kill the PTY, `git worktree remove` the checkout, drop the row), so it must run exactly once.
 *
 *  `app.emit` broadcasts orchestration:request to every open webview, and none of this module's
 *  guards can bound that: `spawnQueue` / `inFlight` / `claimedBeads` are MODULE state, so each
 *  window holds its own copy, and the ownership test below reads the shared persisted projectStore,
 *  which every window has in full regardless of what it displays. So N open windows each ran the
 *  whole teardown for one spin_down: N `removeAgent` (N-1 of them starting a `close:<id>` perf trace
 *  no pane in that window will ever end), N `killPty`, N `git worktree remove` racing each other
 *  over one checkout, and N `orchestration_respond` for a single reqId. The losing windows' removals
 *  are what produce the recurring "removeAgentWorkspace failed … validation failed" warnings — the
 *  checkout is already gone because a sibling window won.
 *
 *  Electing one servicer (windowOwnership — the capture://send routing, which guarantees
 *  at-most-one AND at-least-one handler via main's stale-owner self-heal) removes the fan-out at
 *  the source. Deliberately scoped to spin_down: `spawn_worker` takes its cap reservation and bead
 *  claim SYNCHRONOUSLY at accept time, and putting an await in front of that accept is a separate
 *  change with its own invariant to re-argue. `list_workers` is a read whose duplicate responses
 *  are merely wasteful. spin_down carries all of the destructive fan-out. */
async function handleSpinDown(req: OrchestrationRequest): Promise<void> {
  // Ownership is resolved BEFORE reconcile/teardown so the non-owning windows do no work at all,
  // and they stay SILENT rather than responding: the owner replies for the request, and a second
  // reply to one reqId is at best ignored and at worst races the real verdict. A probe that throws
  // is treated as "not mine" for the same reason the owner-alive probe assumes alive — declining is
  // the at-most-one-preserving default, and main's self-heal covers a genuinely orphaned request.
  if (!(await ownsRequest(req.projectId).catch(() => false))) return;
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
 *  Releases in FIFO order. It used to scan for the first ELIGIBLE request, because a per-agent gate
 *  could refuse the head while a different agent had a free slot — with one machine-wide gate the
 *  answer is the same for every queued request, so a scan would find index 0 or nothing. FIFO is
 *  what that collapses to, and it is the fairer order anyway: the longest-waiting spawn goes first
 *  rather than whichever agent happens to be scanned first. */
async function drainQueue(): Promise<void> {
  expireStaleQueuedSpawns();
  while (spawnQueue.length > 0 && !atCapacity()) {
    const [next] = spawnQueue.splice(0, 1);
    queuedAt.delete(next!.reqId);
    await runSpawn(next!);
  }
}

/** Drop queued spawns whose caller has provably given up (see `SPAWN_QUEUE_MAX_WAIT_MS`), replying
 *  with an error so the caller learns the unit did not start rather than timing out on its socket.
 *
 *  Runs at the TOP of drainQueue, before the capacity check and unconditionally — an entry that
 *  expires while the machine is still full must not be held until a slot happens to free, which is
 *  exactly when it would materialize an untracked worker. drainQueue is wired to every store change,
 *  so this sweeps regularly without its own timer. */
function expireStaleQueuedSpawns(): void {
  const now = reaperNow();
  for (let i = spawnQueue.length - 1; i >= 0; i--) {
    const req = spawnQueue[i]!;
    const since = queuedAt.get(req.reqId);
    if (since === undefined || now - since < SPAWN_QUEUE_MAX_WAIT_MS) continue;
    spawnQueue.splice(i, 1);
    queuedAt.delete(req.reqId);
    // Same reasoning as purgeBuildAgent's: a queued request holds its bead claim (taken in
    // handleSpawn, released in runSpawn's finally), and an expired one never reaches runSpawn — so
    // without this the key leaks and a legitimate retry of that bead is refused as "already being
    // spawned" with nothing in flight (roborev 41945).
    releaseBeadClaim(req);
    void respond(req.reqId, {
      error:
        "spawn timed out waiting for a free slot — the machine stayed at its concurrency cap. " +
        "This unit was NOT started; retry it once a worker has been spun down.",
    });
  }
}

/** Heal passes that have re-opened a worker which STILL hasn't come up live, keyed by worker id.
 *  Pruned every pass down to the workers that are materialized-but-not-live, so it can't grow and a
 *  worker that goes live (or is torn down) and later strands again starts from a fresh budget.
 *  Cleared with the rest of the module state on teardown. */
const healAttempts = new Map<string, number>();
/** How many consecutive passes may re-assert open() on the SAME still-stranded worker before the
 *  heal gives up on it. Deliberately well above what a converging heal needs: a re-open that sticks
 *  clears the entry on the next pass, so a healthy strand costs one attempt. The cap only binds when
 *  re-opening does NOT stick — see {@link ensureWorkersOpen}. */
const MAX_HEAL_ATTEMPTS = 25;

/** Self-healing invariant: re-open any worker that was spawned + had its worktree cut but is no
 *  longer live (not in openAgentIds, no PTY status). runSpawn open()s a worker exactly once at spawn;
 *  if a reconcile()/remount race then evicts it from the cross-window-shared openAgentIds before its
 *  pane mounts, that one-shot is silently undone and the worker strands behind "Start this agent",
 *  blocking its orchestrator with no signal. Re-asserting open() converges the system back to "every
 *  materialized worker is live", regardless of which race evicted it.
 *
 *  The heal is NOT self-limiting, contrary to what this comment used to claim ("once re-opened the
 *  worker has a status entry, so it isn't re-opened again"). Nothing in this module makes the open
 *  stick: whatever evicted the id can evict it again, and each open() mutates openAgentIds → wakes
 *  the runtimeStore subscription → schedules another heal. Whenever the evictor keeps pace, that is
 *  a re-open/evict ping-pong with no exit, every round writing the persisted, cross-window-shared
 *  open set. Sessions do show the same worker id re-opened ~10 times in a sub-millisecond burst, so
 *  the loop is real; it has only ever been bounded by the racer happening to settle first.
 *
 *  So bound it here: give each stranded worker {@link MAX_HEAL_ATTEMPTS} consecutive attempts, then
 *  stop re-asserting and warn once. Giving up is safe — a lingering strand is exactly what the RED
 *  "Approve?" overlay (withUnstartedWorkerAttention) exists to surface — and it is strictly better
 *  than spinning, which burns the same budget while hiding the problem in DEBUG noise. */
function ensureWorkersOpen(): void {
  const { projects } = useProjectStore.getState();
  const rt = useRuntimeStore.getState();
  const openIds = new Set(rt.openAgentIds);
  const stranded: string[] = [];
  for (const project of projects) {
    for (const worker of workersNeedingOpen(project.agents, rt.status, openIds, rt.lastObserved)) {
      // A worker the user just closed can momentarily still look "stranded" — in a stale snapshot's
      // roster, not open, no status — before the removal propagates. Re-opening it here would
      // resurrect the just-closed row, so skip any id tombstoned as locally-removed (the merge
      // filter normally keeps it out of the roster entirely; this is defense-in-depth).
      if (isLocallyRemoved(worker.id)) {
        continue;
      }
      stranded.push(worker.id);
    }
  }
  // Forget every id that finally came up live (or was torn down) BEFORE spending any attempts, so
  // the count measures one unresolved strand. Pruning against `stranded` instead would reset on
  // every ping-pong round — an open() that lands and is immediately evicted would look like a win.
  // Skipped entirely when nothing is being counted, which is the steady state: this runs on every
  // projectStore change, so it must not add a second full-roster scan to the common path.
  if (healAttempts.size > 0) {
    const notYetLive = new Set<string>();
    for (const project of projects) {
      for (const agent of project.agents) {
        if (isNotYetLiveWorker(agent, rt.status)) notYetLive.add(agent.id);
      }
    }
    for (const id of healAttempts.keys()) {
      if (!notYetLive.has(id)) healAttempts.delete(id);
    }
  }
  for (const id of stranded) {
    const attempts = healAttempts.get(id) ?? 0;
    if (attempts >= MAX_HEAL_ATTEMPTS) {
      if (attempts === MAX_HEAL_ATTEMPTS) {
        // Warn exactly once per strand: bumping past the cap makes every later pass fall through.
        healAttempts.set(id, attempts + 1);
        console.warn(
          `[orchestration] worker still stranded after ${MAX_HEAL_ATTEMPTS} re-open attempts — leaving it to the "Approve?" overlay`,
          id,
        );
      }
      continue;
    }
    healAttempts.set(id, attempts + 1);
    console.debug("[orchestration] re-opening stranded worker", id);
    rt.open(id);
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
  if (reapTimer) {
    clearInterval(reapTimer);
    reapTimer = undefined;
  }
  stopWorkerAutosave();
  if (graceTimer) {
    clearTimeout(graceTimer);
    graceTimer = undefined;
    graceTimerAt = undefined;
  }
  // Bump the generation so any pass still in flight stops acting (its loop checks reapGen and bails),
  // reset reaper state so a fresh listener (HMR / re-open) starts each orphan's grace anew rather than
  // reaping on the previous listener's evidence, and clear the single-flight flag so an in-flight pass
  // at teardown can't wedge the next listener's reaper.
  reapGen++;
  orphanSeen.clear();
  reaping = false;
  reapRerunRequested = false; // a request captured before teardown must not fire into the next listener
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
  queuedAt.clear();
  inFlight.clear();
  // Claims die with the listener, for the same reason inFlight does: nothing is in flight after a
  // teardown, so any surviving key is a phantom that would refuse a legitimate spawn once a fresh
  // listener starts. (roborev 41945)
  claimedBeads.clear();
  // Same reasoning: a surviving attempt count would spend a fresh listener's heal budget on a strand
  // the previous listener saw, so the first real eviction after a restart could be ignored outright.
  healAttempts.clear();
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
  // (e.g. a crash/restart mid-spawn): the manifest-backed self-heal, then a reap pass so any worker
  // whose parent build agent did NOT come back is reclaimed instead of leaking a machine-wide cap
  // slot. Ordered reconcile → reap so a worker adopted this pass (parent present) is never reaped in
  // the same pass. Fire-and-forget so a slow/failing scan can't delay listener startup (sparkle-3xus).
  void reconcileWorkersFromDisk()
    .then(() => {
      if (listenerLive) return reapOrphanedWorkers(); // don't reap on behalf of a torn-down listener
    })
    .catch((e) => console.warn("[orchestration] startup reconcile/reap failed", e));
  // Low-frequency sweep: reclaim orphaned workers even when no spawn is attempted, so an idle
  // machine doesn't sit at a leaked cap. Cleared in teardown; guarded on listenerLive so a fire in
  // the teardown gap is a no-op.
  reapTimer = setInterval(() => {
    if (!listenerLive) return;
    // reapOrphanedWorkers sweeps the spawn queue at its top (see the note there), so this 60s tick
    // is also what bounds how long an expired spawn can wait for its error reply on a quiet store.
    void reapOrphanedWorkers().catch((e) => console.warn("[orchestration] periodic reap failed", e));
  }, REAP_INTERVAL_MS);
  // Periodic WIP autosave: enforce "commit incrementally" at the harness level so a HARD
  // death (session-limit crash, app/OOM kill) that never runs an orderly teardown still leaves
  // a worker's work committed on its branch rather than only as uncommitted worktree edits
  // (bead sparkle-piliqq). Reuses the same best-effort snapshot the teardown path uses; a clean
  // tree is a no-op. Stopped in teardown alongside the reaper.
  startWorkerAutosave({ ownsProject: ownsRequest });
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
