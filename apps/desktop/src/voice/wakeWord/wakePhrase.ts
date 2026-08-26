// Does this transcript contain the wake phrase, and what came after it? — one pure function over
// two strings.
//
// No clock, no network, no store, no model call, no dependency. That is a REQUIREMENT, not an
// implementation detail, for two separate reasons:
//
//   • It runs on EVERY interim the transcriber emits, several times a second, for as long as the
//     ambient overlay is listening. Latency in here would be latency on every word the user speaks.
//   • It is the whole of the "on-device" guarantee. This module never sees audio and never opens a
//     socket; it reads text the existing transcript path already produced and answers a question
//     about it. Anything that reached out would move the guarantee from "structurally true" to
//     "true as long as nobody edits this file".
//
// ══ THE PRIOR ART, AND WHAT WAS DELIBERATELY NOT CARRIED FORWARD ════════════════════════════════
// `voice/wakeWords.ts` did this job until commit aed3f7d2f retired the wake word from the MIC path
// ("We're no longer doing the wake word… SPEAK SHOULD BE ALWAYS ON"). Two of its lessons are kept
// here and one of its mechanisms is not:
//
//   KEPT — the ASYMMETRY OF COST (bead `sparkle-mun0`). A stray WAKE only opens a surface; a stray
//   STOP destroyed in-flight dictation. That bead's fix was to make the destructive matcher exact
//   and leave the harmless one generous. This module only ever does the harmless thing — it opens
//   the overlay — so it can afford a tolerant net. Nothing here is allowed to become a stop word.
//
//   KEPT — SHORT TOKENS GET NO SLACK. A one- or two-edit net around a 3–4 letter word admits
//   ordinary English ("top"/"shop"/"step" all sit within one edit of "stop"), which is precisely how
//   `sparkle-mun0` fired mid-sentence. {@link maxEditsForToken} therefore gives a 3-letter token
//   ZERO tolerance: the "hey" in "hey sparkle" must be heard exactly, and it is the carrier that
//   keeps a bare "sparkle" said mid-prompt from opening the overlay.
//
//   DROPPED — the double-metaphone phonetic net. It was a runtime dependency, and that dependency
//   was removed from the app when the matcher was ("the double-metaphone dependency is dropped with
//   the matcher"). Re-adding a package for a two-word phrase is not a trade worth making, and this
//   module's remit is wider than the old one's anyway: the phrase is CONFIGURABLE, so a curated
//   variant table keyed to the word "sparkle" could only ever serve the default. A
//   length-scaled edit-distance net is phrase-agnostic by construction.
//
// ── WHAT COUNTS AS "TOLERANT" HERE ──────────────────────────────────────────────────────────────
// Three real transcriber slips, each handled by a named mechanism rather than by a word list:
//
//   "hey, sparkle."   → punctuation is not a token (see {@link tokenizeWithOffsets})
//   "hey sparkel"     → one TRANSPOSITION, distance 1 under Damerau-OSA (plain Levenshtein calls it
//                       2, which is why the distance function transposes)
//   "hey spar kle"    → the transcriber split one word in two; a phrase token may consume TWO
//                       adjacent transcript tokens joined (see {@link matchPhraseAt})
//
// NOT handled, and stated so nobody assumes otherwise: the reverse split — one transcript token
// covering two phrase tokens ("heysparkle"). It is far rarer than the forward case and would need
// the phrase side to become variable-width too.

/** The wake phrase every surface means when it says "the wake phrase". Configurable everywhere. */
export const DEFAULT_WAKE_PHRASE = "hey sparkle";

/**
 * The lowest score {@link matchWakePhrase} will still report as a match.
 *
 * 0.7 against the default phrase means "at most 3 edits across `hey sparkle`'s 10 characters" — and
 * since {@link maxEditsForToken} already caps a 7-letter token at 2 and a 3-letter one at 0, the
 * threshold is a SECOND, GLOBAL brake rather than the primary one. It exists for longer configured
 * phrases, where per-token caps can accumulate: a four-word phrase could otherwise collect 8 edits
 * and still be reported as heard.
 */
export const DEFAULT_MIN_CONFIDENCE = 0.7;

/** One word of transcript, with its position in the ORIGINAL string kept. */
interface Token {
  /** Lowercased, de-accented, alphanumerics only — what the matcher compares. */
  norm: string;
  /** Offset of the word's first character in the original text. */
  start: number;
  /** Offset just past the word's last character in the original text. */
  end: number;
}

