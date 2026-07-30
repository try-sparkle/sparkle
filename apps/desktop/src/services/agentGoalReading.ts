// agentGoalReading — the ONE place a control surface turns an agent record into "what is its goal,
// is it stalled, is it thrashing".
//
// WHY IT IS A SERVICE AND NOT THREE CALLS AT EACH CALL SITE. Two surfaces answer this question —
// `conciergeTools/terminal.getAgentStatus` (one agent, in depth) and `controlListener.handleGetState`
// (the whole roster, compactly) — and both need the SAME evidence: the goal off the agent record,
// `engine/agentStall` over that goal plus the agent's git state, and `engine/agentThrash` over the
// hook stream. Two copies of that assembly is exactly how the two surfaces end up disagreeing about
// whether an agent is stalled, which is the failure `services/agentLiveness` was extracted to stop
// one field over (a rule stated in one handler cannot be inherited by another).
//
// EVIDENCE, NOT INFERENCE — inherited from the engine and preserved here. `engine/agentStall`
// treats an ABSENT input as "not looked up" and refuses to manufacture a stall from it, so this
// module's job is to pass `undefined` through honestly rather than to substitute a cheerful default.
// Every reader below therefore has three answers (`true` / `false` / `undefined`), and the third one
// is a real answer.
import {
  goalRemainingMs,
  goalStateOf,
  hasUnmetGoal,
  type AgentGoal,
  type GoalState,
} from "../engine/agentGoal";
import { stallReport, type StallReport } from "../engine/agentStall";
import { thrashReportFor, type ThrashReport } from "../engine/agentThrash";
import { unlandedWorkEvidence, type WorkflowStageId } from "../engine/workflowStage";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useInteractionStore } from "../stores/interactionStore";
import { calmNewAgent } from "../engine/newAgentAttention";
import { findRosterAgent } from "./knownAgents";
import type { BranchStatus, WorkflowState } from "./branchStatus";
import type { AgentTabStatus } from "../types";

/** A goal, flattened for a tool result: the raw record's timestamps are replaced by the DERIVED
 *  facts a caller actually branches on (its state now, and how long it has left), because a model
 *  reading `setAt: 1753822...` has to do date arithmetic to learn anything. The retry counters ride
 *  along because "auto-continued 19 times" is the sentence that explains an imminent escalation. */
export interface GoalReading {
  text: string;
  /** `goalStateOf` at the clock passed in — "unmet" | "met" | "expired" | "escalated". Never
   *  "none": this whole object is ABSENT when there is no goal (see {@link goalReading}). */
  state: Exclude<GoalState, "none">;
  /** Milliseconds until the TTL runs out; 0 once it has. */
  remainingMs: number;
  /** Consecutive auto-continues since progress was last seen. */
  continues: number;
  /** Auto-continues spent on this goal ever — the bound that survives a flapping progress mark. */
  totalContinues: number;
  /** Present ONLY when `state === "escalated"`: why auto-continue gave up, for the human who now
   *  owns it. */
  escalationReason?: string;
}

/**
 * Flatten an agent's goal for reporting, or `undefined` when it has none.
 *
 * ABSENT, NOT NULL-SHAPED. An agent with no goal gets no `goal` key at all rather than a record of
 * empty strings and zeroes — a caller can then branch on presence, and a roster of forty goal-less
 * agents costs nothing to say so. (This is also why `state` excludes "none": if you are holding one
 * of these, there IS a goal.)
 */
export function goalReading(goal: AgentGoal | undefined, now: number): GoalReading | undefined {
  if (goal === undefined) return undefined;
  const state = goalStateOf(goal, now);
  // Unreachable for a defined goal — `goalStateOf` returns "none" only for `undefined` — but the
  // implication lives in another module, so it is restated rather than cast away.
  if (state === "none") return undefined;
  return {
    text: goal.text,
    state,
    remainingMs: goalRemainingMs(goal, now),
    continues: goal.continues,
    totalContinues: goal.totalContinues,
    // Only when it actually escalated: an escalation reason on a live goal would read as though the
    // fleet had already given up on it.
    ...(state === "escalated" && goal.escalationReason !== undefined
      ? { escalationReason: goal.escalationReason }
      : {}),
  };
}

