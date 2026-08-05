// WHICH MESSAGE THE STATUS BELONGS TO — the producer behind the per-message status line.
//
// ══ THE ASK ═════════════════════════════════════════════════════════════════════════════════════
// The founder: *"I usually send multiple messages to the Concierge and I would like to see a status
// below each chat message that I send, showing what it's doing about that specific message. … What
// I would ideally love is that it shows me its status below each message."*
//
// The column already had ONE status line, at the bottom, describing the turn in flight. In a thread
// of several questions that line is ambiguous by construction: it is attached to the column rather
// than to a question, so the reader has to infer which of their messages it is about. Attaching it
// to the bubble removes the inference.
//
// ══ SEVERAL MESSAGES CARRY A STATUS NOW (sparkle-t8wsj) ═════════════════════════════════════════
// This header used to say only one ever could, because a send SUPERSEDED the turn in flight — it
// killed the running child rather than waiting. Sends QUEUE now, so at any instant there is one
// message being WORKED ON and any number WAITING behind it, and each carries its own line. That is
// what the founder asked for: *"I don't know which one you are working on."*
//
// The two kinds of line are different in nature and must not be conflated. The working message's
// line is OBSERVED — it names the phase or tool actually running, opening with "Reading your
// message" from the frame after dispatch (services/conciergeTurnFloor). A waiting message's line is
// a fact about the QUEUE, not about the concierge: it says where the message stands in line and
// nothing about what the concierge is doing, because nothing is being done about it yet. See
// {@link waitingLine} for why that position is stated rather than a flat "waiting", and why it
// carries no ETA — and the call site for why the waiting side gets no queue-derived FALLBACK.
//
// ══ WHAT AN OLDER MESSAGE GETS: NOTHING, DELIBERATELY ═══════════════════════════════════════════
// It is tempting to mark a displaced message "never answered", and this app has already tried it.
// `RoutingReceipt` rendered exactly that line and it was DELETED on 2026-07-31, because the
// concierge frequently answers a displaced question a couple of messages later — so the flat claim
// was contradicted by the app's own record, sometimes directly above an "Answered below" marker
// pointing at the answer. A status is a report of something OBSERVED. "I do not currently know
// anything about this message" renders as nothing at all, which is the true statement.
//
// ══ THE WORDS ONLY — NEVER THE TONE (roborev 57889-M2) ══════════════════════════════════════════
// This hook is called from `ConciergeHost`, so anything it subscribes to re-renders the whole
// column: neither `ConciergeColumn` nor `ConciergeThread` is memoised. `useConciergeLiveness` is
// precisely the wrong thing to subscribe to there — it holds `now` in state and re-renders its
// caller once a second for the whole of every turn, and it reads the liveness store with no
// selector, so it also re-renders on every `noteConciergeProgress` (per token chunk). That is what
// `LivenessAnnouncer` was extracted to prevent and what services/conciergeActivity's idempotence
// guard cites as still holding. The tone is therefore read in a LEAF — `MessageStatusLive`, mounted
// only for the one bubble that has a status — and this hook produces the phrase and nothing else.
import { useMemo } from "react";

import { conciergeActivityLine } from "../engine/conciergeActivityLine";
import { EMPTY_TURN_QUEUE, type TurnQueueState } from "../engine/conciergeTurnQueue";
import { useConciergeActivityStore } from "./conciergeActivity";
import type { ConciergeMessageStatusText } from "../components/Concierge/MessageStatus";

/** Nothing is being worked on. A module const so the common path allocates nothing and keeps a
 *  stable identity — the map is a prop on a memoised subtree, so a fresh `{}` every render would
 *  defeat the memo for every row in the thread. */
const NONE: Record<string, ConciergeMessageStatusText> = {};

/**
 * `1` → `"1st"`, `22` → `"22nd"`. English ordinals, teens and all.
 *
 * The teen exception is a live case here rather than a textbook one: the queue holds up to
 * {@link MAX_QUEUED_TURNS} = 50 and the founder's ask is *"twenty to fifty messages"*, so a burst
 * routinely runs through 11–13 (which take `th` despite ending in 1/2/3) and out the other side into
 * 21–23 (which resume `st`/`nd`/`rd`). A bare `n % 10` rule is wrong for three of every hundred
 * positions and every one of them is reachable by hand in one sitting.
 */
