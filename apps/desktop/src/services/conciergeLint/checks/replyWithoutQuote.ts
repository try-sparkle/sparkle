// REPLY-WITHOUT-QUOTE — the reply did not OPEN by quoting the message it is answering.
//
// ══ THE FAILURE THIS EXISTS FOR ═════════════════════════════════════════════════════════════════
// The founder's standing rule is that every concierge reply opens with a short blockquote of his own
// words, so that when a burst of messages gets one paragraph back he can see WHICH of them is being
// answered before he reads a word of the answer. It is already written down in
// `concierge-guidelines.md`, which is injected into the system prompt on every single turn — and it
// keeps being violated anyway.
//
// That is the same shape as `ask-without-action`: a rule restated in prose does not hold, because a
// prompt rule competes for the model's attention with the task and degrades worst exactly when the
// turn is busiest — which is precisely the burst case this rule exists for. His ask was explicit:
// make it deterministic and reject-based, the way `ask-without-action` rejects. So this is a check,
// not a seventeenth guideline bullet (bead sparkle-j6jra).
//
// ══ WHY IT BLOCKS ══════════════════════════════════════════════════════════════════════════════
// `block`, and `askWithoutAction`'s argument transfers without modification: the compliant form is a
// DIFFERENT REPLY — one that opens with the quote — so there is nothing here to autofix. The app
// could prepend a blockquote mechanically, and that is exactly the wrong move: it would be the app
// writing the founder's words into the concierge's mouth, and the quote's whole value is that the
// model demonstrably read the message it is answering. Only the model can produce the compliant
// form, so the reply is held and re-prompted once.
//
// ══ WHAT IT NEEDS, AND WHERE THAT COMES FROM ═══════════════════════════════════════════════════
// `ctx.founderMessages` — the message(s) this reply is answering, oldest first, empty when it
// answers nothing. It is NOT derived here. `Concierge/replyAnchors.pendingAnchors` already decides
// that question for the anchor stub the thread draws over every reply, and it already solves the two
// cases that would otherwise be wrong here: a proactive push anchors nothing (so this check stands
// down on it), and a queued burst collects the whole outstanding run. A second derivation would be a
// second answer to a question the app already answers, and the two would eventually disagree about
// what the founder said.
//
// ══ THE FOUR EDGE CASES, AND WHAT EACH ONE COST ════════════════════════════════════════════════
//  1. PROACTIVE PUSHES. `founderMessages` is empty and the check returns clean. Handled upstream by
//     `isProactiveTurn`, and re-asserted here as a guard rather than trusted.
//  2. A QUEUED BURST. Every message in the array must be represented in the opening quotes — see
//     `coverage()` for the measure and for why partial coverage is a violation rather than a pass.
//  3. TOOL-REFUSAL RELAYS ("Not sent to Kraken Auth — that terminal is in full-screen mode"). These
//     CANNOT REACH THIS CHECK AT ALL, confirmed rather than assumed: every one of them is posted by
//     `ConciergeHost.postSparkle`, whose own header says "Every postSparkle line is BOOKKEEPING — a
//     send outcome, a refusal, a deferred reconciliation — never a brain reply". It appends a plain
//     `sparkle` message straight to the thread. The linter only ever sees `e.text` from a concierge
//     turn's `done` event, so no special case is needed here and none is written.
//  4. DICTATED FOUNDER TEXT. He talks to this app, so his messages arrive with stutters, repeated
//     clauses and mid-sentence self-corrections ("I said drodeo.com not jury.com, drodio.com"). The
//     compliant reply quotes the CLEANED sentence, which is not a byte-exact substring of anything
//     he said — so an exact-match test would block the correct reply. See {@link overlapCoefficient}.
//
// ══ WHAT IT DELIBERATELY DOES NOT CHECK ════════════════════════════════════════════════════════
// That the quote is VERBATIM. A quote is a summary with `>` in front of it as often as not, and the
// rule the founder is enforcing is "show me you read what I sent", not "reproduce my keystrokes".
// A similarity floor is what this can honestly decide; typographic fidelity is not.

import { fromMarkdown } from "mdast-util-from-markdown";
import type { Check, LintContext, Severity, Violation } from "../types";

/** The check id. Must equal the `[concierge.checks.<id>]` table key in `config.toml`. */
export const REPLY_WITHOUT_QUOTE_CHECK_ID = "reply-without-quote";

