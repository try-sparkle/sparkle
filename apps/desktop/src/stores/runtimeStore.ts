// runtimeStore — state for agents that are currently open. `status` (drives tab color) and
// `branchStatus` (live ahead/behind/dirty/size) are live-only and can't be restored.
// `openAgentIds` (which agents are "live": PTY spawned, pane mounted, kept alive across
// tab/project switches) IS persisted, so quit/relaunch re-opens the same agents and each
// Claude session resumes via `claude --continue` (bead ).
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { AgentTabStatus } from "../types";
import type { BranchStatus, WorkflowState, AgentStatusResult } from "../services/branchStatus";
import type { WorkflowStageId } from "../engine/workflowStage";
import { agentBranchStatus, agentWorkflowState, projectAgentsStatus } from "../services/branchStatus";
import { deriveLiveStage, stageIndex } from "../engine/workflowStage";
import { beadLifecycleActions, levelAfter, BEAD_LEVEL } from "../engine/beadLifecycle";
import { createBead, claimBead, closeBead, markBeadDelivered } from "../services/beads";
import { syncProjectMarkdown } from "../services/chiefSync";
import { useSettingsStore, effectiveChiefPat } from "./settingsStore";
import { useProjectStore } from "./projectStore";
import { useInteractionStore } from "./interactionStore";

/** Trailing-debounce window per project. The branch-status poll fires often (mount + the ~30s
 *  connectivity probe); we coalesce those into one sync after a quiet window so a burst of commits
 *  uploads once, not once-per-commit. Content-hash dedup in syncProjectMarkdown makes an unchanged
 *  run a no-op regardless. */
export const CHIEF_SYNC_DEBOUNCE_MS = 10_000;

// Per-project failure backoff (, re-keyed from per-agent). When Chief is unreachable the
// sync throws ("Load failed"); without this a dead endpoint gets retried every debounced run for the
// app's lifetime. After a failure we skip this project's sync until an exponential, capped cooldown
// elapses; the next successful round-trip clears it.
//
// : even with the cap the sync retried forever (~one log line per 5 min per project ≈
// 1.2k/day across the open projects) and the user got no signal their Think library was stale. So
// after SYNC_GIVE_UP_FAILS consecutive failures we GIVE UP the tight retry loop and drop to a quiet
// hourly re-probe (SYNC_GIVEUP_COOLDOWN_MS) — enough to self-heal when the endpoint returns, without
// hammering it or the log. Logging is bounded to the first failure and the give-up transition; the
// slow re-probes stay silent.
const SYNC_BACKOFF_BASE_MS = 5_000;
const SYNC_BACKOFF_CAP_MS = 5 * 60_000;
const SYNC_GIVE_UP_FAILS = 10; // ~20 min of escalating retries (incl. a few at the 5-min cap)…
const SYNC_GIVEUP_COOLDOWN_MS = 60 * 60_000; // …then back off to a quiet hourly re-probe.
const syncBackoff = new Map<string, { until: number; fails: number }>();

// :  bounded a CONSECUTIVE-failure streak (give up after 10 in a row). But an
// intermittently flapping endpoint (fail → success → fail …) resets `fails` to 0 on every success
// (syncBackoff is deleted), so the give-up transition is never reached and the `fails === 1`
// first-failure line re-fires on every flap — real logs show this dribbling out for the app's
// lifetime. We gate that line on a per-project quiet window that, unlike syncBackoff, is NOT cleared
// by success, so a flapping endpoint logs at most once per window (you still get the unhealthy
// signal, just not once per flap).
const SYNC_FAIL_RELOG_QUIET_MS = 60 * 60_000;
const syncFailLoggedAt = new Map<string, number>();

/** Test-only: clear the Chief-sync backoff state between cases. */
export function __resetChiefSyncBackoff(): void {
  syncBackoff.clear();
  syncFailLoggedAt.clear();
}

// : once an agent's worktree is removed (agent cleanup), the 30s branch-status poll
// keeps shelling out `git status` against the deleted directory — failing every tick with
// "cannot change to <dir>: No such file or directory" / "not a git repository". That wastes a
// subprocess per tick and floods the log for the app's lifetime (~150 failed polls across a few
// days in real session logs). A removed worktree never comes back for the same agent id (ids are
// unique, worktrees are torn down for good), so we latch the agent into a session-scoped skip-set
// on the first such failure and never re-poll it. The set resets on relaunch (the store boots
// clean), which is correct — a stale id simply isn't polled again.
const deadWorktrees = new Set<string>();

