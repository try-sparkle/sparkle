// The concierge's AGENT LIFECYCLE tool domain: create a build agent, look at what closing one would
// do, and carry out the close — Ship, Save, or (only ever on an explicit human intent) Discard.
//
// This module is a THIN WRAPPER over the paths the human's own clicks take. It owns no worktree, PTY,
// git or bead logic of its own; every side-effect is delegated:
//   • spawn      → services/buildAgentSpawn.spawnBuildAgentInProject (the "+ New Build Agent" body)
//   • the policy → engine/closeAgent.closeDecision (the ONE rule for "does closing need a
//                  decision?" — the sidebar × and the concierge must never disagree about this)
//   • ship/save  → services/closeAgentActions.shipAgent / saveAgent
//   • discard    → services/closeAgentActions.discardAgentGit
//   • teardown   → services/closeBuildAgent + closeAgentActions.spinDownAgentGit
//   • workers    → services/workerSpawn.spinDownWorker
//   • cloud      → services/cloudAgents/terminate.terminateIfCloud
//
// FOUR SAFETY PROPERTIES, in the order they matter:
//
// 1. DISCARD IS IRREVERSIBLE AND CASCADES. It deletes a never-merged branch, the bead, and the
//    worktree — for the agent AND every child under it. So it is the only operation that takes a
//    second, non-defaulted argument: a `DiscardIntent` naming the exact agent and carrying the
//    literal confirm token. There is no default, no boolean flag, and no code path where discard is
//    the ELSE of a conditional — a bug that turns "close" into "discard" would silently destroy
//    unmerged work, so `closeAgent` refuses rather than falling back, and `previewClose` will never
//    recommend discard (it is the human's choice alone).
//
// 2. EVERY OPERATION IS RISK-CLASSIFIED. `LIFECYCLE_RISK` is a `Record<LifecycleOp, LifecycleRisk>`,
//    so adding an op to `LIFECYCLE_OPS` without classifying it does not compile.
//
// 3. NOTHING THROWS A BARE STRING. Every entry point returns a `LifecycleResult` — `{ ok: true }`
//    with data, or a typed refusal carrying a machine-readable `reason` plus a sentence the
//    concierge can say out loud. Same precedent as services/conciergeDispatch's ConciergeDispatchPath.
//
// 4. SPAWNS RESPECT THE MACHINE'S CAPACITY. Over-cap is a typed refusal, never a silent queue or a
//    crash — see `localAgentCapacity`.
//
// 5. SUCCESS IS REPORTED FROM WHAT HAPPENED, NOT FROM WHAT DIDN'T THROW. `shipAgent` reads the
//    `ShipOutcome` it gets back and distinguishes "PR opened" from "pushed, but gh failed" from
//    "nothing landed at all" — the last of which refuses and keeps the agent. A false success on the
//    one outward-facing operation is the most expensive thing this module could say (roborev 54175).
//    `saveAgent` reads a `SaveOutcome` for the same reason (roborev 54225): both operations are
//    classified `outward-facing`, both make a claim about the REMOTE, and both make it after the
//    worktree is already gone. Save's outcomes are all successes — the branch and bead survive on
//    this machine regardless — but "backed up to the remote" is only said when it is true.
//
// SHIP / SAVE / DISCARD ARE BUILD-AGENT-ONLY. A worker's branch belongs to the orchestrator waiting
// on it and a shell has no branch at all, so those kinds are refused (`requireBuild`) rather than
// handled — see that function for the per-kind reasoning. Discarding a build agent still cascades to
// its workers; what is refused is naming a worker as the target.
//
// A CLOUD SPAWN RUNS THE HUMAN'S OWN SEQUENCE (design 2026-08-01 §Decision 7). It used to return a
// blanket "not supported", whose stated reasons were *"it bills per minute"* and *"it needs a goal
// and a repo up front"* — and those are REQUIREMENTS, not objections, so each one is now satisfied
// rather than used as grounds to refuse:
//   • bills per minute → `evaluateCloudGate` (the same pure gate `NewCloudAgentDialog` uses) runs
//     FIRST, and its `message` + `deepLink` are returned VERBATIM. A gate message is user-facing
//     copy that names the one fix; paraphrasing it here would be a second copy that can drift.
//     The op stays classified `costs-money`, so it goes through the same approval surface as before.
//   • needs a repo → `projectRepoUrl(project.rootPath)`, refusing when there is no GitHub remote.
//     The sandbox CLONES it; sending a bad URL surfaces minutes later as an opaque clone failure.
//   • needs a goal → the `prompt` IS the goal. A cloud agent's goal is delivered by the runner via
//     stdin at start, so there is nothing to send afterwards and nothing to infer — a spawn with no
//     prompt is REFUSED rather than given an invented one.
// Everything below the gate is `createCloudAgent` + `ensureCloudProjectId`, the same calls the
// dialog makes, with the same injected store deps. Nothing new is invented here.

import { useProjectStore } from "../../stores/projectStore";
import { useRuntimeStore, isWorktreeGoneError } from "../../stores/runtimeStore";
import { useAuthStore } from "../../stores/authStore";
import { useCloudAuthStore } from "../../stores/cloudAuthStore";
import { useUiStore } from "../../stores/uiStore";
import { cloudApi } from "../cloudAgents/api";
import { createCloudAgent } from "../cloudAgents/create";
import { evaluateCloudGate } from "../cloudAgents/gating";
import { projectBindingSets } from "../cloudAgents/projectBinding";
import { ensureCloudProjectId } from "../cloudAgents/projectLink";
import { projectRepoUrl } from "../cloudAgents/repoUrl";
import { classifyStartError } from "../cloudAgents/startError";
import type { CategoryId } from "../../stores/uiStore";
import { localAgentCapacity, type CapacityReading } from "../agentCapacity";
import { closeDecision, worktreeRiskOf, type WorktreeRisk } from "../../engine/closeAgent";
import { agentBranchName } from "./workflow";
import {
  agentBranchStatus,
  agentWorkflowState,
  type BranchStatus,
  type WorkflowState,
} from "../branchStatus";
import { retroSettled } from "../../engine/retroReceiptTypes";
import { cachedReceipt } from "../retroReceipts";
import {
  resolveStage,
  stageIndex,
  unlandedWorkEvidence,
  type WorkflowStageId,
} from "../../engine/workflowStage";
// THE `retire_agent` SAFETY RULE, kept pure and unit-tested as arithmetic. Read its header before
// changing anything on the retire path — every rung in it has a measured failure behind it.
import {
  mayRetire,
  type DeadClaim,
  type LiveActivity,
} from "../../engine/retirementPredicate";
import {
  mayRecordRetroGap,
  retroStanding,
  type RetroStanding,
} from "../../engine/retroEvidence";
import { feedbackEvidenceFor } from "../feedbackEvidenceRead";
import { recordRetroConciergeOverride } from "../retroReceipts";
import { recordAgentRetirement } from "../deathRecordWriter";
import { recordConciergeActionReceipt, nextReceiptId } from "../conciergeReceipts";
import { notifyConcierge } from "../conciergeNotifier";
import { spawnBuildAgentInProject } from "../buildAgentSpawn";
import { recordDispatch } from "../dispatchLedger";
import { awaitBriefDelivery, type BriefDeliveryOutcome } from "../agentBrief";
import { getModelCatalog, isDefaultModel, DEFAULT_MODEL_ID } from "../models";
import { isTornOut } from "../satelliteWindows";
import { atCapacitySentence } from "../agentCapacity";
import {
  shipAgent as shipAgentWork,
  saveAgent as saveAgentWork,
  discardAgentGit,
  spinDownAgentGit,
  type SaveOutcome,
  type ShipOutcome,
} from "../closeAgentActions";
import { closeBuildAgent } from "../closeBuildAgent";
import { recordRetroExcused } from "../retroReceipts";
import { spinDownWorker } from "../workerSpawn";
import { terminateIfCloud } from "../cloudAgents/terminate";
import { log } from "../../logger";
import type { AgentKind, AgentTab, Project, Runtime } from "../../types";
// RESOLUTION FOR THE TWO PROCESS OPS. `locate` below scans `projects[].agents` and is why every
// other op in this file answers `unknown-agent` for the app-owned Improve Sparkle agent — it is
// deliberately not a member of that array (services/knownAgents). `findKnownAgent` is the resolver
// built for "can I address this id?", and it has the Sparkle arm. Bead sparkle-x0pvw.
import { findKnownAgent } from "../knownAgents";
import { restartPaneAwaited } from "../paneControl";
import { killPty } from "../../pty";
import { isSparkleAgentId } from "../sparkleAgent";
// The ONE "is Improve Sparkle mid-work" rule, shared with the write gate and the get_state row.
import { sparkleBusyNow } from "../sparkleBusy";

// ── Operations + their risk ─────────────────────────────────────────────────────────────────────

/**
 * Every lifecycle operation the concierge can name. The runtime list is the source of truth for the
 * union below, so a new op is classified in `LIFECYCLE_RISK` or the build fails.
 *
 * ── ADDING ONE? FOUR TABLES ARE EXHAUSTIVE OVER `LifecycleOp`, AND THE COMPILER FINDS THEM ONE AT
 *    A TIME. Doing all four in a single edit is much cheaper than four round trips:
 *
 *      LIFECYCLE_RISK          (this file)                      — how much thought it needs
 *      LIFECYCLE_ROUTES        conciergeTools/registry.ts        — the arg schema + handler
 *      LIFECYCLE_WRITE         conciergeTools/registry.ts        — does it mutate?
 *      LIFECYCLE_RULES         services/conciergeReceiptClassifier.ts — its audit receipt kind
 *      LIFECYCLE_PHRASES       engine/conciergeActivityLine.ts   — how the live column says it
 *
 *    (`grep -n "Record<LifecycleOp" apps/desktop/src apps/mcp-control/src` is the authority; this
 *    list is a convenience and the grep is what to trust if they ever disagree.)
 *
 *    The op ALSO has to be added to `LIFECYCLE_OPS` in `apps/mcp-control/src/tools.ts`, which is a
 *    hand-kept duplicate of this list — `conciergeOps.test.ts` reads this file and fails on drift,
 *    so that one is caught by a test rather than by the compiler.
 *
 * WHY THIS NOTE EXISTS. Adding `retire_agent` missed `LIFECYCLE_PHRASES`, and the resulting single
 * typecheck error failed FOUR CI checks — including both Desktop Rust jobs, which run the frontend
 * build before they reach Rust and so report a TypeScript error as a Rust failure.
 */
export const LIFECYCLE_OPS = [
  "spawn_build_agent",
  "spawn_cloud_build_agent",
  "preview_close",
  "preview_discard",
  "close_agent",
  "ship_agent",
  "save_agent",
  "discard_agent",
  "spin_down_worker",
  // THE NARROW, UNATTENDED CLOSE — see `retireAgent` for the whole rationale. It is deliberately a
  // SEPARATE op rather than a loosening of `close_agent`, so that op keeps its `ask` tier and both
  // of its refusals and the human close paths cannot regress. Choosing this name is strictly MORE
  // restrictive than choosing `close_agent`, so nothing is escapable by picking it.
  "retire_agent",
  // THE TWO OPS THAT ACT ON A RUNNING PROCESS WITHOUT TOUCHING ITS RECORDS (bead sparkle-x0pvw).
  // Every op above resolves its target through `locate`, a scan of `projects[].agents` — which is
  // why all of them answer `unknown-agent` for the app-owned Improve Sparkle agent, an agent
  // deliberately absent from that array. These two resolve through `findKnownAgent` instead, so the
  // concierge can restart and stop the app's own agent as well as a build agent. They are the only
  // members of this list that are safe to point at it: the rest assume a project row and a
  // user-owned branch that do not exist for it, and `discard_agent` would delete the app-owned
  // clone the hourly scheduler works in.
  "restart_agent",
  "stop_agent",
  // THE ORCHESTRATOR'S OWN RECOVERY VERB (bead `sparkle-abl8ug`). A build agent whose worker exits
  // mid-task could not bring it back: `concierge_tool` is concierge-only, so three starved workers
  // had to be salvaged by hand. This is `restart_agent` NARROWED until it is safe for a caller that
  // is not the concierge — same SEPARATE-OP precedent `retire_agent` set against `close_agent`, and
  // for the same reason: choosing this name is strictly MORE restrictive than choosing
  // `restart_agent`, so it opens no laxer path into the op it delegates to. See `resumeWorker`.
  "resume_worker",
] as const;

export type LifecycleOp = (typeof LIFECYCLE_OPS)[number];

/**
 * How much a caller should think before invoking an operation:
 *   • `irreversible`    — destroys work that cannot be recovered (discard: an unmerged branch, a
 *                         bead, a worktree, cascading to every child).
 *   • `outward-facing`  — reaches the network / the outside world (a push, a PR). Recoverable, but
 *                         other people can see it.
 *   • `costs-money`     — starts something metered (a cloud sandbox bills per running minute).
 *   • `routine`         — local, reversible, or read-only.
 */
export type LifecycleRisk = "irreversible" | "outward-facing" | "costs-money" | "routine";

/** THE exhaustive classification. `Record<LifecycleOp, …>` means an unclassified op is a TYPECHECK
 *  FAILURE, not a runtime surprise. */
export const LIFECYCLE_RISK: Record<LifecycleOp, LifecycleRisk> = {
  // Creating a local agent is cheap and undoable (close it) — but it does consume a worker slot,
  // which is why the spawn is capacity-gated rather than unclassified-and-unbounded.
  spawn_build_agent: "routine",
  // Really performed now, which is what makes this classification load-bearing rather than
  // decorative: a sandbox bills for every running minute, so the op goes through the ask tier's
  // approval surface before anything is started.
  spawn_cloud_build_agent: "costs-money",
  preview_close: "routine",
  preview_discard: "routine",
  // Removes worktrees and store rows; the BRANCH (and therefore the work) survives.
  close_agent: "routine",
  // Pushes the branch and opens a PR — other people see this.
  ship_agent: "outward-facing",
  // Pushes a backup of the branch to the remote.
  save_agent: "outward-facing",
  // Deletes an unmerged branch + bead + worktree, for the agent and every child.
  discard_agent: "irreversible",
  // Drops a worker's tab, PTY and worktree; its branch is kept.
  spin_down_worker: "routine",
  // `routine`, AND — unlike close_agent/spin_down_worker — deliberately NOT raised to `disruptive`
  // by policy.ts's RISK_OVERRIDES. That table exists to ask a human before work is stopped IN
  // FLIGHT, and this op cannot stop work in flight: `mayRetire` refuses a dirty tree, unlanded
  // commits, an unreadable reading of either, and an agent that is still producing output. What is
  // left is an agent that finished, landed, and went quiet. See policy.ts for the paired reasoning.
  retire_agent: "routine",
  // Re-spawns the PTY in place. `routine` because it is genuinely reversible: the spawn path
  // resumes the agent's Claude session (`--resume <id>`), so the conversation survives — see
  // services/paneControl, which calls this "safe by construction". It is the remedy for a pane
  // wedged on a screen its CLI will not leave (a login prompt that ignores Escape).
  restart_agent: "routine",
  // `routine`, AND — like `retire_agent`, and unlike the `restart_agent` it delegates to —
  // deliberately NOT raised to `disruptive` by policy.ts's RISK_OVERRIDES. That table asks a human
  // before work is stopped IN FLIGHT, and `resumeWorker` cannot stop work in flight: it refuses a
  // target that is producing output and refuses one whose activity could not be read at all. What is
  // left is a worker whose process is already gone — the population this verb exists for. See
  // policy.ts for the paired reasoning.
  resume_worker: "routine",
  // Kills the PTY and nothing else — no tab, no worktree, no branch, and for Improve Sparkle no
  // scheduler state. `routine` on the same grounds as restart: `restart_agent` brings it straight
  // back. The RISK_OVERRIDES table in policy.ts still raises both to the `disruptive` approval
  // tier, because "reversible" and "may stop work in flight" are different questions.
  stop_agent: "routine",
};

/** One line per risk class, for the concierge to say when it explains itself. */
export const LIFECYCLE_RISK_NOTE: Record<LifecycleRisk, string> = {
  irreversible: "This permanently destroys work that cannot be recovered.",
  "outward-facing": "This reaches the outside world (a push or a pull request).",
  "costs-money": "This starts something that bills while it runs.",
  routine: "This is local and reversible.",
};

// ── Typed results ───────────────────────────────────────────────────────────────────────────────

