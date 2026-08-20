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
import {
  type AgentGoal,
  goalRemainingMs,
  goalStateOf,
  escalationQuotesStaleText,
  mayRearmGoal,
  type GoalState,
} from "../engine/agentGoal";
import type { StallCause, StallInput, StallReport } from "../engine/agentStall";
import type { QuotaBlock } from "../engine/quotaBlock";
import type { HumanBlock } from "../engine/humanBlock";
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
  // Same reasoning as `quotaBlock` above, from a different ledger: this is the Rust nudger's record
  // of the agent's own answer about what is blocking it (`engine/humanBlock`). Not git evidence, so
  // not a member of `RowGitEvidence`; passed in, so this stays pure.
  humanBlock?: HumanBlock,
): StallInput {
  return {
    status,
    now,
    goal,
    ...(quotaBlock ? { quotaBlock } : {}),
    ...(humanBlock ? { humanBlock } : {}),
    hasOpenPr: openPrEvidence(ev.ws),
    hasUnlandedWork: unlandedEvidence(ev),
    hasUncommittedChanges: uncommittedEvidence(ev.bs),
  };
}

/** Each outstanding thing in three or four words, for a chip that has to fit in a sidebar column.
 *  The full sentence lives in `StallReport.detail` and rides along as the chip's tooltip. */
export const STALL_CAUSE_LABEL: Record<StallCause, string> = {
  // ADDRESSES THE READER, and says WHOSE claim it is. "blocked on you" rather than "blocked on
  // human" on purpose: the wire token is machine vocabulary, and the row is read by the person it
  // names. This is the label that finally matches the red dot the founder expected.
  "blocked-on-human": "blocked on you",
  // Names what RAN OUT rather than what happened, because "stuck again" is already carried by the
  // goal badge beside it and the fact worth three words here is that nothing may retry it now.
  "rearms-exhausted": "no re-arms left",
  // ADDRESSES THE READER ABOUT A STUCK ROW — a red cause. "abandoned" rather than "expired"
  // deliberately: the clock is not the fact worth three words here, the stranded branch nobody is
  // coming for is, and that is the disposition only he can make.
  "abandoned-goal": "gave up, work stranded",
  // ADDRESSES THE READER, but CALMLY (2026-08-18). The work is done and only his review-close is
  // left, so this names a task he does at his leisure — "awaiting", not "needs" — because the cause
  // is amber "awaiting review-close", not the red "a human is blocking this" it used to be.
  "human-verified-goal": "awaiting your sign-off",
  "escalated-goal": "auto-continue gave up",
  "unmet-goal": "goal unmet",
  "expired-goal": "goal expired",
  "open-pr": "PR unmerged",
  "unlanded-work": "work not landed",
  "uncommitted-changes": "uncommitted changes",
};

