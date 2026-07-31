// rowAttention — the view-model that lets a sidebar row SAY which kind of gray it is.
//
// THE BUG THIS SERVES. Idle-and-done, idle-and-stalled and thrashing all render as the same gray
// row today, and that identity is the whole defect: a 153-minute stall looked exactly like an agent
// that had shipped its PR. The verdicts themselves already exist and are fully tested —
// engine/agentStall, engine/agentThrash, engine/agentGoal. Nothing here re-decides any of them.
// This module does the two jobs those pure cores deliberately left to the caller:
//
//   1. EVIDENCE GATHERING — turn what the sidebar already knows (branchStatus, workflowState, the
//      workflow-stage watermark) into `StallInput`, preserving the difference between "false" and
//      "not looked up". This is the part with the sharp edge; see `undefined` note below.
//   2. WORDING — short chip labels and a goal badge, so a row can name the outstanding work rather
//      than only that something is outstanding. "Stalled" alone sends the human off to investigate,
//      and the investigation is the expensive part.
//
// NO NEW STATUS. Everything here is a derived OVERLAY read ALONGSIDE `AgentTabStatus`, exactly as
// `rollupDot` sits beside `status` — see the architecture note at the top of engine/agentStall.ts
// for why adding a tenth status would change the meaning of every existing `idle` branch.
//
// `undefined` IS A VALUE, AND IT IS THE ONE THIS FILE EXISTS TO PROTECT. Every mapper below returns
// `undefined` when the app has not actually resolved the fact, and NEVER a `false` that would make
// a row look clean. A stall claim that fires on missing data trains the human to ignore the signal,
// which costs more than the stall did; a `finished` claim built on unread git state is the same lie
// in the other direction. `stallReport` turns a missing input into the `unknown` verdict, and
// `isStalled` deliberately renders no alarm for it.
import { type AgentGoal, goalRemainingMs, goalStateOf, type GoalState } from "../engine/agentGoal";
import type { StallCause, StallInput, StallReport } from "../engine/agentStall";
import type { QuotaBlock } from "../engine/quotaBlock";
import type { ThrashReport, ThrashVerdict } from "../engine/agentThrash";
import type { AgentTabStatus } from "../types";
import type { BranchStatus, WorkflowState } from "../services/branchStatus";
import { unlandedWorkEvidence, type WorkflowStageId } from "../engine/workflowStage";

/** Everything the sidebar holds about one agent's git state, each field carrying its own "we never
 *  looked" arm. Passed as a bag rather than positionally so a future signal can be added without
 *  every call site having to re-thread argument order. */
export interface RowGitEvidence {
  /** `runtimeStore.branchStatus[id]` — ahead/behind/dirty. Absent until the first poll lands. */
  bs?: BranchStatus | undefined;
  /** `runtimeStore.workflowState[id]` — reachability + the best-effort GitHub PR probe. */
  ws?: WorkflowState | undefined;
  /** `runtimeStore.workflowStage[id]` — the persisted monotonic stage watermark, if any. */
  stageOverride?: WorkflowStageId | undefined;
}

/**
 * Is there an OPEN, unmerged PR for this branch?
 *
 * `prState` is a required field on `WorkflowState` but its `null` is ambiguous by construction:
 * Rust returns `null` both for "probed GitHub, this branch has no PR" and for "this was a fast /
 * local poll, so `probePrState` was false and nothing was asked" — the same shape `hasRemote`
 * documents at length one field above it. Those are the two readings this surface must not
 * conflate, so `null` maps to `undefined` ("not looked up") rather than to `false`. The cost is a
 * row that reads `unknown` instead of `finished` until a probing poll lands; the cost of the other
 * choice is telling the human an agent is done on the strength of a lookup nobody performed.
 *
 * `merged` and `closed` ARE evidence — the probe ran and returned a definite non-open state.
 */
function openPrEvidence(ws: WorkflowState | undefined): boolean | undefined {
  if (ws === undefined) return undefined;
  if (ws.prState === null) return undefined;
  return ws.prState === "open";
}

