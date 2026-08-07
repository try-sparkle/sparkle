// A BLOCKED card that has been ANSWERED stays in the thread, greyed, instead of vanishing.
//
// ══ THE REPORT ═══════════════════════════════════════════════════════════════════════════════════
// Founder, 2026-08-06, bead `sparkle-9adzg`, with a screenshot: a red
// "BLOCKED: @<agent> in <project>" card sat in the concierge thread describing an agent that had
// already unblocked — the trigger was a transient `API Error: Unable to connect to API (ENOTFOUND)`
// that self-healed within minutes. His words: "The blocked card should go away or show as resolved
// and be grayed out if it's no longer blocked in the concierge chat thread."
//
// Asked which of the two, he chose to KEEP it. A card that deletes itself takes the record of what
// happened with it, and the thread is where he reads that record back — a fleet where one agent
// blocked for three hours and another cleared in forty seconds looks identical once both cards are
// gone.
//
// ══ WHY THIS IS A LEDGER AND NOT A FIELD ON THE CARD ═════════════════════════════════════════════
// A nudge card is DERIVED: `ConciergeHost` rebuilds the whole set from the feed on every tick and
// nothing about a card is persisted (`conciergeThreadStore.PERSISTED_KINDS` is conversation only).
// That is exactly why the live card is correct and self-retracting — and it is also why a RESOLVED
// card cannot exist without somewhere to remember it, because the moment the agent leaves the red
// band it stops being derivable from the feed at all. This module is that memory: the smallest one
// that can answer "which cards did we show, and which of those are finished".
//
// ══ THE TRAP: LEAVING THE CARD SET IS NOT THE SAME AS BEING UNBLOCKED ════════════════════════════
// The obvious rule — "an id that had a card and no longer does has resolved" — is WRONG, and wrong
// in the direction Sparkle's standing rule forbids (never hide what needs you). An agent's card is
// withdrawn for two very different reasons:
//
//   • it stopped being red                       → resolved. Grey it.
//   • two or more agents share a band, so the     → STILL BLOCKED. It is now a digest line, and
//     cards collapse into a digest line             greying it would report a live blocker as done.
//     (`conciergeDigest`, bead sparkle-4562.4)
//
// So resolution is decided against the agent's BAND — "is this agent still `needs_you`" — and never
// against the card list. {@link noteResolutions} takes the two sets separately for that reason, and
// the argument names say which is which.
//
// ══ ONE CARD PER AGENT, NOT ONE PER EPISODE ══════════════════════════════════════════════════════
// A resolved record is keyed by agent id, so an agent that blocks, clears, and blocks again does not
// leave a paper trail of cards. That is a deliberate trade against fuller history, and it is the
// same trade the digest rule already makes: the failure mode of the alternative is a flapping agent
// producing an unbounded stack of grey cards, which pushes the conversation off screen — the exact
// complaint that created the digest. A re-raised red re-opens the SAME card as live, and
// `conciergeStreamOrder.forgetArrival` moves it back to the bottom of the thread so it cannot
// re-appear far above the fold where the reader will never see it.
//
// PURE — data in, data out, the clock arrives as a parameter. Same family as `engine/alertDismissal`
// and `engine/movementRetraction`, and held to the same rule: every omission fails toward showing a
// card LOUD rather than quiet.
import type { StatusBand } from "./buildSections";

/** A finished red episode — everything the card needs, captured while it was still knowable. */
export interface ResolvedNudge {
  /** The source agent id. Also the card's id, so its pill and its reveal keep working. */
  id: string;
  /** The agent's name AT THE TIME — a fallback only. The card renders an `AgentPill`, which
   *  re-reads the CURRENT name on every render, so a rename still repaints an old card. */
  agentName: string;
  projectName: string;
  band: StatusBand;
  /** When the loud card first went up. */
  raisedAt: number;
  /** When the agent was first seen to have left the red band. */
  resolvedAt: number;
}

/** What the window remembers between ticks. */
export interface ResolvedNudgeLedger {
  /** agentId → when its OPEN episode's card first went up. Present only while it is still red. */
  openedAt: Map<string, number>;
  /** agentId → its most recent FINISHED episode. */
  resolved: Map<string, ResolvedNudge>;
}

export function emptyResolvedLedger(): ResolvedNudgeLedger {
  return { openedAt: new Map(), resolved: new Map() };
}

/** The facts a card carries, as the caller already has them on a `ConciergeAgent`. Named
 *  structurally so a test can supply one without building a whole feed. */
export interface NudgeSubject {
  id: string;
  name: string;
  projectName: string;
  band: StatusBand;
}

