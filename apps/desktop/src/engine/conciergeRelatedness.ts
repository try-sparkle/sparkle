// Is the message that just arrived PART OF THE ONE BEFORE IT? — the concierge's run-absorption judge.
//
// THE DEFECT. The founder types a message and then, a beat later, a second one carrying the context
// that completes it: "hold the deploy" … "the migration hasn't run yet". The concierge answered the
// first one alone, and the answer was worse for it — it was replying to half a thought while the
// other half was still in flight. In his words: he sends a follow-up carrying the context and gets
// answered before it lands. This module is the judgement that lets the turn queue WAIT and absorb
// the run into a single turn instead.
//
// WHY THIS IS A LOCAL HEURISTIC AND NOT A MODEL CALL. The app already owns a model judge — it shells
// out to the `claude` CLI, and measured, it costs p50 8.4s / p90 31.9s. This judgement runs while
// the founder is sitting there waiting for his reply, so a model call would spend more time deciding
// whether to wait than the wait it is deciding about. So: no model call, no async, no I/O, no clock.
// One pure function over the strings it is handed, importable by the queue, the UI and a test alike
// without any of them dragging in the others (the same rule `voice/confidence` states for itself).
//
// WHY THE DEFAULT IS ABSORB. `different` requires POSITIVE EVIDENCE — an explicit topic-shift phrase
// or a gap long enough to be a new sitting. Everything else is `related`. That asymmetry is the
// load-bearing safety property, and it comes straight from the defect: SPLITTING is the behaviour
// the founder is complaining about, so no path through this module — including every failure path —
// may produce it. `isRelated` therefore returns TRUE on any throw, a non-finite gap is never a topic
// shift, and an empty message is related. The cost of absorbing too eagerly is one turn that carries
// an extra sentence; the cost of splitting is the bug we are fixing.
//
// DELIBERATELY NO LEXICAL / WORD-OVERLAP RULE. It is the obvious next idea and it is wrong here: the
// follow-up this feature exists to catch is precisely the one that shares no content words with the
// run, because it refers back with a pronoun ("it needs the flag too"). An overlap score would split
// exactly the case we are trying to join.

import { endsMidThought } from "../voice/confidence";

/** The judgement, plus why — the reason is logged next to the absorbed run so a bad call is legible. */
export type Relatedness = { verdict: "related" | "different"; reason: string };

/**
 * How many messages one turn may absorb before the queue stops adding to it.
 *
 * A resource bound for the CALLER, not part of the judgement below: hitting it does not mean the
 * next message is unrelated, it means this turn is big enough to answer. Keeping it out of
 * `judgeRelatedness` is what preserves "different requires positive evidence" — a cap firing would
 * be a `different` verdict with no evidence behind it.
 */
export const MAX_ABSORBED_RUN = 8;

/** The same bound measured in characters, for the caller. One long dictation can hit it before 8 messages do. */
export const MAX_RUN_CHARS = 12_000;

/**
 * Past this much silence, a new message is a new sitting rather than a continuation — the only
 * time-based evidence of a topic shift this module accepts, and it loses to every rule 1 signal.
 *
 * 45s is deliberately generous. Absorbing a genuinely new topic costs one turn with a stray
 * paragraph in it; splitting a follow-up is the defect. When in doubt, wait.
 */
export const TOPIC_SHIFT_GAP_MS = 45_000;

/** Caller-side: how long an absorbed run may still be superseded/rewritten before it is answered. */
export const MAX_SUPERSEDE_GAP_MS = 30_000;

/**
 * Openers that mean "I am still talking".
 *
 * NOTE THE DELIBERATE ASYMMETRY with `voice/confidence`'s TRAILING_CONJUNCTIONS, which is a
 * different list on purpose and NOT a duplicate of this one. Position flips the meaning: "and" at
 * the END of an utterance means the speaker trailed off mid-clause, while "and" at the START means
 * the speaker is continuing a clause they already finished elsewhere. Same word, opposite evidence,
 * so folding the two lists together would import a set tuned for one question into the other. (The
 * one rule the two layers genuinely share — "does this text stop mid-thought" — IS shared, imported
 * from confidence.ts above rather than copied.)
 *
 * Multi-word entries are matched as whole phrases, so "no wait" is here rather than a bare "no",
 * which on its own is usually an answer and not a continuation.
 */
const CONTINUATION_OPENERS = [
  "and then",
  "and",
  "also",
  "plus",
  "oh",
  "so",
  "but",
  "because",
  "actually",
  "i mean",
  "sorry",
  "no wait",
  "to be clear",
  "btw",
  "basically",
  "or rather",
  "one more thing",
] as const;

/**
 * A first word that CANNOT stand on its own — it points back at something in the previous message.
 *
 * FIRST WORD ONLY, and that is the whole rule: a pronoun anywhere else has its antecedent inside its
 * own sentence ("Deploy it now" is self-contained and is not a continuation by this rule). A message
 * that OPENS with one has no antecedent to offer, so its subject is in the run.
 */
