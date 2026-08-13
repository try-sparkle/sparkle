// agentGoalDisk — MIRROR every goal change to a file a shell hook can read.
//
// A goal is the one thing meant to outlive a lost session, and it lives in localStorage (zustand
// `persist`, key `sparkle-projects` — see stores/projectStore). A SessionStart hook is a shell
// script: it cannot read localStorage, so an agent that wakes with no session context gets NOTHING
// back about what it was doing. This module is the durable mirror it CAN read.
//
// The contract is FROZEN in `docs/agent-goal-record.md`, and its canonical instance is
// `scripts/tests/fixtures/agent-goal-record.json`. That fixture is not documentation — it is the
// ANTI-DRIFT DEVICE. This module's test builds a goal, runs it through `buildAgentGoalRecord`, and
// deep-equals the result against that parsed file; the shell reader's test reads the same file. So
// the two halves fail TOGETHER instead of passing separately, which is the exact failure AGENTS.md
// records: two agents built the two halves of a payload in parallel against a frozen FIELD LIST,
// both suites passed, the merge was clean, and the shipped feature never once ran because one side's
// shape could not be produced by the other.
//
// ── EVERY KEY IS ALWAYS PRESENT; ABSENCE IS `null`, NEVER AN OMITTED KEY ────────────────────────
// The reader may then index a key unconditionally (`jq -r '.goal.verify'` yields the string `null`
// rather than an error), and an ABSENT key means a malformed or older record rather than "this value
// is empty". Two different facts, and collapsing them is how a reader silently mistakes a broken
// record for an empty one.
//
// ── THE STATE VOCABULARY IS PASSED THROUGH AS A STRING, ON PURPOSE ─────────────────────────────
// `GoalState` is being extended in parallel (`retired`, `abandoned`), as is `AgentGoal` (`rearms`,
// `retiredAt`, `abandonedAt`). Switching exhaustively over the union here would make this file fail
// to compile on one side of that change and fail to compile on the other; reading a not-yet-existing
// field directly would do the same. So the state is carried as a `string` and the new fields are read
// defensively. Nothing here needs to UNDERSTAND the vocabulary — it only has to write it down.
import { invoke as tauriInvoke } from "@tauri-apps/api/core";

import { type AgentGoal, goalStateOf } from "../engine/agentGoal";
import { log } from "../logger";
import { useProjectStore } from "../stores/projectStore";
import type { Project } from "../types";
import { ownsProjectInThisWindow } from "./goalContinuationRunner";

/** Bump ONLY on a breaking change — the reader refuses to guess at a version it does not know. */
export const GOAL_RECORD_SCHEMA_VERSION = 1;

/** Trailing-debounce window for the record write.
 *
 *  A goal record is not worth a disk write per keystroke: `projectStore` re-persists on many
 *  mutations that never touch a goal (prompt appends, tab switches, status ticks), and every one of
 *  them wakes this subscriber. The same 400ms the store uses for its own persistence
 *  (`PROJECTS_PERSIST_DEBOUNCE_MS`) — long enough to coalesce a burst, short enough that an ordinary
 *  pause flushes promptly, and matching it means the two writes settle together rather than
 *  interleaving. */
export const GOAL_DISK_DEBOUNCE_MS = 400;

/** How often to re-sweep with NOTHING having changed in the store.
 *
 *  ⚠️ THIS IS NOT BELT-AND-BRACES — without it the record's `state` is provably wrong in the one
 *  situation the feature exists for. `state` is CLOCK-DERIVED: `goalStateOf` returns `expired` purely
 *  because `now >= setAt + ttlMs`, and no store mutation accompanies that transition. A mirror driven
 *  only by store changes therefore writes `"unmet"` and leaves it on disk indefinitely — and the
 *  quieter the agent, the longer it is stale, so the brief handed to an agent waking from a long
 *  stall is exactly the one most likely to assert a live goal that expired hours ago.
 *
 *  A minute is far finer than the hours-scale TTLs this tracks, and a sweep with no goal change is
 *  three cheap reads plus one directory listing — the write dedupe (see `written`) means an unchanged
 *  fleet issues no writes at all. */
export const GOAL_DISK_SWEEP_MS = 60_000;