/** Why an operation was refused. Machine-readable; `message` carries the human sentence. */
export type LifecycleRefusalReason =
  | "no-project" //             no project resolved (none open, or the id is unknown)
  | "unknown-agent" //          no such agent in any open project
  | "not-a-worker" //           a worker-only operation aimed at something else
  | "not-a-build-agent" //      ship/save/discard aimed at a worker or a shell (see `requireBuild`)
  | "at-capacity" //            the machine's agent budget is full (NOT queued); see agentCapacity
  | "cloud-blocked" //          the cloud gate says no (signed out / unpaid / no auth / no credits).
  //                            `message` is the GATE's own sentence, verbatim, and `deepLink` names
  //                            the Settings section that fixes it.
  | "cloud-goal-required" //    a cloud agent's goal is delivered by the runner at start and cannot
  //                            be sent afterwards, so a spawn with no `prompt` is refused rather
  //                            than given one this layer invented
  | "empty-brief" //            a LOCAL spawn whose `prompt` was PROVIDED but is blank (whitespace
  //                            only). The route schema's `.min(1)` counts whitespace toward length,
  //                            so a blank brief passes bad-args, is delivered verbatim, and boots the
  //                            agent taskless while the reply still claims `briefed` (sparkle-esrsnv).
  //                            Refused rather than delivered; the ABSENCE of `prompt` is still
  //                            legitimate (an empty agent the human types into) and never reaches this.
  | "cloud-no-repo" //          the project has no GitHub remote for the sandbox to clone
  | "needs-decision" //         closing would put work at risk: the human picks ship/save/discard
  | "needs-human-confirm" //    the agent LANDED its work, so only a person may take its row off the
  //                            build list (bead sparkle-0l9xk). Distinct from `needs-decision`:
  //                            nothing is at risk here and there is no ship/save/discard choice to
  //                            make — what is owed is the founder's confirm and a look at what the
  //                            agent reported. The concierge must relay `message`, not retry.
  | "uncommitted-work" //       a worker spin-down would delete a dirty worktree; the branch is kept
  //                            but uncommitted files are NOT, so this is refused until they are
  //                            committed (or the caller passes an explicit discard confirmation).
  //                            RAISED ONLY ON A POSITIVE READING of uncommitted files — never on a
  //                            failed or absent one; that is `status-unknown` below.
  | "status-unknown" //         we could not READ the worker's worktree, so we cannot rule work out.
  //                            Split from `uncommitted-work` for the reason bead sparkle-plxhx
  //                            exists: claiming "X has uncommitted changes" about a provably clean
  //                            tree is a false statement, and it made a fleet-wide deadlock
  //                            undebuggable — the founder was staring at an empty `git status` while
  //                            being told there were changes to commit. Unlike `uncommitted-work`
  //                            this is ESCAPABLE without destroying anything: `allowUnknownStatus`
  //                            retires the worker while still refusing a positively-dirty tree.
  // ── THE `retire_agent` REFUSALS ────────────────────────────────────────────────────────────────
  // Each is the concierge stopping ITSELF, so each one's `message` must name the remedy: this verb
  // runs unattended, and a refusal nobody can clear is the fleet-wide deadlock of bead
  // sparkle-plxhx rather than a safety property.
  | "not-retirable-kind" //     a shell has no worktree or branch, so there is nothing to retire.
  //                            Distinct from `not-a-build-agent`: a WORKER is retirable here.
  | "unlanded-work" //          committed work that never reached main. Retiring keeps the branch,
  //                            but nobody would be left finishing it. Established from
  //                            `unlandedWorkEvidence`, NEVER from the ahead count — see `mayRetire`.
  //                            ALSO RAISED BY `spin_down_worker` (bead sparkle-3duunc): a worker's
  //                            spin-down removes its ROW as well as its checkout, so committed work
  //                            held by nothing but that worker's own local branch is left with
  //                            nobody pointing at it. Same reason code because it is the same rule —
  //                            two spellings of it is how the branch/main seam silently diverged.
  | "unlanded-unknown" //       we could not establish whether the work landed. Same split as
  //                            `uncommitted-work` / `status-unknown`, for the same reason: absence
  //                            of evidence must never be reported as evidence of unlanded work.
  //                            ALSO RAISED BY `spin_down_worker`, for the same bead: an unreadable
  //                            repo cannot authorize a teardown.
  | "activity-unknown" //       we could not read whether the agent is still working. COMMON, not
  //                            exotic: `runtimeStore.status` is window-local, so a whole project
  //                            reads `undefined` after a restart. Cleared by reading the terminal.
  | "reason-required" //        a retirement with no stated reason. The reason is what goes on the
  //                            permanent record the founder reads afterwards.
  | "stale-evidence" //         the retirement claimed the agent was dead but backed it with a
  //                            reading that is not about the present — a lower terminal tier (a
  //                            snapshot, history, the transcript), one outside the freshness window,
  //                            a future-dated one, or an empty excerpt. This is the founder's
  //                            2026-08-12 rule: a quota reading never authorizes a close by itself.
  | "intent-required" //        discard was called without a well-formed DiscardIntent
  | "intent-mismatch" //        the intent names a different agent than the one targeted
  | "unknown-model" //          a spawn named a model this app does not offer (never downgraded)
  | "project-torn-out" //      ANY spawn into a project owned by a satellite (neither window mounts it)
  | "agent-busy" //             restart/stop aimed at the app-owned agent while its hourly
  //                            improvement pass is mutating the worktree it shares with its pane.
  //                            ALSO `retire_agent` aimed at an agent still mid-exchange. Same word
  //                            because it is the same answer — "it is doing something, come back" —
  //                            but note what is NOT at stake there: retirement has already proved
  //                            the tree clean and the work landed, so this rung protects the turn in
  //                            flight, not any file.
  | "no-pane" //                restart/stop aimed at an agent with no mounted pane — nothing to act
  //                            on, and NOT an error: a closed agent simply has no PTY
  | "action-failed"; //         the underlying path failed (details in `message`)

export interface LifecycleOk<T> {
  ok: true;
  op: LifecycleOp;
  risk: LifecycleRisk;
  data: T;
}

export interface LifecycleRefused {
  ok: false;
  op: LifecycleOp;
  risk: LifecycleRisk;
  reason: LifecycleRefusalReason;
  /** A sentence the concierge can say to the human, verbatim. */
  message: string;
  /** Present on `needs-decision`: what closing this agent WOULD do, so the refusal is actionable. */
  preview?: ClosePreview;
  /**
   * The Settings section that FIXES this refusal, when one does (the cloud gate's own `deepLink`,
   * or the server's, forwarded unchanged).
   *
   * Carried as a field rather than folded into `message` because the two are read by different
   * things: the sentence is what the concierge says, and this is what a surface can turn into a
   * button. The dialog already renders exactly this pair ("Add Claude auth" / "Open credits"), so
   * dropping it here would leave the tool path saying "add credits" with no way to get there.
   */
  deepLink?: CategoryId;
}

export type LifecycleResult<T> = LifecycleOk<T> | LifecycleRefused;

function ok<T>(op: LifecycleOp, data: T): LifecycleOk<T> {
  return { ok: true, op, risk: LIFECYCLE_RISK[op], data };
}

function refuse(
  op: LifecycleOp,
  reason: LifecycleRefusalReason,
  message: string,
  preview?: ClosePreview,
): LifecycleRefused {
  return {
    ok: false,
    op,
    risk: LIFECYCLE_RISK[op],
    reason,
    message,
    ...(preview ? { preview } : {}),
  };
}

/** A refusal that carries a self-serve fix. Separate from `refuse` so the deep link can only be
 *  attached deliberately — a `deepLink` naming the wrong Settings section is a button that takes
 *  the user somewhere that cannot fix what they were told about. */
function refuseWithFix(
  op: LifecycleOp,
  reason: LifecycleRefusalReason,
  message: string,
  deepLink?: CategoryId,
): LifecycleRefused {
  return { ...refuse(op, reason, message), ...(deepLink ? { deepLink } : {}) };
}

// ── Capacity ────────────────────────────────────────────────────────────────────────────────────

// The reading itself lives in services/agentCapacity so the human's "+ New Build Agent" path can
// gate on the SAME number without an import cycle through this module (which already imports
// buildAgentSpawn). Re-exported here because this is where callers and tests have always found it.
export type { CapacityReading } from "../agentCapacity";
export { localAgentCapacity };

// ── Lookup helpers ──────────────────────────────────────────────────────────────────────────────

interface Located {
  project: Project;
  agent: AgentTab;
}

function locate(agentId: string): Located | null {
  for (const project of useProjectStore.getState().projects) {
    const agent = project.agents.find((a) => a.id === agentId);
    if (agent) return { project, agent };
  }
  return null;
}

/**
 * The kind gate for ship / save / discard — the three outcomes that only make sense for a BUILD
 * agent. Returns the refusal to hand back, or null when the agent qualifies (roborev 54175).
 *
 * Why each other kind is refused rather than handled:
 *   • `worker` — its branch belongs to the orchestrator that spawned it and is integrated by a local
 *     merge into the parent, never by a PR to the project's default branch; the human path never
 *     offers ship for one. And a discard would delete its branch, worktree and bead out from under an
 *     orchestrator sitting in `wait_for_workers`, which has no channel to learn why its worker
 *     vanished. Closing a worker is `spinDownWorkerAgent` (or `closeAgent`, which routes there).
 *   • `shell` — has no branch and no worktree at all, so ship/save would push nothing, save nothing
 *     and then report success for having merely closed a tab.
 * Discarding a build agent still CASCADES to its workers (see `buildDiscardPreview`); what's refused
 * is naming a worker as the target.
 */
function requireBuild(op: LifecycleOp, agent: AgentTab): LifecycleRefused | null {
  if (agent.kind === "build") return null;
  return refuse(
    op,
    "not-a-build-agent",
    agent.kind === "worker"
      ? `“${agent.name}” is a worker, and its branch is the orchestrator that spawned it — shipping, saving or discarding it behind that orchestrator's back would break work it is waiting on. Spin the worker down instead, or act on its build agent.`
      : `“${agent.name}” is a ${agent.kind} tab with no branch or worktree, so there's nothing to ship, save or discard — just close it.`,
  );
}

/** The agent's children (workers spawned under it), in store order. */
function childrenOf(project: Project, agentId: string): AgentTab[] {
  return project.agents.filter((a) => a.parentId === agentId);
}

/** The stage the sidebar would read for this agent — the SAME derivation requestClose uses, from
 *  the live runtime store rather than any snapshot. */
function stageOf(agentId: string): WorkflowStageId {
  const rt = useRuntimeStore.getState();
  return resolveStage(rt.branchStatus[agentId], rt.workflowStage[agentId]);
}

/** Has this agent's work NOT reached origin main yet? (`merged` is origin main — see workflowStage.) */
function isUnmerged(stage: WorkflowStageId): boolean {
  return stageIndex(stage) < stageIndex("merged");
}

// ── Spawn ───────────────────────────────────────────────────────────────────────────────────────

export interface SpawnedBuildAgent {
  agentId: string;
  projectId: string;
  /** The row's name RIGHT NOW — a spawn-time placeholder ("Build 17"), not the agent's identity.
   *
   *  It used to be called `name`, and that word cost a real failure: the concierge read it and told
   *  the founder "Build 17", which auto-naming had already replaced by the time they read it — so
   *  the name existed nowhere on their screen and they had to ask which agent was meant. The value
   *  is still useful (it is what the row says before the first rename), but nothing may quote it as
   *  identity. `agentId` is the durable handle, and a reference is built from that. */
  provisionalName?: string;
  /**
   * Does the agent this reply describes STILL EXIST?
   *
   * False only for `briefDelivery: "agent-closed"` — the agent was closed (or its project was) while
   * the spawn was waiting on brief delivery, so `agentId` names a row that is gone.
   *
   * Spelled out as a field because the PROSE being right is not enough. The reply is read by a
   * language model whose documented rule is to reference an agent as `[@Name](sparkle-agent:<id>)`,
   * and this file's own `provisionalName` note records that a field the model can quote WILL be
   * quoted. With a live-looking `agentId` + `provisionalName` in the payload, an accurate sentence
   * still invites a pill for a nonexistent agent, or a follow-up `send_to_agent_terminal` /
   * `close_agent` on a dead id — the same "names a control on a deleted row" trap this outcome was
   * introduced to close, relocated from the copy into the data (roborev 55865). `provisionalName` is
   * therefore OMITTED for that outcome: there is no row left to have a name.
   */
  agentExists: boolean;
  /** Always true — spelled out in the payload rather than left to the field name, because the reply
   *  is read by a language model and a flag it can see beats a convention it must infer. */
  nameIsProvisional: true;
  /** The capacity reading AFTER the spawn, so the concierge can say "that's 3 of 8". */
  capacity: CapacityReading;
  /**
   * True ONLY when the brief was OBSERVED to reach the agent — never merely because a prompt was
   * passed in.
   *
   * This field used to be `Boolean(input.prompt)`, and that made it a lie the whole system trusted.
   * The brief was written into the agent's PTY after spawn, which lost the SUBMIT every time (see
   * services/agentBrief for the measurements): the text sat at the agent's prompt with the cursor
   * after it until a human pressed Enter, while this said `true`. On five of five concierge spawns in
   * one evening, two agents sat idle 20+ minutes and one woke with no objective at all — it ran eight
   * forensic checks and correctly reported it had no goal. A spawn that reports success while leaving
   * the agent briefless is worse than one that fails loudly.
   *
   * Now it means: claude was exec'd with the brief as its positional prompt, so claude submits it
   * itself at startup. When that could not be confirmed, this is FALSE and `briefDelivery` says why.
   */
  briefed: boolean;
  /**
   * The brief's delivery outcome, spelled out rather than left for the reader to infer from
   * `briefed` — this reply is read by a language model, and a flag it can see beats a convention it
   * must work out (the same reasoning as `nameIsProvisional`).
   *
   *  • "submitted"     — delivered and submitted. The only value that pairs with `briefed: true`.
   *  • "no-brief"      — none was asked for. A deliberate state (an empty agent), NOT a failure.
   *  • "launch-failed" — the agent's pane will never launch it (spawn error, or no claude on PATH).
   *                      The row SURVIVES and the brief is still attached, so "Start again" sends it.
   *  • "agent-closed"  — the agent was closed or discarded before its brief went out. Kept separate
   *                      from "launch-failed" because the two leave OPPOSITE worlds: here the row is
   *                      gone and the brief with it, so a retry remedy would name a control on a
   *                      deleted row (roborev 55850).
   *  • "launching"     — the wait ran out WHILE A LAUNCH WAS CARRYING THE BRIEF in its argv. Not a
   *                      silence: claude is being exec'd with the prompt, so the only outcomes left
   *                      are delivery or a launch failure that reports itself. The remedy is to WAIT,
   *                      and explicitly NOT to re-send — re-sending double-briefs the agent.
   *  • "unconfirmed"   — no launch has taken the brief and nothing failed within the wait. The brief
   *                      may yet go out, so this is explicitly not "failed" — but it is not success
   *                      either, and nothing may upgrade it to one. This is the only remaining value
   *                      that leaves "the agent is sitting there briefless" on the table.
   *
   * Derived from {@link SpawnBriefDelivery} rather than re-listing the six literals: this field and
   * `briefFailureCopy` must agree about what states exist, and a hand-copied union is exactly how
   * they drift apart. Adding an outcome now updates this automatically and fails the copy function's
   * exhaustiveness guard until someone decides what to say about it. */
  briefDelivery: SpawnBriefDelivery["state"];
  /** Present only when `briefed` is false and a brief WAS asked for: what to tell the human, in the
   *  concierge's own voice, so an undelivered brief surfaces as a thing to act on instead of a
   *  silence. Absent when there was nothing to deliver or delivery succeeded. */
  briefFailure?: string;
  /** The mode the agent actually started in. Echoed because "build" is represented by the absence
   *  of a flag, so silence would otherwise be ambiguous between "build" and "not applied". */
  mode: "plan" | "build";
  /** The model actually in force — the validated id, or "default" when inheriting the user's own
   *  Claude Code setting. */
  model: string;
}

/**
 * A cloud agent that really started. A DIFFERENT shape from {@link SpawnedBuildAgent}, deliberately:
 * most of that type's fields are observations of a LOCAL launch (`briefDelivery`, the capacity
 * reading, the mode/model that were applied to a `claude` argv) and a cloud start observes none of
 * them. Reusing it would have meant filling them in with plausible values — which is precisely how
 * `briefed` became a lie the first time (see `SpawnedBuildAgent.briefed`).
 */
export interface SpawnedCloudBuildAgent {
  /** The tab id, which IS the server session id — one id for the store, the relay and the phone. */
  agentId: string;
  projectId: string;
  /** Spelled out so the reply's reader (a language model) can see it rather than infer it. */
  runtime: "cloud";
  /** The row's name RIGHT NOW. Provisional for the same reason the local spawn's is — omitted
   *  entirely when the caller supplied no name, since there is nothing yet to quote. */
  provisionalName?: string;
  nameIsProvisional: boolean;
  /**
   * What the goal did, stated as what was OBSERVED and no more.
   *
   * `"accepted-by-server"` means: `POST /sessions/start` returned a session id for a request that
   * carried this goal, and the runner seeds Claude Code with it via stdin. It deliberately does NOT
   * claim the equivalent of the local path's `briefed: true`, which is an observation of the launch
   * that carried the brief — nothing on this side sees the sandbox's launch.
   */
  goalDelivery: "accepted-by-server";
  /** The goal the session was started with, echoed so a reply can be checked against it. */
  goal: string;
  /** The https URL the sandbox clones. */
  repoUrl: string;
  /** Always true. A cloud sandbox bills for every running minute, and a flag the model can see
   *  beats a risk class it has to look up. */
  billsWhileRunning: true;
}

export interface SpawnBuildAgentInput {
  /** Defaults to the selected project. */
  projectId?: string;
  /** "local" (the default) or "cloud" — see the file header for what a cloud spawn requires. */
  runtime?: Runtime;
  /**
   * The agent's opening brief, delivered ATOMICALLY with the spawn.
   *
   * This is the point of the whole input object. Spawning blank and then sending a message is two
   * operations, and between them the agent is a briefless row — the exact state the attention
   * engine reads as "needs you", so the workaround for a missing feature manufactured a false red
   * notification every single time. Omitting it is still legitimate (an empty agent the human will
   * type into) and is NOT an attention condition.
   */
  prompt?: string;
  /** Human-readable name, set now rather than leaving the row as "Build N" until auto-naming
   *  catches up — which it may never do if the naming backend is unavailable. */
  name?: string;
  /** A services/models.ts id, or "default" to inherit the user's own Claude Code setting. An id
   *  this app does not offer is REFUSED, never silently downgraded — see below. */
  model?: string;
  /** "plan" starts the agent researching and proposing before it edits anything (the state a human
   *  reaches with shift+tab). "build" is the ordinary mode. */
  mode?: "plan" | "build";
  /**
   * The epic this agent is being started AGAINST — bead sparkle-o05vcs.1.
   *
   * Epic membership in this app is the bead parent-child edge plus `AgentTab.epicId` and nothing
   * else, and the shared spawn already writes BOTH halves when it is given one
   * (`services/buildAgentSpawn.SpawnBuildAgentOpts.epicId`). What was missing was a way for the
   * concierge to SAY the epic: with no field here, every agent the concierge started was structurally
   * invisible to `epicLadder.agentsForEpicSlices` — which makes `engine/epicHealth` answer `gray` BY
   * DEFINITION and the ladder rung `unstaffed`. The founder's audit found 6 of 67 epics staffed, so
   * "Build: Active 1" was not a display bug; it was this argument not existing.
   *
   * Forwarded ONLY on the local arm. `spawnCloudBuildAgent` starts its row through a different path
   * that mints no auto-bead, so there is nothing there to parent — same reasoning that keeps
   * `model`/`mode` unforwarded for a cloud start (see the route in conciergeTools/registry.ts).
   *
   * Absent (the ordinary "start me an agent") the spawn is byte-for-byte what it was: a standalone
   * agent with a top-level bead, which is a supported state, not a degraded one.
   */
  epicId?: string;
}

