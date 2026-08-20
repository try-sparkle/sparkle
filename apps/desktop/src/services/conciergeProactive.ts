// THE PROACTIVE PUSH CHANNEL — the trigger, the cost controls, and the staleness rule
// (PRD/sparkle/concierge-proactive-push.md; the gap is recorded in PRD/sparkle/concierge-mode.md §2a).
//
// §2a records this as a BLOCKING architectural gap, not a feature: "the brain has no channel to
// author a proactive thread message. Today nudges are derived frontend-side … while concierge.rs /
// services/concierge.ts only run a turn in response to onSend. 'Aggregation belongs to the brain' is
// therefore not buildable as written." The founder's goal (2026-07-27) is that column one tells him
// when agents need something instead of him polling the columns.
//
// This module is the TRIGGER half. The transport half is `concierge_proactive_turn` in
// src-tauri/src/concierge.rs, which reuses the existing delta/done/error stream under the same
// monotonic turn token — there is no second event channel. The MOUNT is in
// components/ConciergeHost: it feeds this scheduler the roster, records each push's digest against
// its turn id, renders the reply as a push rather than a reply, and runs `markStaleProactive` on
// every tick. All three halves have to ship together — a trigger with no mount spends nothing, and
// a transport with no mount produces an unretractable "You have 3 P1s" (roborev 54166-M5).
//
// PURE CORE, INJECTED EDGES. `significantDigest` / `accountedNeedsYou` / `buildProactivePrompt` /
// `markStaleProactive` are data-in-data-out, and the scheduler takes its clock, its timers and its
// "start a turn" effect as dependencies — so every rate-limiting rule below is tested as arithmetic
// rather than by waiting two real minutes.
//
// WHY A DIGEST AND NOT A TICK. The Rust roster aggregator broadcasts `roster://changed` on every
// window publish — every 250ms in practice (useRosterPublisher). Running a Claude turn on that is
// ~14,400 turns an hour. So the scheduler fires on a CHANGE in a small digest of the state that
// actually matters, never on a tick, and never on movement that is only a timestamp.
import { bandCountLabel } from "../engine/statusBandLabels";
import { rosterLine } from "../engine/conciergeRosterLine";
import { withResearchPreamble, type ResearchStaging } from "./research/drain";
import { isTerminal, type ResearchTask } from "./research/types";
import { withMemoryPreamble } from "../stores/conciergeMemoryStore";
import type { ConciergeMessage } from "../components/Concierge/types";
import type { ConciergeAgent, ConciergeFeed } from "./conciergeFeed";

/**
 * How long a change is allowed to settle before the brain speaks about it.
 *
 * COALESCING, NOT DEBOUNCING, and the difference is load-bearing on a busy fleet. A true debounce
 * restarts its wait on every new change, so a fleet whose digest moves every couple of seconds —
 * i.e. exactly the fleet worth talking about — would never reach a quiet moment and the founder
 * would never hear anything. This window instead opens at the FIRST change and closes on schedule,
 * carrying whatever the state has become by then: at most this long after something starts needing
 * him, he is told, and he is told about the latest state rather than the one that opened the window.
 */
export const PROACTIVE_COALESCE_MS = 4_000;

/** The floor between two proactive turns. Nothing the concierge could say is worth interrupting for
 *  twice inside this, and every turn is real money and real context. */
export const PROACTIVE_MIN_INTERVAL_MS = 2 * 60_000;

/** The hard ceiling: at most this many proactive turns in any rolling hour, whatever happens.
 *  Six is roughly "once every ten minutes at worst" — a chief of staff, not a pager. */
export const PROACTIVE_MAX_PER_HOUR = 6;

/** The window {@link PROACTIVE_MAX_PER_HOUR} is counted over. */
const HOUR_MS = 60 * 60_000;

/** Why a change did NOT buy a turn. Counted, because "how much did the concierge decide not to
 *  spend" is as much a part of the cost story as what it did spend.
 *
 *  `same-surface` is churn the push could not have mentioned; `declined` is a turn that was asked
 *  for and never ran (the user owns the conversation, or the bridge failed) — the one reason that
 *  leaves the change still owed to the founder rather than settled. */
export type ProactiveSkipReason =
  | "unchanged"
  | "same-surface"
  | "calm"
  | "min-interval"
  | "hourly-cap"
  | "declined";

export interface ProactiveStats {
  /** Turns actually started. */
  fired: number;
  skipped: Record<ProactiveSkipReason, number>;
  /**
   * Findings delivered on a turn THE USER STARTED — see {@link ProactiveScheduler.claimNotices}.
   *
   * Counted separately from `fired` and deliberately NOT charged to the hourly cap: that budget
   * bounds interruptions, and a finding riding a turn the founder asked for interrupts nobody. A
   * rising number here against a flat `fired` is the channel working as intended on a busy queue.
   */
  noticesRidden: number;
  /**
   * Turns bought by RESEARCH COMING BACK — see {@link ProactiveScheduler.observeResearch}.
   *
   * Counted separately from `fired` for the same reason `noticesRidden` is, and it is the number
   * that makes the two-budget claim auditable rather than merely asserted: this rising while
   * `fired` stays flat is research reaching the founder without having spent a fleet slot. If the
   * two are ever seen moving together one-for-one, the tracks have been re-merged and §3.3's
   * starvation objection is live again.
   */
  researchFired: number;
}

/** The edges: a clock, a timer, and the effect that actually spends money. */
export interface ProactiveDeps {
  now(): number;
  setTimer(fn: () => void, ms: number): number;
  clearTimer(handle: number): void;
  /**
   * THE RESEARCH DRAIN'S SECOND SEAM (bead `sparkle-s7rfc`, §3.3 of the reporting-channel PRD).
   *
   * Returns the unread research findings to fold into this turn's prompt, and the ids they came
   * from. Optional: a scheduler wired without it behaves exactly as before.
   *
   * IT CAN NOW BE THE REASON A TURN HAPPENS — but only via {@link ProactiveScheduler.observeResearch},
   * never via this method, and the distinction is the whole safety argument. This is still consulted
   * strictly AFTER `fire` has decided there is something to say, so a peek can never be what decides
   * it; the decision is taken from the store snapshot the host feeds in. What changed (bead
   * sparkle-wo4c79) is that "an answer he is waiting on" joined the list of things worth saying, on
   * a budget of its own — see `observeResearch` for why that answers §3.3 rather than overriding it.
   *
   * The old rule read "IT IS ONLY EVER CALLED FOR A TURN THAT IS ALREADY HAPPENING", and the cost of
   * it was measured: research finished, nothing bought a turn, and the founder had to ask for an
   * answer he had already commissioned.
   *
   * PEEKING CLAIMS NOTHING. The ids travel to {@link startTurn}, which stages them against the turn
   * id it gets back; the claim happens only once that turn delivers. See services/research/drain.
   */
  peekResearch?(): ResearchStaging;
  /**
   * The memory re-grounding preamble for this turn (`""` when nothing is saved), read from the same
   * cache the user-turn seam reads (stores/conciergeMemoryStore). Present so an UNPROMPTED turn also
   * carries the WHAT YOU'VE REMEMBERED section — the persona tells the model its memories are folded
   * in automatically, and a proactive turn is precisely where re-grounding matters most (no human
   * message re-supplies context). Pure string; claims nothing, so unlike research it needs no staging.
   */
  peekMemoryPreamble?(): string;
  /**
   * Start one proactive turn. `digest` is the state it is being authored against — the caller
   * records it against the turn id so the resulting message can be marked stale later.
   *
   * `researchTaskIds` names the findings this prompt is carrying (empty when none). The caller
   * stages them against the turn id the transport returns — a decline stages nothing, so an
   * undelivered finding stays unread and rides the next turn instead.
   *
   * RETURNS WHETHER A TURN ACTUALLY STARTED, and that answer is load-bearing (roborev 54166-M2).
   * `concierge_proactive_turn` stands down for any user turn — in flight or merely preparing — and
   * the frontend transport resolves null on every other failure too. This channel exists to report
   * a change the founder is not looking at; if "asked" counted as "delivered", the expected outcome
   * of a push landing while he is typing would be the change being swallowed forever (the baseline
   * moves, the message never arrives) AND one of the six hourly slots being spent on nothing.
   *
   * `boolean | Promise<boolean>` rather than plain `Promise<boolean>` so a synchronous edge settles
   * synchronously — the scheduler is otherwise perfectly deterministic, and a mandatory microtask
   * would make every caller's ordering depend on the event loop.
   */
  startTurn(
    prompt: string,
    digest: string,
    researchTaskIds: readonly string[],
  ): boolean | Promise<boolean>;
}

