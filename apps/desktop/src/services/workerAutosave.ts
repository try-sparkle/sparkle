// apps/desktop/src/services/workerAutosave.ts
//
// Periodic WIP autosave — the DURABLE half of "a worker's work must survive being killed" (bead
// sparkle-piliqq; related sparkle-24h6mk).
//
// The teardown WIP snapshot (services/worktree.snapshotBeforeTeardown, bead sparkle-ovzoj) commits a
// worker's uncommitted edits onto its own branch before every ORDERLY teardown (spinDownWorker /
// spinDownAgentGit / close, and the restart reap which routes through spinDownWorker). But an orderly
// teardown is exactly what a HARD death does not run: a session-limit crash, an app kill, or an OOM
// kill just drops the process, so anything a worker merely edited — never committed — lives only in
// the worktree directory. Three workers lost several hundred lines each this way (sparkle-piliqq).
//
// The bead's recommendation is to "commit incrementally rather than only at the end". This enforces
// it at the harness level with a slow background sweep — but it runs while the agent is ALIVE, so it
// must be invisible to that agent. It therefore does NOT reuse the teardown snapshot (a real
// `git add`/`git commit` on the agent's own index and branch, which would corrupt an in-progress
// merge/rebase, clear the uncommitted diff the agent reads, and fire the project's post-commit review
// hook on every tick). Instead it calls `autosaveWorktreeWip`, which anchors the work to a SIDE REF
// (`refs/sparkle-autosave/<agentId>`) built out of band with plumbing that touches neither the
// agent's index/HEAD/branch nor any hook. The side ref survives a hard kill exactly as a branch
// commit would, so the crash-recovery floor is preserved with zero effect on a live agent.

import type { Project } from "../types";
import { useProjectStore } from "../stores/projectStore";
import { autosaveWorktreeWip, type AutosaveOutcome } from "./worktree";

/** Autosave cadence. Deliberately slow: each tick shells out to git once per live agent, and the
 *  point is a recovery FLOOR (at most this much uncommitted work is ever at risk), not a real-time
 *  mirror. 5 minutes mirrors the WebKit-localStorage checkpoint interval. */
export const AUTOSAVE_INTERVAL_MS = 300_000;

/** One agent whose worktree the sweep should snapshot, reduced to what `autosaveWorktreeWip` needs. */
export interface AutosaveCandidate {
  projectId: string;
  agentId: string;
}

/** The result of one sweep: how many candidates we attempted, and how many actually captured work
 *  (a `snapshotted` outcome). `swept` counts attempts, not snapshots, because a clean tree and a
 *  mid-operation skip are the common, healthy cases and must not read as failures. */
export interface AutosaveSweepResult {
  swept: number;
  snapshotted: number;
}

/** The autosave function the sweep calls per candidate — the real one is `autosaveWorktreeWip`,
 *  injected so tests assert the side effect without a live git repo. */
export type AutosaveWip = (projectId: string, agentId: string) => Promise<AutosaveOutcome>;

/** Whether THIS window is the one that should service a given project. Injected (the real predicate
 *  lives in orchestrationListener, which imports this module — passing it avoids a cycle) so that,
 *  as with every other machine-global side effect in the listener, exactly one window autosaves a
 *  given project's worktrees rather than N windows doing redundant work. */
export type OwnsProject = (projectId: string) => Promise<boolean>;

/**
 * Which agents to autosave, PURE so it is unit-testable. An agent qualifies iff Sparkle cut it a
 * worktree (`worktreePath` set) and it is not a plain shell terminal — those are the checkouts that
 * hold uncommitted work a death would strand. Workers are the motivating case (sparkle-piliqq), but a
 * build agent's own worktree is just as exposed, so it is included too. An agent with no worktree is
 * SKIPPED, not autosaved: there is no directory to snapshot.
 *
 * Deliberately NOT filtered by "is the session running": the whole point is a BACKGROUND worker that
 * gets killed, which often has no open tab, so a liveness filter would exclude the exact target. The
 * side-ref design is what makes sweeping a not-currently-running worktree harmless — it writes only a
 * side ref, never the agent's branch or working state, so even a worktree a human is mid-review in is
 * untouched (see `autosaveWorktreeWip`).
 */
export function autosaveCandidates(projects: Project[]): AutosaveCandidate[] {
  const out: AutosaveCandidate[] = [];
  for (const project of projects) {
    for (const a of project.agents) {
      if (a.kind === "shell") continue;
      if (!a.worktreePath) continue;
      out.push({ projectId: project.id, agentId: a.id });
    }
  }
  return out;
}

