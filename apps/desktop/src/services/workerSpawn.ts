// Programmatically spawn a worker agent under a build agent: register the tab, cut its worktree
// from the parent's local branch, and persist the worktree. The PTY launch happens when the
// worker tab opens (AgentPane), driven by the worker persona + the stored task.
import { GOAL_MAX_LEN } from "@sparkle/core";
import { useProjectStore } from "../stores/projectStore";
import { useBeadsStore } from "../stores/beadsStore";
import { hasEpicGoalText } from "../engine/epicGoal";
import { epicIdForAgent } from "./epicLadder";
import { type WorktreeInfo, type KillReason, killPty } from "../pty";
import { prepareWorkerWorkspace, removeAgentWorkspace, writeWorkerManifest } from "./worktree";
import { useRuntimeStore } from "../stores/runtimeStore";
import { maybeAutoName } from "./agentNaming";
import { aiFeatureNow } from "./aiGate";
import { useStaleBuildStore } from "./staleBuildService";
import { removeAgentWithoutPane } from "./agentTeardown";

/** The authoritative identity of a freshly-spawned worker. Returned straight from the worktree
 *  cut (createWorkerWorktree) — NOT re-derived from a later store read — so callers (the
 *  orchestration reply) always get the correct, non-empty branch + worktree that match the worker
 *  actually created, even if a concurrent reconcile/relocation mutates the store record afterward. */
export interface SpawnedWorker {
  workerId: string;
  /** The worker's own branch (createWorkerWorktree guarantees this is non-empty). */
  branch: string;
  /** The worker's worktree path (createWorkerWorktree guarantees this is non-empty). */
  worktree: string;
}

/** The clause that joins a worker's task to the objective it serves. Split out so the template's
 *  fixed cost is measured, not guessed, when the epic-goal half is truncated below. */
const LADDER_JOINER = " is complete and its result demonstrably serves the epic goal: ";

/**
 * A deterministic laddering goal for a worker the orchestrator dispatched WITHOUT one, or null.
 *
 * ── WHY A TEMPLATE AND NOT A MODEL CALL ──────────────────────────────────────────────────────
 * The good narrowing already happens upstream: `spawn_worker` requires a `goal` and
 * `@sparkle/core`'s `validateWorkerGoal` refuses the spawn without one, so on the ordinary path a
 * model with full context on this exact slice has already written the criterion. This is the
 * SALVAGE path for the one case that bypasses it — the recorded `goalOverride` — and there is
 * nothing here to reason about: no task context beyond a bead id, and a click path that must not
 * grow a network round trip. A fixed sentence naming both ends of the ladder is honest about being
 * a fallback; a generated one would be a second, worse copy of a judgement already made better.
 *
 * Null for every shape with nothing to ladder to: no bead, no board snapshot yet, a bead outside
 * any epic, an epic with no goal, and a goal record left by a FAILED generation (`hasEpicGoalText`
 * rejects the empty text those carry). Null leaves the worker exactly as it is today — goalless,
 * which is what the override asked for.
 */
export function ladderGoalFor(projectId: string, beadId: string | undefined): string | null {
  const beads = useBeadsStore.getState().byProject[projectId]?.beads ?? [];
  // One shared answer to "which epic does this agent's work ladder up to" — `epicLadder`'s own
  // header records why a second derivation of that edge is not allowed to exist. It answers null
  // for a missing `beadId` itself, so there is deliberately NO guard for that here: a second copy
  // would be an inert line no test could ever catch regressing (mutation-check, cause 4).
  const epicId = epicIdForAgent({ id: "", beadId }, beads);
  if (epicId === null) return null;
  const project = useProjectStore.getState().projects.find((p) => p.id === projectId);
  const goal = project?.epicGoals?.[epicId];
  if (!hasEpicGoalText(goal)) return null;

  // TRUNCATE THE EPIC-GOAL HALF, NEVER THE TASK HALF. `GOAL_MAX_LEN` is a real cap — the goal gate
  // refuses longer prose as a status update — and the bead id is the half that makes this goal
  // checkable at all. Losing the tail of a long objective costs a reader some context; losing the
  // bead id costs them the ability to tell which task this criterion is about.
  const head = `${beadId}${LADDER_JOINER}`;
  const room = GOAL_MAX_LEN - head.length;
  // A bead id long enough to crowd the objective down to a stub would produce a goal that names a
  // parent nobody can recognize — worse than the goalless worker this is salvaging.
  if (room < 20) return null;
  return head + (goal.text.length <= room ? goal.text : `${goal.text.slice(0, room - 1).trimEnd()}…`);
}

