// WHAT THE REPLY LINTER FOUND, AS THE THREAD CARRIES AND WORDS IT (bead sparkle-kr2jz, part A).
//
// ══ THE HOLE THIS FILLS ═════════════════════════════════════════════════════════════════════════
// `services/conciergeLint/` is complete, tested and mounted — `runReplyLint` runs on every
// `concierge:done`. Its findings then went exactly two places: an in-memory session counter nothing
// in the app reads (stores/conciergeLintMetrics), and a JSONL only a CLI script reads. So the
// `ask-without-action` check — the one that catches the founder's most-repeated complaint, a reply
// that says "say go and I'll spawn it" instead of spawning it — fired correctly and INVISIBLY.
// Measured over 1,490 concierge turns: 45 first-person promises, 35 never carried out. He had no way
// to see any of it. A detector whose output nobody can see is indistinguishable from no detector.
//
// This module is the wording half of the fix. The rendering half is ./LintMark.
//
// ══ METADATA ONLY, AND THAT IS A HARD RULE ══════════════════════════════════════════════════════
// A mark carries the check id, the severity, and the check's own short `detail` — never the reply
// text and never the matched span. `Violation.span` is a CHARACTER COUNT for exactly this reason
// (services/conciergeLint/types.ts) and `detail` is constrained to a short reason under the same
// rule. This module drops `span` on the floor rather than carrying a number no reader wants, and it
// CLIPS `detail`, because a mark is persisted to localStorage and a check written later could
// interpolate something long into it.
//
// ══ WHY THE PURE / COMPONENT SPLIT ══════════════════════════════════════════════════════════════
// Same split ./replyAnchors ↔ ./ReplyAnchorViews already uses in this directory, and for the same
// two reasons. The WORDING is a correctness concern — "Said it would do it" versus a check id is the
// entire point of the feature — so it is unit-tested as a function rather than asserted through a
// rendered tree, exactly as `RoutingReceipt.receiptText` is. And `stores/conciergeThreadStore` has
// to bound and re-validate these on the persistence boundary, which means importing the rule; a
// store importing a `.tsx` full of React to get a sanitiser would be the wrong dependency.
import type { Severity } from "../../services/conciergeLint";

/** One finding, as it rides on the message it was found in.
 *
 *  A PROJECTION of `services/conciergeLint`'s `Violation`, not a re-export of it, and the difference
 *  is the point: `Violation` also carries `span` (a character count) and `action` (what the app did
 *  about it), neither of which a reader looking at a bubble has any use for. Narrowing here is what
 *  makes "metadata only" checkable by reading the type instead of by trusting a call site. */
export interface MessageLintMark {
  /** The linter's check id (`"ask-without-action"`, …). Kept RAW rather than pre-worded so the
   *  copy can change without a persisted thread carrying yesterday's sentence forever. */
  check: string;
  severity: Severity;
  /** The check's own short reason. Rendered nowhere today — {@link lintCheckSentence} is what the
   *  reader sees — and carried because it is the difference between "hedged" and WHICH word hedged,
   *  which is what an expansion affordance would need. Clipped to {@link LINT_DETAIL_MAX_LEN}. */
  detail: string;
}

/** How many marks one message may carry.
 *
 *  Bounded for the reason `conciergeThreadStore` bounds every other per-message payload: this field
 *  is persisted, and `hedge-words` reports ONE VIOLATION PER HEDGING WORD — a long waffly reply can
 *  produce dozens. The mark collapses to a single line with a count regardless (see
 *  {@link lintMarkText}), so past the first handful the extra records buy the reader nothing and
 *  cost the ~5MB localStorage quota the whole store shares. Six is well past what any wording
 *  distinguishes. */
export const MAX_LINT_MARKS = 6;

/** …and how long one mark's `detail` may be. Every shipped check writes well under this; the cap is
 *  for the check written next, which is the one that can interpolate an unbounded string. */
export const LINT_DETAIL_MAX_LEN = 200;

