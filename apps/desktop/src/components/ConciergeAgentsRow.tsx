// THE "CONCIERGE AGENTS" ROW — one pinned row, sitting directly above Improve Sparkle, standing in
// for every research task the concierge has dispatched. Bead `sparkle-s7rfc`.
//
// The founder's spec, verbatim: *"Let's have a row right above improved sparkle called 'Concierge
// Agents'. it's just one row, like a build orchestrator with '+[n]' showing how many agents are
// running I can click on the row to open up the agents, which are indented like regular build
// workers, and click on any of them to see details."*
//
// ══ IT IS A BUILD ORCHESTRATOR THAT HAPPENS TO HAVE NO PTY ══════════════════════════════════════
//
// READ `SparkleAgentRow`'s HEADER BEFORE CHANGING ANYTHING HERE. It is a written argument against
// exactly the drift this row could reintroduce — "the whole point of the column is that it is
// scannable straight down; a row with its own dialect is a row you have to stop and read" — and it
// records, one by one, the special cases that had to be taken back off the last row that grew them
// (a bigger disc, its own inset, its own font size, a gradient bar, a bordered pill, and worst, its
// own status derivation).
//
// So this row borrows, and invents nothing:
//   • the disc slot          — `DOT_SLOT_W` / `DOT_SIZE` / `GLYPH_SLOT_H`, centered, same line
//   • the box                — `rowBoxFor({ pinned: true })`, the same rule the Sparkle row takes
//                              because it likewise sits OUTSIDE the padded scroll container
//   • the title              — `AGENT_NAME_FONT_SIZE`, `rowTitleWeight`, NEUTRAL ink (`C.cream`).
//                              Colour lives in the disc, on every row in this column.
//   • the badge             — `C.muted` / 12px / lineHeight 1, the collapsed orchestrator's badge.
//                              Its WORDING is this row's own (`2 active now · 9 in the last hour`,
//                              see below); its ink and metrics are borrowed like everything else.
//   • the child indent       — `DEPTH_INDENT`, fed to the SAME `rowBoxFor`, so a task's disc lands
//                              where this row's TITLE begins, exactly as a worker's does
//   • the elapsed reading    — `ElapsedTimer` on the shared `useRowClock`
//   • the selected paint     — `ActiveFillets` + the `forest` fill, on the open child
//
// ══ THE DOT IS DERIVED BY THE CALLER, NOT HERE ═════════════════════════════════════════════════
//
// `status` / `dotColor` / `dotLabel` / `liveCount` / `hydrated` arrive as PRIMITIVE PROPS from
// `AgentSidebar`, which runs them through the same `rollupDot` + `ROLLUP_DOT_COLOR` + `rollupLabel`
// pipeline every build row goes through. Do NOT re-derive any of them in here. A second derivation
// is precisely how the Improve Sparkle row came to render GREEN while its agent sat on an unanswered
// four-option picker: it had a private copy of the logic, so a fix to the shared pipeline landed on
// every other row and silently missed it.
//
// ══ A RESEARCH TASK IS NOT AN AGENT ════════════════════════════════════════════════════════════
//
// Nothing here widens `AgentKind` and nothing is added to `projectStore.agents`. A research task has
// no worktree, no branch, no pane and no PTY — every roster consumer (the ladder, the band chips,
// `get_state`, the concierge's sidebar view, close/retire/promote) would have to learn a fourth kind
// that answers differently to all of them. The row reads `useResearchStore` directly instead, which
// is the same posture `SupportTicketRow` takes toward its own store.
//
// ══ WHY THE `+0` IS RENDERED WHERE THE SPARKLE ROW HIDES ITS BADGE ═════════════════════════════
//
// `SparkleAgentRow` renders `+N` only when N > 0, because there the badge is incidental. Here the
// number IS the row — the founder asked for "'+[n]' showing how many agents are running" on a row
// that is always present — so a live count of zero is a fact the row reports rather than a badge it
// suppresses. `hydrated` is what separates that from "we have not looked yet": before the first
// `listResearch()` lands, the row shows NO badge at all rather than claiming zero.
//
// ══ THE GAUGE IS NO LONGER SPELLED `+N`, AND THAT IS THE SAME ARGUMENT ═════════════════════════
//
// Founder, 2026-08-20: *"instead of plus two, it could say something like '2 active now'"*. `+2`
// said how many without ever saying how many WHAT — running, queued, finished-and-unread all read
// identically — which is the one-signal-many-meanings failure this row's other two numbers were
// each added to end. It now reads `2 active now`, and "active" is chosen over "running" because the
// gauge is `liveTasks` = `queued` + `running`: a queued task has been dispatched and has not
// started, so "running" would claim something false about it. The tooltip carries the exact
// membership — see `badgeTitle`.
//
// The zero rule above is UNCHANGED by the rewording: `0 active now` is still rendered, still for the
// reason stated, and `hydrated` still separates it from having not looked.
//
// ══ THE THIRD NUMBER: THE QUEUE, WHICH IS NOT A RESEARCH FACT AT ALL ═══════════════════════════
//
// Bead `sparkle-zx9knz`. The founder had SIXTEEN messages queued to the concierge while this row
// read `+2`, and asked why ten agents were not spun up. Both of the numbers above were telling the
// truth and neither could answer him: `+[n]` is a LIVE GAUGE with no denominator — `liveTasks`
// counts `queued` + `running` only — so it decays toward zero as passes finish, while the
// concierge's own turn queue stays deep, because dispatching research DEQUEUES NOTHING (only
// `turnFinished` advances that queue). `+0` therefore meant BOTH "nothing to do" and "sixteen of
// your messages are still unanswered and nobody is currently working on any of them".
//
// `queuedCount` is the denominator, and it is the SAME shape of fix as `recentCount` one paragraph
// up: a second population the founder can act on, rendered beside the gauge rather than folded into
// it. It is deliberately NOT a research number — the queue belongs to the concierge, not to any
// task — so it is kept out of `researchRollupStatuses` and touches no disc. Painting the disc from
// it would be the second status derivation this file's header forbids by name.
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { C } from "../theme/colors";
import { DOT_SIZE, DOT_SLOT_W, GLYPH_SLOT_H, DEPTH_INDENT } from "../engine/rowGeometry";
import type { PairSide } from "../engine/rowGeometry";
import { ActiveFillets, rowBoxFor } from "./rowAnatomy";
import { StatusDot } from "./StatusDot";
import { AGENT_NAME_FONT_SIZE, rowTitleWeight } from "./FittedAgentName";
import {
  conciergeBadgeTier,
  conciergeLiveLabel,
  conciergeQueueLabel,
  conciergeRecentLabel,
  conciergeTitleFloor,
} from "./rowWidthThresholds";
import { useRowClock, ElapsedTimer } from "./rowClock";
import type { AgentTabStatus } from "../types";
import {
  groupTasks,
  RECENT_RESEARCH_WINDOW_LABEL,
  RECENT_RESEARCH_WINDOW_SHORT_LABEL,
  refreshResearch,
  RESEARCH_POLL_INTERVAL_MS,
  useResearchStore,
} from "../services/research/store";
import {
  closeResearchPane,
  openResearchTaskInPane,
} from "../services/research/selection";
import { useUiStore } from "../stores/uiStore";
import {
  isLive,
  isRetired,
  type ResearchDepth,
  type ResearchStatus,
  type ResearchTask,
} from "../services/research/types";
import {
  countsTowardRollup,
  dotVariantFor,
  titleInkFor,
  type RowLiveness,
} from "../engine/retiredRowTreatment";