function ordinal(n: number): string {
  const teen = n % 100;
  if (teen >= 11 && teen <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/**
 * What a WAITING message says, given its 1-based place in the queue.
 *
 * ══ WHY A POSITION AND NOT JUST "WAITING" ══════════════════════════════════════════════════════
 * Every waiter used to render the identical `"Waiting its turn"`. That is honest but nearly
 * contentless at the depth this queue exists for: twenty messages produced twenty identical lines,
 * so the reader could see THAT a question was queued and not how far off its answer was. The depth
 * was already computed — `engine/conciergeTurnQueue.waitingCount` has existed since the queue landed
 * and nothing ever read it — which makes this the app's recurring failure of knowing something and
 * not showing it, in miniature.
 *
 * ══ STILL A FACT ABOUT THE QUEUE, NOT A PREDICTION ═════════════════════════════════════════════
 * "3rd in line" says where the message sits in an ordered list this module can see in full. It is
 * NOT an estimate of when the answer arrives, and deliberately carries no time: turn duration varies
 * by more than an order of magnitude (a one-line answer versus a repo-wide read), so any "about two
 * minutes" would be the confident-but-unknowable claim this column has removed everywhere else.
 *
 * The front of the queue is named rather than numbered — "Next up" beats "1st in line", which reads
 * like a position in a list rather than the thing the reader wants to know.
 */
export function waitingLine(position: number): string {
  return position === 1 ? "Next up" : `${ordinal(position)} in line`;
}

/**
 * The per-message status map, keyed by user-message id.
 *
 * @param awaitingId the bubble whose turn is in flight, or null when nothing is being awaited
 * @param typing     whether a turn is actually running — the same flag the column-level indicator
 *                   uses, so the two surfaces can never disagree about whether anything is happening
 * @param floor      the activity counter as it stood when this turn began. Entries at or below it
 *                   belong to an EARLIER turn and must not be presented as work on this message —
 *                   the same rule `ThinkingIndicator` applies, and for the same reason: a line left
 *                   over from the previous turn shown under a new question is a plain falsehood.
 */
export function useConciergeMessageStatuses(
  awaitingId: string | null,
  typing: boolean,
  floor: number,
  queue: TurnQueueState = EMPTY_TURN_QUEUE,
): Record<string, ConciergeMessageStatusText> {
  const latest = useConciergeActivityStore((s) => s.latest);

  return useMemo(() => {
    // WAITING MESSAGES FIRST, and they do not depend on `typing` or the activity floor: a queued
    // message has no turn, so there is no activity that could describe it. The line states the one
    // thing that IS true of it — it is in line — and nothing about what the concierge is doing.
    const waiting: Record<string, ConciergeMessageStatusText> = {};
    // The INDEX is the whole added signal — see {@link waitingLine}. `queue.waiting` is ordered
    // oldest-first and drains from the front, so `i + 1` is the message's actual place in line and
    // moves on its own every time a turn finishes.
    queue.waiting.forEach((q, i) => {
      waiting[q.bubbleId] = { text: waitingLine(i + 1) };
    });

    if (!awaitingId || !typing) return queue.waiting.length ? waiting : NONE;
    const fresh = latest && latest.seq > floor ? latest : null;
    const line = fresh ? conciergeActivityLine(fresh) : null;
    // NO ACTIVITY, NO CLAIM — the rule the column-level indicator degrades by, kept identical here.
    // A turn that is thinking and has called nothing yet gets no status rather than a manufactured
    // one; the bubble simply carries nothing, exactly as it did before this feature.
    //
    // A QUEUE-DERIVED FALLBACK WAS TRIED HERE AND REMOVED, so it is not re-added by the next reader
    // who notices the gap. The idea was to say "Working on this" for `queue.running` until a tool
    // line existed, on the reasoning that the running message was dark while every message queued
    // behind it showed a position. It is not: `services/conciergeTurnFloor` records a
    // `reading_message` phase in an effect keyed on the send counter, which fires for EVERY
    // dispatched turn including one promoted off the queue, so the running message says "Reading
    // your message" from the frame after dispatch. The only window such a fallback could fill is the
    // single pre-commit frame that module already weighs and accepts ("the cost is one frame of bare
    // pulse"), and a phrase that renders for one frame is noise rather than a status.
    if (!line) return queue.waiting.length ? waiting : NONE;
    // LIVE: this one is actually running, so its ink is the age ladder the founder asked for.
    //
    // THE GLYPH TRAVELS WITH THE PHRASE (sparkle-9ciay). *"I like how on the left side it gives me a
    // little icon, I'd like to see that icon on the right side as well."* It is the SAME field the
    // column-level rail draws from — `line.icon`, the tool domain — carried rather than re-derived,
    // so the mark under the bubble cannot disagree with the mark in the rail about what kind of work
    // is running. That matters more than it looks: the rail now yields the WORDS to this line
    // whenever it exists (see ConciergeThread's `activityClaimed`), and the two marks sit side by
    // side on screen while it does.
    //
    // A WAITING line gets none, deliberately — see `waitingLine`. A queue position is not an
    // observed call and has no domain; a glyph on it would be a made-up signal.
    //
    // AND SO DOES `agentRef`, for a sharper reason than the glyph. The rail rendered the agent the
    // sentence names as a live `AgentPill` — current name, status dot, click to open. Handing the
    // bubble `text` alone while the rail yields its words does not move that pill, it DELETES it:
    // `text` embeds the name "as it stood when the call was recorded", so a renamed agent would go
    // stale under the bubble and the click would be gone. Carried, the pill simply changes parent.
    return {
      ...waiting,
      [awaitingId]: { text: line.text, icon: line.icon, agentRef: line.agentRef, live: true },
    };
  }, [awaitingId, typing, latest, floor, queue]);
}
