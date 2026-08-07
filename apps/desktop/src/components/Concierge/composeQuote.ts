// SELECTION-TO-QUOTE, the data half. What a highlighted fragment becomes on its way from the
// transcript into the compose box, and what the brain is finally told about it. Pure: no React, no
// stores, no Tauri, so the chip's face, the wire format and the persisted stub are all derived from
// one place and cannot drift into disagreeing about the same quote.
//
// THE PROBLEM (founder, 2026-08-06). The concierge answers in long, dense replies covering many
// agents and PRs at once, and he routinely wants to answer ONE claim inside one. He has been doing
// it by hand — copy the paragraph, paste it at the top of his message, type the reply underneath —
// repeatedly, in a single session. This automates the workaround he already invented.
//
// THE MIRROR OF `replyAnchors`, ON PURPOSE. That module draws the quoted original ABOVE a concierge
// reply, saying which of his messages it is answering; his own concierge-guidelines file makes that
// a standing rule. This is the same idiom pointed the other way, so it reuses `anchorQuote` for the
// one-line face rather than inventing a second way to shorten a quote — two different ellipses on
// two halves of one visual idea is exactly the drift this note exists to prevent.
import { anchorQuote } from "./replyAnchors";

/** Which surface a quote was taken from. Decides only the chip's caption — the id is what the brain
 *  actually resolves against. */
export type QuoteSource = "sparkle" | "you" | "agent";

/** A fragment of the transcript, staged on the compose box, waiting to be sent with the reply. */
export interface ComposeQuote {
  /** THE WHOLE SELECTION, capped at {@link QUOTE_TEXT_MAX} — not the one-line face. The chip shows a
   *  line; the brain gets the words. Plain text (`sel.toString()`), never the markdown behind them:
   *  the user dragged across RENDERED words and the source string starts and ends somewhere else, so
   *  quoting the source would quote text nobody highlighted (the reasoning `useCopyOnSelection`'s
   *  header sets out at length). */
  text: string;
  /** The message this was taken from. THE INVISIBLE REF — the founder chose attribution that the
   *  brain can resolve but that does not clutter his message. Lets the concierge pull the FULL
   *  original rather than reasoning from the fragment alone. */
  sourceId: string;
  source: QuoteSource;
  /** The chip's caption: "Concierge", "You", or the agent's name. Snapshotted rather than looked up
   *  at render time for the same reason `ReplyAnchor.quote` is — the thread is trimmed from the
   *  front and rewritten on restore, so a live lookup would blank the caption the moment its target
   *  aged out. */
  label: string;
}

/**
 * How much of a selection rides along.
 *
 * A drag can sweep the whole transcript, and this string is persisted with the sent message and
 * prepended to a prompt. Both of those are places an unbounded string does real damage — the same
 * failure `stripDataUrls` and `boundCollapsedPayloads` exist against. Half of CONCIERGE_MSG_MAX_LEN
 * (4000): generous enough that no realistic quote is clipped, small enough that a runaway selection
 * cannot outweigh the message it is attached to.
 */
export const QUOTE_TEXT_MAX = 2000;

/** The caption for a quote's source. `agentName` is used only for `"agent"`, and falls back rather
 *  than rendering an empty chip when an agent's name has not resolved yet. */
export function quoteLabel(source: QuoteSource, agentName?: string): string {
  if (source === "you") return "You";
  if (source === "agent") return agentName?.trim() || "Agent";
  return "Concierge";
}

/**
 * Stage a selection as a quote, or refuse it.
 *
 * Returns `null` for a selection with no words in it. Whitespace-only selections are an accident of
 * dragging, never an intent to quote — the same judgement `useCopyOnSelection` makes before writing
 * the clipboard — and a chip that quotes nothing is a button with no meaning attached.
 *
 * The text is capped here, at the boundary, rather than at send time, so that what the chip shows,
 * what gets persisted and what the brain reads are the same string by construction.
 */
export function makeQuote(input: {
  text: string;
  sourceId: string;
  source: QuoteSource;
  agentName?: string;
}): ComposeQuote | null {
  const trimmed = input.text.trim();
  if (!trimmed) return null;
  const text =
    trimmed.length <= QUOTE_TEXT_MAX ? trimmed : trimmed.slice(0, QUOTE_TEXT_MAX - 1).trimEnd() + "…";
  return {
    text,
    sourceId: input.sourceId,
    source: input.source,
    label: quoteLabel(input.source, input.agentName),
  };
}

/** The chip's one line: whitespace collapsed, capped, ellipsised — through the SAME helper the
 *  concierge's own reply stubs use, so both halves of the idiom shorten a quote identically. */
export function quoteFace(quote: ComposeQuote): string {
  return anchorQuote(quote.text);
}

/**
 * What the brain is actually sent.
 *
 * A markdown blockquote carrying the source id, above the user's own words. The concierge is a
 * `claude -p` child, so the prompt is text and there is no structured side-channel to put the
 * reference in — the id has to travel in the prose. It is written INSIDE the quote rather than as a
 * trailing HTML comment so it cannot be separated from the fragment it describes by any later
 * reflow of the prompt.
 *
 * Every line gets its own `>`, because a bare `>` on the first line only would let a multi-line
 * quote's second paragraph read as the user's own words — turning something the concierge SAID into
 * something it will believe the founder said, which is the one misreading this feature must not
 * produce.
 */
export function quotePrompt(quote: ComposeQuote, body: string): string {
  const head = `[quoting ${quote.label}, message ${quote.sourceId}]`;
  const quoted = [head, ...quote.text.split("\n")].map((line) => `> ${line}`.trimEnd()).join("\n");
  const words = body.trim();
  return words ? `${quoted}\n\n${words}` : quoted;
}
