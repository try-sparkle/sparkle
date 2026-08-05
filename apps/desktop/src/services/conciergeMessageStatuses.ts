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
// line is OBSERVED — it names the tool actually running. A waiting message's line is a fact about
// the QUEUE, not about the concierge, and says only that: its turn has not started.
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
    for (const q of queue.waiting) waiting[q.bubbleId] = { text: "Waiting its turn" };

    if (!awaitingId || !typing) return queue.waiting.length ? waiting : NONE;
    const fresh = latest && latest.seq > floor ? latest : null;
    const line = fresh ? conciergeActivityLine(fresh) : null;
    // NO ACTIVITY, NO CLAIM — the rule the column-level indicator degrades by, kept identical here.
    // A turn that is thinking and has called nothing yet gets no status rather than a manufactured
    // one; the bubble simply carries nothing, exactly as it did before this feature.
    if (!line) return queue.waiting.length ? waiting : NONE;
    return { ...waiting, [awaitingId]: { text: line.text } };
  }, [awaitingId, typing, latest, floor, queue]);
}
