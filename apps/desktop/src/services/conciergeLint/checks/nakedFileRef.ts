// R3 — "Don't paste `file:line` references as if they were self-explanatory — say what the code
// does in plain terms first."
//
// `warn`, never autofix: the compliant form is a SENTENCE the linter cannot write. Only the model
// knows what `src/retry.ts:88` does.
//
// ══ THE EXACT HEURISTIC, AND WHY IT IS THIS CONSERVATIVE ════════════════════════════════════════
// "Self-explanatory" is a judgment, and the plan's own rule for judgment is that it stays in prose.
// What IS mechanically decidable is the degenerate case the rule was written for: a reference
// dropped into the reply with essentially no words around it. So the check fires on exactly that
// and deliberately misses everything else. False negatives are the cheap direction — a missed warn
// costs one unenforced rule once; a false positive on a reply that already explained itself trains
// the reader to ignore the badge, which costs the whole linter.
//
// A reference fires when ALL of the following hold:
//
//   1. It is in PROSE. `mdast.proseSpans` has already dropped fenced blocks, inline code spans and
//      link destinations, and this check also drops BLOCKQUOTES — a `file:line` the USER pasted and
//      the concierge quoted back is not the concierge's reference.
//        Consequence, stated because it is large: `` `src/foo.ts:12` `` in backticks NEVER fires,
//        even bare. That is a real miss, and it is the miss this design chooses: distinguishing
//        "code-formatted because it is a path" from "code-formatted because it is being quoted"
//        needs the judgment the rule already conceded.
//   2. It matches {@link FILE_REF_RE}: at least one `/`-separated directory segment, a filename
//      with an alphabetic extension, then `:` and a line number. Requiring the slash and the
//      extension is what keeps `1.5:30`, `12:45pm`, `ratio 3:1` and a bare `foo:12` out.
//   3. It is not in a TABLE ROW — see the table section below.
//   4. The SOURCE LINE it sits on carries fewer than `threshold` words of explanation (default 4),
//      counting only alphabetic word tokens and with every reference on that line masked out first
//      so the path's own segments cannot count as its explanation.
//
// The unit is the LINE, not the sentence, and that is deliberate: a path contains dots, so
// sentence-splitting a reply full of `foo.ts:12` needs a second grammar to avoid splitting inside
// the reference — exactly the second-grammar trap `agentRefs.ts` records. Concierge replies are
// bullets and short paragraphs, where a line already is the unit a reader reads.
//
// ══ WHY THE WORDS ARE COUNTED ON THE RAW SOURCE LINE, NOT ON THE PROSE SPAN ═════════════════════
// The parser decides WHERE to look — `proseSpans` hands back the ranges that are prose, so fences,
// code spans and blockquotes are already gone. AUTOLINKED URLs are a WEAKER guarantee and the
// difference matters here (roborev 55870): `mdast.ts` drops autolink runs only from OFFSET-ALIGNED
// spans, and a node containing any escape or entity is emitted whole and unaligned, skipping that
// removal. So `See \_here\_ https://host/o/r/blob/main/src/retry.ts:88` is one unaligned node, the
// source scan finds the path INSIDE the URL, and the check fires on a bare link. Documented as an
// accepted false positive rather than papered over — it needs a fix in `mdast.ts` (dropping the runs
// without splitting), not a second grammar here. Everything after that reads the
// SOURCE those ranges cover, and the difference is not academic: any inline markup splits a
// paragraph into several mdast text nodes, and words inside an `inlineCode` node are not prose at
// all. Counting per node would have read
//
//     Every `retryBackoff` call resets src/retry.ts:88
//
// as two words ("call resets") and FIRED on a line that plainly explains itself — and backticked
// identifiers and bolded names are what concierge replies are mostly made of. Counting the raw
// line reads four and stays quiet. The cost is that markup and link destinations count as words,
// which errs toward silence — the direction this check prefers.
//
// ══ SCANNING THE SOURCE IS THE POINT, AND IT COST THREE ATTEMPTS TO GET HERE ═══════════════════
// The reference is now MATCHED against `text.slice(span.start, span.end)` rather than against
// `span.value`, so a match's index IS a source offset and there is nothing to translate. That is
// the whole fix, and it is worth recording what it replaces, because each predecessor sounded
// reasonable and each was wrong in a way its own tests did not show:
//
//   1. "Count on the span when the offsets are misaligned." Silently reinstated per-text-node
//      counting on exactly the lines most likely to reach it — `The **retry backoff** resets &amp;
//      retries at src/retry.ts:88` reads three words on the ref's node and seven on its source
//      line, so the check fired on a line that explains itself.
//   2. "An escape or an entity never adds or removes a newline, so count newlines in the value and
//      walk that many lines forward." FALSE for a character reference that decodes TO a line
//      ending: micromark exempts codes 9/10/12/13 from its replacement, so `&#10;` — the standard
//      idiom for a line break inside a GFM table cell — puts a newline in `value` that the source
//      does not have, and the walk overshoots onto a later line.
//   3. "The matched text is verbatim in the source, so `indexOf` finds it." FALSE for markdown
//      escapes: `_`, `.` and `-` are all escapable, and `src/retry\_helper.ts:88` parses to
//      `src/retry_helper.ts:88`, which the source does not contain. The search then either missed
//      (silence on a naked reference) or landed on a DIFFERENT identical occurrence later in the
//      node and judged that line instead.
//
// Every one of those was a mapping from parsed text back to source. Matching the source directly
// deletes the mapping, so there is no invariant left to be wrong about — which is why this is a
// deletion and not a fourth translation. What remains is one narrow, stated tolerance:
// {@link FILE_REF_RE} accepts a `\` before each path character, so an escaped path is detected and
// masked by the same pattern.
//
// AN ENTITY INSIDE A PATH (`src/retry&#46;ts:88`) IS NOT DETECTED — and the honest statement of that
// miss has two halves, because a previous version of this comment got the second one wrong in each
// direction (roborev 55875, then 55885).
//
// It is NOT self-contained. An unmatched reference is also UNMASKED, so on
// `Fixed src/retry&#46;ts:12 and src/b.ts:9` its own segments ("Fixed", "src", "retry", "ts", "and")
// clear the four-word bar for the SECOND reference and silence `src/b.ts:9`, which is genuinely
// naked. Calling it a miss "in the direction this check always chooses" understated it.
//
// It is ALSO NOT WORTH FIXING BY WIDENING THIS PATTERN, which is what the fix for that attempted and
// had to be reverted. Accepting `&#?[A-Za-z0-9]{1,8};` in both the segment class and the separator
// made an entity consumable as either, i.e. the textbook exponential `(?:E+E)+`: ~25-30 consecutive
// entities that do not end in `.ext:digits` — ordinary HTML-escaped markup like
// `&lt;div&gt;&lt;span&gt;…` — walked ~2^k paths and HUNG the lint pass, on every reply, with no
// input bound. The same widening also matched `See&nbsp;the&nbsp;log&nbsp;42` as a reference (an
// entity satisfied every separator, so condition #2 stopped holding), and because detection and
// masking share this regex those four real words were masked out of the count too.
//
// So the miss stands, deliberately. A real fix decodes entities BEFORE scanning — a separate pass
// with its own offset story — and is not a grammar change here.
//
// ══ A TABLE ROW IS NOT A SENTENCE, SO THE CHECK SKIPS IT ═══════════════════════════════════════
// The bar of four words is calibrated for prose, and a table cell is terse BY CONSTRUCTION — that
// is what a table is for. `| src/retry.ts:88 | resets the backoff |` explains itself perfectly and
// counts three. The wrong repair is to lower the bar globally: at three, `Fixed it in
// src/retry.ts:88` goes quiet, and that is precisely the degenerate case R3 exists for. So the bar
// stays at four for prose and a GFM-shaped table row is skipped entirely: the header row names
// what each column means, which is the explanatory structure the rule is asking for.
//
// The accepted cost, stated: `| src/retry.ts:88 |  |` — a row with an EMPTY explanation cell — is
// also skipped. A false negative, in the direction this check always chooses.
//
// Worked examples at the default threshold of 4:
//   "See src/retry.ts:88"                               → 1 word  → FIRES
//   "- src/retry.ts:88"                                 → 0 words → FIRES
//   "Fixed it in src/retry.ts:88"                       → 3 words → FIRES
//   "The **retry** at src/retry.ts:88"                  → 3 words → FIRES
//   "The retry backoff lives at src/retry.ts:88"        → 5 words → quiet
//   "Every `retryBackoff` call resets src/retry.ts:88"  → 4 words → quiet
//   "| src/retry.ts:88 | resets the backoff |"          → table row → skipped