// The batched status command (project_agents_status) skips fingerprint-unchanged idle agents and
// returns `changed:false` for them, relying on the JS store keeping its prior branchStatus. But the
// Rust fingerprint cache is a process-lifetime static while `branchStatus` is live-only and boots
// EMPTY when this module re-executes (a webview reload/HMR that doesn't restart the Rust process).
// Without this, the first post-reload poll would skip every idle agent and leave branchStatus empty
// until some ref moves. So we FORCE a full recompute on the first poll after (re)init, which
// repopulates branchStatus (and refreshes the Rust cache) exactly once; steady-state polls then skip
// normally. The module-level flag resets whenever the module re-executes, matching the store reset.
let firstProjectStatusPollDone = false;

/** Does this git error mean the agent's worktree directory is gone (vs. a transient hiccup)? The
 *  latch is terminal (no re-poll until relaunch), so we match ONLY the structural signatures git
 *  emits when its CWD is gone — `cannot change to <dir>` (git's chdir-to-CWD failure) or `not a git
 *  repository` — and deliberately NOT a bare "no such file or directory", which an unrelated missing
 *  pathspec/config could trip. A false negative costs one more failed poll; a false positive would
 *  silently stop polling for the app's lifetime. */
export function isWorktreeGoneError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /cannot change to/i.test(msg) || /not a git repository/i.test(msg);
}

/** Does this `bd update --claim` error mean the bead is already CLOSED (so a claim is a no-op)? bd
 *  rejects claiming a non-open issue with "issue not claimable: status closed". This is NOT a
 *  retryable failure: a bead closed in a PRIOR session has its in-memory lifecycle watermark reset on
 *  relaunch, so syncBeadLifecycle would re-attempt the claim (and re-fail) every poll for the app's
 *  lifetime. Match BOTH the "not claimable" verb and the "closed" status so a claim rejected for any
 *  other reason (e.g. a blocked issue, level < closed) still surfaces rather than being mis-latched. */
export function isBeadAlreadyClosedError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /not claimable/i.test(msg) && /closed/i.test(msg);
}

/** Test-only: clear the removed-worktree skip-set between cases. */
export function __resetDeadWorktrees(): void {
  deadWorktrees.clear();
}

interface PendingSync {
  timer: ReturnType<typeof setTimeout>;
  agentId: string;
}
const pendingByProject = new Map<string, PendingSync>();
// One sync per project at a time. Project-level (not per-agent) because asset identity is now
// keyed by (Chief project, path) — two agents must not race to seed the same paths.
const syncingProjects = new Set<string>();

/** Schedule a debounced Chief sync for a project. Resets the timer on each call. */
export function scheduleChiefSync(projectId: string, agentId: string): void {
  const existing = pendingByProject.get(projectId);
  if (existing) clearTimeout(existing.timer);
  const timer = setTimeout(() => {
    pendingByProject.delete(projectId);
    void runChiefSync(projectId, agentId);
  }, CHIEF_SYNC_DEBOUNCE_MS);
  pendingByProject.set(projectId, { timer, agentId });
}

/** Push the project's current markdown to its Chief library (current-state model). Best-effort:
 *  a Chief/git hiccup must not break the UI, and an un-persisted ledger simply retries next run. */
