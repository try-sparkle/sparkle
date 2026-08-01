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
 * the previous REPLY. That is precisely "everything the brain still owed an answer on", which is what
 * the founder is looking at when he counts unanswered messages.
 *
 * Two things deliberately do NOT stop the walk:
 *   • a PUSH (`proactive`) — nobody asked for it, so it settles nothing and must not make the messages
 *     under it look answered;
 *   • a FAILURE bubble — a turn that died leaves its question outstanding, and the reply that finally
 *     lands is exactly the one worth pointing at.
 */
export function pendingAnchors(chat: readonly ConciergeMessage[]): ReplyAnchor[] {
  const out: ReplyAnchor[] = [];
  for (let i = chat.length - 1; i >= 0; i--) {
    const m = chat[i]!;
    if (m.kind === "sparkle" && !m.proactive) break;
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
 * FIRST WINS. A later reply may name the same message again (the same burst is outstanding until
 * something replies); the earliest answer is the one worth jumping to.
 */
export function answeredByIndex(messages: readonly ConciergeMessage[]): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const m of messages) {
    if (m.kind !== "sparkle" || !m.answers) continue;
    // An anchor whose target did not survive restore carries `id: ""` (see {@link remapAnchors}). It
    // still draws its quote over the reply, but there is no message left to mark, and mapping the
    // empty id would put every such reply under one bogus key.
    for (const a of m.answers) if (a.id && !out.has(a.id)) out.set(a.id, m.id);
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