export interface ProactiveScheduler {
  /** Feed one roster observation in. Cheap: the common case is a string compare. */
  observe(feed: ConciergeFeed): void;
  /**
   * Feed the research store in. THE THIRD REASON TO SPEAK, and the one §3.3 originally declined.
   *
   * WHY THIS REVERSES §3.3, AND WHY THAT IS NOT A CLIMBDOWN. §3.3 chose "drain at turn start, no
   * interrupt" and rejected a push per finding for ONE stated reason: it "would spend the SHARED
   * 6/hour ceiling on routine results", rate-limiting out a genuine blocker at minute 40. That
   * objection is about CONTENTION, not about interrupting — and it is answered here by removing the
   * sharing rather than by overriding it. A turn bought by research spends neither
   * {@link PROACTIVE_MAX_PER_HOUR} nor {@link PROACTIVE_MIN_INTERVAL_MS}; it cannot displace a
   * blocker, and a noisy fleet cannot displace it. `claimNotices` already sets this precedent for
   * the same reason ("the hourly cap bounds INTERRUPTIONS").
   *
   * The other half of §3.3 was a latency estimate that did not hold. It accepted the design because
   * worst case became "until the founder next speaks — minutes — versus today's forever". The
   * founder hit the forever branch: two runs finished, one of them FAILED with "the Claude CLI is
   * not signed in", and he learned nothing until he thought to ask. "He speaks again soon" is not
   * reliable when the thing he would speak about is the answer he is waiting on.
   *
   * A FINISHED ANSWER IS NOT AN INTERRUPTION. Everything the ceiling protects against is the app
   * volunteering something unbidden; this is a reply to a question he asked. It is also incapable
   * of the runaway the limiter exists to stop — the trigger is the roster republishing every 250ms
   * (~14,400 turns/hour if ungated), whereas research completions are bounded by what he dispatched
   * and each one costs minutes of a real `claude` run.
   *
   * CANCELLED TASKS DO NOT WAKE HIM. They are terminal and owed, and they still ride a turn bought
   * by something else, but he cancelled them — a turn whose entire content is news he created is
   * the spam this channel must not produce.
   */
  observeResearch(tasks: readonly ResearchTask[]): void;
  /**
   * Hand the concierge something the Pusher measured that no roster digest would ever show.
   *
   * Subject to every cost control `observe` is — the coalescing window, the two-minute floor, the
   * six-an-hour cap — because a finding is an interruption exactly like a push is. What it is NOT
   * subject to is the digest: a notice speaks on its own, which is the whole reason it exists.
   *
   * IDEMPOTENT ON TEXT — PER KIND. The Pusher re-measures the same fleet every sweep, so the
   * identical sentence arrives repeatedly while the condition holds; re-sending it is a no-op until
   * the one that is already owed has been delivered. Two notices of DIFFERENT kinds carrying the
   * same text are NOT duplicates: "Kraken Auth was retired" owed as a live thing to act on and as a
   * report of something already done are opposite statements, and collapsing them would silently
   * drop whichever arrived second — the concealment {@link PENDING_NOTICE_HARD_CAP} exists to
   * refuse at the door rather than commit quietly.
   *
   * `kind` DEFAULTS TO `"pusher"`, so every caller written before reports existed keeps its exact
   * behaviour with no edit. That is not merely convenience: `conciergeNotifier`'s registered sink is
   * typed `(text: string) => boolean`, and a required second parameter would have made this method
   * unassignable to it — the change had to be additive at the call sites to stay inside one seam.
   *
   * RETURNS WHETHER THE FINDING IS NOW OWED — i.e. whether it will reach a prompt. This used to
   * return `void`, and the caller chain assumed that meant success: `notifyConcierge` did
   * `fn(text); return true;`, `pusherMount.sendVerified` handed that `true` back, and
   * `pusherRunner` took its `delivered` branch — recording outcome "sent", spending a rate-budget
   * slot, and stamping the condition as reported for a four-hour cooldown. So on every path that
   * silently refused the text, the finding was destroyed AND suppressed at source for four hours.
   * `false` here is the caller's instruction to keep it owed and offer it again next sweep.
   */
  notify(text: string, kind?: NoticeKind): boolean;
  /**
   * What is owed right now, for a turn THE USER IS ABOUT TO START. CLAIMS NOTHING.
   *
   * ── WHY THIS SEAM HAD TO EXIST: THE CHANNEL IS SELF-DEFEATING WITHOUT IT ───────────────────────
   * Two rules this module already holds, put side by side:
   *
   *   • {@link ProactiveDeps.startTurn} stands down for any user turn — in flight or merely
   *     preparing. That is correct: the user owns the conversation.
   *   • A NON-EMPTY CONCIERGE QUEUE MEANS A USER TURN IS ALWAYS IN FLIGHT. Not a coincidence —
   *     `engine/conciergeTurnQueue.enqueue`'s own invariant: a send WAITS only when something is
   *     already running, so `waiting > 0` implies a running turn, continuously, until it drains.
   *
   * So a finding about a stacked-up queue is declined for exactly as long as the finding is true.
   * Worse than a delay: {@link notify} answers `true` (it really is owed), `conciergeNotifier` and
   * `pusherMount.sendVerified` pass that through, and `pusherRunner` takes its `delivered` branch —
   * spending one of four hourly slots and stamping the condition as reported for FOUR HOURS. The
   * message arrives, if ever, about a backlog long since drained.
   *
   * Folding it into a turn that is GUARANTEED to run removes the contradiction without touching the
   * stand-down, which is the rule that should not move. Same shape as `research/drain.peek`, and
   * the same reason for the peek/claim split: a turn can be superseded, cancelled or killed after
   * its prompt was built, and a finding claimed at build time would be gone with no residue.
   *
   * IDLE-SAFE: this arms nothing and spends nothing. It is called on every user turn, which on a
   * busy queue is continuous — a version that re-armed would pump the very channel it relieves.
   *
   * RETURNS THE OWED OBJECTS, NOT THEIR TEXT, and the caller renders them with
   * {@link buildNoticeSection}. Two reasons, both structural rather than stylistic: a
   * {@link NoticeKind} is an INSTRUCTION whose preamble the reader needs (see `NOTICE_SHAPE`), so
   * text alone would deliver a finding stripped of what to do about it; and {@link claimNotices}
   * matches by OBJECT identity, so handing back strings would make two same-sentence notices of
   * different kinds indistinguishable — delivering one would silently clear the other.
   */
  peekNotices(): readonly PendingNotice[];
  /**
   * The turn carrying `notices` INSTALLED. Clear them.
   *
   * Called once `invoke("concierge_turn")` has resolved a real turn id, beside
   * `researchDrain.stage` — deliberately EARLIER than the drain's own claim, which waits for
   * `concierge:done`. The two inputs differ in what a loss costs: a research finding exists once, on
   * disk, and is unrecoverable if claimed against a turn that dies. A Pusher notice is RE-MEASURED
   * every sweep and re-offered by an idempotent {@link notify}, so the worst case of claiming at
   * install is that a condition which still holds is mentioned one turn later.
   *
   * Removes BY IDENTITY, never by truncation — the rule `settle`'s delivered branch already
   * follows, so a finding that arrived while the turn was being built is still owed afterwards.
   */
  claimNotices(notices: readonly PendingNotice[]): void;
  /** Stop scheduling and drop any armed timer. */
  dispose(): void;
  stats(): ProactiveStats;
}

/**
 * How the Pusher's findings are introduced to the concierge.
 *
 * Written as an INSTRUCTION rather than as a status line, because the failure being fixed is a
 * concierge that reads something and does nothing. `pusherBlocker.routeBlocker` has already decided
 * that each of these is a thing only the concierge can act on before it ever gets here — so the
 * prompt says act, and names the escalation path for the one case where it genuinely cannot.
 */
export const PUSHER_NOTICE_PREAMBLE =
  "The Pusher measured these and they are yours to act on — the agents involved cannot. " +
  "Act on each one now (read the job, arbitrate, restart, or say the one thing the founder has to " +
  "decide); do not simply relay them to him.\n";

