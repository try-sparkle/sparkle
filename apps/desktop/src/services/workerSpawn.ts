// Programmatically spawn a worker agent under a build agent: register the tab, cut its worktree
// from the parent's local branch, and persist the worktree. The PTY launch happens when the
// worker tab opens (AgentPane), driven by the worker persona + the stored task.
import {
  useProjectStore,
  markWorkerTearingDown,
  clearWorkerTearingDown,
} from "../stores/projectStore";
import { type WorktreeInfo, killPty } from "../pty";
import { prepareWorkerWorkspace, removeAgentWorkspace, writeWorkerManifest } from "./worktree";
import { useRuntimeStore } from "../stores/runtimeStore";
import { maybeAutoName } from "./agentNaming";
import { aiFeatureNow } from "./aiGate";

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

export async function spawnWorker(args: {
  projectId: string;
  parentAgentId: string;
  task: string;
  beadId?: string;
}): Promise<SpawnedWorker> {
  const store = useProjectStore.getState();
  const project = store.projects.find((p) => p.id === args.projectId);
  if (!project) throw new Error(`unknown project ${args.projectId}`);
  const parent = project.agents.find((a) => a.id === args.parentAgentId);
  if (!parent) throw new Error(`unknown parent agent ${args.parentAgentId}`);
  if (!parent.branch) throw new Error("parent agent has no branch yet — open it first");

  // Capture the active tab before addAgent shifts selection to the new worker, so a failed
  // worktree cut can restore the user to where they were instead of landing on agents[0].
  const prevSelectedId = project.selectedAgentId;

  const workerId = store.addAgent(args.projectId, {
    kind: "worker",
    parentId: args.parentAgentId,
    task: args.task,
    parentBranch: parent.branch,
    beadId: args.beadId,
  });

  // Fail-closed rollback (sparkle-a670): drop the orphan tab, restore the user's previously-active
  // tab (removeAgent recomputes selection to agents[0], which may not be where the user was), and —
  // when the worktree was already cut — remove it from disk so no half-registered worktree leaks.
  const rollback = async (removeWorktree: boolean): Promise<void> => {
    if (removeWorktree) {
      await removeAgentWorkspace(project.rootPath, args.projectId, workerId).catch((e) =>
        console.warn("spawnWorker rollback: removeAgentWorkspace failed", e),
      );
    }
    useProjectStore.getState().removeAgent(args.projectId, workerId);
    if (prevSelectedId) {
      useProjectStore.getState().selectAgent(args.projectId, prevSelectedId);
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
 *  build agent's) can still be re-adopted by reconcileWorkersFromDisk while its parent lives, the id
 *  is tombstoned (markWorkerTearingDown) across the reap so the reconcile can't resurrect the row
 *  before the manifest is deleted; the tombstone clears once the worktree (and its manifest) is gone.
 *  Returns after the reap so callers that need the worktree actually gone (handleSpinDown's slot
 *  accounting relies only on the synchronous removeAgent, but the MCP reply should reflect a real
 *  teardown) still await completion. */
export async function spinDownWorker(args: { projectId: string; workerId: string }): Promise<void> {
  const project = useProjectStore.getState().projects.find((p) => p.id === args.projectId);
  if (!project) return;
  const worker = project.agents.find((a) => a.id === args.workerId);
  if (!worker || worker.kind !== "worker") return;
  // Optimistic teardown: drop the row + runtime entry NOW so a contended repo lock can't leave the
  // row lingering. Tombstone the id first so a reconcile that races the background reap can't
  // re-adopt it from its not-yet-deleted manifest.
  markWorkerTearingDown(args.workerId);
  useRuntimeStore.getState().close(args.workerId);
  useProjectStore.getState().removeAgent(args.projectId, args.workerId);
  // Reap OS/git resources after the UI is already updated. Errors are swallowed so a partially-gone
  // worker still finishes teardown; warn so a failed PTY kill / worktree removal (e.g. a transient
  // git error leaving an orphan on disk) is visible. Clear the tombstone only once the worktree —
  // and thus its manifest — is gone, so the reconcile is shielded for the whole window.
  try {
    await killPty(args.workerId).catch((e) => console.warn("spinDownWorker: killPty failed", e));
    await removeAgentWorkspace(project.rootPath, args.projectId, args.workerId).catch((e) =>
      console.warn("spinDownWorker: removeAgentWorkspace failed", e),
    );
  } finally {
    clearWorkerTearingDown(args.workerId);
  }
}
