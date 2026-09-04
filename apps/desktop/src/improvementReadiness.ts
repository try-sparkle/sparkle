// improvementReadiness — the VERIFICATION half of the founder's never-idle guarantee (bead
// sparkle-hrzitj, P0).
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────────────────
// The founder's standing order: "Neither you nor the Improved Sparkle agent should ever be idle
// unless there are no P0 and P1 items for improved sparkle to make the system better, AND there are
// no unstaffed epics. Period."
//
// Today the idle decision is ultimately trusted from the AGENT'S OWN SELF-REPORT: when the Improve
// Sparkle agent goes quiet the nudge ladder asks it "what is blocking you?", and if it answers
// `blocked-on-human` (`engine/humanBlock.ts`) the app renders it RED and lets it rest — with NOTHING
// checking that claim against the real backlog. An agent that wrongly says `blocked-on-human` while a
// P0 is sitting ready stops the whole loop, silently and indefinitely. `services/improveNudge.ts`
// (the existing never-idle pusher) never consults that self-report at all, and — the gap this module
// closes — it treats EVERY ready bead as work, so it cannot tell "the backlog is genuinely all
// human-gated, resting is correct" apart from "there is real work and the agent is dodging it."
//
// This module is the missing primitive: a PURE classifier that partitions the ready backlog into
// ACTIONABLE vs HUMAN-GATED work, and `isIdleLegitimate`, which answers the founder's question
// directly — idle is legitimate ONLY when there is zero actionable P0/P1 work AND zero unstaffed
// epics. The self-report is then VERIFIED against it rather than trusted: a `blocked-on-human` claim
// standing over an actionable P0 is not a reason to rest, it is a reason to AUTO-RE-ENGAGE.
//
// ── THE DANGEROUS DIRECTION IS FALSE "HUMAN-GATED" ───────────────────────────────────────────────
// A false ACTIONABLE→HUMAN-GATED classification lets the fleet idle against real work, which is the
// exact failure the founder is ending. A false HUMAN-GATED→ACTIONABLE merely spends one more pass on
// a bead that turns out to need a human — cheap and self-correcting. So the human-gated heuristic is
// kept deliberately TIGHT (the explicit label does the real work; the phrase list is a small, high-
// precision backstop) and every ambiguous bead falls to ACTIONABLE. "Err toward working."
//
// PURE. No store, registry, or Tauri reads live here — only data in, decision out — so the whole rule
// tests as arithmetic. The thin, fully-injected orchestrator (`runIdleReEngage`) at the bottom is the
// only stateful part, and its one side effect (starting a pass) is a spy in the wire-in test.

import type { AgentTabStatus } from "./types";
import type { Bead } from "./services/beads";
import { selectNextReadyBead, type NextReadyBead } from "./services/improveNudge";
import type { SparkleImprovementConsent } from "./stores/settingsStore";

/**
 * The label convention that marks a bead as needing a HUMAN before any agent can act on it — an
 * explicit, unambiguous signal a filer (or the founder) can stamp, which is why it is the PRIMARY
 * mechanism and the phrase heuristic below is only a backstop. A bead carrying this label never
 * counts as actionable, so it can never keep the never-idle guarantee from letting the agent rest.
 */
export const HUMAN_GATED_LABEL = "human-gated"; // gate-writer-ok: applied EXTERNALLY via `bd` bead-labeling (a human, or a future retro/pusher mechanism), never by TS app code — so there is no in-code writer by design; the phrase heuristic in isHumanGated is the in-code backstop.

/**
 * The priority bands that gate the founder's rule. bd's `priority` is numeric and ASCENDING — 0 is
 * P0 (most urgent), 1 is P1 — so "P0 and P1 items" is exactly `priority <= P1_PRIORITY`. A bead bd
 * left ungraded (`priority === undefined`) is NOT in this set: the rule names P0/P1 specifically, and
 * an unprioritized or P2-P4 bead does not by itself make idle illegitimate.
 */
export const P1_PRIORITY = 1;

