// runtimeStore — state for agents that are currently open. `status` (drives tab color) and
// `branchStatus` (live ahead/behind/dirty/size) are live-only and can't be restored.
// `openAgentIds` (which agents are "live": PTY spawned, pane mounted, kept alive across
// tab/project switches) IS persisted, so quit/relaunch re-opens the same agents and each
// Claude session resumes via `claude --continue` (bead ).
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { AgentTabStatus, LastObserved } from "../types";
import type { ObservedReading } from "../engine/observedAttention";
import { isRedStatus } from "../services/windowStatus";
import type { BranchStatus, WorkflowState, AgentStatusResult } from "../services/branchStatus";
import type { WorkflowStageId } from "../engine/workflowStage";
import type { MovementEvidence } from "../engine/movementRetraction";
import type { FollowupSignal } from "../services/turnFollowup";
import { agentBranchStatus, agentWorkflowState, projectAgentsStatus } from "../services/branchStatus";
import { deriveLiveStage, stageIndex } from "../engine/workflowStage";
import { crossRepoReading } from "../engine/crossRepo";
import { slugForRoot } from "../services/conciergeTools/repoSlug";
import { beadLifecycleActions, levelAfter, BEAD_LEVEL } from "../engine/beadLifecycle";
import {
  createBead,
  claimBead,
  closeBead,
  markBeadDelivered,
  isBeadsUnavailable,
  AUTO_LABEL,
} from "../services/beads";
import { syncProjectMarkdown, ChiefLibraryClaimedError } from "../services/chiefSync";
import { chiefProjectExists } from "../services/chief";
import { useChiefSyncStore } from "./chiefSyncStore";
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

/**
 * Let ONE project retry immediately, discarding its cooldown.
 *
 * For the re-link path (sparkle-ojgvp): a `project_gone` failure parks the project at the hourly
 * re-probe deliberately, because nothing about a deleted library is transient. Re-linking makes it
 * transient after all — the user just supplied the missing fact — so the cooldown that was correct
 * a moment ago is now the only thing standing between them and a working sync.
 *
 * Deliberately NOT `syncFailLoggedAt`: that window bounds LOG NOISE across flaps and is not cleared
 * by success either (). Clearing it here would let a re-link re-open the log flood.
 */
export function clearChiefSyncBackoff(projectId: string): void {
  syncBackoff.delete(projectId);
}

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
// normally. The module-level state resets whenever the module re-executes, matching the store reset.
//
// PER-AGENT, not per-call (roborev 54750, High). This was a single boolean, and the probed/local
// split introduced by the closed-agent sweep let the PROBED batch consume it before the LOCAL batch
// ever ran: `pollProjectStatus` set it true as soon as the first call returned, so the second call
// saw `forceAll === false` and fell back to per-agent `force`, which is false for a quiet CLOSED
// agent. Because a closed idle agent's refs never move, `branchStatus[id]` then stayed `undefined`
// FOREVER — `resolveStage(undefined)` falls to `building_unsaved` and `withUnmergedWork` never
// fires. That is the exact "a branch full of commits reads as an empty agent" symptom the sweep was
// added to fix, reintroduced on the reload / second-window path (the Rust `status_cache()` is a
// process-global keyed by worktree path, so it is warm across both).
//
// A Set of agent ids is used rather than "capture the flag once per tick" so that a future THIRD
// batch cannot re-open the same hole.
const forcedOnce = new Set<string>();

/** Monotonic count of `setStatus` CALLS per agent, incremented even when the call is a redundant
 *  re-assert of the value already in the map.
 *
 *  WHY IT CANNOT BE DERIVED FROM `status` ITSELF, which is the whole reason it exists. `setStatus`
 *  bails out when the value is unchanged (see there), and zustand skips listener notification
 *  entirely when `set` returns the identical state object — so a producer re-asserting `working`
 *  over a `working` fires no subscriber callback and leaves the map byte-identical. Nothing
 *  downstream of the store can tell that write from no write at all. That matters to anyone who
 *  needs to know whether a value it wrote is STILL ITS OWN (services/improvePassLiveness retracts
 *  the row's `working` only while it is), because "the value is what I left" and "nobody has
 *  written since" are different questions and only the second is safe to act on.
 *
 *  Deliberately OUTSIDE zustand state, like `forcedOnce` above: a counter in the store would make
 *  every redundant tick churn a render, which is exactly what the bail-out was added to stop
 *  (sparkle-f2uz). Cleared in `close()` with the rest of this agent's live-only state. */
const statusWrites = new Map<string, number>();

/** How many times `setStatus` has been CALLED for this agent — see {@link statusWrites}. Redundant
 *  re-asserts count; a never-written agent is 0. */
export function statusWriteCount(agentId: string): number {
  return statusWrites.get(agentId) ?? 0;
}