export async function spawnWorker(args: {
  projectId: string;
  parentAgentId: string;
  task: string;
  beadId?: string;
  /** The worker's objectively verifiable completion criterion, stated by whoever dispatched the
   *  work. Set on the tab AT CREATION rather than by a later `set_agent_goal` call: an agent that
   *  dies between spawn and that call is a goalless worker, and a goalless worker cannot be told
   *  apart from one that merely stopped (which is what engine/goalContinuation needs to decide
   *  whether to restart it). Absent only under a recorded override — see
   *  mcp-orchestrator/src/goalGate.ts for what is and is not enforced. A blank one under a
   *  goal-bearing epic falls back to {@link ladderGoalFor}; a supplied one is never overwritten. */
  goal?: string;
}): Promise<SpawnedWorker> {
  const store = useProjectStore.getState();
  const project = store.projects.find((p) => p.id === args.projectId);
  if (!project) throw new Error(`unknown project ${args.projectId}`);
  const parent = project.agents.find((a) => a.id === args.parentAgentId);
  if (!parent) throw new Error(`unknown parent agent ${args.parentAgentId}`);

  // STALE-BUILD GUARD (sparkle-cmtg) — fail loudly and accurately BEFORE the "no branch" throw.
  // The app embeds the orchestrator and does NOT hot-reload (staleBuildService), so a running build
  // that is older than the one installed on disk is serving stale orchestration code. That stale
  // code repeatedly mis-derived a live parent's branch as empty and then threw the branch error
  // below — sending the operator hunting for a branch problem that did not exist (the founder repro
  // in the bead). Checking staleness here means a stale build says so directly and tells the human
  // to restart, instead of emitting a misleading "no branch" error we would then have to debug. A
  // stale build must not spawn workers from code that no longer matches what shipped, branch or not.
  const staleBuild = useStaleBuildStore.getState();
  if (staleBuild.stale) {
    const v = staleBuild.installedVersion;
    throw new Error(
      `the running app is a STALE build${
        v ? ` — version ${v} is installed but not yet running` : ""
      } — RESTART the app to finish updating, then spawn again. Spawning from stale orchestration ` +
        `code can misreport agent state (for example, a live branch as "no branch yet").`,
    );
  }

  if (!parent.branch) throw new Error("parent agent has no branch yet — open it first");

  // DON'T STEAL THE TAB. `select: false` — a spawn is MCP-driven, so moving the user's terminal to
  // an agent they never asked for is disruptive on its own, several times a minute in a fan-out.
  // Nothing downstream needs the selection: the worker's PTY mounts because runSpawn calls
  // runtime.open(workerId), not because it is selected (Workspace renders a pane per OPEN id and
  // paints exactly one `visible`), and nothing between here and the return reads selection.
  //
  // It is also what lets orchestrator subtrees stay CLOSED on spawn (§14): a selected worker must
  // always have a visible row — see the selection-reveal effect in AgentSidebar — so a spawn that
  // left the new worker selected would force its subtree open and reproduce the old expand-on-spawn
  // behavior through the back door. Suppressed at the STORE rather than selected-then-restored, so
  // there is no intermediate state a render could observe (no dependence on React batching the two
  // writes) and no phantom `switch:` perf waterfall from a selection that never painted.
  const workerId = store.addAgent(args.projectId, {
    kind: "worker",
    parentId: args.parentAgentId,
    task: args.task,
    parentBranch: parent.branch,
    beadId: args.beadId,
    select: false,
  });
  // Null means "no such project" — already rejected above; keep the check so the rollback/worktree
  // machinery below can never run against a phantom worker id.
  if (!workerId) throw new Error(`unknown project ${args.projectId}`);

  // Record the goal IMMEDIATELY — same synchronous block as the tab, before the first await. The
  // worktree cut below is a real `git worktree` call taking seconds, and an app quit or crash inside
  // that window would otherwise persist a worker tab with a task and no objective: the exact
  // goalless worker the dispatch gate exists to prevent, created by the gate's own success path.
  // Guarded on non-blank because `setAgentGoal` treats an empty string as CLEAR the goal (and
  // agentGoal.newGoal throws on it), so a blank must not reach it.
  //
  // THE LADDER FALLBACK. A blank goal here means the orchestrator used `spawn_worker`'s recorded
  // `goalOverride` escape hatch, which leaves the worker with NO goal at all. That is the right
  // outcome for work with genuinely no criterion — but not for a worker under an epic that HAS a
  // stated goal: there, "nothing this task does is checkable" is contradicted by the epic itself,
  // and the worker still ends up in the goalless population the dispatch gate was built to shrink.
  // So it gets a deterministic template naming its task and the objective that task serves.
  const goal = args.goal?.trim() || ladderGoalFor(args.projectId, args.beadId);
  if (goal) useProjectStore.getState().setAgentGoal(args.projectId, workerId, goal);

  // Fail-closed rollback (sparkle-a670): drop the orphan tab and — when the worktree was already
  // cut — remove it from disk so no half-registered worktree leaks.
  //
  // Selection is restored ONLY when the doomed worker is the one selected, which with `select: false`
  // can now happen just one way: the user CLICKED the new worker's row during the awaits below (a
  // real `git worktree` cut, seconds), and it is about to vanish under them. removeAgent's own
  // fallback for a disappearing selection is `agents[0]` — the first tab in insertion order, not
  // anywhere the user has been — so hand them the orchestrator that owns the failed spawn instead.
  //
  // Unconditional is wrong, and was the previous shape: re-asserting a tab captured before the spawn
  // would yank back a user who had navigated elsewhere during those same awaits, on the failure
  // path — the exact behavior `select: false` exists to prevent.
  const rollback = async (removeWorktree: boolean): Promise<void> => {
    if (removeWorktree) {
      await removeAgentWorkspace(project.rootPath, args.projectId, workerId).catch((e) =>
        console.warn("spawnWorker rollback: removeAgentWorkspace failed", e),
      );
    }
    const selectedWasDoomed =
      useProjectStore.getState().projects.find((p) => p.id === args.projectId)?.selectedAgentId ===
      workerId;
    // The worker's pane NEVER mounted: the row is added with `select: false` and
    // `runtime.open(workerId)` does not run until `runSpawn`, which this rollback is the failure to
    // reach. Fan-out reaches this path (worktree cut failures) far more often than the build-agent
    // teardown where the same leak was first found.
    removeAgentWithoutPane(args.projectId, workerId);
    if (selectedWasDoomed) {
      useProjectStore.getState().selectAgent(args.projectId, args.parentAgentId);
    }
  };

  let info: WorktreeInfo;
  try {
    info = await prepareWorkerWorkspace({
      root: project.rootPath,
      projectId: args.projectId,
      workerId,
      parentBranch: parent.branch,
    });
  } catch (e) {
    // A failed worktree cut left nothing durable on disk — just drop the orphan tab so a dead,
    // un-launchable worker (worktreePath/branch null) isn't stranded in the sidebar.
    await rollback(false);
    throw e;
  }

  // sparkle-hwfv/a670 — Durability BEFORE registration: write the worker's identity to disk
  // (`.sparkle/worker.json`) INSIDE its just-cut worktree, awaited before we finalize the store
  // record or reply. This is the disk-authoritative copy of {workerId, buildAgentId, projectId,
  // branch, task, beadId} that survives a store eviction, so an evicted in-memory record can be
  // re-derived from disk (reconcile, sparkle-3xus) with no app restart — and the task-on-disk lets
  // the worker read its mission even if its store record is gone (kills the taskless-stall half).
  // Ordered manifest → setAgentWorktree so the moment the worker is observable as "materialized"
  // (worktreePath set) it is already durable on disk.
  try {
    await writeWorkerManifest(info.path, {
      workerId,
      buildAgentId: args.parentAgentId,
      projectId: args.projectId,
      branch: info.branch,
      worktree: info.path,
      task: args.task,
      beadId: args.beadId,
      createdAt: new Date().toISOString(),
    });
  } catch (e) {
    // Fail closed: a worker we can't make durable must NOT be returned as a live worktree. Remove
    // the just-cut worktree and the orphan tab so the spawn atomically rolls back (a670).
    await rollback(true);
    throw e;
  }

  useProjectStore.getState().setAgentWorktree(args.projectId, workerId, info.path, info.branch);

  // Auto-name the worker from its assigned task. A worker's task never flows through the Composer's
  // onSubmitPrompt handler (it's injected as the PTY's initialPrompt at launch) and its promptHistory
  // is empty at spawn — so this is the worker's ONE naming moment from the task signal. Pass
  // bypassFirstTurnDefer so the self-reporting-agent first-turn deferral doesn't swallow it (a worker
  // has no earlier self-report opportunity). Fire-and-forget, gated on the autoRename AI feature;
  // no-ops if pinned, thin, or no API key. Claude Code's later ai-title / rename_agent still
  // supersedes (maybeAutoName bails once aiTitle is set or the tab is pinned).
  if (aiFeatureNow("autoRename") && args.task.trim()) {
    void maybeAutoName(args.projectId, workerId, args.task, { bypassFirstTurnDefer: true });
  }

  // Return the AUTHORITATIVE identity captured from the worktree cut — never re-read from the store.
  // The store record can be mutated (worktreePath reset to null on relocation, or the whole record
  // rebuilt by a cross-window reconcile) between here and when the orchestration reply is assembled;
  // a re-read there could yield empty branch/worktree and produce a "malformed reply" (sparkle-yk3x).
  return { workerId, branch: info.branch, worktree: info.path };
}

