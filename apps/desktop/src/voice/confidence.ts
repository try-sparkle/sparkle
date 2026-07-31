// How finished does this sentence SOUND? — the auto-send rail's confidence heuristic (PRD §4).
//
// One pure function over one string. No network, no clock, no store, no model call. That is a
// requirement, not an implementation detail: this runs on EVERY transcript chunk while the user is
// still speaking, and it decides how long the rail waits before pressing Send. A call with latency
// in it would either stall the rail behind a round trip or make the countdown jitter with the
// network. Zero latency, zero cost, and identical for the same input forever — see
// `services/autoSendTuner` for where Haiku's opinion goes instead (out of band, recorded, never in
// the loop).
//
// Modelled on ./wakeMachine: a pure verdict function with its own unit-test file, importable by the
// timer, the rail UI and a test alike without any of them dragging in the others.
//
// THE TIERS ARE THRESHOLDS, NOT DELAYS. The rail does not "wait 3 seconds"; it accumulates elapsed
// silence and compares it to whatever threshold the LATEST chunk implies. So a sentence that starts
// confident and then trails off does not restart its clock — its deadline simply moves away. See
// ./autoSendTimer, which is where that rule lives.

/**
 * How finished the utterance sounds, worst-to-best: `verylow` → `low` → `normal` → `high`.
 *
 * A four-way enum rather than a number so the tier is a NAME the rail, the instrumentation and the
 * Haiku comparison can all agree on. A score would invite everyone to pick their own cutoffs.
 */
export type Confidence = "high" | "normal" | "low" | "verylow";

/**
 * The silence each tier buys before the send fires, in milliseconds.
 *
 * NO CAP ON THE TOTAL WAIT (PRD §4, decided). A sentence that keeps reading as `verylow` waits ten
 * seconds, then ten more from the next chunk, indefinitely — because "I can't tell if you're done"
 * has no honest expiry. A cap would convert exactly the least-confident case into an automatic
 * send, which is backwards.
 */
/**
 * The 20% the founder asked for, applied to the THRESHOLDS rather than to the animation.
 *
 * He described the visible drain as too fast. The honest place to fix that is here, not in the
 * sweep's CSS: the sweep is a PICTURE OF THE DEADLINE (SendModeTray draws `remaining` straight off
 * this clock), so slowing the picture while leaving the deadline where it is would make the control
 * lie — the fill would still be travelling when the message had already gone. Moving the deadline
 * keeps the two the same fact.
 *
 * Kept as a named multiplier over the original values rather than four rewritten literals, so the
 * tuning stays legible as a tuning and the ladder's shape (1 : 3 : 5 : 10) survives it.
 */
export const CONFIDENCE_PACE = 1.2;

export const CONFIDENCE_THRESHOLD_MS: Record<Confidence, number> = {
  high: 1_000 * CONFIDENCE_PACE, // 1200
  normal: 3_000 * CONFIDENCE_PACE, // 3600
  low: 5_000 * CONFIDENCE_PACE, // 6000
  verylow: 10_000 * CONFIDENCE_PACE, // 12000
};

/** The threshold this tier is measured against. */
export function thresholdMs(tier: Confidence): number {
  return CONFIDENCE_THRESHOLD_MS[tier];
}

/**
 * Words that cannot end a thought. A trailing one means the speaker is mid-clause and the next
 * words are already on the way — the strongest "do not send" signal available without a model.
 *
 * Coordinating and subordinating conjunctions, plus the prepositions and determiners that dangle
 * the same way ("send it to", "look at the"). `so` and `then` are here despite being usable as
 * sentence-final discourse markers ("…so."): at the end of a transcript with no terminal
 * punctuation they are overwhelmingly the start of a clause that hasn't landed, and the cost of
 * being wrong is asymmetric — waiting an extra few seconds is an inconvenience, sending half a
 * sentence into an agent's terminal is not.
 */
const TRAILING_CONJUNCTIONS = new Set([
  // coordinating
  "and", "but", "or", "nor", "for", "yet", "so", "plus",
  // subordinating / relative
  "because", "since", "although", "though", "while", "whereas", "unless", "until", "if",
  "when", "whenever", "where", "wherever", "after", "before", "as", "that", "which", "who",
  "whom", "whose", "than", "whether",
  // prepositions & particles that dangle
  "to", "of", "in", "on", "at", "by", "with", "from", "into", "onto", "about", "over",
  "under", "through", "between", "against", "toward", "towards", "upon", "within", "without",
  // determiners / quantifiers
  "the", "a", "an", "my", "your", "our", "their", "its", "his", "her", "this", "these",
  "those", "some", "any", "every", "each", "both", "either", "neither",
  // auxiliaries left hanging ("I was going to", "it should")
  "is", "are", "was", "were", "be", "been", "being", "am", "will", "would", "can", "could",
  "shall", "should", "may", "might", "must", "do", "does", "did", "have", "has", "had",
  // discourse markers that introduce the next clause
  "then", "also", "however", "therefore", "meanwhile", "besides",
]);

