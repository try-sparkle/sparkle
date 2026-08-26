// Social Coding — the PURE half of the CHAT PANE's thread (bead `sparkle-xnjil.10`; design
// `docs/superpowers/specs/2026-08-05-social-coding-design.md` §9 row U5).
//
// No React, no IO, no store, no `socialApi`. Everything here is a decision the pane has to make on
// every render and that a test must be able to make without a DOM: the two `useAutoFollow` keys,
// what counts as a sendable body, and the transport-shaped types the pane takes as an INJECTED
// seam.
//
// ── WHY THE TRANSPORT IS A TYPE HERE AND A CALL NOWHERE ─────────────────────────────────────────
// The server half of this feature (S4: conversations, messages, HTTP send, socket notify) is being
// built in parallel with the pane. So the pane may not reach for `services/socialApi` — it takes a
// {@link ChatThreadSource} and calls what it is handed. Declaring the shape here rather than inside
// the component is what lets S4's real transport be written against it, and tested against it,
// before either side can import the other.
//
// ── R3 IS ABSOLUTE, AND THIS MODULE IS WHERE IT IS CHEAPEST TO SEE ──────────────────────────────
// "Chat text never reaches agent stdin" (design §9 "Do NOT defer"). There is exactly one way a
// string reaches a PTY in this app — the `pty_write` Tauri command — and NOTHING in this module or
// in `ChatPane` may reach it, directly or through `conciergeDispatch`. A person's words go to
// {@link ChatThreadSource.send} and nowhere else. `ChatPane.r3.test.tsx` asserts that as a side
// effect rather than as a promise.
import type { Attachment } from "../components/composer/attachments";

/**
 * One message in a person thread, AS THE PANE NEEDS IT — not as the wire carries it.
 *
 * Deliberately NOT `socialApi.MessageRow`. That type is the server's (`conversationId`, `seq`,
 * `blocks`, a `from` USERNAME) and the pane needs none of it; what the pane needs is which side of
 * the thread a bubble sits on, which is a question about the VIEWER that no server row answers by
 * itself. Adapting the row is the transport's job, so a change to the wire shape stops at the seam
 * instead of reaching every bubble.
 */
export interface ChatMessage {
  /** Stable within the thread. An optimistic echo may mint its own until the server answers. */
  id: string;
  /**
   * TRUE when the signed-in user wrote it. A boolean rather than an author id compared at render
   * time: "which side is this on" is decided once, by the code that knows who we are, instead of
   * at every bubble by a comparison each call site could get wrong in its own way.
   */
  mine: boolean;
  /** How to label the other party — a display name or a username. Empty for one's own messages. */
  author: string;
  /** The message body as markdown. Rendered through `Markdown`, never `dangerouslySetInnerHTML`. */
  body: string;
  /** ISO-8601. Ordering is the transport's job; this is for display only. */
  createdAt: string;
  /** An optimistic echo the server has not acknowledged yet. */
  pending?: boolean;
  /** The send failed. Kept in the thread rather than dropped, so the words are not lost. */
  failed?: boolean;
}

/**
 * The optional half of a send, TAKEN FROM DAY ONE AND IGNORED.
 *
 * `@mentions` and media are deferred (design §9 stage D, bead `sparkle-xnjil.17`) and both are
 * things the founder asked for by name, so they are certain to arrive. A send signature that has to
 * grow a second parameter later is a change to the pane, the seam, every test double and the
 * transport at once; a signature that already carries them is a change to the transport alone.
 *
 * Nothing reads these today. That is the point — a field nobody reads costs nothing, and a
 * signature nobody can extend without touching four files costs a lot.
 */
export interface ChatSendExtras {
  /** Usernames `@`-named in the body. Deferred: the composer does not produce these yet. */
  mentions?: readonly string[];
  /** Files riding along. Deferred: the pane has no attach affordance yet. Reuses the composer's
   *  own `Attachment` rather than declaring a second one — a second shape is how two surfaces come
   *  to disagree about what a dropped file is. */
  attachments?: readonly Attachment[];
}

