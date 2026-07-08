// Pure, dependency-light wake/stop matcher for the always-listening loop.
// No React, no Tauri — fully unit-testable. See the design spec
// (docs/superpowers/specs/2026-06-24-hey-sparkle-always-listening-design.md).
import { doubleMetaphone } from "double-metaphone";
import { DEFAULT_WAKE_WORD, DEFAULT_STOP_WORD } from "./voiceDefaults";

/** User-configurable wake/stop words. When a word equals its built-in default, the tuned
 *  "sparkle" engine runs (unchanged); otherwise the generic per-token fuzzy matcher is used.
 *  Wake and stop are evaluated independently, so customizing one leaves the other on its
 *  own path. */
export interface WakeConfig {
  wakeWord: string;
  stopWord: string;
}
export const DEFAULT_WAKE_CONFIG: WakeConfig = {
  wakeWord: DEFAULT_WAKE_WORD,
  stopWord: DEFAULT_STOP_WORD,
};

// Tier 1: nonsense / domain ASR artifacts — accepted ANYWHERE (no carrier needed).
const TIER1 = [
  "sparkle", "sparkles", "sparkly", "sparkled", "sparkling",
  "sparql", "sparkql", "spark ql", "sparkel", "sparkal", "sparkahl",
  "sparkul", "sparkuhl", "sparcle", "sparcal", "sparc", "sparc le",
  "spar kuhl", "spar kle", "spar kel", "spark le", "spark el",
  "spark hull", "spark ull",
];

// Tier 2: real / speech-plausible words — only wake WITH a leading "hey" carrier.
const TIER2 = [
  "sprinkle", "sprankle", "spackle", "speckle", "sparkler",
  "spark all", "spar call", "spar cool", "spar coal", "spar kill",
];

// Stop phrase: "sparkle stop" — REQUIRES the "sparkle" carrier token AND a
// following "stop"-like token (a 2-gram). Bare "stop" is a common dictation word,
// so it must never end capture on its own; bare "sparkle" is harmless mid-prompt.
// Curated ASR mishearings of the "stop" token (the 2-gram's second half). This set is the ONLY
// thing that counts as a stop token — there is deliberately no fuzzy (Levenshtein/phonetic) net on
// top of it, because "stop" is only 3-4 letters and every loose net admits ordinary near-words:
// lev(_, "stop") <= 1 pulls in "top"/"shop"/"step", and the "STP" Double-Metaphone code is shared by
// "step". Those turned "make the sparkle top bar bigger" into a destructive mid-dictation stop
// (sparkle-mun0). Entries are unambiguous non-words (no common English word), and "stomp" (a real,
// far-off word) was removed for the same reason. The true "stop" is matched exactly and stays reliable.
const STOP_VARIANTS = new Set(["stop", "stahp", "staap", "stope", "stawp", "stopp"]);

const CANON = "sparkle";
const CANON_MP = doubleMetaphone(CANON)[0]; // primary Double Metaphone code, computed at runtime

const despace = (s: string) => s.replace(/ /g, "");
const TIER1_SET = new Set(TIER1.map(despace));
const TIER2_SET = new Set(TIER2.map(despace));
// Single-word Tier-2 entries, with a trailing "s" stripped, for net-demotion checks.
const stripTrailingS = (w: string) => w.replace(/s$/, "");
const TIER2_SINGLE_BASES = new Set(
  TIER2.filter((e) => !e.includes(" ")).map((e) => stripTrailingS(e)),
);

/** lowercase, replace non-alphanumerics with spaces, collapse + trim whitespace. */
export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(segment: string): string[] {
  const n = normalize(segment);
  return n ? n.split(" ") : [];
}

/** 1- and 2-word windows with the index of the window's first token. */
function grams(tokens: string[]): { gram: string; i: number }[] {
  const out: { gram: string; i: number }[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok === undefined) continue;
    out.push({ gram: tok, i });
    const next = tokens[i + 1];
    if (next !== undefined) out.push({ gram: `${tok} ${next}`, i });
  }
  return out;
}

/** Levenshtein distance, capped early once it exceeds `max`. */
function lev(a: string, b: string, max = 2): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const curr: number[] = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const pj = prev[j] ?? max + 1;
      const cj1 = curr[j - 1] ?? max + 1;
      const pj1 = prev[j - 1] ?? max + 1;
      const v = Math.min(pj + 1, cj1 + 1, pj1 + cost);
      curr[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev = curr;
  }
  return prev[b.length] ?? max + 1;
}

/** A net-matched token demotes to Tier 2 iff (after trailing-s strip) it exactly
 *  matches a single-word Tier-2 base. Distance 0 — strictly tighter than the match
 *  radius — so canonical "sparkle" (distance 1 from "sparkler") is NOT demoted. */
function demotesToTier2(token: string): boolean {
  return TIER2_SINGLE_BASES.has(stripTrailingS(token));
}

