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
// A pure verdict function with its own unit-test file, importable by the timer, the rail UI and a
// test alike without any of them dragging in the others — this codebase's convention for a decision
// several surfaces must not disagree about (cf. ./sendMode, ./micPresentation).
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
 * NO CAP ON THE TOTAL WAIT (PRD §4, decided). A sentence that keeps reading as `verylow` waits its
 * thirty seconds, then thirty more from the next chunk, indefinitely — because "I can't tell if
 * you're done" has no honest expiry. A cap would convert exactly the least-confident case into an
 * automatic send, which is backwards.
 *
 * ══ RETUNED 2026-08-20 — THE FOUNDER WAS BEING CUT OFF MID-SENTENCE (bead `sparkle-r3wl6f`) ═════
 * Eight consecutive dictated messages reached the concierge as fragments: `The`, `we can see that
 * there is`, `Let's just take this one here. And so`. Every break landed on a natural speech pause,
 * because he DICTATES WHILE READING THE UI — a pause to look at the screen is the normal case here,
 * not the exception, and the old ladder finalised the utterance inside it.
 *
 * The tier VERDICTS were already right: `fix the header and` scored `verylow` then and scores
 * `verylow` now. What was wrong was the price of that verdict. `verylow` bought 12 seconds, and a
 * stare at the screen outlasts 12 seconds routinely. So this is a retune of the RUNGS, not of the
 * judgement — see {@link confidence} for the one judgement that did change (a trailing comma).
 *
 * The two numbers the founder chose himself, offered against worked examples of each:
 *
 *   • `high` 1200 → 2000. THE ROW THAT ACTUALLY CUT HIM OFF MOST. Deepgram's `smart_format` will
 *     put a full stop on an unfinished thought — `So these are the sent out to the build agents.`
 *     is garbled mid-sentence and carries a period, so it scored `high` and went in 1.2s. A glance
 *     at the screen is longer than that. He picked 2s over 3s and 5s: the lighter touch.
 *   • `verylow` 12000 → 30000. He picked this over "never auto-send, hold until you press send",
 *     knowing what it means: at 30s he still gets cut off, just far less often. If tonight's
 *     pattern repeats at 30s the answer is the hold, and this comment is the record of that
 *     decision being deliberate rather than a compromise nobody noticed.
 *
 * `low` is the agent's, and it is the only number here nobody chose: it has to sit between the two
 * he set, and 7s keeps it nearer `normal` than `verylow` in the spirit of the lighter touch he
 * picked. Move it freely — unlike the two above, no decision is recorded in it.
 *
 * ── WHY THIS IS NO LONGER A MULTIPLIER OVER A 1 : 3 : 5 : 10 SHAPE ─────────────────────────────
 * It used to be `CONFIDENCE_PACE` (1.2) times the PRD's ratio, which kept an earlier "20% slower"
 * tuning legible as a tuning. That form cannot express this change: the whole point is that the
 * top and bottom rungs move by different factors (1.7x and 2.5x), because a clean sentence and a
 * dangling `and` are not the same kind of wrong to get wrong. Preserving the ratio would mean
 * dragging `high` to 6s to reach a 30s `verylow` — a wait he explicitly declined. Four literals
 * with their reasons attached beats a shape that no longer describes the decision.
 */