/**
 * Committed work that never reached main — DELEGATED to `engine/workflowStage.unlandedWorkEvidence`.
 *
 * The rule itself (live commits outranking the monotonic watermark, and its reachability veto) lives
 * in the engine because the CONTROL surface needs the same answer: `agentGoalReading` used to derive
 * this from the stage watermark alone, so the sidebar and `get_state` disagreed about the same agent
 * at the same moment (roborev 55525). Two copies of the assembly is exactly how that happens.
 *
 * Note what this does NOT need to cover: `stallReport` already treats the `unmerged` STATUS itself
 * as proof, because `withUnmergedWork` writes that band only where this predicate held.
 */
function unlandedEvidence(ev: RowGitEvidence): boolean | undefined {
  return unlandedWorkEvidence(ev);
}

/**
 * Uncommitted changes in this agent's own worktree.
 *
 * The `worktreeOnBranch === false` arm is the subtle one, and BranchStatus.dirty documents the rule
 * this follows: a parked tree's dirt belongs to whatever branch was checked out into it, so it is
 * not evidence about THIS agent's outstanding work. That makes it neither a stall cause nor proof
 * of a clean tree — which is precisely `undefined`. (The close-prompt reads the same field the
 * opposite way, on purpose: it asks a SAFETY question, "are there files at risk", and parking
 * carries them along. This asks an ATTRIBUTION question.)
 *
 * `worktreeOnBranch === undefined` is a Rust build predating the field, not a parked tree; it takes
 * the normal path, matching every other attribution consumer's `!== false` gate.
 */
function uncommittedEvidence(bs: BranchStatus | undefined): boolean | undefined {
  if (bs === undefined) return undefined;
  if (bs.worktreeOnBranch === false) return undefined;
  return bs.dirty;
}

/** Assemble the stall question for one row. Pure; the clock and every fact arrive as arguments. */
export function stallInputsFor(
  status: AgentTabStatus,
  now: number,
  goal: AgentGoal | undefined,
  ev: RowGitEvidence,
  // PASSED IN, not looked up here, so this stays pure and the sidebar keeps deciding its own clock.
  // It is a separate parameter rather than a member of `RowGitEvidence` because it is not git
  // evidence — it is an observation from the agent's own output stream.
  quotaBlock?: QuotaBlock,
): StallInput {
  return {
    status,
    now,
    goal,
    ...(quotaBlock ? { quotaBlock } : {}),
    hasOpenPr: openPrEvidence(ev.ws),
    hasUnlandedWork: unlandedEvidence(ev),
    hasUncommittedChanges: uncommittedEvidence(ev.bs),
  };
}

/** Each outstanding thing in three or four words, for a chip that has to fit in a sidebar column.
 *  The full sentence lives in `StallReport.detail` and rides along as the chip's tooltip. */
export const STALL_CAUSE_LABEL: Record<StallCause, string> = {
  "escalated-goal": "auto-continue gave up",
  "unmet-goal": "goal unmet",
  "expired-goal": "goal expired",
  "open-pr": "PR unmerged",
  "unlanded-work": "work not landed",
  "uncommitted-changes": "uncommitted changes",
};

/** What a stalled row renders. `text` is the VISIBLE reading and it is the CAUSE, not the word
 *  "stalled": the column has room for one short phrase per row, and the phrase worth spending it on
 *  is the one that names the outstanding work — "stalled" is already carried by the chip's icon and
 *  ink. The word survives in `ariaLabel`, which is what a screen reader announces and what the row's
 *  accessible name has to say out loud. */
export interface StallChip {
  text: string;
  ariaLabel: string;
  /** Auto-continue gave up on this agent's goal. The single most important thing on the row when it
   *  is true: the mechanism meant to keep it moving has handed it back, so it is nobody's but the
   *  human's. Drives the chip's ink. */
  escalated: boolean;
}

/**
 * The chip for a row, or `null` for a row that gets none.
 *
 * `null` for every verdict except `stalled` — `finished` needs no decoration, `active` is the red
 * tier which is already loud, and `unknown` is the one that matters: it renders NOTHING, because a
 * row we failed to look at is not a row to raise an alarm about.
 *
 * `causes` is ordered most-actionable-first by the engine, so the head is the right thing to name.
 * The "+N" is not decoration either — it tells the reader the tooltip holds more than the headline.
 */