/** Warning-class ordering: worst first, so a row's single glyph and a pill row's first pill both
 *  lead with the thing most worth doing something about.
 *
 *  ⚠️ THE WORK CAUSES COME FIRST, AND THIS WAS INVERTED UNTIL 2026-08-06. `escalated-goal` used to
 *  head the list, on the reasoning that "nothing is coming for that agent at all". That ranked it
 *  above `unmet-goal` / `open-pr` / `unlanded-work` / `uncommitted-changes` — and once
 *  `escalated-goal` moved to the amber `lapsed` tier (engine/stallEscalation LIFECYCLE), the list
 *  led with the one cause that needs NOTHING from the human and buried the ones that do. A row
 *  holding uncommitted files would have shown "auto-continue gave up" as its single glyph.
 *
 *  So the order now mirrors `withStallAttention`'s: everything in `OUTSTANDING` (red — work that
 *  exists and nothing is coming to finish) sorts ahead of every cause that is NOT red. Relative
 *  order WITHIN the red group is unchanged. A cause that stops being red must move down here in the
 *  same change, or this list starts leading with the quiet one again — `agentNotices.test.ts`
 *  derives that partition from `escalationFor` rather than restating it, so a membership change in
 *  the engine fails there instead of silently invalidating this.
 *
 *  ⚠️ THIS GOVERNS PILL ORDER. The row's collapsed GLYPH and its click target are chosen by
 *  `agentNotices.GLYPH_RANK`, which overrides input order — reordering this map alone does NOT
 *  reach them, and that gap is what roborev 59949 caught. Both are fixed; keep them in step.
 *
 *  ⚠️ IT LIVES HERE, NOT IN `agentNotices`, SINCE roborev 65642. It governs THREE surfaces, not
 *  one: the composer's pill order, the row's collapsed glyph, and — added by that finding —
 *  {@link stallChipFor}'s head. The chip used to take `report.causes[0]` on the docblock's word
 *  that the engine emits most-actionable-first, and the engine does not: `stallReport` pushes
 *  `escalated-goal` (amber) before `abandoned-goal` (red), and after the 2026-08-18 demotion it
 *  pushed `human-verified-goal` (amber) before both. So a genuinely stuck row rendered a RED dot
 *  beside the calm chip "awaiting your sign-off +2" — the colour-vs-copy split this whole branch
 *  exists to close, inverted. Ranking the chip head fixes it at the reader rather than asking
 *  every future `causes.push` to remember an ordering nothing checks. */