export const CONFIDENCE_THRESHOLD_MS: Record<Confidence, number> = {
  high: 2_000,
  normal: 4_000,
  low: 7_000,
  verylow: 30_000,
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
 * Punctuation that ends a CLAUSE but not a THOUGHT — the written form of "I have not finished".
 *
 * ══ THE FOUNDER NAMED THIS ONE AND NOTHING IMPLEMENTED IT (bead `sparkle-r3wl6f`) ══════════════
 * *"refuse to finalise on a trailing conjunction, article or comma."* The first two were already
 * handled by {@link TRAILING_CONJUNCTIONS}. The comma was not, and it was not merely missing — it
 * was UNREACHABLE, which is why nobody noticed. {@link bareWord} strips punctuation from a token's
 * edges so `"button,"` compares equal to `"button"`, so by the time the tail was inspected the
 * comma had already been thrown away. There was no line to fix; the character never survived to be
 * tested. Measured cost: `there are the actual tasks here. Each one of these tasks,` — a sentence
 * that stops ON A COMMA, as unambiguous a "more is coming" as speech offers — scored `low` and was
 * sent 6 seconds later, mid-thought.
 *
 * So this is tested against the RAW TRIMMED TEXT, before tokenisation, and that ordering is the
 * whole fix rather than an implementation detail.
 *
 * The semicolon, colon and dash join it because they dangle identically ("here's the problem:",
 * "two things —"), and `smart_format` emits all of them. The ELLIPSIS is here for a reason stated
 * one line above: it is deliberately absent from `TERMINAL_PUNCTUATION` because it is a trail-off,
 * and a trail-off is exactly this category. `...` is matched as well as `…` — the three-dot form
 * ends in a `.` and would otherwise read as a full stop and score `high`, which is backwards.
 */
const MID_CLAUSE_PUNCTUATION = /(\.\.\.|[,;:…–—-])$/;

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
 * The coordinating conjunctions (FANBOYS + "so"), as WHOLE WORDS. A subset of
 * {@link TRAILING_CONJUNCTIONS} — the ones that also open a fresh independent clause — reused by the
 * interior-splice check below. Kept separate on purpose: a dangling `to`/`the`/`because` is a
 * mid-clause TAIL and belongs only to `TRAILING_CONJUNCTIONS`; a capitalised `But`/`So`/`And`
 * appearing INSIDE the text is the seam between two spliced utterances, which is a different signal.
 */
const COORDINATING_CONJUNCTIONS = new Set(["and", "but", "or", "nor", "for", "yet", "so"]);

/**
 * Does this text SPLICE two separately-finalised utterances into one?
 *
 * ══ THE FOUNDER NAMED THIS ONE TOO (bead `sparkle-r3wl6f`, splice comment) ══════════════════════
 * *"As a part of that work, feel free to also compress it so it has less information, not more But
 * looking for something within 10/01/2026 move in dates…"* — TWO UNRELATED dictation sessions run
 * into one message: Sparkle work, then a rental-property enquiry, with no sentence boundary between
 * them. This is worse than a truncation because the tail (`…is not available then.`) LOOKS COMPLETE,
 * so every finished-ness check upstream reads it as `high` and both the countdown and the research
 * dispatcher act on garbage.
 *
 * The seam is the one mark speech-to-text cannot hide: a capitalised coordinating conjunction with
 * NO terminal punctuation before it. `smart_format` capitalises a word only when it has decided a
 * new sentence began — and when it decides that, it also PUNCTUATES the end of the previous one. So
 * a capital `But`/`So`/`And` that is NOT preceded by a `.`/`!`/`?` did not come from one continuous
 * transcription: it is the boundary where a second finalised utterance was concatenated onto the
 * first. `"…not more. But looking…"` (a real full stop) is a legitimate sentence start and is left
 * alone; `"…not more But looking…"` (no stop) is the splice.
 *
 * The FIRST word is exempt — a message that merely opens with "But…" is informal, not a splice —
 * so the scan starts at index 1. NOT a claim about the speaker, only about the text: every caller is
 * asking whether this is ONE whole finished thought, and a splice is two.
 *
 * The seam must be SENTENCE CASE, not merely a leading capital: `smart_format` capitalises exactly
 * the first letter of a sentence, so `But`/`So`/`And` are seams but `AND`/`OR`/`SO` are not — an
 * all-caps coordinating word is emphasis or a boolean/query operator ("the PRs that are green AND
 * unmerged", "open OR ready"), which is one continuous utterance and must stay dispatchable.
 */
export function hasInteriorSplice(text: string): boolean {
  const tokens = text.trim().split(/\s+/).filter((t) => t.length > 0);
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i] ?? "";
    // A SENTENCE-CASED coordinating conjunction — the start of a fresh independent clause. Sentence
    // case (first letter upper, the rest lower) and not ALL-CAPS is the discriminator: it is what
    // `smart_format` emits at a real sentence boundary, and what an emphasis/operator does not.
    if (!isSentenceCase(token)) continue;
    if (!COORDINATING_CONJUNCTIONS.has(bareWord(token))) continue;
    // …with no real sentence boundary before it. A terminal mark on the previous token means this
    // capital is a legitimate new sentence, not a splice seam.
    const prev = tokens[i - 1] ?? "";
    if (TERMINAL_PUNCTUATION.test(prev)) continue;
    return true;
  }
  return false;
}

/**
 * Is this token SENTENCE CASE — first letter uppercase, every other letter lowercase? Surrounding
 * punctuation is ignored; only the letter run is judged. `"But"` and `"So"` are; `"AND"`, `"OR"`,
 * `"iOS"` and `"button"` are not. Used by {@link hasInteriorSplice} to tell a sentence seam apart
 * from an all-caps emphasis/operator word.
 */
function isSentenceCase(token: string): boolean {
  const letters = token.replace(/[^\p{L}]/gu, "");
  if (letters.length === 0) return false;
  return /^\p{Lu}\p{Ll}*$/u.test(letters);
}