/** The `goal` half of the record. Every field required, `null` for absence — see the header. */
export interface AgentGoalRecordGoal {
  text: string;
  /** `none|unmet|met|expired|escalated|retired|abandoned`. A STRING, not the `GoalState` union —
   *  see the header for why this file must compile on both sides of that union's extension. */
  state: string;
  setAt: number;
  ttlMs: number;
  rearms: number;
  continues: number;
  totalContinues: number;
  escalationReason: string | null;
  /** The verification KIND alone (`"landed" | "command" | "human"`), not the `GoalVerify` object.
   *  The frozen contract writes a bare string, and a `command` check's `cmd` is deliberately NOT
   *  mirrored: this file is read back to a waking agent as a brief, and a stale command replayed as
   *  an instruction is the false-"done" hazard `engine/agentGoal` documents at length. */
  verify: string | null;
}

/** One agent's on-disk goal record — `<app_data>/agent-goals/<agentId>.json`. */
export interface AgentGoalRecord {
  schemaVersion: number;
  agentId: string;
  agentName: string;
  /** How the hook finds ITS OWN record: it scans `agent-goals/*.json` for the one whose `worktree`
   *  matches `$PWD` (after `realpath`), rather than parsing an id out of the branch name — a branch
   *  rename must not orphan an agent's brief. `null` for an agent with no worktree, which no `$PWD`
   *  can ever match; that is the honest value, per the always-present/`null`-for-absence rule. */
  worktree: string | null;
  branch: string | null;
  updatedAt: number;
  goal: AgentGoalRecordGoal;
}

/** `AgentGoal` plus the fields being added to it IN PARALLEL by the goal state-machine work.
 *
 *  Written as an intersection rather than by editing `engine/agentGoal.ts` (which is not this
 *  module's file, and editing it would collide): once `AgentGoal` really carries `rearms: number`,
 *  the intersection collapses to `number` and this alias becomes a no-op that can be deleted. Until
 *  then it is what lets `?? 0` compile instead of erroring on an unknown property. */
type GoalWithPendingFields = AgentGoal & { rearms?: number };

/**
 * Serialize one agent's goal into the frozen record shape. PURE — the clock arrives as `now`.
 *
 * `state` is computed with the REAL `goalStateOf` rather than read off a field, because that
 * function is the single definition of the vocabulary and it is what the parallel state-machine work
 * extends. A record that named states this file decided for itself would drift the moment that
 * function learned a new one.
 */
export function buildAgentGoalRecord(args: {
  agentId: string;
  agentName: string;
  worktree: string | null;
  branch: string | null;
  goal: AgentGoal;
  now: number;
}): AgentGoalRecord {
  const goal = args.goal as GoalWithPendingFields;
  return {
    schemaVersion: GOAL_RECORD_SCHEMA_VERSION,
    agentId: args.agentId,
    agentName: args.agentName,
    worktree: args.worktree,
    branch: args.branch,
    updatedAt: args.now,
    goal: {
      text: goal.text,
      state: goalStateOf(goal, args.now),
      setAt: goal.setAt,
      ttlMs: goal.ttlMs,
      // Defensive: the field does not exist on `AgentGoal` yet. `?? 0` is also the right value for
      // every goal that predates it — a goal nobody re-armed has been re-armed zero times.
      rearms: goal.rearms ?? 0,
      continues: goal.continues,
      totalContinues: goal.totalContinues,
      escalationReason: goal.escalationReason ?? null,
      verify: goal.verify?.kind ?? null,
    },
  };
}

/** Everything this module reaches for, as injected edges — the same "PURE CORE, INJECTED EDGES"
 *  split `services/deathRecordWriter` uses, so every rule below tests without a Tauri host. */
export interface GoalDiskDeps {
  invoke: (cmd: string, args: Record<string, unknown>) => Promise<unknown>;
  /** Single-owner election. Two windows must not fight over one agent's file. */
  ownsProject: (projectId: string) => boolean;
  projects: () => Project[];
  /** Subscribe to store changes; returns the unsubscribe. A dep so the debounce is drivable, but
   *  the DEFAULT is the real store subscription and `startAgentGoalDiskMirror()` with no arguments
   *  is exercised by a test — a seam every test injects leaves the production line uncovered
   *  (sparkle-lgbwf), and deleting it would keep the suite green while the feature is dead. */
  subscribe: (onChange: () => void) => () => void;
  now: () => number;
}

