// DOES THE REPLY'S OWN OPENING QUOTE ALREADY SAY WHAT THE STUB WOULD SAY?
//
// ══ THE DEFECT ══════════════════════════════════════════════════════════════════════════════════
// The founder sent a screenshot of one question quoted back at him TWICE, stacked (2026-08-17,
// bead sparkle-y3ptuf):
//
//     | What did you find out about Epic versus tasks?      ← ReplyAnchorStubs, 2px muted gray
//  [copy] | What did you find out about Epic versus tasks?  ← the concierge's own markdown quote
//     The sweep came back. They're one system, not two…
//
// His words: *"There's a bad UX here you're quoting. My question twice So I want it to be the blue
// bar quote and not the gray bar quote… I want it to be the blue bar that has the copy next to it."*
//
// TWO INDEPENDENT SUBSYSTEMS BOTH DECIDED TO QUOTE HIM, neither aware of the other. `./replyAnchors`
// INFERS what a reply is answering and `./ReplyAnchorViews` draws the gray stub over it; separately,
// `services/conciergeLint/checks/replyWithoutQuote` BLOCKS any reply that does not open with a
// markdown blockquote of the same message, and `Markdown.tsx` paints that blockquote with
// `C.tealInk` — the blue bar he is pointing at. Both are correct in isolation. Together they are the
// same sentence twice.
//
// ══ WHAT THIS MODULE DECIDES, AND WHY IT IS A MEASUREMENT ══════════════════════════════════════
// The suppression is gated on CONTENT, not on position, and that is the load-bearing choice. The
// concierge quotes plenty of things that are NOT the founder — agent terminal output, a file, a line
// of its own from earlier — and a reply may open with one of those:
//
//     | why is CI red?                    ← still the stub's job: he asked this, nothing else says so
//  [copy] | ok 47 passed | 2 failed       ← the concierge quoting an agent's scrollback
//     CI is failing on a payment block, not your tests.
//
// A rule that only asked "does the reply open with a blockquote" would delete the stub there and
// leave his actual question nowhere on screen. So the test is whether the OPENING quote demonstrably
// overlaps the message(s) the app already knows this reply answers — and the measure is the linter's
// own, imported rather than reimplemented.
//
// ONE MEASURE, ONE THRESHOLD, DELIBERATELY SHARED. `replyWithoutQuote` is what forces the blue quote
// to exist; this module is what hides the gray one because it exists. If they measured "quotes him"
// differently the two would disagree in exactly the case that matters — a quote the linter accepted
// but this module scored below its own floor would draw BOTH bars again, which is the reported bug
// returning through the fix for it. Importing `overlapCoefficient`, `QUOTE_MATCH_MIN` and
// `leadingQuoteCorpus` makes that disagreement unrepresentable rather than merely unlikely.
//
// ══ WHY THE STUB IS KEPT WHENEVER THE MEASURE FAILS ════════════════════════════════════════════
// `reply-without-quote`'s severity is CONFIGURABLE (`[concierge.checks.reply-without-quote]` in
// config.toml), so "every reply opens with a quote" is a policy, not an invariant. Turn it down to
// `warn` and unquoted replies ship. The stub is therefore the fallback, not the thing being removed:
// a reply that did not quote him keeps its gray anchor and loses nothing. Blue when there is a blue
// bar; gray when there isn't; never both.
import {
  APP_AUTHORED_QUOTE_RE,
  QUOTE_MATCH_MIN,
  leadingQuoteCorpus,
  overlapCoefficient,
} from "../../services/conciergeLint/checks/replyWithoutQuote";
import type { ReplyAnchor } from "./replyAnchors";

/** A CommonMark block quote marker line: `>` under at most three spaces of indentation. */
const QUOTE_LINE_RE = /^ {0,3}>/;

/**
 * THE LEADING RUN OF QUOTE LINES, as a string — a cheap prefix, not a parse.
 *
 * ══ WHY A SCAN EXISTS AT ALL, GIVEN THE PARSER ═════════════════════════════════════════════════
 * `leadingQuoteCorpus` parses, and it should: a hand-rolled `^>` scan disagrees with the renderer in
 * both directions, and here it would disagree in the expensive one (a lazy continuation line reads
 * as prose and blocks a compliant reply). Nothing about that changes — the parse is still what
 * decides. This only chooses WHAT TO HAND IT.
 *
 * The reason is streaming. `ConciergeMessageRow` is memoised, but `m.text` genuinely changes on
 * every delta, so parsing the whole reply here would run a second full `fromMarkdown` per token
 * beside the renderer's own — doubling the markdown parse cost of every turn to re-answer a question
 * whose input stopped changing at the reply's first blank line. Handing the parser only the leading
 * run makes the memo key STABLE the moment prose begins, so the coverage answer is computed a
 * handful of times per reply rather than once per token.
 *
 * ══ IT IS A SUPERSET, AND THAT IS WHAT MAKES IT SAFE ═══════════════════════════════════════════
 * The scan never has to be exact, only never SHORT: `leadingQuoteCorpus` stops at the first
 * non-blockquote child, so handing it a line or two too many changes nothing it returns. That is why
 * a non-blank line under a quote line is kept — CommonMark folds it into the quote as a lazy
 * continuation, and the parser is the one entitled to decide whether it did. Only a BLANK line
 * followed by prose ends the run, which is exactly how the concierge spells the shape this feature
 * is about (`> quote`, blank, answer).
 *
 * Returns `""` when the text does not open with a quote at all, which is most replies and is decided
 * on the first line without touching the rest.
 */