/**
 * A SMALL, HIGH-PRECISION phrase backstop for a bead that is human-gated in substance but was never
 * labelled. Every entry denotes a gate only a HUMAN can lift — a founder decision, or a credential/
 * quota/billing fact no agent can change by editing code. Matched as whole phrases against the
 * lowercased title + description, deliberately NOT bare words: "credential", "token" or "secret"
 * alone appear in ordinary coding beads ("fix credential parsing", "rotate log files"), and matching
 * them would misclassify real work as human-gated — the dangerous direction. Keep this list tight;
 * when in doubt, leave a phrase out and let the bead fall to ACTIONABLE.
 */
export const HUMAN_GATED_PHRASES: readonly string[] = [
  "blocked-on-human",
  "blocked on human",
  "founder must decide",
  "founder must pick",
  "founder to decide",
  "founder decision",
  "awaiting founder",
  "needs founder decision",
  "requires a human decision",
  "human decision needed",
  "expired token",
  "token has expired",
  "rotated credential",
  "rotate the credential",
  "over quota",
  "quota exceeded",
  "account suspended",
  "account is suspended",
  "payment required",
  "billing issue",
];

/**
 * Is this bead HUMAN-GATED — work no agent can start until a person acts? The explicit label is
 * authoritative; the phrase backstop catches an unlabelled but plainly human-gated bead. Reads title
 * and description tolerantly (both optional-ish in hand-built fixtures) and lowercases once.
 */
export function isHumanGated(bead: Pick<Bead, "labels" | "title" | "description">): boolean {
  if (bead.labels.includes(HUMAN_GATED_LABEL)) return true;
  const haystack = `${bead.title ?? ""}\n${bead.description ?? ""}`.toLowerCase();
  return HUMAN_GATED_PHRASES.some((phrase) => haystack.includes(phrase));
}

/** Is this a P0/P1 bead — the priority band the founder's rule names? */
export function isP0OrP1(bead: Pick<Bead, "priority">): boolean {
  return bead.priority !== undefined && bead.priority <= P1_PRIORITY;
}

/**
 * Partition the board's already-filtered READY column (open, unblocked, non-stalled — the same
 * `board.backlog` the pusher's idle count reads) into work the agent can pick up now vs work gated on
 * a human.
 *
 * `actionable` is every ready bead that is NOT human-gated, at any priority — the pull queue.
 * `humanGated` is the rest — the queue to SURFACE rather than work.
 * `actionableP0P1` is the subset of `actionable` that is P0 or P1 — the ONLY thing that bears on the
 * founder's idle rule, split out so `isIdleLegitimate` and the re-engage decision read one field.
 *
 * PURE and non-mutating.
 */
export interface BacklogPartition {
  actionable: Bead[];
  humanGated: Bead[];
  actionableP0P1: Bead[];
}

export function partitionReadyBacklog(readyBeads: readonly Bead[]): BacklogPartition {
  const actionable: Bead[] = [];
  const humanGated: Bead[] = [];
  for (const bead of readyBeads) {
    if (isHumanGated(bead)) humanGated.push(bead);
    else actionable.push(bead);
  }
  return { actionable, humanGated, actionableP0P1: actionable.filter(isP0OrP1) };
}

/**
 * The highest-priority ACTIONABLE ready bead — the concrete item a re-engage should hand over — or
 * `null` when nothing actionable is ready. Reuses `selectNextReadyBead` (bd's own ordering: priority
 * ascending, id as a stable tiebreak) over the non-human-gated subset so the pick can never drift
 * from the pusher's `named-pull` selection, and a human-gated bead can never be handed over as work.
 */
export function selectTopActionableBead(readyBeads: readonly Bead[]): NextReadyBead | null {
  return selectNextReadyBead(partitionReadyBacklog(readyBeads).actionable);
}

