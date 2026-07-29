// An agent MENTIONED BY THE CONCIERGE, as a link the renderer turns into a pill. The pure half:
// no React, no stores, no Tauri.
//
// ══ THIS IS NOT THE SENTINEL TOKEN `mentions.ts` FORBIDS ════════════════════════════════════════
// Read that module's header first; it opens with an emphatic, well-earned prohibition on encoding a
// mention as a token in the text, and someone will arrive here believing this violates it. It does
// not, and the distinction is the number of renderings the text has.
//
// A USER's message is rendered THREE ways (ConciergeHost's `send`): the thread bubble, the payload
// relayed into a live Claude Code PTY, and the plain text the router and auto-namer read. A token
// in that text has to be stripped from each one independently, and forgetting one is exactly the
// shape of the attachment temp-path leak (roborev 46911/46925), which reached three surfaces before
// anyone noticed. So a user mention is DERIVED from the literal `@Name`, never encoded.
//
// A CONCIERGE message has exactly ONE consumer: `ConciergeThread` renders `kind: "sparkle"` text
// through `<Markdown>`, and nothing else reads it — not the PTY, not the router, not the
// notification body. (Verified by grep; re-verify before adding a second consumer, because doing so
// is what would make this the bug the other header describes.)
//
// The derive-from-text rule cannot be used here anyway, and that is the positive reason for this
// module rather than merely an absence of objections. Deriving means matching a NAME against the
// live roster — and the founder currently runs four agents called "Chief Error Diagnostics" and two
// called "Status Check". `mentions.ts` solves that for the composer by making the ADDRESS longer
// (`@Docs (web)`), which works because a human is choosing from a picker and can read the
// disambiguation. The concierge is not choosing from a picker; it is writing prose, and a name it
// writes is at best a guess at which of four identical names it meant. An id is not a guess.
//
// ══ WHY A MARKDOWN LINK AND NOT A BESPOKE DELIMITER ═════════════════════════════════════════════
// `[@Name](sparkle-agent:<id>)` is parsed by the renderer we already run (react-markdown + GFM), so
// there is no second parser to keep in step with the first, and it composes with the markdown
// around it — a pill inside a bullet or a bold run needs no special case.
//
// It also degrades correctly for free, which a bespoke delimiter would not. `Markdown.tsx` already
// drops the `href` of any non-allowlisted scheme and renders the link's TEXT as inert prose, so a
// build where this module is absent, or a message whose token was clipped by the thread store's
// 4000-character cap, shows the reader `@Name` rather than raw syntax. Degradation is the default
// path here, not an extra branch someone has to remember to write.

/** The scheme that marks a link as an agent reference. A constant, not a literal scattered across
 *  the parser, the renderer and the persona's instructions — those three must agree exactly. */
export const AGENT_REF_SCHEME = "sparkle-agent:";

/**
 * What an agent id is allowed to look like.
 *
 * THIS IS A TRUST BOUNDARY, not a tidiness check. The id arrives inside model-authored text, and
 * the value is handed to a store lookup and a navigation call. The app's ids are uuid-shaped, so a
 * conservative alphanumeric/`-`/`_` class covers every real one while refusing path traversal,
 * whitespace, quotes, angle brackets and anything else that could matter to a downstream consumer
 * this module cannot see. Bounded length for the same reason: an unbounded id is an unbounded
 * string from an untrusted source.
 *
 * Refusing is SAFE here in a way it usually is not: an id that fails this test yields a null, the
 * pill renders inert, and the reader sees the plain name. Nothing is lost but a click.
 */
const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * The agent id in `href`, or null when it is not a well-formed agent reference.
 *
 * Null means "not ours" and "ours but malformed" alike, deliberately: both must fall through to
 * the ordinary link path, and a caller that could tell them apart would be tempted to render
 * something different for the second — which is how a malformed id becomes a visible error message
 * in the middle of a sentence.
 */
export function parseAgentRefHref(href: string | undefined): string | null {
  if (typeof href !== "string") return null;
  // Trim before the scheme test for the same reason `isSafeLinkHref` does: markdown can carry
  // leading whitespace into an href, and ` sparkle-agent:x` is the same link to a reader.
  const trimmed = href.trim();
  if (!trimmed.toLowerCase().startsWith(AGENT_REF_SCHEME)) return null;
  const id = trimmed.slice(AGENT_REF_SCHEME.length);
  return AGENT_ID_RE.test(id) ? id : null;
}

/** The href for an agent id — the one place the scheme and the id are joined. Exported so the
 *  tests, and anything that ever composes a reference, cannot spell it differently. */
export function agentRefHref(agentId: string): string {
  return `${AGENT_REF_SCHEME}${agentId}`;
}

/**
 * The bare display name inside a link's text, with any leading sigil removed.
 *
 * The persona asks for `[@Agent Name](…)`, and the pill draws its own `@` — so a model that
 * complies would otherwise produce `@@Agent Name`. Stripping here rather than trusting the
 * instruction means the pill reads correctly whether or not the model included the sigil, which
 * matters because the instruction is a request to a language model, not a schema it must satisfy.
 */
export function stripMentionSigil(text: string): string {
  const t = text.trim();
  return t.startsWith("@") ? t.slice(1).trim() : t;
}
