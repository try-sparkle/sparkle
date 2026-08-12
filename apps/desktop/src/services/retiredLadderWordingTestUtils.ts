/**
 * ONE canonical pattern for the retired recurrence→priority ladder, shared by every prompt suite
 * that has to prove its prompt no longer instructs it (bead `sparkle-mzgqt`, retired 2026-08-09:
 * a comment count silently driving priority is what the founder ruled out, so priority is set by
 * a human and the sighting count feeds a separate, still-unbuilt severity score).
 *
 * WHY THIS IS SHARED RATHER THAN COPIED INTO EACH SUITE. There are two live, unattended production
 * prompts carrying this instruction — `sparkleAgent`'s persona and `improvementPass`'s hourly
 * mission — and the whole point of the sweep that produced this file is that they must state ONE
 * contract, not two paraphrases. Two hand-written guards drift apart exactly the way two
 * hand-written prompts do, and the first review of that sweep caught precisely that: one prompt
 * guarded, its sibling rewritten and left unpinned.
 *
 * WHY IT IS ANCHORED ON THE INSTRUCTION, NOT ON TOKEN ADJACENCY. The first attempt used
 * `/bump.*priority/i` against the whole prompt. Both prompts join their lines into one
 * newline-free string and legitimately say "priority" several times while EXPLAINING the
 * retirement, so that pattern meant "the token `bump` must not appear anywhere before some later
 * `priority`" — simultaneously too broad and too narrow:
 *   - too broad: `sparkleAgent`'s own drain step correctly says "enrich/**bump** recurring ones"
 *     (bumping the `seen-<N>` counter is permitted and is the whole replacement mechanism), so
 *     mirroring that phrasing into the sibling prompt would red the test on CORRECT copy;
 *   - too narrow: "priority bump", "priority climbs" and "steps priority" — all forms the sweep
 *     actually found and removed — put the words in the other order and slipped through unmatched.
 *
 * `escalat` is included, which forces a wording constraint on the prompts themselves: they explain
 * the retirement as "the ladder that let a sighting count escalate **it**", never "escalate
 * priority". That is deliberate — the explanatory sentence has a form that does not collide with
 * the instruction it is explaining, so the guard does not have to distinguish them by context.
 *
 * WHAT THIS PATTERN STRUCTURALLY CANNOT DO, AND WHAT COVERS EACH CASE. A negative can only describe
 * re-entry it can enumerate, so the verb list is a guess about how a future author would phrase the
 * retired instruction — generous (see below), but never closed. Beyond that open-ended caveat there
 * are **three** phrasings it is *barred* from reaching, and each needs its own cover:
 *   1. **`move`.** The prohibition itself is "Do NOT **move** its priority", so admitting `move`
 *      would fire on the very sentence the prompts are required to carry.
 *   2. **DELETION.** Removing the prohibition outright leaves nothing for a negative to match, so
 *      every negative assertion stays green while the live prompts quietly stop telling the agent
 *      not to escalate.
 *   3. **`escalate it`.** Barred for the same reason as `move`, and this branch created the bar
 *      deliberately: `sparkleAgent.ts:609` was reworded to "escalate **it**" precisely so `escalat`
 *      could join the verb list. So the prompts' explanatory clause is what makes the phrase
 *      unmatchable — and a POSITIVE on the prohibition does not cover this one, because a positive
 *      proves PRESENCE, never the absence of a contradictory sibling. Adding
 *      "— escalate it when the count grows" *beside* the prohibition leaves every other assertion
 *      green while the prompt again instructs the retired behaviour.
 *
 * THE COVERAGE MAP — three cases, THREE covers, and case 3 takes two of them:
 *   - cases 1 and 2 → `PRIORITY_PROHIBITION`.
 *   - case 3, the REWORDING/DELETION half → `LADDER_RETIREMENT_EXPLANATION`. Pinning the
 *     explanatory clause is what keeps `escalat` safe to have in the verb list at all.
 *   - case 3, the SIBLING-ADDITION half → `countLadderEscalateIt`. **Neither alone is
 *     sufficient**, and the reason is the whole of case 3: `LADDER_RETIREMENT_EXPLANATION` is a
 *     positive, and a positive cannot see a second instruction added *beside* the one it pins.
 *     If this map ever reads as though the positive covers case 3 on its own, a future author will
 *     correctly conclude the counter is redundant, delete it, and reopen the hole — with nothing
 *     going red, because the counting assertions are the only thing that would have failed.
 *
 * All three are exported and imported by BOTH prompt suites for the same reason the pattern itself
 * is: this module's whole argument is that two hand-written guards for one contract drift apart the
 * way two hand-written prompts do, so it must not hand-write them twice itself.
 */
const RETIRED_LADDER_VERBS = "bump|climb|step|escalat|rais|increas|promot|elevat|nudg";

export const RETIRED_PRIORITY_LADDER_INSTRUCTION = new RegExp(
  // "bumps priority", "BUMP its priority", "raise the priority", "escalate its priority"
  `(?:${RETIRED_LADDER_VERBS})\\w*\\s+(?:it|its|the|a|toward)?\\s*priority` +
    // the other word order: "priority bump", "priority climbs", "priority step"
    `|priority\\s+(?:${RETIRED_LADDER_VERBS})` +
    // ...and the form that never says "priority" at all: "promote it to P1", "bumped to P1"
    `|(?:${RETIRED_LADDER_VERBS})\\w*\\s+(?:it|its|the|a)?\\s*(?:up\\s+)?(?:to\\s+)?P[0-4]\\b`,
  "i",
);

/**
 * The PROHIBITION, asserted as a positive — cases 1 and 2 above. Its polarity is the load-bearing
 * part: a dropped "NOT" is the cheapest possible way for this contract to invert.
 */