/** …and the same for `check`. roborev 57898: `check` was validated for TYPE but never bounded, so a
 *  hand-edited localStorage payload carrying a multi-megabyte check id survived every round trip —
 *  `rehydrateThread` re-validated it and `persistableThread` wrote it straight back. That is exactly
 *  the "a field the text cap cannot see blows the ~5MB quota and zustand silently stops persisting
 *  the whole store" failure the persistence bound exists to prevent, through the one field it did
 *  not cover. Generous next to any real id (the longest shipped is `unresolved-agent-pill`). */
export const LINT_CHECK_MAX_LEN = 64;

/**
 * WHAT EACH CHECK MEANS, IN THE FOUNDER'S TERMS.
 *
 * The bead is explicit that the mark must say what was WRONG, not name the check: "Said it would
 * send — no send in this turn" beats "ask-without-action". A check id is a name for the code that
 * found the problem; it is not a description of the problem, and a reader who has to learn eleven
 * ids before the surface says anything has been handed a log, not a signal.
 *
 * Every id in `stores/conciergeLintMetrics.LINT_CHECK_IDS` has a row here, pinned by a test against
 * that list — a check shipped without a sentence would fall through to {@link lintCheckSentence}'s
 * fallback and print its own id at the founder, which is the exact failure this map exists to end.
 *
 * The list is NOT imported from that store. Nothing under `components/Concierge` touches a store
 * (see ./types' header), and this map is keyed by plain string anyway because the linter's registry
 * is OPEN (`registerCheck`) — a check id can reach this build that the metrics union has no member
 * for, and that case has to render something rather than crash. The TEST imports the store's list
 * and asserts coverage, which is where that dependency belongs.
 */
const CHECK_SENTENCES: Record<string, string> = {
  // THE HEADLINE ONE. The founder, verbatim: "You'll often tell me you're gonna do something and
  // then you don't do it." This sentence is his complaint read back to him, which is what makes the
  // mark recognisable at a glance instead of something to decode.
  "ask-without-action": "Said it would do it — then didn't, this turn",
  // THE OTHER HALF OF THE HEADLINE. `ask-without-action` catches the reply that OFFERS instead of
  // acting; this one catches the reply that says it ALREADY acted when the turn made no such call.
  // Measured across all 1,490 logged turns, 32 of 145 first-person past-tense action claims had no
  // matching tool call. The wording says "this turn" for the same reason the check ignores past-turn
  // references: the check cannot see earlier turns, so the mark must not accuse the reply of more
  // than it actually observed.
  "unbacked-claim": "Said it did it — no matching action this turn",
  // THE THIRD OF THAT FAMILY, and the one the founder had to catch by hand: the reply diagnosed a
  // real bug and then filed nothing, spawned nobody, and messaged no one. Worded as the OMISSION
  // rather than as the diagnosis, because the diagnosis was the good part — what went missing is the
  // disposition. "Nothing attached" rather than "no bead" so the sentence stays true of the other two
  // dispositions the check accepts (an agent spawned, a message sent).
  "defect-without-disposition": "Named a bug — nothing attached to it",
  // His own standing rule, read back to him in his own terms: every reply opens with a blockquote of
  // what he said. Worded as the OMISSION and in the second person like its neighbours, and it names
  // the OPENING rather than the quote, because a reply with the quote buried three paragraphs down
  // is the exact shape the rule exists against.
  "reply-without-quote": "Didn't open by quoting what you said",
  "bare-agent-name": "Named an agent you can't click",
  "bare-pr-number": "Named a PR you can't click",
  "fat-pill-label": "Put a whole sentence inside a pill",
  "unresolved-agent-pill": "Linked an agent that isn't there",
  "relay-paste": "Pasted your own words back at you",
  "actions-first": "Buried what it did under the explanation",
  "unreported-refusal": "Something refused it — and it didn't say so",
  "hedge-words": "Hedged instead of saying what happened",
  "restated-state": "Repeated what it already told you",
  "naked-file-ref": "Named a file with nothing said about it",
};

