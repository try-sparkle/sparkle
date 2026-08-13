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
import { describeGoalVerify } from "@sparkle/core";
import { stallReport, type StallReport } from "../engine/agentStall";
import type { ExpiryProof } from "../engine/goalExpiry";
import { quotaBlockForAgent } from "../engine/engineRegistry";
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
  /** HOW this goal gets checked, rendered as one readable clause ("`pnpm test` exits 0", "a person
   *  decides"), and ABSENT when no check was stated.
   *
   *  Absence is the meaningful half: a goal with no check is one its own claimant may close, so a
   *  reader that cannot see this field cannot tell a goal someone else must sign off from one the
   *  agent will latch itself. It also makes an INHERITED check visible — a new goal that carries a
   *  check forward from a previous one reads as "a person decides" here, which is the only way the
   *  caller learns it did not get the self-markable goal it thought it set (roborev 55933). */
  verify?: string;
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
    // Only when a check was actually stated — `describeGoalVerify(undefined)` returns the honest
    // "no check stated", but rendering that on every goal would put a string on the overwhelming
    // majority of readings to say nothing, and absence already says it.
    ...(goal.verify !== undefined ? { verify: describeGoalVerify(goal.verify) } : {}),
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

/**
 * GIT'S ANSWER to "is this agent's work on origin/main?" — the evidence a `{kind:"landed"}` goal is
 * closed on. `true` / `false` / `undefined` ("not looked up").
 *
 * WHY THIS EXISTS (sparkle-vfkqz). `canSelfMarkMet` refused every `landed` goal to its own claimant
 * because nothing computed `landed`. Something did, all along — just not on this seam: the sidebar's
 * stage ladder and the unlanded-work surface have answered it since the workflow-stage work. Two
 * finished agents escalated to the founder over merged PRs while the fact sat one store read away.
 *
 * TWO CONDITIONS, AND BOTH ARE NEEDED:
 *
 *  • `workflowShipped` — the latched watermark set the first time the agent's stage reached `merged`
 *    (ORIGIN main, deliberately not `merged_local`; see runtimeStore). This is the POSITIVE half,
 *    and it must be positive: `hasUnlandedWork === false` would ALSO be true for an agent that never
 *    committed anything, which would let a goal reading "the fix is merged to origin/main" be closed
 *    by an agent that wrote no code. The watermark is written by `deriveLiveStage`, so it already
 *    carries that module's `committedSeen` guard — a no-op branch sitting on main's HEAD cannot
 *    claim it.
 *  • `unlandedWorkEvidence !== true` — the NEW-WORK CYCLE veto. The watermark is monotonic, so an
 *    agent that landed PR #1 and kept committing still reads `shipped: true` while holding unlanded
 *    commits. Closing a goal there would call an agent done over work it is visibly still holding,
 *    which is the original false-"done" this whole mechanism exists to prevent.
 *
 * NOT a new git call: every input is already-polled window-local state, same as
 * {@link stallEvidenceFor}. So an unopened pane answers `undefined`, and `undefined` fails CLOSED at
 * `canSelfMarkMet` — the agent is refused with copy telling it the reading is missing rather than
 * negative, instead of being told a human must close it.
 */
export function landedEvidenceFor(agentId: string): boolean | undefined {
  const rt = useRuntimeStore.getState();
  const bs = rt.branchStatus?.[agentId];
  const ws = rt.workflowState?.[agentId];
  const stage = rt.workflowStage?.[agentId];
  const shipped = rt.workflowShipped?.[agentId];
  // ⚠️ A LIVE READING IS REQUIRED, NOT JUST THE WATERMARKS (roborev 57794). `workflowStage` and
  // `workflowShipped` are PERSISTED across relaunch (runtimeStore `partialize`); `branchStatus` and
  // `workflowState` deliberately boot clean. So after a relaunch — or in any window that has never
  // polled this agent's pane — the two latches are present and both live signals are absent, and the
  // new-work veto below CANNOT FIRE because it reads `bs.ahead`, the very field that is missing.
  // That combination answered `true` from months-old localStorage: land PR #1, get a new task, write
  // three unlanded commits, relaunch, and the agent could close its goal on a merge that predates
  // the work — the false "done" this gate exists to prevent, restored by the fix for it.
  //
  // Treating it as "not looked up" is the honest reading and costs only a retry after the next poll,
  // which is the same remedy the refusal copy already gives.
  //
  // IT MUST BE `bs` SPECIFICALLY, NOT "either live map" (roborev 57796). The first version accepted
  // `ws !== undefined` as sufficient, which narrowed the hole without closing it: the veto below
  // fires on `bs.ahead`, and `unlandedWorkEvidence` bails early only when BOTH `bs` and
  // `stageOverride` are absent — so a `workflowState`-only reading plus a persisted `merged` stage
  // still fell through to `hasUnmergedCommittedWork(…) === false` and answered `true`, with the veto
  // structurally unable to fire. The two maps are populated independently (`AgentStatusResult.branch`
  // is nullable), so that is a reachable state, not a hypothetical. Require the field the veto
  // actually consumes; `ws` remains an INPUT to the evidence, never an alternative to `bs`.
  if (bs === undefined) return undefined;
  if (shipped !== true) return false;
  return unlandedWorkEvidence({ bs, ws, stageOverride: stage }) === true ? false : true;
}

