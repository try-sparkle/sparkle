// GIT / WORKFLOW tool domain for the concierge — the surface through which the concierge drives an
// agent's branch through its lifecycle (catch up → land / push → PR → merge → delete) on the human's
// behalf.
//
// THIS MODULE WRAPS; IT DOES NOT IMPLEMENT. Every git action here delegates to the SAME service
// function the UI buttons call (services/branchStatus.ts, services/openPrs.ts), which in turn calls
// the Rust command. Nothing here shells out, and nothing here re-derives git behaviour — a second
// implementation of "land" would drift from the one the buttons use, and the drift would only be
// visible after it had already merged something wrong.
//
// THREE RULES THIS MODULE ENCODES (from AGENTS.md, learned the hard way):
//   1. A PR IS THE GATE. Nothing here pushes to the default branch. `open_agent_pr` targets the land
//      target; `merge_pr` is how work reaches main on a repo with a remote. `land_agent_branch` is
//      the LOCAL, remoteless fallback the close-agent flow already uses — it is classified
//      `mutates-main` precisely because it bypasses review, so the policy layer must confirm it.
//   2. MERGE COMMITS ONLY. `merge_pr` has no strategy parameter and refuses at runtime if a caller
//      sends one anyway. A squash rewrites the branch's commits, so its tip stops being an ancestor
//      of main and Sparkle can no longer prove by ancestry that the work landed; `--auto` is not a
//      guard on this repo (auto-merge is disabled, so `gh pr merge --auto` merges IMMEDIATELY with
//      required checks still pending). Both are unreachable from here, by type AND at runtime — the
//      caller is an LLM sending unstructured JSON, so the type alone is not a gate.
//   3. "LANDED" ≠ "SHIPPED". `agent_landed_check` answers only "did this work reach its integration
//      branch" — the default branch, or a worker's orchestrator branch, each named in the verdict —
//      by ANCESTRY (Rust's `merge-base --is-ancestor`, surfaced as WorkflowState's
//      inLocalMain/inOriginMain/inParent/landed) — never by watching CI. It deliberately does not read or
//      report WorkflowState's `shipped` flag: whether a commit is in a released DMG is a different
//      question with a different check (ancestry against the release TAG), and for tags up to
//      v0.45.1 it is unanswerable at all. Conflating the two has already produced a false "it
//      shipped" report in this repo.
//
// EVERY FUNCTION RETURNS A TYPED RESULT AND NEVER THROWS. The caller is a model that has to act on
// the difference between "I declined to do this" and "I tried and the world said no" — see
// `WorkflowRefusal.kind` — and between "the agent is still working" and "your GitHub auth expired"
// — see `WorkflowFailureCode`. This mirrors the typed-refusal precedent in
// services/conciergeDispatch.ts (ConciergeDispatchPath).
//
// THE BUSY GATE READS THE LIVE STORE, NOT THE CALLER. `refreshAgentBranch`/`landAgentBranch` take an
// `isBusy` flag from their caller; the UI computes it from `useRuntimeStore` at click time because a
// closed-over value goes stale. Here the caller is a model, and "is this agent still working" must
// never be its word to give — so this module reads the store itself. That is the one guard the UI
// has that a rebase can never run under a live agent, and it is preserved here.
//
// OUTCOMES ARE OBSERVED, NEVER ASSERTED. "The underlying call resolved" is not evidence of what it
// did. `delete_agent_branch_if_merged` returns Ok whether it deleted the branch or KEPT it (an
// unlanded branch is kept by design), both deletes are idempotent for an already-absent branch, and
// `push_agent_branch` resolves an outcome STRING. Every one of those success paths used to be read
// as "done", which is precisely the class of false report this module exists to prevent — so each
// reports the outcome it was actually handed, and an outcome it does not recognize is "I cannot
// confirm", never a success.

import {
  refreshAgentBranch,
  landAgentBranch,
  pushAgentBranch,
  openAgentPr,
  deleteAgentBranch,
  deleteAgentBranchIfMerged,
  agentBranchStatus,
  agentWorkflowState,
  projectAgentsStatus,
  type AgentStatusInput,
  type AgentStatusResult,
  type BranchDeleteOutcome,
  type BranchStatus,
  type WorkflowState,
} from "../branchStatus";
import {
  fetchOpenPrs,
  fetchPrOwner,
  mergePr,
  prMergeEligibility,
  type PrRow,
} from "../openPrs";
import {
  fetchRoborevProbe,
  fetchRoborevReview,
  highestSeverity,
  parseRoborevFindings,
  roborevMergeGate,
  summarizeRoborev,
} from "../mergeGuard/roborev";
import { fetchPrClaims, findClaim, viewClaim } from "../mergeGuard/prClaims";
import { isKnightwatchRefusal, knightwatchReasonIssue } from "../mergeGuard/knightwatch";
import type {
  KnightwatchOverride,
  PrClaimView,
  RoborevBranchState,
  RoborevGateVerdict,
  RoborevJobFindings,
} from "../mergeGuard/types";
import { useRuntimeStore } from "../../stores/runtimeStore";
import { useProjectStore } from "../../stores/projectStore";
import { hasTurnEndAuthority, isTracked } from "../../engine/turnEndAuthority";
import type { AgentTabStatus } from "../../types";

// ---------------------------------------------------------------------------------------------
// Operations + risk classification
// ---------------------------------------------------------------------------------------------

/** Every operation this domain exposes. Tool-facing snake_case names (what the model sees). */
export type WorkflowOperation =
  // read-only
  | "agent_branch_status"
  | "agent_workflow_state"
  | "project_agents_status"
  | "project_open_prs"
  | "pr_owner"
  | "pr_checks_status"
  | "pr_roborev_status"
  | "agent_landed_check"
  // mutating
  | "refresh_agent_branch"
  | "land_agent_branch"
  | "push_agent_branch"
  | "open_agent_pr"
  | "merge_pr"
  | "delete_agent_branch"
  | "delete_agent_branch_if_merged";

/**
 * How dangerous an operation is, for the policy layer that decides what needs the human's word.
 *
 * - `read-only` — observes; changes nothing anywhere.
 * - `rewrites-branch` — rewrites the AGENT's own history (a rebase). Recoverable via reflog, but it
 *   can conflict and it moves commits the human has already seen.
 * - `outward-facing` — publishes to a place other people see (origin, GitHub). Not undoable by
 *   Sparkle: a force-push or a closed PR is a new outward action, not an undo.
 * - `mutates-main` — changes the branch everything else is measured against. This is the class that
 *   must never happen on a model's own initiative.
 * - `irreversible` — destroys local state; nothing here can put it back.
 */
export type WorkflowRiskClass =
  | "read-only"
  | "rewrites-branch"
  | "outward-facing"
  | "mutates-main"
  | "irreversible";

export interface WorkflowRiskProfile {
  risk: WorkflowRiskClass;
  /** One line the policy layer (or the model) can show the human when asking. */
  summary: string;
  /** True for everything that is not `read-only`. Derived, but stated per-operation so a future
   *  exception is a deliberate edit rather than an accident of a helper function. */
  requiresConfirmation: boolean;
  /** How (or whether) the human can get back to where they were. Null when they cannot. */
  undo: string | null;
}

/**
 * WHAT THE PR PROBE ACTUALLY COVERS, in the words the model is given.
 *
 * `fetchOpenPrs` is backed by `gh pr list --state open --author @me --limit 100`. Presenting that as
 * "the repo's open PRs" makes the concierge report "no PRs are waiting" for a repo full of other
 * people's PRs, and makes it call a perfectly open PR "merged or closed" the moment someone else
 * opened it. The scope is stated everywhere the list is surfaced or a lookup against it fails.
 */
const PR_SCOPE =
  "only the PRs authored by the signed-in `gh` identity (`--author @me`), first 100 by recency";

/**
 * HOW TO READ `agentId`, in the words the model is given.
 *
 * The concierge is required to attach the owning build agent to every PR it mentions rather than
 * cite a bare number. `agentId` is the DURABLE answer to that — recorded when the PR is opened, not
 * parsed out of the branch name — so it is right even for a PR on a descriptive branch like
 * `sparkle/left-pair`, which carries no id at all.
 *
 * The half that matters more is the null case. A pill pointing at the wrong agent opens the wrong
 * agent and the user cannot tell; "unresolved" costs them one question. So the instruction is
 * explicit that null means unknown and must never be filled in by inference.
 */
const PR_OWNERSHIP_NOTE =
  "`agentId` is the agent that opened the PR, from a durable recorded mapping — it is correct even when the branch name contains no agent id. A null `agentId` means UNKNOWN, not \"no agent\": say the owner is unresolved. Do NOT infer an owner from the branch name, the title, or which agent seems likely — a pill carrying the wrong id opens the wrong agent, which is worse than no pill.";

/**
 * THE risk map — an exhaustive `Record` over `WorkflowOperation`, which is the point: adding an
 * operation to the union without classifying it here is a TYPECHECK FAILURE, not a code review
 * question. A separate policy layer consumes this; the guarantee this module owes it is that the
 * classification exists and cannot be forgotten.
 */