export function leadingQuoteSource(text: string): string {
  const source = typeof text === "string" ? text : "";
  const lines = source.split("\n");
  let i = 0;
  // Leading blank lines are children of nothing, so a reply that starts with them still opens with
  // its quote — the same allowance `leadingQuoteCorpus`' header makes.
  while (i < lines.length && lines[i]!.trim() === "") i++;
  if (i >= lines.length || !QUOTE_LINE_RE.test(lines[i]!)) return "";
  const start = i;
  let end = i; // exclusive, and only ever advanced past a line we have decided to keep
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "") {
      // A blank line ENDS a blockquote — but two blockquotes separated by one are still adjacent
      // siblings, which is both what `remarkMergeQuotes` folds into a single bar and what
      // `leadingQuoteCorpus` keeps walking. So look past the blanks: another quote line means the
      // run continues, anything else means prose has started and the opening is over.
      let j = i;
      while (j < lines.length && lines[j]!.trim() === "") j++;
      if (j >= lines.length || !QUOTE_LINE_RE.test(lines[j]!)) break;
      i = j;
      continue;
    }
    i++;
    end = i;
  }
  return lines.slice(start, end).join("\n");
}

/**
 * Does an already-extracted leading run quote every message the reply is answering?
 *
 * Split from {@link leadingQuoteCovers} so a caller on the streaming path can memoise on the RUN —
 * which stops changing at the reply's first blank line — instead of on the reply text, which does
 * not. Both entry points measure identically; this is the one with a stable input.
 *
 * `false` for a reply that anchors nothing (a proactive push, the first line of a session): there is
 * no stub to suppress and so nothing to be duplicated by.
 *
 * EVERY anchor must be covered, not merely one. This mirrors `replyWithoutQuote`'s coverage rule and
 * for the same reason: a reply that quotes the first of a burst of three and answers all three
 * leaves the other two looking exactly as unanswered as they did before. Suppressing the stub on
 * partial coverage would take away the only on-screen record of the two it skipped.
 *
 * APP-AUTHORED ANCHORS ARE DROPPED FIRST, exactly as the linter drops them, and this is the one
 * place the two modules could silently disagree. An attachments-only send is anchored as the app's
 * own description of it ("2 attachments" — see `replyAnchors.attachmentQuote`), which no genuine
 * quotation of his words will ever overlap. `replyWithoutQuote` therefore removes those anchors in
 * `quotableMessages` BEFORE demanding coverage, and this must do the same.
 *
 * An earlier version of this function did not, on the reasoning that an unquotable anchor scores
 * below the floor anyway and so "disposes of the app-authored case without a special case". That
 * holds only when EVERY anchor is app-authored. In a MIXED burst — an attachments-only send plus a
 * text send — the linter drops the attachments anchor and accepts a reply that quotes the words;
 * `every` over the unfiltered list still sees the "2 attachments" anchor at 0.0 and returns false.
 * The stub then draws beside the blue bar and the founder's question is quoted twice again: the
 * reported defect returning through its own fix, in the one case the tests did not cover.
 *
 * Filtering to nothing is `false`, not vacuous truth — `every` on an empty array is `true`, which
 * would suppress the stub for an attachments-only send whose blue bar cannot carry it.
 */
export function quoteSourceCovers(quoteSource: string, anchors?: readonly ReplyAnchor[]): boolean {
  if (!anchors?.length) return false;
  const quote = leadingQuoteCorpus(typeof quoteSource === "string" ? quoteSource : "");
  if (!quote) return false;
  const quotable = anchors.filter((a) => !APP_AUTHORED_QUOTE_RE.test((a.quote ?? "").trim()));
  if (!quotable.length) return false;
  return quotable.every((a) => overlapCoefficient(quote, a.quote ?? "") >= QUOTE_MATCH_MIN);
}

/**
 * WHICH anchors still need a gray stub — the render-level answer, of which {@link quoteSourceCovers}
 * is only the summary.
 *
 * Suppression used to be all-or-nothing over `m.answers`, which was right while coverage was also
 * all-or-nothing. Filtering app-authored anchors out of the MEASURE broke that correspondence: in a
 * mixed burst the reply quotes the text send, coverage is `true`, and every stub disappears — taking
 * with it the only visible trace of the attachments-only send, which the blue bar's rendered text
 * does not represent. (Its `aria-label` names it, but a label is not on screen.) That is exactly what
 * this module's own doctrine forbids two paragraphs up: partial coverage must not remove the record
 * of what was skipped.
 *
 * So the app-authored anchors the measure sets aside are kept as stubs, and everything else follows
 * the old rule — no stubs when the quote covers the words, all stubs when it does not.
 */