// roborev 54843 (Medium): `driveLifecycle` gates `maybePromptRoborevConsent`, but the stage
// watermark above it is advanced UNCONDITIONALLY — intentionally, per the sweep's own design (it
// exists to answer "does this branch hold unmerged work?", and the stage watermark is part of that
// answer even for a closed pane). `maybePromptRoborevConsent` is edge-triggered on prev < reviewable
// <= next, so a closed-sweep tick that writes `building_saved` consumes that crossing silently. When
// the pane is later opened, the probed poll sees `prev === next` (both already at the new stage) and
// the modal never fires for that agent — the ONE-TIME roborev consent prompt is lost, not merely
// deferred. This records which agents crossed while un-prompted, so the next `driveLifecycle` poll
// can still raise the modal even though its own prev/next comparison no longer sees a crossing.
const pendingRoborevConsent = new Set<string>();

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
  const sync = useChiefSyncStore.getState();
  const pat = effectiveChiefPat(settings.keychainChiefPat, settings.chiefPat, settings.runtimeChiefPat);
  if (!pat) {
    sync.noteBlocked(projectId, "no_pat");
    return;
  }
  const project = useProjectStore.getState().projects.find((p) => p.id === projectId);
  // Deliberately UNRECORDED: there is no project to render a status against, so a record here would
  // be unreachable state keyed by an id the UI has already forgotten.
  if (!project) return;
  // Read markdown from a real worktree — prefer the triggering agent, else any workflow agent.
  // shell agents have no worktree (mirrors the predicate in refreshWorkflowStage).
  const hasWorktree = (kind: string) => kind !== "shell";
  const triggering = project.agents.find((a) => a.id === agentId);
  const syncAgent =
    triggering && hasWorktree(triggering.kind)
      ? triggering
      : project.agents.find((a) => hasWorktree(a.kind));
  if (!syncAgent) {
    sync.noteBlocked(projectId, "no_worktree");
    return;
  }
  // The next two returns are NORMAL operation, not states to report: a run already in flight, and
  // the cooldown between retries. Both leave the existing record alone — overwriting it here would
  // replace the reason the user needs ("Chief could not be reached") with a restatement of our own
  // retry mechanics, which is the thing they cannot act on.
  if (syncingProjects.has(projectId)) return;
  const backoff = syncBackoff.get(projectId);
  if (backoff && Date.now() < backoff.until) return; // cooling down after a recent failure
  syncingProjects.add(projectId);
  sync.noteStart(projectId);
  try {
    const chiefProjectId = settings.chiefProjectByProject[projectId];
    const res = await syncProjectMarkdown({
      pat,
      sparkleProjectId: projectId,
      projectName: project.name,
      agentId: syncAgent.id,
      chiefProjectId,
      docState: chiefProjectId ? (settings.chiefDocStateByProject[chiefProjectId] ?? {}) : {},
      // The picker refuses to CREATE this sharing, but that only covers the deliberate path.
      // `ensureChiefProject` name-matches whenever nothing is linked, so an unlinked project can
      // land on a library another Sparkle project owns with no user action at all — and older
      // persisted state can already hold the sharing. This RESERVES the resolved library before
      // the sweep can delete the other project's documents.
      //
      // Both stores are re-read HERE rather than reused from the snapshot at the top of this
      // function: the id is only known after an await, and a decision made from a stale read is
      // exactly the race this replaced. Live project ids are required because a link belonging to
      // a REMOVED project owns nothing — counting one would let a ghost block its library forever.
      claimLibrary: (pid) =>
        useSettingsStore
          .getState()
          .claimChiefLibrary(
            projectId,
            pid,
            useProjectStore.getState().projects.map((p) => p.id),
          ),
      // The ledger above is the best guess available BEFORE the id resolves, and for an unlinked
      // project that guess is always `{}`. Re-read it for the id actually landed on so a project
      // that inherits an existing library (a removed project's link and ledger are never pruned,
      // so re-adding the same folder name-matches right back onto it) reconciles against what is
      // really there instead of overwriting the record of it.
      resolveDocState: (pid) => useSettingsStore.getState().chiefDocStateByProject[pid] ?? {},
    });
    syncBackoff.delete(projectId); // round-trip succeeded → endpoint healthy, reset backoff
    if (!res) {
      // syncProjectMarkdown returns null ONLY for an empty PAT, which the guard above already
      // excluded — so this is unreachable today and recorded as the same cause rather than as a
      // fourth mystery silence if that ever changes.
      sync.noteBlocked(projectId, "no_pat");
      return;
    }
    sync.noteSuccess(projectId, {
      chiefProjectId: res.chiefProjectId || chiefProjectId || null,
      uploaded: res.uploaded.length,
      deleted: res.deletedAssetIds.length,
    });
    if (res.chiefProjectId && res.chiefProjectId !== chiefProjectId) {
      settings.setChiefProject(projectId, res.chiefProjectId);
    }
    // Only persist the ledger when something actually changed — avoids a zustand state update +
    // localStorage write on every poll cycle when the tree is unchanged.
    if (res.chiefProjectId && (res.uploaded.length || res.deletedAssetIds.length)) {
      settings.setChiefProjectDocState(res.chiefProjectId, res.docState);
    }
  } catch (e) {
    // A REFUSAL, not a failure: nothing was written, the endpoint is fine, and the liveness probe
    // below would be a wasted request. Parked at the quiet hourly re-probe like `project_gone` —
    // only a human re-pointing one of the two projects can change the answer, and a re-link clears
    // this cooldown explicitly (clearChiefSyncBackoff).
    if (e instanceof ChiefLibraryClaimedError) {
      sync.noteBlocked(projectId, "library_claimed", e.message);
      syncBackoff.set(projectId, { until: Date.now() + SYNC_GIVEUP_COOLDOWN_MS, fails: SYNC_GIVE_UP_FAILS });
      return;
    }
    // Tell a DELETED project apart from an UNREACHABLE endpoint before recording a reason. Both
    // present here as the same thrown error, and they need opposite responses from the user: one
    // resolves itself, the other never will. We only ask when a link actually exists, and only on
    // the failure path — which the backoff already rate-limits — so the healthy path pays nothing.
    //
    // `chiefProjectExists` is three-valued and `null` (could not tell) must fall through to
    // `unreachable`: an endpoint that is down cannot answer whether a project exists, and reading
    // its silence as "deleted" would strand the project in a state only a human can clear.
    const linkedId = settings.chiefProjectByProject[projectId];
    const stillThere = linkedId ? await chiefProjectExists(pat, linkedId) : null;
    if (stillThere === false) {
      sync.noteBlocked(projectId, "project_gone", String(e));
      // Nothing about this is transient, so skip the escalating retry entirely and sit at the quiet
      // hourly re-probe. That both stops the pointless hammering and lets the project heal by itself
      // if the id comes back (a restore, or a re-link that reuses it).
      syncBackoff.set(projectId, { until: Date.now() + SYNC_GIVEUP_COOLDOWN_MS, fails: SYNC_GIVE_UP_FAILS });
      return;
    }
    sync.noteBlocked(projectId, "unreachable", String(e));
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
// Projects whose bd write path is unavailable because they simply have no beads DB (bd is optional).
// Beads are latched per PROJECT (not per agent) the first time a lifecycle write rejects with "no
// beads database found": without this, every poll re-spawns a `bd` subprocess for every deliverable
// agent that then fails the same way — pure waste plus recurring debug noise. Latched for the session
// (like beadCreateFailed); creating the DB mid-session takes effect on the next relaunch.
const beadsUnavailableProjects = new Set<string>();

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
  beadsUnavailableProjects.clear();
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
  // This project has no beads DB — every bd write would just re-fail with "no beads database found".
  // Skip the shell-outs entirely (latched below on the first such failure) so we don't spawn a bd
  // subprocess per deliverable agent per poll for a project that doesn't use beads.
  if (beadsUnavailableProjects.has(projectId)) return;
  // ATTRIBUTION side of sparkle-xk3x: `dirty` is the one BranchStatus field read from the
  // worktree rather than the branch ref, so when the worktree is parked on another branch its
  // dirt belongs to THAT branch. Counting it here would mark a landed agent as having real work
  // and write `in_progress` back onto an already-closed bead. `ahead` is ref-derived and safe.
  // `undefined` (older Rust build) keeps the previous behaviour rather than silently dropping dirt.
  const dirtyIsThisBranch = !!bs?.dirty && bs.worktreeOnBranch !== false;
  const hasRealWork = !!bs && (bs.ahead > 0 || dirtyIsThisBranch);
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
            AUTO_LABEL, // telemetry, not backlog — see AUTO_LABEL and the board's exclude filter
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
    // A project that never ran `bd init` rejects EVERY write with "no beads database found". Latch it
    // so the top-of-function guard short-circuits future polls — log once per project, not per agent
    // per poll. Genuine failures (bd crashed, offline) stay unlatched and keep retrying next poll.
    if (isBeadsUnavailable(e)) {
      if (!beadsUnavailableProjects.has(projectId)) {
        beadsUnavailableProjects.add(projectId);
        console.debug("syncBeadLifecycle: project has no beads database — bead sync disabled", projectId);
      }
      return;
    }
    console.debug("syncBeadLifecycle failed for", agent.id, e);
  }
}