/**
 * WHICH KIND OF OWED NOTICE THIS IS — and the two are opposite instructions, which is the only
 * reason the channel needed a second one at all.
 *
 * `pusher` is the original: a condition that is STILL TRUE and that only the concierge can move, so
 * {@link PUSHER_NOTICE_PREAMBLE} says act and says outright "do not simply relay them to him".
 *
 * `report` is the inverse: something that ALREADY HAPPENED, unattended, while the founder was away —
 * `retire_agent` retiring finished agents overnight is the producer this was built for. There is
 * nothing left to act on, so relaying it plainly IS the deliverable. Handed to the `pusher` preamble
 * a report becomes an instruction to re-do work that is already done, or to arbitrate a state that no
 * longer exists; handed to the `report` preamble a live blocker becomes a status line nobody acts on.
 * Neither preamble can carry the other's notices, which is why the kind travels with the text rather
 * than being guessed from it.
 */
export type NoticeKind = "pusher" | "report";

/** One owed notice: what to say, and which of the two instructions it must be said under. */
export interface PendingNotice {
  kind: NoticeKind;
  text: string;
}

/**
 * How a REPORT is introduced to the concierge — the mirror of {@link PUSHER_NOTICE_PREAMBLE}, and
 * deliberately its opposite in the one respect that matters.
 *
 * Written as an instruction for the same reason that one is, and pointed the other way: the failure
 * mode here is not a concierge that reads something and does nothing, it is a concierge that reads a
 * finished action and tries to act on it — restarting an agent it retired an hour ago, or asking the
 * founder to decide something that is already decided. The founder asked to be TOLD what happened
 * while he was away; for these, telling him is the whole job.
 *
 * It still says "every one of them", because the disclosure rule in {@link buildNoticeSection}
 * applies to a report exactly as it does to a finding: a summary that quietly names fewer than
 * arrived is the same concealment whatever tense it is written in.
 */
export const REPORT_NOTICE_PREAMBLE =
  "These already HAPPENED while the founder was away — they are a report, not work. Nothing below " +
  "is yours to act on and none of it needs a decision; do not re-do, undo, or ask about any of it. " +
  "Relay them to him plainly, in his words, and account for every one.\n";

/**
 * A READABILITY THRESHOLD, NOT A DROP THRESHOLD — and the difference is the whole of bead
 * sparkle-qogah.
 *
 * ── WHAT THIS USED TO BE, AND WHY IT WAS THE BUG ─────────────────────────────────────────────────
 * This was the length `notify` truncated the owed list to, with `pendingNotices.shift()` discarding
 * the OLDEST finding: no record, no count, no retry, no residue of any kind. That is the founder's
 * P0 rule inverted at its sharpest point. The preamble directly above literally says these are "yours
 * to act on… Act on each one now" — they are the most explicitly actionable items this app produces,
 * and the ninth one to arrive was destroyed in silence.
 *
 * It compounded, too. `notify` returned `void`, so `notifyConcierge` reported the destroyed finding
 * as DELIVERED, and `pusherRunner` then stamped its condition as reported for a four-hour cooldown
 * and spent a rate-budget slot on it. The finding was not merely dropped; it was suppressed at
 * source for four hours by the act of dropping it.
 *
 * Every sibling cap in this codebase announces its drops — `stores/conciergeApprovals` announces
 * expiry, `engine/conciergeTurnQueue` returns `dropped`, `services/pendingSends` calls `onPruned`.
 * This one alone was silent.
 *
 * ── WHAT IT IS NOW ───────────────────────────────────────────────────────────────────────────────
 * Nothing owed is discarded. Past this count the prompt CHANGES SHAPE rather than losing entries: it
 * states how many there are and says outright that none was withheld, then names every one. A long
 * prompt is the "the surface got tall" argument, and height is never a reason to conceal work the
 * founder owes — scroll it, do not hide it. See {@link buildNoticeSection}.
 */
export const MAX_PENDING_NOTICES = 8;

/**
 * The one hard ceiling on the owed list, and it REFUSES THE NEWCOMER rather than destroying
 * something already owed.
 *
 * This is a memory backstop, not a concealment. Findings are deduplicated on exact text and cleared
 * on delivery, so a real fleet never approaches it; what it bounds is the degenerate case where a
 * transport declines for hours while the Pusher keeps minting text that differs by a digit ("walled
 * for 3h07m", "walled for 3h08m") — an unbounded list held by a scheduler that lives as long as the
 * window.
 *
 * THE DIRECTION OF THE REFUSAL IS THE POINT. Dropping the oldest destroys a finding whose condition
 * the Pusher has already stamped as reported — gone, with no retry. Refusing the newest returns
 * `false` to the caller, so `pusherRunner` takes its `transport-failed` branch: no cooldown stamped,
 * no budget slot spent, and the finding is re-offered on the very next sweep. Nothing is lost either
 * way round, and only one of the two is honest about it.
 *
 * Deliberately far above any real count: reaching it at all is a signal that something upstream is
 * malfunctioning, and it should not be reachable by an ordinarily busy fleet.
 */
export const PENDING_NOTICE_HARD_CAP = 200;

/**
 * Render the owed findings into the half of the prompt that carries them. EVERY finding is named,
 * however many there are.
 *
 * The old readability worry was real and is answered here rather than by dropping: a concierge handed
 * thirty bare bullets acts on none of them, so past {@link MAX_PENDING_NOTICES} the list gets a
 * header that states the count, says explicitly that nothing was withheld, and asks for triage. That
 * turns "a wall of text" into "a long list with instructions", which is a readability problem the
 * model can actually solve — unlike the previous answer, which solved it by destroying the evidence.
 *
 * The "none has been withheld" sentence is an assertion this function has to keep true. If a future
 * change ever does withhold something here, that sentence must become an exact count of what was
 * withheld and why — a cap without a disclosure is the bug this function was written to remove.
 *
 * ── TWO KINDS, TWO SECTIONS, TWO COUNTS ─────────────────────────────────────────────────────────
 * A {@link NoticeKind} is an INSTRUCTION, not a label, and the two instructions contradict each
 * other — so the kinds cannot share a section, and a single preamble over a mixed list would tell
 * the concierge to act on things that are already finished (or to merely relay a live blocker).
 * Each kind present renders its own section under its own preamble, carrying EVERY one of its own
 * notices; one kind present renders one section; an empty list renders "".
 *
 * AND THE COUNT IS PER SECTION, which is what keeps the disclosure honest once the list is split.
 * "All 9 are listed below" printed over a section holding 3 of the 9 would be the withholding
 * sentence this function exists to prevent, wearing the disclosure's own clothes: the reader would
 * take the six that are under the OTHER preamble as missing. So each section states the number it
 * actually contains, and the readability threshold is applied to that number too — a section is long
 * or short on its own terms.
 */
export function buildNoticeSection(notices: readonly PendingNotice[]): string {
  if (notices.length === 0) return "";
  // ORDERED, NOT GROUPED-AS-ENCOUNTERED: the work comes before the report, always. `pusher` notices
  // are the ones with something still to do, and a concierge that reads an overnight report first
  // has already spent its attention by the time it reaches the blocker.
  return NOTICE_ORDER.map((kind) => renderNoticeKind(kind, notices.filter((n) => n.kind === kind)))
    .filter((section) => section !== "")
    .join("\n\n");
}

/** The order the sections appear in. See {@link buildNoticeSection}. */
const NOTICE_ORDER: readonly NoticeKind[] = ["pusher", "report"];

/**
 * The preamble each kind is introduced by, and the sentence that carries a long list of it.
 *
 * The overflow sentence differs per kind for the same reason the preamble does — "act on what you
 * can" is meaningless over a list of finished actions — but BOTH keep the count and the words "none
 * has been withheld" verbatim, because that half is the disclosure rule rather than the instruction,
 * and it is not the kind's to vary.
 */
const NOTICE_SHAPE: Record<NoticeKind, { preamble: string; overflow: (n: number) => string }> = {
  pusher: {
    preamble: PUSHER_NOTICE_PREAMBLE,
    overflow: (n) =>
      `There are ${n} of them — more than usual. All ${n} are listed below; none has been ` +
      "withheld. Work the list: act on what you can, group what is the same underlying problem, " +
      "and name plainly the ones you cannot move.\n",
  },
  report: {
    preamble: REPORT_NOTICE_PREAMBLE,
    overflow: (n) =>
      `There are ${n} of them — more than usual. All ${n} are listed below; none has been ` +
      "withheld. Group what is the same kind of thing so the account is readable, but the total " +
      `you give him has to be ${n} — a summary that names fewer is one he cannot check.\n`,
  },
};

