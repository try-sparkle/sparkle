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
import {
  unlandedWorkEvidence,
  uncommittedWorkEvidence,
  type WorkflowStageId,
} from "../engine/workflowStage";

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
 * Uncommitted changes in this agent's own worktree — DELEGATED to
 * `engine/workflowStage.uncommittedWorkEvidence`.
 *
 * The rule (and its parked-worktree arm) lives in the engine because the STAGE LADDER needs the same
 * answer: `buildSections.sectionOfRow` uses it to tell "this row holds unsaved edits" from "nothing
 * has happened here yet" (sparkle-biezi). Keeping a second copy here is how `unlandedWorkEvidence`
 * previously let the sidebar and the control surface disagree about the same agent (roborev 55525).
 */
function uncommittedEvidence(bs: BranchStatus | undefined): boolean | undefined {
  return uncommittedWorkEvidence(bs);
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
  /** The uncommitted paths this row is holding, FULL paths, capped by Rust. Empty when the tree is
   *  clean, when nothing was read, or when the tree is parked (see {@link namedDirtyFiles}). The chip
   *  shows one basename; these ride the tooltip, where someone who needs the directory looks. */
  files: string[];
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
export function stallChipFor(report: StallReport, bs?: BranchStatus | undefined): StallChip | null {
  if (report.verdict !== "stalled") return null;
  const first = report.causes[0];
  if (first === undefined) return null;
  const more = report.causes.length - 1;
  const label = first === "uncommitted-changes" ? uncommittedLabel(bs) : STALL_CAUSE_LABEL[first];
  const text = `${label}${more > 0 ? ` +${more}` : ""}`;
  const files = namedDirtyFiles(bs);
  return {
    text,
    // The VISIBLE text may now be a bare filename (see `uncommittedLabel`), which on its own does not
    // say what is wrong with it. The accessible name must, so it keeps the cause word.
    ariaLabel:
      first === "uncommitted-changes" && files.length > 0
        ? `Stalled — uncommitted changes: ${text}`
        : `Stalled — ${text}`,
    escalated: report.causes.includes("escalated-goal"),
    files,
  };
}

/**
 * The uncommitted-changes chip, NAMING the file when we know it.
 *
 * "uncommitted changes" on its own is the reading the founder could not act on (sparkle-biezi): a
 * forgotten fix and a leftover build artifact produce the identical row, so every one of them costs a
 * terminal read to tell apart. One basename is usually enough to make that call at a glance —
 * `vite.config.ts` is a fix you forgot, `dist/bundle.js` is noise.
 *
 * Falls back to the bare label whenever we do not actually know: no reading yet, an older Rust build
 * that does not send the field, or a PARKED tree whose files are not this branch's to name. Never
 * invents a filename, and never claims a count it did not read.
 */
function uncommittedLabel(bs: BranchStatus | undefined): string {
  const files = namedDirtyFiles(bs);
  const head = files[0];
  if (head === undefined) return STALL_CAUSE_LABEL["uncommitted-changes"];
  // The TRUE total, not the preview's length — Rust caps the preview at 5 but always counts them all.
  const total = bs?.dirtyCount ?? files.length;
  const rest = total - 1;
  // JUST THE FILENAME — no "uncommitted:" prefix, and that is a deliberate reversal of the obvious
  // wording. The chip is capped at 20ch and the row ALREADY carries an "Unsaved" stage badge plus
  // this chip's own ⚠ icon and amber ink, so a prefix spends the scarce characters restating what
  // two neighbouring affordances say and then truncates the ONE thing they cannot: which file.
  // Photographed at the real column width, "uncommitted: CreditPill.tsx" renders as "uncommi…" —
  // strictly worse than the bare label it replaced. The word survives in `ariaLabel` (what a screen
  // reader announces) and in the tooltip, which is where the full paths already live.
  return `${basename(head)}${rest > 0 ? ` +${rest}` : ""}`;
}

/**
 * The dirty paths we may attribute to THIS agent, or `[]`.
 *
 * The `worktreeOnBranch === false` gate is the same one `uncommittedEvidence` applies to `dirty`, and
 * it matters more here: that tree's files belong to whatever branch got checked out into it, so
 * naming them on this row would pin another branch's work on this agent by filename — a confidently
 * wrong claim, which is worse than the silence.
 */
export function namedDirtyFiles(bs: BranchStatus | undefined): string[] {
  if (bs === undefined || bs.worktreeOnBranch === false) return [];
  return bs.dirtyFiles ?? [];
}

/** `apps/desktop/src/x.ts` → `x.ts`. The chip has room for a name, not a path; the full paths ride
 *  along in `StallChip.files` for the tooltip, which is where someone who needs the directory looks. */
function basename(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? path : path.slice(cut + 1);
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