/** The real edges. A function, not a constant, so each call reads current store state. */
export function liveGoalDiskDeps(): GoalDiskDeps {
  return {
    invoke: (cmd, args) => tauriInvoke(cmd, args),
    ownsProject: ownsProjectInThisWindow,
    projects: () => useProjectStore.getState().projects,
    subscribe: (onChange) => useProjectStore.subscribe(() => onChange()),
    now: () => Date.now(),
  };
}

/** What one sweep did to one agent's record. Returned so tests assert the DECISION rather than
 *  counting calls on a spy. */
export interface GoalDiskOutcome {
  agentId: string;
  action: "wrote" | "unchanged" | "deleted" | "failed";
  detail?: string;
}

/**
 * What this window has already written, per agent → the record's content signature.
 *
 * The dedupe that makes the debounce worth having: `projectStore` re-persists on mutations that
 * never touch a goal, so without this every prompt append would rewrite every record. Module-level
 * (not per-mount) so a remount does not rewrite the whole fleet.
 */
let written = new Map<string, string>();

/**
 * The record's CONTENT, excluding `updatedAt`.
 *
 * `updatedAt` is a write timestamp, not content — including it would make every signature unique and
 * defeat the dedupe entirely (every sweep would rewrite every record, which is the behaviour this
 * map exists to prevent).
 */
function signatureOf(record: AgentGoalRecord): string {
  return JSON.stringify([
    record.schemaVersion,
    record.agentId,
    record.agentName,
    record.worktree,
    record.branch,
    record.goal,
  ]);
}

/**
 * One pass: mirror every goal in a project this window OWNS, and clean up records whose goal is gone.
 *
 * NEVER THROWS. A recovery affordance that can break the thing it protects is worse than not having
 * one — a rejected `invoke` must not take the sweep (or the app) down, so a failure is recorded as an
 * outcome and the pass continues to the other agents.
 *
 * ⚠️ THE DELETE RULE IS NARROWER THAN "WE NO LONGER SEE A GOAL", and the difference is a real bug.
 * Ownership can TRANSFER between windows (a satellite is torn off, main adopts an unowned project),
 * and a rule that deleted whatever this window no longer owns would erase a record the other window
 * had just written — the mirror deleting itself, on a project nobody changed. So a record is deleted
 * only when we can prove the goal is gone rather than merely out of view: either the agent no longer
 * exists in ANY project (torn down), or we still OWN it and it has no goal.
 *
 * ⚠️ AND IT RECONCILES AGAINST THE DIRECTORY, NOT AGAINST WHAT THIS WINDOW REMEMBERS WRITING.
 * Keying cleanup off the in-memory `written` map left two records permanently unreachable, because
 * that map only ever knows what THIS window wrote in THIS session:
 *
 *   1. anything left by a PREVIOUS session — an agent torn down while the app was closed, a window
 *      killed mid-sweep — is absent from a map that starts empty at every launch;
 *   2. anything orphaned by an OWNERSHIP HANDOFF — a satellite writes `A.json`, the satellite is
 *      closed and its map dies with the webview, main adopts the project, then A's goal is cleared.
 *      Main owns A and sees no goal, but never wrote A, so it never deleted it.
 *
 * Both leave a stale file that the hook still matches by `worktree`/`$PWD`, briefing a waking agent
 * with a goal that no longer exists — the stale-instruction hazard this module's header argues
 * against, arriving by a different door. So the disk listing is the authority: whatever is really
 * there is tested against the live fleet, and `written` is left to do the ONE job it is good at,
 * which is skipping redundant WRITES.
 */