/** One kind's section, or "" when nothing of that kind is owed. */
function renderNoticeKind(kind: NoticeKind, notices: readonly PendingNotice[]): string {
  if (notices.length === 0) return "";
  const { preamble, overflow } = NOTICE_SHAPE[kind];
  const body = notices.map((n) => `• ${n.text}`).join("\n");
  if (notices.length <= MAX_PENDING_NOTICES) return preamble + body;
  return preamble + overflow(notices.length) + body;
}

/**
 * Put the owed findings in front of a prompt somebody else built — the USER-TURN seam.
 *
 * IDENTITY WHEN NOTHING IS OWED, which is `withResearchPreamble`'s contract restated for the same
 * reason: `ConciergeHost.dispatchTurn` calls this unconditionally, so "nothing owed adds NOTHING to
 * the prompt" has to be a property of this function rather than a discipline at the call site.
 * Otherwise every ordinary turn carries an empty header, which teaches the brain the section is
 * usually noise — and the one turn that matters gets skimmed.
 *
 * The section itself is {@link buildNoticeSection}'s, unchanged: every owed finding is named
 * however many there are, and past the readability threshold the shape changes rather than the
 * length. A second renderer here would be a second place for that rule to be forgotten.
 *
 * TAKES THE OWED OBJECTS, which is what makes that reuse possible — `buildNoticeSection` groups by
 * {@link NoticeKind} and gives each group the preamble that says what to DO about it, and a list of
 * bare strings has already thrown that away. See {@link ProactiveScheduler.peekNotices}.
 */
export function withNoticeSection(notices: readonly PendingNotice[], prompt: string): string {
  const section = buildNoticeSection(notices);
  return section === "" ? prompt : `${section}\n\n${prompt}`;
}

/** What a scheduler with no research drain wired sees: nothing unread, nothing to claim. Frozen
 *  because it is shared by every such turn. */
const EMPTY_RESEARCH: ResearchStaging = Object.freeze({ preamble: "", taskIds: Object.freeze([]) });

/** Every agent in the feed, across projects. */
function allAgents(feed: ConciergeFeed): ConciergeAgent[] {
  return feed.projects.flatMap((p) => p.agents);
}

/**
 * The surfacing gate — in scope (per the pin), not muted, not already spoken for by an ancestor's
 * row, not merely RELAYING someone else's red while working, and in the `needs_you` band.
 *
 * THE SAME POPULATION `ConciergeHost.accountedAgents` renders, and the host now delegates here so
 * there is exactly one implementation. Two copies would drift, and the drift would be visible: the
 * brain would announce a count the column does not show.
 *
 * `redIsInherited` is the newest term and the one worth naming, because it also governs what the
 * PUSH says out loud. The channel exists to speak first, unprompted — so a sentence naming a busy
 * orchestrator as the thing that needs him is the most expensive kind of wrong this app can be: it
 * interrupts, it is checkable in one click, and it is false. See `ConciergeAgent.redIsInherited`.
 */
export function accountedNeedsYou(feed: ConciergeFeed): ConciergeAgent[] {
  return allAgents(feed).filter(
    (a) =>
      a.inScope &&
      !a.muted &&
      !a.representedElsewhere &&
      !a.redIsInherited &&
      a.band === "needs_you",
  );
}

/**
 * A small, stable fingerprint of the state worth interrupting a human about.
 *
 * WHAT IS IN IT: every in-scope, unmuted agent's id and status. Status is the right grain because
 * every "significant" event in the brief lands on it — an agent entering or leaving `needs_you`, an
 * agent finishing, and a stage advancing (the workflow-stage overlay is what produces `unmerged`;
 * the concierge never sees a separate stage field — see conciergeFeed.publishedStatusFor).
 *
 * WHAT IS DELIBERATELY OUT: `since` (the user's last touch, which moves on every interaction),
 * display names, ordering, and muted/out-of-scope agents. Those are the churn — they move on most
 * roster ticks and mean nothing to a person, and including any of them would make every tick a
 * "change" and defeat the whole gate.
 *
 * Sorted, so a reshuffled roster is not a change.
 */
export function significantDigest(feed: ConciergeFeed): string {
  return allAgents(feed)
    .filter((a) => a.inScope && !a.muted)
    .map((a) => `${a.id}=${a.status}`)
    .sort()
    .join(";");
}

/**
 * The fingerprint of what a push actually SAYS — {@link accountedNeedsYou}'s ids and statuses.
 *
 * TWO JOBS, and they are the same question asked twice (roborev 54166-M4):
 *
 *   1. THE FIRE GATE. {@link significantDigest} covers every in-scope agent, but the prompt only
 *      ever describes the surfaced `needs_you` set — so a running worker moving `working` → `idle`,
 *      or a rolled-up worker changing state, was a digest change with a non-empty needs-you set and
 *      therefore bought a turn whose text was word-for-word the previous one. The rate limits
 *      bounded that at six identical messages an hour rather than preventing it, and a notifier
 *      that repeats itself gets muted — which costs the whole feature, not just the repeat.
 *   2. STALENESS. It is what a push carries, so {@link markStaleProactive} marks a message
 *      superseded exactly when the sentence it asserted stops holding — not when some agent it
 *      never mentioned twitched. Scored against `significantDigest`, a true message was struck
 *      through by unrelated churn on the next roster tick.
 *
 * `significantDigest` stays as the cheap pre-filter: it is one string compare on the hot path and
 * it changes strictly more often than this does, so it settles the common "nothing at all moved"
 * case without walking the surfacing gate.
 *
 * Sorted, so a reshuffled roster is not a change. Empty string means nothing needs the user.
 */
export function surfacedDigest(feed: ConciergeFeed): string {
  return accountedNeedsYou(feed)
    .map((a) => `${a.id}=${a.status}`)
    .sort()
    .join(";");
}

/**
 * The prompt for a turn NOBODY ASKED FOR.
 *
 * Deliberately close to `ConciergeHost.buildSnapshot` in shape — same lines, same counts, same
 * vocabulary — with one critical difference: it says outright that there is no question to answer.
 * Handed the send-shaped prompt, the brain reliably answers the last thing the user said, because
 * `--resume` means it can still see it.
 *
 * THE RESEARCH PREAMBLE IS NOT BUILT HERE. It is composed in `fire`, ahead of this section and
 * ahead of the notices, by `withResearchPreamble` — because a notice-only turn calls this function
 * not at all and must still carry the findings. Same reason `buildSnapshot` does not build it
 * either: the seam belongs where the whole prompt is assembled, so there is one place per turn
 * kind rather than one per section.
 */
export function buildProactivePrompt(feed: ConciergeFeed): string {
  const surfaced = accountedNeedsYou(feed);
  // Shared with buildSnapshot via engine/conciergeRosterLine — the "same lines, same vocabulary"
  // promise in this function's header is now kept by the type system rather than by prose.
  const lines = surfaced.map((a) => rosterLine(a));
  const projects = new Set(surfaced.map((a) => a.projectId)).size;
  return [
    // COUNTED FROM THE LINES, not from `feed.scopedCounts.needs_you` (roborev 54166-M1). The two
    // are different populations: the scoped count includes agents rolled up into an ancestor's row
    // (`representedElsewhere`), which the surfacing gate excludes and the lines below therefore
    // never mention. Handed the wider number the brain states a count column one does not show —
    // "3 need you" over two visible items, with no way for the founder to find the third. This is
    // a turn NOBODY ASKED FOR, so it has less licence to be approximately right than a reply does.
    `${bandCountLabel("needs_you", surfaced.length)} across ${projects} project(s):`,
    lines.join("\n"),
    "",
    "The user has not asked you anything. This is you speaking first, unprompted, because this " +
      "state just changed and they are not looking at it. Say in ONE or TWO short sentences what " +
      "needs them and what you recommend — digest it, do not enumerate every item. No greeting, no " +
      "preamble, no offer to help; just the line.",
  ].join("\n");
}