/** The row's label. A CONSTANT because two surfaces read it — the row and its tests — and a literal
 *  in each is a place for them to disagree, the same reason `SPARKLE_AGENT_DISPLAY_NAME` exists. */
export const CONCIERGE_AGENTS_TITLE = "Concierge Agents";

/** `data-hint` for the header row, mirroring `"improve"` / `"agent"`. */
export const CONCIERGE_AGENTS_HINT = "concierge-agents";

/**
 * A research task's life stage, expressed in the column's OWN status vocabulary.
 *
 * This is a TRANSLATION, not a second status taxonomy: it exists so a research task can go through
 * `rollupDot` / `bandOfStatus` / `StatusDot` unchanged, rather than teaching those three about a
 * fifth enum. Exported so the sidebar's rollup and this row's child discs call the same function —
 * one derivation used twice, never two derivations.
 *
 * `failed` → `errored` is the only mapping worth arguing about, and the argument is that a research
 * run that died IS something the founder wants to see when they open the row. It is deliberately
 * NOT allowed to paint the header red forever, though — see `researchRollupStatuses`.
 */
export function agentStatusForResearch(status: ResearchStatus): AgentTabStatus {
  switch (status) {
    // Both LIVE states are green. `queued` has no process yet, but it is work in flight from the
    // founder's point of view — and it is one of the two states `+[n]` counts, so painting it calm
    // would put a number on the row that its own disc contradicts.
    case "queued":
    case "running":
      return "working";
    case "done":
      return "done";
    case "failed":
      return "errored";
    // `cancelled` is a state the founder PUT it in. It is not an alarm and never becomes one.
    case "cancelled":
      return "stopped";
  }
}

/**
 * What the header's disc rolls up: the LIVE tasks only.
 *
 * Terminal tasks are history — they do not paint the collapsed row. That is not tidiness, it is the
 * `unmerged` lesson from `engine/workerRollup` applied one row over: a red that can never be cleared
 * stops being a signal.
 *
 * THE ORIGINAL GROUNDS FOR THIS HAVE BEEN RETRACTED, so the decision is re-stated on ones that
 * survive. It used to read "a failed research task has no 'read' concept (`readAt` is stamped for
 * `done` only) … no gesture that calms it". That is now false in both halves: `readAt` is stamped
 * for EVERY terminal status, and the calming gesture exists — the concierge being told, which also
 * retires the row. A future editor reasoning from the old premise would conclude the opposite.
 *
 * The decision stands anyway, on the simpler ground: a terminal task is FINISHED, and a rollup disc
 * is about what is happening now. A row that has stopped needs no attention from the collapsed
 * header, and it removes itself shortly afterwards, so escalating it would paint a red that is
 * already on its way out.
 *
 * Consequence, stated so it is a decision rather than an oversight: the collapsed row is GREEN while
 * anything is live and GRAY otherwise, and it never goes red. If research ever grows a state that
 * genuinely blocks the founder, add it here and the whole rollup/band/chip chain follows for free.
 */
export function researchRollupStatuses(tasks: readonly ResearchTask[]): AgentTabStatus[] {
  // TWO FILTERS, and the second is the one that reads as redundant today. `isLive` is the narrow
  // rule this row has always applied (queued + running); `countsTowardRollup` is the name of the
  // WIDER rule `engine/retiredRowTreatment` states for every surface that shows finished work —
  // *"whatever surface adopts this treatment must filter retired rows OUT of its rollup"*. Every
  // live-phase task is by construction un-retired, so the conjunction changes no answer now. It is
  // written anyway because the expanded group is a union that DOES carry retired tasks (see
  // `groupTasks`): the day someone widens the first filter to include terminal-but-unclaimed work,
  // the second is what stops a retired `failed` task riding in with it and painting the header red
  // forever. The rule is imported rather than restated, so the reasoning behind it stays in one
  // place (engine/retiredRowTreatment) rather than being re-argued at this call site.
  return tasks
    .filter((t) => isLive(t) && countsTowardRollup(livenessOfResearch(t)))
    .map((t) => agentStatusForResearch(t.status));
}