/**
 * Does this text stop MID-CLAUSE — a dangling function word, a comma, OR splice two utterances?
 *
 * The strongest "do not send" signal available without a model, and the exact check
 * {@link confidence} makes below for its `verylow` tier. Exported so the rule lives in ONE place,
 * the same reason {@link endsMidThought} is exported: `engine/conciergeAutoDispatch` asks this
 * question of a message already sitting in the concierge's queue, deciding whether to spend a
 * metered research child on it. A second copy of the word list at that layer would drift from this
 * one on the first edit to either.
 *
 * ── DELIBERATELY NARROWER THAN `verylow`, AND THE GAP IS LOAD-BEARING ─────────────────────────
 * `confidence` returns `verylow` for this AND for an unclosed question — an utterance that opened
 * like a question and never got its mark. That second rule is right for the countdown (waiting
 * longer costs nothing) and WRONG for the dispatcher, because `why is the DMG build red` is a
 * genuine research question that simply lost its question mark. Folding the two would make the
 * dispatch guard refuse exactly the messages research exists to serve. So callers who want "is
 * this cut off" get this; callers who want "how finished does this sound" get `confidence`.
 *
 * NOT a claim about the SPEAKER, only about the TEXT — same posture as `endsMidThought`. A tail
 * like `and` reads as unfinished whether a transcriber cut it, a countdown fired early, or the
 * writer changed their mind. Every caller is asking whether MORE was coming.
 *
 * It also folds in {@link hasInteriorSplice} — two utterances concatenated into one. That is not a
 * dangling TAIL, but it is the same underlying question every caller here asks ("is this one whole
 * finished thought?"), and routing it through THIS predicate is deliberate: the dispatch guard in
 * `engine/conciergeAutoDispatch` calls `endsMidClause` to refuse research on a fragment, and a
 * splice must be refused too — a research child dispatched on two spliced enquiries reads NOTES.md
 * and the backlog hunting for an antecedent to a question the other half of the message answered.
 * One predicate, so `confidence`'s `verylow` and the dispatch guard's `fragment` stay in lockstep.
 */
export function endsMidClause(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === "") return false;
  // RAW TEXT FIRST — see MID_CLAUSE_PUNCTUATION on why tokenising before this check is what made
  // the trailing comma unreachable for as long as it was.
  if (MID_CLAUSE_PUNCTUATION.test(trimmed)) return true;
  // An interior splice seam is also read from the raw text — the capitalisation and the ABSENCE of
  // punctuation before it are exactly what `bareWord` would throw away.
  if (hasInteriorSplice(trimmed)) return true;
  const w = words(trimmed);
  const last = w[w.length - 1] ?? "";
  return TRAILING_CONJUNCTIONS.has(last);
}

/**
 * Does this text stop before its thought lands?
 *
 * The exact check `confidence()` makes below for its `low` tier — no terminal punctuation anywhere,
 * and long enough that the absence stops reading as a terse complete instruction ("ship it") and
 * starts reading as someone cut off mid-sentence. Exported so the rule lives in ONE place: the
 * concierge's run-absorption judge (`engine/conciergeRelatedness`) asks the same question of a
 * message the founder already sent, and a second copy of the regex at that layer would drift from
 * this one on the first edit to either.
 *
 * `confidence()` calls it too rather than re-deriving the condition inline — same inputs, same
 * answer, so the tier table is unchanged; it just costs one extra pass over the words.
 *
 * NOT a claim about the SPEAKER's intent, only about the TEXT: a long unpunctuated sentence reads
 * as unfinished whether it was truncated by a transcriber, a keystroke, or a change of mind. Every
 * caller wants it that way — all of them are deciding whether MORE is coming.
 */
export function endsMidThought(text: string): boolean {
  return !TERMINAL_PUNCTUATION.test(text.trim()) && words(text).length > LONG_UTTERANCE_WORDS;
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

  // ── verylow — the speaker is demonstrably mid-clause, or two utterances are spliced ──────────
  // A dangling conjunction/preposition/auxiliary — or a trailing comma — beats everything,
  // INCLUDING a terminal mark:
  // "let's deploy it, and." is punctuation landing on an unfinished clause, which is a transcription
  // artefact rather than a finished thought.
  // Delegated to `endsMidClause` above — same condition, one definition, so the dispatch guard's
  // copy of this question cannot drift. It also folds in the TRAILING COMMA, which the tokenised
  // `last` could never see (`bareWord` had already stripped it), AND an INTERIOR SPLICE — two
  // separately-finalised utterances concatenated — whose tail looks complete but which is not one
  // whole thought (see `hasInteriorSplice`). This beats the `hasTerminal → high` rule below, which
  // is the whole point: a splice ends on a clean full stop and would otherwise score `high`.
  if (endsMidClause(trimmed)) return "verylow";

  // An UNCLOSED QUESTION — it opened like a question and never got its mark. Only when nothing else
  // terminated it either: "how do I ship this. ok" has landed somewhere, however oddly.
  if (!hasTerminal && QUESTION_OPENERS.has(first)) return "verylow";

  // ── low — finished-ish, but the tail says "still thinking" ──────────────────────────────────
  // Trailing filler. Weaker than a dangling conjunction because what precedes it is often complete
  // ("add a login button, um"), so this buys a longer look rather than a near-stop.
  if (TRAILING_FILLERS.has(last)) return "low";

  // A long utterance that `smart_format` could not punctuate anywhere. Short ones are exempt: "ship
  // it" is a whole instruction and gets no mark from any punctuator. Delegated to `endsMidThought`
  // above — same condition, one definition, so the concierge's copy of this question cannot drift.
  if (endsMidThought(transcript)) return "low";

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