export async function runChiefSync(projectId: string, agentId: string): Promise<void> {
  const settings = useSettingsStore.getState();
  const pat = effectiveChiefPat(settings.chiefPat, settings.runtimeChiefPat);
  if (!pat) return;
  const project = useProjectStore.getState().projects.find((p) => p.id === projectId);
  if (!project) return;
  // Read markdown from a real worktree — prefer the triggering agent, else any workflow agent.
  // think + shell agents have no worktree (mirrors the predicate in refreshWorkflowStage).
  const hasWorktree = (kind: string) => kind !== "think" && kind !== "shell";
  const triggering = project.agents.find((a) => a.id === agentId);
  const syncAgent =
    triggering && hasWorktree(triggering.kind)
      ? triggering
      : project.agents.find((a) => hasWorktree(a.kind));
  if (!syncAgent) return;
  if (syncingProjects.has(projectId)) return;
  const backoff = syncBackoff.get(projectId);
  if (backoff && Date.now() < backoff.until) return; // cooling down after a recent failure
  syncingProjects.add(projectId);
  try {
    const chiefProjectId = settings.chiefProjectByProject[projectId];
    const res = await syncProjectMarkdown({
      pat,
      sparkleProjectId: projectId,
      projectName: project.name,
      agentId: syncAgent.id,
      chiefProjectId,
      docState: chiefProjectId ? (settings.chiefDocStateByProject[chiefProjectId] ?? {}) : {},
    });
    syncBackoff.delete(projectId); // round-trip succeeded → endpoint healthy, reset backoff
    if (!res) return;
    if (res.chiefProjectId && res.chiefProjectId !== chiefProjectId) {
      settings.setChiefProject(projectId, res.chiefProjectId);
    }
    // Only persist the ledger when something actually changed — avoids a zustand state update +
    // localStorage write on every poll cycle when the tree is unchanged.
    if (res.chiefProjectId && (res.uploaded.length || res.deletedAssetIds.length)) {
      settings.setChiefProjectDocState(res.chiefProjectId, res.docState);
    }
  } catch (e) {
    // Back off so we don't retry a dead endpoint every run; the un-persisted ledger is reattempted
    // once the cooldown elapses. After SYNC_GIVE_UP_FAILS in a row, give up the tight loop and drop
    // to a quiet hourly re-probe ().
    // `fails` intentionally keeps climbing past SYNC_GIVE_UP_FAILS during a long outage: the
    // give-up log keys on the exact `=== SYNC_GIVE_UP_FAILS` transition, so it fires once and stays
    // quiet thereafter. (A success deletes the entry below, resetting the count to 0.)
    const fails = (syncBackoff.get(projectId)?.fails ?? 0) + 1;
    const delay =
      fails >= SYNC_GIVE_UP_FAILS
        ? SYNC_GIVEUP_COOLDOWN_MS
        : Math.min(SYNC_BACKOFF_BASE_MS * 2 ** (fails - 1), SYNC_BACKOFF_CAP_MS);
    syncBackoff.set(projectId, { until: Date.now() + delay, fails });
    // Bound the log: emit only on the first failure (the signal) and the give-up transition, not on
    // every silent retry in between — that per-run flood is the whole bug (). The
    // first-failure line is ALSO gated on a per-project quiet window (): an intermittent
    // flap resets `fails` to 0 on each success, so without this the first-failure line re-fired on
    // every flap and the give-up transition was never reached. The window is NOT cleared by success,
    // so a flapping endpoint logs at most once per SYNC_FAIL_RELOG_QUIET_MS.
    if (fails === 1) {
      const lastLogged = syncFailLoggedAt.get(projectId) ?? 0;
      if (Date.now() - lastLogged >= SYNC_FAIL_RELOG_QUIET_MS) {
        syncFailLoggedAt.set(projectId, Date.now());
        console.debug("chief project sync failed for", projectId, "— backing off", e);
      }
    } else if (fails === SYNC_GIVE_UP_FAILS) {
      console.debug(
        "chief project sync giving up for",
        projectId,
        `after ${fails} consecutive failures; dropping to hourly re-probe`,
      );
    }
  } finally {
    syncingProjects.delete(projectId);
  }
}

// In-flight bead-create guard: createBead is async, so two rapid polls could both see a build agent
// with no beadId and create duplicate beads. Latch the agent id while a create is in flight.
const creatingBeadFor = new Set<string>();
// Agents whose auto-create returned null (bd ran but we couldn't parse an id). Without this we'd
// re-enter the create branch every poll and spawn ORPHAN beads. Back off (no retry until relaunch)
// rather than accrete duplicates.
const beadCreateFailed = new Set<string>();
// agentId -> highest bead lifecycle level (BEAD_LEVEL) we've successfully written. Makes the writes
// MONOTONIC: no double in_progress, and a re-climbing "new cycle" can't re-close/re-deliver a bead.
// In-memory (resets on relaunch); the persisted `workflowShipped` ✓ re-seeds it on first observation
// (see syncBeadLifecycle) so a relaunch can't REOPEN an already-shipped bead by writing in_progress
// onto a re-climbing cycle.
const beadLevelFor = new Map<string, number>();