export const STALL_CAUSE_RANK: Record<StallCause, number> = {
  // RED — `stallEscalation.OUTSTANDING`: the founder is the only actor who can clear it AND the
  // agent is genuinely stuck. All three red causes lead, ahead of every amber one.
  //
  // FIRST OF ALL, and the tie-break is provenance: every other cause on this list is something the
  // app INFERRED about the agent, while this is the agent's own answer to a direct question about
  // what is blocking it. An assertion beats an inference, so it leads.
  "blocked-on-human": 0,
  // Also RED. Below the agent's own answer because it is an inference, above `rearms-exhausted`
  // because a stranded branch is a stronger call to action than a spent retry budget.
  "abandoned-goal": 1,
  // RED, and LAST of the red group: it says only that nothing may retry the goal again, which is a
  // weaker call to action than a stated question or a stranded branch. It rides alongside
  // `escalated-goal` (which stays amber and stays at the bottom), so without a rank of its own the
  // row's single glyph would have led with the quiet member of the pair.
  "rearms-exhausted": 2,
  // NEVER RED SINCE 2026-08-18. `human-verified-goal` moved to the amber `lapsed` tier: an agent
  // awaiting the founder's review-close is done, not stuck, so it sorts BELOW every red cause — it
  // used to lead this whole list. It still ranks above the plain lifecycle causes below because it
  // names a task addressed to HIM (his sign-off) rather than work another actor finishes.
  "human-verified-goal": 3,
  // NEVER RED. The four below are `stallEscalation.LIFECYCLE` → the amber `lapsed` status; they were
  // in the RED group until 2026-08-07 and moved together (see OUTSTANDING for who clears each). Their
  // relative order is unchanged — it is a genuine actionability ordering among things somebody else
  // will do, and `uncommitted-changes` stays last of them for the same reason it always did.
  "unmet-goal": 4,
  "open-pr": 5,
  "unlanded-work": 6,
  "uncommitted-changes": 7,
  // `escalated-goal` is LIFECYCLE too, and sorts BELOW the work causes: it says our retry budget ran
  // out, which is the quietest thing on this list. `expired-goal` is in NEITHER engine set → calm
  // gray. Do not "keep them in step" by adding expiry to LIFECYCLE; that module's own ⚠️ block
  // explains at length why it must stay out.
  "escalated-goal": 8,
  "expired-goal": 9,
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
 * THE HEAD IS CHOSEN BY {@link STALL_CAUSE_RANK}, NOT BY INSERTION ORDER (roborev 65642). This
 * docblock used to say "`causes` is ordered most-actionable-first by the engine, so the head is the
 * right thing to name" — and the engine does not do that. `agentStall.stallReport` pushes
 * `escalated-goal` (amber) before `abandoned-goal` (red), and after the 2026-08-18 demotion it also
 * pushes `human-verified-goal` (amber) before both red causes. Both are reachable together on one
 * row, because every red goal cause requires an ESCALATED goal by construction. The result was a
 * row wearing the RED dot beside the calm chip "awaiting your sign-off +2" — the colour saying
 * "come and unstick this" and the words saying "no rush" about the same agent, which is the exact
 * split the red-dot work exists to close.
 *
 * Ranking here rather than re-ordering the pushes is deliberate: it fixes the reader once, instead
 * of asking every future `causes.push` to remember an ordering nothing enforces.
 *
 * The "+N" is not decoration either — it tells the reader the tooltip holds more than the headline.
 */
export function stallChipFor(report: StallReport, bs?: BranchStatus | undefined): StallChip | null {
  if (report.verdict !== "stalled") return null;
  // Worst-first by rank, with insertion order as the tie-break (the ranks are distinct today, so the
  // tie-break never fires — it is there so a future duplicate rank degrades to the old behaviour
  // rather than to an unstable sort).
  const first = report.causes.reduce<StallCause | undefined>(
    (best, c) => (best === undefined || STALL_CAUSE_RANK[c] < STALL_CAUSE_RANK[best] ? c : best),
    undefined,
  );
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
  // "Nudge loop", NOT "Stuck" or "Looping". Every other label here names what the AGENT is doing;
  // this one has to name what SPARKLE did, because the row it lands on is one the founder was told
  // needed him when it did not (bead sparkle-hpbkw). "Looping" was the word that shipped that
  // misreading — it is the `repeating-command` label one line up, and it says the agent is at fault.
  "nudge-loop": "Nudge loop",
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
  /** The state phrase — "active · 3h 20m left", "met", "auto-continue gave up — <reason>", or,
   *  once the concierge has re-armed it, "re-armed 2× and stuck again — …". */
  label: string;
  /** The goal is escalated — auto-continue gave up, or the concierge raised one deliberately.
   *  Rendered unmistakably; see `stallIsEscalated`. */
  escalated: boolean;
  /** The goal text {@link label}'s escalation sentence QUOTES, present only when it is no longer
   *  the goal the agent holds — i.e. `text` and the sentence describe two different objectives.
   *
   *  ⚠️ DATA, NOT PROSE, AND DELIBERATELY NOT FOLDED INTO {@link label}. `label` is what the
   *  compact column row hands to a `title` and an `aria-label`; the goal there is an ICON and the
   *  rule against putting words in it is written at AgentRow's `goalChipEl`. The card — the surface
   *  you get by clicking into a row — reads this field and decides its own wording, so the two-line
   *  "gave up on / now working on" reading exists exactly where there is room for it and nowhere
   *  else. Absent whenever the quote is live, so a card can branch on presence. */
  staleQuote?: string;
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
    case "discharged":
      // NAMES THE PROOF, because that is the whole difference from `met` one case up. `met` is a
      // CLAIM — the agent's, or a human's — and this is git's: Sparkle closed the goal itself after
      // reading that the work reached the default branch. Showing the sha is what makes the claim
      // auditable by the person reading the row, which is the entire justification for closing a
      // goal with nobody watching.
      return {
        state,
        text: goal.text,
        escalated: false,
        label: goal.dischargedSha
          ? `finished — ${goal.dischargedSha.slice(0, 7)} landed on main`
          : "finished — the work landed on main",
      };
    case "expired":
      // Deliberately NOT worded as "done". An expired goal is unfinished work whose auto-continue
      // MANDATE ran out — the same two facts engine/agentStall keeps apart in its `expired-goal`
      // cause, and the 153-minute-class stalls are the ones most likely to cross the TTL.
      return { state, text: goal.text, escalated: false, label: "ran out of time — never met" };
    case "escalated": {
      // A RE-ARMED GOAL THAT IS ESCALATED AGAIN IS NOT THE SAME ROW, and the badge has to say so.
      // The concierge may clear a machine escalation a bounded number of times (agentGoal's
      // MAX_CONCIERGE_REARMS); each clear puts the agent back to work and spends one. So an
      // escalation carrying `conciergeRearms > 0` means a MACHINE already tried this — the human is not
      // looking at a first give-up, and "just restart it" is advice that has already been taken.
      // The common case (never re-armed) keeps its exact original wording: this is a rarer row and
      // must not cost the ordinary one any clarity.
      const rearms = goal.conciergeRearms ?? 0;
      // ⚠️ A STALE SENTENCE IS NOT RENDERED AS A LIVE CLAIM (founder, 2026-08-18). `escalationReason`
      // is free prose frozen at the instant auto-continue gave up, and `chargeGoalDebt` deliberately
      // carries it onto whatever the goal becomes next — so it outlives the work it describes and
      // nothing regenerates it. Interpolated unconditionally, that let a row assert a blocker that no
      // longer existed: the row he reported read "blocked on human" about a release run that had
      // already terminally failed, in the app's own badge, beside a goal it no longer held.
      //
      // ⚠️ BE PRECISE ABOUT WHAT SURVIVES — this comment has now overstated it in BOTH directions
      // (roborev 65339, then 65369/65370), so it is written as an enumeration rather than a claim.
      // `staleQuote` carries `escalatedGoalText`, the GOAL TEXT the escalation was about, not the
      // `escalationReason` SENTENCE. Who still carries that sentence for a stale escalation:
      //   • DROPPED — this badge label, and `agentStall.stalledDetail` (the chip tooltip + pill).
      //   • CARRIED, MARKED STALE — the MCP roster (`services/controlListener`) and the wake-up
      //     brief (`services/agentGoalDisk`); both attach `escalationStale` beside it.
      //   • CARRIED, MARKED STALE — `services/agentGoalReading.goalReading`, which reaches
      //     `get_agent_status` and the `set_agent_goal` reply. It was the last UNFLAGGED reader and
      //     handed a machine the frozen sentence as an unqualified live claim; it now sets
      //     `escalationStale` too.
      // The trade this line makes is only about the LABEL: an out-of-date sentence with no room to
      // date it is worse than no sentence, and the reader still learns the escalation is stale and
      // what it was about.
      //
      // This is also the founder's "stale can never be red" rule at the copy layer: no red tier reads
      // this prose (see `stallEscalation.OUTSTANDING`), and now no live-sounding label does either.
      const staleProse = escalationQuotesStaleText(goal);
      const why = goal.escalationReason && !staleProse ? ` — ${goal.escalationReason}` : "";
      // Spread onto every escalated shape below, so a re-armed-and-stuck-again row cannot silently
      // lose the marker the common case gets.
      const stale = staleProse ? { staleQuote: goal.escalatedGoalText } : {};
      if (rearms === 0) {
        return {
          state,
          text: goal.text,
          escalated: true,
          label: `auto-continue gave up${why}`,
          ...stale,
        };
      }
      // The BADGE stays amber either way — `escalated-goal` was deliberately removed from the RED
      // tier on 2026-08-06 because rows were painted red that needed nothing, and that has not
      // changed. What DID change is the CAUSE: a spent allowance now also raises the
      // `rearms-exhausted` stall cause (engine/agentStall), which IS in the red tier, because at
      // that point auto-continue can do nothing more and only a human can move the row. The two
      // are not in conflict — the amber here is the goal badge's own wording, the red is the dot.
      // Read them together: `!mayRearmGoal(goal)` is the exact predicate behind both.
      const spent = !mayRearmGoal(goal);
      const label = spent
        ? `re-armed ${rearms}× and stuck again — no re-arms left, this one is yours${why}`
        : `re-armed ${rearms}× and stuck again${why}`;
      return { state, text: goal.text, escalated: true, label, ...stale };
    }
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