import type { Check, LintContext, Severity, Violation } from "../types";
import { proseSpans, type ProseSpan } from "../mdast";

/** The check id. Must equal the `[concierge.checks.<id>]` table key in `config.toml`. */
export const NAKED_FILE_REF_CHECK_ID = "naked-file-ref";

/** Words of surrounding explanation below which a reference counts as naked. Calibrated for PROSE:
 *  at three, `Fixed it in src/retry.ts:88` goes quiet, and that is the case the rule exists for.
 *  Terse-by-construction table rows are skipped instead of lowering this — see the header. */
export const DEFAULT_MIN_EXPLANATION_WORDS = 4;

/**
 * A `path/to/file.ext:123` reference, optionally with an end line (`:123-140` or `:123:4`).
 *
 * Requires a directory segment AND an alphabetic extension AND a line number — three independent
 * conditions, each one removing a whole class of coincidental colon-digit text.
 *
 * Every character may carry a leading `\` — the segment characters AND the separators (`/`, the
 * extension `.`, the `:` before the line number) — because this runs over RAW MARKDOWN (see the
 * scanning section in the header) and escaping punctuation is a routine model habit: `\_` to
 * suppress emphasis inside an identifier, and often `\.` or `\/` from a model that escapes
 * generically rather than selectively.
 *
 * COVERING THE SEPARATORS TOO IS NOT A DETAIL (roborev 55870). Tolerating escapes only INSIDE
 * segments left `src/retry_helper\.ts:88` undetected — the segment class consumes `retry_helper\.ts`
 * and then the literally-spelled `\.` has no bare `.` left to match. That is a silent miss of the
 * same kind this pattern exists to remove, and it is worse than a plain miss: the unmatched
 * reference is also UNMASKED, so on `Fixed \.ts style at src/a\.ts:12 and src/b.ts:9` its segments
 * ("src", "a", "ts") count as explanation for the OTHER reference on the line and push it over the
 * bar. Detection and masking are the same regex precisely so they cannot disagree like that.
 */