function matchesWakeDefault(segment: string): boolean {
  const tokens = tokenize(segment);
  if (tokens.length === 0) return false;
  const precededByHey = (i: number) => i > 0 && tokens[i - 1] === "hey";

  // 1. Curated variant sets (1- and 2-grams, compared de-spaced).
  for (const { gram, i } of grams(tokens)) {
    const d = despace(gram);
    if (TIER1_SET.has(d)) return true;
    if (TIER2_SET.has(d) && precededByHey(i)) return true;
  }

  // 2 + 3. Phonetic / edit-distance nets on single tokens, tier-gated.
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok === undefined) continue;
    const netHit = doubleMetaphone(tok)[0] === CANON_MP || lev(tok, CANON) <= 2;
    if (!netHit) continue;
    if (demotesToTier2(tok)) {
      if (precededByHey(i)) return true; // Tier-2-like → needs the carrier
    } else {
      return true; // novel spelling of the bare wake word → accept anywhere
    }
  }
  return false;
}

/** True when a token is the "sparkle" carrier of a "sparkle stop" 2-gram. The phonetic (Double
 *  Metaphone) net still admits every real "sparkle" mishearing the wake path accepts — sparkly,
 *  sparkel, sparcle all share the "SPRKL" code — but the Levenshtein fallback is TIGHTER here than on
 *  the wake path (≤1, not ≤2). The wake carrier can be generous because a stray wake only *starts*
 *  listening; a stray STOP destroys in-flight capture, so the stop carrier must not fire on a merely
 *  2-edit-away word like "spark" (MP "SPRK", not "SPRKL"), which would let "…add a spark, stop…"
 *  end capture. Canonical "sparkle" is distance 0, so the real stop word stays reliable (sparkle-mun0). */
function isSparkleToken(tok: string): boolean {
  return doubleMetaphone(tok)[0] === CANON_MP || lev(tok, CANON, 1) <= 1;
}

/** True when a token is a "stop"-like word. EXACT membership of the curated STOP_VARIANTS set only —
 *  no Levenshtein/phonetic fuzz — because any fuzz on a 3-4 letter word admits ordinary near-words
 *  ("top", "shop", "step") that then destructively end capture mid-dictation (sparkle-mun0). The set
 *  already carries the plausible ASR mishearings, so exactness costs nothing in real reliability. */
function isStopToken(tok: string): boolean {
  return STOP_VARIANTS.has(tok);
}

function matchesStopDefault(segment: string): boolean {
  return stopStartIndex(tokenize(segment)) >= 0;
}

/** Index of the first token that begins a wake match (incl. a "hey" carrier), or -1. */
function wakeStartIndex(tokens: string[]): number {
  const precededByHey = (i: number) => i > 0 && tokens[i - 1] === "hey";
  for (const { gram, i } of grams(tokens)) {
    const d = despace(gram);
    if (TIER1_SET.has(d)) return precededByHey(i) ? i - 1 : i;
    if (TIER2_SET.has(d) && precededByHey(i)) return i - 1;
  }
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok === undefined) continue;
    const netHit = doubleMetaphone(tok)[0] === CANON_MP || lev(tok, CANON) <= 2;
    if (!netHit) continue;
    if (demotesToTier2(tok)) {
      if (precededByHey(i)) return i - 1;
    } else {
      return i;
    }
  }
  return -1;
}

/** Index of the "sparkle" token that begins a "sparkle stop" match (a 2-gram), or -1.
 *  Both tokens are required: bare "stop" (common dictation) and bare "sparkle" (a
 *  normal mid-prompt word) must NOT match. */
function stopStartIndex(tokens: string[]): number {
  for (let i = 0; i + 1 < tokens.length; i++) {
    const tok = tokens[i];
    const next = tokens[i + 1];
    if (tok === undefined || next === undefined) continue;
    if (isSparkleToken(tok) && isStopToken(next)) return i;
  }
  return -1;
}

/** Return the normalized text AFTER the wake phrase (the same-segment remainder). */
function stripWakePrefixDefault(segment: string): string {
  const tokens = tokenize(segment);
  const start = wakeStartIndex(tokens);
  if (start < 0) return normalize(segment);
  // Skip the carrier (if any) + the matched wake token(s). The wake match is at most
  // a 2-gram; advance past it. Find the matched gram length by re-checking.
  let skip = start;
  // Move past an optional "hey" carrier.
  if (tokens[skip] === "hey") skip += 1;
  // Past the wake gram: try 2-gram first (against both Tier-1 and Tier-2), else 1 token.
  const skipTok = tokens[skip];
  const skipNext = tokens[skip + 1];
  if (skipTok !== undefined && skipNext !== undefined) {
    const g2 = despace(`${skipTok} ${skipNext}`);
    if (TIER1_SET.has(g2) || TIER2_SET.has(g2)) {
      skip += 2;
    } else {
      skip += 1;
    }
  } else {
    skip += 1;
  }
  return tokens.slice(skip).join(" ").trim();
}