/**
 * Start a local build agent — the exact sequence the "+ New Build Agent" button runs (tab + open →
 * worktree + PTY on mount, plus the best-effort bead), reached through the shared
 * `spawnBuildAgentInProject` so there is only ever one of it.
 */
export async function spawnBuildAgent(
  input: SpawnBuildAgentInput = {},
): Promise<LifecycleResult<SpawnedBuildAgent | SpawnedCloudBuildAgent>> {
  if (input.runtime === "cloud") return spawnCloudBuildAgent(input);
  const state = useProjectStore.getState();
  const projectId = input.projectId ?? state.selectedProjectId;
  const project = projectId ? state.projects.find((p) => p.id === projectId) : undefined;
  if (!project) {
    return refuse(
      "spawn_build_agent",
      "no-project",
      projectId
        ? `I couldn't find an open project with id ${projectId}.`
        : "There's no project open, so there's nothing to start a build agent in.",
    );
  }
  // NOTHING can be spawned into a torn-out project from this window — briefed or not.
  //
  // An earlier version refused only the BRIEFED spawn, on the reasoning that an empty agent was
  // fine because "the satellite mounts the pane and launches it". That reasoning was WRONG
  // (roborev 55102). `landInAgent` marks the agent live via `useRuntimeStore.open(agentId)`, and
  // the runtime store is NOT cross-window synced — `crossWindowSync` wires exactly two stores,
  // projectStore and dictationStore. So the satellite receives the agent ROW (projectStore is
  // synced) but never the open flag, and renders its "Start this agent" hint instead of mounting
  // anything. Main cannot cover for it either: Workspace `continue`s on torn-out before the
  // visited-or-current check. The agent would exist in no window, with no worktree and no PTY,
  // while still consuming a `localAgentCapacity()` slot — and the reply would have said it started.
  //
  // The brief has its own reason on top: the satellite has its OWN `pendingSends` module instance,
  // so a brief queued here is drained by nobody and the queue does not self-age (roborev 55095).
  //
  // Refused with the honest remedy rather than half-done. Checked BEFORE the capacity gate and
  // before anything is created, so a refused spawn consumes no slot.
  //
  // THE REMEDY NAMES THE ONE THING THAT ACTUALLY WORKS. An earlier draft offered "…or start the
  // agent from that window", which cannot be done: the satellite renders columns ② + ③ only — no
  // tab strip, no "+ New Build Agent" — and its own empty state says the opposite ("start one from
  // the main Sparkle window", satellite/SatelliteApp.tsx). Per this repo's rule that user-facing
  // remedy text is code, an instruction the user cannot carry out is a bug, not phrasing — and this
  // one contradicted copy shipped in the very window it pointed at (roborev 55102).
  if (isTornOut(project.id)) {
    return refuse(
      "spawn_build_agent",
      "project-torn-out",
      `${project.name} is open in its own window, so I can't start an agent in it from here — it ` +
        `would end up with no terminal in either window. Re-dock ${project.name} and I'll start it.`,
    );
  }

  // ALSO ABOVE THE CAPACITY GATE, for the same reason as the torn-out guard: this depends only on
  // the caller's input and can never be satisfied by freeing slots. Below it, an at-capacity request
  // carrying a bad model id was answered with "Close or finish one before starting another" — so the
  // user destroys an agent on the concierge's instruction, the retry sends the same bad id, and only
  // then does the real answer surface (roborev 55108). Both invariant-only preconditions now sit
  // above the one refusal whose remedy is destructive.
  //
  // Validate the model BEFORE anything is created, so a bad id leaves the store untouched rather
  // than producing an agent running the wrong model. Refused rather than silently falling back:
  // routing cheap mechanical work to a small model is the REASON this argument exists, so quietly
  // substituting the default would bill the user for the opposite of what they asked for, with
  // nothing in the reply to say so.
  if (input.model !== undefined && !isDefaultModel(input.model)) {
    const known = getModelCatalog().map((m) => m.id);
    if (!known.includes(input.model)) {
      return refuse(
        "spawn_build_agent",
        "unknown-model",
        `"${input.model}" isn't a model this app offers. Available: ${known.join(", ")}.`,
      );
    }
  }

  // ══ A PRESENT-BUT-BLANK BRIEF IS REFUSED, NEVER DELIVERED ═══════════════════════════════════════
  // `prompt` is the whole point of a briefed spawn, and a whitespace-only string is the one input
  // that slips past every check between here and the agent's terminal: the route schema's `.min(1)`
  // counts whitespace toward length so it clears bad-args, `Boolean(input.prompt)` is true so the
  // reply below would claim `briefed: true`, and the string is handed to the launch verbatim — so the
  // agent boots with a blank opening message, reads it as no task, and answers the nudge ladder
  // `no-task-assigned` while the reply insists it was briefed. That is exactly the incident this
  // guard closes (bead sparkle-esrsnv): an agent spawned "with a brief" that arrived empty, which a
  // human then had to paste in by hand mid-turn.
  //
  // The cloud path already refuses this — `spawnCloudBuildAgent` derives its goal via
  // `input.prompt?.trim()` and returns `cloud-goal-required` when it is empty. The LOCAL path did
  // not, and that asymmetry is what shipped the bug; this restores the symmetry.
  //
  // Fires ONLY when a brief was PROVIDED and is blank — OMITTING `prompt` is still legitimate (an
  // empty agent the human types into) and must not be refused. Checked ABOVE the capacity gate for
  // the same reason as the torn-out and unknown-model guards: it depends only on the caller's input
  // and can never be satisfied by freeing a slot, so a blank brief must not consume one, and nothing
  // is created before it is caught.
  if (input.prompt !== undefined && input.prompt.trim() === "") {
    return refuse(
      "spawn_build_agent",
      "empty-brief",
      "The brief came through blank, so I didn't start an agent — a blank brief boots it with no " +
        "task, and it would just sit there asking what to do. Tell me what the agent should work on " +
        "and I'll start it, or say to start an empty agent and I'll open one for you to type into.",
    );
  }

  // The cap is checked BEFORE anything is created, so an over-cap request leaves the store exactly
  // as it found it. Refused, never queued: a silent queue would leave the human waiting on an agent
  // that has no slot and no ETA.
  const capacity = localAgentCapacity();
  if (capacity.atCapacity) {
    // Says what is TRUE: slots are taken by rows, and only some of those rows have a mounted pane in
    // THIS window right now. Claiming all N are "running" is wrong, and so was the old claim that
    // the rest "haven't started yet, and each one starts as soon as you do" — closed-tab projects
    // were observed with a running-agent count equal to their entire roster. A row without a mounted
    // pane here is a row this window is not DISPLAYING; its process may be running perfectly well,
    // and that sentence sent a human looking for agents that would start later when they were
    // already running. So the clause now reports what `live` actually measures and nothing more.
    return refuse(
      "spawn_build_agent",
      "at-capacity",
      // ONE sentence, shared with every other gate (services/agentCapacity). Two hand-written
      // copies had already got the `live` clause and the ceiling's cause wrong in turn.
      atCapacitySentence(capacity, "I can't start another agent right now."),
    );
  }
  const agentId = spawnBuildAgentInProject(project, {
    prompt: input.prompt,
    name: input.name,
    model: input.model,
    mode: input.mode,
    // The epic binding, settled AT SPAWN rather than by a follow-up write — see
    // `SpawnBuildAgentInput.epicId`. `undefined` is the no-epic case and the shared spawn treats it
    // as the plain "+ New Build Agent" start, so this line changes nothing for a caller that omits it.
    epicId: input.epicId,
    // THE ONE CALLER THAT OPTS INTO BEING DECLINED. A spawn from here is the machine acting on the
    // founder's behalf, not his own hand on a control — so if his caret is in a terminal when this
    // lands, the new agent appears and starts but does not take his screen (engine/attentionGuard).
    // Every direct gesture (the sidebar row, the empty-state button, a file drop) keeps the default
    // `"user"` and still jumps; see SpawnBuildAgentOpts.attention.
    attention: "auto",
    // THE DELEGATION LEDGER'S PROVENANCE, and the ONLY thing this path contributes to it.
    //
    // `spawnBuildAgentInProject` writes the row itself, so there is deliberately no second
    // `recordDispatch` here — two writes for one spawn would double-count the delegation and make
    // the recall path report the same agent twice. All this passes down is the one fact the shared
    // helper cannot work out for itself: a concierge spawn is neither a background sweep nor a hand
    // on a control, and without this it would be recorded as a button press. Since the incident this
    // feature exists for is the concierge failing to recall ITS OWN dispatches, "I did this" is
    // precisely the fact the row must carry.
    dispatchedBy: "concierge",
  });
  if (!agentId) {
    // TWO CAUSES REACH THIS LINE NOW, AND THEY READ DIFFERENTLY TO A HUMAN. Capacity and torn-out
    // are pre-checked above and `background` is never passed, so `null` used to mean exactly one
    // thing: `addAgent` lost a race with the project being removed. `spawnBuildAgentInProject` now
    // also returns `null` when a step between `addAgent` and the brief threw and it tore the row
    // back down — same "nothing was created" guarantee, completely different cause. Reporting that
    // as a closed project sends the human looking for a tab nobody closed, and leaves the real
    // reason only in a WARN.
    const projectStillOpen = useProjectStore.getState().projects.some((p) => p.id === project.id);
    return refuse(
      "spawn_build_agent",
      "action-failed",
      projectStillOpen
        ? // NOT "nothing was created" — narrower on purpose. The teardown guarantees no AGENT
          // exists, but it runs after the foreground trio, so a tab the human closed may have
          // reopened and the selection may have moved. Promising more than that would send them
          // looking for a change that did happen.
          "Something went wrong while starting the agent, so no agent was created — though your project view may have moved. The project is still open, so it's worth trying again."
        : "The project closed while I was starting the agent, so nothing was created.",
    );
  }
  // ══ THE NAME IS PROVISIONAL, AND THE FIELD SAYS SO ════════════════════════════════════════════
  //
  // This used to come back as `name`, and that one word caused a real failure the founder had to
  // stop and correct: the concierge, reading a field called `name`, told them *"Build 17"* — and by
  // the time they read it the agent had auto-named itself something else, so the name it quoted did
  // not exist anywhere in the UI and could not be found. Their words: *"Build 17 is not the name of
  // the agent right now … When you tell me Build 17, that doesn't mean anything to me because I
  // can't see it."*
  //
  // The value is a SPAWN-TIME PLACEHOLDER with a lifespan measured in seconds — auto-naming replaces
  // it as soon as the agent has done enough to be named. So it is returned under a name that cannot
  // be mistaken for identity, beside the field that IS identity. `agentId` is the durable handle;
  // the persona's rule (concierge.rs) is to reference an agent as `[@Name](sparkle-agent:<id>)`,
  // which the renderer resolves to whatever the agent is called at the moment it is READ.
  //
  // Kept rather than dropped because it is genuinely useful to the model — it is what the row says
  // right now, so a reply written before the first rename is not blind — but nothing downstream
  // should quote it as the agent's identity, and a field called `provisionalName` does not invite
  // that the way `name` did.
  const provisionalName =
    useProjectStore
      .getState()
      .projects.find((p) => p.id === project.id)
      ?.agents.find((a) => a.id === agentId)?.name ?? "Build agent";
  log.debug("concierge-lifecycle", "spawned a build agent", { agentId, projectId: project.id });
  // ══ WAIT FOR THE BRIEF TO ACTUALLY GO OUT, THEN REPORT WHAT HAPPENED ══════════════════════════
  //
  // The reply is only allowed to claim `briefed: true` once the launch carrying the brief has run
  // (services/agentBrief). This awaits the launch EVENT — it is not a sleep, and there is
  // deliberately no fixed delay anywhere on this path: a magic duration would be too short on a
  // loaded machine and wasted on an idle one, and the measurements show even "output has been quiet
  // for 2.5s" fires too early to be trusted. The bound inside `awaitBriefDelivery` exists only to
  // stop waiting on silence, and its outcome is "unconfirmed" rather than success.
  //
  // No brief asked for → resolves immediately with nothing held, so an empty spawn is as fast as it
  // ever was.
  const delivery = input.prompt
    ? await awaitBriefDelivery(agentId)
    : ({ state: "no-brief" } as const);
  // OBSERVED AT REPLY TIME, never inferred from the delivery state.
  //
  // This was `delivery.state !== "agent-closed"`, which is a proxy for the question, not the answer —
  // and it is wrong in exactly the cases that matter. Any path that destroys an agent row WITHOUT
  // calling `clearBrief` (the cross-window tombstone merge is one: `withoutRemovedAgents` drops rows
  // whenever the union of this window's and the persisted snapshot's `removedIds` says so) leaves
  // the delivery reading `unconfirmed`, so the inferred flag would ship `agentExists: true` plus a
  // live `provisionalName` for a deleted row — the very "live-looking handle for a dead id" this
  // field was added to prevent, reached through a different door (roborev 55876).
  //
  // Asking the store costs one lookup and is true for EVERY deletion path, including ones not yet
  // written. That is the difference between an invariant a comment asserts and one the code checks.
  const agentExists = useProjectStore
    .getState()
    .projects.find((p) => p.id === project.id)
    ?.agents.some((a) => a.id === agentId) === true;
  const briefFailure = briefFailureCopy(delivery, agentExists);
  return ok("spawn_build_agent", {
    agentId,
    projectId: project.id,
    // Omitted entirely when the row is gone: a name is a thing a row has, and this one no longer
    // exists. Read BEFORE the removal, so keeping it would quote a name nothing can resolve.
    ...(agentExists ? { provisionalName } : {}),
    /** Spelled out in the payload, not only in this file's comments: the reply is read by a language
     *  model, and a flag it can see is worth more than a naming convention it has to infer. */
    nameIsProvisional: true,
    agentExists,
    capacity: localAgentCapacity(),
    briefed: delivery.state === "submitted" && Boolean(input.prompt),
    briefDelivery: delivery.state,
    ...(briefFailure ? { briefFailure } : {}),
    mode: input.mode === "plan" ? "plan" : "build",
    model: isDefaultModel(input.model) ? DEFAULT_MODEL_ID : input.model!,
  });
}

/**
 * Every delivery state a spawn REPLY can carry: the module's own outcomes plus `no-brief`, which is
 * not one of them. `no-brief` is a fact about the REQUEST (none was asked for), settled here without
 * ever consulting `agentBrief` — so it is deliberately not in `BriefDeliveryOutcome`, and this union
 * is where the two meet.
 */
type SpawnBriefDelivery = BriefDeliveryOutcome | { readonly state: "no-brief" };

/**
 * What to tell the human when a brief did not confirm — `undefined` when there is nothing to say.
 *
 * ══ THE REMEDY MUST BE AN ACTION THAT ACTUALLY WORKS ══════════════════════════════════════════
 *
 * …under the conditions that triggered it. This repo treats a wrong remedy string as a bug, not as
 * phrasing, and this one function has now been wrong four times in the same shape. Extracted from the
 * reply body so each branch is directly testable: the defect is always a STATE reaching copy written
 * for a different state, which is a property of this mapping and of nothing else.
 *
 *   • THE ROW BEING GONE OUTRANKS THE DELIVERY OUTCOME, and that ordering is load-bearing. Making
 *     `agentExists` an observation created a combination the copy never anticipated — a timed-out
 *     delivery TOGETHER WITH `agentExists: false` — because any path that destroys a row without
 *     settling the brief leaves the delivery reading as a timeout. Keyed on the delivery state alone,
 *     that reply told the human to "check that it picked up the task" about an agent that no longer
 *     exists (roborev 55888). So: if the row is gone, say so, whatever the delivery outcome was. Only
 *     a SURVIVING row gets outcome-specific wording, because only then is there something to look at.
 *   • `launch-failed` means the agent's TERMINAL never started (spawn error, or no claude on PATH),
 *     so it is NOT "running with no objective" — an earlier draft said that and described the wrong
 *     state entirely. The row exists and `noteBriefFailed` deliberately RETAINS the brief, so
 *     "Start again" genuinely re-emits it.
 *   • `launching` vs `unconfirmed` is the newest split, and it exists because one string covered both.
 *     Its "check that it picked up the task" was followed exactly as written on three consecutive
 *     spawns whose briefs were already in claude's argv: the brief was re-sent by hand, double-briefing
 *     each agent (one re-send the full-screen-app write guard refused outright). A brief committed to
 *     a live launch needs patience, and saying anything that reads as "go make sure" invites the
 *     duplicate — so that branch names waiting as the action and names re-sending as the harm.
 */
