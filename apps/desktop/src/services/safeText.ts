// Surrogate-safe string handling for text that crosses a JSON boundary (Tauri IPC, the relay).
//
// WHY THIS EXISTS — the `publish_window_roster failed unexpected end of hex escape` flood:
// JavaScript strings are UTF-16 code units, so a non-BMP character (emoji, CJK ext, math script)
// occupies a surrogate PAIR of two units. A plain `s.slice(0, N)` can cut BETWEEN the pair and
// leave a lone LEADING surrogate at the end of the string. `JSON.stringify` faithfully emits that
// as the escape `\ud83c`, which is syntactically a complete escape but semantically half a
// character — and serde_json on the Rust side rejects it while parsing the IPC args with exactly:
//
//     unexpected end of hex escape at line N column N
//
// (serde_json reads the leading surrogate, then requires a following `\u` low surrogate; finding
// the closing quote instead, it reports UnexpectedEndOfHexEscape rather than a lone-surrogate
// error. That is why the message names a *hex escape* even though nothing was truncated on the
// wire.) The invoke then rejects, and because the roster republishes on every store change the
// same offending prompt fails over and over — hundreds of times a day.
//
// The fix is to never produce the malformed string in the first place: truncate on character
// boundaries, and keep a cheap well-formedness guard for text arriving from elsewhere.

/** Code-unit range for the leading half of a UTF-16 surrogate pair. */
const HIGH_START = 0xd800;
const HIGH_END = 0xdbff;

/** A high surrogate not followed by a low one, or a low surrogate not preceded by a high one. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** True if `s` contains an unpaired surrogate — i.e. `JSON.stringify(s)` would emit an escape that
 *  serde_json refuses to parse. Exported so tests (and callers) can assert the invariant directly. */
export function hasLoneSurrogate(s: string): boolean {
  LONE_SURROGATE.lastIndex = 0; // the regex is /g; reset so the check is stateless
  return LONE_SURROGATE.test(s);
}

/** Truncate to at most `maxUnits` UTF-16 code units WITHOUT splitting a surrogate pair.
 *  If the cut would land between a pair, the half character is dropped entirely — half an emoji is
 *  not worth corrupting the payload for.
 *
 *  NOTE: this guards the CUT only. Text that arrived already malformed stays malformed — use
 *  `safeTruncate` if you need both guarantees. The names were once `truncateSafe`/`safeTruncate`,
 *  which differed by word order alone; reaching for the wrong one silently reintroduced the lone
 *  surrogate this module exists to prevent, so the boundary-only variant is named for what it
 *  actually does. */
export function truncateOnBoundary(s: string, maxUnits: number): string {
  if (s.length <= maxUnits) return s;
  const cut = s.slice(0, maxUnits);
  const last = cut.charCodeAt(cut.length - 1);
  // A trailing HIGH surrogate is always malformed — its partner is beyond the cut.
  if (last >= HIGH_START && last <= HIGH_END) return cut.slice(0, -1);
  return cut;
}

/** Replace any unpaired surrogate with U+FFFD so the string is well-formed UTF-16 (and therefore
 *  serializes to JSON that serde_json accepts). This is a guard for text we did not truncate
 *  ourselves — a title or prompt can arrive already-malformed from a terminal scrape or a
 *  clipboard paste — not a substitute for truncating safely at the source. */
export function stripLoneSurrogates(s: string): string {
  if (!hasLoneSurrogate(s)) return s;
  return s.replace(LONE_SURROGATE, "�");
}

/** Both guards in the order they matter: cap the length on a character boundary, then repair any
 *  malformation that was already present in the source text. */
export function safeTruncate(s: string, maxUnits: number): string {
  return stripLoneSurrogates(truncateOnBoundary(s, maxUnits));
}