export async function syncAgentGoalRecords(
  deps: GoalDiskDeps = liveGoalDiskDeps(),
): Promise<GoalDiskOutcome[]> {
  const outcomes: GoalDiskOutcome[] = [];
  let projects: Project[];
  try {
    projects = deps.projects();
  } catch (e) {
    log.warn("goals", "could not read projects for the goal-record mirror", { error: String(e) });
    return outcomes;
  }
  const now = deps.now();

  /** Every agent this window can see, owned or not — the "torn down" test below. */
  const allAgentIds = new Set<string>();
  /** Agents in an OWNED project that have no goal — the "goal really is gone" test. */
  const ownedWithoutGoal = new Set<string>();

  for (const project of projects) {
    const owned = deps.ownsProject(project.id);
    for (const agent of project.agents) {
      allAgentIds.add(agent.id);
      if (!owned) continue;
      if (agent.goal === undefined) {
        ownedWithoutGoal.add(agent.id);
        continue;
      }
      const record = buildAgentGoalRecord({
        agentId: agent.id,
        agentName: agent.name,
        worktree: agent.worktreePath,
        branch: agent.branch,
        goal: agent.goal,
        now,
      });
      const signature = signatureOf(record);
      if (written.get(agent.id) === signature) {
        outcomes.push({ agentId: agent.id, action: "unchanged" });
        continue;
      }
      // The payload is built on its own line, and the invoke is a SINGLE statement, so a mutation
      // check can blank the write without breaking the file's syntax. A multi-line call expression
      // is unjudgeable by `mutation-check.sh` — commenting any one of its lines is a parse error —
      // which would leave the one call this whole module exists to make covered by nothing it can
      // prove.
      const json = JSON.stringify(record);
      try {
        await deps.invoke("write_agent_goal_record", { agentId: agent.id, json });
        // Recorded only AFTER a write we watched succeed, so a failed write is retried on the next
        // pass rather than being remembered as done.
        written.set(agent.id, signature);
        outcomes.push({ agentId: agent.id, action: "wrote" });
      } catch (e) {
        log.warn("goals", "could not write the agent goal record", {
          agentId: agent.id,
          error: String(e),
        });
        outcomes.push({ agentId: agent.id, action: "failed", detail: String(e) });
      }
    }
  }

  // ⚠️ AN EMPTY STORE IS NOT EVIDENCE THAT THE FLEET IS EMPTY. A relaunch races zustand's rehydration
  // from localStorage, so `projects` is briefly `[]` for reasons that have nothing to do with agents
  // being gone. With `allAgentIds` empty, every record on disk reads as an orphan — so a sweep that
  // landed in that window would delete every brief in the directory at exactly the relaunch this
  // whole mechanism exists to recover from. Deleting nothing is always recoverable (the next sweep
  // reconciles); deleting a brief is not.
  if (projects.length === 0) return outcomes;

  let onDisk: string[];
  try {
    const listed = await deps.invoke("list_agent_goal_records", {});
    onDisk = Array.isArray(listed) ? listed.filter((id): id is string => typeof id === "string") : [];
  } catch (e) {
    // A failed listing means we cannot tell an orphan from a live record, so we clean nothing this
    // pass and try again on the next one. It must not cost us the WRITES above, which already landed.
    log.warn("goals", "could not list agent goal records; skipping cleanup this pass", {
      error: String(e),
    });
    return outcomes;
  }

  for (const agentId of onDisk) {
    const goneEntirely = !allAgentIds.has(agentId);
    // Not ours to judge: the record belongs to an agent that still exists in a project this window
    // does not own. The owning window deletes it, or keeps it current — either way, hands off.
    if (!goneEntirely && !ownedWithoutGoal.has(agentId)) continue;
    try {
      await deps.invoke("delete_agent_goal_record", { agentId });
      written.delete(agentId);
      outcomes.push({ agentId, action: "deleted" });
    } catch (e) {
      log.warn("goals", "could not delete the agent goal record", {
        agentId,
        error: String(e),
      });
      outcomes.push({ agentId, action: "failed", detail: String(e) });
    }
  }

  return outcomes;
}

// ── The mount ───────────────────────────────────────────────────────────────────────────────────

let timer: ReturnType<typeof setTimeout> | null = null;
let ticker: ReturnType<typeof setInterval> | null = null;
let unsubscribe: (() => void) | null = null;
let syncing = false;
let rerunWhenIdle = false;

/** Which mount the live closures belong to.
 *
 *  Teardown clears the timer and unsubscribes, but it cannot reach the `schedule` CLOSURE a
 *  subscriber already captured — so a listener that fires after `stop()` (a subscriber that ignores
 *  its unsubscribe, or the previous mount's listener after a remount replaced it) would re-arm the
 *  module-level timer and start writing again from a mount that no longer exists. Every closure
 *  checks its own generation, so a stale one is inert by construction rather than by trusting the
 *  subscriber to behave. */
let generation = 0;

/**
 * Start mirroring goals to disk. Returns a teardown. Idempotent: a second call replaces the first
 * subscription rather than running two.
 *
 * Mounted app-level (App.tsx and SatelliteApp.tsx), the same shape and for the same reason as
 * `startGoalContinuationRunner`: a goal belongs to an AGENT and one mirror serves the whole fleet, so
 * a per-pane mount would multiply the writes. The single-owner election inside the sweep is what
 * keeps a torn-off satellite from writing over main's records.
 *
 * A first pass is scheduled immediately (through the debounce). That is load-bearing rather than
 * eager: a relaunch restores goals from localStorage into a store nothing has yet mutated, so a
 * mirror that only reacted to CHANGES would leave every record missing after exactly the event this
 * whole mechanism exists to recover from.
 */