/**
 * How much of a founder message the opening quote must share with it to count as quoting it.
 *
 * Documented the way `ANCHOR_QUOTE_MAX` is, because the number is a judgement and the judgement is
 * the load-bearing part. 0.6 is set from BOTH directions of the real data:
 *
 *   • THE FLOOR IT MUST CLEAR. A cleaned quote of dictated speech drops the stutters, the filler and
 *     the abandoned half-sentence — measured against real dictated messages that is roughly a
 *     quarter to a third of the content words gone. A threshold at 0.8 blocks the compliant reply,
 *     and a blocking false positive costs the founder a whole turn on a reply that was already
 *     right, which this subsystem calls its costly error.
 *   • THE CEILING IT MUST NOT EXCEED. Two sentences about different subjects share almost no content
 *     words once the stopwords are gone — an unrelated quote scores near zero, not near 0.5. So the
 *     gap between "a cleaned quote" and "a different topic" is wide, and 0.6 sits in the middle of
 *     it rather than at either edge.
 *
 * Both sides are pinned by tests: a stuttered message with a cleaned quote passes, and an unrelated
 * quote of that same message is blocked.
 */
export const QUOTE_MATCH_MIN = 0.6;

/**
 * A "founder message" that the app wrote, not the founder.
 *
 * `anchorQuote`'s fallback chain ends at `attachmentQuote`, so a send that was nothing but files is
 * quoted as "2 attachments" — the app's own description of it. Demanding a blockquote of that would
 * block a reply whose compliant form does not exist, which is the one error this check is not
 * allowed to make. Anchored at both ends so it cannot swallow a real message that merely mentions
 * attachments; pinned against `attachmentQuote` itself by a test, so a change over there turns this
 * exemption red rather than off.
 */
export const APP_AUTHORED_QUOTE_RE = /^\d+ attachments?$/i;

/**
 * Words carried by both any two English sentences, dropped before measuring similarity.
 *
 * Without this the measure is trivially satisfiable: "> can you, and I can do that" shares five
 * words with almost every message the founder sends, so any `>` line would clear the floor and the
 * check would degrade into "does the reply start with a blockquote" — which is the check one
 * paragraph shallower than the one he asked for. Kept deliberately short and generic: a domain word
 * ("merge", "DNS", "agent") is exactly the signal being measured and must never be listed here.
 */
const STOPWORDS = new Set([
  "a", "about", "all", "also", "am", "an", "and", "any", "are", "as", "at", "be", "been", "but",
  "by", "can", "could", "did", "do", "does", "for", "from", "get", "had", "has", "have", "he",
  "her", "him", "his", "i", "if", "in", "into", "is", "it", "its", "just", "me", "my", "no", "not",
  "of", "on", "one", "or", "our", "out", "over", "please", "s", "she", "should", "so", "some",
  "t", "than", "that", "the", "their", "them", "then", "there", "these", "they", "this", "those",
  "to", "up", "us", "was", "we", "were", "what", "when", "which", "who", "will", "with", "would",
  "you", "your",
]);

/** The shape this module walks — structural, matching `mdast.ts`'s own `MdastNode` and for the same
 *  reason: four fields are enough and the linter stays free of a type dependency on the renderer's
 *  stack. */
interface MdastNode {
  type: string;
  value?: string;
  children?: MdastNode[];
}

/** Every `value` under a node, joined — a blockquote's words as a reader sees them. */
function nodeText(node: MdastNode): string {
  if (typeof node.value === "string") return node.value;
  return (node.children ?? []).map(nodeText).join(" ");
}

/**
 * The reply's OPENING run of blockquotes, as one string. `""` when the reply does not open with one.
 *
 * PARSED, NOT PATTERN-MATCHED, for the reason `mdast.ts`'s header gives at length: a hand-rolled
 * `^>` scan disagrees with the renderer in both directions, and here it would disagree in the
 * expensive one — a lazy continuation line (a bare line directly under a `>` line, which CommonMark
 * folds into the quote) would read as prose and BLOCK a compliant reply. `fromMarkdown` is the same
 * parser `mdast.ts` runs, so there is one grammar in this subsystem and not two.
 *
 * THE RUN, not just the first node: two quotes separated by a blank line are two `blockquote`
 * children, and a reply answering a burst of two messages will often be written exactly that way.
 * The run STOPS at the first non-blockquote child — a blockquote further down the reply is not an
 * opening, which is the whole point of the rule (a quote buried under a preamble is the shape the
 * founder is objecting to).
 *
 * Leading blank lines are not children of anything, so a reply that starts with them still opens
 * with its quote. Returns `""` rather than throwing on unparseable input: this runs on
 * model-authored markdown inside a linter that must never be able to lose a reply.
 */
export function leadingQuoteCorpus(text: string): string {
  let tree: MdastNode;
  try {
    tree = fromMarkdown(typeof text === "string" ? text : "") as unknown as MdastNode;
  } catch {
    return "";
  }
  const parts: string[] = [];
  for (const child of tree.children ?? []) {
    if (child.type !== "blockquote") break;
    parts.push(nodeText(child));
  }
  return parts.join(" ");
}