/** What a send did. A value rather than a throw: a failed send must leave the words on screen, and
 *  an exception crossing a submit handler is how they get lost instead. */
export type ChatSendResult = { ok: true } | { ok: false; reason: string };

/**
 * Where a thread's messages come from and where its sends go — THE INJECTED SEAM.
 *
 * `ChatPane` takes a hook returning this and calls it. The default (see
 * {@link ChatPane}'s `useThread` prop) is the honest no-transport implementation; S4 replaces it
 * with the real one and no signature moves.
 */
export interface ChatThreadSource {
  /** Oldest first. The pane does not sort — see {@link ChatMessage.createdAt}. */
  messages: readonly ChatMessage[];
  /** `"unwired"` means no transport is attached at all (the default seam), which is a different
   *  state from "loaded and empty" and must not paint like one. */
  state: "unwired" | "loading" | "ready" | "error";
  /** A sentence for the reader when `state === "error"`. */
  error?: string | null;
  /** Send one message. Never throws — see {@link ChatSendResult}. */
  send: (body: string, extras?: ChatSendExtras) => Promise<ChatSendResult>;
  /** Backwards paging, handed straight to `useAutoFollow`. Optional: a transport with no history
   *  endpoint simply omits it. */
  onReachTop?: () => void;
}

/** Can this composer body be sent? Whitespace-only is not a message, and the trim is what a caller
 *  must send — so the two answers come from one function rather than two spellings of a trim. */
export function sendableBody(raw: string): string | null {
  const body = raw.trim();
  return body.length === 0 ? null : body;
}

/**
 * `useAutoFollow`'s `contentKey` for a person thread.
 *
 * ITS CONTRACT IS "a string that changes whenever the RENDERED CONTENT changes — not the array
 * identity", and the identity form is bead `sparkle-y4ft`: a host that rebuilds its array every
 * tick scrolls the column on every click. So this folds in everything a bubble paints — the count,
 * the newest id, the total text length, and the pending/failed flags — and nothing that it does
 * not.
 *
 * TOTAL LENGTH IS THE ONE THAT IS EASY TO OMIT and the one that matters most here: a message whose
 * body is edited in place by an ack (an optimistic echo replaced by the server's own flattening)
 * changes neither the count nor the last id, and a follow that misses it strands the reader one
 * bubble short of the bottom.
 */
export function chatContentKey(messages: readonly ChatMessage[]): string {
  let chars = 0;
  let flags = 0;
  for (const m of messages) {
    chars += m.body.length;
    // Two bits per message, folded POSITIONALLY — `h = h * 31 + bits`, not `h += bits`. A plain sum
    // is symmetric, so two messages exchanging states (one settles as another fails, in one tick)
    // nets to the same total and the key does not move while both bubbles repaint. `>>> 0` keeps it
    // a 32-bit unsigned int rather than drifting into float territory on a long thread.
    const bits = (m.pending ? 1 : 0) | (m.failed ? 2 : 0);
    flags = (Math.imul(flags, 31) + bits) >>> 0;
  }
  const last = messages[messages.length - 1];
  return `${messages.length}:${last?.id ?? ""}:${chars}:${flags}`;
}

/**
 * `useAutoFollow`'s `rearmKey`: the newest message the VIEWER wrote.
 *
 * The hook's own docstring names the trap — "Never pass a boolean 'a user message exists' — that
 * re-arms on every tick and restores sparkle-y4ft in full." So this is an ID, and it is the id of a
 * message with `mine: true` only: a peer's message arriving must never yank a reader who has
 * scrolled up, which is the entire reason the follow can be disarmed at all.
 *
 * Empty string when the viewer has said nothing yet — the hook reads `""` as "nothing to re-arm on".
 */
export function chatRearmKey(messages: readonly ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.mine) return m.id;
  }
  return "";
}