/** Tear down a finished worker: drop its tab + runtime entry IMMEDIATELY, then reap its PTY and
 *  worktree (branch is kept) in the background. Idempotent for sequential calls — a worker already
 *  gone is a no-op. Worker-only: a non-worker id is a no-op, because removeAgent cascades to a
 *  build's workers and would orphan their PTYs/worktrees (this fn only tears down the single id).
 *
 *  Ordering matters (the "× closes the worker but the row comes back" bug): removeAgentWorkspace
 *  serializes on the shared per-root repo lock (worktree.withRepoLock), so AWAITING it BEFORE
 *  removeAgent — as this did originally — left the just-closed worker row lingering in the sidebar
 *  (and the orchestration self-heal, ensureWorkersOpen, re-opened it) for as long as a concurrent
 *  agent held that lock. Mirrors the build-agent close (AgentSidebar.teardownAgent): drop the row
 *  synchronously, reap OS/git resources after. Because a worker's on-disk manifest (unlike a closed
 *  build agent's) can still be re-adopted by reconcileWorkersFromDisk while its parent lives,
 *  removeAgent tombstones the id (pendingLocalRemovals) so the reconcile can't resurrect the row
 *  before the manifest is deleted.
 *  Returns after the reap so callers that need the worktree actually gone (handleSpinDown's slot
 *  accounting relies only on the synchronous removeAgent, but the MCP reply should reflect a real
 *  teardown) still await completion. */