/** Forget an agent's bead-lifecycle bookkeeping when it's closed/removed, so these module maps don't
 *  grow unbounded over a long session (and a recycled id can't inherit a stale watermark/latch). */
function forgetBeadLifecycle(agentId: string): void {
  beadLevelFor.delete(agentId);
  beadCreateFailed.delete(agentId);
  creatingBeadFor.delete(agentId);
}

/** Test-only: reset the module-level lifecycle bookkeeping between cases. */
export function __resetBeadLifecycleForTest(): void {
  beadLevelFor.clear();
  beadCreateFailed.clear();
  creatingBeadFor.clear();
}

/** Advance a deliverable agent's bead from its current workflow STAGE, monotonically and best-effort
 *  (fire-and-forget; never blocks or breaks the poll). Decision logic is the pure, unit-tested
 *  `beadLifecycleActions`; this wrapper performs the chosen actions' shell-outs and only advances the
 *  per-agent watermark AFTER each write succeeds (so a partial failure — e.g. the delivered label —
 *  is retried on the next poll). */
export async function syncBeadLifecycle(
  projectId: string,
  projectPath: string,
  agent: { id: string; kind: string; beadId?: string; name?: string },
  stage: WorkflowStageId,
  bs: BranchStatus | undefined,
  shippedLatched: boolean,
): Promise<void> {
  const hasRealWork = !!bs && (bs.ahead > 0 || bs.dirty);
  // Seed the watermark from the persisted shipped ✓: if this agent's work ever reached main, its bead
  // is at least closed — so a relaunch that sees a re-climbing cycle (stage back at building) never
  // writes in_progress onto it and reopens it. In-memory progress still wins when it's further along.
  const seeded = Math.max(beadLevelFor.get(agent.id) ?? 0, shippedLatched ? BEAD_LEVEL.closed : 0);
  const actions = beadLifecycleActions({
    kind: agent.kind,
    hasBead: !!agent.beadId,
    hasRealWork,
    stage,
    writtenLevel: seeded,
  });
  if (actions.length === 0) return;
  try {
    let beadId = agent.beadId;
    for (const action of actions) {
      if (action === "create") {
        if (beadId || beadCreateFailed.has(agent.id) || creatingBeadFor.has(agent.id)) return;
        creatingBeadFor.add(agent.id);
        try {
          const title = agent.name?.trim() || "Build agent";
          const newId = await createBead(
            projectPath,
            title,
            "Auto-created by Sparkle for a deliverable Build agent.",
          );
          if (!newId) {
            // bd ran but its output didn't yield an id — don't retry (would orphan a bead per poll).
            beadCreateFailed.add(agent.id);
            return;
          }
          beadId = newId;
          useProjectStore.getState().setAgentBeadId(projectId, agent.id, newId);
        } finally {
          creatingBeadFor.delete(agent.id);
        }
        continue;
      }
      if (!beadId) return;
      // Map the engine's monotonic actions to bd's canonical verbs (claim=in_progress+assignee,
      // close, label-then-close=delivered).
      if (action === "in_progress") {
        try {
          await claimBead(projectPath, beadId);
        } catch (e) {
          // A bead CLOSED in a prior session can't be claimed ("not claimable: status closed"). Its
          // in-memory watermark reset on relaunch, so without this we'd re-attempt the claim — and
          // re-fail — every poll forever. The bead is already PAST in_progress: latch the watermark
          // at `closed` (never reopen it — the forward-only invariant) and stop. Re-throw anything
          // else so a genuine claim failure still retries next poll.
          if (!isBeadAlreadyClosedError(e)) throw e;
          beadLevelFor.set(agent.id, Math.max(beadLevelFor.get(agent.id) ?? 0, BEAD_LEVEL.closed));
          continue;
        }
      } else if (action === "closed") await closeBead(projectPath, beadId);
      else if (action === "delivered") await markBeadDelivered(projectPath, beadId);
      // Advance the watermark only after the write resolved, so a throw retries it next poll.
      beadLevelFor.set(agent.id, Math.max(beadLevelFor.get(agent.id) ?? 0, levelAfter(action)));
    }
  } catch (e) {
    console.debug("syncBeadLifecycle failed for", agent.id, e);
  }
}

