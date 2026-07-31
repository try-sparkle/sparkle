// Decode HTML entities out of MODEL-AUTHORED display text on the way IN.
//
// WHY THIS EXISTS. A worker named itself "Pane Mounting & Resize Perf" and the ladder rendered
// "Pane Mounting &amp; Resize Perf". The app is not the escaper — the roster proves it, because
// other agents' names carry a RAW ampersand ("Spider Chart & Live Task", "Waterfall & Team
// Health") and survive every surface intact. What happened is that the agent itself emitted the
// escaped form in its `rename_agent` tool arguments. Models do this: the name is generated text,
// and generated text picks up HTML escaping from the model's own training distribution. It is not
// rare and it is not something the caller can be relied on to stop doing — so the app has to be
// the one that normalizes, at the boundary where the name arrives.
//
// FIXED AT INGEST, NOT AT RENDER, and that distinction is load-bearing. React already escapes on
// output, so "decode at the render site" would have to be done at EVERY render site (the ladder
// row, the agent pill, the tab title, the window title, the concierge feed, `get_state`'s roster)
// and every one added later. Decoding once as the name is stored means every reader — including
// ones that never call `agentDisplayName`, and including the MCP roster another agent reads — sees
// the same, correct string.
//
// DELIBERATELY NOT APPLIED TO HUMAN-TYPED NAMES (the sidebar's manual rename). A person who types
// "&amp;" means those characters; a model that emits them means "&". Only the model-authored
// setters call this.
//
// Pure and DOM-free (no `textarea.innerHTML` trick) so it is unit-testable under the node env and
// can never execute markup as a side effect of decoding it.

/** The named entities worth handling: the five `escapeHtml` produces, plus the two other spellings
 *  that show up in model output. Anything else stays literal — a display name has no business
 *  carrying `&hellip;`, and silently rewriting unknown entities is how a decoder starts mangling
 *  legitimate text. */
const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** One decoding pass: named entities plus numeric (`&#39;`) and hex (`&#x27;`) character refs. */
function decodeOnce(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = parseInt(body.slice(2), 16);
      return codePointOr(code, whole);
    }
    if (body.startsWith("#")) {
      const code = parseInt(body.slice(1), 10);
      return codePointOr(code, whole);
    }
    return NAMED[body.toLowerCase()] ?? whole;
  });
}

/** A character ref is only honored when it names a real, safe scalar value. Anything out of range,
 *  unpaired-surrogate, or a C0 control (which would let a decoded name inject newlines/NULs into a
 *  single-line label) is left exactly as written rather than turned into something unprintable. */
function codePointOr(code: number, fallback: string): string {
  if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return fallback;
  if (code >= 0xd800 && code <= 0xdfff) return fallback;
  if (code < 0x20 || code === 0x7f) return fallback;
  return String.fromCodePoint(code);
}

/** Passes allowed before we stop. DOUBLE-escaping is the reported shape ("&amp;amp;" — escaped
 *  once by the model, once more by whatever relayed it), so a single pass is not enough. The cap
 *  keeps this bounded and total: a pathological input can cost at most this many scans, and a name
 *  that genuinely contains the literal text "&amp;" is not worth protecting against a bug that is
 *  actually happening. */
const MAX_PASSES = 4;

/**
 * Decode HTML entities until the string stops changing (bounded by `MAX_PASSES`).
 *
 * `"Pane Mounting &amp; Resize Perf"` → `"Pane Mounting & Resize Perf"`
 * `"Pane Mounting &amp;amp; Resize Perf"` → `"Pane Mounting & Resize Perf"`
 * `"Rock & Roll"` → unchanged (nothing to decode — this is the common case and it is a no-op)
 */
export function decodeHtmlEntities(s: string): string {
  let out = s;
  for (let i = 0; i < MAX_PASSES; i++) {
    const next = decodeOnce(out);
    if (next === out) break;
    out = next;
  }
  return out;
}

/** The one normalizer every MODEL-AUTHORED agent name passes through on the way into the store. */
export function normalizeAgentName(name: string): string {
  return decodeHtmlEntities(name);
}
