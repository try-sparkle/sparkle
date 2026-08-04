// THE TURN BOUNDARY — the activity counter as it stood when the message now being worked on was
// sent, so everything at or below it belongs to an EARLIER turn.
//
// ══ WHY THIS IS ITS OWN MODULE (roborev 57889-M1) ═══════════════════════════════════════════════
// It lived as a bare `useEffect` inside ConciergeHost, keyed on `[typing]` alone — and that is a
// boundary keyed on the wrong event. A send does not QUEUE behind the turn in flight, it SUPERSEDES
// it (`concierge.rs` kills the running process group), and `askSparkle` calls `setTyping(true)`
// unconditionally — so a re-send while a turn is running writes the SAME value, React bails out, the
// effect never re-runs, and the floor keeps the previous turn's snapshot. Meanwhile the message the
// status attaches to has already moved. The result is the previous turn's line — "Reading Kraken
// Auth's terminal" — rendered under the question the user just asked, which is the one falsehood
// this whole surface exists to remove, in precisely the case it was built for (*"I usually send
// multiple messages to the Concierge"*).
//
// KEYED ON THE SEND, therefore, not on the typing transition: `awaitingId` moves on every send and
// `typing` does not. Extracted here rather than fixed in place because the defect lived entirely in
// host wiring that nothing could reach — the producer's own suite takes `floor` as a parameter, so
// no test it contains can see a floor that failed to move.
import { useEffect, useState } from "react";

import { noteConciergePhase, useConciergeActivityStore } from "./conciergeActivity";

/**
 * The floor for the turn currently being awaited, and the `reading_message` phase that opens it.
 *
 * ══ WHY AN EFFECT AND NOT A LINE NEXT TO `setTyping(true)` ══════════════════════════════════════
 * A genuine ordering constraint, not a preference: recording at the send site produces NOTHING on
 * screen. `ThinkingIndicator` establishes its own per-turn floor by snapshotting the counter on the
 * render where `typing` flips true and showing an entry only when `entry.seq > floor`. A synchronous
 * record at the send site runs BEFORE that render, so the floor is taken from the entry we just
 * wrote and the strict `>` filters it straight back out. An effect runs after the commit, so the
 * floor is already fixed and this entry lands above it. The cost is one frame of bare pulse.
 *
 * THE SNAPSHOT IS TAKEN BEFORE THE PHASE IS RECORDED, so the phase itself clears the floor it just
 * established — that is what gives a brand-new turn something to say before its first tool call.
 * `noteConciergePhase` exempts `reading_message` from its idempotence guard for exactly this reason
 * (roborev 57870): back-to-back turns that reach no tool and no text leave `reading_message` as the
 * newest entry, and a guard that collapsed the repeat would leave the new turn with nothing above
 * its floor at all.
 *
 * @param typing  whether a turn is running at all. Gated on rather than merely keyed on, so the
 *                commit that ends a turn cannot open a new boundary.
 * @param sendSeq a counter bumped UNCONDITIONALLY on every send.
 *
 * ══ WHY A COUNTER AND NOT `awaitingId` (roborev 57914-M1) ═══════════════════════════════════════
 * This used to key on the awaited bubble id, documented as "it changes on every send". It does not:
 * `relayFollowUp` and the "Also ask Sparkle" replay both send with NO bubble of their own, so
 * `awaitingId` stays `null`. Two such sends back to back leave `null` and `typing: true` unchanged,
 * React bails, and the effect never re-runs — the floor keeps the KILLED turn's snapshot, and
 * `ThinkingIndicator` goes on narrating the dead turn ("Reading Kraken Auth's terminal") for the
 * whole of the new one. A counter cannot collide with itself, so it has no such hole.
 */
export function useConciergeTurnFloor(typing: boolean, sendSeq: number): number {
  /**
   * ══ SNAPSHOTTED DURING RENDER, NOT IN AN EFFECT (roborev 57914-M2) ════════════════════════════
   *
   * `awaitingId` moves during render while a passive effect lands after commit, so an effect-set
   * floor leaves at least one COMMITTED render in which the new bubble is already current and the
   * floor is still the previous turn's. For that frame the producer returns the superseded turn's
   * line keyed to the message the user just sent — the single falsehood this surface exists to
   * remove — and nothing guarantees the browser has not painted it. It resolves on the next render,
   * which is precisely why a test that reads state after effects flush cannot see it.
   *
   * Setting state during render is React's sanctioned answer to "adjust state when a prop changes":
   * the component re-runs before anything is committed, so the stale frame is never shown.
   * `ThinkingIndicator` derives its own floor exactly this way, for exactly this reason.
   */
  const [turn, setTurn] = useState(() => ({
    key: typing ? sendSeq : -1,
    floor: typing ? (useConciergeActivityStore.getState().latest?.seq ?? -1) : -1,
  }));
  if (typing && turn.key !== sendSeq) {
    setTurn({ key: sendSeq, floor: useConciergeActivityStore.getState().latest?.seq ?? -1 });
  }
  // The PHASE stays in an effect, and must: recording it during render would write it at or below
  // the floor taken in the same pass, and the strict `seq > floor` would filter the new turn's only
  // entry straight back out. After commit it lands strictly above.
  useEffect(() => {
    if (!typing) return;
    noteConciergePhase("reading_message");
  }, [typing, sendSeq]);
  return turn.floor;
}