export function briefFailureCopy(
  delivery: SpawnBriefDelivery,
  agentExists: boolean,
): string | undefined {
  // THE ROW BEING GONE IS TESTED FIRST, and this ordering is the invariant the docstring states.
  //
  // Extracting this function once put the `submitted`/`no-brief` early return ABOVE this check, which
  // silently reversed it: an agent whose brief HAD gone in and which was then closed during the reply
  // window produced no `briefFailure` at all, where it previously said the row was gone. That is not
  // cosmetic — `conciergeReceiptClassifier.spawnShortfall` marks the receipt fatal on
  // `agentExists === false` and words it from this sentence, so dropping it downgraded the receipt to
  // a generic "that agent is already gone" for the one case the human most needs the specifics of.
  if (!agentExists) {
    // …but the CLAUSE ABOUT THE BRIEF has to match what actually happened to it, or this becomes the
    // same wrong-remedy defect one layer down: telling someone the brief never went in, when it did,
    // invites them to re-send it to the replacement agent on top of a brief it already has.
    const briefClause =
      delivery.state === "submitted"
        ? "it was closed right after its opening brief went in, so nothing is running"
        : delivery.state === "no-brief"
          ? "it was closed, so nothing is running"
          : "it was closed before its opening brief went in, so nothing is running and the brief " +
            "went with it";
    const restart =
      delivery.state === "no-brief"
        ? "Say the word and I'll start a fresh one."
        : "Say the word and I'll start a fresh one with the same brief.";
    return `That agent is gone — ${briefClause}. ${restart}`;
  }
  if (delivery.state === "submitted" || delivery.state === "no-brief") return undefined;
  switch (delivery.state) {
    case "launch-failed":
      return (
        `I created the agent, but its terminal didn't start — ${delivery.reason} — so its opening ` +
        `brief hasn't gone in yet. Its brief is still attached, so "Start again" on that agent will ` +
        `send it; nothing needs re-typing.`
      );
    case "launching":
      return (
        "I created the agent and its opening brief is in the launch command claude is starting " +
        "with, but it's still coming up, so I can't call it delivered yet. It should pick the task " +
        "up on its own — give it a moment rather than re-sending, which would brief it twice."
      );
    case "unconfirmed":
      // Reaching here now means something stronger than it used to: nothing ever read the brief to
      // launch with, so this really is the "it may be sitting there briefless" case.
      return (
        "I created the agent, but I couldn't confirm its opening brief went in — nothing had " +
        "picked it up to launch with. Check that it got the task before relying on it."
      );
    case "agent-closed":
      // The row is gone, so the `!agentExists` branch above has already said so with the right
      // sentence. Listed explicitly rather than falling into a default — see the exhaustiveness
      // guard below for why this function may not have a catch-all arm.
      return undefined;
    default: {
      // EXHAUSTIVE BY CONSTRUCTION — a `default: return undefined` here was a silent trapdoor.
      //
      // This is the one function whose documented defect mode is "a STATE reaching copy written for
      // a different state", and a catch-all removes the compiler's only way to catch it: adding a
      // sixth `BriefDeliveryOutcome` would yield `briefed: false` with NO `briefFailure`, so
      // `conciergeReceiptClassifier.spawnShortfall` returns undefined and the receipt reads as a
      // clean success for a brief that never arrived. Now a new outcome fails the typecheck here
      // until someone decides what to say about it.
      const _never: never = delivery;
      void _never;
      return undefined;
    }
  }
}

/**
 * The cloud gate, read from the two stores that hold its inputs — the SAME assembly `useCloudGate`
 * does for the dialog, minus React. It is not shared with that hook because the hook is a set of
 * `useStore` subscriptions; the DECISION it feeds (`evaluateCloudGate`) is shared, which is the half
 * that must not have two copies.
 *
 * `cloudAuthStore` is deliberately NOT persisted, so it is cold on every launch — and a cold store
 * now reads as ALLOWED, not as "no auth". Unprobed is UNKNOWN, and nobody may refuse on a fact
 * nobody looked up; `POST /sessions/start` is the definitive check and refuses with the server's own
 * reason. A FAILED probe reads the same way, deliberately: `refresh` leaves `loaded` false on error,
 * and blocking on that would refuse every cloud spawn for the rest of the sign-in over one flaky GET.
 *
 * So the probe here is an OPTIMISATION, not the gate: it discovers a genuinely missing credential
 * before spending a server round-trip, and lets the tool answer with the specific "add your Claude
 * authentication" guidance instead of a generic failure. Remove it and nothing becomes unsafe —
 * spawns simply reach the server before being told no.
 */
async function readCloudGate() {
  const cloudAuth = useCloudAuthStore.getState();
  if (!cloudAuth.loaded) await cloudAuth.refresh(); // never throws; sets `error` and leaves method
  // RE-READ THE BALANCE, for the same reason both dialogs do — and more sharply here. `me` is
  // persisted, and once a user is entitled `AuthGate` stops refreshing it on focus, so the only
  // routine re-reads are the two dialogs' own effects, the credits panel, and deep-link/dictation
  // events. A server-side auto-topup, or any top-up that did not come back through the
  // `sparkle://auth` deep link, therefore leaves this store quoting a launch-time balance — and now
  // that this gate refuses against the server's floor rather than 1¢, that stale number can refuse a
  // spawn on an account that is funded. Best-effort exactly like the probe above. SWALLOWED
  // deliberately — `refresh` reaches the keychain through `hasToken()`, which throws outside a Tauri
  // webview, and a gate that cannot be read must not become a gate that cannot be passed.
  const lastKnown = useAuthStore.getState().me;
  await useAuthStore
    .getState()
    .refresh()
    .catch(() => {});
  const auth = useAuthStore.getState();
  // LAST-KNOWN, NEVER ZERO. `refresh` does not merely fail quietly: a `/me` it could not complete —
  // network down, backend unreachable, an ambiguous 401 — CLEARS `me` outright once the entitlement
  // grace window has lapsed. Reading `me?.balanceCents ?? 0` straight off that would convert a
  // balance we just failed to LEARN into a definitive "you don't have enough credits", deep-linking
  // a funded user to Credits they do not need. That is the same thing the cloud-auth probe above
  // refuses to do — nobody may refuse on a fact nobody looked up — so a refresh that came back with
  // no `me` decides on the reading we already had. (A refresh that finds no TOKEN is different and is
  // not covered by this: it also clears `tokenPresent`, so the gate returns `signed_out` below,
  // which is both true and actionable.)
  const me = auth.me ?? lastKnown;
  return evaluateCloudGate({
    signedIn: auth.tokenPresent,
    // Re-read AFTER the await: the refresh above is the whole point of asking. And an unprobed or
    // FAILED probe still reads as allowed — `refresh` leaves `loaded` false when the GET fails, and
    // refusing on that would state as fact something we never learned, for the rest of the sign-in.
    // `POST /sessions/start` is the definitive check and refuses with the server's own reason.
    authConfigured:
      useCloudAuthStore.getState().method != null || !useCloudAuthStore.getState().loaded,
    // NULL, NOT ZERO. The `?? lastKnown` above covers a refresh that CLEARED a balance we once had;
    // this covers never having had one (a cold, funded, non-entitled account persists no `me`), for
    // which there is no last-known to fall back to. Both endings must be "we did not learn it",
    // never "it is zero" — see the credits check in `evaluateCloudGate`.
    balanceCents: me?.balanceCents ?? null,
    // The server's own start floor, transported — see the identical note in `useCloudGate`. The
    // concierge must refuse on the same number the dialog's cost line quotes, or "you need $1.00 to
    // start" and a tool that happily starts are two answers to one question. Absent falls back to
    // CLOUD_MIN_START_CENTS, so an older `/me` behaves exactly as before.
    minStartCents: me?.cloudAgentPricing?.minStartCents,
  });
}

/**
 * Start a CLOUD build agent — the exact sequence `NewCloudAgentDialog.start()` runs, reached from a
 * tool call. See the file header for why each of the old refusal's stated reasons is satisfied here
 * rather than used as grounds to refuse.
 *
 * The order of the three preconditions is not arbitrary. The GATE runs first because it is the only
 * one that can say "this account may not do this at all", and because its refusal is the one with a
 * self-serve fix attached; asking for a goal or probing `gh` first would make a signed-out user
 * answer two questions before learning they cannot start one anyway. The goal is checked before the
 * repo lookup because it is free and the lookup shells out to `gh`.
 */
async function spawnCloudBuildAgent(
  input: SpawnBuildAgentInput,
): Promise<LifecycleResult<SpawnedCloudBuildAgent>> {
  const op: LifecycleOp = "spawn_cloud_build_agent";
  const state = useProjectStore.getState();
  const projectId = input.projectId ?? state.selectedProjectId;
  const project = projectId ? state.projects.find((p) => p.id === projectId) : undefined;
  if (!project) {
    return refuse(
      op,
      "no-project",
      projectId
        ? `I couldn't find an open project with id ${projectId}.`
        : "There's no project open, so there's nothing to start a cloud agent for.",
    );
  }

  // ══ THE GATE'S MESSAGE IS RETURNED VERBATIM ═════════════════════════════════════════════════════
  // Not paraphrased, not wrapped in a friendlier sentence. Each of those strings names the ONE thing
  // that unblocks the user ("Add your Claude authentication…", "…require a paid account. Upgrade…"),
  // it is already the copy the dialog shows for the identical block, and it ships beside the
  // `deepLink` that reaches the fix. A second wording here would be a second copy that can drift
  // from the one the dialog shows for the same state — and this repo treats a remedy string as code.
  const gate = await readCloudGate();
  if (!gate.ok) return refuseWithFix(op, "cloud-blocked", gate.message, gate.deepLink);

  // ══ THE GOAL IS REQUIRED, AND IS NEVER INVENTED ═════════════════════════════════════════════════
  // A cloud agent's goal is delivered by the runner via stdin as the session starts; there is no
  // "spawn it empty and tell it later" for one. The concierge's `prompt` IS that goal. Refusing is
  // the only honest option: a spawn that made one up would bill the user by the minute for work
  // nobody asked for, and the local path's own history (`SpawnedBuildAgent.briefed`) is what a
  // briefless agent costs even when it is free.
  const goal = input.prompt?.trim() ?? "";
  if (!goal) {
    return refuse(
      op,
      "cloud-goal-required",
      "A cloud agent is started with its goal — the sandbox seeds Claude Code with it as it comes " +
        "up, so there's no way to tell it afterwards the way there is with a local agent. Tell me " +
        "what it should do and I'll start it.",
    );
  }

  // The sandbox CLONES the repo. Null means we genuinely could not determine it (no gh, no remote,
  // not a GitHub repo) — refuse rather than send a bad URL and let the user discover it as an opaque
  // server-side clone failure minutes into a billing sandbox.
  let repoUrl: string | null;
  try {
    repoUrl = await projectRepoUrl(project.rootPath);
  } catch {
    repoUrl = null; // projectRepoUrl is documented never to throw; belt for a future change.
  }
  if (!repoUrl) {
    return refuse(
      op,
      "cloud-no-repo",
      `A cloud agent clones the repo into its sandbox, and I couldn't work out ${project.name}'s ` +
        `GitHub repository — it needs a GitHub remote (and the gh CLI signed in). A local agent ` +
        `works on this project without one.`,
    );
  }

  try {
    // A cloud session is keyed to the ORCHESTRATION project row, not this project's locally-minted
    // id. Same call, same injected binding sets as the dialog — the rules about which server row a
    // project may adopt live in projectLink/projectBinding and must not be re-derived here.
    const cloudProjectId = await ensureCloudProjectId(project, {
      api: cloudApi,
      remember: (localId, cloudId) => useProjectStore.getState().setCloudProjectId(localId, cloudId),
      ...projectBindingSets(project.id),
    });

    const ps = useProjectStore.getState();
    const res = await createCloudAgent(
      {
        projectId: cloudProjectId,
        goal,
        repoUrl,
        ...(project.defaultBranch ? { baseBranch: project.defaultBranch } : {}),
        ...(input.name?.trim() ? { name: input.name.trim() } : {}),
      },
      {
        // The store deps ignore the id they're handed for the same reason the dialog's do:
        // `createCloudAgent` passes the id it sent to the SERVER, while the tab belongs to the LOCAL
        // project record.
        api: cloudApi,
        addAgent: (_serverProjectId, opts) => ps.addAgent(project.id, opts),
        selectAgent: (_serverProjectId, agentId) => ps.selectAgent(project.id, agentId),
        open: (agentId) => useRuntimeStore.getState().open(agentId),
        reveal: (agentId) => useUiStore.getState().requestRevealAgent(agentId),
      },
    );

    if (!res.ok) {
      // The SERVER's refusal, forwarded with its own fix. `orphanedSessionId` means the start
      // SUCCEEDED and only the tab failed — the sandbox is running and billing — and
      // `startedUntrackedGuidance` is the message that says so. Retrying would start a second one,
      // so this must never read as "nothing happened" (roborev 46278).
      return refuseWithFix(op, "action-failed", res.guidance.message, res.guidance.deepLink);
    }

    log.debug("concierge-lifecycle", "started a cloud build agent", {
      agentId: res.id,
      projectId: project.id,
    });
    const named = input.name?.trim();
    // ══ THE DELEGATION LEDGER — THE CLOUD PATH'S OWN ROW (services/dispatchLedger) ═══════════════
    //
    // A SECOND WRITE SITE, not a duplicate of the local one. The cloud spawn never reaches
    // `spawnBuildAgentInProject` — it goes `ensureCloudProjectId` → `createCloudAgent` → its own
    // `addAgent` — so the line that records every local delegation cannot see this one at all. Left
    // out, "start it in the cloud" would be the one phrasing that makes a dispatch unrememberable,
    // which is the same class of hole as the incident: a delegation that happened and that the
    // concierge cannot later find.
    //
    // WRITTEN HERE, past `res.ok`, because until the server hands back a session id there is nothing
    // to key a row on. The refusal above is not a delegation, even the `orphanedSessionId` flavour:
    // that one carries no id this side can quote, so a row for it would name no agent.
    //
    // `by: "concierge"` unconditionally — `spawn_cloud_build_agent` is a concierge tool and has no
    // button behind it, so unlike the local path there is no ambiguity to derive.
    //
    // `brief` is the GOAL, which for a cloud agent is the whole of what it was told: the runner seeds
    // Claude Code with it via stdin as the sandbox comes up, and `cloud-goal-required` above refuses
    // the spawn outright when it is empty. So this row can never carry the local path's legitimate
    // empty brief.
    void recordDispatch({
      targetId: res.id,
      channel: "cloud-build",
      nameAtDispatch: named ?? null,
      projectId: project.id,
      projectName: project.name,
      brief: goal,
      by: "concierge",
    });
    return ok(op, {
      agentId: res.id,
      projectId: project.id,
      runtime: "cloud",
      // Only when the caller named it. An auto-named row has no name yet, and the local path's own
      // history says a spawn-time placeholder quoted as identity is worse than no name at all.
      ...(named ? { provisionalName: named } : {}),
      nameIsProvisional: !named,
      goalDelivery: "accepted-by-server",
      goal,
      repoUrl,
      billsWhileRunning: true,
    });
  } catch (err) {
    // Everything the project-link or the start threw (offline, signed out, server error) goes
    // through the SAME classifier the dialog uses, so one failure gets one set of fixes wherever it
    // is surfaced.
    const guidance = classifyStartError(err);
    return refuseWithFix(op, "action-failed", guidance.message, guidance.deepLink);
  }
}

// ── Previews (read-only) ────────────────────────────────────────────────────────────────────────

/** One thing a discard would destroy. */
export interface DiscardTarget {
  agentId: string;
  name: string;
  kind: AgentKind;
  /** The branch that would be DELETED (null if the agent never got one). */
  branch: string | null;
  /** The bead that would be DELETED (null if it has none). */
  beadId: string | null;
  /** The worktree that would be REMOVED. */
  worktreePath: string | null;
  stage: WorkflowStageId;
  /** True when this branch has NOT reached origin main — i.e. deleting it loses the work. */
  unmerged: boolean;
}

export interface DiscardPreview {
  agentId: string;
  projectId: string;
  /** The agent FIRST, then every child, in store order — exactly what discard would act on. */
  targets: DiscardTarget[];
  childAgentIds: string[];
  branches: string[];
  beadIds: string[];
  /** True when ANY target's work has not reached origin main. The number that should make a human
   *  stop and read. */
  anyUnmerged: boolean;
  /** Always true. Present so a caller rendering this preview cannot forget to say so. */
  irreversible: true;
  /** The token `DiscardIntent.confirm` must carry. */
  requiredConfirm: typeof DISCARD_CONFIRM_TOKEN;
}

/** What the concierge should offer. `keep-open` is a real answer: closing an agent removes its
 *  worktree in EVERY outcome, so uncommitted changes are lost by ship, save and discard alike —
 *  the honest move is to have the agent commit first. `discard` is deliberately absent: it is never
 *  recommended, only ever chosen. */
export type CloseRecommendation = "close" | "ship" | "save" | "keep-open";

export interface ClosePreview {
  agentId: string;
  projectId: string;
  name: string;
  kind: AgentKind;
  runtime: Runtime;
  stage: WorkflowStageId;
  /** `closeDecision === "work-at-risk-prompt"` — closing needs the ship/save/discard decision. */
  wouldPrompt: boolean;
  /**
   * `closeDecision === "retirement-confirm"` — the work LANDED, so only the founder may take the row
   * off the build list (bead sparkle-0l9xk). A THIRD state, not a flavour of `wouldPrompt`: nothing
   * is at risk here and there is no ship/save/discard choice to make.
   *
   * It exists because the preview and the action had come apart (roborev 59153): `wouldPrompt` is
   * derived from the work-at-risk question alone, which is `false` for a landed agent — so the
   * concierge announced "closing is safe and silent" for exactly the population `closeAgent` then
   * refused. A preview that describes a different close than the one that will happen is worse than
   * no preview.
   */
  retirementConfirm: boolean;
  /** Neither prompt fires: nothing at risk AND nothing landed to confirm. Genuinely a teardown. */
  silentClose: boolean;
  commitsAhead: number;
  uncommittedChanges: boolean;
  unmergedCommittedWork: boolean;
  /** True when we have no branch reading yet (or the worktree is parked on another branch) — we
   *  cannot rule out work at risk, so the cautious answer is used. */
  statusUnknown: boolean;
  recommended: CloseRecommendation;
  /** A sentence explaining the recommendation, for the concierge to say. */
  reason: string;
  childAgentIds: string[];
  /** Exactly what a discard WOULD destroy, computed up front so the consequence can be explained
   *  before anything is chosen. */
  discardPreview: DiscardPreview;
}