/**
 * Hesitation noise. A trailing one means the speaker is thinking, not finished.
 *
 * Weaker than a dangling conjunction: "add a login button, um" is a complete instruction followed
 * by a noise, so it earns `low` (a longer look) rather than `verylow` (a near-stop). Deepgram's
 * `smart_format` strips some of these, which is why the list is short and the tier is forgiving —
 * this is a hint, not a contract.
 */
const TRAILING_FILLERS = new Set([
  "um", "uh", "erm", "er", "ah", "hmm", "hm", "mmm", "mm", "like", "well", "okay", "ok",
  "right", "anyway", "actually", "basically", "literally", "just",
]);

/**
 * Words that open a question. Used to decide whether an UNPUNCTUATED utterance was TRYING to be
 * one — a question left without its mark is a sentence the speaker has not finished delivering.
 */
const QUESTION_OPENERS = new Set([
  "what", "why", "how", "when", "where", "who", "whom", "whose", "which",
  "is", "are", "was", "were", "do", "does", "did", "can", "could", "will", "would",
  "should", "shall", "may", "might", "have", "has", "had", "am",
]);

/** Sentence-ending punctuation. `…` is deliberately absent — an ellipsis is a trail-off, not a stop. */
const TERMINAL_PUNCTUATION = /[.!?！？。]$/;

/**
 * Past this many words, an utterance with no terminal punctuation at all stops reading as a terse
 * complete instruction ("ship it") and starts reading as someone still mid-thought.
 *
 * Six, because that is roughly where a spoken imperative stops fitting in one breath: "run the
 * tests and push it" is five words and complete; anything much longer without a single mark of
 * punctuation from `smart_format` is a sentence the model itself could not find the end of.
 */
export const LONG_UTTERANCE_WORDS = 6;

/** Strip punctuation from the edges of one token so `"button,"` and `"and,"` compare as words. */
function bareWord(token: string): string {
  return token.replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, "").toLowerCase();
}

/** The utterance's words, punctuation-stripped and lowercased. Empty for empty input. */
function words(transcript: string): string[] {
  return transcript
    .trim()
    .split(/\s+/)
    .map(bareWord)
    .filter((w) => w.length > 0);
}

/**
 * How finished does this transcript sound?
 *
 * Ordered worst-first: the strongest "keep waiting" signal wins, because the tiers are not
 * independent judgements to be averaged — they are a single question ("how sure am I that this is
 * over?") and one dangling conjunction settles it however clean the rest of the sentence was.
 *
 * Empty or whitespace-only input is `verylow`. There is nothing there to be confident about, and
 * the rail must never treat "I have heard nothing yet" as "they have finished".
 */
export function confidence(transcript: string): Confidence {
  const w = words(transcript);
  if (w.length === 0) return "verylow";

  // `?? ""` only to satisfy `noUncheckedIndexedAccess` — the length guard above already proves
  // both indices exist, and "" is in none of the word sets, so the fallback is unreachable.
  const first = w[0] ?? "";
  const last = w[w.length - 1] ?? "";
  const trimmed = transcript.trim();
  const hasTerminal = TERMINAL_PUNCTUATION.test(trimmed);
  const endsWithQuestionMark = /[?？]$/.test(trimmed);

  // ── verylow — the speaker is demonstrably mid-clause ────────────────────────────────────────
  // A dangling conjunction/preposition/auxiliary beats everything, INCLUDING a terminal mark:
  // "let's deploy it, and." is punctuation landing on an unfinished clause, which is a transcription
  // artefact rather than a finished thought.
  if (TRAILING_CONJUNCTIONS.has(last)) return "verylow";

  // An UNCLOSED QUESTION — it opened like a question and never got its mark. Only when nothing else
  // terminated it either: "how do I ship this. ok" has landed somewhere, however oddly.
  if (!hasTerminal && QUESTION_OPENERS.has(first)) return "verylow";

  // ── low — finished-ish, but the tail says "still thinking" ──────────────────────────────────
  // Trailing filler. Weaker than a dangling conjunction because what precedes it is often complete
  // ("add a login button, um"), so this buys a longer look rather than a near-stop.
  if (TRAILING_FILLERS.has(last)) return "low";

  // A long utterance that `smart_format` could not punctuate anywhere. Short ones are exempt: "ship
  // it" is a whole instruction and gets no mark from any punctuator.
  if (!hasTerminal && w.length > LONG_UTTERANCE_WORDS) return "low";

  // ── high — a clean, closed sentence ─────────────────────────────────────────────────────────
  // A fully-formed question (opener + "?") is explicitly high per PRD §4: it is the one shape where
  // the speaker's intonation and the punctuator agree that the turn is over.
  if (endsWithQuestionMark && QUESTION_OPENERS.has(first)) return "high";
  if (hasTerminal) return "high";

  // ── normal — the default ────────────────────────────────────────────────────────────────────
  // Short, unpunctuated, no bad tail: "ship it", "run the tests". Nothing says finished and nothing
  // says unfinished, which is exactly what the middle tier is for.
  return "normal";
}
