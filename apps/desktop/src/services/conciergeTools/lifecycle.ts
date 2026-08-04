// The concierge's AGENT LIFECYCLE tool domain: create a build agent, look at what closing one would
// do, and carry out the close — Ship, Save, or (only ever on an explicit human intent) Discard.
//
// This module is a THIN WRAPPER over the paths the human's own clicks take. It owns no worktree, PTY,
// git or bead logic of its own; every side-effect is delegated:
//   • spawn      → services/buildAgentSpawn.spawnBuildAgentInProject (the "+ New Build Agent" body)
//   • the policy → engine/closeAgent.shouldPromptOnClose (the ONE rule for "does closing need a
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
import { useRuntimeStore } from "../../stores/runtimeStore";
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
import { shouldPromptOnClose } from "../../engine/closeAgent";
import { resolveStage, stageIndex, type WorkflowStageId } from "../../engine/workflowStage";
import { spawnBuildAgentInProject } from "../buildAgentSpawn";
import { awaitBriefDelivery } from "../agentBrief";
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
import { spinDownWorker } from "../workerSpawn";
import { terminateIfCloud } from "../cloudAgents/terminate";
import { log } from "../../logger";
import type { AgentKind, AgentTab, Project, Runtime } from "../../types";

// ── Operations + their risk ─────────────────────────────────────────────────────────────────────