/**
 * THE FOUNDER'S RULE, STATED ONCE. Idle is legitimate — the agent may rest — ONLY when there is zero
 * actionable P0/P1 ready work AND zero unstaffed epics. Anything else means there is work the agent
 * is supposed to be doing, so resting (or self-reporting `blocked-on-human`) is not legitimate.
 *
 * `unstaffedEpicCount` is the count of `in_progress` buildable epics with no live orchestrator — the
 * "unstaffed work that is supposed to be actively built" the founder calls a three-alarm fire. It is
 * passed in rather than computed here because the robust liveness join lives in the pusher
 * (`pusherMount.improveUnstaffedEpics`); this module owns only the arithmetic, so both clauses are
 * testable as data. A caller with no reliable unstaffed-epic reading passes 0 and relies on the
 * pusher's existing unstaffed-epic alarm to cover clause B (see the scheduler wiring).
 */
export function isIdleLegitimate(
  readyBeads: readonly Bead[],
  unstaffedEpicCount: number,
): boolean {
  return partitionReadyBacklog(readyBeads).actionableP0P1.length === 0 && unstaffedEpicCount === 0;
}

// ── THE RE-ENGAGE DECISION ───────────────────────────────────────────────────────────────────────

/**
 * The pane statuses that mean "at rest and re-engageable" for the Improve Sparkle agent.
 *
 * `idle`/`unmerged` are the plain resting states (mirrors `improveNudge.RESTING`). `blocked`/`lapsed`
 * are included on PURPOSE and are the crux of this feature: a `blocked` pane is exactly what an agent
 * that answered the nudge ladder with `blocked-on-human` looks like, and letting that self-report
 * stand unverified over an actionable backlog is the failure being corrected. `working` is never
 * re-engageable — the agent is producing output, and a headless pass must not share the worktree with
 * a live turn. `waiting`/`approval`/`questions` are excluded too: a prompt is on screen for the human
 * and starting a pass would step on an in-flight interaction. `undefined` (no reading in this window)
 * is not resting either — the fail-closed direction — UNLESS the self-report says blocked-on-human,
 * which is itself positive evidence the agent has stopped.
 */
export const REENGAGE_RESTING_STATUS: ReadonlySet<AgentTabStatus> = new Set<AgentTabStatus>([
  "idle",
  "unmerged",
  "blocked",
  "lapsed",
]);

/**
 * How often the scheduler may auto-re-engage at most — the existing tick cadence. The brief's rule is
 * "never re-engage more often than the existing tick cadence; don't spam", and the scheduler ticks
 * every `IMPROVEMENT_TICK_MS` (5 min), so a per-tick check with this cooldown fires at most once a
 * tick. In practice the `passRunning` latch bounds it far harder (a running pass holds for up to 30
 * min), so this only governs the gap BETWEEN passes.
 */
export const REENGAGE_COOLDOWN_MS = 5 * 60 * 1000;

/** Everything the re-engage decision reads. Pure inputs so the rule tests as arithmetic. */
export interface ReEngageInput {
  /** Improvement consent. `"never"` (chat-only) bars re-engage — the agent must not be told to mine
   *  backlog. Read, never changed. */
  consent: SparkleImprovementConsent;
  /** The agent's live pane status, or `undefined` when this window has no reading. */
  paneStatus: AgentTabStatus | undefined;
  /** Did the agent SELF-REPORT `blocked-on-human` (`humanBlockFor(id) !== undefined`)? The exact
   *  claim the founder distrusts; here it is a signal to VERIFY, never to obey. */
  selfReportedBlockedOnHuman: boolean;
  /** A pass is already in flight (the module latch in `services/improvementPass`). */
  passRunning: boolean;
  /** A connectivity re-attempt is armed for the hourly slot (`passRetryDueAt() !== null`). When set,
   *  the hourly mechanism owns the next run and re-engage stands down, so it never disarms or races
   *  that latch (roborev 68224 is the mirror hazard on the drain path). */
  retryArmed: boolean;
  /** The app's connectivity verdict (`connectionStore.isOnline`). A pass needs the network from its
   *  first step, so re-engaging while offline buys a guaranteed failure that costs a cooldown for
   *  nothing — the same reason the hourly gate holds on `offline`. Stand down and let the slot start
   *  the pass once the network is back. */
  online: boolean;
  /** Was the beads board readable at all this tick? `false` means `readyBeads` is NOT evidence of an
   *  empty backlog — an unreadable board must never be read as "nothing to do" (bead sparkle-hrzitj).
   *  Re-engage stands down when the board is unreadable: it cannot name an actionable item, and the
   *  pusher's own board-unreadable nudge already covers telling the agent to read it directly. */
  boardReadable: boolean;
  /** The board's ready column. Meaningful only when `boardReadable`. */
  readyBeads: readonly Bead[];
  /** Count of unstaffed buildable epics — clause B of the founder's rule. See `isIdleLegitimate`. */
  unstaffedEpicCount: number;
  /** When re-engage last fired, or `null` if never. Window-local, forgotten on reload. */
  lastReEngageAt: number | null;
  now: number;
  cooldownMs: number;
}