export function stubAnchorsFor(
  quoteSource: string,
  anchors?: readonly ReplyAnchor[],
): readonly ReplyAnchor[] {
  return partitionAnchors(quoteSource, anchors).stub;
}

/**
 * WHICH anchors the BLUE BAR stands for — the ones its rendered text actually quotes.
 *
 * The exact complement of {@link stubAnchorsFor}, and it has to be, because the bar's jump target
 * and its accessible name are both derived from it. Deriving them from the FULL anchor list instead
 * is a defect this module already shipped once: in a mixed burst the bar renders his question but
 * `quoteJumpTarget` returned the first anchor with an id — the attachments send — so clicking the
 * quote of his question scrolled to the image, the surviving gray stub pointed at that same message,
 * NOTHING on the row could reach his question, and the bar announced itself to a screen reader as
 * "Replying to 2 of your messages, starting with: 2 attachments". The affordance the whole feature
 * exists to preserve was the one thing unreachable.
 *
 * Empty when the quote covers nothing: there is no bar standing in for anything, so there is no jump
 * to offer and every anchor keeps its stub.
 */
export function barAnchorsFor(
  quoteSource: string,
  anchors?: readonly ReplyAnchor[],
): readonly ReplyAnchor[] {
  return partitionAnchors(quoteSource, anchors).bar;
}

/**
 * The single split both accessors read, so "what the bar shows" and "what still needs a stub" cannot
 * drift into overlapping or into leaving an anchor represented by neither.
 */
function partitionAnchors(
  quoteSource: string,
  anchors?: readonly ReplyAnchor[],
): { bar: readonly ReplyAnchor[]; stub: readonly ReplyAnchor[] } {
  if (!anchors?.length) return { bar: [], stub: [] };
  if (!quoteSourceCovers(quoteSource, anchors)) return { bar: [], stub: anchors };
  const isAppAuthored = (a: ReplyAnchor) => APP_AUTHORED_QUOTE_RE.test((a.quote ?? "").trim());
  return { bar: anchors.filter((a) => !isAppAuthored(a)), stub: anchors.filter(isAppAuthored) };
}

/** Does this reply OPEN by quoting every message it is answering? The whole rule in one call, for
 *  callers that are not on the streaming path. */
export function leadingQuoteCovers(text: string, anchors?: readonly ReplyAnchor[]): boolean {
  return quoteSourceCovers(leadingQuoteSource(text), anchors);
}

/**
 * Which message the blue bar should jump to, once it is standing in for the stub.
 *
 * THE OLDEST ANCHOR THAT STILL RESOLVES, i.e. the first of the burst. `remarkMergeQuotes` folds the
 * reply's opening quotes into ONE bar (the founder's own call, twice: five bars for one quotation
 * read as broken, and asked again on 2026-08-17 for the merged form), so there is one control for
 * what may be several messages and it has to point somewhere definite. The first is the right end:
 * a jump lands the reader at the top of the run he sent, with the rest below it in the column, where
 * jumping to the last would put the others off-screen above.
 *
 * Returns `undefined` when no anchor has an id left. An anchor whose target did not survive restore
 * keeps its quote and loses its id (see `replyAnchors.remapAnchors`) — the quote is still true, but
 * there is nothing to scroll to, and a control that scrolls nowhere is the dead affordance this
 * column's rules are written against. The bar then renders as plain prose, exactly like the stub
 * degrades to a `<div>` in the same case.
 */
export function quoteJumpTarget(anchors?: readonly ReplyAnchor[]): ReplyAnchor | undefined {
  return anchors?.find((a) => !!a.id);
}

/**
 * What the jumpable quote is CALLED, to a screen reader and on hover.
 *
 * A FUNCTION IN THIS MODULE, not a template inside the JSX, for the reason `RoutingReceipt`'s and
 * `lintMarks`' wording live away from their components: the sentence is the feature. A control whose
 * accessible name is "block quote" tells a non-sighted reader nothing about the one thing it does.
 *
 * IT MUST NOT CLAIM ONE MESSAGE WHEN IT MEANS SEVERAL. `remarkMergeQuotes` folds a burst's quotes
 * into a single bar, so one control can stand for three sends while its `title` shows only the words
 * of the first — and "Replying to: <first>. Show that message." would then be a confident sentence
 * about a mapping that does not hold. The plural form says how many there are and that the jump
 * lands on the first, which is what actually happens (see {@link quoteJumpTarget}).
 *
 * Phrased off the ANCHORS rather than off the rendered quote, so it describes what the app knows this
 * reply answers rather than what the model chose to type — the same "a fact about DELIVERY, not a
 * claim about content" line `replyAnchors`' header draws.
 */
export function quoteJumpLabel(anchors?: readonly ReplyAnchor[]): string {
  const first = quoteJumpTarget(anchors);
  const count = anchors?.length ?? 0;
  if (!first) return "";
  if (count <= 1) return `Replying to: ${first.quote}. Show that message.`;
  return `Replying to ${count} of your messages, starting with: ${first.quote}. Show the first.`;
}
