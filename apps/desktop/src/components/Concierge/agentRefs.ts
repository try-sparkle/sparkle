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
// A CONCIERGE message has exactly TWO consumers, and the second one arrived exactly as this
// paragraph warned it would:
//
//   1. `ConciergeThread` renders `kind: "sparkle"` text through `<Markdown>`, which turns a
//      reference into a pill.
//   2. THE CLIPBOARD. `CopyAnswerButton` copies the markdown SOURCE — that is the whole point of
//      it, so tables and code blocks survive a paste — and it landed on this branch while the
//      pills landed on main, so neither side's tests could see the combination. An answer naming
//      an agent copied as `[@Kraken Auth](sparkle-agent:9f3c…)`: a dead link carrying an internal
//      uuid, pasted into a PR or a Slack thread, where the reader wanted the answer.
//
// Consumer 2 is HANDLED, by `stripAgentRefs` below, which every copy path must run first. That is
// the price this design charges per consumer, and it is why the count is written down here. A
// THIRD consumer — a notification body, a router payload, an export — pays it again or reintroduces
// the bug `mentions.ts`'s header describes. Re-verify before adding one.
//
// The SELECTION path needs no stripping: `sel.toString()` reads the rendered DOM, so it already
// yields `@Kraken Auth`. That asymmetry is the reason this is easy to miss — two copy affordances
// over the same words, one correct by construction and one not.
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

import { fromMarkdown } from "mdast-util-from-markdown";

/** The shape `stripAgentRefs` walks. Structural rather than mdast's full union: this module needs
 *  three fields, and naming them here keeps it free of a type dependency on the renderer's stack. */
interface MdastNode {
  type: string;
  value?: string;
  children?: MdastNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}
interface MdastLink extends MdastNode {
  url: string;
}

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

/**
 * Flatten agent references to the words a reader sees, for consumers that are not the renderer.
 *
 * THE CLIPBOARD IS THE CALLER. `CopyAnswerButton` copies the markdown SOURCE on purpose — that is
 * what keeps a table a table on paste — but the source of an answer that names an agent contains
 * `[@Kraken Auth](sparkle-agent:9f3c…)`, and pasting an internal uuid as a dead link is not what
 * "copy this answer" means. The rendered pill reads `@Kraken Auth`, the selection path already
 * yields `@Kraken Auth`, and this makes the third path agree with the other two.
 *
 * Ordinary links are LEFT ALONE — a real `[docs](https://…)` is part of the answer and belongs in
 * the paste. "Ours" is decided by `parseAgentRefHref`, the same function the renderer asks.
 *
 * ══ IT PARSES, IT DOES NOT PATTERN-MATCH ═══════════════════════════════════════════════════════
 * This ran on a hand-rolled `/\[([^\]]*)\]\(([^)]*)\)/g` first, and a second grammar is a second
 * set of answers. roborev 55092 found it disagreeing with remark in BOTH directions on exactly the
 * model-authored text this feature exists for:
 *
 *   • OVER-stripping. remark never parses a link inside a code span or a fence; a regex does. An
 *     answer quoting a stored message — ``the source is `Ask [@K](sparkle-agent:9f3c)` `` — renders
 *     as literal syntax in the thread but would have copied with the reference rewritten. That is
 *     the button silently editing code the user copied BECAUSE it preserves source verbatim.
 *   • UNDER-stripping, which reintroduces the very bug this function exists to fix. CommonMark
 *     allows a title — `(sparkle-agent:9f3c "Kraken Auth")` — and an angle-bracketed destination —
 *     `(<sparkle-agent:9f3c>)`. remark splits the title off and unwraps the brackets, so both
 *     render as pills; the regex handed the whole string to `parseAgentRefHref`, got null, and left
 *     the dead link with its uuid in the clipboard. Nested brackets in a label failed the same way.
 *
 * So the destination is now read from the SAME markdown grammar the thread renders through, and
 * every one of those cases follows from that rather than from a rule someone remembered to add.
 * The link nodes carry source offsets, so the rewrite is a splice of the original text: everything
 * this function does not understand is passed through byte-for-byte, which is the property a
 * copy-the-source button needs most.
 */
export function stripAgentRefs(text: string): string {
  const edits: { start: number; end: number; label: string }[] = [];
  visitLinks(fromMarkdown(text), (node) => {
    if (parseAgentRefHref(node.url) === null) return;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    // A node without offsets cannot be spliced safely; leaving it literal is the same outcome as a
    // malformed reference, which the renderer also declines to turn into a pill.
    if (start === undefined || end === undefined) return;
    edits.push({ start, end, label: `@${stripMentionSigil(nodeText(node))}` });
  });
  // Back to front, so each splice leaves the offsets of the ones before it untouched.
  let out = text;
  for (const e of edits.sort((a, b) => b.start - a.start)) {
    out = out.slice(0, e.start) + e.label + out.slice(e.end);
  }
  return out;
}

/** Every `link` node in the tree, in document order. */
function visitLinks(node: MdastNode, fn: (link: MdastLink) => void): void {
  if (node.type === "link") fn(node as MdastLink);
  for (const child of node.children ?? []) visitLinks(child, fn);
}

/** A node's visible words — what the pill would draw, and what a selection copy already yields. */
function nodeText(node: MdastNode): string {
  if (typeof node.value === "string") return node.value;
  return (node.children ?? []).map(nodeText).join("");
}
