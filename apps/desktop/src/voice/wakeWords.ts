// Pure, dependency-light wake/stop matcher for the always-listening loop.
// No React, no Tauri — fully unit-testable. See the design spec
// (docs/superpowers/specs/2026-06-24-hey-sparkle-always-listening-design.md).
import { doubleMetaphone } from "double-metaphone";

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

// Stop variants (mishearings of "send it"). Bare "send" is deliberately absent.
const STOP = [
  "send it", "sendit", "sent it", "sentit", "send id", "sent id",
  "send et", "send at", "fend it", "fendit", "fend at", "scent it",
  "sand it", "spend it",
];

const CANON = "sparkle";
const CANON_MP = doubleMetaphone(CANON)[0]; // primary Double Metaphone code, computed at runtime

const despace = (s: string) => s.replace(/ /g, "");
const TIER1_SET = new Set(TIER1.map(despace));
const TIER2_SET = new Set(TIER2.map(despace));
const STOP_SET = new Set(STOP.map(despace));
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

export function matchesWake(segment: string): boolean {
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

export function matchesStop(segment: string): boolean {
  const tokens = tokenize(segment);
  for (const { gram } of grams(tokens)) {
    const d = despace(gram);
    if (STOP_SET.has(d)) return true;
    // Scope the lev-net to s/f-initial grams so plausible dictation phrases like
    // "bend it", "lend it", "end it" don't false-stop capture.
    if ((d.startsWith("s") || d.startsWith("f")) && lev(d, "sendit", 1) <= 1) return true;
  }
  return false;
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

/** Earliest token index of a stop match, or -1. */
function stopStartIndex(tokens: string[]): number {
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok === undefined) continue;
    // Check the 2-gram first (the canonical "send it"), then the single token.
    const next = tokens[i + 1];
    if (next !== undefined) {
      const d = despace(`${tok} ${next}`);
      if (STOP_SET.has(d) || ((d.startsWith("s") || d.startsWith("f")) && lev(d, "sendit", 1) <= 1)) return i;
    }
    const d1 = despace(tok);
    if (STOP_SET.has(d1) || ((d1.startsWith("s") || d1.startsWith("f")) && lev(d1, "sendit", 1) <= 1)) return i;
  }
  return -1;
}

/** Return the normalized text AFTER the wake phrase (the same-segment remainder). */
export function stripWakePrefix(segment: string): string {
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
export function stripStopSuffix(segment: string): string {
  const tokens = tokenize(segment);
  const start = stopStartIndex(tokens);
  if (start < 0) return normalize(segment);
  return tokens.slice(0, start).join(" ").trim();
}
