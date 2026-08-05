// DEFECT-WITHOUT-DISPOSITION — the concierge asserted that a defect EXISTS and attached nothing to it.
//
// ══ THE FAILURE THIS EXISTS FOR ═════════════════════════════════════════════════════════════════
// The concierge diagnosed a real bug — a plan-approval prompt raises no pill, traced to
// `workerRollup.ts:169` — and then filed no bead. The founder had to notice the omission himself. A
// diagnosis nobody records is worth less than no diagnosis: it costs the investigation AND leaves the
// human believing the problem is now held somewhere.
//
// ══ WHY THE TWO CHECKS NEXT DOOR DO NOT COVER IT ════════════════════════════════════════════════
// `ask-without-action` missed it for two confirmed reasons, and this check is shaped around both:
//
//   1. IT KEYS ON A QUESTION. Its whole grammar is `OFFER_PATTERNS` — "want me to", "should I",
//      "let me know if". The miss contained no question at all. So the trigger here is the DEFECT
//      ASSERTION itself: "there is a bug in X" with nothing attached IS the violation, and nothing in
//      this file looks for an interrogative.
//   2. IT IS TURN-SCOPED. `askWithoutAction.run` returns clean at `if (tookAction(ctx.toolCalls))`,
//      and `tookAction` accepts ANY state-changing call — a theme change, a goal set, a navigate that
//      happens to be classified a write. A turn that acts on issue A and drops issue B scores clean.
//      Here the bar is a DISPOSITION-CLASS call ({@link tookDisposition}): a bead filed or an agent
//      spawned. Closing an agent, merging a PR, setting a goal, sending a message or taking a
//      screenshot are all "action" over there and none of them dispose of a named defect.
//
// `unbacked-claim` is the mirror image and also silent here: it asks whether a claimed ACTION
// happened, and the miss claimed no action — it reported a finding and stopped.
//
// ══ WHAT THIS CHECK CAN AND CANNOT PROVE, STATED PLAINLY ════════════════════════════════════════
// The disposition test is TURN-LEVEL, because that is all the evidence a deterministic check has.
// Nothing here can tell that the bead the turn filed is about the defect the sentence named — that
// attribution needs a reader with the reply and the tool arguments side by side, which is the
// "Witness" (bead sparkle-lviti). The Witness has no code yet; it is a spec request. So the class
// this check decides is the mechanically decidable one: A DEFECT WAS ASSERTED AND THE TURN FILED NO
// BEAD AND SPAWNED NO AGENT — a bead, a spawn, or a stated reason all pass. ONLY SILENCE IS A
// VIOLATION, where silence means nothing durable was written down.
//
// IT FIRES ON THE ORIGINATING MISS. That turn sent a message to an existing agent and filed nothing,
// and under {@link tookDisposition}'s ruling a send is not a disposition — so the reply that started
// all of this is a violation here, which is the whole point.
//
// What it still CANNOT prove, stated plainly: that the bead the turn filed is ABOUT the defect the
// sentence named. A turn that names a bug and files an unrelated bead passes. That attribution needs
// a reader with the reply and the tool arguments side by side, which is the Witness's job; until it
// exists, this under-reach is in the false-NEGATIVE direction, which is the safe one for a check
// that blocks.
//
// ══ WHY IT LIVES IN conciergeLint AND NOT SOMEWHERE ELSE ════════════════════════════════════════
// `conciergeLint` is the ONLY surface in the app that sees concierge REPLY TEXT alongside THAT TURN'S
// TOOL CALLS. The Pusher never reads reply text and blocks nothing; the Witness is unbuilt. A check
// correlating "what the reply asserted" with "what the turn did" has nowhere else to run today.
//
// ══ THE GRAMMAR IS CALIBRATED — LOOSENING IT IS THE REGRESSION ══════════════════════════════════
// Same discipline as `unbackedClaim`'s header, for the same measured reason: a naive scan of that
// corpus flagged 23% of turns at ~70% false positives and the shipped grammar flags 2.1%. A noisy
// check gets switched off and is worth less than nothing. Two properties do the work here:
//
//   A. A DEFECT NOUN OR A DEFECT PREDICATE IN AN EXISTENCE / ATTRIBUTION FRAME. Not a keyword scan —
//      the word "bug" alone is ordinary vocabulary in this app. See {@link DEFECT_PATTERNS}.
//   B. FOUR EXCLUSIONS, each removing a class of BLOCKING false positive, and every one of them
//      scoped to the ASSERTION'S OWN SENTENCE via `sentenceAround`. Paragraph-wide exemption is
//      roborev 55713, a High, and it has recurred twice in this folder.
//
// ══ SHIPPED "warn", THOUGH IT IS WRITTEN TO BLOCK ══════════════════════════════════════════════
// `action: "warned"` always, and no autofix — the compliant form of a true positive is not a rewrite,
// it is the bead that was not filed. On severity, see the config row: `lintReply` computes `blocked`
// and NO production caller reads it (`ConciergeHost.tsx` consumes only `.text` and `.violations`), so
// every `severity = "block"` in the shipped config is inert today. `config.rs` already documents that
// discipline for `ask-without-action`, and `conciergeLintRegistry.test.ts` pins the gap. The row flips
// to `"block"` in the change that lands the re-prompt — a one-line edit in two places.