/**
 * The one character class a path SEGMENT is built from, and the three SEPARATORS between segments.
 *
 * COMPOSED FROM NAMED PIECES SO THE SAFETY PROPERTY IS TESTABLE (roborev 55898). What keeps this
 * pattern linear is that a separator can never match something the segment class also matches: with
 * the two disjoint there is exactly ONE way to decompose any input, so the engine never backtracks
 * across alternatives. Widening either side until they overlap is what produced the exponential
 * `(?:E+E)+` this file reverted — and the first attempt to guard that searched the source for the
 * literal token from that diff, which any other spelling of the same overlap (`&\w+;`,
 * `&(?:#\d+|\w+);`) would have slipped past while the test stayed green.
 *
 * Exported so `disjointness` can be asserted by MATCHING, not by reading the source.
 */
export const SEGMENT_CHAR = String.raw`\\?[A-Za-z0-9_.@-]`;

/** The separators, in order. Each must stay disjoint from {@link SEGMENT_CHAR} — see it. */
export const SEPARATORS = [String.raw`\\?\/`, String.raw`\\?\.`, String.raw`\\?:`] as const;

export const FILE_REF_RE = new RegExp(
  `(?:(?:${SEGMENT_CHAR})+${SEPARATORS[0]})+` +
    `(?:${SEGMENT_CHAR})+${SEPARATORS[1]}` +
    `[A-Za-z][A-Za-z0-9]*${SEPARATORS[2]}` +
    String.raw`\d+(?:\\?[:-]\d+)?`,
  "g",
);

