// Extract the `@`-tokens from one bead comment.
//
// THIS FILE ONLY FINDS TOKENS; IT NEVER DECIDES WHO THEY MEAN. Resolution — id first, then a unique
// display-name match, with an explicit ambiguous/unknown verdict — lives in ONE place
// (`services/agentMentionResolve`), shared with `send_peer_message`. Splitting it that way is what
// lets an UNKNOWN handle be reported back to whoever wrote it: a parser that silently dropped
// anything it could not resolve (which is what `mention.rs::parse_mentions` does, by design, for its
// two hard-coded handles) can never tell "nobody was mentioned" apart from "someone was mentioned and
// the message went nowhere". That distinction is the whole feature.
//
// WHY A NAME DICTIONARY IS AN INPUT. An agent's display name is free text and routinely contains
// SPACES ("Bead Mention Doorbell"). A word-run scan after `@` — the obvious implementation, and the
// one `mention.rs` uses — can only ever capture `Bead`, so every multi-word agent in the fleet is
// unaddressable and reports as an unknown handle. So the caller passes the names it knows, and a
// longest-match wins before the word-run fallback. The dictionary is used ONLY to decide where the
// token ENDS; whether that token actually resolves is still the resolver's call, so a name that is
// ambiguous across two agents is still reported as ambiguous rather than silently picked here.

/** A `@`-token found in a comment, with the offset it was found at (first-seen order is preserved). */
export interface MentionToken {
  /** The raw handle text, `@` stripped. Never empty. */
  token: string;
  /** True when the token was matched against a known display name rather than the word-run scan.
   *  Only used for diagnostics — resolution treats both identically. */
  matchedKnownName: boolean;
}

/** Characters that continue a bare `@handle` run: an agent id is a uuid, so `-` must be included. */
function isHandleChar(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9_-]/.test(ch);
}

/**
 * Is the `@` at `at` the START of a mention, rather than an `@` embedded in a longer word?
 *
 * WITHOUT THIS, `daniel@danielodio.com` mentions "danielodio". Every embedded `@` becomes a handle,
 * and because an unresolvable handle is REPORTED (that is the whole design), each one posts a
 * NOT DELIVERED comment onto a founder-visible bead about a comment that never contained a mention.
 * The failure is not merely noise either: an extracted fragment that happens to match a live agent
 * name delivers a real doorbell to someone nobody addressed.
 *
 * A mention must therefore start at the beginning of the text or follow a non-handle character —
 * whitespace, or punctuation like `(` or `"`. `@` itself is excluded so `@@foo` is not a mention.
 */
function startsMention(text: string, at: number): boolean {
  if (at === 0) return true;
  const prev = text[at - 1];
  return !isHandleChar(prev) && prev !== "@";
}

/**
 * Does a candidate token END on a boundary?
 *
 * TWO DISTINCT FAILURES, and only the first is obvious:
 *
 *  - A known name that is a PREFIX of a longer word would otherwise win. With an agent named `Ship`,
 *    `@Shipyard` yields `Ship` — which resolves cleanly and wakes an agent nobody mentioned. The
 *    word-run fallback would have produced `Shipyard`, an unknown handle, and REPORTED it. So the
 *    dictionary path without this check actively converts a reportable miss into a silent
 *    mis-delivery, which is the exact failure class this feature exists to remove.
 *
 *  - A `/` immediately after the run means a package scope or a path, never a mention. Bead comments
 *    in this repo routinely quote shell (`pnpm --filter @sparkle/desktop test`), and `@sparkle` there
 *    is not addressing anybody. Treating it as one produces a NOT DELIVERED comment on every such
 *    bead — and would deliver a real doorbell if a live agent happened to be named `sparkle`.
 */
function endsOnBoundary(rest: string, len: number): boolean {
  const after = rest[len];
  if (after === undefined) return true;
  return !isHandleChar(after) && after !== "/";
}

/**
 * Every distinct `@`-token in `text`, in first-seen order, de-duplicated.
 *
 * `knownNames` are display names that may contain spaces; the LONGEST one matching at the cursor
 * wins, so `@Bead Mention` cannot shadow `@Bead Mention Doorbell`. Matching is exact and
 * case-SENSITIVE, deliberately mirroring `resolveAgentMention` — a parser that folded case would
 * hand the resolver a token it then refused, turning a working mention into an unknown-handle
 * refusal for a reason invisible to the person who wrote it.
 *
 * A token must be BOUNDED on both sides (see `startsMention` / `endsOnBoundary`): an `@` embedded in
 * a longer word is not a mention, a known name may not win as the prefix of a longer word, and an
 * `@` with nothing addressable after it yields no token. Those three rules are what stop an email
 * address, a package scope, or a decorative `@` from manufacturing an unknown-handle report — and,
 * worse, from delivering a doorbell to an agent nobody addressed.
 */
export function parseMentionTokens(text: string, knownNames: readonly string[] = []): MentionToken[] {
  // Longest first so a name that is a prefix of another cannot win.
  const names = [...knownNames].filter((n) => n.length > 0).sort((a, b) => b.length - a.length);
  const out: MentionToken[] = [];
  const seen = new Set<string>();

  const push = (token: string, matchedKnownName: boolean) => {
    if (token.length === 0 || seen.has(token)) return;
    seen.add(token);
    out.push({ token, matchedKnownName });
  };

  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== "@") continue;
    if (!startsMention(text, i)) continue;
    const rest = text.slice(i + 1);

    const name = names.find((n) => rest.startsWith(n) && endsOnBoundary(rest, n.length));
    if (name !== undefined) {
      push(name, true);
      i += name.length; // the loop's own += 1 accounts for the `@`
      continue;
    }

    let j = 0;
    while (j < rest.length && isHandleChar(rest[j])) j += 1;
    if (j > 0 && endsOnBoundary(rest, j)) push(rest.slice(0, j), false);
    i += j;
  }

  return out;
}