/** Keep only candidates whose project THIS window owns. Resolves ownership once per distinct project
 *  (not once per candidate) and treats a throwing probe as "not mine" — the at-most-one-handler
 *  default the spin-down path uses. */
export async function filterOwnedCandidates(
  candidates: AutosaveCandidate[],
  ownsProject: OwnsProject,
): Promise<AutosaveCandidate[]> {
  const decision = new Map<string, boolean>();
  const out: AutosaveCandidate[] = [];
  for (const c of candidates) {
    let owned = decision.get(c.projectId);
    if (owned === undefined) {
      owned = await ownsProject(c.projectId).catch(() => false);
      decision.set(c.projectId, owned);
    }
    if (owned) out.push(c);
  }
  return out;
}

/**
 * Run ONE sweep over `candidates`, snapshotting each one's uncommitted work best-effort. Never
 * throws: a per-candidate rejection is logged and the sweep continues, because one wedged worktree
 * must not stop the others from being protected.
 */
export async function sweepOnce(
  candidates: AutosaveCandidate[],
  autosave: AutosaveWip,
): Promise<AutosaveSweepResult> {
  let snapshotted = 0;
  for (const c of candidates) {
    try {
      const r = await autosave(c.projectId, c.agentId);
      if (r.kind === "snapshotted") {
        snapshotted++;
        console.info(
          `workerAutosave: checkpointed ${r.files} uncommitted path(s) for ${c.agentId} to ` +
            `${r.refName ?? "(ref unreadable — the snapshot was made)"} as ` +
            `${r.sha ?? "(sha unreadable)"}`,
        );
      }
    } catch (e) {
      console.warn(`workerAutosave: snapshot failed for ${c.agentId}; continuing`, e);
    }
  }
  return { swept: candidates.length, snapshotted };
}

interface AutosaveHandle {
  timer: ReturnType<typeof setInterval> | null;
  running: boolean;
  getProjects: () => Project[];
  autosave: AutosaveWip;
  ownsProject: OwnsProject;
  intervalMs: number;
}

// Single active autosave per app window, module-local so start/stop are simple imperative calls the
// orchestration listener wires to its own lifecycle.
let active: AutosaveHandle | null = null;

/** Options for {@link startWorkerAutosave}; every field is injectable so tests drive the loop with a
 *  fake clock and mocks, and production supplies the real store, `autosaveWorktreeWip`, and the
 *  listener's window-ownership predicate. */
export interface StartAutosaveOptions {
  intervalMs?: number;
  getProjects?: () => Project[];
  autosave?: AutosaveWip;
  ownsProject?: OwnsProject;
}

/**
 * Start the periodic autosave. Idempotent-by-replacement: a second call stops the first. Does NOT
 * fire an immediate sweep — the tree was just committed-or-clean at spawn/adopt time, and a
 * synchronous sweep at listener startup would pile git onto the already-busy launch path; the first
 * checkpoint lands one interval in, which is the recovery floor this provides.
 */
export function startWorkerAutosave(opts: StartAutosaveOptions = {}): void {
  stopWorkerAutosave();
  const handle: AutosaveHandle = {
    timer: null,
    running: false,
    getProjects: opts.getProjects ?? (() => useProjectStore.getState().projects),
    autosave: opts.autosave ?? autosaveWorktreeWip,
    ownsProject: opts.ownsProject ?? (async () => true),
    intervalMs: opts.intervalMs ?? AUTOSAVE_INTERVAL_MS,
  };
  active = handle;

  const tick = async () => {
    // Re-entrancy guard: a slow sweep must not overlap the next interval.
    if (handle.running || active !== handle) return;
    handle.running = true;
    try {
      const owned = await filterOwnedCandidates(
        autosaveCandidates(handle.getProjects()),
        handle.ownsProject,
      );
      if (active === handle) await sweepOnce(owned, handle.autosave);
    } finally {
      handle.running = false;
    }
  };

  handle.timer = setInterval(() => void tick(), handle.intervalMs);
}

/** Stop the active autosave (idempotent). Safe to call in teardown even if none is running. */
export function stopWorkerAutosave(): void {
  if (active?.timer) clearInterval(active.timer);
  active = null;
}

/** Test/introspection helper: is an autosave loop currently active? */
export function isWorkerAutosaveRunning(): boolean {
  return active !== null;
}