/** Apply a freshly-fetched WorkflowState to an agent: derive its live stage, advance the stored stage
 *  if it moved forward, drive its bead lifecycle (create/claim/close/deliver), and latch the sticky
 *  shipped ✓. Extracted so the per-agent `refreshWorkflowStage` and the batched `pollProjectStatus`
 *  share ONE code path — the only difference between them is how `ws` is fetched (sparkle-zlic). */
async function applyWorkflowState(
  projectId: string,
  rootPath: string,
  agent: { id: string; kind: string; beadId?: string; name?: string; parentId?: string | null },
  ws: WorkflowState,
): Promise<void> {
  const store = useRuntimeStore;
  const prev = store.getState().workflowStage[agent.id] ?? null;
  // A worker's "Merged" = its orchestrator's OWN work has reached main. Read the parent's stored
  // stage (set by its own poll — orchestrators are applied first each tick); eventually consistent.
  let parentReachedMain = false;
  if (agent.kind === "worker" && agent.parentId) {
    const ps = store.getState().workflowStage[agent.parentId];
    parentReachedMain = ps ? stageIndex(ps) >= stageIndex("merged") : false;
  }
  const next = deriveLiveStage({
    kind: agent.kind,
    bs: store.getState().branchStatus[agent.id],
    ws,
    prev,
    parentReachedMain,
    // Live Pushed/Shipped signals from the Rust workflow state (sparkle-v7d0). Without these the
    // "Pushed" stage only lit via a PR probe and "Shipped" was unreachable; deriveLiveStage gates
    // both on committedSeen so a no-op branch can't skip stages.
    pushed: ws.pushed,
    shipped: ws.shipped,
    // A bead-bound agent floors at Planned before any code work exists.
    hasBead: !!agent.beadId,
  });
  if (next !== prev) store.getState().setWorkflowStage(agent.id, next);
  // Drive the agent's bead from its current stage (fire-and-forget; monotonic + idempotent).
  void syncBeadLifecycle(
    projectId,
    rootPath,
    agent,
    next,
    store.getState().branchStatus[agent.id],
    !!store.getState().workflowShipped[agent.id],
  );
  // Sticky "shipped" watermark: latch true the first time work reaches On Main (or beyond).
  if (
    stageIndex(next) >= stageIndex("merged") &&
    !store.getState().workflowShipped[agent.id]
  ) {
    store.getState().setWorkflowShipped(agent.id, true);
  }
}

interface RuntimeState {
  status: Record<string, AgentTabStatus>; // agentId -> status (live-only, never persisted)
  // agentId -> the terminal screen text captured the moment the agent entered an "ask" status
  // (waiting/approval), so the notification path can summarize WHAT it's asking. Live-only (never
  // persisted, like `status`); cleared whenever `status` is cleared for an agent.
  attentionScreen: Record<string, string>;
  openAgentIds: string[]; // agents whose pane is mounted + PTY alive (persisted)
  branchStatus: Record<string, BranchStatus>; // agentId -> live ahead/behind/dirty/size (live-only)
  // agentId -> the furthest workflow stage we KNOW this agent's OWN work has reached. Derived each
  // poll from local-ref reachability + an opportunistic GitHub PR probe (see refreshWorkflowStage /
  // engine.deriveLiveStage), advanced monotonically. The sidebar overlays it on the git-derived
  // stage (resolveStage) and rolls workers up into their orchestrator. PERSISTED: this is the
  // `prev` watermark deriveLiveStage relies on to absorb the post-merge `ahead→0` dip — without it,
  // a NORMAL-merged branch reads back as building_unsaved on the next launch (committedSeen=false
  // once ahead/aheadOfBase are 0 and prev is gone). Pruned to live agents on reconcile().
  workflowStage: Record<string, WorkflowStageId>;
  // agentId -> has this agent's OWN work EVER reached "main" or beyond. A sticky watermark (set once,
  // never cleared until the agent closes) so the row keeps a "shipped ✓" even after the live stage
  // RESETS to a new cycle (deriveLiveStage drops back to Committed when fresh work lands on a branch
  // that already shipped). PERSISTED alongside workflowStage so the ✓ survives a relaunch.
  workflowShipped: Record<string, boolean>;