export function startAgentGoalDiskMirror(
  deps: GoalDiskDeps = liveGoalDiskDeps(),
  debounceMs: number = GOAL_DISK_DEBOUNCE_MS,
  sweepMs: number = GOAL_DISK_SWEEP_MS,
): () => void {
  stopAgentGoalDiskMirror();
  generation += 1;
  const mine = generation;
  const run = async (): Promise<void> => {
    if (mine !== generation) return;
    // A sweep awaits its invokes, so a slow write can outlast the debounce. Overlapping passes would
    // both read the same pre-write `written` map and issue the same write twice.
    if (syncing) {
      rerunWhenIdle = true;
      return;
    }
    syncing = true;
    try {
      await syncAgentGoalRecords(deps);
    } catch (e) {
      log.warn("goals", "goal-record mirror pass failed", { error: String(e) });
    } finally {
      syncing = false;
    }
    if (rerunWhenIdle) {
      rerunWhenIdle = false;
      schedule();
    }
  };
  // The timer body, hoisted out of the `setTimeout` call for the same reason the write above is one
  // statement: an inline arrow makes `setTimeout` a multi-line expression, which a mutation check
  // cannot blank without a parse error — so the line that arms the debounce would be unprovable.
  const fire = (): void => {
    timer = null;
    void run();
  };
  // TRAILING debounce: each change RESTARTS the window, so a burst collapses into one pass at its
  // end. Same shape as `debouncedLocalStorage` in projectStore.
  const schedule = (): void => {
    if (mine !== generation) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(fire, debounceMs);
  };
  unsubscribe = deps.subscribe(schedule);
  // The clock tick that catches a TTL expiry nobody touched the store for — see GOAL_DISK_SWEEP_MS.
  // It goes through `schedule`, not straight to `run`, so it coalesces with a burst already in
  // flight and inherits the same generation guard rather than opening a second path around it.
  ticker = setInterval(schedule, sweepMs);
  schedule();
  // ⚠️ SCOPED TO THIS MOUNT, not the bare module-global stop. If two mounts ever overlap in one
  // window (a second call site, a non-serialized remount, HMR), returning `stopAgentGoalDiskMirror`
  // meant the FIRST mount's cleanup tore down the SECOND, live mirror — and no goal reached disk for
  // the rest of the session. That is precisely the failure the generation counter was introduced to
  // make impossible, leaking out through the one path it did not cover.
  return () => {
    if (mine !== generation) return;
    stopAgentGoalDiskMirror();
  };
}

/** Stop mirroring (idempotent). Leaves the written-signature map alone: a remount must not rewrite
 *  every record the previous mount already put on disk. */
export function stopAgentGoalDiskMirror(): void {
  // Bumped FIRST: it is what makes an already-captured `schedule`/`run` closure inert, so a
  // subscriber that keeps calling after its unsubscribe cannot restart the mirror.
  generation += 1;
  if (timer !== null) clearTimeout(timer);
  timer = null;
  if (ticker !== null) clearInterval(ticker);
  ticker = null;
  if (unsubscribe !== null) unsubscribe();
  unsubscribe = null;
  rerunWhenIdle = false;
  // ⚠️ CLEARED, and it is not merely tidy. A teardown issued while a sweep's `invoke` is still in
  // flight used to LATCH `syncing = true` forever: that sweep's `finally` belongs to the old
  // generation and its result is discarded, so nothing ever reset the flag. The next mount's first
  // pass then took the `if (syncing)` branch, set `rerunWhenIdle`, and returned — and the only thing
  // that discharges that flag is the stale sweep's own `schedule` closure, which the generation
  // guard has already made inert. The pass dropped that way is the first-pass-on-mount, the one
  // load-bearing for relaunch recovery.
  syncing = false;
}

/** Test helper: is the mirror armed? */
export function isAgentGoalDiskMirrorRunning(): boolean {
  return unsubscribe !== null;
}

/** Test helper: forget what this window believes it has written, so a fresh test starts clean. */
export function _resetAgentGoalDiskForTests(): void {
  stopAgentGoalDiskMirror();
  written = new Map();
  syncing = false;
}