/**
 * A research task's liveness in the shared vocabulary of `engine/retiredRowTreatment`.
 *
 * The one place this row translates its own notion of "finished" into that module's single bit. The
 * mapping is `isRetired` — terminal AND claimed by the concierge — which is exactly the population
 * `visibleTasks` drops and `groupTasks` brings back: a row is drawn as history precisely when it has
 * said everything it is ever going to say and been heard.
 *
 * NOT `isTerminal`. A finished task whose findings are still owed to the prompt preamble is
 * unfinished BUSINESS — it is about to be read out to the founder — and drawing it hollow-and-muted
 * would dim the one row that still has something to deliver.
 */
export function livenessOfResearch(task: ResearchTask): RowLiveness {
  return isRetired(task) ? "retired" : "live";
}

/** The human word for a task's state, used in the main-pane view. Sentence case, like every other
 *  label in the column. Exported so `ConciergeResearchPane` renders the SAME word this row's disc
 *  label uses — one vocabulary, not two. */
export function researchStatusLabel(status: ResearchStatus): string {
  switch (status) {
    case "queued":
      return "Queued";
    case "running":
      return "Running";
    case "done":
      return "Done";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
  }
}

/**
 * The research TIER, in words the founder reads — the closest stable stand-in for "which model".
 *
 * The task record carries no model id (the model is derived from `depth` inside the runner, which
 * this lane deliberately does not touch), and `depth` is the contract field that decides it: `quick`
 * is the cheaper/faster model, `deep` the bigger one on a longer wall clock (see research/types.ts).
 * So the detail names the tier rather than inventing a model-id coupling the frontend does not own.
 */
export function researchTierLabel(depth: ResearchDepth): string {
  return depth === "deep" ? "Deep research" : "Quick research";
}

/** When this task's clock started, and when it stopped (`null` = still running). Exported for the
 *  main-pane view's elapsed reading, so the row and the pane measure the same span. */
export function spanOf(task: ResearchTask): { since: number; until: number | null } {
  return { since: task.startedAt ?? task.createdAt, until: task.finishedAt };
}

/**
 * Does the badge carry a queue segment at all?
 *
 * ONE predicate, read by the visible text and by BOTH copy strings, so a tooltip cannot come to
 * describe a segment the row is not drawing — the "one derivation used twice, never two
 * derivations" rule this file applies to every other number it shows. The repo treats user-facing
 * copy as code, and a string that describes the old behaviour is the specific failure it calls out.
 *
 * TWO SUPPRESSIONS, and they are different facts:
 *
 *   • `undefined` is WE DID NOT LOOK, never an empty queue. That is the rule
 *     `stores/conciergeQueueStore` states for itself — see its "`undefined` MEANS WE DID NOT LOOK"
 *     header — and it is what a window with no `ConciergeHost` mounted reports. Rendering it as `0`
 *     would put the fail-open answer at the front of a display built to end a silence.
 *   • `0` is a real, measured empty queue, and it is suppressed for exactly the reason `recentCount`
 *     is: it is the ordinary state of every single send, so a permanent `· 0 queued` would be a
 *     second zero saying what `0 active now` already says.
 *
 * The two therefore render identically and mean different things. That is deliberate; do not
 * "simplify" it into a truthiness test, because the day this row grows a treatment for one of them
 * the other must not come with it.
 */
function showsQueue(queuedCount: number | undefined): queuedCount is number {
  return queuedCount !== undefined && queuedCount > 0;
}

/**
 * The badge's accessible description — the same segments the eye gets, in the same order.
 *
 * Terse on purpose: this is read aloud in a list of rows, so it names the numbers rather than
 * explaining them. {@link badgeTitle} is where the explanation lives.
 */
function badgeAria(liveCount: number, recentCount: number, queuedCount: number | undefined): string {
  const parts = [`${liveCount} active now`];
  if (showsQueue(queuedCount)) parts.push(`${queuedCount} queued`);
  if (recentCount > 0) parts.push(`${recentCount} in ${RECENT_RESEARCH_WINDOW_LABEL}`);
  return parts.join(", ");
}

/**
 * The badge's hover copy — each number in the words that say WHICH population it counts.
 *
 * The queue clause is worded against the field's actual definition: `ConciergeQueueDepth.waiting`
 * EXCLUDES the turn in flight ("Messages waiting BEHIND the running turn"), so "waiting behind the
 * concierge's current turn" is true of it and "messages outstanding" would not be.
 *
 * ══ THE TOOLTIP CARRIES THE PRECISION THE ROW HAS NO WIDTH FOR ═════════════════════════════════
 *
 * The visible gauge reads `N active now`, which is the founder's own wording and is honest: the
 * number is `liveTasks` = `queued` + `running`, and "active" covers both. It is not, however,
 * EXACT — a queued task has been dispatched and has not started — and "running" would have been the
 * worse trade, since it claims something about a queued task that is false. So the row says the
 * true-and-short thing and the tooltip says the whole thing. The alternative, splitting the gauge
 * into `1 running · 1 starting`, was rejected: this badge already carries a `queued` segment meaning
 * something else entirely (the concierge's MESSAGE queue), and two different "queued"s on one line
 * is the one-signal-many-meanings failure the third number was added to end.
 */