/** Read-only: what would closing this agent do? THE function that makes this domain safe to expose. */
export function previewClose(agentId: string): LifecycleResult<ClosePreview> {
  const found = locate(agentId);
  if (!found) return refuse("preview_close", "unknown-agent", unknownAgent(agentId));
  const { project, agent } = found;
  const rt = useRuntimeStore.getState();
  const bs = rt.branchStatus[agentId];
  const stage = stageOf(agentId);
  // THE SAME CALL THE SIDEBAR × MAKES (AgentSidebar.requestClose) — `closeDecision`, not the old
  // `shouldPromptOnClose` boolean. The × moved to `closeDecision` when the retirement gate landed
  // and this did not follow, which is precisely how the preview came to describe a silent teardown
  // for a row the action refuses (roborev 59153). One decision, three outcomes, read once.
  const decision = closeDecision(agent.kind, stage, bs, {
    settled: retroSettled(cachedReceipt(project.id, agentId)),
  });
  const wouldPrompt = decision === "work-at-risk-prompt";
  const retirementConfirm = decision === "retirement-confirm";
  // `statusUnknown` keeps the parked arm: for a PREVIEW, "the tree is off its minted branch" is a
  // real caveat a reader should see. What it must not do is masquerade as uncommitted work.
  const statusUnknown = !bs || bs.worktreeOnBranch === false;
  const commitsAhead = bs?.ahead ?? 0;
  // A POSITIVE READING ONLY (bead sparkle-plxhx). This used to be
  // `bs.dirty || bs.worktreeOnBranch === false`, which reported `uncommittedChanges: true` for every
  // worker parked on a descriptively-named branch — including six whose worktrees were
  // `git status --porcelain` EMPTY. Both flags then came back true at once, and the preview asserted
  // changes existed while the operator was looking at a clean tree.
  //
  // `worktreeRiskOf` is the shared rule: parking cannot make an empty tree non-empty, and a dirty
  // parked tree still answers "dirty" so the safety call the old comment defended is intact.
  const uncommittedChanges = worktreeRiskOf(bs) === "dirty";
  const unmergedCommittedWork = commitsAhead > 0 && isUnmerged(stage);
  const { recommended, reason } = recommend({
    wouldPrompt,
    retirementConfirm,
    statusUnknown,
    uncommittedChanges,
    commitsAhead,
    stage,
    kind: agent.kind,
  });
  const discardPreview = buildDiscardPreview(project, agent);
  return ok("preview_close", {
    agentId,
    projectId: project.id,
    name: agent.name,
    kind: agent.kind,
    runtime: agent.runtime,
    stage,
    wouldPrompt,
    retirementConfirm,
    silentClose: !wouldPrompt && !retirementConfirm,
    commitsAhead,
    uncommittedChanges,
    unmergedCommittedWork,
    statusUnknown,
    recommended,
    reason,
    childAgentIds: childrenOf(project, agentId).map((a) => a.id),
    discardPreview,
  });
}

/** The recommendation ladder. Note what it CANNOT return: `discard` is not in the union at all, so
 *  no future edit here can make destruction the default suggestion.
 *
 *  EVERY rung must be reachable — a recommendation the concierge advertises but can never produce is
 *  a documented behavior that doesn't exist. `shouldPromptOnClose` is true for exactly four reasons
 *  (no reading yet, parked tree, dirty tree, commits ahead), so once the first three rungs have
 *  returned, `commitsAhead > 0` is the only case left, and the ship/save split below is decided by
 *  whether that work already has a PR (roborev 54175). */
function recommend(i: {
  wouldPrompt: boolean;
  retirementConfirm: boolean;
  statusUnknown: boolean;
  uncommittedChanges: boolean;
  commitsAhead: number;
  stage: WorkflowStageId;
  kind: AgentKind;
}): { recommended: CloseRecommendation; reason: string } {
  // CHECKED FIRST, and before the "safe and silent" sentence below — that sentence was the false one
  // a landed agent used to get (roborev 59153). The work IS safe; the row is not free to remove.
  if (i.retirementConfirm) {
    // …BUT "the row needs your confirm" IS NOT "there is nothing left to do" (knightwatch
    // 5204094441#3, second-order). Widening the gate to `merged_local` brought a stage into this rung
    // that genuinely still has somewhere to go: landed on LOCAL main with commits origin has never
    // seen. Answering `keep-open` there would drop the one recommendation that moves it forward, and
    // falling through is not an option either — the next rung is the "safe and silent" sentence
    // roborev 59153 removed from exactly these rows. So the rung splits on the outstanding work and
    // says BOTH facts, since the retirement flag rides alongside in `retirementConfirm` regardless.
    // GATED ON THE STAGE, NOT THE COUNT ALONE (roborev 59899). `commitsAhead > 0` does not mean
    // "not on origin": `ahead` is `rev-list --left-right --count`, so it only reaches 0 once the
    // branch TIP is an ancestor of the base — a squash or rebase merge defeats that permanently and
    // `ahead` stays N forever (workflowStage.ts spells this out). `merged` and `shipped` rows
    // therefore routinely carry a non-zero count, and gating on the count alone told the founder
    // their work "has landed locally" with commits that "have not reached the remote yet" — false,
    // it is on origin — and recommended `ship`, which asks `gh` for a second pull request on a
    // branch whose PR already merged. That is the false-copy-on-landed-rows defect roborev 59153
    // fixed, reintroduced one rung lower.
    //
    // `isUnmerged` is the predicate that already means what this needs (`building_saved` ≤ stage <
    // `merged`), and `previewClose` computes `unmergedCommittedWork` from the same pair — so this
    // rung and that field cannot disagree about one row. Within this branch only `merged_local` can
    // satisfy it, which is why the old `pull_request ? "save" : "ship"` ternary was dead code:
    // `pull_request` sorts BELOW the retirement boundary and can never reach here.
    if (i.commitsAhead > 0 && isUnmerged(i.stage)) {
      const n = i.commitsAhead;
      return {
        recommended: "ship",
        reason:
          `This agent's work has landed locally, so its code is safe — but ${n} commit${n === 1 ? " has" : "s have"} ` +
          `not reached the remote yet, and that is worth doing before the row goes. Taking the row off the build ` +
          `list is separately yours to confirm: close it from its row and I'll show you what it reported first.`,
      };
    }
    return {
      recommended: "keep-open",
      reason:
        "This agent's work has landed, so its code is safe — but taking the row off the build list " +
        "is yours to confirm, and I'd want you to see what it reported on its way out. Close it from " +
        "its row and I'll show you that first.",
    };
  }
  if (!i.wouldPrompt) {
    return {
      recommended: "close",
      reason:
        i.kind === "build"
          ? "Nothing is at risk — this agent never made any work to lose. Closing is safe and silent."
          : "Workers are the orchestrator's business; closing one just drops its tab and worktree, and its branch is kept.",
    };
  }
  if (i.uncommittedChanges) {
    return {
      recommended: "keep-open",
      reason:
        "There are uncommitted changes in this agent's worktree. Closing removes the worktree in EVERY case — ship, save and discard alike — so those changes would be lost. Ask the agent to commit first, then close.",
    };
  }
  if (i.statusUnknown) {
    return {
      recommended: "keep-open",
      reason:
        "I can't read this agent's git state yet, so I can't rule out unsaved work. Give it a moment and ask me again.",
    };
  }
  // Only `commitsAhead > 0` can reach here (see the header): committed work that hasn't landed.
  // A branch that ALREADY has a PR open is the save case — shipping it again would ask `gh` for a
  // second pull request on the same branch, which errors, leaving the work merely pushed. Saving
  // backs it up and keeps the branch + bead while the existing PR gets reviewed.
  if (i.stage === "pull_request") {
    // NOT "there's nothing left to ship" (roborev 54225). `commitsAhead` is measured against the
    // base branch, not against the PR's head, so this rung is reached precisely when there may be
    // commits the open pull request hasn't seen — which is what the save's push is FOR. And the
    // push is only best-effort, so the promise is conditional: what actually happened comes back in
    // `save_agent`'s `data.save`.
    const n = i.commitsAhead;
    return {
      recommended: "save",
      reason:
        `This branch already has a pull request open, so shipping it again would ask \`gh\` for a second pull ` +
        `request on the same branch, which just fails. Saving pushes the branch — which is also how any of its ` +
        `${n} commit${n === 1 ? "" : "s"} the pull request hasn't seen yet get to it — and keeps the branch (and ` +
        `its task) while the review finishes. If that push can't reach the remote I'll tell you rather than call ` +
        `it backed up.`,
    };
  }
  return {
    recommended: "ship",
    reason: `This agent has ${i.commitsAhead} commit${i.commitsAhead === 1 ? "" : "s"} that haven't reached main. Shipping pushes the branch and opens a pull request, which is how work gets reviewed and landed.`,
  };
}

/** Read-only: exactly what a discard would destroy. */
export function previewDiscard(agentId: string): LifecycleResult<DiscardPreview> {
  const found = locate(agentId);
  if (!found) return refuse("preview_discard", "unknown-agent", unknownAgent(agentId));
  return ok("preview_discard", buildDiscardPreview(found.project, found.agent));
}

function buildDiscardPreview(project: Project, agent: AgentTab): DiscardPreview {
  const rows = [agent, ...childrenOf(project, agent.id)];
  const targets: DiscardTarget[] = rows.map((a) => {
    const stage = stageOf(a.id);
    return {
      agentId: a.id,
      name: a.name,
      kind: a.kind,
      branch: a.branch,
      beadId: a.beadId ?? null,
      worktreePath: a.worktreePath,
      stage,
      // A branch with no commits of its own can't lose work, but we have no cheap way to prove that
      // per-branch here, so "hasn't reached origin main" is the cautious reading — it over-reports
      // rather than under-reports, which is the correct direction for a destructive preview.
      unmerged: isUnmerged(stage),
    };
  });
  return {
    agentId: agent.id,
    projectId: project.id,
    targets,
    childAgentIds: rows.slice(1).map((a) => a.id),
    branches: targets.map((t) => t.branch).filter((b): b is string => !!b),
    beadIds: targets.map((t) => t.beadId).filter((b): b is string => !!b),
    anyUnmerged: targets.some((t) => t.unmerged),
    irreversible: true,
    requiredConfirm: DISCARD_CONFIRM_TOKEN,
  };
}

// ── Close: the silent teardown ──────────────────────────────────────────────────────────────────

export interface ClosedAgents {
  /** The agent and every child that was torn down. */
  agentIds: string[];
  projectId: string;
  /** Which outcome actually ran. */
  outcome: "close" | "ship" | "save" | "spin-down" | "retire";
  /** THE NAME OF THE AGENT THIS TORE DOWN, because after this reply nothing else can supply it.
   *
   *  `conciergeReceiptClassifier` takes a receipt's subject from the CALL ARGS, and every op in this
   *  family is argued by id alone; the renderer then tries the live roster to turn that id into a
   *  name and necessarily MISSES, because the op it is reporting has just removed the row. Without
   *  this the receipt degrades to its anonymous fallback and reads "Closed that agent." — the
   *  founder's 2026-08-18 complaint, which he raised about the retire wording and which this family
   *  reaches by the same route.
   *
   *  DECLARED HERE RATHER THAN LEFT TO INFERENCE (roborev 65334, Medium). It previously survived
   *  only because `ok()` infers through generics and a non-fresh object literal gets no
   *  excess-property check — so nothing in the type system asserted the reply carried it, and a
   *  refactor that built this from a typed value would have dropped it silently while every test
   *  stayed green. Optional, because the ship/save outcomes share this shape and do not set it. */
  agentName?: string;
}

/**
 * Close an agent whose work is NOT at risk — the silent teardown behind the sidebar's ×. Branches
 * are kept (a merged branch may be safe-deleted per the user's `delete_merged_branch` setting, via
 * `git branch -d`, which refuses an unmerged branch).
 *
 * REFUSES with `needs-decision` — carrying the preview — when `shouldPromptOnClose` says work is at
 * risk. It deliberately does NOT fall back to any destructive outcome; the human (through the
 * concierge) picks ship, save, or discard explicitly.
 */
export async function closeAgent(
  agentId: string,
  /**
   * The agent's stated reason for having NO retro, when it offers one (bead sparkle-0l9xk).
   *
   * This is the live path into `recordRetroExcused` — the agent side of the receipt store, and the
   * only receipt state an agent writes about itself. Untyped on purpose: it arrives off the tool
   * wire as whatever was typed, and `recordRetroExcused` runs it through muster.
   *
   * IT DOES NOT BUY A CLOSE. A landed row still comes back `needs-human-confirm` below, settled or
   * not — the receipt decides what the dialog SAYS, never whether to ask. What it buys is that the
   * founder reads the agent's own words at confirm time instead of "nothing on file".
   */
  noRetro?: { reasonCode?: unknown; reasonText?: unknown },
): Promise<LifecycleResult<ClosedAgents>> {
  const found = locate(agentId);
  if (!found) return refuse("close_agent", "unknown-agent", unknownAgent(agentId));
  if (noRetro) {
    const excuse = await recordRetroExcused(found.project.id, agentId, noRetro);
    // A rejected WORDING is relayed with muster's own phrase so the agent can rephrase; retrying the
    // same text would fail identically. A failed WRITE is deliberately NOT fatal here — the excuse
    // is a nicety, the close decision below is the gate, and refusing to close because a note could
    // not be written would strand the row over the least important thing in the operation.
    if (excuse.status === "rejected") {
      return refuse(
        "close_agent",
        "action-failed",
        `I can't record that as “${found.agent.name}”'s reason for having no retro: ` +
          `${excuse.why}. Give me a reason in your own words and I'll put it on the record.`,
      );
    }
  }
  const preview = previewClose(agentId);
  if (!preview.ok) return refuse("close_agent", preview.reason, preview.message);
  if (preview.data.wouldPrompt) {
    return refuse(
      "close_agent",
      "needs-decision",
      `Closing “${preview.data.name}” would put work at risk, so I won't do it silently. ${preview.data.reason}`,
      preview.data,
    );
  }
  if (found.agent.kind === "worker") {
    const r = await spinDownWorkerAgent(agentId);
    return r.ok
      ? ok("close_agent", { ...r.data, outcome: "close" as const })
      : refuse("close_agent", r.reason, r.message);
  }
  const ids = [agentId, ...childrenOf(found.project, agentId).map((a) => a.id)];
  // closeBuildAgent is the existing one-click "Close Build Agent": it terminates any cloud sandbox
  // in the subtree, drops the panes, removes the worktrees, and honors delete_merged_branch.
  //
  // `false` — THE CONCIERGE IS NOT A HUMAN CONFIRMATION. It is the caller that produced this bead:
  // it closed three landed agents on its own judgement, and each of them left with its retro
  // unread. It may still close everything that has NOT landed; a landed row comes back refused and
  // the refusal is relayed rather than worked around.
  const closed = await closeBuildAgent(agentId, false);
  if (!closed.ok) return refuse("close_agent", closed.reason, closed.message);
  // `agentName` — see the note on `spinDownWorkerAgent`'s reply. The roster row is gone by the time
  // the receipt renders, so without this the line reads "Closed that agent."
  return ok("close_agent", {
    agentIds: ids,
    projectId: found.project.id,
    outcome: "close",
    agentName: found.agent.name,
  });
}

// ── Retire: the unattended close ────────────────────────────────────────────────────────────────
//
// THE OP THE FOUNDER ASKED FOR ON 2026-08-12, verbatim: *"no i absolutely do not want close_agent to
// be human only. let's fix that so you can close agents that need to be closed"* — said with ~78 of
// 81 agent slots held, many by agents that had finished.
//
// `close_agent` above is UNCHANGED. It keeps its `ask` policy tier, its `needs-decision` refusal and
// its `needs-human-confirm` refusal, so the sidebar ×, the phone tap and the green suggestion button
// cannot regress through this change. This is a second, NARROWER door, and everything that makes it
// safe is in `engine/retirementPredicate.mayRetire` — read that file's header before touching this.
//
// ── THE ONE THING TO GET RIGHT: EVERY READING IS TAKEN LIVE ──────────────────────────────────────
// `previewClose` answers from `runtimeStore`, which is a 30-second cache with two states that never
// recover on their own, alongside a `status` map that is window-local and reads `undefined` for a
// whole project after a restart. This op must not answer from either. See `readRetirementFacts`.
//
// ── AND WHAT IT WRITES BEFORE IT DESTROYS ANYTHING ───────────────────────────────────────────────
// The durable record is written FIRST and its failure ABORTS the retirement. That ordering is the
// whole point: `AgentSidebar.confirmRetire` already follows it for the human path, because
// destroying the row and the record of why it went, together, is the failure worth designing
// against — and this path runs while nobody is watching.

/** What a retirement did. */
export interface RetiredAgents extends ClosedAgents {
  outcome: "retire";
  /** Whether a "no retro was on file" mark was written. See `mayRecordRetroGap`. */
  gapReceiptWritten: boolean;
  /** The retro standing that was resolved at retirement, for the concierge to report. */
  retroStanding: RetroStanding["kind"];
}

/**
 * The three writes this op makes outside itself, as an INJECTED object.
 *
 * On the deps object rather than inline at the call site, deliberately (bead sparkle-lgbwf, seen
 * 4×): a seam that every test supplies and production writes inline is a seam whose production line
 * is covered by nothing — delete it and the suite stays green while the bug comes back. Defaulted
 * here, so one test can drive the real path.
 */