/**
 * The body of a turn bought by RESEARCH COMING BACK rather than by the fleet moving.
 *
 * WHY THIS IS NOT {@link buildProactivePrompt}'s instruction. That one says "ONE or TWO short
 * sentences, digest it" — right for fleet churn, where the founder needs to know something needs
 * him and can go look. It is wrong here, and expensively so: he ASKED this question, the run has
 * finished, and a two-line notice that an answer exists costs him a round-trip to get the answer he
 * already commissioned. That round-trip IS the reported bug — he had to ask "what did you find out
 * about Epic versus tasks?" for research that had already come back.
 *
 * So this instruction says the opposite thing about length: deliver the finding, and let the
 * finding decide how long that is. The findings themselves arrive ahead of this, in the drain's own
 * preamble (`withResearchPreamble`), exactly as they do on a user turn.
 */
export function buildResearchAnswerPrompt(): string {
  return (
    "The user has not asked you anything in this turn. This is you speaking first, unprompted, " +
    "because research he commissioned has finished and he has NOT seen it. He is waiting on this — " +
    "he asked the question, the run is done, so give him the ANSWER, not a notice that an answer " +
    "exists. Lead with what he asked about and what came back. Length follows the finding: as long " +
    "as the answer needs, no longer. If a run FAILED, say plainly that it failed, why, and what you " +
    "recommend doing about it. No greeting, no preamble, no offer to help."
  );
}

/**
 * Mark every proactive message whose state no longer holds.
 *
 * THE PROBLEM §2a NAMES: "Today's nudge list is recomputed from the feed every render, so it
 * self-heals. A brain-authored digest is an append-only thread entry that will still read 'You have
 * 3 P1s' after they're resolved." A message that keeps asserting a resolved count is not merely
 * stale, it is a lie the app is telling on its own initiative — which is worse than not having said
 * anything.
 *
 * THE RULE: a push carries the digest it was authored against. When the current digest differs, the
 * state it described no longer holds and the message is marked `stale` — the thread renders it
 * visibly superseded rather than quietly wrong. Digest equality is the whole test, and it is
 * deliberately strict: anything that would change the sentence (an item resolving, another arriving,
 * a status moving) changes the digest. It also subsumes supersession — a newer push's digest is
 * current by construction, so every older one is stale the moment it is written.
 *
 * A `you` bubble and an ordinary reply are never touched: a reply is an answer to a question that
 * WAS asked, and it stays true as a record of that exchange.
 *
 * Returns the INPUT ARRAY UNCHANGED when nothing needed marking (the overwhelmingly common case).
 * Bubbles are memoized on identity, so rebuilding the array on every roster tick would re-render the
 * whole thread — the same rule `boundLiveThumbnails` follows in conciergeThreadStore.
 */
export function markStaleProactive(
  chat: ConciergeMessage[],
  currentDigest: string,
): ConciergeMessage[] {
  let out: ConciergeMessage[] | null = null;
  for (let i = 0; i < chat.length; i++) {
    const m = chat[i]!;
    if (m.kind !== "sparkle" || !m.proactive || m.stale) continue;
    if (m.digest === currentDigest) continue;
    out ??= chat.slice();
    out[i] = { ...m, stale: true };
  }
  return out ?? chat;
}

/** When a pending change may fire, and what is holding it. */
interface Due {
  at: number;
  /** The binding constraint. "coalesce" is the ordinary settling window, not a refusal to spend. */
  reason: "coalesce" | "min-interval" | "hourly-cap";
}

/**
 * The trigger.
 *
 * SEEDS, THEN FIRES ON CHANGES. The first observation establishes the baseline and spends nothing.
 * That is deliberate: at mount the column is ALREADY rendering the current state (the nudge cards
 * and digest lines are derived from the feed and self-heal), so a turn to re-narrate the status quo
 * would be pure cost on every app launch — and launch is exactly when a fleet looks busiest. The
 * channel exists to report what changed while the founder wasn't looking.
 *
 * SAYS NOTHING ABOUT GOING CALM. A change that leaves nothing needing the user is real, but a turn
 * spent to say "all clear" is money spent to say nothing — and the message that claimed otherwise is
 * already handled, for free, by {@link markStaleProactive}.
 */