/**
 * The evidence `engine/goalExpiry.decideExpiry` adjudicates an expired goal on — or `undefined`,
 * meaning WE DID NOT LOOK.
 *
 * ALL-OR-NOTHING, and that is the safety property rather than a convenience. Every boolean below is
 * a verdict, and `decideExpiry` can latch a goal permanently closed on them, so a partially-known
 * proof must not exist: absent evidence has to be indistinguishable from "not looked up" at the
 * boundary, or a missing reading gets read as a negative finding. This is the same
 * `undefined`-is-not-`false` discipline {@link stallEvidenceFor} is built on, held one notch
 * stricter because the consumer WRITES rather than merely renders.
 *
 * NOT A NEW GIT CALL. Every input is already-polled, window-local store state, exactly as
 * {@link stallEvidenceFor} and {@link landedEvidenceFor} are — this runs on the 15s continuation
 * sweep for every agent on the roster, so an answer costing a subprocess per agent would cost more
 * than the stalls it resolves.
 *
 * THE TWO SHAS AND `hasOpenPr` ARE ALLOWED TO BE ABSENT, and the exemption is earned by a test each
 * one passes: `decideExpiry` reads them from exactly ONE arm apiece, so their absence withholds that
 * single decision (`proof-unauditable`, `pr-state-unknown`) instead of colouring any other. Nothing
 * is inferred from it anywhere else.
 *
 * ⚠️ `hasOpenPr` WAS REQUIRED HERE, AND THAT SHIPPED THE WHOLE MECHANISM INERT for the population it
 * exists to rescue. `readOpenPr` answers `undefined` unless `workflowState` is present AND
 * `prState !== null` — and `null` is the ordinary reading for a branch that simply has no PR, since
 * the probe cannot tell "no PR" from "did not ask". So the target case (an agent walled by an
 * outage, work committed, no PR yet) produced NO proof at all, `decideExpiry` refused with
 * `evidence-unreadable`, and the goal was never re-armed — the dead letter this module was written
 * to end, reconstructed one layer down. Same reasoning as the shas, same fix: withhold the one
 * decision, not the evidence.
 */
export function expiryProofFor(agentId: string): ExpiryProof | undefined {
  const rt = useRuntimeStore.getState();
  const bs = rt.branchStatus?.[agentId];
  // The live reading is required, for the reason spelled out at `landedEvidenceFor`: `workflowStage`
  // and `workflowShipped` are PERSISTED across relaunch while `branchStatus` deliberately boots
  // clean, so without this an answer could be served from months-old localStorage — the false "done"
  // roborev 57794 restored once already.
  if (bs === undefined) return undefined;

  // ⚠️ PARKED IS ANSWERED HERE, BEFORE THE GATE, or the refusal it exists to name never happens.
  // `readUncommitted` returns `undefined` for precisely `dirty && worktreeOnBranch === false` — and a
  // parked worktree is parked BECAUSE someone checked a topic branch into it and is working there,
  // so dirty-and-parked is the majority of that population (21 of ~48 worktrees, measured). Those
  // therefore tripped the all-or-nothing gate and degraded into `evidence-unreadable`, which is the
  // exact outcome the pass-through below was written to prevent: only a parked-and-pristine tree
  // ever reached `worktree-parked`, and the two refusals say different things to a human.
  //
  // THE OTHER FIELDS ARE FAIL-CLOSED VALUES, not readings. `decideExpiry` returns at
  // `!proof.worktreeOnBranch` without consulting them, and these are chosen so that even a future
  // arm which did consult them could not write a latch: `landed:false` and `clean:false` refuse a
  // discharge, `unlanded:false` refuses an abandonment, and an absent `hasOpenPr` refuses one again.
  // A parked tree's evidence belongs to another branch; nothing here is attributable to this agent.
  if (bs.worktreeOnBranch === false) {
    return { landed: false, clean: false, unlanded: false, worktreeOnBranch: false };
  }

  const landed = landedEvidenceFor(agentId);
  const ev = stallEvidenceFor(agentId);
  const { hasOpenPr, hasUnlandedWork, hasUncommittedChanges } = ev;
  if (landed === undefined || hasUnlandedWork === undefined || hasUncommittedChanges === undefined) {
    return undefined;
  }

  return {
    landed,
    clean: hasUncommittedChanges === false,
    unlanded: hasUnlandedWork,
    // SPREAD-WHEN-KNOWN, the shape `stallEvidenceFor` already uses: a key present with the value
    // `undefined` reads as a supplied answer to anything inspecting the object, and the whole point
    // of this field being optional is that a missing key means "not looked up".
    ...(hasOpenPr === undefined ? {} : { hasOpenPr }),
    // Always `true` by the time we reach here — the `false` case returned above. Kept as a field
    // rather than dropped because `decideExpiry` owns the parked rule and names it in its refusal
    // (`worktree-parked`), which is a sentence a human can act on; this reader only supplies the
    // fact. `undefined` (a Rust build predating the field) reads as "on branch", the same
    // back-compat direction `BranchStatus` documents for it.
    worktreeOnBranch: true,
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
    // The account-limit wall, read from the same StatusEngine that observed it. Supplied HERE rather
    // than by each caller for the reason the corrected status is: `get_agent_status` and the roster
    // both publish this report, and a wall visible to one but not the other is the same
    // one-object-contradicts-itself bug the correction above exists to prevent.
    quotaBlock: quotaBlockForAgent(agentId, now),
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
  return thrashReportFor(agentId, now, {
    goalOutstanding: hasUnmetGoal(goal, now),
    // Same wall, same reader, same clock as `stallReadingFor` — so the two reports published side by
    // side in one `get_agent_status` response cannot disagree about whether the agent is blocked.
    quotaBlock: quotaBlockForAgent(agentId, now),
  });
}