export interface RetireDeps {
  /** Writes the permanent "no retro on file" mark. Resolves FALSE when the write failed. */
  recordGap: typeof recordRetroConciergeOverride;
  /** Writes the durable audit record. Resolves FALSE when the write failed — and that ABORTS. */
  recordRetirement: typeof recordAgentRetirement;
  /** The live "is this agent still mid-exchange" reading. */
  readActivity: (agentId: string) => LiveActivity;
}

const DEFAULT_RETIRE_DEPS: RetireDeps = {
  recordGap: recordRetroConciergeOverride,
  recordRetirement: recordAgentRetirement,
  readActivity: liveActivityOf,
};

/**
 * Map the live status map onto the predicate's three-valued activity reading.
 *
 * `undefined` BECOMES `unknown`, NEVER `quiet`. `runtimeStore.status` is written only by a mounted
 * pane, so after a relaunch — or for any project no window hosts — every agent in the fleet reads
 * `undefined`. Collapsing that to "quiet" would make the entire fleet retirable on the strength of a
 * map nobody had populated, which is the exact shape of the staleness bug this verb was built after.
 *
 * The RED tier (`waiting`/`approval`/`questions`) counts as busy rather than quiet. Those agents are
 * not emitting tokens, but each is holding an exchange open with a human, and retiring one silently
 * discards a question somebody was going to answer.
 */
export function liveActivityOf(agentId: string): LiveActivity {
  const status = useRuntimeStore.getState().status[agentId];
  if (status === undefined) return "unknown";
  if (status === "working" || status === "questions" || status === "waiting" || status === "approval")
    return "working";
  return "quiet";
}

/**
 * Take every safety reading LIVE, at the moment of the decision.
 *
 * ONE READER FOR BOTH TEARDOWN VERBS. `retire_agent` and `spin_down_worker` ask the same two
 * questions — what is in the tree, and did the work land — so they ask them through this. The
 * spin-down path used to carry its own `readAgentWorktreeRisk`, identical in every arm; that copy
 * is gone, because two spellings of one safety ladder is how the surfaces drift apart.
 *
 * ── WHY THIS RE-READS INSTEAD OF TRUSTING THE STORE (bead sparkle-plxhx) ─────────────────────────
 * `runtimeStore.branchStatus` is a 30-second poll with two states that never recover on their own. A
 * worker whose worktree was removed is LATCHED into `deadWorktrees` and never polled again, so its
 * entry stays `undefined` for the app's lifetime; a worker whose pane was never mounted may have no
 * entry at all. Deciding a teardown from a permanently-stale cache is how a fail-safe default became
 * a fail-PERMANENT one. So we ask git, now. The live call deliberately BYPASSES the `deadWorktrees`
 * latch (it invokes the Tauri command directly rather than going through `pollBranchStatus`),
 * because the latched population is exactly the population that needs an answer here.
 *
 * ── FALLBACK ORDER, AND WHY A THROW IS NOT AUTOMATICALLY "UNKNOWN" ───────────────────────────────
 * A worktree that is GONE is not an ambiguity — there is no checkout left, so a teardown destroys
 * no FILES, and `isWorktreeGoneError` already owns that signature; answering `"clean"` for it is a
 * statement about a directory that demonstrably is not there. Any OTHER failure falls back to the
 * cached reading (a stale-but-real observation beats none) and only then to `unknown`, which
 * refuses.
 *
 * ⚠️ That `"clean"` is about the TREE ONLY, and the branch rung must not read it as an all-clear:
 * a gone worktree leaves no `BranchStatus`, so `unlanded` comes back `undefined` and
 * `spinDownWorkerAgent` needs `ws` — which is read from branch REFS and survives a missing
 * checkout — to tell a landed-or-pushed branch from one nobody else is holding.
 */
async function readRetirementFacts(
  project: { id: string; rootPath: string; defaultBranch?: string | null },
  agentId: string,
  /**
   * The ORCHESTRATOR's branch, for a worker. Empty for anything else.
   *
   * It is what makes `WorkflowState.inParent` answerable at all — Rust computes that containment
   * against the branch name it is handed, so passing `""` (which every caller did before bead
   * sparkle-3duunc) makes it a permanent `false`. The spin-down guard reads it as the ordinary,
   * SAFE shape of a finished worker: the orchestrator merged the branch into its own and is now
   * reclaiming the slot, so the commits are held by something other than the row about to vanish.
   * Without it that guard would refuse every normal worker teardown, which is the fail-PERMANENT
   * direction bead sparkle-plxhx was filed over.
   */
  parentBranch = "",
): Promise<{
  worktreeRisk: WorktreeRisk;
  unlanded: boolean | undefined;
  bs?: BranchStatus;
  ws?: WorkflowState;
}> {
  const rt = useRuntimeStore.getState();
  const cached = rt.branchStatus[agentId];
  const base = project.defaultBranch ?? "";
  let bs: BranchStatus | undefined;
  let worktreeRisk: WorktreeRisk;
  try {
    bs = await agentBranchStatus(project.rootPath, project.id, agentId, base);
    // Keep the store honest, so the sidebar stops rendering the stale reading the moment this runs.
    rt.setBranchStatus(agentId, bs);
    worktreeRisk = worktreeRiskOf(bs);
  } catch (e) {
    bs = cached;
    worktreeRisk = isWorktreeGoneError(e) ? "clean" : worktreeRiskOf(cached);
  }
  let ws: WorkflowState | undefined;
  try {
    // `probePrState: false` — the PR probe reaches GitHub, and `unlandedWorkEvidence` deliberately
    // does not consult `prState` anyway (it is the state of the branch's PR, not of the branch).
    ws = await agentWorkflowState(project.rootPath, agentId, parentBranch, false, project.id);
  } catch {
    ws = rt.workflowState[agentId];
  }
  return {
    worktreeRisk,
    // REUSED, NOT RE-DERIVED. This function already yields to direct reachability over the ahead
    // count, which is the only way a squash-landed branch (ahead: N forever) reads as landed.
    unlanded: unlandedWorkEvidence({ bs, ws, stageOverride: rt.workflowStage[agentId] }),
    bs,
    ws,
  };
}

/**
 * POSITIVE proof that this branch's commits exist somewhere OTHER than the worker's own local
 * branch — i.e. that dropping the worker's row strands nothing (bead sparkle-3duunc).
 *
 * Every term is a `=== true`, and that is the whole design: `WorkflowState`'s booleans are all
 * optional, so a Rust build predating any one of them deserializes it to `undefined`, and `false`
 * on this type means "not known to be" rather than "known not to be". This function is only ever
 * asked to CLEAR a refusal, so it must speak only from evidence that ran.
 *
 * The four terms, and why each one is a real answer to "would tearing this row down lose it":
 *   • `pushed`         — `refs/remotes/origin/<branch>` exists (Rust `branch_pushed`). The commits
 *                        are on a remote. This is the axis bead sparkle-3duunc names by hand.
 *   • `inParent`       — the orchestrator's branch contains the worker's tip. The NORMAL shape of a
 *                        finished worker: merged up, slot being reclaimed. See `parentBranch` above.
 *   • `inOriginMain` /
 *     `landedOnOrigin` — it reached origin main outright, by ancestry or by squash-equivalence.
 *                        Redundant with `unlanded === false` in the ordinary case, and NOT redundant
 *                        in the case that matters: a GONE worktree makes `agentBranchStatus` throw,
 *                        and `unlandedWorkEvidence` answers `undefined` whenever it has no
 *                        `BranchStatus` at all — even with a perfectly good workflow reading in hand.
 *
 * ⚠️ NO LOCAL TERM. `inLocalMain` and `landed` are deliberately absent, the same scoping
 * `unlandedWorkEvidence` documents at length: a branch merged into LOCAL main only still needs
 * somebody to carry it the rest of the way, and this function's job is to say who else is holding
 * the work — not whether it exists on this laptop, which is exactly what is being torn down.
 */
function commitsHeldElsewhere(ws: WorkflowState | undefined): boolean {
  return (
    ws?.pushed === true ||
    ws?.inParent === true ||
    ws?.inOriginMain === true ||
    ws?.landedOnOrigin === true
  );
}

/** A one-line branch measurement for the audit record, in the same shape `branchEvidence` uses. */
function branchEvidenceOf(bs: BranchStatus | undefined): string | null {
  if (!bs) return null;
  return `${bs.ahead} ahead, ${bs.dirty ? "dirty" : "clean"}`;
}

/**
 * Retire an agent that has finished — unattended, and with NO CAP.
 *
 * The no-cap decision is the founder's, made explicitly on 2026-08-12 and matching the "no cap,
 * trust the concierge" call already recorded for research dispatch. `mayRetire`'s header carries the
 * reasoning; do not add a limit here without taking it back to him.
 */
export async function retireAgent(
  agentId: string,
  args: { reason: string; deadClaim?: DeadClaim | null },
  deps: RetireDeps = DEFAULT_RETIRE_DEPS,
): Promise<LifecycleResult<RetiredAgents>> {
  const found = locate(agentId);
  if (!found) return refuse("retire_agent", "unknown-agent", unknownAgent(agentId));
  const { project, agent } = found;

  const facts = await readRetirementFacts(project, agentId);
  const verdict = mayRetire({
    kind: agent.kind,
    worktreeRisk: facts.worktreeRisk,
    unlanded: facts.unlanded,
    liveActivity: deps.readActivity(agentId),
    reason: args.reason,
    deadClaim: args.deadClaim ?? null,
    now: Date.now(),
  });
  if (!verdict.ok) {
    return refuse("retire_agent", verdict.refusal, `I won't retire “${agent.name}”. ${verdict.message}`);
  }

  // ── THE RETRO STANDING ──────────────────────────────────────────────────────────────────────────
  // Resolved for BUILD agents only: workers report to an orchestrator, not to the build list, and
  // have never been part of the retro gate (`closeDecision` answers `silent` for them).
  //
  // ALL FOUR ARMS RETIRE — the founder's boundary choice on 2026-08-12, which explicitly extended
  // this to landed rows carrying no retro at all. What differs is what gets WRITTEN, and the split
  // is not cosmetic: `mayRecordRetroGap` answers true ONLY for `absent`, the one arm where a
  // trustworthy read affirmatively found nothing. A receipt has no delete path anywhere in this app,
  // and 19 of the 29 receipts once on disk were false marks written on absence-of-evidence. So an
  // `unknown` standing — the backlog was unreadable — retires WITHOUT accusing, and says so in the
  // durable record instead. Retiring on an unreadable backlog is fine; accusing on one is not.
  //
  // A WORKER RECORDS `unknown`, NOT `settled`. Both suppress the gap write, so the behaviour is the
  // same either way — but the value lands in the permanent record, and `settled` would assert a
  // retro standing that was never determined. `unknown` is the honest word for "not established
  // here", and it is what the record should say to anyone reading it later.
  const standing: RetroStanding =
    agent.kind === "build"
      ? retroStanding(
          retroSettled(cachedReceipt(project.id, agentId)),
          feedbackEvidenceFor(project.id, agentId),
        )
      : { kind: "unknown" };

  let gapReceiptWritten = false;
  if (agent.kind === "build" && mayRecordRetroGap(standing)) {
    gapReceiptWritten = await deps.recordGap(project.id, agentId, {
      // NAMES ITS AUTHOR. The founder's own gap note says "Retired by the founder"; a machine-written
      // one that borrowed that sentence would put words in his mouth on a permanent record.
      reasonText:
        "Retired by the concierge with no retro receipt on file, and no agent-feedback beads " +
        "attributed to this agent in a fresh read of the backlog at the time.",
      branchEvidence: branchEvidenceOf(facts.bs),
    });
    // A FAILED GAP WRITE IS NOT FATAL — and that is the opposite call from the audit write below.
    // The two records answer different questions. This one is a claim ABOUT THE AGENT that we were
    // unable to file; the retirement is still safe and still fully recorded by the audit write,
    // which carries `gapReceiptWritten: false` so the gap is visible as unfiled rather than implied.
  }

  // ── THE DURABLE RECORD, BEFORE ANYTHING IS DESTROYED ───────────────────────────────────────────
  const recorded = await deps.recordRetirement({
    agentId,
    reason: args.reason,
    retiredBy: "concierge",
    evidence: {
      worktreeRisk: facts.worktreeRisk,
      landed: facts.unlanded === undefined ? null : !facts.unlanded,
      stage: stageOf(agentId),
      branch: agent.branch ?? null,
      ahead: facts.bs?.ahead ?? null,
      retroStanding: standing.kind,
      gapReceiptWritten,
      terminalEvidence: args.deadClaim?.evidence ?? null,
      terminalEvidenceObservedAt: args.deadClaim?.observedAt ?? null,
    },
  });
  if (!recorded) {
    return refuse(
      "retire_agent",
      "action-failed",
      `I couldn't write the record of why I was retiring “${agent.name}”, so I've left it open. ` +
        `Retiring it now would take the row and the reason it went at the same time, and this runs ` +
        `while you're not watching — the record is the only thing that would have told you.`,
    );
  }

  // ── THE READABLE RECORD ─────────────────────────────────────────────────────────────────────────
  // The durable write above is the one that survives a restart and gates the teardown; this is the
  // one the founder actually SEES, in the audit pane, without opening a file. `retired` is its own
  // receipt kind rather than a flavour of `closed`, because "I asked for this and forgot" and "the
  // app did it while I slept" are the two readings he must be able to tell apart.
  //
  // WRITTEN ONLY AFTER THE TEARDOWN ACTUALLY HAPPENED, which is the opposite ordering from the
  // durable record above, and deliberately so — the two answer different questions. The durable one
  // must precede the destruction, because its whole job is to make sure nothing is destroyed
  // unrecorded. This one is a report of what DID happen, so recording it up front would put a
  // cheerful `ok: true` in the founder's audit pane for a retirement that then failed and left the
  // row sitting in front of him. A receipt that disagrees with the roster is exactly the
  // did-it-really-happen ambiguity this module exists to end.
  //
  // NOT gated on: a failed receipt is a rendering loss, and the fact is already durable above.
  const noteReceipt = (): void => {
    recordConciergeActionReceipt({
      id: nextReceiptId(),
      kind: "retired",
      ok: true,
      agentId,
      agentName: agent.name,
      // VERBATIM, never a gist — the judgement is the part worth checking.
      reason: args.reason,
      at: Date.now(),
      op: "retire_agent",
    });
    // ── AND TELL HIM ────────────────────────────────────────────────────────────────────────────
    // The founder asked to be told what was retired while he was away, which is the half a record
    // alone does not deliver: a log answers a question he has to think to ask.
    //
    // `"report"`, NEVER the default `"pusher"` kind. The Pusher preamble instructs the concierge to
    // "act on each one now … do not simply relay them to him" — handed a finished retirement that
    // becomes an instruction to undo or re-do completed work. A retirement already happened, and
    // relaying it plainly IS the deliverable.
    //
    // Capacity is named because relieving it is the entire point of the verb, and "I retired six
    // agents" means nothing without the number it bought back.
    const cap = localAgentCapacity();
    notifyConcierge(
      `Retired “${agent.name}” — ${args.reason} (${cap.used} of ${cap.limit} agent slots now in use).`,
      "report",
    );
  };

  // ── THE TEARDOWN ────────────────────────────────────────────────────────────────────────────────
  if (agent.kind === "worker") {
    const r = await spinDownWorkerAgent(agentId);
    if (!r.ok) return refuse("retire_agent", r.reason, r.message);
    noteReceipt();
    return ok("retire_agent", {
      ...r.data,
      outcome: "retire" as const,
      gapReceiptWritten,
      retroStanding: standing.kind,
    });
  }
  const ids = [agentId, ...childrenOf(project, agentId).map((a) => a.id)];
  // `true` — AND THIS IS THE FIRST PRODUCTION CALLER OF THAT BRANCH, which closeBuildAgent's header
  // has reserved since bead sparkle-0l9xk for "the day one of them earns a human confirm of its
  // own". What earns it is not a human standing behind this call; it is the founder's standing
  // authorization plus `mayRetire`, which refuses everything his confirm was protecting — work at
  // risk, unlanded commits, an unreadable reading of either, an agent still mid-exchange — and the
  // durable record above, which cannot fail silently because it is written first and gates this line.
  const closed = await closeBuildAgent(agentId, true);
  if (!closed.ok) return refuse("retire_agent", closed.reason, closed.message);
  noteReceipt();
  return ok("retire_agent", {
    agentIds: ids,
    projectId: project.id,
    outcome: "retire",
    gapReceiptWritten,
    retroStanding: standing.kind,
  });
}

// ── Ship ────────────────────────────────────────────────────────────────────────────────────────

/** What a ship did, alongside what was torn down. `ship` is the outcome reported by
 *  closeAgentActions.shipAgent — the concierge must read it rather than assume a PR exists. */
export interface ShippedAgents extends ClosedAgents {
  outcome: "ship";
  ship: ShipOutcome;
  /**
   * TRUE when the work shipped but the ROW IS STILL THERE, because shipping is precisely what makes
   * the retirement gate apply (bead sparkle-0l9xk): a landed build agent may only be taken off the
   * list by a person.
   *
   * Read it. `agentIds` is `[]` in that case, and announcing "shipped and closed" over a row the
   * founder can still see is the same class of false report as announcing a PR that was never
   * opened — the failure the `ShipOutcome` contract above exists to prevent.
   */
  retirementPending: boolean;
}

/**
 * Ship: push the branch + open a PR (local land fallback when there's no remote), then tear the
 * agent down. The bead bookkeeping lives in closeAgentActions.shipAgent — it is only marked done on
 * a real outcome, so a failed land keeps the branch AND the open task.
 *
 * SUCCESS IS READ FROM THE OUTCOME, NEVER FROM "IT DIDN'T THROW" (roborev 54175). Only a push
 * failure throws; a `gh` failure and a failed local land both return normally, so inferring success
 * from the absence of an exception made the concierge announce "shipped, PR opened" for a branch that
 * had no PR — or, worse, for work that never left the machine. The three real answers:
 *   • landed / pr-opened  → shipped; tear down and say which of the two happened.
 *   • pushed-no-pr        → the BRANCH is safe on the remote (nothing is lost by tearing down), but
 *                           no review is open, so `data.ship` carries `prOpened: false` + the reason.
 *   • land-failed         → nothing landed anywhere. Refuse and KEEP the agent, exactly like a throw.
 */