export const WORKFLOW_RISK: Record<WorkflowOperation, WorkflowRiskProfile> = {
  agent_branch_status: {
    risk: "read-only",
    summary: "Read an agent branch's ahead/behind/dirty counts.",
    requiresConfirmation: false,
    undo: null,
  },
  agent_workflow_state: {
    risk: "read-only",
    summary: "Read an agent's land-to-green workflow signals (reachability, PR state).",
    requiresConfirmation: false,
    undo: null,
  },
  project_agents_status: {
    risk: "read-only",
    summary: "Read branch + workflow status for every agent in a project.",
    requiresConfirmation: false,
    undo: null,
  },
  project_open_prs: {
    risk: "read-only",
    summary: `List the open pull requests waiting in the project's repo — ${PR_SCOPE}.`,
    requiresConfirmation: false,
    undo: null,
  },
  pr_owner: {
    risk: "read-only",
    summary:
      "Name the agent that opened a PR, by number — the durable mapping, not a branch-name guess. Answers null when unknown.",
    requiresConfirmation: false,
    undo: null,
  },
  pr_checks_status: {
    risk: "read-only",
    summary: `Read a PR's CI rollup and mergeability, with its known blind spots stated. Finds the PR by scanning ${PR_SCOPE}.`,
    requiresConfirmation: false,
    undo: null,
  },
  pr_roborev_status: {
    risk: "read-only",
    summary:
      "Read the roborev review state for a PR's branch — whether a round is in flight, and the outstanding findings with their severity.",
    requiresConfirmation: false,
    undo: null,
  },
  agent_landed_check: {
    risk: "read-only",
    summary: "Answer, by ancestry, whether an agent's work reached the default branch.",
    requiresConfirmation: false,
    undo: null,
  },
  refresh_agent_branch: {
    risk: "rewrites-branch",
    summary: "Rebase the agent's branch onto a fresh base (catch up).",
    requiresConfirmation: true,
    undo: "Recoverable from the branch's reflog, but the commit ids change.",
  },
  land_agent_branch: {
    risk: "mutates-main",
    summary: "Merge the agent's branch LOCALLY into its integration target (no review gate).",
    requiresConfirmation: true,
    undo: "Only by resetting the target branch — treat as unlanding a merge, not an undo.",
  },
  push_agent_branch: {
    risk: "outward-facing",
    summary: "Push the agent's branch to origin, where other people can see it.",
    requiresConfirmation: true,
    undo: null,
  },
  open_agent_pr: {
    risk: "outward-facing",
    summary: "Open a GitHub pull request for the agent's branch.",
    requiresConfirmation: true,
    undo: "The PR can be closed, which is a new public action rather than an undo.",
  },
  merge_pr: {
    risk: "mutates-main",
    summary: "Merge an open pull request into the default branch with a MERGE COMMIT.",
    requiresConfirmation: true,
    undo: null,
  },
  delete_agent_branch: {
    risk: "irreversible",
    summary: "Delete an agent's local branch, merged or not — its unmerged work is gone.",
    requiresConfirmation: true,
    undo: null,
  },
  delete_agent_branch_if_merged: {
    risk: "irreversible",
    summary: "Delete an agent's local branch ONLY if git agrees it is fully merged.",
    requiresConfirmation: true,
    // Classified alongside its unguarded sibling on purpose. The merge check cannot lose landed
    // work, but it still destroys a ref, and a policy layer that has to reason about which delete is
    // the safe one will eventually get it backwards. Same class; the softer `undo` says why it is
    // the one to prefer.
    undo: "The work survives in the branch it was merged into; only the ref is gone.",
  },
};

/** The operation list, kept in step with the risk map by the tests (and by `satisfies`). */
export const WORKFLOW_OPERATIONS = [
  "agent_branch_status",
  "agent_workflow_state",
  "project_agents_status",
  "project_open_prs",
  "pr_owner",
  "pr_checks_status",
  "pr_roborev_status",
  "agent_landed_check",
  "refresh_agent_branch",
  "land_agent_branch",
  "push_agent_branch",
  "open_agent_pr",
  "merge_pr",
  "delete_agent_branch",
  "delete_agent_branch_if_merged",
] as const satisfies readonly WorkflowOperation[];

// Compile-time cover check in the OTHER direction: `satisfies` proves every entry in the array is a
// real operation; this proves every operation is in the array. Both, or the list silently omits one.
type _EveryOperationListed = Exclude<
  WorkflowOperation,
  (typeof WORKFLOW_OPERATIONS)[number]
> extends never
  ? true
  : never;
const _everyOperationListed: _EveryOperationListed = true;
void _everyOperationListed;

export function riskOf(op: WorkflowOperation): WorkflowRiskClass {
  return WORKFLOW_RISK[op].risk;
}

/** The whole domain, flattened for a tool-listing surface (the model's menu). */
export function describeWorkflowTools(): Array<{ op: WorkflowOperation } & WorkflowRiskProfile> {
  return WORKFLOW_OPERATIONS.map((op) => ({ op, ...WORKFLOW_RISK[op] }));
}

// ---------------------------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------------------------

/** Why an operation did not happen. The codes are deliberately narrow: a caller must be able to act
 *  on the difference between them without parsing `message`. */
export type WorkflowFailureCode =
  | "agent-working" // the agent has a live PTY — we will not rewrite/delete under it
  | "target-busy" // the branch we'd merge INTO belongs to a live agent
  | "no-target" // no base/integration branch to act against
  | "no-branch" // the agent's branch doesn't exist
  | "nothing-to-land" // the target already contains everything this branch has
  | "target-not-checked-out"
  | "dirty" // uncommitted changes block the operation
  | "conflict"
  | "merge-failed" // git errored for a non-conflict reason
  | "no-remote" // the repo has no origin
  | "not-pushed" // GitHub needs the branch on the remote first
  | "pr-exists"
  | "pr-not-found"
  | "checks-blocked" // red / pending checks, or a conflicting PR — never merge over these
  | "checks-unknown" // we could not READ the checks, so we will not merge blind
  // The four codes below are the #806 lesson. GitHub's check state is not this project's whole
  // definition of "clean", and a PR nobody appears to own may in fact be owned — see the header of
  // services/mergeGuard/types.ts.
  | "pr-claimed" // a live agent said it will land this itself
  | "roborev-pending" // a review round is IN FLIGHT — its verdict does not exist yet
  | "roborev-unresolved" // open FAIL-verdict reviews nobody has read or closed
  | "roborev-unknown" // roborev IS the gate here and we could not read it
  // The PR still carries a knightwatch [blocking] review probe nobody answered. A DISTINCT code
  // from the roborev ones on purpose: the remedy is not "read a finding and close it", it is
  // "answer the reviewer's question on the pull request". Measured before it was built — of the
  // last 40 merged PRs, 24 carried a blocking probe and all 24 merged with zero probe-citing reply.
  | "knightwatch-unanswered"
  // The PR's head moved between the gate reading it and the merge running, so GitHub declined the
  // merge (`--match-head-commit`). A DISTINCT code because it is the only merge outcome whose
  // remedy is "do the identical thing again": nothing merged, and a second `merge_pr` re-reads the
  // rows and re-gates against the NEW head. Uncoded it reads as a tool error, which is the one
  // thing it is not.
  | "head-moved"
  | "gh-unavailable" // the gh CLI is missing or unusable
  | "auth-failed" // credentials expired / rejected
  | "rejected-non-fast-forward"
  | "branch-checked-out" // git refuses to delete a branch a worktree holds
  | "not-merged" // the branch was KEPT because its work isn't on the integration branch
  | "probe-failed" // a best-effort read could not answer (NOT "the answer is empty")
  | "invalid-request" // the caller asked for something this domain forbids or can't parse
  | "unknown-error";

export interface WorkflowRefusal {
  ok: false;
  op: WorkflowOperation;
  risk: WorkflowRiskClass;
  /**
   * `refused` — we declined BEFORE touching the repo; nothing happened and retrying unchanged will
   * refuse again. `failed` — the operation ran and git/GitHub rejected it; the repo may or may not
   * have moved, and the remedy is usually outside Sparkle.
   */
  kind: "refused" | "failed";
  code: WorkflowFailureCode;
  /** Human-readable, and for `failed` it carries the underlying tool's own words verbatim. */
  message: string;
  /** Conflicted paths, when the underlying command reported them. */
  files?: string[];
}

export type WorkflowResult<T> =
  | { ok: true; op: WorkflowOperation; risk: WorkflowRiskClass; data: T }
  | WorkflowRefusal;

function ok<T>(op: WorkflowOperation, data: T): WorkflowResult<T> {
  return { ok: true, op, risk: riskOf(op), data };
}

function refused(
  op: WorkflowOperation,
  code: WorkflowFailureCode,
  message: string,
  files?: string[],
): WorkflowRefusal {
  return { ok: false, op, risk: riskOf(op), kind: "refused", code, message, ...(files ? { files } : {}) };
}

function failed(
  op: WorkflowOperation,
  code: WorkflowFailureCode,
  message: string,
  files?: string[],
): WorkflowRefusal {
  return { ok: false, op, risk: riskOf(op), kind: "failed", code, message, ...(files ? { files } : {}) };
}

/** Rust/gh errors arrive as strings as often as Errors; neither shape may be lost. */
function errText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

// ---------------------------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------------------------

/**
 * Everything an agent-scoped operation needs. Supplied by the integration layer from the stores —
 * NOT by the model — so an id it invents can't be dressed up with a root path of its choosing.
 */
export interface AgentWorkflowContext {
  /** The PROJECT root (the repo), not the agent's worktree. */
  root: string;
  projectId: string;
  agentId: string;
  kind: "build" | "worker" | (string & {});
  /** For a worker: the orchestrator whose branch it integrates into. */
  parentId?: string | null;
  /** The ref the agent was cut from. */
  baseBranch?: string | null;
  /** The project's integration branch. */
  defaultBranch?: string | null;
}

/** `sparkle/agent-<id>` — the branch naming this app guarantees. */
export function agentBranchName(agentId: string): string {
  return `sparkle/agent-${agentId}`;
}

/**
 * Where this agent's work integrates. Mirrors AgentSidebar's `onLand`: a worker lands into its
 * orchestrator's branch; anything else lands into the project's DEFAULT branch — the ref
 * reachability is measured against — falling back to its own base only when the default is unknown.
 * Pure, so the rule is tested without a store.
 */
export function resolveLandTarget(ctx: AgentWorkflowContext): string {
  if (ctx.kind === "worker" && ctx.parentId) return agentBranchName(ctx.parentId);
  return (ctx.defaultBranch || ctx.baseBranch || "").trim();
}