export type ReEngageRefusal =
  /** Consent is `never` — chat-only, may not be told to mine backlog. */
  | "consent-never"
  /** The agent is not at rest (working, or a prompt is on screen) — nothing to re-engage. */
  | "not-resting"
  /** A pass is already running — re-engaging would either no-op on the latch or double-run. */
  | "already-running"
  /** A connectivity retry is armed; the hourly mechanism owns the next run. */
  | "retry-armed"
  /** Known-offline — a pass would fail from its first networked step. */
  | "offline"
  /** The board could not be read this tick — no basis to name an actionable item. */
  | "board-unreadable"
  /** Idle IS legitimate — zero actionable P0/P1 AND zero unstaffed epics. Resting is correct. */
  | "idle-legitimate"
  /** Re-engaged within the cooldown — give the started pass room before firing again. */
  | "rate-limited";

export type ReEngageDecision =
  | { reEngage: true; focus: NextReadyBead | null; actionableP0P1Count: number; unstaffedEpicCount: number }
  | { reEngage: false; reason: ReEngageRefusal };

/**
 * Should the scheduler auto-re-engage the idle Improve Sparkle agent right now? PURE. Refuses toward
 * standing down at every step, each with a distinct reason, in the order below:
 *
 *   1. `consent-never`    — chat-only mode may not be told to mine backlog.
 *   2. `not-resting`      — the agent is working, or a prompt is on screen; there is nothing to re-engage.
 *                           `blocked`/`lapsed`, and ANY status when the agent self-reported
 *                           `blocked-on-human`, DO count as re-engageable — that is the whole point.
 *   3. `already-running`  — a pass is in flight.
 *   4. `retry-armed`      — the hourly slot's connectivity re-attempt is armed; defer to it.
 *   5. `offline`          — a pass would fail from its first networked step; hold the slot.
 *   6. `board-unreadable` — no reading, so no actionable item to name (the pusher covers the nudge).
 *   7. `idle-legitimate`  — zero actionable P0/P1 AND zero unstaffed epics; resting is correct.
 *   8. `rate-limited`     — fired within the cooldown.
 *
 * On a re-engage verdict it carries the top actionable bead (for a legible log / a future named
 * hand-off) plus the two counts behind the verdict. `focus` may be `null` when the illegitimacy is
 * carried by unstaffed epics alone with no actionable ready bead — the caller still re-engages (a
 * discovery pass finds and staffs the work); the field is `null` because there is no single item to
 * name, never because there is nothing to do.
 */
