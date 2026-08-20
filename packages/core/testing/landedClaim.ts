// THE ONE OWNER of "this refusal must not assert that the work is on origin/main".
//
// WHY IT LIVES HERE (roborev 65753). The property is asserted at two layers — the pure
// `selfMarkRefusal` output in `packages/core/goalVerify.test.ts`, and what the real
// `set_agent_goal_met` op returns in `apps/desktop/src/services/controlListener.test.ts` — and it was
// duplicated verbatim in both, under a comment that named the file it was written in as its own
// sibling. That is the exact drift this branch exists to fix (a doc that kept enumerating two arms
// after a third arrived), reproduced inside the guard: widening the rule in one copy leaves the
// weaker predicate running at the layer that actually reaches agents.
//
// It is a pure audit that returns findings; the suites do the asserting, so nothing here depends on
// a test framework.

/**
 * An AFFIRMATIVE statement that the work is on origin/main.
 *
 * Deliberately not a bare `on origin\/main`: the refusal opens with "This goal is verified by the
 * work being on origin/main", which is a description of the CHECK, and reports "nothing has been
 * observed reaching origin/main", which is an absence. Neither is a claim. The tokens below are the
 * affirmative forms — including the plain `is on origin/main` and bare `landed`, which an earlier
 * cut missed (`already on origin/main` needed the adverb, `landed on` the preposition), so
 * "your work is on origin/main and this worktree was parked" was never even examined.
 *
 * `\blanded\b` does not match inside `unlanded` — the word boundary fails there — which is what
 * keeps "it is holding no unlanded commits either" out of the candidate set.
 */
export const LANDED_CLAIM =
  /\b(merged|landed|is an ancestor|already on origin\/main|(?:is|are|was|were) (?:already )?on origin\/main)\b/i;

export type LandedClaimViolation = {
  sentence: string;
  /** No governing condition at all, or one that arrives AFTER the claim it is supposed to govern. */
  reason: "no-condition" | "condition-follows-claim";
};

export interface LandedClaimAudit {
  /** Clauses that make a landed claim at all — empty means the audit examined nothing. */
  candidates: string[];
  violations: LandedClaimViolation[];
}

/**
 * The words that can put a claim under a condition. `if` alone was too narrow (roborev 65758): the
 * not-yet-read arm legitimately says "…or once you have merged your PR…", which claims nothing and
 * would have audited as an unconditional claim the moment this rule was pointed at that arm — and a
 * guard that fires on correct copy is a guard someone weakens back out.
 */
const GOVERNOR = /\b(if|unless|once|when|whether|should)\b/i;

/**
 * A negated mention asserts the opposite, so it is not a claim: "git says it has not merged yet".
 *
 * SCOPED TO THE CLAIM'S OWN COMMA-SEGMENT (roborev 65761). Tested against the whole clause prefix it
 * is an exemption anything can buy: "If you have not committed the work yet, then your work already
 * merged" carries a `not` far upstream, so the claim is hidden from `violations` AND from
 * `candidates` — worse than passing, because it also removes the evidence that anything was checked.
 */
const NEGATOR = /\b(not|never|no|nothing)\b[^,.;—]*$/i;

/**
 * Clauses of one sentence.
 *
 * EM-DASHES ARE THE TRAP (roborev 65758). This copy uses them BOTH ways: as a PAIR around a
 * parenthetical, where the sentence's leading condition still governs what is inside…
 *
 *   "If you believe it is ALREADY on origin/main — it merged and this worktree was parked — run …"
 *
 * …and as a single trailing dash, which introduces an independent clause the earlier condition does
 * NOT govern:
 *
 *   "If you have not committed the work yet, commit it and land it — your work already merged."
 *
 * Judging the whole sentence on its first `if` accepts both, so the second — an outright merge
 * claim, one edit from the shipped string — passed clean. Paired dashes (an EVEN count) stay one
 * scope; an odd count means the tail stands alone and needs its own condition.
 */
function clausesOf(sentence: string): string[] {
  const parts = sentence.split("—");
  if (parts.length % 2 === 1) return [sentence];
  return [parts.slice(0, -1).join("—"), parts[parts.length - 1]!];
}

/**
 * Find every landed claim in `message` that is not GOVERNED by a preceding condition.
 *
 * "Governed" is positional on purpose: `"Your work already merged, so if you open another PR you
 * will duplicate it."` contains a governor and still asserts the merge, so co-occurrence is not
 * enough — the condition must come first, and it must be in the claim's own clause.
 *
 * EVERY occurrence is checked, not just the first in a sentence: a conditional opening followed by a
 * second, unconditional claim is exactly the shape that slipped through when this looked at one
 * index per sentence.
 */
export function auditLandedClaims(message: string): LandedClaimAudit {
  const candidates: string[] = [];
  const violations: LandedClaimViolation[] = [];
  const claimRe = new RegExp(LANDED_CLAIM.source, "gi");

  for (const sentence of message.split(/(?<=[.;])\s+/)) {
    for (const clause of clausesOf(sentence)) {
      let claimed = false;
      claimRe.lastIndex = 0;
      for (let m = claimRe.exec(clause); m !== null; m = claimRe.exec(clause)) {
        const prefix = clause.slice(0, m.index);
        // The nearest segment only — see NEGATOR. A denial reaches the words next to it, not across
        // a comma into a different assertion.
        if (NEGATOR.test(prefix.split(/[,—;]/).pop() ?? prefix)) continue;
        claimed = true;
        if (!GOVERNOR.test(prefix)) {
          const after = clause.slice(m.index);
          violations.push({
            sentence: clause.trim(),
            reason: GOVERNOR.test(after) ? "condition-follows-claim" : "no-condition",
          });
        }
      }
      if (claimed) candidates.push(clause.trim());
    }
  }
  return { candidates, violations };
}
