// REPLY ANCHORING — which of the user's messages a concierge reply is answering, and the rule that
// decides it. Pure: no React, no stores, no Tauri, so both halves of the affordance (the quoted stub
// over the reply and the marker under the message it answers) are derived from one place.
//
// THE PROBLEM. The founder fires several messages in a row while a turn is in flight. Each send kills
// the turn before it (see ConciergeHost's `askSparkle`), so the answer that finally arrives is one
// paragraph covering a burst of questions — and nothing on screen says which paragraph belongs to
// which question. His words: "I've sent you, like, 10 messages and not gotten a response yet."
//
// The column's previous answer to this was the receipt line "→ Replaced by your next message — never
// answered", which claims something FALSE: the concierge usually does answer, a couple of messages
// later. This module is the positive replacement — instead of asserting a message went unanswered,
// show WHERE it was answered.
//
// INFERRED, NOT DECLARED BY THE MODEL, and that choice is the load-bearing one. The alternative was
// to have the brain mark its own replies ("I am answering messages 3 and 4"). It was rejected for
// three reasons: it needs nothing from the model to work, so it cannot silently stop working when a
// turn is terse or the model forgets; the burst case is exactly when the model is LEAST likely to
// enumerate carefully; and the app already knows the answer with certainty — it knows which user
// messages it sent to the brain and which of them were still outstanding when the reply began. The
// anchors are therefore a fact about DELIVERY, which the app owns, not a claim about content, which
// it would have to trust the model for.
import type { ConciergeMessage, ConciergeUserMessage } from "./types";

/** One quoted original above a reply: the message's id (for the jump) and a one-line excerpt of it. */
export interface ReplyAnchor {
  /** The `you` message this reply is answering. May no longer be in the thread (see
   *  `conciergeThreadStore.rehydrateThread`) — the stub then renders un-clickable rather than
   *  disappearing, because the quote is still a true record of what was asked. */
  id: string;
  /** The stub's words: ONE line, whitespace collapsed, capped at {@link ANCHOR_QUOTE_MAX }.
   *
   *  A SNAPSHOT rather than a live lookup into the thread, for the same reason a sent message
   *  snapshots its `mentions` and `attachments`: the thread is trimmed from the front
   *  (CONCIERGE_THREAD_MAX) and rewritten on restore, so a reply that resolved its quote at render
   *  time would lose the quote the moment its target aged out — silently turning a reply that says
   *  what it answers into one that doesn't. It also keeps the memoised row inert: the stub is on the
   *  message object, so nothing has to be derived per tick to draw it. */
  quote: string;
}

/** How much of a message the stub carries. One line at the column's width is well under this; the cap
 *  is what stops a 4000-char paste (CONCIERGE_MSG_MAX_LEN) riding along on every reply that answers it,
 *  which is the persisted-size failure `stripDataUrls` and `boundCollapsedPayloads` exist against. */
export const ANCHOR_QUOTE_MAX = 120;

/** The most messages ONE reply will claim to answer, newest kept.
 *
 *  The natural bound is the rule itself — a reply only anchors what arrived since the last reply — so
 *  this is a backstop against a pathological burst, not the working limit. Deliberately well above the
 *  founder's "like, 10 messages": clipping the OLDEST of a burst would leave exactly the messages he is
 *  staring at looking unanswered, which is the complaint this whole affordance exists to fix. */
export const ANCHOR_MAX = 20;

/** What an attachments-only send is quoted as (its text is empty, but it is still a real message —
 *  ComposeBox's `canSend` is text OR attachments). A stub with no words is a button that says
 *  nothing; this names what was actually sent. */
export function attachmentQuote(count: number): string {
  return count === 1 ? "1 attachment" : `${count} attachments`;
}

/** A message's words as ONE line: newlines and runs of whitespace collapsed, trimmed, capped.
 *
 *  The collapse is not cosmetic. The stub is a single recessed line above the reply (the way iMessage
 *  draws a quoted original), so a multi-line paste that kept its newlines would either grow the stub
 *  into a wall or be clipped mid-line by CSS with the interesting part off-screen. Capping the STRING
 *  rather than relying on `text-overflow` also bounds what gets persisted. */
export function anchorQuote(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (line.length <= ANCHOR_QUOTE_MAX) return line;
  // Cut to the cap INCLUDING the ellipsis, so the stored string never exceeds the cap it advertises.
  return line.slice(0, ANCHOR_QUOTE_MAX - 1).trimEnd() + "…";
}

/**
 * Did this message actually reach the brain?
 *
 * ONLY a message the concierge was given may be claimed as answered. A send routed into an agent's
 * terminal (`target: "agent"`) was never seen by the brain at all, so anchoring it would be the same
 * class of lie as the "never answered" line this replaces — a confident sentence about a delivery that
 * did not happen — and it would send the founder to a reply that genuinely says nothing about it.
 *
 * A message with NO receipt yet counts as reaching it: `deliver` calls `askSparkle` before
 * `setReceipt`, so between those two statements a genuinely brain-bound message has no receipt to read.
 * Excluding it would drop the anchor for the very message being answered. Agent-bound sends are never
 * in that window with a reply arriving — they don't start a concierge turn.
 */
export function reachedTheBrain(m: ConciergeUserMessage): boolean {
  const r = m.receipt;
  if (!r) return true;
  return r.target === "sparkle" || r.alsoSentTo === "sparkle";
}

