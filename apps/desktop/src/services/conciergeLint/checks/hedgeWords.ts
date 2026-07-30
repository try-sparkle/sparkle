// R13 — "never use hedging words like 'should' or 'deserves to'".
//
// `warn`, never autofix: the compliant form of "the build should finish soon" is a different
// sentence with a different commitment in it ("the build finishes in ~3 minutes" / "I don't know
// when the build finishes"), and only the model knows which. A substitution that deleted the word
// would change the claim, so this check reports and leaves the text alone.
//
// ══ WHAT IT LOOKS AT, AND WHAT IT DOES NOT ══════════════════════════════════════════════════════
// PROSE ONLY, via `mdast.proseSpans`. Three exclusions, each one a real reply this would otherwise
// have punished:
//   • a fenced block — a code sample containing `if (x) { /* should */ }`, or a quoted guideline
//     that literally lists the banned words, is not the concierge hedging.
//   • an inline code span — `` the `should` in rule 13 `` is the concierge NAMING the word.
//   • a BLOCKQUOTE — "you asked: > should I merge it?" is the user's word, and warning about it
//     blames the concierge for something it did not write. This is why `excludeBlockquote` exists.
//
// Word boundaries, case-insensitively: "Should we" and "should" both hedge; "shoulder" and
// "shouldn't" do not (`\b` stops the first; the second is a different word and the apostrophe
// breaks the boundary anyway). Multi-word entries match across any whitespace run, so a phrase
// broken over a line wrap still counts.

import type { Check, LintContext, Severity, Violation } from "../types";
import { proseSpans } from "../mdast";

/** The check id. Must equal the `[concierge.checks.<id>]` table key in `config.toml`. */
export const HEDGE_WORDS_CHECK_ID = "hedge-words";

/** The rule names two; the config key is hand-editable so a user can add their own. */
export const DEFAULT_HEDGE_WORDS = "should, deserves to";

/** Split the comma-separated config value into words, dropping blanks. Exported because the tests
 *  and any future settings UI must not re-implement the splitting. */
export function parseHedgeWords(words: string | undefined): string[] {
  return (words ?? DEFAULT_HEDGE_WORDS)
    .split(",")
    .map((w) => w.trim())
    .filter((w) => w.length > 0);
}

const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g;

/** A case-insensitive, word-bounded, whitespace-tolerant matcher for one configured entry.
 *
 *  `\b` is applied only where the entry's own edge is a word character: an entry ending in `)` or
 *  `-` has no word boundary there, and `\b` would make it unmatchable rather than stricter. */
function matcherFor(word: string): RegExp {
  const body = word
    .split(/\s+/)
    .map((part) => part.replace(REGEX_SPECIALS, "\\$&"))
    .join("\\s+");
  const leading = /\w/.test(word[0] ?? "") ? "\\b" : "";
  const trailing = /\w/.test(word[word.length - 1] ?? "") ? "\\b" : "";
  return new RegExp(`${leading}${body}${trailing}`, "gi");
}

export const hedgeWordsCheck: Check = {
  id: HEDGE_WORDS_CHECK_ID,
  run(text: string, ctx: LintContext): { text: string; violations: Violation[] } {
    const policy = ctx.policy?.checks?.[HEDGE_WORDS_CHECK_ID];
    const severity: Severity = policy?.severity ?? "warn";
    const matchers = parseHedgeWords(policy?.words).map((w) => ({
      word: w,
      re: matcherFor(w),
    }));
    if (matchers.length === 0) return { text, violations: [] };

    const violations: Violation[] = [];
    for (const span of proseSpans(text, { excludeBlockquote: true })) {
      for (const { word, re } of matchers) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(span.value)) !== null) {
          // A zero-width match would spin forever; a configured entry cannot produce one, but the
          // entries are hand-edited config, so the guard is cheap insurance against a hang.
          if (m[0].length === 0) {
            re.lastIndex += 1;
            continue;
          }
          violations.push({
            check: HEDGE_WORDS_CHECK_ID,
            severity,
            action: "warned",
            span: m[0].length,
            detail: `hedging word "${word}"`,
          });
        }
      }
    }
    // One violation per occurrence, not per check: "this reply hedged five times" and "this reply
    // hedged once" are different facts about it, and collapsing them would hide the first.
    return { text, violations };
  },
};