/**
 * EVERY STATUS THAT MEANS A LIVE PTY MID-TURN.
 *
 * `working` is not the whole of "live". An agent that is `waiting` (asked a question), at `approval`
 * (a dangerous action pending), or `blocked` (went quiet mid-turn) has a session open and a worktree
 * that may be half-written — which is exactly the condition this gate exists for. The UI's own gate
 * is narrower, and that is defensible there: a human clicking Land can SEE the agent sitting at a
 * prompt. A model cannot, so the gate here has to be the wider one.
 *
 * Deliberately NOT live: `idle`/`done`/`unmerged`/`stopped` (turn finished — a landing state is not
 * a busy one). Typed against AgentTabStatus so a new status is a decision someone makes here rather
 * than a silent "not live".
 *
 * `errored` is ALSO not in this set, but NOT because the process is gone — this comment used to say
 * exactly that, and it was wrong (roborev 55041/55076). The status engine's mid-stream failure branch
 * sets `errored` while the PTY is very much ALIVE: an API-error banner the agent kept churning under,
 * or a self-prompt loop. It is left out of the set because the witness check in `isWorking` below
 * covers it precisely — a wedged-but-alive agent has no turn-end witness and is refused, while a
 * genuinely exited one carries the `exited` witness and is allowed. Do not "simplify" that away by
 * reasoning from this list alone.
 *
 * `blocked` is still listed and is still correct to treat as live, but the STATUS ENGINE no longer
 * produces it: it used to mean "quiet for 25s", which was a guess dressed as a fact and doubled as a
 * red needs-you alarm. `hasTurnEndAuthority` below is what replaces it for this gate — see there.
 * (`services/improvementPass` still sets `blocked` for the Sparkle self-improve agent, so the entry
 * is live code, not a leftover.)
 */
const LIVE_AGENT_STATUSES = new Set<AgentTabStatus>(["working", "waiting", "approval", "blocked"]);

/** Live PTY-busy reading for an agent. Read at CALL time, never passed in — see the module header. */
function isWorking(agentId: string): boolean {
  try {
    const status = useRuntimeStore.getState().status[agentId];
    if (status !== undefined && LIVE_AGENT_STATUSES.has(status)) return true;
    // A settled status is only EVIDENCE of a finished turn when something actually witnessed the turn
    // ending — Claude's hook `Stop`, or the spinner disappearing. On the time-heuristic fallback path
    // (no hooks, no spinner: TUI drift, or a non-Claude program) there is no witness, and `idle` there
    // means "the terminal went quiet", which is equally consistent with a six-minute `pnpm test`.
    //
    // The two consumers of that ambiguity must resolve it in OPPOSITE directions, which is exactly why
    // it can't live in the status: an alarm must read a guess as "finished" (paging a human off a quiet
    // terminal is a false alarm), while this gate must read it as "still live" (landing/rebasing/
    // deleting a branch under a half-written worktree is unrecoverable, and refusing costs one retry).
    // So: an agent this window is driving, whose turn-end signal is a guess, counts as live here.
    //
    // Scoped to TRACKED agents deliberately. An untracked id — pane in another window, or not open —
    // tells this module nothing, and answering "live" for it would refuse every operation forever.
    // Scoped to the statuses that can actually BE a mid-turn guess. `done`/`stopped`/`unmerged` are
    // terminal OBSERVATIONS — the PTY is gone, and a dead process cannot be writing the worktree.
    // Applying the override to those refused every op forever on a fallback-path agent that had
    // exited, with no escape a user or model would ever deduce from the message (roborev 54815).
    //
    // `errored` is DELIBERATELY IN THE GUESS SET, though it looks terminal beside them (roborev
    // 55041). It has a second producer: statusEngine's mid-stream failure branch sets it when the
    // agent printed an API-error banner and kept churning, or fell into a self-prompt loop — "all
    // while its process stays alive" — and statusRouter lifts that screen reading over the hook
    // status. A wedged agent is still executing tools, so landing or deleting its branch is exactly
    // the unrecoverable write this module exists to prevent. A genuinely EXITED agent is unaffected:
    // StatusEngine.exit() grants the `exited` witness, so it passes `hasTurnEndAuthority` whatever
    // its status name. And this refusal is recoverable — stopping the agent kills the PTY, which
    // grants that witness, so the message's "wait for it to finish (or stop it)" is actionable.
    const couldBeAGuess = status === undefined || status === "idle" || status === "errored";
    if (couldBeAGuess && isTracked(agentId) && !hasTurnEndAuthority(agentId)) return true;
    return false;
  } catch {
    // A store that can't be read is not evidence the agent is idle, but refusing every operation on
    // a store hiccup is worse than the guard being unavailable; the underlying Rust commands have
    // their own dirty/lock checks. Fail open here and let those speak.
    return false;
  }
}

const WORKING_MSG = (what: string) =>
  `Refused: the agent's session is still live (working, waiting on you, at an approval prompt, or blocked mid-turn). ${what} under a live agent would act on a half-written tree. Wait for it to finish (or stop it) and ask again.`;

/**
 * IS THIS A REPO THE HUMAN ACTUALLY ADDED?
 *
 * Agent-scoped operations take their root from a vetted `AgentWorkflowContext`, but the PR/roster
 * entry points take a bare `root: string`, and `mergePrTool`'s request comes off the wire from a
 * model. An unvetted path would run `gh pr merge` — a `mutates-main` action — in a repo the human
 * never named. So a bare root is only honoured when it matches a registered project's `rootPath`.
 *
 * FAILS CLOSED, unlike `isWorking`: there the wrong answer costs a refused rebase, here it costs a
 * merge into somebody else's main. An unreadable/empty project list refuses everything.
 */
function isRegisteredRoot(root: string): boolean {
  const want = normalizeRoot(root);
  if (!want) return false;
  try {
    return useProjectStore
      .getState()
      .projects.some((p) => normalizeRoot(p.rootPath) === want);
  } catch {
    return false;
  }
}

/** Trailing separators and surrounding whitespace are not a different repo. */
function normalizeRoot(root: string): string {
  return (root || "").trim().replace(/[/\\]+$/, "");
}

const UNKNOWN_ROOT_MSG = (root: string) =>
  `Refused: "${root}" is not one of the projects added to Sparkle. This tool acts on the user's disk, so it only runs against a registered project root — ask for the project by name and let Sparkle supply its path.`;

// ---------------------------------------------------------------------------------------------
// The second gate: intent (a PR claim) and review state (roborev)
// ---------------------------------------------------------------------------------------------

/**
 * IS THE AGENT THAT CLAIMED THIS PR STILL AROUND?
 *
 * Deliberately ROSTER PRESENCE, not `useRuntimeStore` status. That status map is window-local and
 * never persisted — the note in controlListener's `handleGetState` spells this out — so an agent
 * mounted in another project window reads as "stopped" here. Voiding a claim on that reading would
 * hand the concierge a merge over a perfectly live owner, which is the exact failure this gate
 * exists to prevent, so presence in the persisted roster is the signal and the TTL on the claim is
 * what stops a genuinely dead agent from wedging the PR forever.
 *
 * An unreadable store answers TRUE (the claim stands). Unlike `isWorking` and like
 * `isRegisteredRoot`, the expensive mistake here is proceeding, not pausing.
 */
function claimantIsPresent(agentId: string): boolean {
  const roster = rosterAgents();
  // COULD NOT READ ⇒ the claim stands. `rosterAgents` returns null (not []) for an unreadable or
  // half-rehydrated store precisely so this stays reachable: an empty roster and an unknown one
  // are different facts, and collapsing them made an unreadable store report every claimant as
  // gone — merging over a live claim through the very guard added to prevent it.
  if (roster === null) return true;
  return roster.some((a) => a.id === agentId);
}

/** Every agent across every project, or `null` when the roster could not be READ — an unreadable
 *  store, or a persisted project record still rehydrating with no `agents` array. Null is not an
 *  empty roster, and the difference decides whether a claim blocks. */
function rosterAgents(): Array<{ id: string; name?: string }> | null {
  try {
    const projects = useProjectStore.getState().projects;
    if (!Array.isArray(projects)) return null;
    // A project record whose `agents` is missing is a store we cannot fully read, NOT a project
    // with no agents — treat the whole roster as unknown rather than quietly under-counting it.
    if (projects.some((p) => !Array.isArray(p.agents))) return null;
    return projects.flatMap((p) => p.agents);
  } catch {
    return null;
  }
}

/** A claim on this PR, resolved to the standing it actually carries right now. Never throws: a
 *  claim registry we cannot read must not take the merge path down with it — but see the caller,
 *  which does NOT treat an unreadable registry as "unclaimed". */
async function readPrClaim(root: string, number: number): Promise<PrClaimView | null> {
  const claims = await fetchPrClaims(root);
  if (claims === null) return null; // could not look — NOT "nobody claimed it"
  const claim = findClaim(claims, root, number);
  const agentName = claim
    ? ((rosterAgents() ?? []).find((a) => a.id === claim.agentId)?.name ?? null)
    : null;
  return viewClaim(
    claim,
    Date.now(),
    claim ? claimantIsPresent(claim.agentId) : false,
    agentName,
  );
}

/** The roborev state of a PR's HEAD branch. */
async function readRoborevState(root: string, branch: string): Promise<RoborevBranchState> {
  return summarizeRoborev(await fetchRoborevProbe(root, branch));
}

/**
 * Read `roborevOverride` off the wire. Returns `null` for "not supplied", `"invalid"` for a
 * malformed one, and the parsed value otherwise.
 *
 * A MALFORMED OVERRIDE IS AN ERROR, NOT AN ABSENT ONE. The caller is a model sending JSON that
 * TypeScript never sees; silently ignoring `{ roborevOverride: true }` would refuse the merge with
 * a findings message while the caller believed it had waived them, and it would keep believing that
 * on every retry. Say the shape is wrong.
 */
