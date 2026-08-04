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
// ══ WHY EXACTLY ONE MESSAGE EVER CARRIES A STATUS TODAY ═════════════════════════════════════════
// Not a simplification — a property of the backend, and the honest rendering of it. A send does not
// QUEUE behind the turn in flight, it SUPERSEDES it: `concierge.rs` kills the running turn's process
// group, and `buildSnapshot` puts only the newest message in the prompt. So at any instant there is
// exactly one message being worked on, and it is always the most recent one. A map is still the
// right shape — it is what the per-message surface consumes, and it is what stops this from being
// re-plumbed when that changes (bead sparkle-t8wsj, which makes sends queue and fan out).
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
): Record<string, ConciergeMessageStatusText> {
  const latest = useConciergeActivityStore((s) => s.latest);

  return useMemo(() => {
    if (!awaitingId || !typing) return NONE;
    const fresh = latest && latest.seq > floor ? latest : null;
    const line = fresh ? conciergeActivityLine(fresh) : null;
    // NO ACTIVITY, NO CLAIM — the rule the column-level indicator degrades by, kept identical here.
    // A turn that is thinking and has called nothing yet gets no status rather than a manufactured
    // one; the bubble simply carries nothing, exactly as it did before this feature.
    if (!line) return NONE;
    return { [awaitingId]: { text: line.text } };
  }, [awaitingId, typing, latest, floor]);
}