export function createProactiveScheduler(deps: ProactiveDeps): ProactiveScheduler {
  /**
   * Findings from the Pusher that are owed to the concierge but not yet delivered.
   *
   * ── WHY THE SCHEDULER GREW A SECOND INPUT (sparkle-4cd0x) ──────────────────────────────────────
   * Founder: *"the build agent AND THE CONCIERGE are both just sitting silent… I'm wondering if the
   * pusher can be the thing that does that."* This channel already pushes the concierge, but only
   * ever about ONE thing: a change in the needs-you digest. The conditions the Pusher measures —
   * an agent quota-walled for hours, a goal escalated, an app duty overdue, several agents killed by
   * one event, an agent pushed twice that did not move — move no digest, so nothing said anything
   * about them and the concierge had no way to learn they existed. Every watchdog pointed at build
   * agents; none pointed at the thing supposed to be watching them.
   *
   * ── WHY THEY LIVE IN THEIR OWN LIST AND NOT IN `pendingFeed` ───────────────────────────────────
   * They must survive `dropPending`. A feed change is DISCARDED when the fleet flickers back to the
   * state we already spoke about — correct for a digest, and wrong for a finding: "this agent has
   * been walled for three hours" does not stop being true because the roster settled. So notices are
   * cleared on exactly one event, DELIVERY, and a decline leaves them owed. That is the same
   * "the change is still OWED" rule `fire`'s settle path already applies to a feed change.
   *
   * ── AND NOTHING ELSE EVER REMOVES FROM IT (bead sparkle-qogah) ─────────────────────────────────
   * There is exactly ONE `pendingNotices` removal in this file, in `settle`'s delivered branch, and
   * it removes by identity. It used to have a sibling — `notify` truncated the list with `shift()`
   * — and that sibling destroyed the oldest owed finding with no record, no count and no retry,
   * while the caller was told the delivery had succeeded. If you are adding a second remover,
   * you are re-introducing that defect; the ceiling is enforced at the DOOR instead
   * (see {@link PENDING_NOTICE_HARD_CAP}), where a refusal can still be reported to the caller.
   *
   * ── ONE LIST FOR BOTH KINDS, SPLIT ONLY AT RENDER TIME ─────────────────────────────────────────
   * A {@link PendingNotice} carries its own kind, so the lifecycle above — arrival order, the hard
   * ceiling, the single removal on delivery — is one set of rules rather than two that could drift.
   * `buildNoticeSection` is the only thing that separates them, and it separates them for the
   * prompt's sake, not for the bookkeeping's.
   */
  let pendingNotices: PendingNotice[] = [];
  /** The digest we last seeded or spoke about. */
  let baseline: string | null = null;
  /** The SURFACED projection of that same moment — what a push would actually have said about it.
   *  Kept beside `baseline` because the two answer different questions: `baseline` settles "did
   *  anything move at all", this settles "would the sentence be any different". */
  let baselineSurfaced: string | null = null;
  let pendingFeed: ConciergeFeed | null = null;
  let pendingDigest: string | null = null;
  let pendingSurfaced: string | null = null;
  /** When the change now pending FIRST appeared — the coalescing window's origin. */
  let pendingSince: number | null = null;
  /** Limiter reasons already counted for the pending change, so a change held for two minutes
   *  doesn't count one skip per roster tick. */
  let counted = new Set<ProactiveSkipReason>();
  /** Epoch ms of each turn the founder ACTUALLY GOT, pruned to the last hour. Drives the hourly
   *  cap, which is a budget for delivered messages — a declined push must not consume one. */
  let firedAt: number[] = [];
  /** Epoch ms of the last turn we ASKED for, delivered or not. Drives the minimum interval, which
   *  is a floor on attempts rather than on deliveries: without it a standing refusal (the user
   *  holding the conversation) would retry once per coalescing window forever. */
  let lastAttemptAt: number | null = null;
  /** ── THE RESEARCH TRACK ─────────────────────────────────────────────────────────────────────
   *  A SECOND, INDEPENDENT CLOCK, deliberately not folded into the three variables above.
   *
   *  Sharing them was the whole of §3.3's objection (see `observeResearch`): one budget means a
   *  noisy fleet starves an answer the founder is waiting for, and routine findings starve a
   *  blocker. Two tracks means neither can happen — a research turn spends no fleet slot, and a
   *  spent fleet ceiling does not hold a finished answer.
   *
   *  The LAST SNAPSHOT of the store, kept so `fire` can re-ask "is a wake still owed?" at the
   *  moment it fires rather than trusting a decision taken up to a coalescing window earlier. The
   *  store refreshes after every claim, so this self-updates — which is what makes the stand-down
   *  below able to see a finding a USER turn delivered while this one was still pending. */
  let researchTasks: readonly ResearchTask[] = [];
  /** When the currently-owed research wake first appeared — this track's coalescing origin. Same
   *  rule as `pendingSince`: opened by the FIRST terminal task, never reset by later ones, so five
   *  runs finishing together are one turn rather than five. */
  let researchSince: number | null = null;
  /** This track's own floor on ATTEMPTS, mirroring `lastAttemptAt` and for the same reason: a push
   *  declined because the user owns the conversation would otherwise be retried once per four
   *  second window for as long as he keeps typing. It is a floor on RETRIES, never on the first
   *  delivery — a finished answer still goes out on the coalescing window alone. */
  let researchLastAttemptAt: number | null = null;
  /** A turn is out at the transport and has not reported back. Nothing else may fire until it
   *  does, or a slow bridge would let one change become several turns. */
  let inFlight = false;
  let timer: number | null = null;
  let disposed = false;
  const stats: ProactiveStats = {
    fired: 0,
    noticesRidden: 0,
    researchFired: 0,
    skipped: {
      unchanged: 0,
      "same-surface": 0,
      calm: 0,
      "min-interval": 0,
      "hourly-cap": 0,
      declined: 0,
    },
  };

  const clearTimer = () => {
    if (timer !== null) {
      deps.clearTimer(timer);
      timer = null;
    }
  };

  /**
   * THE ONE WAY A NOTICE LEAVES `pendingNotices` — removal by identity, plus the flag that has to
   * come down with it.
   *
   * Extracted so the two delivery paths cannot drift: a proactive turn reporting delivered
   * (`settle`) and a USER turn that carried the finding (`claimNotices`). This file's own rule is
   * that there is exactly one remover — see `pendingNotices`' doc, which records what happened the
   * last time there were two: the sibling was `notify`'s `shift()`, and it destroyed the oldest
   * owed finding with no record, no count and no retry while the caller was told it had landed.
   * Two callers of ONE remover is not that; two removers would be.
   *
   * BY IDENTITY, never by truncating the list, so a finding that arrived while the turn was being
   * built or was in flight is still owed afterwards.
   *
   * ...AND THE "SOMETHING IS OWED" FLAG COMES BACK DOWN WITH THEM (roborev 57705). `dropPending`
   * deliberately keeps `pendingSince` alive while notices are owed, and nothing else lowers it —
   * leaving the scheduler in the one state this file treats as impossible, owed-with-nothing-owed.
   * The visible cost is not the pointless timer: it is `observe`'s `pendingSince ??=`, which keeps
   * the STALE origin, so `dueAt` computes a coalescing deadline already in the past and the next
   * genuine feed change fires with NO window at all. `counted` is reset with it, because those skip
   * reasons were counted against a change that has now been delivered. The timer `dropPending` may
   * already have armed goes too: `arm()` early-returns on a null `pendingSince` WITHOUT clearing,
   * so lowering the flag alone would leave a live handle behind for the life of the window.
   */
  const clearOwed = (delivered: readonly PendingNotice[]) => {
    const sent = new Set(delivered);
    pendingNotices = pendingNotices.filter((n) => !sent.has(n));
    if (pendingNotices.length === 0 && pendingFeed === null) {
      pendingSince = null;
      counted = new Set();
      clearTimer();
    }
  };

  const dropPending = () => {
    pendingFeed = null;
    pendingDigest = null;
    pendingSurfaced = null;
    counted = new Set();
    clearTimer();
    // AN UNDELIVERED NOTICE KEEPS THE CHANGE PENDING. `pendingSince` is the whole lifecycle's
    // "something is owed" flag — `arm` and `onTimer` both bail on null — so clearing it while
    // notices remain would strand them until some unrelated feed change happened to re-arm the
    // timer, which on a quiet fleet is never. A dropped FEED change and an owed NOTICE are
    // different facts, and this is the one line that has to tell them apart.
    if (pendingNotices.length === 0) {
      pendingSince = null;
    } else {
      // Re-armed through `arm` rather than by setting a timer here, so the notice is still held
      // behind the min-interval and hourly cap and still counts the limiter that held it. A raw
      // timer would make a notice the one thing in this module that can outrun its own budget.
      arm();
    }
  };

  const prune = (now: number) => {
    firedAt = firedAt.filter((t) => t > now - HOUR_MS);
  };

  /**
   * Is there a finished research run the founder has not been told about, that is worth WAKING him
   * for? Re-asked at fire time, never cached — see `researchTasks`.
   *
   * `readAt === null` is the drain's durable exactly-once claim (stamped in research.rs only once a
   * turn actually delivers, first-claim-wins), so this answers "still owed" and not merely
   * "finished". It is what makes the stand-down honest: if a USER turn carried the findings while
   * this wake sat in its coalescing window, the claim is stamped and there is nothing left to say.
   *
   * CANCELLED IS TERMINAL AND OWED BUT NOT WAKE-WORTHY — see `observeResearch`. It is excluded here
   * and nowhere else, so a cancelled task still RIDES a turn bought by something else, exactly as
   * before. This predicate governs only whether research may BUY one.
   */
  const researchWakeOwed = () =>
    researchTasks.some(
      (t) => isTerminal(t.status) && t.readAt === null && t.status !== "cancelled",
    );

  /** The earliest moment an owed research answer may become a turn, or null if none is owed.
   *
   *  DELIBERATELY IGNORES `dueAt`'s two limiters. That is the entire point of the second track: the
   *  fleet's floor and ceiling bound interruptions the founder did not ask for, and this is a reply
   *  to one he did. It has its own retry floor and nothing else. */
  const researchDueAt = (): number | null => {
    if (researchSince === null) return null;
    let at = researchSince + PROACTIVE_COALESCE_MS;
    const last = researchLastAttemptAt;
    if (last !== null && last + PROACTIVE_MIN_INTERVAL_MS > at) {
      at = last + PROACTIVE_MIN_INTERVAL_MS;
    }
    return at;
  };

  /** The earliest moment the pending change may become a turn, and what is holding it back. */
  const dueAt = (now: number): Due => {
    let due: Due = { at: (pendingSince ?? now) + PROACTIVE_COALESCE_MS, reason: "coalesce" };
    // ATTEMPTS, not deliveries — see `lastAttemptAt`.
    const last = lastAttemptAt;
    if (last !== null && last + PROACTIVE_MIN_INTERVAL_MS > due.at) {
      due = { at: last + PROACTIVE_MIN_INTERVAL_MS, reason: "min-interval" };
    }
    if (firedAt.length >= PROACTIVE_MAX_PER_HOUR) {
      // The oldest turn inside the cap has to age out of the hour before another may run.
      const releases = firedAt[firedAt.length - PROACTIVE_MAX_PER_HOUR]! + HOUR_MS;
      if (releases > due.at) due = { at: releases, reason: "hourly-cap" };
    }
    return due;
  };

  /**
   * Ask for a turn, and commit NOTHING until the transport says one actually started.
   *
   * The split matters (roborev 54166-M2). Committing up front — advancing the baseline, spending an
   * hourly slot, counting a delivery — was right only if every ask became a message, and the
   * commonest non-delivery is the channel working exactly as designed: the push stands down because
   * the user owns the conversation. Under the old order that outcome moved the baseline past the
   * very change the channel exists to report, so the founder was never told about it and never
   * would be, while the turn he did not receive still ate one of six slots for the hour.
   *
   * What IS committed immediately is `lastAttemptAt`, because the two-minute floor has to bind on
   * asks. A refusal that stays refused for an hour must cost one attempt per floor, not one per
   * four-second coalescing window.
   */
  const fire = (now: number, mainReady: boolean, researchReady: boolean) => {
    // NOTHING FROM THE MAIN TRACK IS READ WHEN IT IS NOT ITS TURN. A research wake can come due
    // while a feed change is still held by the two-minute floor; taking the feed here anyway would
    // let research smuggle the fleet past its own limiter, which is §3.3's objection with the
    // players swapped.
    const feed = mainReady ? pendingFeed : null;
    const digest = mainReady ? pendingDigest : null;
    const surfaced = mainReady ? pendingSurfaced : null;
    // Snapshotted BEFORE `dropPending`, and by value: `settle` runs after an await and must clear
    // exactly the notices this turn carried, never ones that arrived while it was in flight.
    const notices = mainReady ? pendingNotices.slice() : [];
    const hasFeedChange = feed !== null && digest !== null && surfaced !== null;
    // A NOTICE ALONE IS ENOUGH TO SPEAK. This is the point of the second input: the Pusher's
    // findings move no digest, so requiring a feed change here would mean they could only ever ride
    // along with an unrelated one — i.e. exactly the silence being fixed.
    const hasMain = hasFeedChange || notices.length > 0;
    // ══ AND SO IS A FINISHED ANSWER ══════════════════════════════════════════════════════════════
    // The third reason. This line used to sit BELOW a `return` that required one of the two above,
    // on §3.3's reasoning that a finding must never buy a turn. That is reversed here, and
    // `observeResearch` records why in full: the objection was contention on a SHARED ceiling, and
    // the research track shares neither limiter, so the blocker at minute 40 is still safe. The
    // failure it leaves behind — an answer sitting unspoken until the founder thinks to ask for it
    // — is the one actually observed.
    if (!hasMain && !researchReady) return;
    const research = deps.peekResearch?.() ?? EMPTY_RESEARCH;
    // DO NOT REPORT WHAT HE HAS ALREADY BEEN TOLD. `researchWakeOwed` re-reads the durable
    // `readAt` claim at THIS instant, so a finding a user turn happened to carry while this wake
    // sat in its coalescing window stands the wake down instead of saying it twice. The preamble
    // check is the same question asked of the drain, which is the component that actually knows.
    const tellAnswer = researchReady && research.preamble !== "" && researchWakeOwed();
    if (!hasMain && !tellAnswer) {
      // Nothing owed after all: close this track's window rather than re-arming it, or a delivered
      // finding would leave a timer running forever on a quiet fleet.
      researchSince = null;
      clearTimer();
      return;
    }
    const body = [
      hasFeedChange ? buildProactivePrompt(feed) : null,
      // EVERY OWED FINDING GOES IN — `buildNoticeSection` names all of them however many there are,
      // and changes shape rather than length past the readability threshold.
      notices.length > 0 ? buildNoticeSection(notices) : null,
      // LAST, so a turn carrying both a blocker and an answer still leads with the blocker.
      tellAnswer ? buildResearchAnswerPrompt() : null,
    ]
      .filter((part): part is string => part !== null)
      .join("\n\n");
    // Identity when there is nothing unread — no empty header, on any turn. Memory re-grounding
    // wraps OUTSIDE research, matching the user-turn seam's order (memories are background context
    // the brain should already hold; research findings are what just came back).
    const memoryPreamble = deps.peekMemoryPreamble?.() ?? "";
    const prompt = withMemoryPreamble(memoryPreamble, withResearchPreamble(research.preamble, body));
    // EACH TRACK CHARGES ITS OWN ATTEMPT, and only the track that actually spoke. A research-only
    // turn that moved `lastAttemptAt` would put the fleet behind a two-minute floor it never
    // earned — the starvation §3.3 predicted, arriving by the back door.
    if (hasMain) lastAttemptAt = now;
    if (tellAnswer) researchLastAttemptAt = now;
    if (hasMain) dropPending();

    let settled = false;
    const settle = (delivered: boolean) => {
      if (settled) return; // a transport that both resolves and throws must not double-count
      settled = true;
      inFlight = false;
      if (disposed) return;
      if (delivered) {
        // Guarded: a notice-only turn advanced no digest, and writing `null` into the baseline
        // would make the NEXT genuine feed change compare against nothing and re-seed silently.
        if (hasFeedChange) {
          baseline = digest;
          baselineSurfaced = surfaced;
        }
        // THE NOTICES THIS TURN CARRIED ARE NOW DELIVERED. `clearOwed` is the single remover — it
        // owns both the by-identity removal and the "something is owed" flag that has to come down
        // with it (roborev 57705). `dropPending` keeps that flag alive while notices are owed, and
        // `fire` runs it BEFORE the transport reports back, so at that moment the flag is rightly
        // held; this is where it is released.
        // GUARDED ON THE MAIN TRACK. `clearOwed` lowers the shared "something is owed" flag and
        // kills the timer when nothing is left; running it for a research-only turn would tear down
        // a main-track window this turn never carried.
        if (hasMain) {
          clearOwed(notices);
          firedAt.push(now);
          stats.fired++;
        }
        // THE ANSWER LANDED — close this track's window. Not `firedAt`: see `observeResearch`.
        if (tellAnswer) {
          researchSince = null;
          stats.researchFired++;
        }
      } else {
        stats.skipped.declined++;
        // A DECLINED ANSWER STAYS OWED. `researchSince` is deliberately untouched, so `arm()` below
        // re-arms it behind this track's own retry floor. In practice the user turn that caused the
        // decline delivers the findings itself through the user-turn seam, after which the
        // stand-down above closes the window silently.
        // The change is still OWED. Re-pend it — unless a newer observation already did, in which
        // case that one supersedes this and the baseline (deliberately not advanced) still differs
        // from it.
        //
        // Tested on `pendingFeed` rather than on `pendingSince` (which is what it used to read).
        // The two were equivalent until notices existed — `dropPending` cleared both together — but
        // a notice now holds `pendingSince` non-null on purpose, and under the old test that made an
        // owed notice SWALLOW the re-pend of a declined feed change. `pendingFeed === null` asks the
        // question that was always meant: did a newer observation supersede this one.
        if (hasFeedChange && pendingFeed === null) {
          pendingFeed = feed;
          pendingDigest = digest;
          pendingSurfaced = surfaced;
          counted = new Set();
        }
        // Puts the re-armed attempt behind the min-interval floor. Notices left in `pendingNotices`
        // are re-armed by this too — they were never removed, so nothing has to be restored.
        //
        // GUARDED ON `hasMain`: a declined RESEARCH-only turn carried nothing from this track, and
        // raising the flag for it would create the one state this file treats as impossible —
        // owed-with-nothing-owed — whose real cost is that `observe`'s `pendingSince ??=` then keeps
        // a stale origin and the next genuine feed change fires with no coalescing window at all.
        if (hasMain && pendingSince === null) pendingSince = deps.now();
      }
      arm();
    };

    // The SURFACED digest travels with the turn, not the significant one: it is what the message
    // asserts, and therefore the only thing `markStaleProactive` can honestly score it against.
    //
    // A NOTICE-ONLY TURN HAS NO DIGEST OF ITS OWN — it asserts something the surface does not show,
    // which is why it exists — so it travels with the surface AS IT STOOD when we spoke. That makes
    // it retractable on the same rule as every other push, and the direction of the residual error
    // is the one this module already chose everywhere else: a finding that is still true may be
    // struck early, rather than a finding that has stopped being true being left standing. This
    // file's own rule is that the app volunteering something false is worse than having said
    // nothing.
    const outcome = deps.startTurn(prompt, surfaced ?? baselineSurfaced ?? "", research.taskIds);
    if (typeof outcome === "boolean") {
      settle(outcome);
      return;
    }
    inFlight = true;
    // A rejected transport is a decline, not a crash: `startProactiveConciergeTurn` never rejects,
    // but this module must not become the place a future edge's rejection goes unhandled.
    outcome.then(settle, () => settle(false));
  };

  /** (Re)arm the timer for whenever the pending change may fire, counting any limiter that is
   *  holding it — once per pending change per reason. */
  /** ONE TIMER, TWO TRACKS: arm for whichever comes due first. Keeping a second `setTimer` handle
   *  was the obvious alternative and is worse — `dispose`, `dropPending` and `clearOwed` all reach
   *  for exactly one handle today, and a sibling they did not know about would outlive them. */
  const arm = () => {
    if (disposed) return;
    const now = deps.now();
    prune(now);
    const mainDue = pendingSince === null ? null : dueAt(now);
    const researchDue = researchDueAt();
    if (mainDue === null && researchDue === null) return;
    // Counted for the MAIN track only, and only when that track is what is holding things up. The
    // research track has no limiter worth a statistic: it is held by its coalescing window, which
    // is not a skip.
    if (mainDue !== null && mainDue.reason !== "coalesce" && !counted.has(mainDue.reason)) {
      counted.add(mainDue.reason);
      stats.skipped[mainDue.reason]++;
    }
    const at = Math.min(mainDue?.at ?? Infinity, researchDue ?? Infinity);
    clearTimer();
    timer = deps.setTimer(onTimer, Math.max(0, at - now));
  };

  function onTimer() {
    timer = null;
    if (disposed) return;
    // A turn is still out. Don't arm a replacement here — that would busy-loop on an already-due
    // change; `settle` re-arms once the transport reports back.
    if (inFlight) return;
    const now = deps.now();
    prune(now);
    // A limiter can have moved under us (another turn ran; the hour rolled differently than the
    // arithmetic at arm time predicted), so the decision is re-taken here rather than trusted.
    const mainReady = pendingSince !== null && dueAt(now).at <= now;
    const researchDue = researchDueAt();
    const researchReady = researchDue !== null && researchDue <= now;
    if (!mainReady && !researchReady) {
      arm();
      return;
    }
    fire(now, mainReady, researchReady);
  }

  return {
    /**
     * ── THE FOUR ANSWERS, AND WHY EACH ONE IS WHAT IT IS (bead sparkle-qogah) ────────────────────
     *
     * The return value is "is this finding now owed, and will it reach a prompt" — nothing weaker.
     * All four paths below used to return `void` and were read by the caller as success, so it is
     * worth stating each one rather than leaving the reader to infer it from the control flow:
     *
     *   1. DISPOSED → FALSE. The scheduler will never build another prompt, so this text reaches
     *      nobody, ever. Reported honestly, the Pusher keeps the finding owed and the next window
     *      to mount a concierge gets it. Reported as success — which is what happened — the
     *      condition was stamped for four hours by a scheduler that was already dead. This is
     *      exactly the false-success `conciergeNotifier`'s own header was written to prevent, and
     *      it was arriving through the sink that header describes.
     *   2. EMPTY TEXT → FALSE. Nothing is owed because there is nothing to say, but the caller
     *      still must not record a delivery: an empty push is a bug upstream, and `false` surfaces
     *      it as a `transport-failed` WARN instead of burning the condition's cooldown on a blank.
     *   3. ALREADY OWED → TRUE, and this is the one refusal that is genuinely a success. The
     *      identical sentence is ALREADY in `pendingNotices` and WILL be delivered; this call is
     *      the Pusher re-measuring a condition that has not changed. The work is owed, so the
     *      cooldown is legitimately earned — re-offering it would only duplicate the bullet.
     *   4. AT THE HARD CEILING → FALSE. See {@link PENDING_NOTICE_HARD_CAP}: we refuse the arrival
     *      rather than destroying something already owed, and `false` is what makes that refusal
     *      recoverable — the Pusher re-offers it next sweep, by which time a delivery has drained
     *      the list.
     *
     * There is deliberately NO path that returns `true` for text this scheduler did not accept.
     */
    notify(text, kind = "pusher") {
      // (1) DISPOSED — see above.
      if (disposed) return false;
      const finding = text.trim();
      // (2) EMPTY — see above.
      if (finding === "") return false;
      // (3) ALREADY OWED — see the idempotence note on the interface. Returning early rather than
      // re-arming also means a Pusher sweeping every five minutes against a condition that lasts
      // hours cannot keep pushing the coalescing window out in front of itself. TRUE, because the
      // finding really is pending and really will be delivered.
      //
      // THE KIND IS PART OF THE IDENTITY. Matching on text alone would silently swallow a report of
      // something already done whenever a live finding happened to word it the same way — a drop,
      // reported to the caller as a delivery, which is the exact defect this whole path was
      // rewritten to remove. The two would be rendered under contradictory instructions, so they
      // are not the same notice however identical the sentence.
      if (pendingNotices.some((n) => n.kind === kind && n.text === finding)) return true;
      // (4) THE HARD CEILING — refuse the newcomer, never destroy an incumbent. This replaces a
      // `shift()` that discarded the oldest owed finding with no residue of any kind. Counted over
      // BOTH kinds, because what it bounds is this scheduler's memory, and memory is not per-kind.
      if (pendingNotices.length >= PENDING_NOTICE_HARD_CAP) return false;
      pendingNotices.push({ kind, text: finding });
      // Opens the coalescing window if nothing else has. A finding that arrives while a feed change
      // is already pending rides the same turn, which is the cheaper outcome for both.
      if (pendingSince === null) {
        pendingSince = deps.now();
        counted = new Set();
      }
      arm();
      return true;
    },
    observe(feed) {
      if (disposed) return;
      const digest = significantDigest(feed);
      if (baseline === null) {
        // Seed only — see the doc above.
        baseline = digest;
        baselineSurfaced = surfacedDigest(feed);
        return;
      }
      if (digest === baseline) {
        stats.skipped.unchanged++;
        // The fleet flickered and settled back to the state we already spoke about (or seeded).
        // There is nothing left to say, so a pending turn is cancelled rather than delivered late.
        if (pendingSince !== null) dropPending();
        return;
      }
      const surfaced = surfacedDigest(feed);
      if (surfaced === "") {
        stats.skipped.calm++;
        // Adopt it: going calm is a real change, it just isn't one worth a turn. Adopting means a
        // later return to a needing state is a change from THIS, and fires.
        baseline = digest;
        baselineSurfaced = surfaced;
        if (pendingSince !== null) dropPending();
        return;
      }
      if (surfaced === baselineSurfaced) {
        // Something moved, but nothing the push could have MENTIONED — see `surfacedDigest`. Adopt
        // the new significant digest so the same churn isn't re-examined on every roster tick, and
        // say nothing: the message would have been word-for-word the last one.
        stats.skipped["same-surface"]++;
        baseline = digest;
        if (pendingSince !== null) dropPending();
        return;
      }
      pendingFeed = feed;
      pendingDigest = digest;
      pendingSurfaced = surfaced;
      // NOT reset on each new change — that is what makes this a coalescing window rather than a
      // debounce (see PROACTIVE_COALESCE_MS).
      pendingSince ??= deps.now();
      arm();
    },
    observeResearch(tasks) {
      if (disposed) return;
      // Kept even when nothing is wake-worthy, because `fire`'s stand-down re-reads this snapshot
      // to decide whether an answer is still owed at the moment it would speak.
      researchTasks = tasks;
      if (!researchWakeOwed()) {
        // Everything owed has been claimed — by this channel or by a user turn that carried it.
        // Close the window rather than leaving a timer running on a quiet fleet.
        if (researchSince !== null) {
          researchSince = null;
          clearTimer();
          arm();
        }
        return;
      }
      // NOT reset by later arrivals — the same coalescing rule as `pendingSince`, and the reason
      // five runs finishing inside four seconds are one turn instead of five.
      researchSince ??= deps.now();
      arm();
    },
    /**
     * See the interface for WHY this seam exists. Two properties, both cheap and both load-bearing:
     * it claims nothing, and it arms nothing.
     *
     * A DISPOSED SCHEDULER OFFERS NOTHING, matching `notify`'s first answer: it will never build
     * another prompt, so anything still owed to it reaches nobody. Handing findings to a host that
     * is tearing down would let them be claimed against a turn nothing is left to observe.
     */
    peekNotices() {
      if (disposed) return [];
      return [...pendingNotices];
    },

    /** The turn carrying these installed — see the interface. One remover, shared with `settle`. */
    claimNotices(notices) {
      if (disposed || notices.length === 0) return;
      const owed = new Set(pendingNotices);
      // Count only what was ACTUALLY owed here. A claim naming something this scheduler never had
      // (a stale prompt, a host that outlived a remount) must not inflate the tally — the number is
      // read as "findings this channel got through", and an unowed claim delivered nothing.
      const landed = notices.filter((n) => owed.has(n));
      if (landed.length === 0) return;
      clearOwed(landed);
      // NOT `firedAt`, and NOT `stats.fired`. The hourly cap bounds INTERRUPTIONS; this turn is one
      // the founder started himself, so charging it would rate-limit out a genuine push later for
      // the sake of a message that cost him nothing.
      stats.noticesRidden += landed.length;
    },

    dispose() {
      disposed = true;
      // Both tracks. `dropPending` only knows about the main one, and a research window left open
      // would keep `arm` willing to set a timer on a scheduler that will never build another prompt.
      researchSince = null;
      researchTasks = [];
      dropPending();
    },
    stats: () => ({
      fired: stats.fired,
      noticesRidden: stats.noticesRidden,
      researchFired: stats.researchFired,
      skipped: { ...stats.skipped },
    }),
  };
}