function normalizeAck(
  value: unknown,
): { acknowledgedJobIds: number[]; reason: string } | "invalid" | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object") return "invalid";
  const o = value as Record<string, unknown>;
  const ids = o.acknowledgedJobIds;
  const reason = o.reason;
  if (!Array.isArray(ids) || ids.length === 0) return "invalid";
  if (!ids.every((n) => Number.isInteger(n) && (n as number) > 0)) return "invalid";
  if (typeof reason !== "string" || reason.trim() === "") return "invalid";
  return { acknowledgedJobIds: ids as number[], reason: reason.trim() };
}

/**
 * Read `knightwatchOverride` off the wire. `null` for "not supplied", `"invalid"` for a malformed
 * one, the trimmed value otherwise.
 *
 * MALFORMED IS AN ERROR, NOT ABSENT — the same rule as {@link normalizeAck}, for the same reason:
 * the caller is a model sending JSON that TypeScript never sees, and silently ignoring
 * `{ knightwatchOverride: true }` would refuse the merge with a probe message while the caller
 * believed it had waived them, on every retry.
 *
 * The SENTENCE FLOOR is applied here too (`knightwatchReasonIssue`), not left to Rust. Rust remains
 * the authority — it must be, since it is the only thing every merge path passes through — but a
 * one-word reason bounced from there arrives as a `failed`/`unknown-error` with gh's wording, which
 * tells the model nothing about what to write instead. Refusing it here says exactly what is wrong.
 */
function normalizeKnightwatchOverride(
  value: unknown,
): KnightwatchOverride | "invalid" | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object") return "invalid";
  const reason = (value as Record<string, unknown>).reason;
  if (typeof reason !== "string") return "invalid";
  if (knightwatchReasonIssue(reason) !== null) return "invalid";
  return { reason: reason.trim() };
}

/**
 * What to tell a model whose merge was refused for unanswered probes — the Rust refusal verbatim,
 * plus the remedy.
 *
 * THE REMEDY IS THE REPLY, NOT THE OVERRIDE. A refusal that leads with its own escape hatch teaches
 * the model that the hatch is the way through, and the measured failure this gate exists to fix is
 * exactly that: 24 of the last 40 merged PRs carried a blocking probe and every one merged with no
 * probe-citing reply. So this names answering ON THE PULL REQUEST first, says plainly that the
 * override does not answer anything, and warns that whatever it writes is published as its own
 * words next to the question it skipped.
 */
function knightwatchRefusalMessage(number: number, rustMessage: string): string {
  return `Refused: PR #${number} still carries knightwatch review probes nobody has answered.\n\n${rustMessage}\n\nANSWER THEM ON THE PULL REQUEST — reply to the review comment, citing the probe, and say what you did about it. That is the only thing that clears a probe. \`knightwatchOverride: { reason }\` does NOT answer one: it records YOUR sentence on the PR as the reason you merged with the reviewer's question outstanding, and it is published under your name beside that question. Reach for it only when you can say why the probe does not apply — and if you are not the one who can answer it, say so and leave the PR unmerged.`;
}

/** The gate's own code word, mapped onto this domain's failure codes. Total over
 *  `RoborevGateCode`, so a new code there is a typecheck failure here rather than a silent
 *  `unknown-error`. */
function roborevCode(v: RoborevGateVerdict): WorkflowFailureCode {
  switch (v.code) {
    case "roborev-pending":
      return "roborev-pending";
    case "roborev-unresolved":
      return "roborev-unresolved";
    case "roborev-unknown":
    case null:
      return "roborev-unknown";
    default: {
      // A REAL exhaustiveness check. This used to be a bare `default:` under a comment claiming a
      // new `RoborevGateCode` would be a typecheck failure — it would not have been; it would have
      // silently become "unknown".
      const _never: never = v.code;
      void _never;
      return "roborev-unknown";
    }
  }
}

/** What to TELL the caller — including, for each arm, the thing it can actually do next. A refusal
 *  that does not name its remedy just gets retried verbatim. */
function roborevRefusalMessage(
  v: RoborevGateVerdict,
  branch: string,
  acknowledged: boolean,
): string {
  const ids = v.jobIds.length ? ` (roborev job${v.jobIds.length > 1 ? "s" : ""} ${v.jobIds.join(", ")})` : "";
  switch (v.code) {
    case "roborev-pending":
      return `Refused: a roborev review round is still IN FLIGHT on ${branch}${ids}. Its verdict does not exist yet, so there is nothing to read and nothing that can be waived — an in-flight round is not acknowledgeable by design. \`roborev wait\` on it, or ask again once it lands. This is the exact state PR #806 was merged in.`;
    case "roborev-unresolved":
      return acknowledged
        ? `Refused: the findings you acknowledged do not cover everything that is open${ids}. Read the remaining ones with pr_roborev_status and either fix them, \`roborev close\` them with a reason, or name them too.`
        : `Refused: ${branch} has open FAIL-verdict roborev reviews${ids} that nobody has read or closed. This project treats roborev as a required gate, and merging buries the findings on a branch that is about to be deleted. Read them with pr_roborev_status, then fix, \`roborev close\` with a stated reason, or acknowledge them by id.`;
    default:
      // TWO different situations share `roborev-unknown`, and telling them apart is the difference
      // between an actionable message and one that sends the reader to debug a healthy daemon.
      // When the verdict names job ids, roborev answered fine and THOSE JOBS died; only a verdict
      // with no ids is "we could not read roborev at all".
      return v.jobIds.length
        ? `Refused: roborev job${v.jobIds.length > 1 ? "s" : ""} ${v.jobIds.join(", ")} on ${branch} ended without a readable verdict — the review never finished, so nothing was checked. roborev answered fine; these particular jobs did not. Re-run them, or \`roborev close\` each with a reason once you have judged the commit by hand. They cannot be acknowledged with roborevOverride, which names open FAIL findings only.`
        : `Refused: roborev is the review gate on this machine and its state for ${branch} could not be read. That is "I could not find out", not "it is clean", and merging on it is merging blind.${v.reason ? ` ${v.reason}` : ""}`;
  }
}

// ---------------------------------------------------------------------------------------------
// Mutating operations
// ---------------------------------------------------------------------------------------------

/**
 * Catch an agent's branch up: rebase it onto its base. REFUSES while the agent is working — the same
 * guard the UI's Status pill applies, preserved here because it is the only thing stopping a rebase
 * from running under a live agent's feet.
 */
export async function refreshAgentBranchTool(
  ctx: AgentWorkflowContext,
): Promise<WorkflowResult<{ ahead: number; behind: number; base: string }>> {
  const op = "refresh_agent_branch";
  const base = (ctx.baseBranch || "").trim();
  if (!base) return refused(op, "no-target", "Refused: this agent has no base branch to rebase onto.");
  if (isWorking(ctx.agentId)) return refused(op, "agent-working", WORKING_MSG("Rebasing"));
  try {
    // isBusy=false: we just checked it ourselves, live, above.
    const r = await refreshAgentBranch(ctx.root, ctx.projectId, ctx.agentId, base, false);
    if (r.ok) return ok(op, { ahead: r.ahead, behind: r.behind, base });
    if (r.reason === "conflict")
      return failed(op, "conflict", "The rebase hit conflicts and was aborted; the branch is unchanged.", r.files ?? []);
    if (r.reason === "dirty")
      return refused(op, "dirty", "Refused: the agent's worktree has uncommitted changes. Commit or stash them first.", r.files ?? []);
    // "busy" can still come back if the PTY started between our check and the call. ONLY "busy" —
    // this used to be the catch-all, which told the model to "wait for the agent to finish" for
    // conditions that have nothing to do with the agent.
    if (r.reason === "busy") return refused(op, "agent-working", WORKING_MSG("Rebasing"), r.files ?? []);
    return failed(
      op,
      "unknown-error",
      `The rebase was declined for a reason this tool does not recognize: "${String(r.reason)}". The branch's state is unconfirmed — read its status before acting on this.`,
      r.files ?? [],
    );
  } catch (e) {
    return failed(op, "unknown-error", errText(e));
  }
}

/**
 * Merge the agent's branch into its integration target LOCALLY (`--no-ff`, see Rust
 * `land_agent_branch`). Classified `mutates-main` because it puts work on the integration branch
 * with NO review gate — on a repo with a remote the PR path (push → open PR → merge PR) is the one
 * AGENTS.md mandates, and this is the remoteless/worker fallback the close flow already uses.
 */
export async function landAgentBranchTool(
  ctx: AgentWorkflowContext,
): Promise<WorkflowResult<{ target: string; mergeSha: string | null }>> {
  const op = "land_agent_branch";
  const target = resolveLandTarget(ctx);
  if (!target) return refused(op, "no-target", "Refused: no integration branch is known for this agent.");
  // Not a guard the UI has: a human clicking Land on a running agent is a deliberate choice they can
  // see the state of; a model doing it merges whatever half-finished commit happens to be there.
  if (isWorking(ctx.agentId)) return refused(op, "agent-working", WORKING_MSG("Landing"));
  const targetBusy = ctx.kind === "worker" && ctx.parentId ? isWorking(ctx.parentId) : false;
  try {
    const r = await landAgentBranch(ctx.root, ctx.agentId, target, targetBusy);
    if (r.ok) return ok(op, { target: r.target, mergeSha: r.mergeSha ?? null });
    switch (r.reason) {
      case "busy":
        return refused(op, "target-busy", `Refused: ${target} belongs to an agent that is still working.`, r.files);
      case "conflict":
        return failed(op, "conflict", `The merge into ${target} conflicted and was aborted.`, r.files);
      case "merge-failed":
        return failed(op, "merge-failed", `git failed to merge into ${target}.`, r.files);
      case "dirty":
        return refused(op, "dirty", `Refused: ${target}'s worktree has uncommitted changes.`, r.files);
      case "nothing-to-land":
        return refused(op, "nothing-to-land", `${target} already contains this branch's work.`, r.files);
      case "target-not-checked-out":
        return refused(op, "target-not-checked-out", `${target} is not checked out anywhere Sparkle can merge into.`, r.files);
      case "no-branch":
        return refused(op, "no-branch", "Refused: this agent has no branch.", r.files);
      case "no-target":
        return refused(op, "no-target", "Refused: no integration branch is known for this agent.", r.files);
      default:
        // `reason` is a closed union to TypeScript, but it is DESERIALIZED FROM RUST across IPC —
        // tsc's exhaustiveness proves nothing about the value that actually arrives. Without this
        // arm the function fell off the end of the `try` and resolved `undefined`, from a function
        // whose whole contract is "always a typed result"; the caller then crashed on `result.ok`.
        return failed(
          op,
          "unknown-error",
          `The land into ${target} was declined for a reason this tool does not recognize: "${String(r.reason)}". Whether anything reached ${target} is unconfirmed — check before retrying.`,
          r.files,
        );
    }
  } catch (e) {
    return failed(op, "unknown-error", errText(e));
  }
}