  open: (agentId: string) => void;
  close: (agentId: string) => void;
  /** Clear an agent's live status + branch status + workflow stage/shipped watermark WITHOUT
   *  removing it from the open set. Called when a slot starts a FRESH run (nothing to resume) so a
   *  reused worktree doesn't inherit the prior occupant's progress (incl. the sticky "shipped ✓").
   *  Unlike `close`, the pane stays mounted; the new session repopulates status from its own hooks. */
  resetProgress: (agentId: string) => void;
  setStatus: (agentId: string, status: AgentTabStatus) => void;
  /** Store the terminal screen captured when an agent entered an "ask" status, for the notification
   *  summarizer. Live-only (mirrors `status`). */
  setAttentionScreen: (agentId: string, text: string) => void;
  setBranchStatus: (agentId: string, s: BranchStatus) => void;
  setWorkflowStage: (agentId: string, stage: WorkflowStageId) => void;
  setWorkflowShipped: (agentId: string, shipped: boolean) => void;
  /** Fetch + store this agent's branch status. Best-effort: a transient git error is swallowed
   *  so the UI never breaks. */
  pollBranchStatus: (
    root: string,
    projectId: string,
    agentId: string,
    baseBranch: string,
  ) => Promise<void>;
  /** Re-derive this agent's OWN workflow stage from local-ref reachability + a best-effort GitHub
   *  PR probe, and advance the stored stage if it moved forward. Best-effort: swallows git/gh
   *  errors. Skips think/shell agents (no git workflow). */
  refreshWorkflowStage: (root: string, projectId: string, agentId: string) => Promise<void>;
  /** Poll branch + workflow status for MANY of a project's agents in ONE batched Rust call
   *  (sparkle-zlic), instead of fanning out ~3-4 subprocesses per agent every tick. Applies each
   *  changed agent's branch status + workflow/bead lifecycle (orchestrators first, so a worker's
   *  derive reads its parent's fresh stage), skips unchanged ones, and schedules ONE Chief sync for
   *  the project. `probePrState` gates the origin fetch + gh PR probe. Best-effort: swallows errors. */
  pollProjectStatus: (
    root: string,
    projectId: string,
    agents: Array<{
      id: string;
      kind: string;
      baseBranch: string;
      parentBranch: string;
      beadId?: string;
      name?: string;
      parentId?: string | null;
      force: boolean;
    }>,
    probePrState: boolean,
  ) => Promise<void>;
  isOpen: (agentId: string) => boolean;
  /** Drop any open ids whose agent no longer exists (e.g. deleted between
   * launches). Call once on boot with the ids of all agents in projectStore. */
  reconcile: (validIds: string[]) => void;
}