import type { Check, LintContext, LintToolCall, Severity, Violation } from "../types";
import { proseSpans } from "../mdast";
// REUSED, NOT REIMPLEMENTED — this folder keeps paying for duplicated copies.
// `backedFamilies` already resolves MCP dispatcher names through `catalogNameFor` and already matches
// `bd create` / `gh pr` / `git push` inside a `Bash` call; a second copy would eventually disagree
// with the first about what a filing IS. `sentenceAround` already handles version strings
// ("v0.62.0") and closing quotes, both of which have caused a blocking false positive next door.
import { backedFamilies } from "./unbackedClaim";
import { sentenceAround } from "./askWithoutAction";

/** The check id. Must equal the `[concierge.checks.<id>]` table key in `config.toml`. */
export const DEFECT_WITHOUT_DISPOSITION_CHECK_ID = "defect-without-disposition";

/**
 * DID THIS TURN DISPOSE OF ANYTHING?
 *
 * A bead filed or an agent spawned. Named rather than inlined so the INTENT is readable at the call
 * site and testable on its own — "these two families are what disposing of a defect looks like" is
 * the design decision, and burying it inside a `.has()` chain would make it look like an
 * implementation detail of the scan.
 *
 * ══ WHY A MESSAGE IS NOT A DISPOSITION (the founder's ruling, 2026-08-05) ═══════════════════════
 * The brief's constraint 2 listed a message to an owning agent alongside a bead and a spawn. Taken
 * literally that exempts the very turn this check was built for: the originating miss DID send to an
 * existing agent, and filed nothing. Asked to choose, the founder ruled that a newly-asserted defect
 * needs a BEAD (or a spawn) — messaging is fine, but only in addition. His words in the originating
 * message are the same ruling: "You should be filing a bead and maybe even starting it with an agent
 * if it's a high enough priority."
 *
 * The cost is accepted and is not silent: a turn that routes a defect to its owning agent and
 * reasonably judges no bead is warranted must SAY the reason, which {@link NOT_ACTING_PATTERNS}
 * exempts. "Only silence is a violation" survives — a message alone is silence about the record.
 *
 * Deliberately a SUBSET of `backedFamilies`' six: `close`, `goal`, `merged` and `send` are real
 * writes and real work, and none of them puts a named defect anywhere a human will find it again.
 * That subsetting is the whole difference from `askWithoutAction.tookAction`, which accepts any
 * write at all — and it is why a turn that acts on issue A cannot launder issue B.
 */
export function tookDisposition(calls: readonly LintToolCall[] | undefined): boolean {
  const backed = backedFamilies(calls);
  return backed.has("filed") || backed.has("spawn");
}

/** One way of asserting that a defect exists, and the frame it is asserted in. */
interface DefectPattern {
  readonly re: RegExp;
  /** Names the FRAME, never the reply's words — `detail` is metadata and carries no prose. */
  readonly label: string;
}

/**
 * A run of ordinary words that may sit between a frame and its defect noun — "a", "still another",
 * "a second real" — WITHOUT admitting a negation.
 *
 * The lookahead is load-bearing in both directions: "there is no bug here" and "that is not broken"
 * are the concierge REPORTING THAT NOTHING IS WRONG, and flagging those would make the check fire
 * hardest on exactly the replies that did their job.
 */
const FILLER = String.raw`(?:(?!no\b|not\b|never\b|nothing\b)[\w'’-]+\s+)`;

/** The defect nouns, as one alternation. `stale` is DELIBERATELY ABSENT — see {@link DEFECT_PATTERNS}. */
const DEFECT_NOUN = String.raw`bugs?|defects?|regressions?|race\s+conditions?|races?|leaks?|deadlocks?|crashes?|no-?ops?|dead\s+code`;