export function decideReEngage(input: ReEngageInput): ReEngageDecision {
  if (input.consent === "never") return { reEngage: false, reason: "consent-never" };
  // At rest AND re-engageable. `working` is never eligible; a self-reported blocked-on-human makes
  // any non-working status eligible, because the claim itself is evidence the agent has stopped and
  // is exactly what must be verified against the backlog rather than obeyed.
  const resting =
    input.paneStatus !== "working" &&
    (input.selfReportedBlockedOnHuman ||
      (input.paneStatus !== undefined && REENGAGE_RESTING_STATUS.has(input.paneStatus)));
  if (!resting) return { reEngage: false, reason: "not-resting" };
  if (input.passRunning) return { reEngage: false, reason: "already-running" };
  if (input.retryArmed) return { reEngage: false, reason: "retry-armed" };
  // Known-offline: hold rather than spend a pass on a guaranteed connectivity failure — the same
  // stand-down the hourly gate makes. The slot starts the pass once the network returns.
  if (!input.online) return { reEngage: false, reason: "offline" };
  // An unreadable board is not an empty one (bead sparkle-hrzitj). With no reading there is no
  // actionable item to name and no basis to assert idle is legitimate; stand down here and let the
  // pusher's board-unreadable nudge tell the agent to read the backlog directly.
  if (!input.boardReadable) return { reEngage: false, reason: "board-unreadable" };
  if (isIdleLegitimate(input.readyBeads, input.unstaffedEpicCount)) {
    return { reEngage: false, reason: "idle-legitimate" };
  }
  if (input.lastReEngageAt !== null && input.now - input.lastReEngageAt < input.cooldownMs) {
    return { reEngage: false, reason: "rate-limited" };
  }
  const partition = partitionReadyBacklog(input.readyBeads);
  return {
    reEngage: true,
    focus: selectNextReadyBead(partition.actionable),
    actionableP0P1Count: partition.actionableP0P1.length,
    unstaffedEpicCount: input.unstaffedEpicCount,
  };
}

// ── THE THIN ORCHESTRATOR ────────────────────────────────────────────────────────────────────────

/** When re-engage last fired in THIS window. Module-level for the same reason as the pass latches it
 *  sits beside: it is this webview's running state, and a reload should forget it. */
let lastReEngageAt: number | null = null;

/** Read the last-re-engage clock without disturbing it (for a surface that renders the hold). */
export function lastReEngageAtValue(): number | null {
  return lastReEngageAt;
}

/** Test seam: forget the last-re-engage clock, as a fresh webview would. */
export function resetReEngageForTests(): void {
  lastReEngageAt = null;
}

/** What the orchestrator gathers from the live app. Every field is a getter so the orchestrator stays
 *  pure of store reads and the whole thing tests with plain spies. */
export interface ReEngageDeps {
  now(): number;
  consent(): SparkleImprovementConsent;
  paneStatus(): AgentTabStatus | undefined;
  selfReportedBlockedOnHuman(): boolean;
  passRunning(): boolean;
  retryArmed(): boolean;
  online(): boolean;
  /** The board reading: whether it was readable at all, and its ready column. */
  readyBacklog(): { boardReadable: boolean; readyBeads: readonly Bead[] };
  unstaffedEpicCount(): number;
  /** Start a pass. The side effect under test — the scheduler wires this to `runImprovementPass`. */
  reEngage(focus: NextReadyBead | null): void;
}

/**
 * The scheduler's per-tick never-idle step: gather, decide, and — only on a re-engage verdict — start
 * a pass and stamp the cooldown clock. Returns the decision so the scheduler can log it and a test can
 * assert it. The cooldown is stamped ONLY on an actual re-engage, so a run of stand-downs never
 * advances it and the first genuine idle-with-work fires immediately.
 */
export function runIdleReEngage(deps: ReEngageDeps): ReEngageDecision {
  const backlog = deps.readyBacklog();
  const decision = decideReEngage({
    consent: deps.consent(),
    paneStatus: deps.paneStatus(),
    selfReportedBlockedOnHuman: deps.selfReportedBlockedOnHuman(),
    passRunning: deps.passRunning(),
    retryArmed: deps.retryArmed(),
    online: deps.online(),
    boardReadable: backlog.boardReadable,
    readyBeads: backlog.readyBeads,
    unstaffedEpicCount: deps.unstaffedEpicCount(),
    lastReEngageAt,
    now: deps.now(),
    cooldownMs: REENGAGE_COOLDOWN_MS,
  });
  if (decision.reEngage) {
    lastReEngageAt = deps.now();
    deps.reEngage(decision.focus);
  }
  return decision;
}