export async function shipAgent(agentId: string): Promise<LifecycleResult<ShippedAgents>> {
  const found = locate(agentId);
  if (!found) return refuse("ship_agent", "unknown-agent", unknownAgent(agentId));
  const { project, agent } = found;
  const wrongKind = requireBuild("ship_agent", agent);
  if (wrongKind) return wrongKind;
  const ids = [agentId, ...childrenOf(project, agentId).map((a) => a.id)];
  let outcome: ShipOutcome;
  try {
    outcome = await shipAgentWork({
      root: project.rootPath,
      projectId: project.id,
      agentId,
      targetBranch: project.defaultBranch ?? agent.baseBranch ?? "main",
      prTitle: agent.name,
      beadId: agent.beadId,
    });
  } catch (e) {
    // The agent is KEPT on a ship failure — its branch and worktree are exactly where they were.
    return refuse(
      "ship_agent",
      "action-failed",
      `I couldn't ship “${agent.name}” (${errText(e)}). I've left the agent open so nothing is lost.`,
    );
  }
  if (outcome.kind === "land-failed") {
    // No remote and the local merge failed: the work is exactly where it was. Same treatment as a
    // throw — refuse, keep the agent, and do NOT touch closeBuildAgent.
    return refuse(
      "ship_agent",
      "action-failed",
      `I couldn't ship “${agent.name}”: this repo has no remote, and merging the branch into ` +
        `${project.defaultBranch ?? agent.baseBranch ?? "main"} locally failed (${outcome.reason}). ` +
        `I've left the agent open so nothing is lost.`,
    );
  }
  // Ship SUCCEEDED — that fact is not up for revision below. What follows only decides whether the
  // row also goes, and a refusal here must never be reported as a failed ship: the branch is landed
  // or on the remote either way, and telling the founder his ship failed would send him to re-do a
  // merge that is already done.
  //
  // `outcome.landed` SHORT-CIRCUITS THE GATE'S OWN STAGE READ (knightwatch probe 2). `closeBuildAgent`
  // resolves the stage from `runtimeStore.branchStatus`, which was polled BEFORE this ship and still
  // says pre-merge — so a local land that merged the branch seconds ago reads as unlanded and closes
  // silently. The ship's own outcome is the fresher, more direct fact: it just did the merge.
  if (outcome.landed) {
    // …AND PERSIST IT, so the fact outlives this tick (knightwatch 5204094441#3). Nothing else
    // remembers a no-remote land: the poll re-derives the stage from git, where a landed branch is a
    // clean tree 0 ahead — the same reading as an agent that built nothing. Without this the gate
    // holds exactly once and the next close resolves to `silent`. `resolveStage` maxes the override
    // against the derived stage, so it can only ratchet up.
    useRuntimeStore.getState().setWorkflowStage(agentId, "merged_local");
    return ok("ship_agent", {
      agentIds: [],
      projectId: project.id,
      outcome: "ship",
      ship: outcome,
      retirementPending: true,
    });
  }
  const closed = await closeBuildAgent(agentId, false);
  return ok("ship_agent", {
    // `[]`, not `ids`, when the row survived: `agentIds` is what the concierge reads to say what it
    // tore down, and naming agents that are still on the list is the misreport this field exists
    // to make impossible.
    agentIds: closed.ok ? ids : [],
    projectId: project.id,
    outcome: "ship",
    ship: outcome,
    retirementPending: !closed.ok,
  });
}

// ── Save ────────────────────────────────────────────────────────────────────────────────────────

/** What a save did with the branch, alongside what was torn down. `save` is the outcome reported by
 *  closeAgentActions.saveAgent — the concierge must read it rather than assume a remote backup. */
export interface SavedAgents extends ClosedAgents {
  outcome: "save";
  save: SaveOutcome;
}

/**
 * Save for later: back the branch up to the remote (best-effort), remove the worktree, and KEEP the
 * branch and the bead. Never deletes a branch — not even a merged one — because "save" is the
 * outcome a human picks when they mean "don't lose this".
 *
 * SUCCESS IS READ FROM THE OUTCOME HERE TOO (roborev 54225). Ship got this treatment first; save
 * needs it just as much, and arguably more now that `recommend` makes save the RECOMMENDED answer
 * for a branch with a PR already open — the common path. The push was swallowed, so an offline /
 * unauthed / rejected backup returned exactly like a successful one and the concierge said "backed
 * the branch up to the remote and kept it" with the worktree already gone and nothing on the remote.
 *
 * Unlike ship, no `SaveOutcome` is a refusal: the branch and the bead survive on this machine in
 * every case, which is the whole of what save promises. Only the SENTENCE changes, and `data.save`
 * is what decides it.
 */
export async function saveAgent(agentId: string): Promise<LifecycleResult<SavedAgents>> {
  const found = locate(agentId);
  if (!found) return refuse("save_agent", "unknown-agent", unknownAgent(agentId));
  const { project } = found;
  const wrongKind = requireBuild("save_agent", found.agent);
  if (wrongKind) return wrongKind;
  const ids = [agentId, ...childrenOf(project, agentId).map((a) => a.id)];
  const save = await saveAgentWork(project.rootPath, agentId);
  // Deliberately NOT closeBuildAgent: that honors delete_merged_branch, and a save must keep every
  // branch unconditionally.
  await tearDownKeepingBranches(project, ids);
  return ok("save_agent", { agentIds: ids, projectId: project.id, outcome: "save", save });
}

/** The sidebar's `teardownAgent` for a build subtree: stop any cloud sandbox, drop the panes, remove
 *  the worktrees (branches KEPT), then drop the rows. */
async function tearDownKeepingBranches(project: Project, ids: string[]): Promise<void> {
  await Promise.all(ids.map((id) => terminateIfCloud(project.agents.find((a) => a.id === id))));
  const { close } = useRuntimeStore.getState();
  for (const id of ids) close(id);
  // `beadIds` is deliberately NOT passed here, unlike the closeBuildAgent path. A SAVE keeps every
  // branch precisely so the work can be resumed, so closing its bead would contradict the gesture.
  // The trade-off is real and known: removeAgent below means syncBeadLifecycle can never reach this
  // bead again, so it stays wherever it was. That is a parked bead, not a shipped one — the right
  // end-state is arguably `open` rather than `in_progress`, which bd has no single verb for. Left
  // as a deliberate follow-up rather than silently closing preserved work.
  await spinDownAgentGit({
    root: project.rootPath,
    projectId: project.id,
    ids,
    deleteBranch: false,
  });
  // Same shape as `closeBuildAgent`: the awaited git teardown above means any pane has already
  // unmounted, so the `close:` trace `removeAgent` would have opened had nothing left to end it.
  // The store's mounted-pane gate settles that (bead sparkle-bxidpw).
  useProjectStore.getState().removeAgent(project.id, ids[0]!);
}

// ── Discard: the irreversible one ───────────────────────────────────────────────────────────────

/** The literal token a caller must echo back to discard. Spelled out so it can never be produced by
 *  a stray boolean, a truthy object, or a yes/no answer bubbling up from somewhere else. */
export const DISCARD_CONFIRM_TOKEN = "discard-permanently" as const;

/**
 * The explicit, non-defaulted intent `discardAgent` requires.
 *
 * Two fields, both load-bearing:
 *   • `confirm` — the exact token above. There is no boolean form, because `true` is the single most
 *     likely value for a variable to hold by accident.
 *   • `agentId` — the agent the human confirmed. It must equal the one being discarded, so a
 *     confirmation that has gone stale (the concierge moved on, a different row is selected) cannot
 *     be spent on the wrong agent.
 */
export interface DiscardIntent {
  confirm: typeof DISCARD_CONFIRM_TOKEN;
  agentId: string;
}

/** Fails closed, exactly like conciergeDispatch's `isDispatchAuthority`: TypeScript stops the call
 *  sites it can see, this stops the shapes it can't (a value off the wire, a JS caller, an MCP
 *  argument object). */
export function isDiscardIntent(v: unknown): v is DiscardIntent {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Partial<DiscardIntent>;
  return o.confirm === DISCARD_CONFIRM_TOKEN && typeof o.agentId === "string" && o.agentId !== "";
}

export interface DiscardOutcome {
  /** What was destroyed — the same preview shape, captured immediately before the delete. */
  destroyed: DiscardPreview;
  /** The name of the agent this destroyed. See {@link ClosedAgents.agentName} — same reason, same
   *  defect: `destroyed` describes WHAT went, not WHO, so without this the receipt for a discard
   *  reads "Closed that agent." Declared rather than inferred (roborev 65334, Medium). */
  agentName?: string;
}

/**
 * PERMANENTLY destroy an agent's work: delete its branch and its bead and remove its worktree, for
 * the agent AND every child under it. Unmerged commits are gone; there is no undo.
 *
 * `intent` is REQUIRED and has no default. Every guard below refuses — nothing here falls THROUGH to
 * the delete, and there is no code path anywhere in this module that reaches `discardAgentGit`
 * except this function after a well-formed, agent-matched intent.
 */
export async function discardAgent(
  agentId: string,
  intent: DiscardIntent,
): Promise<LifecycleResult<DiscardOutcome>> {
  if (!isDiscardIntent(intent)) {
    return refuse(
      "discard_agent",
      "intent-required",
      `Discarding permanently deletes an unmerged branch, its task, and its worktree — for this agent and every worker under it. I need an explicit confirmation naming the agent (confirm: "${DISCARD_CONFIRM_TOKEN}") before I'll do that.`,
    );
  }
  if (intent.agentId !== agentId) {
    return refuse(
      "discard_agent",
      "intent-mismatch",
      `That confirmation is for a different agent (${intent.agentId}), not ${agentId}. I won't spend it here.`,
    );
  }
  const found = locate(agentId);
  if (!found) return refuse("discard_agent", "unknown-agent", unknownAgent(agentId));
  const { project } = found;
  const wrongKind = requireBuild("discard_agent", found.agent);
  if (wrongKind) return wrongKind;
  // Snapshot BEFORE anything is torn down: this is both the report to the human and the exact list
  // handed to the git/bead delete, so the two can never disagree.
  const destroyed = buildDiscardPreview(project, found.agent);
  const ids = destroyed.targets.map((t) => t.agentId);
  log.warn("concierge-lifecycle", "discarding an agent subtree — irreversible", {
    agentId,
    ids,
    branches: destroyed.branches,
    beadIds: destroyed.beadIds,
    anyUnmerged: destroyed.anyUnmerged,
  });
  const { close } = useRuntimeStore.getState();
  for (const id of ids) close(id);
  // Discard is the most explicit "destroy this" there is — every cloud sandbox under it goes too.
  await Promise.all(ids.map((id) => terminateIfCloud(project.agents.find((a) => a.id === id))));
  await discardAgentGit({
    root: project.rootPath,
    projectId: project.id,
    ids,
    beadIds: destroyed.beadIds,
  });
  // `discardAgentGit` was awaited above, so no pane survives to end a `close:` trace — see the note
  // in `tearDownKeepingBranches`; the store's mounted-pane gate is what keeps this from leaking.
  useProjectStore.getState().removeAgent(project.id, agentId);
  // `agentName` — see the note on `spinDownWorkerAgent`'s reply. `destroyed` describes what was
  // torn down, not who; without the name the receipt reads "Closed that agent."
  return ok("discard_agent", { destroyed, agentName: found.agent.name });
}

// ── Workers ─────────────────────────────────────────────────────────────────────────────────────

/** Spin a WORKER down: its tab and runtime entry go immediately, then its PTY and worktree are
 *  reaped; its branch is kept. Refuses anything that isn't a worker — `spinDownWorker` is a no-op
 *  for other kinds, and silently doing nothing would read as success.
 *
 *  ALSO refuses a worker whose worktree is DIRTY. "The branch is kept" makes this read like a
 *  lossless operation, and for committed work it is — but the teardown removes the checkout with
 *  `--force`, so anything uncommitted (including files the worker never staged) is destroyed with
 *  no salvage ref and no undo. The caller is an orchestrator that cannot see the worktree, so it
 *  spins a worker down believing "branch kept" covers the work; it does not.
 *
 *  THE READING IS TAKEN LIVE, AT THE MOMENT OF THE DECISION — see `readRetirementFacts`. It used
 *  to come from the cached `runtimeStore.branchStatus` with unknown collapsed into dirty, and that
 *  collapse is what bead sparkle-plxhx is about: a permanently-stale cache entry made the refusal
 *  permanent, and phrasing it as "there are uncommitted changes" made it a false one. Unknown is now
 *  its own answer with its own refusal and its own non-destructive override; only a POSITIVE dirty
 *  reading raises `uncommitted-work`, and that guard is unchanged.
 *
 *  TWO escape hatches, because there are two different things to escape (bead sparkle-plxhx):
 *   • `discardUncommitted` — "I know there are real files here and I accept losing them." The only
 *     thing that overrides a POSITIVE dirty reading. Shaped like the other destructive confirmations
 *     in this module: optional, so the REFUSAL naming what would be lost is what an omitted flag
 *     produces, never a silent teardown.
 *   • `allowUnknownStatus` — "I looked at the tree myself; retire it." Overrides only the UNKNOWN
 *     case, and is NOT a discard: it cannot tear down a tree we positively read as dirty. It exists
 *     because the unknown case used to be inescapable, which turned a fail-safe default into a
 *     permanent deadlock whose only workaround was `discard_agent` — an operation that deletes
 *     branches and worktrees outright and is far more dangerous than the loss being guarded against.
 *
 *  ── AND THE BRANCH, WHICH THIS USED TO NEVER ASK ABOUT (bead sparkle-3duunc) ────────────────────
 *  The two guards above are both about the same axis — files in the tree — and a worker whose tree
 *  is spotless sailed past both. That is the measured loss: a finished worker's branch held EIGHT
 *  commits that were on neither origin/main nor any remote ref, with no PR, and the teardown took
 *  its row with nothing anywhere flagging that the work was held by that row alone. "The branch is
 *  kept" is TRUE and is not the same as "the work is safe": the ROW is what a human and an
 *  orchestrator navigate by, and a branch nobody is pointing at is work nobody will finish.
 *
 *  So a third rung asks the ancestry question, and it REUSES the retirement assessment rather than
 *  re-deriving it — `readRetirementFacts` → `engine/workflowStage.unlandedWorkEvidence`, the same
 *  path `mayRetire` reads, raising the same `unlanded-work` / `unlanded-unknown` reasons. A rule
 *  expressed twice is how two surfaces come to disagree about the same agent at the same moment.
 *
 *  It fires ONLY when nothing else is holding the commits — see `commitsHeldElsewhere`. A pushed
 *  branch, or one already merged into the orchestrator's, tears down exactly as before.
 *
 *   • `allowUnlandedWork` — the third escape hatch, for the third axis: "I know these commits are
 *     only on this branch, and I want the slot back anyway." Deliberately NOT `discardUncommitted`:
 *     that flag says something about UNCOMMITTED FILES, and spending it here would let a caller who
 *     accepted losing a scratch edit also drop a row over eight committed ones it never heard about.
 *     `allowUnknownStatus` clears the UNKNOWN arm only, matching what it already means for the tree
 *     ("I went and looked myself") — it cannot clear a positive unlanded reading.
 */