/**
 * THE GRAMMAR. A defect NOUN plus an existence/attribution frame, or a defect PREDICATE.
 *
 * ══ WHAT IS DELIBERATELY NOT HERE ══════════════════════════════════════════════════════════════
 *   • A BARE DEFECT NOUN. "bug", "regression" and "crash" are ordinary vocabulary in this app's
 *     conversations ("the bug bead", "regression tests", "a crash report"). A keyword scan is the
 *     23%-at-70%-false-positives design `unbackedClaim`'s header measured and rejected.
 *   • `stale`. The founder's brief lists it as a noun to consider, and the corpus says no: "the
 *     branch is stale" is this concierge's most common use of the word by a wide margin, and it
 *     describes a FRESHNESS STATE with its own guardrails (AGENTS.md `[freshness]`), not a defect.
 *     Admitting it would fire on routine branch triage.
 *   • `does not run` / `never runs` / `never updates`. Too close to ordinary description of designed
 *     behaviour — "the check does not run when severity is off" is a correct sentence about correct
 *     code. The negative-behaviour frame is held to verbs whose negation reads as breakage.
 *   • `failed`. A tool call that "failed" is a refusal the concierge is reporting, which is
 *     `unreported-refusal`'s territory; only `is/are failing` and `fails to/on/when/…` are here.
 */