/** The stage at which a commit first exists on the branch — the first thing roborev can review. */
const REVIEWABLE_STAGE_INDEX = stageIndex("building_saved");

/** One-time roborev consent trigger. roborev defaults ON, but a locked UX requires a single consent
 *  modal at the FIRST reviewable commit. `applyWorkflowState` runs for every git-workflow agent (a
 *  build orchestrator OR its workers — think/shell agents never reach a committed stage), so this
 *  fires the tick ANY such agent's stage first crosses INTO building_saved (from a lower/none stage),
 *  and only when roborev is on and we haven't prompted yet. `roborevConsentOpen` guards against
 *  re-opening every subsequent tick until the user resolves the modal (which flips consent_prompted
 *  true, closing this for good). Exported for unit testing the crossing + gating logic. */
export function maybePromptRoborevConsent(
  prev: WorkflowStageId | null,
  next: WorkflowStageId,
): void {
  const crossedIntoCommitted =
    stageIndex(next) >= REVIEWABLE_STAGE_INDEX &&
    (prev == null || stageIndex(prev) < REVIEWABLE_STAGE_INDEX);
  if (!crossedIntoCommitted) return;
  const settings = useSettingsStore.getState();
  if (!settings.roborevEnabled || settings.roborevConsentPrompted || settings.roborevConsentOpen) {
    return;
  }
  settings.setRoborevConsentOpen(true);
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
  /** Whether this call may drive the bead lifecycle and the roborev consent modal.
   *
   *  FALSE for the closed-agent sweep (roborev 54750). Widening the status poll to closed panes also
   *  widened these side effects to rows nobody is watching, which previously could not reach them:
   *
   *   1. `syncBeadLifecycle` emits `create` for any BUILD agent with `hasRealWork` and no `beadId`,
   *      so the first tick after that change would shell out `bd create` + `claim` for EVERY closed
   *      build agent holding commits — dozens at once on a 46-agent fleet, with no user action.
   *   2. `close()` clears `workflowStage`/`workflowShipped` and calls `forgetBeadLifecycle`, so for a
   *      closed agent `prev` is null and the persisted-shipped re-seed that stops `in_progress` being
   *      written back onto an already-progressed bead is gone — for exactly the rows this sweep polls.
   *   3. The same null `prev` lets `maybePromptRoborevConsent` cross into `building_saved` from a
   *      background sweep rather than from work the user is watching.
   *
   *  The sweep exists to answer "does this branch hold unmerged work?" — `branchStatus`,
   *  `workflowState` and the stage watermark, all of which still update. Mutating beads and raising
   *  modals is not part of that question, and is left to the probed batch for open panes. */
  driveLifecycle = true,
): Promise<void> {
  const store = useRuntimeStore;
  // The PERSISTED row, for the two fields that live there rather than in any git reading: the
  // cross-repo landing stamp and the assignment text. `agent` above is the caller's narrow projection
  // (it deliberately carries only what every caller has), so this reads the record itself. Absent for
  // a row that has already been removed mid-tick, which reads as "no cross-repo signal" — today's
  // behaviour exactly.
  const agentRecord = useProjectStore
    .getState()
    .projects.find((p) => p.id === projectId)
    ?.agents.find((a) => a.id === agent.id);
  // Keep the RAW signals for the composer CTA (the monotonic stage watermark below can't tell
  // "on local main" from "on origin main"). Latches an observed hasRemote — see setWorkflowState.
  store.getState().setWorkflowState(agent.id, ws);
  const prev = store.getState().workflowStage[agent.id] ?? null;
  // A worker's "Merged" = its orchestrator's OWN work has reached main. Read the parent's stored
  // stage (set by its own poll — orchestrators are applied first each tick); eventually consistent.
  // Pinned to `merged_local`, NOT `merged`: before the merged_local split, `merged` meant local OR
  // origin main, and reaching LOCAL main was always enough to roll workers up. Comparing against the
  // now-stricter origin-only `merged` would silently stop worker rollup in any repo that lands
  // locally without pushing — a behavior regression the split must not introduce.
  let parentReachedMain = false;
  let parentOnOriginMain = false;
  if (agent.kind === "worker" && agent.parentId) {
    const ps = store.getState().workflowStage[agent.parentId];
    parentReachedMain = ps ? stageIndex(ps) >= stageIndex("merged_local") : false;
    // …and whether the parent got all the way to ORIGIN main, which promotes the worker to the full
    // `merged` (see the worker bump in deriveLiveStage). Without that promotion a worker caps at
    // merged_local and its bead never closes.
    //
    // Read from the parent's LIVE WorkflowState, never its stage watermark. The watermark is sticky
    // and monotonic, so a parent still pinned at merged/shipped from a PREVIOUS cycle would promote
    // a freshly-integrated worker to `merged` — and that promotion has irreversible side effects the
    // merged_local cap didn't: it latches workflowShipped (cleared only on close/reset) and closes
    // the bead, for work that isn't on origin at all. The live signal falls back the moment the
    // parent starts a new cycle, so it can't strand a worker in that state.
    const pws = store.getState().workflowState[agent.parentId];
    parentOnOriginMain = pws?.inOriginMain === true || pws?.prState === "merged";
  }
  const next = deriveLiveStage({
    kind: agent.kind,
    bs: store.getState().branchStatus[agent.id],
    ws,
    prev,
    parentReachedMain,
    parentOnOriginMain,
    // Live Pushed/Shipped signals from the Rust workflow state (sparkle-v7d0). Without these the
    // "Pushed" stage only lit via a PR probe and "Shipped" was unreachable; deriveLiveStage gates
    // both on committedSeen so a no-op branch can't skip stages.
    pushed: ws.pushed,
    shipped: ws.shipped,
    // A bead-bound agent floors at Planned before any code work exists.
    hasBead: !!agent.beadId,
    // WORK THAT LANDED IN ANOTHER REPO (bead `sparkle-pgh1ue`). `ws` above is measured entirely
    // inside the BOUND project, so for a cross-repo agent every field of it is an honest zero and the
    // row settles at "Local: Nothing Yet" forever. Read straight off the agent record, which is where
    // `set_agent_landed` writes it — the ONLY carrier of a fact this repo cannot contain.
    crossRepo: crossRepoReading({
      landedElsewhere: agentRecord?.landedElsewhere,
      // The ASSIGNMENT is what names the other repo before any stamp exists: a worker's one-shot
      // `task`, or a build agent's most recent prompt. Both are what a human typed (or an
      // orchestrator wrote) to define the work.
      taskText: agentRecord?.task ?? agentRecord?.lastPrompt ?? null,
      boundSlug: slugForRoot(rootPath),
    }),
  });
  if (next !== prev) store.getState().setWorkflowStage(agent.id, next);
  // One-time roborev consent: the first time this agent's work reaches a reviewable commit
  // (building_saved or beyond), surface the consent modal — see maybePromptRoborevConsent.
  if (driveLifecycle) {
    // A DEFERRED crossing (see `pendingRoborevConsent`) takes priority over the normal prev/next
    // comparison: prev may already equal next here (the closed sweep already wrote the stage), which
    // would read as "no crossing" and silently drop the one-time prompt. Passing `null` as `prev`
    // reproduces the crossing unconditionally; `maybePromptRoborevConsent`'s own settings guard
    // (already prompted / already open) still applies, so this cannot re-open a resolved modal.
    if (pendingRoborevConsent.delete(agent.id)) {
      maybePromptRoborevConsent(null, next);
    } else {
      maybePromptRoborevConsent(prev, next);
    }
    // Drive the agent's bead from its current stage (fire-and-forget; monotonic + idempotent).
    void syncBeadLifecycle(
      projectId,
      rootPath,
      agent,
      next,
      store.getState().branchStatus[agent.id],
      !!store.getState().workflowShipped[agent.id],
    );
  } else if (
    stageIndex(next) >= REVIEWABLE_STAGE_INDEX &&
    (prev == null || stageIndex(prev) < REVIEWABLE_STAGE_INDEX)
  ) {
    // The closed sweep just wrote a crossing that `driveLifecycle` prevented it from prompting for.
    // Remember it so the NEXT poll that is allowed to drive lifecycle (i.e. the pane gets opened,
    // the probed batch picks it up) still raises the one-time modal.
    pendingRoborevConsent.add(agent.id);
  }
  // Sticky "shipped" watermark: latch true the first time work reaches On Main (or beyond).
  // Deliberately compares against `merged` (ORIGIN main), not `merged_local`: this watermark drives
  // the bead lifecycle and the "landed at least once" ✓, which must mean the work is actually on the
  // remote. merged_local sits BELOW merged in the ladder, so a local-only land correctly does not
  // trip this — keep it that way if the stage order ever changes.
  if (
    stageIndex(next) >= stageIndex("merged") &&
    !store.getState().workflowShipped[agent.id]
  ) {
    store.getState().setWorkflowShipped(agent.id, true);
  }
}