/** The three git-shaped inputs `engine/agentStall` asks for. Every field is optional and
 *  `undefined` means NOT LOOKED UP — never "no". */
export interface StallEvidence {
  hasOpenPr?: boolean;
  hasUnlandedWork?: boolean;
  hasUncommittedChanges?: boolean;
}

/**
 * What this window can actually see about an agent's git state, read from `runtimeStore`.
 *
 * Every read here is window-local and already-polled — no `git` call, no network. That is a
 * requirement rather than an optimisation: `handleGetState` runs this for EVERY agent on the roster
 * on a call an orchestrator makes routinely, so an answer that costs a subprocess per agent would
 * cost more than the stalls it finds.
 *
 * The three `undefined` arms are the load-bearing part:
 *
 *  • NO ENTRY at all → `undefined`. This window has not polled that agent (its pane is mounted in
 *    another window, or nothing has polled yet). `stallReport` turns "no cause found, but I did not
 *    look" into the `unknown` verdict, which is the honest answer.
 *  • `prState: null` → `undefined`, NOT `false`. Rust reports `null` both for "probed, found no PR"
 *    and for a poll that did not probe GitHub at all (`probePrState` is gated), and those are
 *    indistinguishable at this boundary — the same ambiguity `WorkflowState.hasRemote` documents for
 *    its own `false`. Only "open" is evidence in either direction here.
 *  • DIRTY BUT PARKED → `undefined`. `BranchStatus.dirty` is the one field that is not derived from
 *    the branch ref, so when `worktreeOnBranch === false` the uncommitted files belong to whatever
 *    branch the tree was moved onto (the `land.sh` parking bug, bead `sparkle-rhgm`). Attributing
 *    them to THIS agent would claim a stall on another branch's work. A CLEAN tree is unambiguous
 *    either way, so `dirty: false` still answers `false`.
 */
export function stallEvidenceFor(agentId: string): StallEvidence {
  const rt = useRuntimeStore.getState();
  const openPr = readOpenPr(rt.workflowState?.[agentId]);
  const unlanded = readUnlanded(
    rt.branchStatus?.[agentId],
    rt.workflowState?.[agentId],
    rt.workflowStage?.[agentId],
  );
  const uncommitted = readUncommitted(rt.branchStatus?.[agentId]);
  // Spread-when-known rather than assign-possibly-undefined: `exactOptionalPropertyTypes` aside, a
  // key present with the value `undefined` reads as a supplied answer to anything that inspects the
  // object, and the whole point of this shape is that a missing key means "not looked up".
  return {
    ...(openPr === undefined ? {} : { hasOpenPr: openPr }),
    ...(unlanded === undefined ? {} : { hasUnlandedWork: unlanded }),
    ...(uncommitted === undefined ? {} : { hasUncommittedChanges: uncommitted }),
  };
}

/** `prState: null` is ambiguous — see {@link stallEvidenceFor}. Only "open" is a positive reading. */
function readOpenPr(ws: WorkflowState | undefined): boolean | undefined {
  if (ws === undefined || ws.prState === null) return undefined;
  return ws.prState === "open";
}

/**
 * THE SAME RULE THE SIDEBAR USES, not a second copy (roborev 55525).
 *
 * This used to read the stage watermark ALONE, which made the two surfaces contradict each other on
 * the exact case the sidebar had just been fixed for: the new-work cycle (merge PR #1, keep committing
 * on the same branch) has a monotonic `merged` watermark outranking live `ahead: 3`, so the sidebar
 * reported `stalled` / `unlanded-work` while `get_state` and `get_agent_status` reported `finished` —
 * for the same agent, at the same moment, on the surface a concierge actually sweeps. The inputs were
 * always in hand here; only the rule was missing. See `unlandedWorkEvidence` for why it yields to
 * reachability but pointedly NOT to `prState`.
 */
function readUnlanded(
  bs: BranchStatus | undefined,
  ws: WorkflowState | undefined,
  stage: WorkflowStageId | undefined,
): boolean | undefined {
  return unlandedWorkEvidence({ bs, ws, stageOverride: stage });
}

/** A parked worktree's dirt is some other branch's — see {@link stallEvidenceFor}. A clean tree is
 *  unambiguous whoever it belongs to. */