/**
 * Open an episode for every agent that has a LIVE card right now. Mutates and returns the ledger.
 *
 * ASSIGN-ONCE while the episode lasts, so `raisedAt` measures the whole block rather than restarting
 * on each tick — the duration the card ends up showing is only as honest as this.
 *
 * Re-opening also DROPS any resolved record for that agent: the card is loud again, and a grey twin
 * of the same card sitting elsewhere in the thread would state the opposite fact about one agent in
 * two places. The caller pairs this with `conciergeStreamOrder.forgetArrival` so the re-raised card
 * moves to the bottom instead of re-appearing at its old slot; see the header.
 */
export function noteCardsShown(
  ledger: ResolvedNudgeLedger,
  cardAgents: readonly NudgeSubject[],
  now: number,
): ResolvedNudgeLedger {
  for (const a of cardAgents) {
    if (!ledger.openedAt.has(a.id)) ledger.openedAt.set(a.id, now);
    ledger.resolved.delete(a.id);
  }
  return ledger;
}

/**
 * Close every open episode whose agent has LEFT the red band, and forget every record whose agent
 * has left the fleet. Mutates and returns the ledger.
 *
 * `stillRed` IS THE BAND, NOT THE CARD LIST — see the header. An agent whose card was folded into a
 * digest line is still red, so it stays open and no grey card is produced for it.
 *
 * `knownAgents` is the whole fleet. A record whose agent is gone is dropped rather than kept as
 * history, because its card would render an `AgentPill` that resolves to nothing — a dead-end pill
 * naming an agent the reader can no longer open. `subjectOf` supplies the naming facts; an agent
 * that cannot be described is not turned into a card.
 */
export function noteResolutions(
  ledger: ResolvedNudgeLedger,
  stillRed: ReadonlySet<string>,
  knownAgents: ReadonlySet<string>,
  subjectOf: (id: string) => NudgeSubject | undefined,
  now: number,
): ResolvedNudgeLedger {
  for (const [id, raisedAt] of [...ledger.openedAt]) {
    if (!knownAgents.has(id)) {
      ledger.openedAt.delete(id);
      continue;
    }
    if (stillRed.has(id)) continue;
    ledger.openedAt.delete(id);
    const subject = subjectOf(id);
    if (subject === undefined) continue;
    ledger.resolved.set(id, {
      id,
      agentName: subject.name,
      projectName: subject.projectName,
      band: subject.band,
      raisedAt,
      // Never before the raise: the two are observations taken at different times, and an NTP step
      // between them would otherwise produce a card reading "RESOLVED after -4s". The card clamps
      // too — belt and braces, because this value is also what a future consumer would sort on.
      resolvedAt: Math.max(raisedAt, now),
    });
  }
  for (const id of [...ledger.resolved.keys()]) {
    if (!knownAgents.has(id)) ledger.resolved.delete(id);
  }
  evictOldest(ledger);
  return ledger;
}

/**
 * How many finished episodes the thread keeps at once.
 *
 * THE CARD WALL IS THE FAILURE THIS BOUNDS, and it is the one the digest already exists to prevent
 * (bead `sparkle-4562.4`): twenty-seven cards stacked above the compose box pushed the conversation
 * off screen. Live cards are protected from it by digesting — two or more of a band collapse into a
 * line — and resolved cards get no such rule, because a grey card is history and history does not
 * group into "3 blocks cleared" without losing the durations that are the whole point of keeping it.
 *
 * So they are capped instead. One-per-agent bounds a FLAPPING agent (see the header) but says
 * nothing about the fleet-wide sum: a dozen agents each blocking once a session is a dozen permanent
 * grey cards, none of which the reader ever asked to keep. Eight is roughly a screenful in this
 * column, and the discard is always the OLDEST — the episodes furthest from what just happened.
 */
export const MAX_RESOLVED_CARDS = 8;

/** Keep only the {@link MAX_RESOLVED_CARDS} most recently finished episodes.
 *
 *  By `resolvedAt`, not by Map insertion order: a record is re-inserted whenever its agent blocks
 *  again and re-resolves, so insertion order and recency agree today — but the ordering that MATTERS
 *  is "which episode finished last", and stating it explicitly is what keeps a future re-insert from
 *  silently evicting the newest card.
 *
 *  TIE-BROKEN ON `raisedAt`, AND THAT IS NOT A REFINEMENT — without it this function did the exact
 *  OPPOSITE of what it promises in the commonest bulk case (roborev 59945-M1). `noteResolutions`
 *  stamps every episode it closes on one tick with the same `now`, so twelve agents leaving
 *  `needs_you` together all carry an identical `resolvedAt`; `Array.prototype.sort` is stable, the
 *  comparator returns 0 for every pair, and the order that survives is insertion order — oldest
 *  OPENED first. `slice(MAX)` then deleted the tail, i.e. the four NEWEST blocks, keeping the eight
 *  oldest. A test that hands each agent a distinct `resolvedAt` cannot see this. */