export async function spinDownWorkerAgent(
  workerId: string,
  opts: {
    discardUncommitted?: boolean;
    allowUnknownStatus?: boolean;
    allowUnlandedWork?: boolean;
  } = {},
): Promise<LifecycleResult<ClosedAgents>> {
  const found = locate(workerId);
  if (!found) return refuse("spin_down_worker", "unknown-agent", unknownAgent(workerId));
  if (found.agent.kind !== "worker") {
    return refuse(
      "spin_down_worker",
      "not-a-worker",
      `“${found.agent.name}” is a ${found.agent.kind} agent, not a worker — closing it is a different operation with different consequences.`,
    );
  }
  // ONE read for BOTH axes. `readRetirementFacts` takes the same live `agentBranchStatus` reading
  // this path always took — same fallback ladder, same gone-worktree arm — and adds the workflow
  // reading the branch rung needs, so the tree guards below are unchanged in behaviour.
  // ── THE PARENT BRANCH, WITH THE MINTED FALLBACK EVERY OTHER CONSUMER ALREADY USES ────────────
  // `parentBranch` is stamped at spawn time and is genuinely ABSENT for a real population: the
  // disk-reconcile self-heal that re-creates worker rows after a restart (`adoptWorker`) passes
  // none. Rust's `resolve_parent_branch` returns early on an empty string, so `inParent` would be a
  // permanent `false` for exactly those rows — and the ordinary, safe shape (merged up into the
  // orchestrator, not yet pushed) would then refuse forever. `sparkle/agent-<parentId>` is the
  // branch name this app guarantees, so the fallback is a real answer rather than a guess.
  const parentBranch = found.agent.parentId
    ? found.agent.parentBranch || agentBranchName(found.agent.parentId)
    : (found.agent.parentBranch ?? "");
  const facts = await readRetirementFacts(found.project, workerId, parentBranch);
  const risk = facts.worktreeRisk;
  if (risk === "dirty" && !opts.discardUncommitted) {
    return refuse(
      "spin_down_worker",
      "uncommitted-work",
      `“${found.agent.name}” has uncommitted changes in its worktree. Spinning it down keeps the branch but deletes the checkout, so those changes would be gone for good. Ask the worker to commit first, then spin it down.`,
    );
  }
  // NOT folded into the branch above, and NOT phrased as a claim about uncommitted files. Saying
  // "it has uncommitted changes" about a tree we could not read is the false statement this bead
  // was filed over. `discardUncommitted` also clears this — a caller willing to lose real files is
  // certainly willing to proceed past an unreadable tree.
  if (risk === "unknown" && !opts.allowUnknownStatus && !opts.discardUncommitted) {
    return refuse(
      "spin_down_worker",
      "status-unknown",
      `I couldn't read “${found.agent.name}”'s worktree, so I can't tell whether it holds uncommitted ` +
        `changes — this is NOT a report that it does. Spinning it down keeps the branch but deletes the ` +
        `checkout, so I've stopped rather than guess. If you've checked the tree yourself (a clean ` +
        `\`git status\` in it, or the directory is already gone), retry with allowUnknownStatus and I'll ` +
        `retire it — that still refuses if the tree turns out to hold real uncommitted files.`,
    );
  }
  // ── THE BRANCH (bead sparkle-3duunc) ───────────────────────────────────────────────────────────
  // Only reached once the tree is settled, mirroring `mayRetire`'s order: files first, because that
  // is the rung where unrecoverable data is at stake, then the ancestry question.
  if (!commitsHeldElsewhere(facts.ws)) {
    const branch = found.agent.branch ?? `sparkle/agent-${workerId}`;
    // The count comes from the SAME reading the verdict did. It may be absent (an unreadable tree
    // leaves no `BranchStatus` while the stage watermark can still say work exists), and "commits"
    // is the honest word for that — never a guessed number on a sentence about losing work.
    const n = facts.bs?.ahead;
    const commits = n !== undefined && n > 0 ? `${n} commit${n === 1 ? "" : "s"}` : "commits";
    // EVERY REMEDY NAMED HERE IS SAFE UNDER THE CONDITION THAT TRIGGERED THE REFUSAL — the founder's
    // sparkle-8bvh rule. Each of the three either moves the commits somewhere else first or is the
    // caller deliberately spending the override; none of them is "spin it down another way", and
    // `discard_agent` is not offered at all (it DELETES the branch, which is strictly worse than
    // the loss being guarded against).
    const waysOut =
      `Have it merged into ${parentBranch || "your branch"}, or push the branch ` +
      `(\`git push -u origin ${branch}\`) so the work exists somewhere other than this worktree — ` +
      `either one clears this. If you already have the commits and just want the slot back, retry ` +
      `with allowUnlandedWork.`;
    if (facts.unlanded === true && !opts.allowUnlandedWork) {
      return refuse(
        "spin_down_worker",
        "unlanded-work",
        `“${found.agent.name}” has ${commits} on ${branch} that never reached main, and nothing ` +
          `else is holding them — no remote ref, and not merged into its orchestrator. Spinning it ` +
          `down keeps the branch but takes its row, so nobody would be left finishing that work. ` +
          waysOut,
      );
    }
    // FAIL CLOSED. An unreadable repo cannot authorize a teardown — and this is NOT a claim that
    // unlanded work exists, the same honesty split `status-unknown` draws for the tree.
    if (facts.unlanded === undefined && !opts.allowUnlandedWork && !opts.allowUnknownStatus) {
      return refuse(
        "spin_down_worker",
        "unlanded-unknown",
        `I couldn't establish whether “${found.agent.name}”'s committed work has landed, so I ` +
          `can't rule out that spinning it down strands something — this is NOT a report that it ` +
          `does. I've stopped rather than guess. ` +
          waysOut,
      );
    }
  }
  await spinDownWorker({ projectId: found.project.id, workerId });
  return ok("spin_down_worker", {
    agentIds: [workerId],
    projectId: found.project.id,
    outcome: "spin-down",
    // ── THE NAME, BECAUSE BY THE TIME THE RECEIPT RENDERS THERE IS NOWHERE ELSE TO GET IT ────────
    // The founder's 2026-08-18 complaint about "Retired that agent." was one instance of a defect
    // this whole family shares. `conciergeReceiptClassifier` takes a receipt's subject from the CALL
    // ARGS, and every close-family op is argued by id alone; the renderer then tries the live roster
    // to turn that id into a name — and necessarily misses, because the op it is reporting has just
    // removed the row. So the line degrades to the anonymous fallback and reads "Closed that agent."
    //
    // This function is the LAST place the name exists. It is spread into `close_agent` and
    // `retire_agent` as well, so one field here fixes the sentence for all three.
    agentName: found.agent.name,
  });
}

// ── Restart / Stop — the two ops that act on a PROCESS, not on records ───────────────────────────
//
// WHY THESE RESOLVE DIFFERENTLY FROM EVERYTHING ELSE IN THIS FILE (bead sparkle-x0pvw). The founder
// asked for the concierge to be able to restart and stop the app's own Improve Sparkle agent — the
// motivating case being a pane wedged on a Claude CLI login screen that ignores Escape, where a
// restart is the only real remedy. Every other op here goes through `locate`, and `locate` cannot
// find that agent by construction. These two go through `findKnownAgent`.
//
// THEY DELIBERATELY DO NOT WIDEN WHAT CAN BE DESTROYED. A restart re-spawns a PTY and a stop kills
// one; neither touches a tab, a worktree, a branch, a bead, or — for Improve Sparkle — one byte of
// scheduler state. The destructive ops keep their `locate`-only resolution, which is what keeps
// `discard_agent` unable to delete the app-owned clone the hourly pass works in.

/** What a restart or a stop acted on. `agentId` echoes the target so a caller batching several can
 *  tell the replies apart. */
export interface ProcessActed {
  agentId: string;
  outcome: "restart" | "stop";
}

/** The shared preamble for both ops: resolve the agent, and refuse if acting now would collide with
 *  the app-owned agent's hourly pass.
 *
 *  THE BUSY CHECK APPLIES TO RESTART AND STOP EXACTLY AS IT APPLIES TO A SEND, and that is a
 *  deliberate reading of the founder's constraint rather than an omission. He asked for full access
 *  "but I don't want you to break anything the agent is currently doing" — and a restart mid-pass is
 *  strictly MORE disruptive than a send mid-pass: it kills the `claude` that is writing the shared
 *  worktree and leaves whatever it had uncommitted behind for the next pass to clean up. There is no
 *  force flag: a genuinely wedged pass already clears itself (a 30-minute client watchdog with a
 *  35-minute Rust reclaim behind it), so the escape hatch would only ever be used to do the damage. */
function resolveForProcessOp(
  op: "restart_agent" | "stop_agent" | "resume_worker",
  agentId: string,
): LifecycleRefused | null {
  if (findKnownAgent(agentId) === undefined) {
    return refuse(op, "unknown-agent", unknownAgent(agentId));
  }
  if (isSparkleAgentId(agentId)) {
    const busy = sparkleBusyNow(Date.now());
    if (busy) return refuse(op, "agent-busy", busy.detail);
  }
  return null;
}

/**
 * Re-spawn an agent's terminal in place.
 *
 * The conversation SURVIVES: the spawn path resumes the agent's Claude session (`--resume <id>`),
 * which is why services/paneControl calls restarting "safe by construction". This is the remedy for
 * a pane stuck on a screen its CLI will not leave — the login prompt that ignores Escape being the
 * case that prompted it.
 *
 * `no-pane` is reported when no pane is mounted, rather than `action-failed`: a closed agent picks
 * up a fresh spawn the next time it opens, so there is nothing wrong, nothing to retry, and nothing
 * that happened.
 *
 * THE ACK WAITS FOR THE RESTART, and that is the whole point of `restartPaneAwaited`. This used to
 * call `restartPane`, whose boolean is a DISPATCH receipt — the pane's lever is async and swallows
 * its own failures, so `ok` was written before anything had run and regardless of whether it then
 * worked. Measured on v0.107.0: three errored agents restarted, three `{ok:true, outcome:"restart"}`
 * replies, and an immediate `get_agent_status` on each still reading `errored` with needsYou true.
 * That is the false-success shape that has the concierge report agents as recovered while they are
 * still down, so every non-`restarted` outcome is now a refusal the caller can read and relay.
 */
export async function restartAgent(agentId: string): Promise<LifecycleResult<ProcessActed>> {
  return restartTerminal("restart_agent", agentId);
}

/**
 * The restart, with the OP NAME as a parameter — the one implementation both `restart_agent` and
 * `resume_worker` run.
 *
 * PARAMETERISED RATHER THAN COPIED, deliberately. Every branch below is a refusal that tells the
 * caller not to report the agent as recovered, and each was written after a measured false success
 * (see `restartAgent`'s header for the v0.107.0 measurement). A second copy of five such branches is
 * the drift class this repo keeps paying for: the copy would go stale silently, and the failure it
 * produces is the exact one these sentences exist to prevent — an agent reported healthy while it is
 * still down. The op name is threaded through so each refusal names the op the CALLER asked for; a
 * reply stamped `restart_agent` to a caller that said `resume_worker` is a receipt for a call nobody
 * made.
 */
async function restartTerminal(
  op: "restart_agent" | "resume_worker",
  agentId: string,
): Promise<LifecycleResult<ProcessActed>> {
  const refusal = resolveForProcessOp(op, agentId);
  if (refusal) return refusal;
  const result = await restartPaneAwaited(agentId);
  if (result === "no-pane") {
    return refuse(
      op,
      "no-pane",
      `${agentId} has no terminal open right now, so there was nothing to restart. It will start fresh the next time it is opened.`,
    );
  }
  if (result === "no-claude") {
    return refuse(
      op,
      "action-failed",
      `${agentId}'s terminal could not be restarted: the \`claude\` CLI was not found. The agent is still down — this needs a human to fix the install.`,
    );
  }
  if (result === "nothing-to-restart") {
    // SAYS ONLY WHAT IS KNOWN, AND QUALIFIES THE REMEDY BY RUNTIME. Two earlier versions of this
    // copy each asserted one false universal: first that the runtime "rebuilds its config and keeps
    // the same process" (a cloud agent has no local process to keep), then that "closing and
    // reopening starts a fresh terminal" (reopening a cloud pane RE-ATTACHES to the same
    // server-side session — `AgentPane.prepare()`: "the session already exists there. The desktop's
    // job is to ATTACH, not to spawn"). A human follows this verbatim, so a remedy that is wrong for
    // half the population sends them to the same stuck screen. Remedy copy is code (AGENTS.md,
    // bead sparkle-8bvh) — and where the runtime is unknown, the honest move is to say so rather
    // than pick one.
    const runtime = findKnownAgent(agentId)?.runtime;
    const remedy =
      runtime === "cloud"
        ? "This agent runs server-side and the desktop only attaches to it, so reopening the tab re-attaches to the same session rather than starting a new one — nothing on this machine will restart it."
        : runtime === "local"
          ? "Restarting does not reach this kind of agent; closing and reopening it is what starts a fresh terminal."
          : "What would actually restart it depends on where it runs, and that could not be determined here.";
    return refuse(
      op,
      "action-failed",
      `${agentId}'s terminal was not re-spawned — nothing was replaced, so it is in exactly the state it was in before. ${remedy} Do not report it as recovered.`,
    );
  }
  if (result === "timed-out") {
    return refuse(
      op,
      "action-failed",
      `${agentId}'s terminal was told to restart but had not come up yet. It may still be starting — re-read its status before reporting it either way, and do not report it as recovered.`,
    );
  }
  if (result !== "restarted") {
    return refuse(
      op,
      "action-failed",
      `${agentId}'s terminal did not come back up (${result}). It is still down — do not report it as recovered.`,
    );
  }
  // NOTHING IS WRITTEN TO `runtimeStore.status` HERE, deliberately. An earlier cut of this cleared a
  // red status to `working` on success, which relocated the very bug this function exists to close:
  // the success verdict was the pane's PHASE, which only means the spawn command was assembled, so a
  // launch that then died at PTY spawn would have had its truthful `errored` overwritten with a
  // calm `working` — and `get_agent_status` derives `needsYou` from exactly that. The verdict is now
  // `paneReadiness` reaching `ready`, i.e. the PTY genuinely came up, and statusEngine's own
  // `spawn -> working` transition repaints the status off the real spawn. Letting the engine own it
  // means a restart that comes up and immediately re-errors still reads red.
  log.info("concierge", "restarted an agent's terminal", { agentId });
  return ok(op, { agentId, outcome: "restart" });
}

/**
 * Bring an orchestrator's OWN worker back after its process is gone (bead `sparkle-abl8ug`).
 *
 * WHY THIS IS A SEPARATE OP AND NOT A LOOSENING OF `restart_agent`. `concierge_tool` is
 * concierge-only, so a build agent whose worker exited mid-task had no way to resume it — the
 * measured cost was three starved workers salvaged by hand, and the refusal an orchestrator got told
 * it to "ask the human", which is exactly the unattended deadlock the fleet cannot afford overnight.
 * The remedy is not to admit an agent to `restart_agent`: that op is `disruptive` because it can kill
 * a `claude` mid-turn, and admitting an unattended caller to it would hand every orchestrator a way
 * to cut off a worker's live turn. This op is the same act with the dangerous population REMOVED,
 * which is the `retire_agent`-vs-`close_agent` precedent one more time: strictly more restrictive
 * than the op it delegates to, so nothing is escapable by choosing it.
 *
 * THREE GATES, and each removes one thing the `disruptive` tier was protecting:
 *
 *   1. WORKER ONLY. A build agent is the human's own row and a shell is nobody's worker; neither is
 *      an orchestrator's to re-spawn. `not-a-worker` says so.
 *   2. NOT PRODUCING OUTPUT. `liveActivityOf` reads the live status map, and its RED tier
 *      (`questions` / `waiting` / `approval`) counts as working — a worker holding a question open is
 *      mid-exchange with somebody, and re-spawning it discards that. This is the gate that makes the
 *      `routine` classification true rather than asserted: with it, the op cannot stop work in flight.
 *   3. ACTIVITY MUST BE READABLE. `unknown` REFUSES rather than proceeding, for the reason
 *      `liveActivityOf`'s own header gives: `runtimeStore.status` is written only by a mounted pane,
 *      so an unread map is not evidence of quiet. Fail-closed here costs an orchestrator one refusal
 *      it can act on; failing open costs a worker its turn. In practice the populations line up —
 *      `restartPaneAwaited` needs a mounted pane too, and a mounted pane is what writes the status.
 *
 * OWNERSHIP IS NOT CHECKED HERE, and that is deliberate rather than missing: this module has no
 * caller identity to check it against. The subtree test lives at the one layer that does have one —
 * `mayWriteAgentFieldFor` in services/controlListener, the same walk `rename_agent` applies — and the
 * concierge reaches this op with its own authority, as it does every other lifecycle op.
 */
export async function resumeWorker(agentId: string): Promise<LifecycleResult<ProcessActed>> {
  const agent = findKnownAgent(agentId);
  if (agent === undefined) {
    return refuse("resume_worker", "unknown-agent", unknownAgent(agentId));
  }
  // READ THROUGH `tab`, and treat its ABSENCE as a refusal rather than as an unknown to work around.
  // `findKnownAgent` resolves three arms and only the roster arm carries a row: the app-owned Improve
  // Sparkle agent and an `observed`-only id both come back with no `tab` at all. Neither is anybody's
  // worker — the first is the app's own, and the second is an id with no record saying what it is —
  // so both belong on the refusing side of this gate, which is what reading `tab?.kind` gives.
  const kind = agent.tab?.kind;
  if (kind !== "worker") {
    return refuse(
      "resume_worker",
      "not-a-worker",
      kind === undefined
        ? `${agentId} has no roster row saying what it is, so it cannot be established as your worker and was left alone. This op only brings back a worker in your own subtree.`
        : `${agentId} is a ${kind} agent, not a worker, so it is not yours to resume. This op only brings back a worker in your own subtree; anything else is the human's or the concierge's call.`,
    );
  }
  const activity = liveActivityOf(agentId);
  if (activity === "working") {
    return refuse(
      "resume_worker",
      "agent-busy",
      `${agentId} is still mid-exchange — producing output, or holding a question or approval open. Resuming it would re-spawn its terminal and cut that turn off, so nothing was done. Read its terminal before deciding it is stuck.`,
    );
  }
  if (activity === "unknown") {
    return refuse(
      "resume_worker",
      "activity-unknown",
      `Whether ${agentId} is still working could not be read, so it was left alone — an unread status is not evidence that it is quiet. Open its pane (that is what writes the reading) and try again.`,
    );
  }
  return restartTerminal("resume_worker", agentId);
}

/**
 * Kill an agent's terminal, and nothing else.
 *
 * NARROW BY DESIGN. The tab, the worktree, the branch and (for Improve Sparkle) the hourly scheduler
 * are all untouched — `restart_agent` brings the process straight back. It is emphatically NOT a
 * cancel for the headless improvement pass: that pass runs as its own child with its own watchdog,
 * and killing it mid-write is the thing this whole change was conditioned on not doing. A pass in
 * flight refuses this op, same as a send.
 */
export async function stopAgent(agentId: string): Promise<LifecycleResult<ProcessActed>> {
  const refusal = resolveForProcessOp("stop_agent", agentId);
  if (refusal) return refusal;
  try {
    await killPty(agentId, "concierge-stop-agent");
  } catch (e) {
    // `killPty` does NOT swallow the "no such pty" teardown race the way the other PTY ops do, so a
    // stop aimed at an agent whose terminal has already gone lands here. Reported honestly rather
    // than as a success: the caller asked for a state change and none was made.
    return refuse("stop_agent", "action-failed", `Could not stop ${agentId}: ${errText(e)}`);
  }
  log.info("concierge", "stopped an agent's terminal", { agentId });
  return ok("stop_agent", { agentId, outcome: "stop" });
}

// ── Small shared bits ───────────────────────────────────────────────────────────────────────────

function unknownAgent(agentId: string): string {
  return `I can't find an agent with id ${agentId} in any open project — it may already be closed.`;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
