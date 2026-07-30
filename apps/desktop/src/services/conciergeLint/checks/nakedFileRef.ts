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
// DETECTION is per prose span, so fences, code spans and blockquotes stay excluded. COUNTING is on
// the original source line, and the difference is not academic: any inline markup splits a
// paragraph into several mdast text nodes, and words inside an `inlineCode` node are not prose at
// all. Counting per span would have read
//
//     Every `retryBackoff` call resets src/retry.ts:88
//
// as two words ("call resets") and FIRED on a line that plainly explains itself — and backticked
// identifiers and bolded names are what concierge replies are mostly made of. Counting the raw
// line reads four and stays quiet. The cost is that markup and link destinations count as words,
// which errs toward silence — the direction this check prefers.
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
 */
export const FILE_REF_RE =
  /(?:[A-Za-z0-9_.@-]+\/)+[A-Za-z0-9_.@-]+\.[A-Za-z][A-Za-z0-9]*:\d+(?:[:-]\d+)?/g;

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

/**
 * Where a reference sits in the ORIGINAL source, or `null` when that cannot be established.
 *
 * ══ THE INVARIANT, AND THE TWO IT REPLACES ══════════════════════════════════════════════════════
 * This is the third attempt at "which line is this reference on", and the first two both rested on
 * a claim that turned out to be false or too weak. Recorded, because each was reasonable-sounding:
 *
 *   • "Count on the span when the offsets are misaligned." That silently reinstated per-text-node
 *     counting on exactly the lines most likely to reach it — `The **retry backoff** resets &amp;
 *     retries at src/retry.ts:88` reads three words on the ref's node and seven on its source line,
 *     so the check fired on a line that explains itself.
 *   • "Resolving an escape or an entity never adds or removes a newline, so count newlines in the
 *     parsed value and walk that many lines forward." FALSE for a numeric character reference that
 *     decodes TO a line ending: micromark exempts codes 9/10/12/13 from its `�` replacement,
 *     so `&#10;` and `&NewLine;` put a newline in `value` that the source does not have. `&#10;` is
 *     the standard idiom for a line break inside a GFM table cell, so this is not exotic. The walk
 *     then overshoots onto a LATER line and judges the wrong text, in either direction and with no
 *     signal that it happened.
 *
 * The invariant that actually holds is about the REFERENCE, not about the encoding: a
 * {@link FILE_REF_RE} match is drawn from `[A-Za-z0-9_.@/-]`, `:` and digits, and markdown neither
 * escapes nor entity-encodes any of those. So the matched text appears VERBATIM in the source, and
 * `indexOf` finds it — for aligned and unaligned spans alike, with no branch between them.
 *
 * `searchFrom` advances past each hit so repeated identical references resolve to their own
 * occurrences rather than all collapsing onto the first, and the bound at `span.end` keeps the
 * search inside this span.
 *
 * `null` means "could not be located" — reachable only if a model entity-encodes a character inside
 * the path itself (`src/retry&#46;ts:88`). The caller stays SILENT on it. A false negative, which is
 * the direction this check always chooses; guessing a line and counting the wrong words is how the
 * two attempts above produced false positives.
 */
function findRefInSource(
  text: string,
  span: ProseSpan,
  ref: string,
  searchFrom: number,
): number | null {
  const at = text.indexOf(ref, Math.max(searchFrom, span.start));
  if (at === -1 || at + ref.length > span.end) return null;
  return at;
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
      const scanner = new RegExp(FILE_REF_RE.source, "g");
      let searchFrom = span.start;
      let m: RegExpExecArray | null;
      while ((m = scanner.exec(span.value)) !== null) {
        // The ORIGINAL source line, always — so inline markup that split the paragraph into
        // several text nodes cannot hide the explanation. See `findRefInSource`.
        const at = findRefInSource(text, span, m[0], searchFrom);
        // Unlocatable: stay silent rather than count the wrong line. See `findRefInSource`.
        if (at === null) continue;
        searchFrom = at + m[0].length;
        const line = lineAt(text, at);
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
