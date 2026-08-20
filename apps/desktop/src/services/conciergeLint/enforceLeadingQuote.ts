// ENFORCE-LEADING-QUOTE — the DETERMINISTIC FLOOR under the `reply-without-quote` check.
//
// ══ WHY THIS EXISTS ═════════════════════════════════════════════════════════════════════════════
// `reply-without-quote` (checks/replyWithoutQuote.ts) makes it a BLOCKING finding when a reply does
// not open by quoting the founder's message — the reply is held and the model is re-prompted ONCE.
// That check's own header argues against prepending a quote mechanically, on the ground that the
// quote's value is that "the model demonstrably read the message". That value is real, and the block
// path preserves it: when the correction lands a compliant reply, its OWN quote renders and this
// module stands down (`inserted: false`).
//
// But "re-prompted ONCE" is still an instruction the model can ignore, and every give-up exit then
// renders the reply UNQUOTED and marked (ConciergeHost `settleHold`, and the blocked-but-could-not-
// hold path). The founder's standing complaint is exactly that shape: the reply "launches into
// analysis" without saying which of his messages it is answering, and asking it to quote — in the
// guidelines, in the persona, and now in a re-prompt — has not made it unavoidable. A prompt
// instruction, however it is delivered, is not a structural guarantee.
//
// So this is the floor the check needed: when a founder-facing reply is about to be RENDERED and it
// STILL does not open by quoting the message(s) it answers, the pipeline prepends a blockquote of
// the founder's own words — inserted by CODE, so it is literally always present. The model's analysis
// follows underneath. The reconciliation with the check's philosophy is that this fires ONLY on the
// model's failure: a reply that quotes on its own (first pass or corrected) never reaches the prepend.
//
// ══ ONE COVERAGE RULE, TWO READERS ══════════════════════════════════════════════════════════════
// Coverage is decided by the SAME functions the check judges by — `leadingQuoteCorpus`,
// `overlapCoefficient`, `QUOTE_MATCH_MIN`, `quotableMessages` — so the enforcer can never disagree
// with the check about whether a reply already quotes a message, and can never prepend a blockquote
// of a message the check would have stood down on (a proactive push carries no founder messages; an
// attachments-only send is quoted "2 attachments", which `quotableMessages` drops).
import {
  QUOTE_MATCH_MIN,
  leadingQuoteCorpus,
  overlapCoefficient,
  quotableMessages,
} from "./checks/replyWithoutQuote";

/** The outcome of {@link ensureLeadingFounderQuote}. `inserted` is what the caller reads to decide
 *  whether to drop the now-satisfied `reply-without-quote` MARK: a reply the code just made quote
 *  must not also carry "Didn't open by quoting what you said". The telemetry that the model failed is
 *  recorded upstream regardless — this only governs what the founder is SHOWN. */
export interface EnsureLeadingQuoteResult {
  /** The reply text, with a leading blockquote prepended iff `inserted`. */
  text: string;
  /** True when a blockquote was prepended (the reply did not already quote every message it answers). */
  inserted: boolean;
}

/**
 * Guarantee that a founder-facing reply OPENS by quoting the message(s) it answers.
 *
 * Returns the text UNCHANGED when there is nothing to quote (a proactive push, or an attachments-only
 * send) or when the reply already covers every founder message it answers. Otherwise returns a copy
 * with a blockquote of the UNCOVERED messages prepended — one `> …` line each, then a blank line,
 * then the original reply. Prepending only the uncovered ones matches the compliant form the check
 * asks for ("one for each message you are answering") without duplicating a quote the model did land.
 *
 * `founderQuotes` are the anchor excerpts the thread already computed for this reply
 * (`ReplyAnchor.quote` — one line, whitespace-collapsed, capped), which is why each becomes a clean
 * single blockquote line here. Pure: no I/O, no throwing — the reply is the product.
 */
export function ensureLeadingFounderQuote(
  text: string,
  founderQuotes: readonly string[],
): EnsureLeadingQuoteResult {
  const safeText = typeof text === "string" ? text : "";
  const messages = quotableMessages(founderQuotes);
  if (messages.length === 0) return { text: safeText, inserted: false };

  const corpus = leadingQuoteCorpus(safeText);
  // The messages this reply does NOT already quote (below the same floor the check uses). An empty
  // corpus scores 0 against every message, so a reply that opens with no quote leaves all of them
  // uncovered — which is the give-up shape this floor exists for.
  const uncovered = messages.filter((m) => overlapCoefficient(corpus, m) < QUOTE_MATCH_MIN);
  if (uncovered.length === 0) return { text: safeText, inserted: false };

  const block = uncovered.map((m) => `> ${m}`).join("\n");
  // A give-up reply always has text; the empty-text branch is defensive so the prepend is never a
  // dangling blockquote with nothing under it.
  const prefixed = safeText.trim().length > 0 ? `${block}\n\n${safeText}` : block;
  return { text: prefixed, inserted: true };
}