/**
 * The user messages a reply appended to `chat` RIGHT NOW would be answering, oldest first.
 *
 * The rule: walk back from the end and collect every `you` message that reached the brain, stopping at
 * the previous ANSWER. That is precisely "everything the brain still owed an answer on", which is what
 * the founder is looking at when he counts unanswered messages.
 *
 * "AN ANSWER" IS A COMPLETED, NON-PROACTIVE TURN — `settled && !proactive` — and NOT merely a
 * left-aligned bubble. That distinction is the whole correctness of this function, because three
 * different things render as one:
 *
 *   • a PUSH (`proactive`) — nobody asked for it, so it settles nothing and must not make the messages
 *     under it look answered;
 *   • an APP-AUTHORED STATUS LINE — `ConciergeHost.postSparkle` appends "Sent to Kraken Auth.",
 *     "Approving…", the deferred-send outcomes and 20-odd others as plain `sparkle` messages. Reading
 *     one as an answer truncates the outstanding set the moment the founder interleaves an
 *     agent-bound message into a burst — and note the asymmetry that would create: `reachedTheBrain`
 *     correctly skips that agent-bound `you` message, while the receipt the app posted FOR it would
 *     have ended the burst.
 *   • an ABANDONED FRAGMENT — a turn the user's next send killed mid-stream. `askSparkle` leaves a
 *     bubble that streamed text alone, on purpose, so the fragment lives in the thread forever. It
 *     answered nothing; the reply that lands next is the one worth pointing at.
 *
 * A FAILURE bubble does not stop the walk either, for the same reason as the last of those: a turn
 * that died leaves its question outstanding.
 */
export function pendingAnchors(chat: readonly ConciergeMessage[]): ReplyAnchor[] {
  const out: ReplyAnchor[] = [];
  for (let i = chat.length - 1; i >= 0; i--) {
    const m = chat[i]!;
    if (m.kind === "sparkle" && m.settled && !m.proactive) break;
    if (m.kind !== "you") continue;
    if (!reachedTheBrain(m)) continue;
    const quote = anchorQuote(m.text) || attachmentQuote(m.attachments?.length ?? 0);
    out.push({ id: m.id, quote });
    if (out.length === ANCHOR_MAX) break;
  }
  // Collected newest-first (the walk direction, which is also which end the cap keeps); rendered in
  // the order he SENT them, per the ask.
  return out.reverse();
}

/**
 * user message id → the id of the reply that answers it.
 *
 * The other half of the affordance, and the half that actually addresses the complaint: he is looking
 * at his own messages, not at the reply. Derived rather than stored on the `you` message so the two
 * directions can never disagree — one reply's `answers` array is the single record, and a message is
 * answered exactly when some reply names it.
 *
 * ONLY A SETTLED REPLY MAY MARK A MESSAGE ANSWERED — the same definition of "an answer" that
 * {@link pendingAnchors} stops at, and the two must not drift.
 *
 * A bubble is stamped with its anchors on its FIRST DELTA, so an unsettled one is a claim in progress,
 * not a delivery. Trusting it puts the marker on a turn that may never finish, and LAST-WINS does not
 * save it: that only rescues the case where a later reply names the message again, and a chain of
 * killed turns can end without one. Concretely — `you-1` is displaced before a byte arrives (so
 * `askSparkle` correctly stamps `receipt.unanswered`); turn 2 streams nine characters claiming
 * `you-1`; `you-3` kills turn 2; turn 3 fails outright, producing a `failure` bubble and no anchors at
 * all. The 2026-07-29 burst this feature exists for is exactly a run of turns dying that way. With an
 * unsettled bubble trusted, `you-1` would render an "Answered below" pointing at nine characters of a
 * dead turn — and, because the receipt withdrawal keys off this same index, would have lost the one
 * true sentence it had. Strictly worse than saying nothing.
 *
 * The visible consequence is that the marker appears when the reply FINISHES rather than when it
 * starts, which is what the word "Answered" means anyway.
 *
 * LAST WINS is kept as the safe direction rather than as load-bearing logic: with the filter above,
 * the walk's stopping rule means a settled reply ends the burst, so two settled replies naming one
 * message should be unreachable. If it ever becomes reachable, the newest claimant is the freshest
 * thing said about that message — and the ordering is pinned by a test with both replies settled,
 * because an invariant nothing enforces is one a later change can quietly invert.
 */
export function answeredByIndex(messages: readonly ConciergeMessage[]): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const m of messages) {
    if (m.kind !== "sparkle" || !m.answers || !m.settled) continue;
    // An anchor whose target did not survive restore carries `id: ""` (see {@link remapAnchors}). It
    // still draws its quote over the reply, but there is no message left to mark, and mapping the
    // empty id would put every such reply under one bogus key.
    for (const a of m.answers) if (a.id) out.set(a.id, m.id);
  }
  return out;
}

/**
 * Rewrite a reply's anchor ids through a rename, dropping the ones that no longer resolve.
 *
 * Needed because the persisted thread REINDEXES every id by position on restore
 * (`conciergeThreadStore.rehydrateThread` — ids collide with the ones a fresh session mints). An
 * anchor is an id reference, so a restored reply would otherwise point at nothing and its stub would
 * be a dead button.
 *
 * A dropped id keeps its QUOTE and loses only the jump — see {@link ReplyAnchor.id}. Returns
 * `undefined` for a reply with no anchors so a restored message doesn't grow an empty array.
 */
export function remapAnchors(
  answers: readonly ReplyAnchor[] | undefined,
  idMap: ReadonlyMap<string, string>,
): ReplyAnchor[] | undefined {
  if (!answers?.length) return undefined;
  return answers.map((a) => {
    const next = idMap.get(a.id);
    return next === undefined ? { quote: a.quote, id: "" } : { ...a, id: next };
  });
}
