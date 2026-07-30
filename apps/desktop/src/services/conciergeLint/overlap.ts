// The shared verbatim-overlap engine: how much of this reply is a COPY of something else?
//
// Two checks ask that question of different corpora, which is the whole reason this is a module and
// not a helper inside one of them:
//
//   • `restated-state` (R5, "stop re-reporting unchanged state") asks it against the PREVIOUS
//     concierge reply.
//   • `relay-paste` (R16, "never paste the full text you sent into your reply") asks it against
//     THIS turn's tool-call arguments.
//
// Same engine, different candidates. Duplicating it would let the two drift — one tightened, one
// not — and a threshold that means different things in two config keys is a threshold nobody can
// tune.
//
// ══ WHY WHITESPACE IS COLLAPSED FIRST ═══════════════════════════════════════════════════════════
// The evasion this defends against is not adversarial, it is incidental: a model that re-emits a
// paragraph re-wraps it. Line breaks land in different places, a list gains indentation, a double
// space becomes single. Comparing raw text would report a 40-character overlap for two strings a
// human would call identical. Collapsing every whitespace RUN to a single space makes the measure
// mean what the rule means — "the same words, again" — and costs nothing else, because no check
// here cares about layout.
//
// ══ COMPLEXITY, AND THE CAP ═════════════════════════════════════════════════════════════════════
// The naive answer is the longest-common-substring DP: O(n·m) cells. For a 10KB reply against a few
// KB of tool arguments that is tens of millions of cells on the render path of every single turn —
// "accidentally quadratic with a huge constant" is exactly the failure the plan calls out.
//
// Instead: BINARY SEARCH on the answer's length, with a rolling hash deciding each probe.
// "Is there a common substring of length L" is MONOTONE — if one exists at L it exists at L-1 (any
// prefix of it) — so binary search over L is valid, and each probe is O(n + m) with a Rabin-Karp
// hash set. Total O((n + m) · log n): for a 10KB reply that is ~15 linear passes, microseconds.
//
// Hash collisions are handled by VERIFYING every hit with a real substring comparison, so the
// result is exact, not probabilistic. Expected wasted verifications at these sizes are well under
// one per probe (birthday bound against a 2^31 modulus), so the exactness is free.
//
// Inputs are capped at {@link OVERLAP_MAX_INPUT_CHARS}; see that constant for why truncating is the
// right failure direction.

/**
 * How much of each side is examined, in characters, AFTER whitespace collapsing.
 *
 * A concierge reply is bounded in practice (the thread store caps at 4000 characters) and tool
 * arguments are not, so the cap is really about a pathological argument — a file dump, a diff, a
 * pasted log. Truncating biases toward a SMALLER measured overlap, i.e. toward a false negative,
 * which is the direction this whole design prefers: a missed warn costs a rule going unenforced
 * once, a false block costs the user a wasted revision turn on a reply that was already correct.
 *
 * 20000 is ~5× the largest reply the thread store will hold, so a real reply is never truncated.
 */
export const OVERLAP_MAX_INPUT_CHARS = 20_000;

/** Every run of whitespace becomes a single space, and the ends are trimmed. The normalization both
 *  sides of a comparison must agree on — exported so a caller can normalize a threshold's units the
 *  same way rather than guessing. */
export function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** The longest contiguous run the reply shares with some candidate. `length` is in characters of
 *  the COLLAPSED text, and `text` is that run (collapsed) — callers hash it for the log rather than
 *  storing it, per the metadata-only rule. */
export interface OverlapMatch {
  length: number;
  text: string;
}

const NO_OVERLAP: OverlapMatch = { length: 0, text: "" };

// Rabin-Karp parameters. `MOD` is the Mersenne prime 2^31 - 1 and `BASE` is a small prime, so
// `hash * BASE + char` stays under 2^53 and every intermediate is exact in a JS number.
const MOD = 2_147_483_647;
const BASE = 131;

/**
 * The longest contiguous verbatim overlap between `reply` and any of `candidates`.
 *
 * Both sides are whitespace-collapsed first, then truncated to {@link OVERLAP_MAX_INPUT_CHARS}.
 * Returns `{ length: 0, text: "" }` when there is no overlap, when `candidates` is empty, or when
 * either side is empty — never throws, for any input.
 */
export function longestOverlap(reply: string, candidates: readonly string[]): OverlapMatch {
  const a = collapseWhitespace(reply).slice(0, OVERLAP_MAX_INPUT_CHARS);
  if (a.length === 0) return NO_OVERLAP;

  const bs: string[] = [];
  for (const c of candidates) {
    if (typeof c !== "string") continue;
    const b = collapseWhitespace(c).slice(0, OVERLAP_MAX_INPUT_CHARS);
    if (b.length > 0) bs.push(b);
  }
  if (bs.length === 0) return NO_OVERLAP;

  let lo = 1;
  let hi = Math.min(
    a.length,
    bs.reduce((m, b) => Math.max(m, b.length), 0),
  );
  let best = NO_OVERLAP;

  // Invariant: every length < lo is known to be achievable, every length > hi unachievable.
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const hit = commonSubstringOfLength(a, bs, mid);
    if (hit === null) {
      hi = mid - 1;
    } else {
      best = { length: mid, text: hit };
      lo = mid + 1;
    }
  }
  return best;
}

/**
 * A substring of exactly `len` characters present in `a` and in some element of `bs`, or `null`.
 *
 * One Rabin-Karp pass to index `a`, one per candidate to probe it. Every hash hit is confirmed by
 * an actual string comparison, so a collision costs time and never correctness.
 */
function commonSubstringOfLength(a: string, bs: readonly string[], len: number): string | null {
  if (len <= 0 || len > a.length) return null;

  // BASE^(len-1) mod MOD — the weight of the character leaving the window on each roll.
  let high = 1;
  for (let i = 1; i < len; i++) high = (high * BASE) % MOD;

  const index = new Map<number, number[]>();
  let h = 0;
  for (let i = 0; i < len; i++) h = (h * BASE + a.charCodeAt(i)) % MOD;
  index.set(h, [0]);
  for (let i = len; i < a.length; i++) {
    h = (h - ((a.charCodeAt(i - len) * high) % MOD) + MOD) % MOD;
    h = (h * BASE + a.charCodeAt(i)) % MOD;
    const start = i - len + 1;
    const bucket = index.get(h);
    if (bucket) bucket.push(start);
    else index.set(h, [start]);
  }

  for (const b of bs) {
    if (b.length < len) continue;
    let hb = 0;
    for (let i = 0; i < len; i++) hb = (hb * BASE + b.charCodeAt(i)) % MOD;
    let found = probe(a, b, 0, len, index.get(hb));
    if (found !== null) return found;
    for (let i = len; i < b.length; i++) {
      hb = (hb - ((b.charCodeAt(i - len) * high) % MOD) + MOD) % MOD;
      hb = (hb * BASE + b.charCodeAt(i)) % MOD;
      found = probe(a, b, i - len + 1, len, index.get(hb));
      if (found !== null) return found;
    }
  }
  return null;
}

/** Confirm a hash hit with a real comparison. Returns the shared text, or `null` on a collision. */
function probe(
  a: string,
  b: string,
  bStart: number,
  len: number,
  aStarts: number[] | undefined,
): string | null {
  if (!aStarts) return null;
  const needle = b.slice(bStart, bStart + len);
  for (const s of aStarts) {
    if (a.startsWith(needle, s)) return needle;
  }
  return null;
}