/** What a reference is replaced by before words are counted: a private-use character, written as an
 *  escape so it is visible in the source. It cannot match {@link WORD_RE}, so a reference's own
 *  path segments never count as its explanation, and it is not whitespace, so removing a reference
 *  cannot fuse its two neighbours into one token and undercount them. */
const MASK = "\uE000";

/** Alphabetic word tokens. Numbers do not count as explanation — "src/retry.ts:88 88" explains
 *  nothing — and neither does the mask. */
const WORD_RE = /[A-Za-z][A-Za-z0-9'’_-]*/g;

function countWords(line: string): number {
  return (line.match(WORD_RE) ?? []).length;
}

/** The whole line of `source` containing `index` — from the previous newline to the next. */
function lineAt(source: string, index: number): string {
  const from = source.lastIndexOf("\n", Math.max(0, index - 1)) + 1;
  const to = source.indexOf("\n", index);
  return source.slice(from, to === -1 ? source.length : to);
}

/** The source text this span covers. A text node contains no other nodes by construction, so this
 *  is the same prose the parser saw — differing from `span.value` only where markdown escaped or
 *  entity-encoded a character. See the scanning section in this file's header. */
function sourceOf(text: string, span: ProseSpan): string {
  return text.slice(span.start, span.end);
}

/**
 * Is this source line a GFM table row?
 *
 * Reconstructed from the raw line rather than from the parser, because `mdast.ts` runs without the
 * gfm extension and sees a whole table as one paragraph (that module's header says so). A pipe at
 * both ends plus an inner pipe is GFM's own row shape, and it is deliberately strict: a sentence
 * that merely contains a `|` is not a row and stays subject to the ordinary word count.
 */
function isTableRow(line: string): boolean {
  const t = line.trim();
  return t.startsWith("|") && t.endsWith("|") && t.length > 2 && t.slice(1, -1).includes("|");
}

export const nakedFileRefCheck: Check = {
  id: NAKED_FILE_REF_CHECK_ID,
  run(text: string, ctx: LintContext): { text: string; violations: Violation[] } {
    const policy = ctx.policy?.checks?.[NAKED_FILE_REF_CHECK_ID];
    const severity: Severity = policy?.severity ?? "warn";
    const minWords =
      typeof policy?.threshold === "number" && policy.threshold >= 0
        ? policy.threshold
        : DEFAULT_MIN_EXPLANATION_WORDS;

    const violations: Violation[] = [];
    for (const span of proseSpans(text, { excludeBlockquote: true })) {
      // A private scanner per span: `FILE_REF_RE` is also used by `.replace` below, and String
      // .replace resets a global regex's `lastIndex` — sharing one instance across the two would
      // rewind this loop forever.
      // Scan the SOURCE this span covers, not its parsed value: `m.index` is then a real source
      // offset by construction, for aligned and unaligned spans alike. See the header.
      const source = sourceOf(text, span);
      const scanner = new RegExp(FILE_REF_RE.source, "g");
      let m: RegExpExecArray | null;
      while ((m = scanner.exec(source)) !== null) {
        const line = lineAt(text, span.start + m.index);
        // A table row is terse by construction and its header row is the explanation — the word
        // bar is calibrated for prose and does not apply. See this file's header.
        if (isTableRow(line)) continue;
        // Mask every reference on the line before counting, so the path's own words ("src",
        // "retry", "ts") cannot be mistaken for the explanation the rule asks for.
        const explanation = countWords(line.replace(FILE_REF_RE, MASK));
        if (explanation >= minWords) continue;
        violations.push({
          check: NAKED_FILE_REF_CHECK_ID,
          severity,
          action: "warned",
          span: m[0].length,
          detail: `file:line reference with ${explanation} word(s) of explanation (needs ${minWords})`,
        });
      }
    }
    return { text, violations };
  },
};