function badgeTitle(liveCount: number, recentCount: number, queuedCount: number | undefined): string {
  const parts = [
    `${liveCount} research ${liveCount === 1 ? "agent" : "agents"} active now (running or queued)`,
  ];
  if (showsQueue(queuedCount)) {
    parts.push(
      `${queuedCount} ${queuedCount === 1 ? "message" : "messages"} waiting behind the concierge's current turn`,
    );
  }
  if (recentCount > 0) {
    parts.push(`${recentCount} dispatched in ${RECENT_RESEARCH_WINDOW_LABEL}`);
  }
  return parts.join(" · ");
}

/**
 * The pinned "Concierge Agents" row and, when it is open, one indented row per research task.
 *
 * `React.memo`'d with primitive props and no callbacks at all, for the same reason `SparkleAgentRow`
 * is (sparkle-alrm.3): a project agent's status flip re-renders that agent's row and must not reach
 * this one. The expansion is LOCAL state and the task list comes from the row's own store
 * subscription, so neither travels through props and neither can be invalidated by the column.
 */
export const ConciergeAgentsRow = memo(function ConciergeAgentsRow({
  status,
  dotColor,
  dotRing,
  dotLabel,
  liveCount,
  columnWidth,
  recentCount,
  queuedCount,
  hydrated,
  paneSide,
  jointOpen,
}: {
  /** The row's own status, from the caller's `rollupDot` pipeline. See the header. */
  status: AgentTabStatus;
  /** Rolled-up disc paint, when the tasks under this row disagree with its own status. Same override
   *  every build head takes; `undefined` means "use the status taxonomy". */
  dotColor?: string;
  /** Draw the disc as a RING: the colour describes a row UNDER this one. Set exactly where
   *  `dotColor` is — see StatusDot's `variant` (roborev 63126). */
  dotRing?: boolean;
  dotLabel?: string;
  /** Queued + running. Straight from the store's `liveTasks` selector via the caller — NOT counted
   *  again in here, so the badge and the disc can never tell different stories. */
  liveCount: number;
  /**
   * The measured width of the sidebar column, or 0 before it has been measured.
   *
   * Picks the badge's phrasing — see {@link conciergeBadgeTier}. The shrink rules below keep the
   * badge from OVERFLOWING; this keeps it from being ELLIPSIZED, which at the default 220px column
   * ate the `in the last hour` phrase this change exists to show. Same prop and same "component
   * measures, `rowWidthThresholds` decides" split as `AgentRow`'s stage chip.
   */
  columnWidth?: number;
  /**
   * How many were dispatched in the last {@link RECENT_RESEARCH_WINDOW_MS} — every status.
   *
   * THE HALF THAT MAKES `+0` READABLE. `liveCount` is a gauge and falls back to zero minutes after
   * each burst, so on its own it cannot distinguish "delegating, just finished" from "has never
   * delegated" — and the founder read the second off a row that meant the first. Same rule as
   * `liveCount`: computed by the caller through the store's own selector, never re-counted here.
   */
  recentCount: number;
  /**
   * How many messages are waiting behind the running concierge turn — `undefined` for WE DID NOT
   * LOOK.
   *
   * THE DENOMINATOR THE OTHER TWO NUMBERS LACK (bead `sparkle-zx9knz`). See the header: `+[n]`
   * decays to zero as passes finish while the turn queue stays deep, so without this a row reading
   * `+0` means both "nothing to do" and "sixteen of your messages are unanswered".
   *
   * OPTIONAL is load-bearing, and `undefined` is NOT `0` — that is the rule
   * `stores/conciergeQueueStore` states for itself; see {@link showsQueue}. Same discipline as the
   * two counts above: a PRIMITIVE PROP computed by the caller through the store's own selector
   * (`useConciergeQueueStore((s) => s.depth)?.waiting`), never re-derived in here, and no store
   * subscription of this row's own.
   */
  queuedCount?: number;
  /** Has the first `listResearch()` landed? Separates "+0" from "we have not looked yet". */
  hydrated: boolean;
  /** The same two geometry inputs every row in this column takes — see engine/rowGeometry. */
  paneSide: PairSide;
  jointOpen: boolean;
}) {
  // `showsQueue` is passed in, not inferred: the queue segment costs about a tier's worth of width
  // and the ladder's budgets were measured without it, so the tier has to know whether it is there.
  const tier = conciergeBadgeTier(columnWidth ?? 0, showsQueue(queuedCount));
  const titleFloor = conciergeTitleFloor(columnWidth ?? 0);
  const [expanded, setExpanded] = useState(false);
  const byId = useResearchStore((s) => s.byId);
  const openTaskId = useResearchStore((s) => s.openTaskId);
  const openTaskSeq = useResearchStore((s) => s.openTaskSeq);
  // Is the research pane the ACTIVE main-pane view right now? A child row paints as selected only
  // when its task is BOTH the open one AND on screen in the main pane — so selecting a worker (which
  // clears `activeSpecial` via showBuildStage) drops this row's fill even though `openTaskId` stays
  // sticky, exactly as a worker row de-highlights when you switch to Improve Sparkle.
  const researchActive = useUiStore((s) => s.activeSpecial === "research");
  // Newest first, through the store's OWN selector. Sorting here instead would be a second answer to
  // "which task is the latest", which is the drift `sortedTasks` exists to prevent.
  //
  // ══ LIVE WORK, PLUS WHAT FINISHED RECENTLY ══════════════════════════════════════════════════════
  //
  // This was `sortedTasks(Object.values(byId))` — every task the store had ever seen, for the life of
  // the install, because nothing anywhere retired one. The founder's sidebar reached 28 stacked rows,
  // 11 of them red at exactly 3m: dead research runs that had already said everything they were ever
  // going to say, sitting there looking like live work. `visibleTasks` fixed that by dropping every
  // RETIRED task — one the concierge has been TOLD about.
  //
  // It overshot, and the founder reported the overshoot the next day: he clicked
  // `Concierge Agents +0 · 15 recently` and nothing opened. The `· N recently` badge counts
  // `recentTasks`, which KEEPS retired tasks on purpose, so the header promised fifteen rows onto a
  // group that rendered none of them. *"I wanna be able to see the recent ones as well as the active
  // ones."*
  //
  // `groupTasks` is the union of the two sets, bounded by the same window the badge already uses
  // (`RECENT_RESEARCH_WINDOW_MS`, one hour since 2026-08-20) — so the label and the click are
  // computed from one another and cannot drift again. That coupling is why narrowing the window
  // narrowed BOTH in one edit: a badge counting an hour over a list showing twelve would have been
  // the same defect as the dead click above, pointing the other way. Retired rows
  // are drawn as history (hollow disc, muted title; see `livenessOfResearch`) rather than hidden, and
  // they are still kept out of every rollup — see `researchRollupStatuses`.
  //
  // `Date.now()` at render rather than a clock of its own, exactly as `AgentSidebar` reads it for the
  // badge: this component re-renders on every `byId` change and the row polls every 5s, so the window
  // slides on the poll and a stale reading can only be seconds old.
  const tasks = useMemo(() => groupTasks(Object.values(byId), Date.now()), [byId]);

  // HYDRATE ON MOUNT, THEN KEEP POLLING. The store is a cache and the disk is the truth: the
  // concierge that dispatched a task has usually exited by the time this window paints, so a row
  // that trusted an empty store would report "+0" for work that is running right now. Failures are
  // swallowed inside `refreshResearch` — a cache refresh must not turn a working column into a
  // crashing one.
  //
  // ══ THE POLL LIVES WITH THE ROW, NOT WITH THE CONCIERGE ═══════════════════════════════════════
  //
  // It was in `ConciergeHost` first, which paints no row — and `AgentSidebar` renders this one in
  // windows where no `ConciergeHost` is mounted at all (a torn-off satellite), and in the main
  // window whenever the host unmounts because no project is open. Those windows refreshed once at
  // mount and never again: `+[n]` frozen, a finished task stuck on `running`, indefinitely
  // (roborev 61724). A poll that outlives the thing it feeds is not a poll.
  //
  // ONE PER WINDOW is guaranteed one level up — `Workspace.tsx` passes `showConciergeRow={false}`
  // to all but one sidebar (sparkle-x0pvw), so two columns cannot each start a timer.
  //
  // A poll rather than an event because the runner has no change channel: research completes on a
  // wall clock of minutes, so this cadence is far finer than what it watches, and each tick is one
  // directory read. Same posture as `BEADS_POLL_INTERVAL_MS` — a cache mirroring a file we do not own.
  useEffect(() => {
    void refreshResearch();
    const timer = setInterval(() => {
      void refreshResearch();
    }, RESEARCH_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  // ══ A CLICKED CHAT LINK OPENS THIS GROUP ═══════════════════════════════════════════════════════
  //
  // The concierge names a task it dispatched as a `sparkle-research:` pill (see `ResearchPill`); the
  // founder clicks it, and the ONLY thing that click does is set the store's `openTaskId`. This is
  // the row's half of that gesture: when `openTaskId` points at a task this group actually renders,
  // the group EXPANDS so the row — and, below it, the detail — is on screen. Without this the click
  // would set a field that a collapsed group never reveals, and the link would look dead.
  //
  // ══ AN EDGE, NOT A CONDITION — OR THE HEADER'S COLLAPSE STOPS WORKING (roborev 63900) ══════════
  //
  // Two failure modes bracket this, and keying the reveal on the OPEN-GESTURE SEQ answers both:
  //
  //   • Re-expanding a manually-collapsed group. `openTaskId` is sticky and the effect's `tasks` dep
  //     churns identity on every 5s poll (`replaceAll` rebuilds `byId`), so a condition on the value
  //     re-fires within 5s of every collapse and pops the group back open forever. A poll never calls
  //     `setOpenTask`, so it never bumps the seq — the collapse STAYS made.
  //   • A dead re-click (roborev 63906/63907). If the edge were keyed on `openTaskId`, clicking the
  //     SAME pill after a header collapse would write the id it already holds — no store change, no
  //     re-render, nothing happens, violating `ResearchPill`'s "every click produces a visible
  //     result". `setOpenTask` bumps `openTaskSeq` on every non-null call, so a repeat click is a
  //     genuine new edge; `handledSeq` records the last one handled so only an actual gesture expands.
  const handledSeq = useRef(0);
  useEffect(() => {
    if (openTaskSeq === handledSeq.current) return;
    handledSeq.current = openTaskSeq;
    // Guarded on membership so a stale `openTaskId` (a task since retired, or one this window has not
    // listed) cannot force the group open around nothing. Read from the closure, which is fresh: the
    // seq bump that ran this effect came from the same `setOpenTask` that set `openTaskId`.
    if (openTaskId !== null && tasks.some((t) => t.id === openTaskId)) {
      setExpanded(true);
    }
  }, [openTaskSeq, openTaskId, tasks]);

  const rowBox = rowBoxFor({ paneSide, jointOpen, isActive: false, pinned: true });
  // PER-INSTANCE, not a module constant. A module-level id is emitted once per mounted row, and
  // this component can legitimately mount more than once across windows — a duplicated `id` is
  // invalid HTML and, worse, silently resolves every header's `aria-controls` to the FIRST
  // subtree in the document, so a screen reader following the second row lands on the wrong one
  // (roborev 61699).
  const groupId = useId();

  return (
    <>
      <div
        data-hint={CONCIERGE_AGENTS_HINT}
        // A DISCLOSURE, not a selection — this row claims no pane, because a research task has no
        // pane to claim. `aria-expanded` is therefore the whole of its state, and it is the same
        // attribute a build head carries for its own subtree (AgentRow sets it from
        // `subtreeCollapsed`), so a screen reader hears one vocabulary down the column.
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        aria-controls={tasks.length > 0 ? groupId : undefined}
        onClick={() => setExpanded((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setExpanded((v) => !v);
          }
        }}
        title="Concierge Agents — research tasks the concierge has dispatched"
        style={{
          flex: "0 0 auto",
          position: "relative",
          display: "flex",
          alignItems: "flex-start",
          gap: 8,
          // THE PINNED BOX, unconditional on any selected state — the list-twitch rule in
          // engine/rowGeometry. The trailing 2 is the gap to the row below, matching a list row's.
          margin: `0 ${rowBox.marginRight}px 2px ${rowBox.marginLeft}px`,
          padding: rowBox.padding,
          cursor: "pointer",
          background: "transparent",
          borderRadius: rowBox.borderRadius,
        }}
      >
        <div
          style={{
            flex: "0 0 auto",
            width: DOT_SLOT_W,
            height: GLYPH_SLOT_H,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <StatusDot
            status={status}
            size={DOT_SIZE}
            color={dotColor}
            variant={dotRing ? "ring" : "fill"}
            label={dotLabel}
          />
        </div>
        <div
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            alignItems: "center",
            gap: 8,
            height: GLYPH_SLOT_H,
          }}
        >
          <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 4, minWidth: 0 }}>
            <span
              style={{
                flex: "0 1 auto",
                // A FLOOR, NOT ZERO. Yielding first is right; yielding EVERYTHING is not. With
                // `minWidth: 0` the proportional split takes the title to nothing at narrow widths
                // and the row renders as an anonymous strip of numbers — hard to pick out of a
                // column of rows. See CONCIERGE_TITLE_FLOOR_PX, which is deliberately SMALL: a
                // large floor buys no name the shrink ratio was not already leaving, and costs the
                // counts the pixels they need.
                minWidth: titleFloor,
                // Yields its width to the badge first — see the badge's `flexShrink` note below.
                flexShrink: 100,
                // Neutral, like every other row title in this column.
                color: C.cream,
                fontSize: AGENT_NAME_FONT_SIZE,
                fontWeight: rowTitleWeight(false),
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {CONCIERGE_AGENTS_TITLE}
            </span>
            {/* The collapsed orchestrator's badge, ink for ink — and rendered at ZERO too. See the
                header for why this one does not hide itself. */}
            {hydrated && (
              <span
                aria-label={badgeAria(liveCount, recentCount, queuedCount)}
                title={badgeTitle(liveCount, recentCount, queuedCount)}
                style={{
                  // ══ THE BADGE MUST DEGRADE VISIBLY, NOT BE CLIPPED SILENTLY ═══════════════
                  //
                  // It was `flex: "0 0 auto"` — un-shrinkable — back when it read `+0` and was ~16px
                  // wide. Naming the period made it ~200px, and the Build column DEFAULTS to
                  // `BUILD_COLUMN_DEFAULT_WIDTH` (220) and drags down to 50: after `LIST_PAD_X` ×2,
                  // `DOT_SLOT_W` and the gap, roughly 172px is left for title + badge. An
                  // un-shrinkable badge therefore overflowed the row and was cut by the list's own
                  // `overflowX: "hidden"` — with NO ellipsis, because the clip happened on an
                  // ancestor. What got cut is the TAIL, which is exactly the `in the last hour`
                  // phrase this whole change exists to show. Silently.
                  //
                  // `minWidth: 0` is what makes the shrink actually possible (a flex item's
                  // automatic minimum size is its content, so `flex-shrink` alone does nothing
                  // here), and the ellipsis is what makes the loss legible: a reader who sees `…`
                  // knows to widen the column, where a hard cut just looks like the row's copy.
                  // ── SHRINK ORDER IS EXPLICIT, NOT LEFT TO FLEX-BASIS ──────────────────────
                  // The `1` in this shorthand is the badge's shrink factor, against the title's
                  // `flexShrink: 100` above — do not "tidy" it back to `0 0 auto`. Flex distributes
                  // shrinkage in proportion to each item's base size, so with EQUAL factors the
                  // badge — the LONGER of the two — would give up the most, which is precisely
                  // backwards. The title is the row's identity and can be named from position
                  // alone; the numbers are the reason the row exists and are recoverable no other
                  // way. So the title absorbs essentially all the shrink first, and the badge only
                  // starts losing characters once the title has none left to give.
                  //
                  // ⚠️ THIS DECLARATION RESTATES THE CSS DEFAULT (`0 1 auto`), so NO test can tell
                  // its presence from its absence and mutation-check reports it uncaught — which is
                  // CORRECT here, not a vacuous test. Deleting it does not bring the bug back;
                  // writing `0 0 auto` does. It is kept as an explicit marker of that, since this
                  // span carried exactly that value until the badge outgrew it. The assertion in
                  // the test is therefore on the PROPERTY ("not un-shrinkable"), never on the
                  // declaration — pinning the literal would fail on a harmless deletion. The
                  // neighbouring `minWidth` / `overflow` / `textOverflow` lines are NOT defaults
                  // and are each caught.
                  flex: "0 1 auto",
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  color: C.muted,
                  fontSize: 12,
                  lineHeight: 1,
                }}
              >
                {/* ── WHY A SECOND NUMBER, AND WHY IT IS CONDITIONAL ──────────────────────────
                    `{liveCount} active now` is a live gauge and is rendered even at zero (see the
                    header). That is honest and, alone, unreadable: it falls to `0 active now`
                    minutes after every burst, so "delegating, just finished" and "has never
                    delegated" look identical — and the founder read the second off a row that meant
                    the first, with 28 dispatched tasks on disk.

                    The recent count is SUPPRESSED at zero rather than rendered as `· 0`, which is
                    the opposite of the rule above it and deliberately so: the gauge is a
                    measurement of something that is always measurable, while `· 0` would add a
                    second zero saying the same thing twice. When it is absent, `0 active now` means
                    what it has always meant.

                    ── AND WHY THE WINDOW IS NAMED, NOT IMPLIED ────────────────────────────────
                    It read `· 62 recently` until 2026-08-20, and the founder could not interpret
                    it: *"It'd be helpful to know in what time period."* An hour, a day, or since
                    install all render as "recently", so the number carried no information at all.
                    The phrase comes from `RECENT_RESEARCH_WINDOW_LABEL`, DERIVED from the window
                    the selector enforces — never typed here — so the row cannot come to state a
                    period it is not counting over, which would be strictly worse than the
                    ambiguity it replaced.

                    ── AND WHY A THIRD, IN THE MIDDLE ──────────────────────────────────────────
                    NOW, then WAITING, then ALREADY BEEN THROUGH — the founder's own reading order,
                    and the only one in which `0 active now · 16 queued · 12 in the last hour` is a
                    sentence. The
                    queue segment sits between the two research numbers because it is the thing
                    they are both about: `+0` is how much of that queue is being worked right now
                    and `12 recently` is how much of it has already had a pass.

                    NO DIALECT FOR THE "ALL DISPATCHED, ALL FINISHED, STILL QUEUED" STATE, which is
                    a decision rather than an omission. That state — `queuedCount > 0` with
                    `liveCount === 0` — is the one named in bead `sparkle-zx9knz`, and the three
                    numbers already say it in full: nothing running, sixteen waiting, twelve have
                    been. Wording it as "waiting on the concierge" would additionally claim the
                    queue has STOPPED MOVING, and this row has no evidence for that — a sixteen-deep
                    queue draining one turn at a time is healthy and looks identical from here. The
                    store says so where the evidence actually lives: `oldestAt` exists because *"a
                    count says the queue is deep; only this says it has STOPPED MOVING, which is the
                    actual complaint"* (stores/conciergeQueueStore). A diagnosis on a number that
                    cannot support it is worse than three honest numbers, and a fourth grammar is
                    exactly the per-row dialect SparkleAgentRow's header argues against. */}
                {/* ── THE WORDS SHORTEN WITH THE COLUMN; THE UNIT NEVER DOES ────────────────
                    Shrinking the badge (below) stops it overflowing, but the failure it degrades
                    into is an ELLIPSIS — and what an ellipsis eats first is the TAIL, which is
                    exactly the `in the last hour` phrase. Measured: the full string is 192px and
                    the badge's budget at the default 220px column is ~147px, so the unabbreviated
                    form renders `… 63 in th…` at the width the app BOOTS at.

                    So the phrasing steps down instead — see `conciergeBadgeTier`. Every tier still
                    names the hour; only the words around it shorten. `badgeAria` and `badgeTitle`
                    are NOT on this ladder and always speak the full sentence. */}
                {conciergeLiveLabel(liveCount, tier)}
                {showsQueue(queuedCount) && ` · ${conciergeQueueLabel(queuedCount, tier)}`}
                {recentCount > 0 &&
                  ` · ${conciergeRecentLabel(
                    recentCount,
                    tier,
                    RECENT_RESEARCH_WINDOW_LABEL,
                    RECENT_RESEARCH_WINDOW_SHORT_LABEL,
                  )}`}
              </span>
            )}
          </div>
        </div>
        {/* Empty while unselected — this row is never selected, so this draws nothing today. Kept so
            the anatomy is literally the same call every other row makes, rather than a row that has
            quietly opted out of the shared chrome. */}
        <ActiveFillets ends={rowBox.filletEnds} paneSide={paneSide} />
      </div>

      {/* THE SUBTREE. A `group`, exactly as a build head's workers are, and rendered only when there
          are children — an empty group is something a screen reader announces and then finds
          nothing in. */}
      {expanded && tasks.length > 0 && (
        <div id={groupId} role="group" aria-label={`Agents for ${CONCIERGE_AGENTS_TITLE}`}>
          {tasks.map((task) => (
            <ConciergeTaskRow
              key={task.id}
              task={task}
              selected={openTaskId === task.id && researchActive}
              paneSide={paneSide}
              jointOpen={jointOpen}
            />
          ))}
        </div>
      )}
    </>
  );
});

/**
 * ONE research task, indented under the header exactly as a worker is under its orchestrator.
 *
 * `depthIndent: DEPTH_INDENT` through the SAME `rowBoxFor` a worker row uses, so the task's disc
 * lands on the header's TITLE line — the hanging indent engine/rowGeometry describes — rather than
 * on some second, arbitrary column of this row's own invention.
 *
 * ══ CLICKING SELECTS INTO THE MAIN PANE — NOTHING OPENS INLINE ═════════════════════════════════
 *
 * Founder, 2026-08-17: a research agent should work "exactly like any other worker" — click its
 * name and the RIGHT pane shows what was sent and what is happening, with nothing expanding in the
 * builder column that eats its width. So the click routes to the main pane
 * (`openResearchTaskInPane`), and clicking the row that is already showing closes the pane
 * (`closeResearchPane`) — the same click-again-to-put-away gesture a selected build head uses. The
 * old inline detail below this row is GONE (see `ConciergeResearchPane`).
 */
const ConciergeTaskRow = memo(function ConciergeTaskRow({
  task,
  selected,
  paneSide,
  jointOpen,
}: {
  task: ResearchTask;
  /** Is THIS task the one currently shown in the main pane? Drives the selected fill and the
   *  reveal-scroll. From the parent: `openTaskId === task.id && activeSpecial === "research"`. */
  selected: boolean;
  paneSide: PairSide;
  jointOpen: boolean;
}) {
  const { since, until } = spanOf(task);
  // Ticks only while the task is live: `useRowClock(undefined)` registers nothing at all, so a
  // column of finished tasks costs no timers.
  const clockNow = useRowClock(until === null ? since : undefined);
  const box = rowBoxFor({
    paneSide,
    jointOpen,
    isActive: selected,
    depthIndent: DEPTH_INDENT,
    pinned: true,
  });
  const st = agentStatusForResearch(task.status);
  // IS THIS ROW HISTORY? The one bit `engine/retiredRowTreatment` takes, and the only place this
  // component decides it. Both halves of the treatment below are read from that module rather than
  // branched on here, so the reasoning for the treatment lives with the treatment.
  //
  // NOTE FOR A FUTURE EDITOR: this row is that module's only caller. The build-agent list was going
  // to be the second one and the founder explicitly descoped it — regular build-agent rows are to
  // keep looking exactly as they do today. See that module's header.
  const liveness = livenessOfResearch(task);
  // SELECT INTO THE MAIN PANE, or put it away if it is already the one showing. `closeResearchPane`
  // rather than `setOpenTask(null)` so the pane's active-view flag is cleared too — see
  // services/research/selection.
  const onActivate = useCallback(() => {
    if (selected) closeResearchPane();
    else openResearchTaskInPane(task.id);
  }, [selected, task.id]);

  // BRING THE ROW TO THE FOUNDER when it becomes the selected task — the second half of a chat-link
  // click (the first is `ConciergeAgentsRow` expanding the group). A `sparkle-research:` pill can
  // point at a task far down a long group, so selecting it is not the same as the founder FINDING
  // its row. Optional-called because jsdom does not implement `scrollIntoView`, and `block: "nearest"`
  // so an already-visible row is not yanked. Only fires on the false→true edge.
  const rowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selected) rowRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [selected]);

  return (
    <>
      <div
        ref={rowRef}
        data-hint="concierge-agent"
        data-task-id={task.id}
        role="button"
        tabIndex={0}
        // A SELECTION, not a disclosure: this row no longer opens a subtree, it points the main pane
        // at its task. `aria-pressed` is the toggle-selection state a worker-like row carries.
        aria-pressed={selected}
        onClick={onActivate}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onActivate();
          }
        }}
        title={task.question}
        style={{
          flex: "0 0 auto",
          position: "relative",
          display: "flex",
          alignItems: "flex-start",
          gap: 8,
          margin: `0 ${box.marginRight}px 2px ${box.marginLeft}px`,
          padding: box.padding,
          cursor: "pointer",
          // The build row's selected fill, on the one row here that CAN be selected: the task whose
          // view the founder is reading in the main pane. Same `forest`, same fillets below.
          background: selected ? C.forest : "transparent",
          borderRadius: box.borderRadius,
        }}
      >
        <div
          style={{
            flex: "0 0 auto",
            width: DOT_SLOT_W,
            height: GLYPH_SLOT_H,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {/* HUE says what happened (the existing taxonomy, untouched); FILL says whether it is
              still happening. A retired row is drawn hollow in its own status colour, so a run that
              DIED still reads differently from one that answered — which a flat grey would have
              destroyed. `ring` is unambiguous here because a task row is a LEAF: it owns no children,
              so the variant's other meaning ("a row under this one is in this state") is unreachable.
              See engine/retiredRowTreatment. */}
          <StatusDot
            status={st}
            size={DOT_SIZE}
            variant={dotVariantFor(liveness)}
            label={researchStatusLabel(task.status)}
          />
        </div>
        <div
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            alignItems: "center",
            gap: 8,
            height: GLYPH_SLOT_H,
          }}
        >
          {/* Timer, then title — the collapsed row's strip, element for element. */}
          <ElapsedTimer since={since} now={until ?? clockNow} color={C.muted} />
          <span
            style={{
              flex: "0 1 auto",
              minWidth: 0,
              // The other half of the treatment: an 8px disc is not enough on a column the founder
              // scans at speed, so a retired row's NAME drops to muted too. The live ink is still
              // `C.cream`, passed in rather than read inside the engine so that module stays free of
              // the theme layer (both are CSS custom properties, so light/dark is handled there).
              color: titleInkFor(liveness, C.cream, C.muted),
              fontSize: AGENT_NAME_FONT_SIZE,
              fontWeight: rowTitleWeight(selected),
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {task.question}
          </span>
        </div>
        <ActiveFillets ends={box.filletEnds} paneSide={paneSide} />
      </div>
    </>
  );
});