/** A string as its content words: lowercased, punctuation dropped, whitespace collapsed, stopwords
 *  removed. Falls back to the full token set when stripping the stopwords would leave nothing — a
 *  message made entirely of common words is still a message, and scoring it 0 would block a reply
 *  that quoted it perfectly. */
function contentTokens(value: string): Set<string> {
  const all = (typeof value === "string" ? value : "")
    .toLowerCase()
    // Everything that is not a letter, a digit or a `.` becomes a break. The `.` survives so a
    // hostname stays one token — `drodio.com` vs `jury.com` is exactly the distinction a
    // self-correcting dictated message turns on.
    .replace(/[^a-z0-9.]+/g, " ")
    // …but a `.` that is not BETWEEN two alphanumerics is a full stop, not part of a word.
    .replace(/(^|\s)\.+|\.+(?=\s|$)/g, "$1")
    .split(/\s+/)
    .filter((w) => w.length > 0);
  const content = all.filter((w) => !STOPWORDS.has(w));
  return new Set(content.length > 0 ? content : all);
}

/**
 * How much two strings say the same thing: shared content words over the SMALLER of the two sets.
 *
 * The overlap coefficient rather than Jaccard or one-directional containment, because the two sides
 * are asymmetric in BOTH directions depending on the turn and the check has to survive each:
 *
 *   • ONE LONG MESSAGE, A SHORT QUOTE. He sends a paragraph; the compliant reply opens with a
 *     one-line excerpt of it. The excerpt is the smaller set, so this measures "is the quote drawn
 *     from the message" — which is the right question. Jaccard would score this near zero and block
 *     the compliant reply.
 *   • A BURST OF SHORT MESSAGES, ONE COMBINED QUOTE. Three sends answered by one opening quote that
 *     covers all three. Each message is now the smaller set, so this measures "is this message
 *     present in the quote" — again the right question, and again the opposite direction from the
 *     case above.
 *
 * Both are real and both must pass, which is what rules out either one-directional test.
 *
 * Returns 0..1, and 0 when either side has no words at all.
 */
export function overlapCoefficient(a: string, b: string): number {
  const left = contentTokens(a);
  const right = contentTokens(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const w of left) if (right.has(w)) shared++;
  return shared / Math.min(left.size, right.size);
}

/** The founder messages this check is entitled to demand a quote of. */
function quotableMessages(messages: readonly string[] | undefined): string[] {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((m): m is string => typeof m === "string")
    .map((m) => m.trim())
    .filter((m) => m.length > 0 && !APP_AUTHORED_QUOTE_RE.test(m));
}

export const replyWithoutQuoteCheck: Check = {
  id: REPLY_WITHOUT_QUOTE_CHECK_ID,
  run(text: string, ctx: LintContext): { text: string; violations: Violation[] } {
    const policy = ctx?.policy?.checks?.[REPLY_WITHOUT_QUOTE_CHECK_ID];
    const severity: Severity = policy?.severity ?? "block";

    // NOTHING TO QUOTE, NOTHING TO CHECK — a proactive push, or a send whose only content was
    // attachments. Checked first because it is the cheap way out and it is the case that must never
    // produce a finding.
    const messages = quotableMessages(ctx?.founderMessages);
    if (messages.length === 0) return { text, violations: [] };

    const quote = leadingQuoteCorpus(text);
    // EVERY message in the burst has to be represented, not just one of them. A reply that quotes
    // the first of three and answers all three leaves the other two looking exactly as unanswered as
    // they did before the quote existed, which is the complaint the rule was written for.
    const covered = quote
      ? messages.filter((m) => overlapCoefficient(quote, m) >= QUOTE_MATCH_MIN).length
      : 0;
    if (covered === messages.length) return { text, violations: [] };

    return {
      text,
      violations: [
        {
          check: REPLY_WITHOUT_QUOTE_CHECK_ID,
          severity,
          // `"warned"` at detection time, like every other check here: only the component that
          // performs a revision may honestly claim one (roborev 55981). The mount upgrades it.
          action: "warned",
          // METADATA ONLY — the character COUNT of the opening quote that was found wanting, and 0
          // when there was no opening quote at all. Never the quote itself: `Violation.span` is a
          // count by contract, and the founder's own words are the last thing that should travel
          // out of this subsystem into a log.
          span: quote.length,
          // Counts and fixed words. ONE violation for the reply rather than one per uncovered
          // message: "this reply did not open by quoting me" is a single failure, and counting it
          // per message would inflate the one number this whole feature exists to make trustworthy.
          detail:
            quote.length === 0
              ? `did not open with a blockquote of the ${messages.length} message(s) it answers`
              : `opened with a quote that matched ${covered} of ${messages.length} message(s) it answers`,
        },
      ],
    };
  },
};
