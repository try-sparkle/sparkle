// A RESEARCH TASK referenced in concierge text, as a link the renderer turns into a pill. The pure
// half: no React, no stores, no Tauri.
//
// ══ THE THIRD SIBLING OF `agentRefs.ts` / `beadRefs.ts` ═════════════════════════════════════════
// Read `agentRefs.ts`'s header first. Everything it says about why a reference is a MARKDOWN LINK
// rather than a bespoke delimiter, why the id lives behind a conservative trust boundary, and why
// the clipboard flattener parses rather than pattern-matches, applies here unchanged. This module
// mirrors it so a reader who has understood one has understood all three — one shape, three kinds of
// referent (an AGENT, a unit of WORK, a background RESEARCH task).
//
// ══ WHERE THE REFERENCE COMES FROM ═════════════════════════════════════════════════════════════
// Like an agent reference, and unlike a bead reference, a research reference is WRITTEN, not found:
// the persona is instructed (in `apps/mcp-control/src/server.ts`'s `sparkle_research` description) to
// name a task it dispatched as `[<the question>](sparkle-research:<taskId>)`, and the runner mints
// the id. Text that does not contain the scheme contains no research pill, by construction — a task
// id is not id-shaped in a way that could be recovered from prose (`rsh_<epoch>_<hex>`), so there is
// no linkifier for it and none is wanted.
//
// ══ SYNTAX IS DECIDED HERE; EXISTENCE IS DECIDED LIVE ══════════════════════════════════════════
// This module answers "could this be a task id?"; `ResearchPill` answers "is it one the row is
// showing, right now?" — re-asked on every render against the live research store. An id that no
// longer resolves to a VISIBLE task (the concierge has been told, the row retired) renders as the
// plain label, exactly as a `BeadPill` for an unfiled id renders as prose. Deciding existence here
// would freeze it for as long as the memoized text is on screen, which is the wrong place to decide
// a fact about the store five seconds from now.

import { fromMarkdown } from "mdast-util-from-markdown";

/** The shape `stripResearchRefs` walks. Structural rather than mdast's full union, for the reason
 *  `agentRefs.ts` gives: three fields are enough, and naming them here keeps this module free of a
 *  type dependency on the renderer's stack. */
interface MdastNode {
  type: string;
  value?: string;
  children?: MdastNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}
interface MdastLink extends MdastNode {
  url: string;
}

/** The scheme that marks a link as a research-task reference. A constant, not a literal scattered
 *  across the parser, the renderer and the persona's instructions — those three must agree exactly. */
export const RESEARCH_REF_SCHEME = "sparkle-research:";

/**
 * What a research task id is allowed to look like — the PARSER's trust boundary.
 *
 * The runner mints `rsh_<epoch13>_<16hex>` (see `src-tauri/src/research.rs`), so an
 * alphanumeric/`_`/`-` class covers every real one. This is the SAME class `AGENT_ID_RE` uses and
 * for the same reason: the value arrives inside model-authored text and is handed to a store lookup,
 * so path separators, whitespace, quotes, angle brackets and any second scheme are all refused.
 * Bounded length because an unbounded id is an unbounded string from an untrusted source.
 *
 * Refusing is SAFE here exactly as it is for agents and beads: a rejected id yields null, the pill is
 * never constructed, and the reader sees the plain label. Nothing is lost but a click.
 */
const RESEARCH_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** True when `id` is a well-formed research task id. Exported so a WRITER's boundary can be the same
 *  test as the parser's rather than a second spelling of it. */
export function isWellFormedResearchId(id: string): boolean {
  return RESEARCH_ID_RE.test(id);
}

/**
 * The task id in `href`, or null when it is not a well-formed research reference.
 *
 * Null means "not ours" and "ours but malformed" alike, for the reason `parseAgentRefHref` gives:
 * both must fall through to the ordinary link path, and a caller that could tell them apart would be
 * tempted to render the second as a visible error in the middle of a sentence.
 */
export function parseResearchRefHref(href: string | undefined): string | null {
  if (typeof href !== "string") return null;
  // Trim before the scheme test for the same reason `isSafeLinkHref` does: markdown can carry
  // leading whitespace into an href, and ` sparkle-research:x` is the same link to a reader.
  const trimmed = href.trim();
  if (!trimmed.toLowerCase().startsWith(RESEARCH_REF_SCHEME)) return null;
  const id = trimmed.slice(RESEARCH_REF_SCHEME.length);
  return isWellFormedResearchId(id) ? id : null;
}

/** The href for a task id — the one place the scheme and the id are joined. Exported so the tests,
 *  and anything that ever composes a reference, cannot spell it differently. */
export function researchRefHref(taskId: string): string {
  return `${RESEARCH_REF_SCHEME}${taskId}`;
}

/**
 * Flatten research references to the words a reader sees, for consumers that are not the renderer.
 *
 * THE CLIPBOARD IS THE CALLER, and this is `agentRefs.ts`'s "third consumer" tax paid a third time —
 * knowingly, exactly as that module's header says it must be. `CopyAnswerButton` copies the markdown
 * SOURCE so a table stays a grid on paste; the source of an answer that references a task contains
 * `[the question](sparkle-research:rsh_…)`, and pasting a dead link carrying an internal id is not
 * what "copy this answer" means. The rendered pill reads the question label and the selection path
 * already yields it, so this makes the source path agree with the other two.
 *
 * IT PARSES, IT DOES NOT PATTERN-MATCH, for every reason `stripAgentRefs`/`stripBeadRefs` give — a
 * hand-rolled `/\[…\]\(…\)/g` disagreed with remark in both directions (over-stripping inside code
 * spans, under-stripping the CommonMark title and angle-bracketed forms). Reading the destination
 * from the same grammar the thread renders through makes all of those follow from one decision.
 */
export function stripResearchRefs(text: string): string {
  const edits: { start: number; end: number; label: string }[] = [];
  visitLinks(fromMarkdown(text), (node) => {
    const id = parseResearchRefHref(node.url);
    if (id === null) return;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    // A node without offsets cannot be spliced safely; leaving it literal is the same outcome as a
    // malformed reference, which the renderer also declines to turn into a pill.
    if (start === undefined || end === undefined) return;
    // The VISIBLE words, falling back to the id. The pill draws the label the author wrote (the
    // question); only when the author wrote nothing does the reader fall back to the id itself.
    const label = nodeText(node).trim();
    edits.push({ start, end, label: label === "" ? id : label });
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

/** A node's visible words — what the reader saw, and what a selection copy already yields. */
function nodeText(node: MdastNode): string {
  if (typeof node.value === "string") return node.value;
  return (node.children ?? []).map(nodeText).join("");
}