export function stallChipFor(report: StallReport): StallChip | null {
  if (report.verdict !== "stalled") return null;
  const first = report.causes[0];
  if (first === undefined) return null;
  const more = report.causes.length - 1;
  const text = `${STALL_CAUSE_LABEL[first]}${more > 0 ? ` +${more}` : ""}`;
  return {
    text,
    ariaLabel: `Stalled — ${text}`,
    escalated: report.causes.includes("escalated-goal"),
  };
}

/** What is wrong, in one or two words. `healthy` has no entry — it gets no chip. */
export const THRASH_VERDICT_LABEL: Record<Exclude<ThrashVerdict, "healthy">, string> = {
  "context-pressure": "Context exhausted",
  "repeating-command": "Looping",
  "no-progress": "No progress",
  // "Rate limited", not "Blocked": the row's STATUS already reads Blocked, and a chip that repeats
  // the band name spends the row's scarcest space saying nothing. This chip's job is to say WHY.
  "quota-blocked": "Rate limited",
};

/**
 * The thrash chip's text, or `null`.
 *
 * `undefined` IN, `null` OUT — and that is not the same as healthy. `thrashReportFor` returns
 * `undefined` for an agent this window has never seen a hook event for, and reading that as calm
 * would report health on no evidence. Both render no chip, but they mean different things and the
 * distinction is why this takes `ThrashReport | undefined` rather than a defaulted report.
 */
export function thrashChipLabel(report: ThrashReport | undefined): string | null {
  if (report === undefined) return null;
  if (report.verdict === "healthy") return null;
  return THRASH_VERDICT_LABEL[report.verdict];
}

/** The goal, as a row/card can render it: what it is, where it is in its life, and whether it has
 *  been handed back to the human. `null` when the agent has no goal at all. */
export interface GoalBadge {
  state: Exclude<GoalState, "none">;
  /** The goal's own words. */
  text: string;
  /** The state phrase — "active · 3h 20m left", "met", "auto-continue gave up — <reason>". */
  label: string;
  /** Auto-continue gave up. Rendered unmistakably; see `stallIsEscalated`. */
  escalated: boolean;
}

export function goalBadgeFor(goal: AgentGoal | undefined, now: number): GoalBadge | null {
  const state = goalStateOf(goal, now);
  if (goal === undefined || state === "none") return null;
  switch (state) {
    case "unmet":
      // The "goal active (4h)" reading the PRD asked for. Remaining time is a bound on how much
      // longer auto-continue may spend on it (agentGoal.DEFAULT_GOAL_TTL_MS), not a deadline for
      // the work — so it reads as "left", not "due".
      return {
        state,
        text: goal.text,
        escalated: false,
        label: `active · ${formatRemaining(goalRemainingMs(goal, now))} left`,
      };
    case "met":
      return { state, text: goal.text, escalated: false, label: "met" };
    case "expired":
      // Deliberately NOT worded as "done". An expired goal is unfinished work whose auto-continue
      // MANDATE ran out — the same two facts engine/agentStall keeps apart in its `expired-goal`
      // cause, and the 153-minute-class stalls are the ones most likely to cross the TTL.
      return { state, text: goal.text, escalated: false, label: "ran out of time — never met" };
    case "escalated":
      return {
        state,
        text: goal.text,
        escalated: true,
        label: goal.escalationReason
          ? `auto-continue gave up — ${goal.escalationReason}`
          : "auto-continue gave up",
      };
  }
}

/** "3h 20m", "45m", "<1m", "0m" — coarse on purpose. Nobody acts on the seconds, and a ticking
 *  seconds field would re-render every row in the column once a second to say so. */
export function formatRemaining(ms: number): string {
  if (ms <= 0) return "0m";
  const totalMin = Math.floor(ms / 60_000);
  if (totalMin === 0) return "<1m";
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${totalMin}m`;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}