export const useRuntimeStore = create<RuntimeState>()(
  persist(
    (set, get) => ({
      status: {},
      attentionScreen: {},
      openAgentIds: [],
      branchStatus: {},
      workflowStage: {},
      workflowShipped: {},

      open: (agentId) =>
        set((s) =>
          s.openAgentIds.includes(agentId)
            ? s
            : { openAgentIds: [...s.openAgentIds, agentId] },
        ),

      close: (agentId) =>
        set((s) => {
          forgetBeadLifecycle(agentId); // drop module-level bead bookkeeping for this agent
          useInteractionStore.getState().forget(agentId); // …and its last-interaction timestamp
          const { [agentId]: _removed, ...status } = s.status;
          const { [agentId]: _scr, ...attentionScreen } = s.attentionScreen;
          const { [agentId]: _bs, ...branchStatus } = s.branchStatus;
          const { [agentId]: _ws, ...workflowStage } = s.workflowStage;
          const { [agentId]: _shipped, ...workflowShipped } = s.workflowShipped;
          return {
            openAgentIds: s.openAgentIds.filter((id) => id !== agentId),
            status,
            attentionScreen,
            branchStatus,
            workflowStage,
            workflowShipped,
          };
        }),

      resetProgress: (agentId) =>
        set((s) => {
          // Also forget the module-level bead watermark/latches so a reused slot doesn't inherit the
          // prior occupant's lifecycle state (esp. now that workflowShipped is persisted).
          forgetBeadLifecycle(agentId);
          const { [agentId]: _st, ...status } = s.status;
          const { [agentId]: _scr, ...attentionScreen } = s.attentionScreen;
          const { [agentId]: _bs, ...branchStatus } = s.branchStatus;
          const { [agentId]: _ws, ...workflowStage } = s.workflowStage;
          const { [agentId]: _shipped, ...workflowShipped } = s.workflowShipped;
          // Note: openAgentIds is intentionally untouched — the pane stays mounted for the new run.
          return { status, attentionScreen, branchStatus, workflowStage, workflowShipped };
        }),

      setStatus: (agentId, status) =>
        set((s) => ({ status: { ...s.status, [agentId]: status } })),

      setAttentionScreen: (agentId, text) =>
        set((s) => ({ attentionScreen: { ...s.attentionScreen, [agentId]: text } })),

      setBranchStatus: (agentId, s) =>
        set((st) => ({ branchStatus: { ...st.branchStatus, [agentId]: s } })),

      setWorkflowStage: (agentId, stage) =>
        set((st) => ({ workflowStage: { ...st.workflowStage, [agentId]: stage } })),

      setWorkflowShipped: (agentId, shipped) =>
        set((st) => ({ workflowShipped: { ...st.workflowShipped, [agentId]: shipped } })),

      pollBranchStatus: async (root, projectId, agentId, baseBranch) => {
        // A removed worktree never returns for the same agent id — skip it permanently ().
        if (deadWorktrees.has(agentId)) return;
        try {
          const s = await agentBranchStatus(root, projectId, agentId, baseBranch);
          get().setBranchStatus(agentId, s);
          // Piggyback the Chief markdown sync on the same signal a commit would refresh —
          // debounced + coalesced per project.
          scheduleChiefSync(projectId, agentId);
          // …and advance the workflow tracker from reachability + an opportunistic PR probe. Runs
          // after setBranchStatus so deriveLiveStage sees this tick's fresh ahead/dirty counts.
          void get().refreshWorkflowStage(root, projectId, agentId);
        } catch (e) {
          // A gone worktree is terminal — latch it so we stop re-polling a deleted directory every
          // tick (). Anything else is a transient git error: log at debug level (so a
          // persistent structural failure — e.g. a bad baseBranch — is still diagnosable) and retry.
          if (isWorktreeGoneError(e)) {
            deadWorktrees.add(agentId);
            return;
          }
          console.debug("pollBranchStatus failed for", agentId, e);
        }
      },

      refreshWorkflowStage: async (root, projectId, agentId) => {
        try {
          const project = useProjectStore.getState().projects.find((p) => p.id === projectId);
          const agent = project?.agents.find((a) => a.id === agentId);
          // No worktree / no git workflow → nothing to track.
          if (!project || !agent || agent.kind === "think" || agent.kind === "shell") return;
          // A worker integrates into its orchestrator's branch; everyone else, into project main.
          const parentBranch =
            agent.kind === "worker" && agent.parentId ? `sparkle/agent-${agent.parentId}` : "";
          const ws = await agentWorkflowState(root, agentId, parentBranch, true);
          // Derive stage + drive bead lifecycle + latch shipped ✓ (shared with pollProjectStatus).
          await applyWorkflowState(projectId, project.rootPath, agent, ws);
        } catch (e) {
          console.debug("refreshWorkflowStage failed for", agentId, e);
        }
      },

      pollProjectStatus: async (root, projectId, agents, probePrState) => {
        // Drop agents already latched as gone () so a removed worktree isn't re-polled.
        const live = agents.filter((a) => !deadWorktrees.has(a.id));
        if (live.length === 0) return;
        const project = useProjectStore.getState().projects.find((p) => p.id === projectId);
        if (!project) return;
        // Force every agent to recompute on the FIRST poll after (re)init so the live-only, boots-empty
        // branchStatus map is repopulated even when the Rust fingerprint cache survived a reload (see
        // firstProjectStatusPollDone). Steady-state polls honor each agent's own `force`.
        const forceAll = !firstProjectStatusPollDone;
        let results: AgentStatusResult[];
        try {
          results = await projectAgentsStatus(
            root,
            projectId,
            live.map((a) => ({
              agentId: a.id,
              baseBranch: a.baseBranch,
              parentBranch: a.parentBranch,
              kind: a.kind,
              force: a.force || forceAll,
            })),
            probePrState,
          );
        } catch (e) {
          console.debug("pollProjectStatus failed for", projectId, e);
          return;
        }
        firstProjectStatusPollDone = true;
        const infoById = new Map(live.map((a) => [a.id, a]));
        // Apply orchestrators (build) BEFORE workers so a worker's deriveLiveStage reads its parent's
        // fresh stage this same tick — matching the old parents-first-then-rest poll ordering.
        const rank = (id: string) => (infoById.get(id)?.kind === "build" ? 0 : 1);
        const ordered = [...results].sort((x, y) => rank(x.agentId) - rank(y.agentId));
        for (const r of ordered) {
          if (!r.changed) continue; // unchanged since last tick → keep prior store values
          if (r.branch) get().setBranchStatus(r.agentId, r.branch);
          const info = infoById.get(r.agentId);
          if (r.workflow && info) {
            await applyWorkflowState(
              projectId,
              project.rootPath,
              { id: info.id, kind: info.kind, beadId: info.beadId, name: info.name, parentId: info.parentId },
              r.workflow,
            );
          }
        }
        // ONE debounced Chief sync for the whole project (the same signal a commit would refresh),
        // rather than one per agent as the old per-agent pollBranchStatus fan-out did.
        const syncAgent = live.find((a) => a.kind !== "think" && a.kind !== "shell");
        if (syncAgent) scheduleChiefSync(projectId, syncAgent.id);
      },

      isOpen: (agentId) => get().openAgentIds.includes(agentId),

      reconcile: (validIds) =>
        set((s) => {
          const valid = new Set(validIds);
          // Sweep module-level bead bookkeeping for agents that no longer exist (bounds growth).
          // Union of BOTH maps: a build agent whose create returned null is in beadCreateFailed but
          // never gets a beadLevelFor entry, so iterating beadLevelFor alone would leak it.
          for (const id of new Set([...beadLevelFor.keys(), ...beadCreateFailed.keys()])) {
            if (!valid.has(id)) forgetBeadLifecycle(id);
          }
          // Prune the per-agent last-interaction map to live agents too (same unbounded-growth
          // concern as the bead maps; the map only ever grew before).
          useInteractionStore.getState().reconcile(validIds);
          const openAgentIds = s.openAgentIds.filter((id) => valid.has(id));
          // Prune the now-PERSISTED workflow maps to agents that still exist, so a deleted agent's
          // stale stage/shipped ✓ can't linger forever in localStorage (and can't resurface if its
          // id is ever reused). Live-only maps (status/branchStatus) boot empty so need no pruning.
          const pruneMap = <V>(m: Record<string, V>): Record<string, V> => {
            const out: Record<string, V> = {};
            for (const id of Object.keys(m)) if (valid.has(id)) out[id] = m[id] as V;
            return out;
          };
          const stagePruned = Object.keys(s.workflowStage).some((id) => !valid.has(id));
          const shipPruned = Object.keys(s.workflowShipped).some((id) => !valid.has(id));
          const openChanged = openAgentIds.length !== s.openAgentIds.length;
          if (!openChanged && !stagePruned && !shipPruned) return s;
          return {
            ...(openChanged ? { openAgentIds } : {}),
            ...(stagePruned ? { workflowStage: pruneMap(s.workflowStage) } : {}),
            ...(shipPruned ? { workflowShipped: pruneMap(s.workflowShipped) } : {}),
          };
        }),
    }),
    {
      name: "sparkle-runtime",
      storage: createJSONStorage(() => localStorage),
      // The open set, the workflow-stage watermark, and the sticky shipped ✓ survive a relaunch.
      // Persisting the watermark is what lets a merged/shipped agent read back as Merged instead of
      // collapsing to building_unsaved after the post-merge `ahead→0` dip (see workflowStage above /
      // deriveLiveStage `prev`). Live status/branchStatus deliberately boot clean and are excluded.
      partialize: (s) => ({
        openAgentIds: s.openAgentIds,
        workflowStage: s.workflowStage,
        workflowShipped: s.workflowShipped,
      }),
    },
  ),
);