/** Push the agent's branch to origin. Outward-facing: other people can see it afterwards. */
export async function pushAgentBranchTool(
  ctx: AgentWorkflowContext,
): Promise<WorkflowResult<{ outcome: "pushed"; branch: string }>> {
  const op = "push_agent_branch";
  try {
    // Rust resolves an outcome STRING. Match the known ones explicitly: "anything that isn't
    // no-remote is a successful push" would report `pushed` for whatever outcome a future Rust
    // build adds, which is a claim this layer has no basis for.
    const r = await pushAgentBranch(ctx.root, ctx.agentId);
    if (r === "no-remote")
      return refused(op, "no-remote", "Refused: this repo has no `origin` remote, so there is nowhere to push.");
    if (r === "pushed") return ok(op, { outcome: "pushed", branch: agentBranchName(ctx.agentId) });
    return failed(
      op,
      "unknown-error",
      `The push returned an outcome this tool does not recognize: "${String(r)}". Do NOT report the branch as pushed — read its status to find out.`,
    );
  } catch (e) {
    const msg = errText(e);
    return failed(op, classifyGitPushError(msg), msg);
  }
}

function classifyGitPushError(msg: string): WorkflowFailureCode {
  // Rust rejects with the BARE string "no-branch" when the agent has no branch to push. It is a
  // precisely known, actionable condition with a code of its own — falling through to
  // "unknown git failure" sends the model hunting for a git problem that isn't there.
  if (/^\s*no-branch\s*$/i.test(msg)) return "no-branch";
  if (/non-fast-forward|\[rejected\]|fetch first/i.test(msg)) return "rejected-non-fast-forward";
  if (/authentication failed|could not read username|permission denied|403|401|invalid credentials|access denied/i.test(msg))
    return "auth-failed";
  if (/no remote|does not appear to be a git repository|'origin' does not/i.test(msg)) return "no-remote";
  return "unknown-error";
}

/**
 * Open a GitHub PR for the agent's branch against its land target. This — not a push to main — is
 * how work reaches the default branch on a repo with a remote.
 */
export async function openAgentPrTool(
  ctx: AgentWorkflowContext,
  title: string,
): Promise<WorkflowResult<{ url: string; target: string; title: string }>> {
  const op = "open_agent_pr";
  const target = resolveLandTarget(ctx);
  if (!target) return refused(op, "no-target", "Refused: no target branch is known for this PR.");
  const t = (title || "").trim();
  if (!t) return refused(op, "invalid-request", "Refused: a PR needs a title. Say what the work does.");
  try {
    const url = await openAgentPr(ctx.root, ctx.projectId, ctx.agentId, target, t);
    return ok(op, { url, target, title: t });
  } catch (e) {
    const msg = errText(e);
    if (/already exists/i.test(msg))
      return refused(op, "pr-exists", `A pull request for this branch already exists. ${msg}`);
    if (/must first push|no commits between|head sha|not found on the remote|push the current branch/i.test(msg))
      return refused(op, "not-pushed", `Push the branch to origin first. ${msg}`);
    if (/command not found|no such file|gh (is )?not installed|executable/i.test(msg))
      return failed(op, "gh-unavailable", msg);
    if (/auth|not logged|401|403|token/i.test(msg)) return failed(op, "auth-failed", msg);
    if (/no remote|'origin' does not/i.test(msg)) return failed(op, "no-remote", msg);
    return failed(op, "unknown-error", msg);
  }
}

/**
 * What `merge_pr` accepts. There is deliberately NO merge-strategy field:
 *   - a SQUASH rewrites the branch's commits, so its tip stops being an ancestor of main and
 *     Sparkle's ancestry check can no longer prove the work landed (it falls back to a `gh` probe
 *     and reads committed work as at-risk when it isn't);
 *   - `--auto` is not a guard on this repo — auto-merge is disabled, so gh silently merges
 *     IMMEDIATELY with required checks still pending.
 * `never`-typed fields make asking for either a type error; `mergePrTool` rejects them at runtime
 * too, because the caller is a model sending JSON that TypeScript never sees.
 */
export interface MergePrRequest {
  /**
   * The PROJECT root. Validated against the registered projects (`isRegisteredRoot`) before
   * anything runs: unlike the agent-scoped operations, this object came off the wire, so the path
   * is the model's word — and this operation is `mutates-main`.
   */
  root: string;
  /** Scopes the PR→agent ownership lookup that annotates the probe. Same project as `root`. */
  projectId: string;
  number: number;
  /** The only merge method Sparkle allows. Optional, and if given it must be exactly "merge". */
  method?: "merge";
  auto?: never;
  squash?: never;
  rebase?: never;
  /**
   * WAIVE SPECIFIC, NAMED roborev findings — deliberately not a boolean.
   *
   * A caller must list the exact open FAIL job ids it is overriding. If the live blocking set is not
   * a SUBSET of what it named, the merge is refused anyway, so a model cannot blanket-override: it
   * has to have actually read the findings it is waiving, and a round that appeared since it looked
   * re-blocks. An IN-FLIGHT round can never be acknowledged at all — you cannot waive a verdict that
   * does not exist yet, and that is precisely the state PR #806 was merged in.
   *
   * `reason` is required and is not decoration: `merge_pr` is `mutates-main`, so it already goes to
   * the human for confirmation, and this is the sentence they read before saying yes.
   */
  roborevOverride?: { acknowledgedJobIds: number[]; reason: string };
  /**
   * MERGE PAST AN UNANSWERED KNIGHTWATCH `[blocking]` PROBE, in writing.
   *
   * Same shape discipline as `roborevOverride` and for the same reason: an object with a required
   * `reason` is what stops a caller expressing "override" without expressing why. Rust validates
   * that the reason costs a sentence and RECORDS IT ON THE PULL REQUEST, so whatever a model writes
   * here is published as the model's own words beside the question it declined to answer.
   *
   * IT DOES NOT ANSWER THE PROBE, AND THE REFUSAL SAYS SO. A probe is a reviewer's question about
   * this diff; the only thing that answers it is a reply on the PR citing it. A model that reaches
   * for this because a gate is in its way is doing the thing the gate exists to prevent, one step
   * more expensively — so the refusal text names the reply as the remedy and this field as the
   * exception, not the other way round. `merge_pr` is `mutates-main`, so a human confirms the call
   * either way and this sentence is what they are confirming.
   */
  knightwatchOverride?: KnightwatchOverride;
}

/**
 * Merge an open PR into the default branch with a MERGE COMMIT.
 *
 * Refuses to merge over red or pending checks, over a conflict, or when the PR probe could not
 * answer at all — "wait for checks, then merge" from AGENTS.md, applied to a caller that has no eyes
 * on the PR page. Reuses the UI's own `prMergeEligibility` so the concierge and the PR menu cannot
 * drift apart on what "safe to merge" means.
 *
 * GITHUB'S CHECK STATE IS NOT THIS PROJECT'S DEFINITION OF "CLEAN" — the #806 lesson. On
 * 2026-07-29 this tool merged a PR whose 18 checks were green and whose owning agent was
 * deliberately holding it for a roborev round it had drained eleven times. Nothing was wrong with
 * the CI gate; it was answering a narrower question than the one that mattered. So two more gates
 * run after it, in this order:
 *
 *   4. THE CLAIM. A live agent that said "I will land this" wins. Cheaper and far more actionable
 *      than an inventory of findings — "someone else owns this, go ask them" is the answer that
 *      would have prevented the incident outright.
 *   5. ROBOREV. Pending / unresolved / unreadable all refuse. Unreadable refuses for the same
 *      reason a `null` PR probe does: merging blind is what a gate exists to prevent.
 *
 * Both fail CLOSED on an unreadable probe. That can wedge a merge when the roborev daemon is down —
 * which is the correct trade for a `mutates-main` action, and why the narrow acknowledgement escape
 * hatch on `MergePrRequest.roborevOverride` exists rather than a blanket force flag.
 */
