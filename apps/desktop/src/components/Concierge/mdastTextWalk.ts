// THE ONE TRAVERSAL every inline linkifier shares — "which text nodes may be rewritten".
//
// ══ WHY IT IS ITS OWN MODULE ═══════════════════════════════════════════════════════════════════
// It began as a private `walk` inside `remarkBeadRefs`, whose own header explains why it is shaped
// the way it is (code spans and fences are never visited; a link's whole SUBTREE is off limits, not
// merely its immediate children). That header also names the hazard this module exists to remove:
//
//     "It shares ONE traversal with the linkifier rather than restating the rule, which is the
//      whole point: a `walk` that skipped a new node type here and not there would put the drift
//      back."
//
// That was written about two callers in ONE file. `remarkPrRefs` is a third, in another file, and
// copying twelve lines of tree-walking into it would have reintroduced exactly the drift the
// sentence warns about — with the failure mode being silent and one-sided: a pill that correctly
// refuses to appear inside a fenced block for bead ids and cheerfully rewrites one for PR numbers.
//
// So the rule lives here, once, and every linkifier states only WHAT it matches.
//
// ══ WHAT THE RULE IS ═══════════════════════════════════════════════════════════════════════════
//   • Only `text` nodes are offered. A fenced block's or an inline span's content lives on a
//     `code`/`inlineCode` node, which has no `children` and is therefore never reached — that is
//     what keeps a pill out of a command the reader is about to copy.
//   • A `link`/`linkReference` subtree is off limits at ANY depth, because `[**#2164**](…)` puts the
//     text one level down inside a `strong`, and injecting a reference there produces an anchor
//     inside an anchor — invalid HTML the browser silently reparents.

/** The subset of mdast a linkifier touches. Structural, matching `beadRefs.ts`'s choice not to take
 *  a type dependency on the renderer's stack. */
export interface MdastWalkNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdastWalkNode[];
  /** Present on parsed nodes; deliberately NOT set on the nodes a linkifier creates — a synthesized
   *  node's source span is a lie, and a consumer that spliced by it would cut the wrong bytes. */
  position?: unknown;
}

/**
 * Visit every rewritable text node of `node`, in document order.
 *
 * `onText` returning nodes REPLACES that text node (what a linkifier does); returning `null` leaves
 * it alone, and with it the node's `position` (what a collector does). Two return shapes rather than
 * two functions, so a caller that only wants to know "what WOULD be linkified" asks the same
 * traversal the rewrite uses instead of approximating it.
 */
export function walkTextNodes(
  node: MdastWalkNode,
  inLink: boolean,
  onText: (value: string) => MdastWalkNode[] | null,
): void {
  const children = node.children;
  if (children === undefined) return;
  const nested = inLink || node.type === "link" || node.type === "linkReference";
  const out: MdastWalkNode[] = [];
  let changed = false;
  for (const child of children) {
    if (child.type !== "text" || nested || typeof child.value !== "string") {
      walkTextNodes(child, nested, onText);
      out.push(child);
      continue;
    }
    const replacement = onText(child.value);
    if (replacement === null) {
      out.push(child);
      continue;
    }
    changed = true;
    out.push(...replacement);
  }
  if (changed) node.children = out;
}

/**
 * Split `value` into text and link nodes around `spans`, or null when there are none.
 *
 * The other half every linkifier repeats: given the spans its own pattern found, cut the text around
 * them and emit a `link` per span. Returning null when nothing matched is what keeps an untouched
 * node's `position` intact.
 *
 * THE CREATED NODES CARRY NO `position`, DELIBERATELY — see {@link MdastWalkNode.position}.
 */
export function splitOnSpans<S extends { start: number; end: number }>(
  value: string,
  spans: readonly S[],
  toLink: (span: S, text: string) => MdastWalkNode,
): MdastWalkNode[] | null {
  if (spans.length === 0) return null;
  const out: MdastWalkNode[] = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.start > cursor) out.push({ type: "text", value: value.slice(cursor, span.start) });
    out.push(toLink(span, value.slice(span.start, span.end)));
    cursor = span.end;
  }
  if (cursor < value.length) out.push({ type: "text", value: value.slice(cursor) });
  return out;
}