function evictOldest(ledger: ResolvedNudgeLedger): void {
  if (ledger.resolved.size <= MAX_RESOLVED_CARDS) return;
  const byNewest = [...ledger.resolved.values()].sort(
    (a, b) => b.resolvedAt - a.resolvedAt || b.raisedAt - a.raisedAt,
  );
  for (const stale of byNewest.slice(MAX_RESOLVED_CARDS)) ledger.resolved.delete(stale.id);
}

/**
 * Forget an agent's card entirely — the reader pressed [x] on its RESOLVED form, meaning "take this
 * out of my history".
 *
 * Deliberately NOT what [x] does to a live card: there it is the app's per-episode acknowledgement
 * (`engine/alertDismissal`), which de-escalates the red so the row calms too. A finished episode has
 * nothing left to acknowledge, so the only thing left for the control to mean is removal.
 */
export function forgetResolved(ledger: ResolvedNudgeLedger, id: string): ResolvedNudgeLedger {
  ledger.resolved.delete(id);
  return ledger;
}

/**
 * Forget an agent's episode ENTIRELY — the open one as well as any finished one — so nothing about
 * it will ever be turned into a grey card.
 *
 * THIS IS THE ONE {@link forgetResolved} CANNOT DO, and the difference is the whole point. Dropping
 * only the finished record leaves `openedAt` standing, and an open episode is a card the NEXT quiet
 * tick will manufacture.
 *
 * ITS ONE CALLER IS THE LIVE [x]. `engine/alertDismissal` acknowledges a red WITHOUT resolving it —
 * the agent is still `waiting`, its published status is merely de-escalated, which is exactly how
 * the feed's `stillRed` set loses it. Left alone, acknowledging an alarm would mint a grey
 * "RESOLVED after 4s:" card asserting the block is finished when the agent is still stopped dead
 * waiting for the reader: a live blocker rendered as history, the one direction this whole module is
 * written to make impossible. It would also make [x] a TWO-click gesture — one to acknowledge, one
 * to clear the receipt it left behind.
 *
 * NOT FOR MUTE OR A PIN, even though both also withdraw a live card while the agent is still red.
 * Those are CURRENT-VIEW facts and this is a permanent deletion, so using it there erased receipts a
 * later unpin/unmute should have brought back, and restamped `raisedAt` on episodes that were still
 * open (roborev 59945-M2). The caller hides those at render instead; see the filter in
 * `ConciergeHost`'s view model.
 */
export function forgetEpisode(ledger: ResolvedNudgeLedger, id: string): ResolvedNudgeLedger {
  ledger.openedAt.delete(id);
  ledger.resolved.delete(id);
  return ledger;
}

/** The finished episodes, for the caller to turn into cards. */
export function resolvedNudges(ledger: ResolvedNudgeLedger): ResolvedNudge[] {
  return [...ledger.resolved.values()];
}

/**
 * THE WINDOW'S ONE LEDGER.
 *
 * Module-level for the same reason `movementRetraction.WINDOW_LEDGER` is, and it is the more
 * important half of that argument here: this ledger holds `raisedAt`, and `raisedAt` is the only
 * record of when a block STARTED. A `useRef` dies with its component — `ConciergeHost` sits inside
 * `ReadinessGate`/`AuthGate`/`Suspense`, so an auth lapse or a chunk re-suspend unmounts it — and on
 * remount every open episode would be re-stamped `now`, so a three-hour block would resolve as "0s".
 * A wrong duration is worse than none: it reads as a fact rather than as a gap.
 */
const WINDOW_LEDGER: ResolvedNudgeLedger = emptyResolvedLedger();

/** The window's shared ledger. React callers only — tests build their own. */
export function windowResolvedLedger(): ResolvedNudgeLedger {
  return WINDOW_LEDGER;
}

/** Clear the shared ledger. Tests only: module state that survives a case is how one test's open
 *  episode silently decides the next one's duration. */
export function resetResolvedLedgerForTests(): void {
  WINDOW_LEDGER.openedAt.clear();
  WINDOW_LEDGER.resolved.clear();
}