/** Return the normalized text BEFORE the stop phrase (the same-segment remainder). */
function stripStopSuffixDefault(segment: string): string {
  const tokens = tokenize(segment);
  const start = stopStartIndex(tokens);
  if (start < 0) return normalize(segment);
  return tokens.slice(0, start).join(" ").trim();
}

// ── Generic (custom-word) matcher ──────────────────────────────────────────────
// Used whenever a configured word differs from its built-in default. Matches the
// user's typed phrase as a CONTIGUOUS run of tokens, each fuzzily compared (see
// tokenFuzzyEq for the length-gated exact/phonetic/edit-distance rules). This is
// deliberately simpler/looser than the tuned "sparkle" engine; the Voice controls
// pane warns that accuracy varies by word (short words especially).

// Route on VALUE equality (normalized): a word equal to its built-in default runs the tuned
// engine, a different word runs the generic matcher. Typing the default phrase ("Hey Sparkle")
// into the config is therefore intentionally indistinguishable from leaving it unset — both get
// the tuned engine, which is strictly more accurate than the generic path, so this is the
// desired behavior, not a footgun.
const isDefaultWake = (cfg: WakeConfig) => normalize(cfg.wakeWord) === normalize(DEFAULT_WAKE_WORD);
const isDefaultStop = (cfg: WakeConfig) => normalize(cfg.stopWord) === normalize(DEFAULT_STOP_WORD);

/** True when transcript token `t` is a fuzzy match for phrase token `p`.
 *  Length-gated so short words don't over-match. Both fuzzy nets misbehave at short lengths:
 *  the Levenshtein net matches every 1-edit neighbor ("cat"→bat/car/rat), and Double-Metaphone
 *  codes collide densely ("cat"/"cot"/"cut"/"kit" all code "KT"). So a phrase token of ≤4 chars
 *  requires an EXACT match; only 5+ char words get the phonetic + edit-distance (≤2) nets. A ≤2
 *  char transcript token is also excluded from the fuzzy nets (metaphone is unreliable that short). */
function tokenFuzzyEq(t: string, p: string): boolean {
  if (t === p) return true;
  if (p.length <= 4 || t.length <= 2) return false;
  const mpP = doubleMetaphone(p)[0];
  const mpT = doubleMetaphone(t)[0];
  if (mpP && mpT && mpP === mpT) return true;
  return lev(t, p, 2) <= 2;
}

/** Index where `phrase` first matches `tokens` as a contiguous fuzzy run, else -1. */
function phraseMatchIndex(tokens: string[], phrase: string[]): number {
  if (phrase.length === 0 || tokens.length < phrase.length) return -1;
  for (let i = 0; i + phrase.length <= tokens.length; i++) {
    let ok = true;
    for (let j = 0; j < phrase.length; j++) {
      const t = tokens[i + j];
      const p = phrase[j];
      if (t === undefined || p === undefined || !tokenFuzzyEq(t, p)) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }
  return -1;
}

// ── Public API: branch on default-vs-custom, per word ───────────────────────────

/** True when the segment contains the configured wake word. */
export function matchesWake(segment: string, config: WakeConfig = DEFAULT_WAKE_CONFIG): boolean {
  if (isDefaultWake(config)) return matchesWakeDefault(segment);
  return phraseMatchIndex(tokenize(segment), tokenize(config.wakeWord)) >= 0;
}

/** True when the segment contains the configured stop word. */
export function matchesStop(segment: string, config: WakeConfig = DEFAULT_WAKE_CONFIG): boolean {
  if (isDefaultStop(config)) return matchesStopDefault(segment);
  return phraseMatchIndex(tokenize(segment), tokenize(config.stopWord)) >= 0;
}

/** Return the normalized text AFTER the configured wake phrase (same-segment remainder). */
export function stripWakePrefix(segment: string, config: WakeConfig = DEFAULT_WAKE_CONFIG): string {
  if (isDefaultWake(config)) return stripWakePrefixDefault(segment);
  const tokens = tokenize(segment);
  const phrase = tokenize(config.wakeWord);
  const idx = phraseMatchIndex(tokens, phrase);
  if (idx < 0) return normalize(segment);
  return tokens.slice(idx + phrase.length).join(" ").trim();
}

/** Return the normalized text BEFORE the configured stop phrase (same-segment remainder). */
export function stripStopSuffix(segment: string, config: WakeConfig = DEFAULT_WAKE_CONFIG): string {
  if (isDefaultStop(config)) return stripStopSuffixDefault(segment);
  const tokens = tokenize(segment);
  const idx = phraseMatchIndex(tokens, tokenize(config.stopWord));
  if (idx < 0) return normalize(segment);
  return tokens.slice(0, idx).join(" ").trim();
}