export const PRIORITY_PROHIBITION = /do NOT move its priority/i;

/**
 * The EXPLANATORY CLAUSE — case 3 above. This is not decoration: "escalate **it**" is the exact
 * wording that keeps `escalat` out of collision with the prompts' own prose, so `escalat` can stay
 * in the verb list. Reword it to "escalate priority" and the guard starts firing on correct copy;
 * drop it and the `escalate it` re-entry silently reopens. Either way the constraint is load-bearing
 * and therefore has to be pinned rather than remembered.
 */
export const LADDER_RETIREMENT_EXPLANATION = /count escalate it was retired/i;

/**
 * How many times "escalate it" appears — case 3's OTHER half, and the one a positive genuinely
 * cannot reach.
 *
 * Pinning the explanatory clause stops it being reworded or deleted. It does NOT stop a second
 * "escalate it" being added BESIDE it, because a positive proves presence and says nothing about
 * siblings: "— escalate it when the count grows" dropped next to the prohibition leaves every other
 * assertion green while the live unattended prompt again instructs the retired behaviour, and the
 * negative pattern is barred from that phrasing by construction.
 *
 * COUNTING is what closes it. The phrase is licensed EXACTLY ONCE per prompt, in the explanatory
 * clause; a second occurrence is by definition not that clause. This is the only assertion in the
 * set that constrains what may be ADDED rather than what must be present, which is why it exists
 * separately rather than being folded into the regex above.
 *
 * WHY IT IS CONTEXT-SCOPED RATHER THAN A BARE `/escalate it/g`. "Escalate" is an ordinary word in
 * these prompts, about something else entirely: `sparkleAgent.ts` already says "stop and escalate
 * to the user in chat instead", and rewording that to the equally natural "escalate **it** to the
 * user in chat" would take a bare count to 2 and red a test whose name blames the retired priority
 * ladder. This module's own suite warns that a guard firing on correct copy "gets loosened or
 * deleted by the next agent, taking the real coverage with it" — and a misleading diagnosis makes
 * deletion the likely outcome, so the false positive is the expensive direction here.
 *
 * THE HONEST LIMIT, stated rather than glossed, and it has TWO parts:
 *   - The trailing-word list is a guess, the same kind the verb list is, so a sibling phrased
 *     "— escalate it, **since** a repeated signal matters" is NOT counted.
 *   - Closing the alternation with `\b` (which is what keeps "only"/"aside"/"onto" out) also
 *     excludes any inflection not spelled out in the list. `whenever` and `afterwards` are admitted
 *     explicitly below because they are the natural ones; **`onwards` is deliberately not**, since
 *     "escalate it onwards to the user" reads as ordinary routing prose rather than a recurrence
 *     rule, and the false positive is the expensive direction here. So that phrasing is a known
 *     miss, not an oversight.
 * Both residuals are covered only in the weaker sense that the negative pattern catches any
 * *priority-verb* phrasing and `PRIORITY_PROHIBITION` catches the clause's removal. They are real
 * gaps; claiming otherwise is precisely the mistake the rounds before this one made.
 */
/**
 * The trailing words that mark an `escalate it` as a RECURRENCE instruction rather than ordinary
 * escalation prose. Exported so the prompt suites can name the restriction accurately instead of
 * paraphrasing it — the same reason `PRIORITY_PROHIBITION` is exported rather than hand-written
 * twice. A comment that restates a rule slightly wrong is how the last three rounds of this branch
 * went; a list you can read is not.
 */
export const LADDER_ESCALATION_TRAILING_WORDS = [
  // Inflections are spelled out, because `\b` (below) means a listed stem no longer matches its
  // own longer forms: `when` alone does NOT match "whenever". "escalate it whenever the count
  // grows" is the single most natural way to phrase this instruction, so leaving it to a prefix
  // match — which is what the missing boundary was accidentally providing — is not an option.
  "when(?:ever)?",
  // `on` deliberately WITHOUT `wards`: see THE HONEST LIMIT above. "onto" and "only" are excluded
  // by the boundary, which is the point.
  "on",
  "as",
  "once",
  "after(?:wards)?",
  "every",
] as const;

/**
 * BOTH boundaries are load-bearing. Without the `\b` closing the alternation each alternative
 * matches as a PREFIX — `on` matches "only", `as` matches "aside" — so "escalate it **only** to the
 * user in chat" would count, which is a reword of the very line (`sparkleAgent.ts:576`) this
 * scoping exists to protect. The false positive would have been reintroduced inside the narrowing
 * that removed it. The cost of the boundary is the inflection miss documented above, which is why
 * the list carries its own `(?:ever)?` / `(?:wards)?` rather than relying on prefix matching.
 */
const LADDER_ESCALATE_IT_SOURCE = `count escalate it\\b|escalate it\\b\\s+(?:${LADDER_ESCALATION_TRAILING_WORDS.join(
  "|",
)})\\b`;

export function countLadderEscalateIt(prompt: string): number {
  // `String.prototype.match` with a `g` regex sets `lastIndex` to 0 before it iterates and leaves
  // it there (ES 22.2.6.9), so a shared literal would be safe HERE. It is built per call anyway
  // because that safety is a property of `.match()` specifically — `test()`/`exec()` do carry
  // `lastIndex` across calls — and a future edit switching the implementation would inherit a
  // silent, order-dependent bug. This is a cheap hedge, not a fix for an existing defect; an
  // earlier revision claimed the latter and shipped a test that could not fail.
  return (prompt.match(new RegExp(LADDER_ESCALATE_IT_SOURCE, "gi")) ?? []).length;
}