export async function mergePrTool(
  req: MergePrRequest,
): Promise<WorkflowResult<{ number: number; method: "merge"; url: string }>> {
  const op = "merge_pr";
  // Runtime backstop for the type above. Read defensively: this object came off the wire.
  const raw = req as unknown as Record<string, unknown>;
  if (raw.method !== undefined && raw.method !== "merge")
    return refused(
      op,
      "invalid-request",
      "Refused: Sparkle merges pull requests with a MERGE COMMIT only. A squash or rebase merge rewrites the branch's commits, so its tip stops being an ancestor of main and Sparkle can no longer prove by ancestry that the work landed.",
    );
  if (raw.auto)
    return refused(
      op,
      "invalid-request",
      "Refused: `--auto` is not a guard on this repo. Auto-merge is disabled, so gh would merge IMMEDIATELY with required checks still pending. Wait for the checks and merge deliberately.",
    );
  if (raw.squash || raw.rebase)
    return refused(op, "invalid-request", "Refused: squash and rebase merges are not available here — merge commits only.");
  if (!Number.isInteger(req.number) || req.number <= 0)
    return refused(op, "invalid-request", "Refused: a PR number is required.");
  // `method`/`auto`/`squash`/`number` were validated defensively above and `root` was not — yet
  // `root` is the one that decides WHICH REPOSITORY gets merged into.
  if (!isRegisteredRoot(req.root)) return refused(op, "invalid-request", UNKNOWN_ROOT_MSG(req.root));
  // ONE spelling from here down. `isRegisteredRoot` deliberately tolerates a trailing separator and
  // surrounding whitespace, but the downstream gates compare the root by exact string (the claim
  // registry) and hand it to a CLI (`--repo`), so `/repo/` used to sail past admission and then
  // match NO claims and NO reviews — reporting both gates clean. A tolerant check must not feed an
  // intolerant consumer.
  const root = normalizeRoot(req.root);

  let rows: PrRow[] | null;
  try {
    rows = await fetchOpenPrs(root, req.projectId);
  } catch (e) {
    return failed(op, "probe-failed", errText(e));
  }
  if (rows === null)
    return refused(
      op,
      "checks-unknown",
      "Refused: could not read the repo's open PRs (no gh, unauthed, offline, or timed out), so the PR's checks are unknown. Merging blind is exactly what the checks gate exists to prevent.",
    );
  const pr = rows.find((r) => r.number === req.number);
  if (!pr)
    return refused(
      op,
      "pr-not-found",
      `Refused: PR #${req.number} is not in the list this probe can see — ${PR_SCOPE}. It may be merged or closed, but it may equally be open and authored by someone else, or past the 100-row cap. Confirm with \`gh pr view ${req.number}\` before telling the user it is gone.`,
    );
  const gate = prMergeEligibility(pr);
  if (!gate.canMerge) return refused(op, "checks-blocked", `Refused: ${gate.reason}.`);

  // --- Gate 4: does an agent already own this? ------------------------------------------------
  const claimView = await readPrClaim(root, req.number);
  if (claimView === null)
    return refused(
      op,
      "checks-unknown",
      "Refused: could not read the PR claim registry, so whether an agent has said it will land this itself is unknown. An unreadable registry is not an unclaimed PR — that assumption is how #806 was merged out from under its owner.",
    );
  if (claimView.blocks)
    return refused(
      op,
      "pr-claimed",
      `Refused: ${claimView.summary} Merging now would land it against that agent's own gating criteria, which may be stricter than CI. Ask the agent about it instead of merging around it — its own summary above says whether the claim is current or already stale.`,
    );

  // --- Gate 5: roborev --------------------------------------------------------------------------
  const roborev = await readRoborevState(root, pr.headRefName);
  const ack = normalizeAck(raw.roborevOverride);
  if (ack === "invalid")
    return refused(
      op,
      "invalid-request",
      "Refused: `roborevOverride` must be `{ acknowledgedJobIds: number[], reason: string }` with at least one job id and a non-empty reason. It is deliberately not a boolean — waiving findings means naming the ones you read.",
    );
  const verdict = roborevMergeGate(roborev, ack?.acknowledgedJobIds);
  if (!verdict.canMerge)
    return refused(op, roborevCode(verdict), roborevRefusalMessage(verdict, pr.headRefName, ack !== null));

  // --- Gate 6: knightwatch probes -------------------------------------------------------------
  //
  // NOT ANOTHER PROBE OF OUR OWN. The gate itself is inside Rust's `merge_pr`, the single sink all
  // six in-app merge paths reach, so it cannot be routed around by a caller that skips this domain.
  // What happens HERE is only the two things a tool layer can do: refuse a malformed override
  // before spending a merge on it, and turn Rust's refusal into a coded, actionable one.
  const knightwatch = normalizeKnightwatchOverride(raw.knightwatchOverride);
  if (knightwatch === "invalid")
    return refused(
      op,
      "invalid-request",
      "Refused: `knightwatchOverride` must be `{ reason: string }`, and the reason has to be a sentence — at least 15 characters with a space in it. It is deliberately not a boolean: it is recorded on the pull request as your stated reason for merging with a reviewer's question unanswered, so \"ok\" is not one. Answering the probe on the PR is the way through; this is the exception.",
    );

  try {
    // THE HEAD THIS DECISION WAS MADE AGAINST. `pr` is the polled row `prMergeEligibility` read at
    // gate 3, so `pr.headRefOid` is the exact sha whose checks every gate above judged. Rust turns it
    // into `gh pr merge --match-head-commit`, so a branch that moved while gates 4-6 ran (a claim
    // read, a roborev probe and an override validation, none of them instant) is refused loudly
    // rather than merged at a head nobody evaluated. Without it the race is silent in the direction
    // that loses work: a commit pushed while the merge settles is simply absent from the default
    // branch afterwards and NOTHING looks wrong — the PR reads MERGED and the branch is back,
    // recreated by the push. Absent or empty merges unguarded, exactly as before.
    await mergePr(root, req.number, knightwatch?.reason, pr.headRefOid);
    return ok(op, { number: req.number, method: "merge", url: pr.url });
  } catch (e) {
    const msg = errText(e);
    // FIRST, because a probe refusal is a REFUSAL — nothing was merged and the repo did not move —
    // and because its remedy is nothing the patterns below would suggest. Left to them it lands on
    // `unknown-error` with Rust's prose and no code, which is a message a model retries verbatim.
    if (isKnightwatchRefusal(msg))
      return refused(op, "knightwatch-unanswered", knightwatchRefusalMessage(req.number, msg));
    // ALSO A REFUSAL, for the same reason and one more. GitHub evaluates `--match-head-commit`
    // BEFORE it merges anything, so a moved head means the repo did not move either — reporting it
    // as `failed` would tell the model an operation half-happened when none of it did. And it is
    // the guard added by this very call site doing its job, not a fault: the remedy is exact and
    // mechanical, so it gets a code rather than gh's prose. Ordered after the knightwatch branch
    // (whose test requires the word "knightwatch", so neither can shadow the other) and before the
    // generic patterns, none of which match this message.
    if (/head branch was modified|match-head-commit/i.test(msg))
      return refused(
        op,
        "head-moved",
        `Refused: PR #${req.number}'s head moved after this merge was gated — every check was judged at ${pr.headRefOid || "the head the poll reported"}, and GitHub declined the merge because the branch no longer points there. NOTHING was merged and the repository did not move. Call merge_pr again: it re-reads the PR and re-runs every gate against the new head. gh said: ${msg}`,
      );
    if (/not mergeable|conflict/i.test(msg)) return failed(op, "conflict", msg);
    if (/required status check|checks have not passed|blocked/i.test(msg)) return failed(op, "checks-blocked", msg);
    if (/auth|not logged|401|403|token/i.test(msg)) return failed(op, "auth-failed", msg);
    if (/command not found|no such file/i.test(msg)) return failed(op, "gh-unavailable", msg);
    return failed(op, "unknown-error", msg);
  }
}

/** What a delete tool reports. `deleted` is the OBSERVED outcome, never "the call resolved". */
export interface BranchDeleteReport {
  branch: string;
  /** True only for an outcome of `"deleted"`. An already-absent branch is `false`: nothing died. */
  deleted: boolean;
  outcome: BranchDeleteOutcome;
}

/**
 * Turn the outcome Rust reported into a result, or say we cannot confirm.
 *
 * An unrecognized value (an older binary that still resolves `undefined`, a renamed variant, a
 * caller that stubbed the service) must NOT resolve to a success. "I could not confirm what
 * happened" is a worse answer for the model than "deleted" only if "deleted" is true — and here it
 * is exactly the case where it might not be.
 */
function reportDelete(
  op: WorkflowOperation,
  branch: string,
  outcome: unknown,
): WorkflowResult<BranchDeleteReport> {
  switch (outcome) {
    case "deleted":
      return ok(op, { branch, deleted: true, outcome: "deleted" });
    case "already-absent":
      return ok(op, { branch, deleted: false, outcome: "already-absent" });
    case "kept-not-merged":
      return refused(
        op,
        "not-merged",
        `Kept ${branch}: its work is not contained in the project's default branch (neither by ancestry nor by merge-equivalence), so nothing was deleted. That is good news — the work is still here. Land or merge it first if you want the branch gone.`,
      );
    default:
      return failed(
        op,
        "unknown-error",
        `The delete returned an outcome this tool does not recognize: "${String(outcome)}". Sparkle CANNOT confirm whether ${branch} was deleted — do not report it either way; check with \`git branch --list ${branch}\`.`,
      );
  }
}

/**
 * Delete an agent's local branch, merged or not (`git branch -D`). IRREVERSIBLE — unmerged commits
 * are gone. Prefer `deleteAgentBranchIfMergedTool` unless the human has explicitly said to discard
 * the work. The worktree must already be removed (git refuses to delete a checked-out branch).
 *
 * The underlying command is IDEMPOTENT: a branch that was already gone resolves exactly like a real
 * delete, so the report comes from the outcome it returns rather than from the call resolving.
 */
export async function deleteAgentBranchTool(
  ctx: AgentWorkflowContext,
): Promise<WorkflowResult<BranchDeleteReport>> {
  const op = "delete_agent_branch";
  const branch = agentBranchName(ctx.agentId);
  if (isWorking(ctx.agentId)) return refused(op, "agent-working", WORKING_MSG("Deleting the branch"));
  try {
    return reportDelete(op, branch, await deleteAgentBranch(ctx.root, ctx.agentId));
  } catch (e) {
    const msg = errText(e);
    if (/used by worktree|checked out|cannot delete branch/i.test(msg)) return failed(op, "branch-checked-out", msg);
    return failed(op, "unknown-error", msg);
  }
}