const LEADING_PRONOUNS = new Set(["it", "that", "this", "those", "these", "they", "them"]);

/**
 * Phrases with which the founder announces a topic change himself. This is the positive evidence
 * `different` requires — he said so, in as many words.
 */
const TOPIC_SHIFT_PHRASES = [
  "separately",
  "different topic",
  "unrelated",
  "changing subject",
  "change of subject",
  "new topic",
  "on another note",
  "switching gears",
  "totally different",
  "different question",
] as const;

/** Lowercased, leading quotes/dashes/bullets stripped, whitespace collapsed — for prefix matching. */
function normalizeOpening(text: string): string {
  return text
    .trim()
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .toLowerCase()
    .replace(/\s+/gu, " ");
}

/**
 * The message's opening, plus the text after ONE short leading clause.
 *
 * "separately, what about X" and "ok, separately, what about X" are the same announcement, and only
 * the first is anchored at index 0. Bounded to a SHORT lead (three words) and a single comma so this
 * stays an anchor rather than the unbounded substring scan it replaces.
 */
function openingClauses(opening: string): string[] {
  const out = [opening];
  const comma = opening.indexOf(",");
  if (comma > 0) {
    const lead = opening.slice(0, comma);
    if (lead.split(" ").filter(Boolean).length <= 3) out.push(opening.slice(comma + 1).trim());
  }
  return out;
}

/** Does `haystack` begin with `phrase` as whole words (so "so" does not match "society")? */
function startsWithPhrase(haystack: string, phrase: string): boolean {
  if (!haystack.startsWith(phrase)) return false;
  const after = haystack.charAt(phrase.length);
  return after === "" || !/[\p{L}\p{N}]/u.test(after);
}