export async function spinDownWorker(args: {
  projectId: string;
  workerId: string;
  /** WHO asked. Defaults to `worker-spin-down` — the orchestrator and concierge callers, which are
   *  automation. A human clicking × on a worker row must pass `sidebar-close-agent`, or the ledger
   *  records their click as a reap. */
  stoppedBy?: KillReason;
}): Promise<void> {
  const project = useProjectStore.getState().projects.find((p) => p.id === args.projectId);
  if (!project) return;
  const worker = project.agents.find((a) => a.id === args.workerId);
  if (!worker || worker.kind !== "worker") return;
  // Drop the ROW + close the pane FIRST, so the sidebar updates instantly instead of waiting on the
  // slow git worktree removal below (~1-2s, and far worse for a build agent tearing down N workers).
  // Removing the row synchronously up front is what makes the × feel immediate. It's safe because
  // removeAgent now TOMBSTONES the id (pendingLocalRemovals), so the disk reconcile can't re-adopt
  // this worker from its still-present manifest during the teardown window (sparkle-close-resurrect).
  // DELIBERATELY UNCHANGED, and the leak here is KNOWN — see bead sparkle-vmfda. A `close:` trace can
  // dangle when no pane was mounted, but "was one?" has no answer this call site can give: it is
  // false in the main window for an unvisited or torn-out project, and TRUE in the satellite window
  // for that same torn-out project (SatelliteApp mounts on `openAgentIds` alone). Guessing wrong in
  // the other direction cancels a LIVE trace and silently stops measuring closes, which is worse
  // than the dangle. Left alone until the ownership question is settled where it belongs.
  // KILL BEFORE THE ROW GOES. Dropping the row unmounts the pane, and that unmount is itself a
  // `killPty(id, "pane-unmount")`; `mark_stopped_at` writes only while the record is still `Live`,
  // so FIRST WRITER WINS. Killing after the removal let the unmount win and recorded a human's ×
  // as automation — the same race already fixed on the build-agent path (roborev 64259). Dispatched
  // here, awaited below, so the row still disappears without waiting on the PTY.
  const kill = killPty(args.workerId, args.stoppedBy ?? "worker-spin-down").catch((e) =>
    console.warn("spinDownWorker: killPty failed", e),
  );
  useRuntimeStore.getState().close(args.workerId);
  useProjectStore.getState().removeAgent(args.projectId, args.workerId);
  // Then the slow disk teardown — still AWAITED so the orchestrator's spin_down reply only resolves
  // once the PTY is dead and the worktree is gone. Errors are swallowed so a partially-gone worker
  // still finishes; warn so a failed kill / removal (a transient git error leaving an orphan) shows.
  await kill;
  // SNAPSHOT BEFORE THE DELETE (`snapshotWip`). The worker's BRANCH survives a spin-down; its
  // WORKTREE does not — so anything the worker edited but never committed is destroyed here,
  // silently and with nothing left to salvage from. That is not hypothetical: an app restart killed
  // two workers whose ~870 lines existed only as uncommitted worktree edits, and only a by-hand
  // rescue before teardown saved them (bead sparkle-ovzoj).
  //
  // The snapshot happens INSIDE removeAgentWorkspace, after it settles the env seed and the
  // dependency bootstrap — both of which are still writing into this worktree until then. It is
  // reached only after the PTY kill above, so a live worker is no longer typing into what it reads.
  await removeAgentWorkspace(project.rootPath, args.projectId, args.workerId, {
    snapshotWip: true,
  }).catch((e) => console.warn("spinDownWorker: removeAgentWorkspace failed", e));
}