/**
 * The reader-facing sentence for one check id.
 *
 * The fallback NAMES THE ID rather than saying something vague. A check with no sentence here is a
 * gap in this file, and "Something looked off in this reply" would hide that gap behind copy that
 * reads deliberate — whereas an id on screen is self-reporting: whoever sees it knows precisely
 * which row is missing. It is also the honest amount of information the app actually has.
 */
export function lintCheckSentence(check: string): string {
  return CHECK_SENTENCES[check] ?? `Flagged by ${check}`;
}

/**
 * THE WHOLE MARK, COLLAPSED TO ONE LINE — or null when there is nothing to say.
 *
 * ONE LINE, ALWAYS, however many checks fired. The bead's constraint is that a false positive must
 * cost a glance and nothing more; a stack of five annotations under a reply costs a paragraph, and
 * would push the conversation off screen in a column this narrow — the same failure the collapsed
 * payload field exists to prevent (see ./types `ConciergeSparkleMessage.collapsed`).
 *
 * The FIRST finding is the one worded, not a count alone ("3 issues"), because a bare number tells
 * the reader nothing and forces a click the bead explicitly does not require. Violations arrive in
 * registry order, so the head is stable for a given reply rather than a race.
 */
export function lintMarkText(marks: readonly MessageLintMark[] | undefined): string | null {
  if (!marks?.length) return null;
  const head = lintCheckSentence(marks[0]!.check);
  return marks.length === 1 ? head : `${head} · +${marks.length - 1} more`;
}

/** One record reduced to the three fields a mark may hold, with `detail` clipped. Shared by both
 *  entry points below so the live path and the restore path cannot disagree about what a mark is. */
function sanitize(v: { check?: unknown; severity?: unknown; detail?: unknown }): MessageLintMark | null {
  if (typeof v?.check !== "string" || !v.check) return null;
  const check = v.check.slice(0, LINT_CHECK_MAX_LEN);
  // `severity` is passed through as whatever the producer said. `severityBlocks`/`severityRuns`
  // already tolerate an unknown tier by design (services/conciergeLint/types), and a mark whose only
  // consumer is a `data-` attribute must not be the one place that hard-rejects a new one.
  const severity = (typeof v.severity === "string" ? v.severity : "warn") as Severity;
  const detail = typeof v.detail === "string" ? v.detail.slice(0, LINT_DETAIL_MAX_LEN) : "";
  return { check, severity, detail };
}

/**
 * Turn the linter's violations into the marks a message carries — or `undefined` for a clean reply.
 *
 * `undefined` RATHER THAN `[]`, matching every other optional field on a concierge message: the
 * thread is persisted, and an empty array per clean turn is bytes in localStorage that say exactly
 * what the absent field says. It also makes "did this reply have findings" a plain truthiness test
 * at every call site instead of a `.length` nobody remembers.
 */
export function toLintMarks(
  violations: readonly { check: string; severity: Severity; detail: string }[] | undefined,
): MessageLintMark[] | undefined {
  if (!Array.isArray(violations) || violations.length === 0) return undefined;
  const marks: MessageLintMark[] = [];
  for (const v of violations) {
    const m = sanitize(v);
    if (m) marks.push(m);
    if (marks.length === MAX_LINT_MARKS) break;
  }
  return marks.length ? marks : undefined;
}

/**
 * Re-validate marks that came back off DISK, where the shape is not guaranteed.
 *
 * A persisted thread is untrusted input: it was written by whatever build ran last, and localStorage
 * is hand-editable. `rehydrateThread` runs this so a malformed or oversized `lint` array cannot reach
 * the renderer — the same posture that module already takes for ids and reply anchors, applied
 * deliberately rather than by the field surviving a spread nobody thought about.
 */
export function normalizeLintMarks(value: unknown): MessageLintMark[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return toLintMarks(
    value.filter((v): v is { check: string; severity: Severity; detail: string } => !!v && typeof v === "object"),
  );
}