/** A word is a run of letters, digits and apostrophes. Everything else is a separator. */
const TOKEN_RE = /[\p{L}\p{N}']+/gu;

/** Combining marks, left over after NFD decomposition — this is the de-accenting step. */
const COMBINING_MARKS = /\p{M}+/gu;

/** Anything that is not a letter or a digit, INSIDE a token: the apostrophe in "what's". */
const INTRA_TOKEN_NOISE = /[^\p{L}\p{N}]+/gu;

/** Leading whitespace and punctuation, stripped off a residual so ", what's up" reads "what's up". */
const LEADING_NOISE = /^[\s\p{P}\p{S}]+/u;

/**
 * One word, reduced to what the matcher compares: NFD-decomposed so accents become separate marks,
 * marks removed, lowercased, and everything that is not a letter or a digit dropped.
 *
 * So `"Sparkle's"` → `"sparkles"` and `"café"` → `"cafe"`. Returns `""` for a token that was nothing
 * but punctuation (a lone apostrophe), which {@link tokenizeWithOffsets} then discards.
 */
function normalizeToken(raw: string): string {
  return raw.normalize("NFD").replace(COMBINING_MARKS, "").toLowerCase().replace(INTRA_TOKEN_NOISE, "");
}

/**
 * Split text into comparable words WITHOUT losing where they were.
 *
 * The offsets are the reason this exists rather than a plain `normalize().split(" ")`. The residual
 * has to come back in the user's own casing and punctuation — "what's on my calendar", not "whats on
 * my calendar" — so the match is computed over normalized tokens and then sliced out of the ORIGINAL
 * string using the offsets. Normalizing first and slicing the normalized text would hand the genie a
 * de-apostrophised, lowercased sentence, and every downstream surface that shows it would look
 * broken.
 */
function tokenizeWithOffsets(text: string): Token[] {
  const out: Token[] = [];
  for (const m of text.matchAll(TOKEN_RE)) {
    const raw = m[0];
    const norm = normalizeToken(raw);
    if (norm === "") continue;
    const start = m.index ?? 0;
    out.push({ norm, start, end: start + raw.length });
  }
  return out;
}

/**
 * The transcript reduced to space-separated comparable words: `"Hey, Sparkle!"` → `"hey sparkle"`.
 *
 * Exported because the detector needs it for a question the matcher does not answer — "is this
 * interim an EXTENSION of the one before it, or a new utterance?" — and a second copy of the
 * normalization rules over there would drift from this one on the first edit to either.
 */
export function normalizeTranscript(text: string): string {
  return tokenizeWithOffsets(text)
    .map((t) => t.norm)
    .join(" ");
}

/**
 * How many character edits a token of this length may absorb and still count as heard.
 *
 * ZERO below four characters is the `sparkle-mun0` rule restated: every net around a short word
 * admits ordinary English, and in a multi-word phrase the short word is usually the carrier ("hey",
 * "ok", "yo") whose whole job is to stop a bare noun from firing. One edit on "hey" would accept
 * "hay", "he", "they" and "her" — four words that appear in ordinary speech constantly.
 *
 * Two edits from seven characters up is what buys "sparkel" (a transposition, 1) and "sparkles"
 * (an insertion, 1) with room to spare, while still rejecting "sparkling" (3) and "spatula" (3).
 */
function maxEditsForToken(length: number): number {
  if (length <= 3) return 0;
  if (length <= 6) return 1;
  return 2;
}

/**
 * Damerau-Levenshtein distance, optimal-string-alignment variant, abandoned as soon as it exceeds
 * `max` (so a long mismatched word costs a row, not a matrix).
 *
 * TRANSPOSITION IS THE POINT. Plain Levenshtein scores "sparkle" → "sparkel" as 2, the same as two
 * unrelated substitutions, which forces the tolerance up to 2 to admit the single most common ASR
 * rendering of the word — and a tolerance of 2 lets far worse things through. Counting an adjacent
 * swap as ONE edit keeps the common slip cheap and the tolerance honest.
 */
function distance(a: string, b: string, max: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;

  let twoAgo: number[] = [];
  let prev: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);

  for (let i = 1; i <= a.length; i++) {
    const curr: number[] = new Array<number>(b.length + 1);
    curr[0] = i;
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(
        (prev[j] ?? max + 1) + 1, // deletion
        (curr[j - 1] ?? max + 1) + 1, // insertion
        (prev[j - 1] ?? max + 1) + cost, // substitution
      );
      // Transposition: the previous two characters, swapped.
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, (twoAgo[j - 2] ?? max + 1) + 1);
      }
      curr[j] = v;
      if (v < rowMin) rowMin = v;
    }
    // Every later row is >= this row's minimum, so the answer can never come back under `max`.
    if (rowMin > max) return max + 1;
    twoAgo = prev;
    prev = curr;
  }
  return prev[b.length] ?? max + 1;
}