/** Every lifecycle operation the concierge can name. The runtime list is the source of truth for
 *  the union below, so a new op is classified in `LIFECYCLE_RISK` or the build fails. */
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
  | "cloud-no-repo" //          the project has no GitHub remote for the sandbox to clone
  | "needs-decision" //         closing would put work at risk: the human picks ship/save/discard
  | "uncommitted-work" //       a worker spin-down would delete a dirty worktree; the branch is kept
  //                            but uncommitted files are NOT, so this is refused until they are
  //                            committed (or the caller passes an explicit discard confirmation)
  | "intent-required" //        discard was called without a well-formed DiscardIntent
  | "intent-mismatch" //        the intent names a different agent than the one targeted
  | "unknown-model" //          a spawn named a model this app does not offer (never downgraded)
  | "project-torn-out" //      ANY spawn into a project owned by a satellite (neither window mounts it)
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
   *  • "unconfirmed"   — no launch and no failure within the wait. The brief may yet go out, so this
   *                      is explicitly not "failed" — but it is not success either, and nothing may
   *                      upgrade it to one.
   */
  briefDelivery: "submitted" | "no-brief" | "launch-failed" | "agent-closed" | "unconfirmed";
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
  });
  if (!agentId) {
    return refuse(
      "spawn_build_agent",
      "action-failed",
      "The project closed while I was starting the agent, so nothing was created.",
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
  // THE REMEDY MUST BE AN ACTION THAT ACTUALLY WORKS under the conditions that triggered it — this
  // repo treats a wrong remedy string as a bug, not phrasing.
  //
  // `launch-failed` means the agent's TERMINAL never started (spawn error, or no claude on PATH), so
  // it is NOT "running with no objective" — an earlier draft said that, and it described the wrong
  // state entirely. The row exists and its brief is still attached, so "Start again" is the correct
  // action: `noteBriefFailed` deliberately RETAINS the brief precisely so a retry re-emits it.
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
  // THE ROW BEING GONE OUTRANKS THE DELIVERY OUTCOME, and this ordering is load-bearing.
  //
  // Making `agentExists` observed created a combination the copy never anticipated: `unconfirmed`
  // TOGETHER WITH `agentExists: false` — which is not a corner but the whole reason the flag is
  // observed (a row destroyed by any path that doesn't settle the brief leaves the delivery reading
  // `unconfirmed`). Keyed on `delivery.state` alone, that reply told the human to "check that it
  // picked up the task" about an agent that no longer exists, beside `agentExists: false` and a
  // persona instruction to say it was closed. Same remedy-copy defect as the three before it,
  // relocated into the one sentence still left unconditional (roborev 55888).
  //
  // So: if the row is gone, say so — whatever the delivery outcome was. Only a SURVIVING row gets
  // the outcome-specific wording, because only then is there something to go and look at.
  const briefFailure = !agentExists
    ? "That agent is gone — it was closed before its opening brief went in, so nothing is running " +
      "and the brief went with it. Say the word and I'll start a fresh one with the same brief."
    : delivery.state === "launch-failed"
      ? // The row survives and `noteBriefFailed` retained the brief, so the retry really does send it.
        `I created the agent, but its terminal didn't start — ${delivery.reason} — so its opening ` +
        `brief hasn't gone in yet. Its brief is still attached, so "Start again" on that agent will ` +
        `send it; nothing needs re-typing.`
      : delivery.state === "unconfirmed"
        ? // The row is still THERE (checked above), so "go look at it" is an action they can take.
          "I created the agent, but I couldn't confirm its opening brief went in. Check that it " +
          "picked up the task before relying on it."
        : undefined;
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
 * The cloud gate, read from the two stores that hold its inputs — the SAME assembly `useCloudGate`
 * does for the dialog, minus React. It is not shared with that hook because the hook is a set of
 * `useStore` subscriptions; the DECISION it feeds (`evaluateCloudGate`) is shared, which is the half
 * that must not have two copies.
 *
 * `cloudAuthStore` is deliberately NOT persisted (a stale "auth configured" would wave a start
 * through into a guaranteed 400), so a cold store reads `method: null` — which the gate correctly
 * calls "no auth". For a HUMAN that is fine: the dialog probes on open, and the person is looking at
 * the result. A tool call has no such moment, so it probes here, once, before deciding. Without this
 * the first cloud spawn of every launch would be refused with "add your Claude authentication" for
 * an account that has it.
 */
async function readCloudGate() {
  const cloudAuth = useCloudAuthStore.getState();
  if (!cloudAuth.loaded) await cloudAuth.refresh(); // never throws; sets `error` and leaves method
  const auth = useAuthStore.getState();
  return evaluateCloudGate({
    featureEnabled: auth.me?.cloudAgentsEnabled === true,
    signedIn: auth.tokenPresent,
    entitled: auth.me?.entitled === true,
    // Re-read AFTER the await: the refresh above is the whole point of asking.
    authConfigured: useCloudAuthStore.getState().method != null,
    balanceCents: auth.me?.balanceCents ?? 0,
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
  /** engine/closeAgent.shouldPromptOnClose — the ONE policy. True ⇒ closing needs a decision. */
  wouldPrompt: boolean;
  /** The complement of `wouldPrompt`, named for the thing the human asked about. */
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
  // The SAME call the sidebar × makes (AgentSidebar.requestClose). Never re-derived here.
  const wouldPrompt = shouldPromptOnClose(agent.kind, stage, bs);
  const statusUnknown = !bs || bs.worktreeOnBranch === false;
  const commitsAhead = bs?.ahead ?? 0;
  // A parked worktree still physically holds whatever was uncommitted when it was moved, so an
  // unknown reading counts as "there may be uncommitted work" — the safety side of the same call
  // shouldPromptOnClose makes.
  const uncommittedChanges = bs ? bs.dirty || bs.worktreeOnBranch === false : false;
  const unmergedCommittedWork = commitsAhead > 0 && isUnmerged(stage);
  const { recommended, reason } = recommend({
    wouldPrompt,
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
    silentClose: !wouldPrompt,
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
  statusUnknown: boolean;
  uncommittedChanges: boolean;
  commitsAhead: number;
  stage: WorkflowStageId;
  kind: AgentKind;
}): { recommended: CloseRecommendation; reason: string } {
  if (!i.wouldPrompt) {
    return {
      recommended: "close",
      reason:
        i.kind === "build"
          ? "Nothing is at risk — this agent's work has either landed on main or it never made any. Closing is safe and silent."
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
  outcome: "close" | "ship" | "save" | "spin-down";
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
export async function closeAgent(agentId: string): Promise<LifecycleResult<ClosedAgents>> {
  const found = locate(agentId);
  if (!found) return refuse("close_agent", "unknown-agent", unknownAgent(agentId));
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
  await closeBuildAgent(agentId);
  return ok("close_agent", { agentIds: ids, projectId: found.project.id, outcome: "close" });
}

// ── Ship ────────────────────────────────────────────────────────────────────────────────────────

/** What a ship did, alongside what was torn down. `ship` is the outcome reported by
 *  closeAgentActions.shipAgent — the concierge must read it rather than assume a PR exists. */
export interface ShippedAgents extends ClosedAgents {
  outcome: "ship";
  ship: ShipOutcome;
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
  await closeBuildAgent(agentId);
  return ok("ship_agent", { agentIds: ids, projectId: project.id, outcome: "ship", ship: outcome });
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
  useProjectStore.getState().removeAgent(project.id, agentId);
  return ok("discard_agent", { destroyed });
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
 *  spins a worker down believing "branch kept" covers the work; it does not. The dirty reading is
 *  the SAME one the close flow already trusts (`runtimeStore.branchStatus`), and unknown counts as
 *  dirty for the same reason `shouldPromptOnClose` treats it that way: an unpolled or parked
 *  worktree cannot be ruled out, and the cost of being wrong is unrecoverable.
 *
 *  `discardUncommitted` is the explicit escape hatch, and it is deliberately shaped like the other
 *  destructive confirmations in this module: optional, so the REFUSAL (with its sentence naming what
 *  would be lost) is what an omitted flag produces, never a silent teardown. */
export async function spinDownWorkerAgent(
  workerId: string,
  opts: { discardUncommitted?: boolean } = {},
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
  if (!opts.discardUncommitted && workerHasUncommittedWork(workerId)) {
    return refuse(
      "spin_down_worker",
      "uncommitted-work",
      `“${found.agent.name}” has uncommitted changes in its worktree. Spinning it down keeps the branch but deletes the checkout, so those changes would be gone for good. Ask the worker to commit first, then spin it down.`,
    );
  }
  await spinDownWorker({ projectId: found.project.id, workerId });
  return ok("spin_down_worker", {
    agentIds: [workerId],
    projectId: found.project.id,
    outcome: "spin-down",
  });
}

/** Does this worker's worktree hold changes that a spin-down would destroy?
 *
 *  Reads the same live `branchStatus` the close flow reads, and answers with the same safety bias as
 *  `previewClose.uncommittedChanges` — but the DEFAULT is inverted, because the consequence is. No
 *  reading yet (`undefined`) means the poll hasn't landed, and a worktree parked on another branch
 *  still physically holds whatever was uncommitted when it was moved; in both cases we cannot rule
 *  out work at risk, and here the fallback for "cannot rule out" is deletion. So both count as
 *  dirty. `ahead` is NOT consulted: committed work survives on the branch, which the teardown keeps. */
function workerHasUncommittedWork(workerId: string): boolean {
  const bs = useRuntimeStore.getState().branchStatus[workerId];
  if (!bs) return true;
  return bs.dirty || bs.worktreeOnBranch === false;
}

// ── Small shared bits ───────────────────────────────────────────────────────────────────────────

function unknownAgent(agentId: string): string {
  return `I can't find an agent with id ${agentId} in any open project — it may already be closed.`;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