/**
 * Delete an agent's local branch ONLY if its work is already on the project's default branch.
 *
 * NOT `git branch -d`, whatever the old comment here said: the Rust command tests ancestry OR
 * merge-equivalence (`merge-tree`, which recognizes the squash/rebase merge `-d` would refuse) and
 * then FORCE-deletes. Cannot lose landed work — an unlanded branch is simply kept.
 *
 * AND IT NEVER REJECTS FOR THE KEPT CASE. It returns Ok whether it deleted the branch or left it
 * alone, so the "kept, not merged" refusal has to be read off the returned outcome. It used to be
 * inferred from a rejection the command cannot produce, which meant the real, common behaviour —
 * branch kept — was reported as a confident `deleted: true` for a branch still sitting on disk.
 */
export async function deleteAgentBranchIfMergedTool(
  ctx: AgentWorkflowContext,
): Promise<WorkflowResult<BranchDeleteReport>> {
  const op = "delete_agent_branch_if_merged";
  const branch = agentBranchName(ctx.agentId);
  if (isWorking(ctx.agentId)) return refused(op, "agent-working", WORKING_MSG("Deleting the branch"));
  try {
    return reportDelete(op, branch, await deleteAgentBranchIfMerged(ctx.root, ctx.agentId));
  } catch (e) {
    const msg = errText(e);
    // Kept in place for a `git branch -d` message from any path that still produces one — the
    // outcome above is the primary signal, this is the belt.
    if (/not fully merged|not merged/i.test(msg))
      return refused(op, "not-merged", `Kept the branch: git says it is not fully merged. ${msg}`);
    if (/used by worktree|checked out|cannot delete branch/i.test(msg)) return failed(op, "branch-checked-out", msg);
    return failed(op, "unknown-error", msg);
  }
}

// ---------------------------------------------------------------------------------------------
// Read-only operations
// ---------------------------------------------------------------------------------------------

export async function agentBranchStatusTool(
  ctx: AgentWorkflowContext,
): Promise<WorkflowResult<BranchStatus>> {
  const op = "agent_branch_status";
  try {
    return ok(op, await agentBranchStatus(ctx.root, ctx.projectId, ctx.agentId, ctx.baseBranch || ""));
  } catch (e) {
    return failed(op, "unknown-error", errText(e));
  }
}

/** `probeGitHub` gates the network PR probe; leave it off for a fast, purely local read. */
export async function agentWorkflowStateTool(
  ctx: AgentWorkflowContext,
  opts: { probeGitHub?: boolean } = {},
): Promise<WorkflowResult<WorkflowState>> {
  const op = "agent_workflow_state";
  try {
    const parent = ctx.kind === "worker" && ctx.parentId ? agentBranchName(ctx.parentId) : "";
    return ok(
      op,
      await agentWorkflowState(
        ctx.root,
        ctx.agentId,
        parent,
        opts.probeGitHub === true,
        ctx.projectId,
      ),
    );
  } catch (e) {
    return failed(op, "unknown-error", errText(e));
  }
}

/** `root` is validated here for the same reason `mergePrTool`'s is — this entry point takes a bare
 *  path rather than a vetted `AgentWorkflowContext`. */
export async function projectAgentsStatusTool(
  root: string,
  projectId: string,
  agents: AgentStatusInput[],
  probeGitHub: boolean,
): Promise<WorkflowResult<AgentStatusResult[]>> {
  const op = "project_agents_status";
  if (!isRegisteredRoot(root)) return refused(op, "invalid-request", UNKNOWN_ROOT_MSG(root));
  try {
    return ok(op, await projectAgentsStatus(root, projectId, agents, probeGitHub));
  } catch (e) {
    return failed(op, "unknown-error", errText(e));
  }
}

/**
 * The open PRs this identity has in the repo. A failed probe is a FAILURE, never an empty list —
 * "no PRs are waiting" and "I couldn't look" are different answers and only one of them is
 * reassuring.
 *
 * NOT "every open PR in the repo": see `PR_SCOPE`. The scope travels with the data, because a bare
 * empty list reads as "the repo is clear" no matter what the doc comment says.
 */
export async function projectOpenPrsTool(
  root: string,
  projectId: string,
): Promise<WorkflowResult<{ prs: PrRow[]; scope: string; ownership: string }>> {
  const op = "project_open_prs";
  if (!isRegisteredRoot(root)) return refused(op, "invalid-request", UNKNOWN_ROOT_MSG(root));
  try {
    const rows = await fetchOpenPrs(root, projectId);
    if (rows === null)
      return failed(op, "probe-failed", "Could not read the repo's open PRs (no gh, unauthed, offline, or no remote). This is NOT the same as there being none.");
    return ok(op, {
      prs: rows,
      scope: `This list covers ${PR_SCOPE}. Other people's open PRs are not in it, so it is not evidence the repo has none.`,
      ownership: PR_OWNERSHIP_NOTE,
    });
  } catch (e) {
    return failed(op, "probe-failed", errText(e));
  }
}

/** What `pr_owner` answers with. Mirrors the Rust `PrOwnerAnswer`. */
export interface PrOwnerResult {
  number: number;
  /** The owning agent, or null for UNKNOWN — never a guess. */
  agentId: string | null;
  /** How the answer was reached: "created" | "pr-body" | "worktree-branch" | "branch-name". */
  source: string | null;
  branch: string | null;
  /** Why there is no owner. Null when there is one. */
  reason: string | null;
  ownership: string;
}

/**
 * Which agent owns PR `number` — the lookup for a PR `project_open_prs` did NOT list (someone
 * else's, or past the 100-row cap), so the concierge can still name an owner instead of citing a
 * bare number.
 *
 * Answers from the durable store first, so a PR this app opened resolves without a network round
 * trip; only an unknown PR costs a `gh pr view`. An unresolvable owner is a SUCCESS with
 * `agentId: null` and a reason, not a failure — "I could not find out" is a real answer and the
 * caller must be able to say it.
 */
export async function prOwnerTool(
  root: string,
  projectId: string,
  number: number,
): Promise<WorkflowResult<PrOwnerResult>> {
  const op = "pr_owner";
  if (!isRegisteredRoot(root)) return refused(op, "invalid-request", UNKNOWN_ROOT_MSG(root));
  if (!Number.isInteger(number) || number <= 0)
    return refused(op, "invalid-request", "Refused: a PR number is required.");
  try {
    const a = await fetchPrOwner(root, projectId, number);
    return ok(op, { ...a, ownership: PR_OWNERSHIP_NOTE });
  } catch (e) {
    return failed(op, "probe-failed", errText(e));
  }
}

export interface PrChecksStatus {
  number: number;
  title: string;
  url: string;
  checks: PrRow["checks"];
  mergeable: PrRow["mergeable"];
  /** Whether the checks state, as read, is safe to merge on — the UI's own gate. */
  canMerge: boolean;
  blockedReason: string | null;
  /**
   * How many CI steps actually EXECUTED. Always null here, and `stepCountAvailable` is always false:
   * this comes from the `gh pr list` rollup, which reports a verdict and no step counts. It is
   * surfaced anyway because its absence is the whole point — see `ambiguity`.
   */
  stepsExecuted: null;
  stepCountAvailable: false;
  /** Non-null when the reading cannot be taken at face value, saying exactly why. */
  ambiguity: string | null;
}

/**
 * A PR's CI rollup, with its blind spot stated rather than hidden.
 *
 * A RED result is not proof the tests failed. When Actions is unavailable to the repo (billing
 * block, spending cap, platform incident) every queued job is failed at the source with ZERO steps
 * executed, and the PR renders exactly like a genuine test failure; the tell is the step count. This
 * probe cannot supply one, so it says so and points at the command that can
 * (`gh run view <id> --json jobs`).
 */
export async function prChecksStatusTool(
  root: string,
  projectId: string,
  number: number,
): Promise<WorkflowResult<PrChecksStatus>> {
  const op = "pr_checks_status";
  if (!isRegisteredRoot(root)) return refused(op, "invalid-request", UNKNOWN_ROOT_MSG(root));
  try {
    const rows = await fetchOpenPrs(root, projectId);
    if (rows === null)
      return failed(op, "probe-failed", "Could not read the repo's PRs (no gh, unauthed, offline, or no remote), so the checks are unknown.");
    const pr = rows.find((r) => r.number === number);
    if (!pr)
      return failed(
        op,
        "pr-not-found",
        `PR #${number} is not in the list this probe can see — ${PR_SCOPE}. An open PR authored by someone else, or past the 100-row cap, lands here too; this is not evidence it is merged or closed. \`gh pr view ${number}\` answers it directly.`,
      );
    const gate = prMergeEligibility(pr);
    const ambiguity =
      pr.checks === "failing"
        ? "A red rollup does not prove the tests failed: when Actions is unavailable to the repo, every job fails at the source with ZERO steps executed and looks identical to a real failure. This probe reads the `gh pr list` rollup and cannot report a step count — confirm with `gh run view <id> --json jobs` (a total of 0 steps across jobs, and every workflow red at the same timestamp, means infrastructure, not tests)."
        : null;
    return ok(op, {
      number: pr.number,
      title: pr.title,
      url: pr.url,
      checks: pr.checks,
      mergeable: pr.mergeable,
      canMerge: gate.canMerge,
      blockedReason: gate.reason,
      stepsExecuted: null,
      stepCountAvailable: false,
      ambiguity,
    });
  } catch (e) {
    return failed(op, "probe-failed", errText(e));
  }
}

/** How many reviews we will open and parse for one `pr_roborev_status` call. The findings body of a
 *  thorough review runs to thousands of characters and lands permanently in a concierge's context,
 *  so the op reads the OPEN blockers newest-first and says plainly when it stopped. A cap that lies
 *  by omission would be worse than no cap — see `truncated`. */
const ROBOREV_REVIEW_READ_CAP = 5;