/** Where one phrase token was found: how many edits it cost and how many transcript tokens it ate. */
interface TokenHit {
  edits: number;
  consumed: 1 | 2;
}

/** Best way to hear `phraseToken` starting at transcript token `i`, or null if it is not there. */
function hearTokenAt(tokens: Token[], i: number, phraseToken: string): TokenHit | null {
  const first = tokens[i];
  if (first === undefined) return null;
  const cap = maxEditsForToken(phraseToken.length);

  let best: TokenHit | null = null;

  const single = distance(first.norm, phraseToken, cap);
  if (single <= cap) best = { edits: single, consumed: 1 };

  // THE SPLIT-WORD CASE — "spar kle" for "sparkle". Only considered when it is STRICTLY better than
  // hearing the word on its own, so a clean "sparkle" followed by "what" is never tempted to eat the
  // first word of the residual.
  const second = tokens[i + 1];
  if (second !== undefined) {
    const joined = distance(first.norm + second.norm, phraseToken, cap);
    if (joined <= cap && (best === null || joined < best.edits)) {
      best = { edits: joined, consumed: 2 };
    }
  }

  return best;
}

/** The whole phrase, heard starting at transcript token `i` — edits spent and last token eaten. */
function matchPhraseAt(
  tokens: Token[],
  i: number,
  phraseTokens: string[],
): { edits: number; lastTokenIndex: number } | null {
  let cursor = i;
  let edits = 0;
  for (const phraseToken of phraseTokens) {
    const hit = hearTokenAt(tokens, cursor, phraseToken);
    if (hit === null) return null;
    edits += hit.edits;
    cursor += hit.consumed;
  }
  return { edits, lastTokenIndex: cursor - 1 };
}

/** A wake phrase found in a transcript. */
export interface WakePhraseMatch {
  /** Offset in the ORIGINAL text where the phrase's first character sits. */
  index: number;
  /** Offset in the ORIGINAL text just past the phrase's last character. */
  endIndex: number;
  /** The words that matched, exactly as the transcript rendered them ("Hey, Sparkel"). */
  heard: string;
  /** Everything after the phrase, original casing and punctuation, leading noise trimmed. */
  residual: string;
  /** `1 - edits / phraseLength`, floored at 0. Exactly 1 for a character-exact match. */
  confidence: number;
}

/** Knobs. Both have defaults; the detector threads its own configuration through. */
export interface MatchOptions {
  /** Reject a match scoring below this. Defaults to {@link DEFAULT_MIN_CONFIDENCE}. */
  minConfidence?: number;
}

/**
 * Find the wake phrase in `text`, tolerantly.
 *
 * Returns the FIRST occurrence, not the best or the last. The first is the one whose residual is the
 * rest of the sentence, which is the entire reason the residual is computed — a later occurrence
 * would hand the genie a fragment. The detector's cooldown, not this function, is what stops the
 * same spoken phrase being reported twice.
 *
 * `null` when the phrase is not there, when either argument holds no words, or when the best match
 * scores below `minConfidence`.
 */
export function matchWakePhrase(
  text: string,
  phrase: string = DEFAULT_WAKE_PHRASE,
  options: MatchOptions = {},
): WakePhraseMatch | null {
  const minConfidence = options.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const phraseTokens = normalizeTranscript(phrase).split(" ").filter((t) => t.length > 0);
  if (phraseTokens.length === 0) return null;

  const tokens = tokenizeWithOffsets(text);
  if (tokens.length === 0) return null;

  const phraseLength = phraseTokens.reduce((n, t) => n + t.length, 0);

  for (let i = 0; i < tokens.length; i++) {
    const hit = matchPhraseAt(tokens, i, phraseTokens);
    if (hit === null) continue;

    const confidence = Math.max(0, 1 - hit.edits / phraseLength);
    if (confidence < minConfidence) continue;

    const first = tokens[i];
    const last = tokens[hit.lastTokenIndex];
    // Both indices were produced by a walk that already read them; the guard is `noUncheckedIndexedAccess`.
    if (first === undefined || last === undefined) continue;

    return {
      index: first.start,
      endIndex: last.end,
      heard: text.slice(first.start, last.end),
      residual: text.slice(last.end).replace(LEADING_NOISE, "").trim(),
      confidence,
    };
  }

  return null;
}