/** localStorage key the runtime store persists under. Exported so the multi-window open-set merge
 *  () and any test read the SAME key instead of duplicating the literal. */
export const RUNTIME_PERSIST_KEY = "sparkle-runtime";

/** Read the `openAgentIds` currently persisted under {@link RUNTIME_PERSIST_KEY}. Multi-window
 *  correctness (): EVERY window persists its own open set to this ONE shared key, so a
 *  naive whole-array write is last-writer-wins and silently drops another live window's agents from
 *  the set a relaunch restores from (window A opening a3 persists [..,a3] and clobbers b1 that window
 *  B just wrote). `open`/`close` merge against THIS value so the persisted set stays the UNION across
 *  all live windows, minus only the id a window explicitly closes. Best-effort: a malformed/absent
 *  blob reads as empty so a parse hiccup can never break open/close. */
export function readPersistedOpenAgentIds(): string[] {
  try {
    if (typeof localStorage === "undefined") return [];
    const raw = localStorage.getItem(RUNTIME_PERSIST_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { state?: { openAgentIds?: unknown } };
    const ids = parsed?.state?.openAgentIds;
    return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Union this window's in-memory open set with the shared persisted set (other windows' opens),
 *  preserving in-memory order and appending persisted-only ids after; `add` is appended if new. Pure
 *  + exported for testing. This is the read-modify-MERGE that fixes the cross-window clobber
 *  () — we never overwrite the shared array with just our own ids. */
export function mergeOpenAgentIds(inMemory: string[], persisted: string[], add?: string): string[] {
  const seen = new Set(inMemory);
  const out = [...inMemory];
  for (const id of persisted) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  if (add && !seen.has(add)) out.push(add);
  return out;
}

/** Element-wise array equality — lets `open` keep the `openAgentIds` reference stable on a no-op
 *  merge so subscribers don't re-render for nothing. */
function sameStringOrder(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Are two artifact-evidence maps the same reading? Field-by-field, because `fleet_digest` hands
 *  back fresh objects on every poll, so reference equality is never true and a whole-map subscriber
 *  would re-render every ten seconds over facts that did not move. */
function sameMovement(
  a: Record<string, MovementEvidence>,
  b: Record<string, MovementEvidence>,
): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) {
    const x = a[k];
    const y = b[k];
    if (y === undefined || x === undefined) return false;
    if (
      x.lastEvent !== y.lastEvent ||
      x.lastEventMs !== y.lastEventMs ||
      x.sessionId !== y.sessionId ||
      // ⚠️ ADDING A FIELD TO MovementEvidence WITHOUT ADDING IT HERE MAKES IT UNREACHABLE. This
      // predicate decides whether the new map is stored at all, so a tick where ONLY `toolsRecent`
      // moved would be discarded as "the same reading" and `progressMark` would never see the tool
      // count change — the escalation predicate's work signal, silently frozen at whatever the
      // first poll happened to read, with every test still green.
      x.toolsRecent !== y.toolsRecent
    )
      return false;
  }
  return true;
}

interface RuntimeState {
  status: Record<string, AgentTabStatus>; // agentId -> status (live-only, never persisted)
  // agentId -> the LAST status this window observed for the agent + when, captured by close() from
  // the entry it deletes and DEMOTED from any red tier to `stopped` (a question dies with its PTY).
  // PERSISTED. Its whole job is to let a surface tell "ran, then closed" from "never started": a
  // closed worker used to read as statusless and get a synthetic red "Approve?" overlay (sparkle-w340).
  lastObserved: Record<string, LastObserved>;
  // agentId -> the ARTIFACT evidence of that agent having acted, refreshed by services/fleetWatch
  // from `fleet_digest` every FLEET_POLL_INTERVAL_MS. Live-only, like `status`.
  //
  // WHY THIS EXISTS AS A SEPARATE MAP FROM `status`. `status` has exactly ONE writer,
  // components/AgentPane's status engine, so it is live only while a pane is MOUNTED for that agent
  // — and panes mount lazily, per project, on first visit (Workspace.tsx). For every agent this
  // window is not hosting, `status` is a frozen last reading that nothing can retract, which is how
  // a BLOCKED pill outlived the block and had to be cleared by hand (bead sparkle-7ba9e). This map
  // is the second witness: it is read off disk for the whole `openAgentIdSet()` population, needs no
  // pane, and costs no agent turn. `engine/movementRetraction` is what compares the two.
  agentMovement: Record<string, MovementEvidence>;
  // agentId -> the LAST attention verdict the Rust nudger read off that agent's grid, pushed by
  // `services/observedAttentionListener` off `attention://observed`. Live-only, like `status`.
  //
  // THE THIRD WITNESS, and it exists for the same reason `agentMovement` above does — `status` is
  // written by a MOUNTED pane and by essentially nothing else, so for an agent this window is not
  // hosting it is a frozen last reading. Where `agentMovement` reads ARTIFACTS off disk (what the
  // agent DID), this reads the agent's own rendered SCREEN once a second in the Rust process (what
  // the agent is asking for RIGHT NOW), which is the half that says a human is being waited on.
  // `engine/observedAttention` is what applies it.
  observedAttention: Record<string, ObservedReading>;
  // agentId -> the terminal screen text captured the moment the agent entered an "ask" status
  // (waiting/approval), so the notification path can summarize WHAT it's asking. Live-only (never
  // persisted, like `status`); cleared whenever `status` is cleared for an agent — AND, since
  // sparkle-99o9a, the moment that agent's status leaves the red tier. It is a snapshot of a
  // question, so it may not outlive the question: see `setStatus` for why the expiry is keyed on
  // this map's sibling `status` rather than on the Terminal seam that writes it.
  attentionScreen: Record<string, string>;
  /** When each `attentionScreen` entry was WRITTEN (epoch ms).
   *
   *  A SIBLING MAP RATHER THAN `{ text, at }` (bead sparkle-5wbhn): `attentionScreen` is read as a
   *  bare string by `useAttentionNotifications` and the concierge read chain, and widening it would
   *  touch every one of those call sites for a fact only the expiry needs. Written and cleared in
   *  lockstep with `attentionScreen` — every site that touches one touches the other. */
  attentionScreenAt: Record<string, number>;
  // agentId -> how ask-like a FINISHED turn looked that we could NOT judge, because the AI backend
  // was unavailable (services/turnFollowup returns `unknown`). This is the neutral middle state
  // between "the judge said this needs you" (red) and "the judge said it's done" (gray): we simply
  // do not know, and the row says so rather than guessing in either direction.
  //
  // It exists because the alternative is a silent loss. With the judge dead — the expected state
  // until AI enhancement moves onto the user's own `claude` CLI — a genuine "Want me to land it?"
  // would otherwise read exactly like a finished turn, and the user would never learn an ask was
  // dropped. Live-only, cleared with `status`, and cleared per-agent the moment a new turn opens or
  // a real verdict arrives (AgentPane) — a stale marker on a turn that has moved on is noise.
  unjudgedAsk: Record<string, FollowupSignal>;
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
  // agentId -> WHEN this agent's work was last observed to CROSS into `merged`, so a reader can ask
  // whether that merge happened before or after some other event. The boolean above cannot answer
  // it, and the gap is not cosmetic: the watermark survives into the agent's next goal, so "this
  // agent shipped something" reads as true from the first second of a goal no work has been done on
  // yet — and anything closing a goal on that basis acts on a merge that predates it (roborev
  // 63905).
  //
  // ⚠️ WRITTEN BY `setWorkflowStage` ON THE UPWARD CROSSING, not by the `workflowShipped` latch.
  // That latch is one-shot ("set once, never cleared until the agent closes"), so dating IT records
  // an agent's FIRST merge forever and the comparison then reports "predates this goal" for every
  // goal after the first — the field would be permanently absent for repeat-use agents, which is
  // worse than absent altogether because the caller is told to look for it (roborev 63931). The
  // STAGE is what cycles, so it is what carries the date.
  //
  // Absent means NO CLAIM, never "never merged": a cleared stage map (close/resetProgress) gives
  // the next poll no `prev` to cross from, and stamping there would date an old merge as now.
  // Persisted with the watermark, or a relaunch silently disables the anchor.
  workflowShippedAt: Record<string, number>;
  // agentId -> the LIVE WorkflowState from the last poll (reachability + PR probe + hasRemote). The
  // stage watermark above is monotonic and lossy by design; the composer CTA needs the raw signals
  // to tell "on local main" from "on origin main" (engine/agentCta.deriveCta). Live-only (never
  // persisted, like branchStatus): a relaunch re-polls within a tick, and a persisted `hasRemote`
  // could outlive the repo it described. Cleared on close/resetProgress.
  workflowState: Record<string, WorkflowState>;

  open: (agentId: string) => void;
  close: (agentId: string) => void;
  /** Clear an agent's live status + branch status + workflow stage/shipped watermark WITHOUT
   *  removing it from the open set. Called when a slot starts a FRESH run (nothing to resume) so a
   *  reused worktree doesn't inherit the prior occupant's progress (incl. the sticky "shipped ✓").
   *  Unlike `close`, the pane stays mounted; the new session repopulates status from its own hooks. */
  resetProgress: (agentId: string) => void;
  setStatus: (agentId: string, status: AgentTabStatus) => void;
  /** Replace the whole artifact-evidence map from one `fleet_digest` tick. WHOLE-MAP, not per-agent:
   *  the digest is a complete reading over `openAgentIdSet()`, so an agent MISSING from a tick has no
   *  evidence this tick and must not keep a previous tick's — a retraction is only ever as good as
   *  its most recent reading. */
  setAgentMovement: (movement: Record<string, MovementEvidence>) => void;
  /** Record ONE agent's attention verdict. Per-agent, NOT whole-map: the producer emits on change
   *  and a missing agent this tick means "unchanged", never "no evidence" — the opposite of
   *  `setAgentMovement`'s complete-reading semantics above. The Rust side sweeps a verdict when its
   *  PTY dies, so a stale row cannot outlive its terminal. */
  setObservedAttention: (agentId: string, reading: ObservedReading) => void;
  /** Replace the whole map from the startup seed, which IS a complete reading. */
  seedObservedAttention: (readings: Record<string, ObservedReading>) => void;
  /** Drop one agent's verdict — the producer's `gone` retraction, sent when its PTY is swept. A
   *  held verdict that outlives its terminal is a latched reading with no writer that can move it,
   *  which is the exact bug this whole channel exists to fix. Safe to call when unset. */
  clearObservedAttention: (agentId: string) => void;
  /** Store the terminal screen captured when an agent entered an "ask" status, for the notification
   *  summarizer. Live-only (mirrors `status`), and EXPIRES with the ask: the next `setStatus` that
   *  moves this agent out of the red tier drops it. Write it before you set the red status, not
   *  after a non-red one. */
  setAttentionScreen: (agentId: string, text: string) => void;
  /** Mark this agent's finished turn as carrying a possible ask nobody could judge. */
  setUnjudgedAsk: (agentId: string, signal: FollowupSignal) => void;
  /** Drop the marker — a new turn opened, or a real verdict landed. Safe to call when unset. */
  clearUnjudgedAsk: (agentId: string) => void;
  setBranchStatus: (agentId: string, s: BranchStatus) => void;
  setWorkflowStage: (agentId: string, stage: WorkflowStageId) => void;
  setWorkflowShipped: (agentId: string, shipped: boolean) => void;
  /** Store an agent's live WorkflowState, LATCHING an observed `hasRemote: true` (see the field's
   *  comment and Rust's probe gate). Every other field is taken from `ws` as-is. */
  setWorkflowState: (agentId: string, ws: WorkflowState) => void;
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
      /** `AgentTab.createdAt` — epoch ms this row was spawned. Forwarded to Rust as `createdAtMs`,
       *  which is what `dirtySinceAgentCount` compares each dirty file's mtime against. Undefined
       *  for a re-adopted worker or a legacy persisted row; Rust then declines that reading. */
      createdAt?: number;
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
      lastObserved: {},
      agentMovement: {},
      observedAttention: {},
      attentionScreen: {},
      attentionScreenAt: {},
      unjudgedAsk: {},
      openAgentIds: [],
      branchStatus: {},
      workflowStage: {},
      workflowShipped: {},
      workflowShippedAt: {},
      workflowState: {},

      open: (agentId) =>
        set((s) => {
          // Merge against the shared persisted set so a concurrent window's open ids aren't clobbered
          // by this whole-array write (): union {this window's set, persisted set, agentId}.
          const merged = mergeOpenAgentIds(s.openAgentIds, readPersistedOpenAgentIds(), agentId);
          return sameStringOrder(merged, s.openAgentIds) ? s : { openAgentIds: merged };
        }),

      close: (agentId) =>
        set((s) => {
          forgetBeadLifecycle(agentId); // drop module-level bead bookkeeping for this agent
          useInteractionStore.getState().forget(agentId); // …and its last-interaction timestamp
          const { [agentId]: _removed, ...status } = s.status;
          // Persist the agent's LAST observed status before we drop it, so surfaces can tell a
          // ran-then-closed pane from a never-started one (sparkle-w340). A red-tier value is demoted
          // to `stopped`: an approval/question can't be answered against a dead PTY, so a closed pane
          // must never read back as still asking. Only written when we actually had an observation —
          // closing an agent this window never saw leaves lastObserved untouched (an unknown stays
          // unknown, not a manufactured `stopped`).
          const lastObserved =
            _removed === undefined
              ? s.lastObserved
              : {
                  ...s.lastObserved,
                  [agentId]: {
                    status: isRedStatus(_removed) ? ("stopped" as AgentTabStatus) : _removed,
                    at: Date.now(),
                  },
                };
          const { [agentId]: _scr, ...attentionScreen } = s.attentionScreen;
          const { [agentId]: _scrAt, ...attentionScreenAt } = s.attentionScreenAt;
          // Stripped with the rest of the live-only maps. Its doc says it is cleared with `status`,
          // and it must be: the marker claims an unanswered question about a turn that is gone once
          // the pane closes (and about the PREVIOUS occupant on a slot reuse). roborev, 54814.
          const { [agentId]: _ask, ...unjudgedAsk } = s.unjudgedAsk;
          const { [agentId]: _bs, ...branchStatus } = s.branchStatus;
          const { [agentId]: _ws, ...workflowStage } = s.workflowStage;
          const { [agentId]: _shipped, ...workflowShipped } = s.workflowShipped;
          const { [agentId]: _shippedAt, ...workflowShippedAt } = s.workflowShippedAt;
          const { [agentId]: _wstate, ...workflowState } = s.workflowState;
          // `branchStatus` was just dropped above — `forcedOnce` must forget it too (roborev 54843,
          // High). Otherwise an agent polled once while open (marked forced), then closed, then
          // reopened has no branchStatus but IS in `forcedOnce`: every poll after that sends
          // `force: false`, the fingerprint cache reports `changed: false` for a quiet branch, and
          // `branchStatus[id]` never gets set again — the exact bug this Set was added to fix,
          // through the door `close()`/`resetProgress()` leave open.
          forcedOnce.delete(agentId);
          // Live-only, like `status` itself — a reopened agent must not inherit a stale write count.
          statusWrites.delete(agentId);
          // Read-modify-MERGE the shared persisted set, then drop ONLY this id (): the
          // union retains other live windows' open ids in the persisted write, so closing a3 here
          // can't clobber window B's b1 — while still removing a3 itself.
          const mergedOpen = mergeOpenAgentIds(s.openAgentIds, readPersistedOpenAgentIds());
          return {
            openAgentIds: mergedOpen.filter((id) => id !== agentId),
            status,
            lastObserved,
            attentionScreen,
            attentionScreenAt,
            unjudgedAsk,
            branchStatus,
            workflowStage,
            workflowShipped,
            workflowShippedAt,
            workflowState,
          };
        }),

      resetProgress: (agentId) =>
        set((s) => {
          // Also forget the module-level bead watermark/latches so a reused slot doesn't inherit the
          // prior occupant's lifecycle state (esp. now that workflowShipped is persisted).
          forgetBeadLifecycle(agentId);
          const { [agentId]: _st, ...status } = s.status;
          // Forget the prior occupant's last-observed too: a fresh run in a reused slot must not
          // inherit a stale "ran, then closed" reading (sparkle-w340). The pane stays mounted, so the
          // new session repopulates a LIVE status within a tick regardless.
          const { [agentId]: _lo, ...lastObserved } = s.lastObserved;
          const { [agentId]: _scr, ...attentionScreen } = s.attentionScreen;
          const { [agentId]: _scrAt, ...attentionScreenAt } = s.attentionScreenAt;
          // Stripped with the rest of the live-only maps. Its doc says it is cleared with `status`,
          // and it must be: the marker claims an unanswered question about a turn that is gone once
          // the pane closes (and about the PREVIOUS occupant on a slot reuse). roborev, 54814.
          const { [agentId]: _ask, ...unjudgedAsk } = s.unjudgedAsk;
          const { [agentId]: _bs, ...branchStatus } = s.branchStatus;
          const { [agentId]: _ws, ...workflowStage } = s.workflowStage;
          const { [agentId]: _shipped, ...workflowShipped } = s.workflowShipped;
          const { [agentId]: _shippedAt, ...workflowShippedAt } = s.workflowShippedAt;
          const { [agentId]: _wstate, ...workflowState } = s.workflowState;
          // Same reason as in `close()`: `branchStatus` was just dropped, so `forcedOnce` must
          // forget the id too, or the reused slot inherits a stale "already forced" mark with no
          // branchStatus to show for it.
          forcedOnce.delete(agentId);
          // Note: openAgentIds is intentionally untouched — the pane stays mounted for the new run.
          return {
            status,
            lastObserved,
            attentionScreen,
            attentionScreenAt,
            unjudgedAsk,
            branchStatus,
            workflowStage,
            workflowShipped,
            workflowShippedAt,
            workflowState,
          };
        }),

      setStatus: (agentId, status) => {
        // Count the CALL, before the bail-out below can discard it — see `statusWrites`. This is the
        // only record that a redundant re-assert happened at all; the map and every subscriber are
        // blind to it by construction.
        statusWrites.set(agentId, (statusWrites.get(agentId) ?? 0) + 1);
        // Skip the write when the value is unchanged (sparkle-f2uz): setStatus makes a NEW `status`
        // map ref, which every whole-map subscriber (sidebar/TopBar) re-renders on. A redundant tick
        // of the SAME status (e.g. repeated "working"/"listening"/"blocked") must not churn a render.
        set((s) => {
          if (s.status[agentId] === status) return s;
          const next: Pick<RuntimeState, "status"> &
            Partial<Pick<RuntimeState, "attentionScreen" | "attentionScreenAt">> = {
            status: { ...s.status, [agentId]: status },
          };
          // THE CAPTURE EXPIRES WITH THE ASK (sparkle-99o9a). `attentionScreen[agentId]` is the screen
          // photographed the moment the agent went red, and it used to be cleared ONLY by
          // close()/resetProgress() — so a menu snapshot outlived the menu by hours, or by the whole
          // session, and every consumer read it as the present tense: `readAgentTerminal` tier (b)
          // narrates it to the concierge as this agent's recent output, and the phone relay sends it
          // as the body of "what it's asking". Leaving red is the moment that stops being true, so
          // this is where it goes.
          //
          // KEYED ON THE STORE'S OWN STATUS, deliberately, and this is why the clear lives here rather
          // than at the Terminal seam that WRITES the capture. Terminal only sees the screen scraper's
          // emit, which the statusRouter may suppress entirely once hooks own the status — clearing
          // there would key expiry on a status the consumers never see, while `mayHaveMenu`, the one
          // consumer that gates the capture at all, gates it on `isRedStatus(status[agentId])` out of
          // THIS map. One status, one predicate, one place (bead sparkle-07gjg is the bug class: a
          // predicate split by name rather than by content). Every status writer — AgentPane's router,
          // SparkleAgentPane, requery, improvementPass — funnels through here, so no path can resume
          // an agent while leaving its ask-screen behind.
          //
          // BOUNDED BY "SOMEONE MOVES THIS AGENT'S STATUS", WHICH IS NOT EVERY AGENT. `status` has one
          // writer, a MOUNTED AgentPane, so for an agent this window is not hosting it is a frozen
          // last reading and nothing here ever runs — see engine/movementRetraction's header. That is
          // exactly the population that reads the capture, so this clear is necessary and not
          // sufficient: `conciergeTools/terminal.captureFor` carries the second expiry, off the
          // movement ledger, for the unhosted case. Do not read this line as a guarantee.
          //
          // `isRedStatus` and not the narrower waiting|approval capture condition: red is what the
          // consumers ask, and it keeps the snapshot through a waiting→blocked/errored slide, where
          // the agent still needs you and nothing has recaptured a screen.
          if (!isRedStatus(status) && agentId in s.attentionScreen) {
            const { [agentId]: _scr, ...attentionScreen } = s.attentionScreen;
            const { [agentId]: _scrAt, ...attentionScreenAt } = s.attentionScreenAt;
            next.attentionScreen = attentionScreen;
            next.attentionScreenAt = attentionScreenAt;
          }
          return next;
        });
      },

      setAgentMovement: (movement) =>
        // Same no-op guard `setStatus` uses, for the same reason: this map has whole-map subscribers
        // (the concierge feed), and a poll that reads the same facts as the last one — the common
        // case for a quiet fleet, every ten seconds — must not churn a render. Shallow-compared by
        // the three fields that matter, because the digest hands back fresh objects each tick.
        set((s) => (sameMovement(s.agentMovement, movement) ? s : { agentMovement: movement })),

      setObservedAttention: (agentId, reading) =>
        // Same no-op guard `setStatus` uses, for the same reason: this map has whole-map
        // subscribers (the sidebar, on every render), and the producer re-asserts a verdict on
        // reconnect. `atMs` is deliberately OUT of the comparison — it moves on every reading, so
        // including it would make the guard a no-op and churn a render once a second per agent.
        set((s) => {
          const prev = s.observedAttention[agentId];
          if (prev && prev.verdict === reading.verdict && prev.alternate === reading.alternate)
            return s;
          return { observedAttention: { ...s.observedAttention, [agentId]: reading } };
        }),

      seedObservedAttention: (readings) =>
        set(() => ({ observedAttention: readings })),

      clearObservedAttention: (agentId) =>
        set((s) => {
          if (!(agentId in s.observedAttention)) return s;
          const { [agentId]: _dropped, ...rest } = s.observedAttention;
          return { observedAttention: rest };
        }),

      setAttentionScreen: (agentId, text) =>
        // The stamp is written with the text, never separately: `captureFor` compares movement
        // against THIS instant, and a capture with no stamp falls back to the old
        // episode-relative comparison, which is the behaviour this fixes (bead sparkle-5wbhn).
        set((s) => ({
          attentionScreen: { ...s.attentionScreen, [agentId]: text },
          attentionScreenAt: { ...s.attentionScreenAt, [agentId]: Date.now() },
        })),

      setUnjudgedAsk: (agentId, signal) =>
        // Same no-op guard `setStatus` uses and for the same reason: this map has whole-map
        // subscribers (the sidebar), and re-marking an already-marked agent must not churn a render.
        set((s) => (s.unjudgedAsk[agentId] === signal ? s : { unjudgedAsk: { ...s.unjudgedAsk, [agentId]: signal } })),

      clearUnjudgedAsk: (agentId) =>
        set((s) => {
          if (!(agentId in s.unjudgedAsk)) return s;
          const next = { ...s.unjudgedAsk };
          delete next[agentId];
          return { unjudgedAsk: next };
        }),

      setBranchStatus: (agentId, s) =>
        set((st) => ({ branchStatus: { ...st.branchStatus, [agentId]: s } })),

      setWorkflowStage: (agentId, stage) =>
        set((st) => {
          // STAMPING THE TRANSITION INTO `merged`, NOT THE FIRST-EVER LATCH (roborev 63931).
          //
          // `workflowShipped` is documented as "set once, never cleared until the agent closes", and
          // its single production call site only ever passes `true`. So a timestamp written there
          // records an agent's FIRST merge, forever — and an anchor comparing it against `goal.setAt`
          // then reports "the merge predates this goal" for every goal after the first. The evidence
          // field would be permanently absent for exactly the repeat-use agents it exists to serve,
          // which is worse than not shipping it: the caller is told to look for a signal that never
          // arrives.
          //
          // The STAGE is the thing that actually cycles — `deriveLiveStage` drops back to Committed
          // when fresh work lands on a branch that already shipped — so an upward crossing of
          // `merged` happens once per merge, which is the event worth dating.
          const prev = st.workflowStage[agentId];
          // ⚠️ AN ABSENT `prev` DOES NOT STAMP, and that is the second half of the fix. After
          // `close()`/`resetProgress()` the stage map is cleared, so the next poll would look like a
          // fresh crossing and date a merge that may be months old as "now" — re-manufacturing the
          // false positive this anchor removes. No history means no claim.
          const crossedIntoMerged =
            prev !== undefined &&
            stageIndex(prev) < stageIndex("merged") &&
            stageIndex(stage) >= stageIndex("merged");
          return {
            workflowStage: { ...st.workflowStage, [agentId]: stage },
            ...(crossedIntoMerged
              ? { workflowShippedAt: { ...st.workflowShippedAt, [agentId]: Date.now() } }
              : {}),
          };
        }),

      setWorkflowShipped: (agentId, shipped) =>
        set((st) => {
          // DOES NOT STAMP `workflowShippedAt` — see that field's note. This latch is one-shot, so a
          // date written here would be the agent's FIRST merge forever and would read as "predates
          // this goal" for every later goal. `setWorkflowStage` owns the date because the stage is
          // what cycles.
          if (!shipped) {
            // Cleared together, so the pair cannot disagree — a date outliving its watermark would
            // claim a merge the watermark says never happened.
            const { [agentId]: _drop, ...workflowShippedAt } = st.workflowShippedAt;
            return { workflowShipped: { ...st.workflowShipped, [agentId]: false }, workflowShippedAt };
          }
          return { workflowShipped: { ...st.workflowShipped, [agentId]: true } };
        }),

      setWorkflowState: (agentId, ws) =>
        set((st) => {
          // `hasRemote` is only computed on a PROBING poll (Rust gates it on probe_pr_state), so
          // every fast tick reports false. Latch an observed true so the CTA doesn't flap between
          // "Push to Origin Main" and "Close" on alternating polls. A repo genuinely LOSING its
          // remote isn't worth tracking — re-observing false would be wrong here, not right.
          const prevHasRemote = st.workflowState[agentId]?.hasRemote;
          const merged: WorkflowState = { ...ws, hasRemote: ws.hasRemote || prevHasRemote || false };
          return { workflowState: { ...st.workflowState, [agentId]: merged } };
        }),

      pollBranchStatus: async (root, projectId, agentId, baseBranch) => {
        // A removed worktree never returns for the same agent id — skip it permanently ().
        if (deadWorktrees.has(agentId)) return;
        try {
          // The agent's spawn stamp, so the single-agent path attributes dirt the same way the
          // batch does. Absent row / absent stamp → undefined → Rust declines the reading.
          const createdAt = useProjectStore
            .getState()
            .projects.find((p) => p.id === projectId)
            ?.agents.find((a) => a.id === agentId)?.createdAt;
          const s = await agentBranchStatus(root, projectId, agentId, baseBranch, createdAt);
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
          if (!project || !agent || agent.kind === "shell") return;
          // A worker integrates into its orchestrator's branch; everyone else, into project main.
          const parentBranch =
            agent.kind === "worker" && agent.parentId ? `sparkle/agent-${agent.parentId}` : "";
          const ws = await agentWorkflowState(root, agentId, parentBranch, true, projectId);
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
        // forcedOnce). Steady-state polls honor each agent's own `force`.
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
              force: a.force || !forcedOnce.has(a.id),
              // `?? null`, never omitted: the field crosses into a Rust `Option<i64>`, and the two
              // sides of that seam must agree that ABSENT and NULL mean the same "no stamp".
              createdAtMs: a.createdAt ?? null,
            })),
            probePrState,
          );
        } catch (e) {
          console.debug("pollProjectStatus failed for", projectId, e);
          return;
        }
        // Latch any agent the batch reports as GONE (worktree dir deleted / no longer a git repo) so
        // the NEXT poll's `live` filter drops it — otherwise the batch re-shells `git status` against
        // the dead path every tick and floods the log with "not a git repository" (). The
        // per-agent `pollBranchStatus` path already latched these via `isWorktreeGoneError`, but the
        // batched Rust path swallowed the failure into `changed:false`, so TS never learned the path
        // was dead. Rust now surfaces it as `gone` for exactly this prune.
        for (const r of results) {
          if (r.gone) deadWorktrees.add(r.agentId);
        }
        // Mark forced only on EVIDENCE the recompute actually landed (roborev 54843): either this
        // poll produced a fresh read (`r.changed`), or a prior poll already established
        // `branchStatus` for the agent. Marking the whole batch unconditionally — the previous fix
        // for this same finding — let a per-agent git error (which `projectAgentsStatus` reports as
        // `changed: false`, indistinguishable here from a genuine "no diff") spend that agent's one
        // free recompute on a poll that produced nothing, so it never got a real force again.
        const branchStatusNow = get().branchStatus;
        for (const r of results) {
          if (r.changed || branchStatusNow[r.agentId] !== undefined) forcedOnce.add(r.agentId);
        }
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
              // `probePrState` is exactly the open/closed split: the probed batch is the rows with a
              // mounted pane, the local batch is the closed sweep. Only the former may mutate beads
              // or raise the consent modal — see `driveLifecycle`.
              probePrState,
            );
          }
        }
        // ONE debounced Chief sync for the whole project (the same signal a commit would refresh),
        // rather than one per agent as the old per-agent pollBranchStatus fan-out did.
        const syncAgent = live.find((a) => a.kind !== "shell");
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
          // `forcedOnce` and `pendingRoborevConsent` are the same unbounded-growth shape
          // (roborev 54843) — an agent id, once added, was never removed even after the agent
          // itself is gone.
          for (const id of forcedOnce) if (!valid.has(id)) forcedOnce.delete(id);
          for (const id of pendingRoborevConsent) if (!valid.has(id)) pendingRoborevConsent.delete(id);
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
          // lastObserved is persisted too (sparkle-w340), so a deleted agent's stale reading must be
          // pruned or it lingers in localStorage forever (and could resurface if the id is reused).
          const lastObservedPruned = Object.keys(s.lastObserved).some((id) => !valid.has(id));
          const openChanged = openAgentIds.length !== s.openAgentIds.length;
          if (!openChanged && !stagePruned && !shipPruned && !lastObservedPruned) return s;
          return {
            ...(openChanged ? { openAgentIds } : {}),
            ...(stagePruned ? { workflowStage: pruneMap(s.workflowStage) } : {}),
            ...(shipPruned
              ? {
                  workflowShipped: pruneMap(s.workflowShipped),
                  // Pruned on the SAME condition, not its own: the two maps are one fact, and a
                  // separate predicate is how they drift apart for a reused agent id.
                  workflowShippedAt: pruneMap(s.workflowShippedAt),
                }
              : {}),
            ...(lastObservedPruned ? { lastObserved: pruneMap(s.lastObserved) } : {}),
          };
        }),
    }),
    {
      name: RUNTIME_PERSIST_KEY,
      storage: createJSONStorage(() => localStorage),
      // The open set, the workflow-stage watermark, and the sticky shipped ✓ survive a relaunch.
      // Persisting the watermark is what lets a merged/shipped agent read back as Merged instead of
      // collapsing to building_unsaved after the post-merge `ahead→0` dip (see workflowStage above /
      // deriveLiveStage `prev`). Live status/branchStatus deliberately boot clean and are excluded.
      partialize: (s) => ({
        openAgentIds: s.openAgentIds,
        workflowStage: s.workflowStage,
        workflowShipped: s.workflowShipped,
        // Persisted with it, or a relaunch leaves a latched watermark whose timestamp is gone —
        // which reads as "we cannot tell when this merged" and silently disables the goal anchor
        // for every agent that shipped before the restart.
        workflowShippedAt: s.workflowShippedAt,
        // Persisted so a closed worker still reads as "ran, then stopped" after a relaunch, rather
        // than reverting to statusless and re-manufacturing a synthetic red (sparkle-w340).
        lastObserved: s.lastObserved,
      }),
    },
  ),
);