function readUncommitted(bs: BranchStatus | undefined): boolean | undefined {
  if (bs === undefined) return undefined;
  if (!bs.dirty) return false;
  return bs.worktreeOnBranch === false ? undefined : true;
}

/**
 * Is this agent idle-and-finished, idle-and-stalled, merely unexamined, or busy? The goal comes from
 * the agent record; the git evidence from {@link stallEvidenceFor}.
 *
 * THE STATUS CORRECTION HAPPENS HERE, not in the callers, and that is the whole point of this
 * function existing (roborev 55308). Extracting the assembly into one module was supposed to make
 * the two surfaces unable to disagree about who is stalled — but they were handing it differently
 * corrected statuses: `getAgentStatus` passed the `calmNewAgent`-corrected value (which rewrites
 * `idle` → `new` for a briefless, freshly-spawned agent) while `handleGetState` passed the raw map.
 * `new` is deliberately excluded from `agentStall.isQuiet` and `idle` is not, so one briefless agent
 * with a goal got `stalled` from one surface and `active — "Status 'new' — not idle."` from the other,
 * at the same moment. Applying the correction inside means a caller CANNOT supply an uncorrected
 * status: the divergence moved from the derivation to its input, and this puts it back.
 */
export function stallReadingFor(
  agentId: string,
  status: AgentTabStatus,
  goal: AgentGoal | undefined,
  now: number,
): StallReport {
  return stallReport({
    status: correctedStatusFor(agentId, status, now),
    now,
    goal,
    ...stallEvidenceFor(agentId),
  });
}

/**
 * The status a control surface should REPORT, corrected for "spawned but never briefed".
 *
 * Exported because a surface that publishes `status` and `stall` side by side has to derive both from
 * the SAME value or it contradicts itself in one object (roborev 55451). The roster used to emit the
 * RAW status next to a `stall` computed from the corrected one, and the omission rule for `stall` is
 * "the `active` verdict is already implied by `status`" — so a briefless, freshly-spawned agent with a
 * goal published `status: "idle"`, an unmet goal, and NO `stall` key. Applying the documented rule to
 * that row reads "active", which the `idle` in the same object denies. A caller sweeping for stuck
 * agents could resolve it neither way.
 *
 * `?? status` is not defensive noise: `calmNewAgent` returns `undefined` for an unobserved agent, and
 * this function's callers have a concrete status in hand and need one back.
 *
 * IDEMPOTENT BY CONTRACT, and callers rely on it (roborev 55588). `handleGetState` hands in a status
 * already corrected by `withNewAgentCalm` over the whole roster, so this runs a second time on the
 * same value — which must be a no-op, and is: `calmNewAgent` only rewrites `idle`/`blocked`, and its
 * output `new` is neither. Keeping the internal call rather than trusting every caller is deliberate;
 * it is what stops `get_agent_status` (the other caller, which has no roster-wide map) from diverging,
 * and that divergence is the bug this function was extracted for. If you ever make `calmNewAgent`
 * rewrite `new`, this stops being idempotent and the roster row starts double-correcting.
 */
export function correctedStatusFor(
  agentId: string,
  status: AgentTabStatus,
  now: number,
): AgentTabStatus {
  const tab = findRosterAgent(agentId);
  if (!tab) return status;
  return calmNewAgent(status, tab, now, useInteractionStore.getState().lastAt[agentId]) ?? status;
}

/**
 * Is this agent looping / out of context? `undefined` when this window has never seen a hook event
 * for it.
 *
 * THE `undefined` MUST REACH THE CALLER. `thrashReportFor` deliberately does not synthesise a
 * healthy-looking report for an agent nobody is watching, and a surface that turned that into
 * `thrashing: false` would publish calm on no evidence — the same false negative `liveness` and
 * `rollupDot`'s null arm exist to prevent, one module over.
 *
 * `goalOutstanding` is supplied because the `no-progress` rule is only an alarm while there is goal
 * work outstanding; without it, three prose turns in a row (a human asking an agent three questions)
 * read as "producing output without doing anything".
 */
export function thrashReadingFor(
  agentId: string,
  goal: AgentGoal | undefined,
  now: number,
): ThrashReport | undefined {
  return thrashReportFor(agentId, now, { goalOutstanding: hasUnmetGoal(goal, now) });
}