/** The first word of `next`, punctuation-stripped and lowercased. `""` when there is none. */
function firstWord(normalized: string): string {
  const raw = normalized.split(" ")[0] ?? "";
  // The typographic apostrophe is folded to the ASCII one FIRST. Without it `"It’s"` — which is what
  // dictation and macOS smart quotes actually produce — loses the mark to the class strip below and
  // arrives as `its`, matching nothing.
  return raw.replace(/[’‘]/gu, "'").replace(/[^\p{L}\p{N}']/gu, "");
}

/**
 * The pronoun stem of a first word, with a contraction's tail removed.
 *
 * ══ WHY (roborev 65837) ════════════════════════════════════════════════════════════════════════
 * `LEADING_PRONOUNS` holds bare pronouns, so `"It's still failing on the runner."` — about as clear
 * an anaphoric continuation as exists — matched NOTHING and fell through to the gap rule, which
 * split it. That is the failure direction this module states it must never take, produced by the
 * most common way anyone actually writes a follow-up.
 */
function pronounStem(word: string): string {
  return word.replace(/'(?:s|re|ve|ll|d|m)$/u, "");
}

/**
 * Does the message begin with a lowercase letter?
 *
 * A dictation continuation: the transcriber capitalizes the start of a fresh utterance, so a
 * lowercase opening is the tail of one that already started. Scripts without case (CJK) are NOT
 * lowercase for this purpose — `toLowerCase() === toUpperCase()` there, and reading every Japanese
 * message as a continuation would be a rule firing on the absence of evidence.
 */
function startsLowercase(trimmed: string): boolean {
  const ch = trimmed.charAt(0);
  if (ch === "") return false;
  return ch.toLowerCase() === ch && ch.toUpperCase() !== ch;
}

/**
 * Is `next` part of the run so far, or the start of something else?
 *
 * @param run    the messages absorbed so far, oldest first, at least one
 * @param next   the candidate message
 * @param gapMs  elapsed ms between the last run message and `next`
 *
 * Evaluated in a fixed order, and the order IS the policy:
 *   1. a continuation signal short-circuits everything — including the gap
 *   2. an explicit topic-shift phrase near the start
 *   3. a gap longer than TOPIC_SHIFT_GAP_MS
 *   4. otherwise related
 *
 * Rule 1 beating rule 3 is the pairing most likely to regress and the one that matters most: a
 * message cut off mid-thought is completed by whatever follows it, however long the founder took to
 * type the rest. Rule 1 beating rule 2 is likewise deliberate — "and separately, …" is a man adding
 * a second item to the thing he is already saying, not opening a new sitting.
 */
export function judgeRelatedness(run: readonly string[], next: string, gapMs: number): Relatedness {
  // THE FAIL-SAFE LIVES HERE, not only in `isRelated` (roborev 65837). This is the exported entry
  // point a caller must use to obtain `reason`, so the documented usage was precisely the path with
  // NO guard — a bug in this module would surface there as an exception thrown into the turn queue
  // rather than as the absorb the founder asked for. `isRelated` is now a thin wrapper over this.
  try {
    return judgeUnguarded(run, next, gapMs);
  } catch {
    return {
      verdict: "related",
      reason: "the judge threw — absorbing, because splitting is the defect",
    };
  }
}

/** The rules themselves. Never called directly — {@link judgeRelatedness} owns the failure direction. */
function judgeUnguarded(run: readonly string[], next: string, gapMs: number): Relatedness {
  const trimmed = next.trim();

  // Nothing to judge. Absorb — an empty message is never evidence of a new topic.
  if (trimmed === "") return { verdict: "related", reason: "empty message — nothing says new topic" };

  const opening = normalizeOpening(trimmed);

  // ── 1. CONTINUATION SIGNAL — short-circuits rules 2 and 3 ───────────────────────────────────
  for (const marker of CONTINUATION_OPENERS) {
    if (startsWithPhrase(opening, marker)) {
      return { verdict: "related", reason: `continuation opener "${marker}"` };
    }
  }

  const first = pronounStem(firstWord(opening));
  if (LEADING_PRONOUNS.has(first)) {
    return { verdict: "related", reason: `opens with the bare pronoun "${first}" — its antecedent is in the run` };
  }

  // ── 2. EXPLICIT TOPIC SHIFT — the founder said so himself ───────────────────────────────────
  //
  // ══ ABOVE THE WEAK SIGNALS, AND ANCHORED — BOTH CORRECTIONS FROM roborev 65837 ═══════════════
  // ORDER: this used to sit below the lowercase-start check. The founder types lowercase, which is
  // his dominant input mode, so in practice that ordering made this entire list AND the gap rule
  // unreachable — `"separately, what about the DMG?"` was absorbed despite announcing a new topic
  // in as many words. An explicit announcement is stronger evidence than casing, so it is weighed
  // first. It still sits BELOW the continuation openers and the bare-pronoun test, which are
  // explicit connectives pointing back into the run: "and separately, …" is a continuation.
  //
  // ANCHORED: this used to be a bare `includes` over the first 48 characters, so an ordinary
  // sentence that merely USES one of these words early was split — "Can you check whether that DMG
  // is unrelated to the runner?" contains "unrelated" at index ~33 and came back `different`. That
  // is the exact defect this module exists to remove, caused by the one rule that produces it.
  // A short leading clause is still allowed ("ok, separately …") because that is how the phrase is
  // actually spoken, but the phrase must OPEN the message or the clause after it.
  for (const candidate of openingClauses(opening)) {
    for (const phrase of TOPIC_SHIFT_PHRASES) {
      if (startsWithPhrase(candidate, phrase)) {
        return { verdict: "different", reason: `explicit topic-shift phrase "${phrase}"` };
      }
    }
  }

  // ── 1c. WEAKER CONTINUATION SIGNALS ─────────────────────────────────────────────────────────
  // Below the explicit announcement above, but still above the gap: both deliberately fail toward
  // absorbing, which is the founder's stated preference over splitting.
  if (startsLowercase(trimmed)) {
    return { verdict: "related", reason: "starts lowercase — reads as a dictation continuation" };
  }

  const last = run.length > 0 ? run[run.length - 1] : undefined;
  if (typeof last === "string" && endsMidThought(last)) {
    return { verdict: "related", reason: "the run's last message was cut off mid-thought" };
  }

  // ── 3. A GAP LONG ENOUGH TO BE A NEW SITTING ────────────────────────────────────────────────
  // A non-finite gap (NaN from an absent timestamp, Infinity from a clock that stepped) is NOT
  // evidence of anything, and must never be read as a shift — `>` is already false for NaN, but the
  // guard is explicit so nobody later "fixes" it into an absolute-value comparison that isn't.
  if (Number.isFinite(gapMs) && gapMs > TOPIC_SHIFT_GAP_MS) {
    return { verdict: "different", reason: `${Math.round(gapMs)}ms gap exceeds ${TOPIC_SHIFT_GAP_MS}ms` };
  }

  // ── 4. DEFAULT — absorb ─────────────────────────────────────────────────────────────────────
  return { verdict: "related", reason: "no positive evidence of a topic shift" };
}

/**
 * `judgeRelatedness` as a boolean, with the failure direction pinned.
 *
 * ANY throw returns TRUE. Not defensive habit — the founder's stated requirement: splitting is the
 * defect, so a bug in this module must degrade into "absorb everything", never into the behaviour we
 * are here to remove. A crash costs one over-long turn; a `false` here would reproduce the bug and
 * blame it on a stack trace nobody sees.
 */
export function isRelated(run: readonly string[], next: string, gapMs: number): boolean {
  // `judgeRelatedness` is already guarded; the try here is belt to that brace, so this stays total
  // even if someone later removes the guard one level down.
  try {
    return judgeRelatedness(run, next, gapMs).verdict === "related";
  } catch {
    return true;
  }
}