export const DEFECT_PATTERNS: readonly DefectPattern[] = [
  // EXISTENCE — "there is a bug in the rollup", "there's a race between the two writers".
  {
    re: new RegExp(
      String.raw`\bthere(?:'s|’s|\s+is|\s+are|\s+was|\s+were)\s+${FILLER}{0,3}(?:${DEFECT_NOUN})\b`,
      "gi",
    ),
    label: "existence",
  },
  // PREDICATE — "the pill is broken", "that's a regression", "it is a no-op", "this is dead code".
  {
    re: new RegExp(
      String.raw`\b(?:is|are|was|were|'s|’s)\s+${FILLER}{0,2}(?:broken|inert|misfiring|dead\s+code|a\s+(?:${DEFECT_NOUN}))\b`,
      "gi",
    ),
    label: "predicate",
  },
  // ATTRIBUTION — "the bug is in workerRollup.ts", "the root cause is the status filter".
  {
    re: /\b(?:the\s+)?(?:bug|defect|regression|breakage|root\s+cause|cause)\s+(?:is|was)\b/gi,
    label: "attribution",
  },
  // ATTRIBUTION — "traced it to workerRollup.ts:169", the sentence the originating miss contained.
  { re: /\btraced\s+(?:it|this|that|them|the\s+[\w'’-]+)\s+to\b/gi, label: "attribution" },
  // NEGATIVE BEHAVIOUR — "the pill never fires", "the guard does not fire", "it no longer surfaces".
  {
    re: /\b(?:never|does\s+not|doesn'?t|do\s+not|don'?t|no\s+longer)\s+(?:ever\s+|actually\s+)?(?:fires?|triggers?|raises?|surfaces?|renders?|reaches?)\b/gi,
    label: "negative behaviour",
  },
  // NEGATIVE BEHAVIOUR, OBJECT FORM — "a plan-approval prompt raises no pill".
  {
    re: /\b(?:fires?|triggers?|raises?|surfaces?|renders?|produces?|emits?|shows?)\s+no\s+[\w'’-]+/gi,
    label: "negative behaviour",
  },
  // NOT WIRED — the app's own word for a surface that exists and is connected to nothing.
  { re: /\b(?:is|are|was|were)\s+(?:still\s+|simply\s+)?not\s+wired\b/gi, label: "not wired" },
  { re: /\bnever\s+wired\b/gi, label: "not wired" },
  { re: /\bmisfires?\b|\bmisfired\b/gi, label: "misfire" },
  // FAILING — a live failure, not a tool call that returned an error (see the header note on `failed`).
  {
    re: /\b(?:is|are|was|were|keeps?|kept)\s+(?:still\s+|now\s+|currently\s+)?failing\b/gi,
    label: "failing",
  },
  { re: /\bfails?\s+(?:to|on|when|with|because|silently|outright)\b/gi, label: "failing" },
  // HARD FAILURES, as verbs. Present/past indicative only — no infinitive, so no future can match.
  { re: /\b(?:crashes|crashed|deadlocks|deadlocked|leaks|leaked)\b/gi, label: "hard failure" },
];

/**
 * Negative subjects: the words that make a defect PREDICATE into a report that nothing is wrong.
 *
 * {@link FILLER}'s lookahead guards the material AFTER the frame ("there is no bug", "is not
 * broken") and cannot see what comes BEFORE it, so "Nothing is broken there." matched `is broken`
 * and fired on the concierge saying everything is fine — the worst direction for this check to be
 * wrong in, since it would fire hardest on the replies that did their job. Caught by its own test.
 *
 * Checked as the word immediately preceding the match rather than anywhere in the sentence: a
 * sentence-wide test would silence "Nothing else changed, but the pill never fires."
 */
const NEGATIVE_SUBJECTS: ReadonlySet<string> = new Set([
  "nothing",
  "none",
  "nobody",
  "neither",
  "nowhere",
  "no",
]);

/** Is the frame at `index` governed by a negative subject — "Nothing is broken"? */
export function hasNegativeSubject(value: string, index: number): boolean {
  const before = value.slice(0, index).replace(/\s+$/, "");
  const word = /([A-Za-z][A-Za-z'’-]*)$/.exec(before)?.[1];
  return word !== undefined && NEGATIVE_SUBJECTS.has(word.toLowerCase());
}

/**
 * EXCLUSION A — ALREADY HANDLED. The founder's constraint 4, and the obvious false positive:
 * REPORTING a defect that is already dealt with is not the failure this check exists for.
 *
 * "The TypeScript error, already fixed on main." must pass, verbatim.
 *
 * The last three entries treat an adjacent BEAD ID or PR NUMBER as evidence the thing is tracked.
 * That is broader than it looks — "PR #1315 is broken" is a defect assertion that mentions a PR
 * number and will be exempted by it — and it is the right trade anyway: the error it admits is a
 * false NEGATIVE on a check written to block, and a reply that names an id has given the human
 * something to follow, which is most of what filing buys.
 */
export const ALREADY_HANDLED_PATTERNS: readonly RegExp[] = [
  /\balready\s+(?:fixed|landed|merged|closed|filed|tracked|open|reported|patched|handled|known)\b/i,
  /\balready\s+has\s+a\s+bead\b/i,
  /\balready\s+open\s+as\b/i,
  /\bwas\s+(?:fixed|patched|closed|reverted)\b/i,
  /\b(?:fixed|landed|merged|patched)\s+(?:on|in)\s+(?:main|origin\/main|master|trunk|the\s+release)\b/i,
  /\bfixed\s+by\b/i,
  /\bknown\s+issue\b/i,
  /\bcovered\s+by\b/i,
  /\btracked\s+(?:as|in|by|under)\b/i,
  /\bhas\s+a\s+bead\b/i,
  // Evidence of tracking by reference: a bead id, a beads-CLI id, or a PR/issue number.
  /\bsparkle-[a-z0-9]{3,}\b/i,
  /\bbd-[a-z0-9][\w.-]*\b/i,
  /#\d+\b/,
];

/**
 * EXCLUSION B — A STATED REASON FOR NOT ACTING. The founder's constraint 2, and his standing rule:
 * "if you decide an action is not worth taking, name the specific reason."
 *
 * A named reason is a DISPOSITION — the defect was considered and declined on the record, which is
 * the opposite of the silence this check is for. The list is curated rather than derived from a bare
 * "because": every sentence explaining a defect contains a because, so keying on it would delete the
 * check. What is required is a phrase that declines or reclassifies.
 */
export const STATED_REASON_PATTERNS: readonly RegExp[] = [
  /\bnot\s+worth\s+(?:filing|fixing|chasing|a\s+bead|the\s+bead)\b/i,
  /\b(?:not|isn'?t|aren'?t|won'?t\s+be)\s+filing\b/i,
  /\bno\s+bead\b/i,
  /\bleaving\s+(?:it|this|that)\b/i,
  /\bby\s+design\b/i,
  /\bdeliberate(?:ly)?\b/i,
  /\bintentional(?:ly)?\b/i,
  /\bon\s+purpose\b/i,
  /\bworking\s+as\s+intended\b/i,
  /\bexpected\s+behaviou?r\b/i,
  /\b(?:not|isn'?t|is\s+not)\s+a\s+bug\b/i,
];

/**
 * EXCLUSION C — HYPOTHETICAL / CONDITIONAL / FUTURE. An assertion is PRESENT OR PAST INDICATIVE, the
 * same requirement (B) `unbackedClaim` holds its claims to.
 *
 * "If it were broken the pill would be missing" describes a world that does not exist; "that could
 * regress" is a risk, not a finding. Filing a bead for a hypothetical is not the behaviour anyone
 * wants, so flagging one would push the concierge toward noise.
 */
export const HYPOTHETICAL_PATTERNS: readonly RegExp[] = [
  /\bif\b/i,
  /\bunless\b/i,
  /\bwhether\b/i,
  /\bwould\b/i,
  /\bcould\b/i,
  /\bmight\b/i,
  /\bmay\s+be\b/i,
  /\bwere\s+to\b/i,
  /\bin\s+case\b/i,
  /\bat\s+risk\s+of\b/i,
  /\bwill\s+(?:break|regress|fail|crash)\b/i,
];

/**
 * EXCLUSION D — THE HUMAN'S OWN CLAIM. `excludeBlockquote` catches the quoted form structurally; this
 * catches the attributed one. "You said the pill never fires" is the concierge REPEATING the report
 * it was handed, and holding it responsible for filing the human's own observation as a bead — on
 * the turn the human made it — is the wrong-target mistake `hedgeWords` documents.
 */
export const HUMAN_ATTRIBUTED_PATTERNS: readonly RegExp[] = [
  /\byou\s+(?:said|say|mentioned|noted|flagged|reported|wrote|told|asked|pointed\s+out)\b/i,
  /\byou'?re\s+seeing\b/i,
  /\byou\s+saw\b/i,
  /\byour\s+(?:point|note|report|screenshot)\b/i,
];

const ALL_EXCLUSIONS: readonly (readonly RegExp[])[] = [
  ALREADY_HANDLED_PATTERNS,
  STATED_REASON_PATTERNS,
  HYPOTHETICAL_PATTERNS,
  HUMAN_ATTRIBUTED_PATTERNS,
];

/** Is this ONE SENTENCE exempt? Never the paragraph — roborev 55713, twice over in this folder. */
export function sentenceIsExempt(sentence: string): boolean {
  return ALL_EXCLUSIONS.some((group) => group.some((p) => p.test(sentence)));
}

export const defectWithoutDispositionCheck: Check = {
  id: DEFECT_WITHOUT_DISPOSITION_CHECK_ID,
  run(text: string, ctx: LintContext): { text: string; violations: Violation[] } {
    const policy = ctx.policy?.checks?.[DEFECT_WITHOUT_DISPOSITION_CHECK_ID];
    const severity: Severity = policy?.severity ?? "warn";

    // THE SECOND HALF OF THE TEST, checked first because it is the cheap way out. A turn that filed,
    // spawned or sent has disposed of something; this check cannot prove WHICH thing (see the header)
    // and staying silent is the only honest answer available to it.
    if (tookDisposition(ctx.toolCalls)) return { text, violations: [] };

    const violations: Violation[] = [];
    // EXCLUSION E — NOT PROSE. `proseSpans` drops fenced blocks and inline code structurally, so a
    // defect asserted inside a pasted log or a quoted diff is not the concierge's own voice; and
    // `excludeBlockquote` drops the human's words quoted back.
    for (const span of proseSpans(text, { excludeBlockquote: true })) {
      // ONE VIOLATION PER ASSERTED DEFECT, and a defect is asserted in ONE SENTENCE. Several frames
      // routinely match the same sentence — "There is a bug: the pill never fires" is `existence` and
      // `negative behaviour` — and counting that twice would overstate a number the human is meant to
      // trust, the same reasoning `askWithoutAction` uses for its one-per-span break.
      const seen = new Set<string>();
      for (const { re, label } of DEFECT_PATTERNS) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(span.value)) !== null) {
          if (m[0].length === 0) {
            re.lastIndex += 1;
            continue;
          }
          if (hasNegativeSubject(span.value, m.index)) continue;
          const sentence = sentenceAround(span.value, m.index);
          if (seen.has(sentence)) continue;
          if (sentenceIsExempt(sentence)) continue;
          seen.add(sentence);
          violations.push({
            check: DEFECT_WITHOUT_DISPOSITION_CHECK_ID,
            severity,
            // Always `"warned"`: nothing revises a reply yet, and stamping `"revised"` would inflate
            // the correction-rate rollup this log exists to make trustworthy (roborev 55981).
            action: "warned",
            // METADATA ONLY — a character COUNT, never the matched text, and a frame name rather than
            // any of the reply's own words (`Violation`'s doc comment; `conciergeAudit.ts`'s standing
            // decision against putting concierge prose on disk).
            span: m[0].length,
            detail: `asserted a defect (${label}) with no bead, agent, or stated reason`,
          });
        }
      }
    }
    return { text, violations };
  },
};