export interface PrRoborevStatus {
  number: number;
  branch: string;
  /** False when roborev is not in play on this machine — the gate does not apply, which is NOT the
   *  same as the branch being clean. */
  applicable: boolean;
  /** False when we could not read roborev at all. Everything below is then empty for lack of an
   *  answer, not because the answer was zero. */
  known: boolean;
  /** True while a round is queued or running. The single most common thing an agent is waiting on,
   *  and the thing the concierge could not see at all before this op existed. */
  roundInFlight: boolean;
  /** Whether `merge_pr` would refuse right now, and why — computed by the SAME gate the merge runs,
   *  so a concierge cannot read "clean" here and then be refused there. */
  wouldBlockMerge: boolean;
  blockedReason: string | null;
  /** Open FAIL reviews with their findings parsed out. Capped — see `truncated`. */
  outstanding: RoborevJobFindings[];
  /** The worst severity across everything in `outstanding`; null when there is nothing to rank. */
  highestSeverity: string | null;
  /** How many open blockers exist BEYOND the ones detailed above. Zero means the list is complete. */
  truncated: number;
  /** An agent's declared intent to land this PR, if any — read alongside the review state because
   *  they are the two halves of the same question ("is anyone else on this?"). */
  claim: PrClaimView | null;
  counts: { inFlight: number; blocking: number; errored: number; openPassing: number; total: number };
}

/**
 * THE READ OP THE CONCIERGE NEVER HAD.
 *
 * Agents in this project block on roborev constantly — it is the single most common thing they are
 * waiting for — and until now nothing in the concierge's tool surface could read review state for a
 * PR, a branch or a commit. So the concierge's only available reading of "is this ready" was CI, and
 * on 2026-07-29 it acted on exactly that and merged #806.
 *
 * Reports the branch's review state, the outstanding findings WITH severity, whether a round is in
 * flight, and any claim on the PR. `wouldBlockMerge` is computed by the same `roborevMergeGate` the
 * merge path runs, so this op and `merge_pr` can never disagree about what "clean" means.
 */
export async function prRoborevStatusTool(
  rawRoot: string,
  projectId: string,
  number: number,
): Promise<WorkflowResult<PrRoborevStatus>> {
  const op = "pr_roborev_status";
  if (!isRegisteredRoot(rawRoot)) return refused(op, "invalid-request", UNKNOWN_ROOT_MSG(rawRoot));
  // ONE spelling, for the same reason `mergePrTool` does it: admission tolerates a trailing
  // separator, the claim registry matches by exact string, and the roborev CLI's `--repo` does not
  // match a tolerated spelling. Without this the op reports both gates clean for `/repo/` — and
  // this is the op a concierge consults BEFORE deciding to merge, so it would disagree with the
  // merge gate it promises never to disagree with.
  const root = normalizeRoot(rawRoot);
  let rows: PrRow[] | null;
  try {
    rows = await fetchOpenPrs(root, projectId);
  } catch (e) {
    return failed(op, "probe-failed", errText(e));
  }
  if (rows === null)
    return failed(
      op,
      "probe-failed",
      "Could not read the repo's PRs (no gh, unauthed, offline, or no remote), so this PR's branch — and therefore its review state — is unknown.",
    );
  const pr = rows.find((r) => r.number === number);
  if (!pr)
    return failed(
      op,
      "pr-not-found",
      `PR #${number} is not in the list this probe can see — ${PR_SCOPE}. That is not evidence it is merged or closed; \`gh pr view ${number}\` answers it directly.`,
    );

  const state = await readRoborevState(root, pr.headRefName);
  const verdict = roborevMergeGate(state);
  // Newest first: when the cap bites, the reviews a caller most needs are the recent ones.
  const ordered = [...state.blocking].sort((a, b) => b.id - a.id);
  const detailed = ordered.slice(0, ROBOREV_REVIEW_READ_CAP);
  const outstanding: RoborevJobFindings[] = [];
  for (const job of detailed) {
    const body = await fetchRoborevReview(root, job.id);
    // null body ≠ no findings. `findings: null` says we could not read the review, which is a
    // different fact from a review that turned out clean, and the caller must be able to tell.
    outstanding.push({ job, findings: body === null ? null : parseRoborevFindings(body) });
  }
  const allFindings = outstanding.flatMap((o) => o.findings ?? []);
  let claim: PrClaimView | null = null;
  try {
    claim = await readPrClaim(root, number);
  } catch {
    claim = null; // best-effort here; the MERGE path is where an unreadable registry has to bite
  }

  return ok(op, {
    number: pr.number,
    branch: pr.headRefName,
    applicable: state.applicable,
    known: state.known,
    roundInFlight: state.inFlight.length > 0,
    wouldBlockMerge: !verdict.canMerge,
    blockedReason: verdict.canMerge
      ? null
      : roborevRefusalMessage(verdict, pr.headRefName, false),
    outstanding,
    // An unreadable review body must NOT summarise as "open reviews, nothing serious". `null` here
    // is reserved for "every body was read and none carried a finding"; a body we could not fetch
    // ranks as `unknown`, which sorts as high as `high`. Same null-is-not-a-benign-default rule the
    // probe follows, in the one field a model is most likely to summarise on.
    highestSeverity: outstanding.some((o) => o.findings === null)
      ? "unknown"
      : allFindings.length
        ? highestSeverity(allFindings)
        : null,
    truncated: Math.max(0, ordered.length - detailed.length),
    claim,
    counts: {
      inFlight: state.inFlight.length,
      blocking: state.blocking.length,
      errored: state.errored.length,
      openPassing: state.openPassing,
      total: state.total,
    },
  });
}

/**
 * Did this agent's work reach the default branch?
 *
 * ANCESTRY ONLY. Every verdict here comes from ref containment computed in Rust with
 * `git merge-base --is-ancestor` (WorkflowState's inLocalMain / inOriginMain / inParent) plus the
 * merge-equivalence check that catches a squash (`landed`). CI is never consulted: a green run on
 * main can belong to somebody else's commit.
 *
 * A WORKER'S TARGET IS ITS ORCHESTRATOR'S BRANCH, not the default branch (`resolveLandTarget`), so
 * containment there is a `landed` verdict with `where: "parent-branch"` — reported as its own place
 * rather than folded into the default-branch answer, because the two are different facts and the
 * caveat has to say which one it is holding. Ranked below the default-branch arms so work that
 * reached BOTH reports the stronger one.
 *
 * IT DOES NOT ANSWER "DID THIS SHIP". Whether the work is in a released build is ancestry against
 * the release TAG, and for tags up to v0.45.1 it cannot be answered at all (those builds tagged a
 * tree that was never the tree they built). WorkflowState carries a `shipped` flag; this function
 * deliberately does not read or report it, so a caller cannot mistake one answer for the other.
 */
export type LandedVerdict =
  | {
      verdict: "landed";
      /** `parent-branch` is a WORKER's integration target (its orchestrator's branch) — landed on
       *  its target, which is NOT the same as having reached the default branch. */
      where: "origin-default" | "local-default" | "parent-branch";
      basis: "ancestry";
      caveat: string | null;
    }
  | { verdict: "landed-squashed"; basis: "merge-equivalence"; caveat: string }
  | { verdict: "not-landed"; basis: "ancestry"; aheadOfBase: number; caveat: string }
  | { verdict: "unknown"; basis: "none"; caveat: string };

export async function agentLandedCheckTool(
  ctx: AgentWorkflowContext,
): Promise<WorkflowResult<LandedVerdict>> {
  const op = "agent_landed_check";
  let s: WorkflowState;
  try {
    const parent = ctx.kind === "worker" && ctx.parentId ? agentBranchName(ctx.parentId) : "";
    // probePrState=false: this question is answered from local refs. A PR probe would add network
    // latency and a state ("merged") that is NOT the same fact as containment.
    s = await agentWorkflowState(ctx.root, ctx.agentId, parent, false, ctx.projectId);
  } catch (e) {
    return ok(op, {
      verdict: "unknown",
      basis: "none",
      caveat: `Could not read the branch's reachability, so this is genuinely unknown — not a "no". ${errText(e)}`,
    });
  }
  if (s.inOriginMain)
    return ok(op, {
      verdict: "landed",
      where: "origin-default",
      basis: "ancestry",
      caveat: null,
    });
  if (s.inLocalMain)
    return ok(op, {
      verdict: "landed",
      where: "local-default",
      basis: "ancestry",
      caveat:
        "Contained in the LOCAL default branch but not in origin's as of the last fetch — it has landed here, not necessarily for anyone else.",
    });
  // A WORKER integrates into its orchestrator's branch, not into the default branch (see
  // `resolveLandTarget`). Work contained there HAS landed on its target; calling it "not-landed,
  // N ahead" is the work-at-risk signal, and it pushes the concierge to land work already
  // integrated. Ranked below the default-branch arms so the stronger fact wins when both hold.
  if (ctx.kind === "worker" && ctx.parentId && s.inParent)
    return ok(op, {
      verdict: "landed",
      where: "parent-branch",
      basis: "ancestry",
      caveat: `Contained in ${agentBranchName(ctx.parentId)}, this worker's integration target — NOT in the project's default branch. The orchestrator still has to land its own branch for this work to reach main; ask about the orchestrator to find out whether it has.`,
    });
  if (s.landed === true)
    return ok(op, {
      verdict: "landed-squashed",
      basis: "merge-equivalence",
      caveat:
        "The branch tip is not an ancestor of the default branch, but merging it would add nothing — consistent with a squash or rebase merge. Ancestry cannot confirm this one; the equivalence check can.",
    });
  return ok(op, {
    verdict: "not-landed",
    basis: "ancestry",
    aheadOfBase: s.aheadOfBase,
    caveat:
      "Computed from LOCAL refs with no fetch, so origin's default branch is only as current as the last fetch. Fetch and ask again before treating this as final.",
  });
}
