// Adjacent blockquotes are ONE quote: merge them so a multi-line quotation draws a single bar.
//
// ══ THE DEFECT ══════════════════════════════════════════════════════════════════════════════════
// The founder reported a five-line quote rendering as FIVE SHORT GRAY DASHES down the left edge
// instead of one continuous rule. `Markdown.tsx` has drawn `borderLeft: 3px solid` on the
// blockquote since it was written, so the style was never the problem — the QUOTE was five separate
// blockquotes, each contributing its own 3px border and the 8px bottom margin between them.
//
// Under CommonMark a BLANK LINE ends a blockquote. So this, which is how the concierge writes a
// quotation when it quotes the founder's own message back to him:
//
//     > one
//                        ← blank
//     > two
//
// is two `blockquote` nodes, not one two-line quote. Contiguous `> one\n> two` would already have
// been a single node. Confirmed against this repo's own parser before the fix: blank-separated → 5
// blockquotes, contiguous → 1.
//
// ══ WHY A PLUGIN AND NOT CSS ════════════════════════════════════════════════════════════════════
// The cheap version is a negative margin, or `blockquote + blockquote { border-top: 0 }`, closing
// the visual gap and leaving the tree alone. It is wrong for the reason `remarkBeadRefs` gives for
// preferring a tree pass: the DOM would still say five quotes where the author wrote one. Anything
// reading the rendered output — a screen reader announcing "block quote" five times, a copy, a
// future selection or anchor feature — sees the lie, and the seam reopens the moment the spacing
// changes. Merging the NODES makes the document say what it means.
//
// It also cannot be fixed upstream by asking the model to stop emitting blank lines: the quoting is
// model-authored prose (a standing communication guideline), so the renderer has to be robust to
// both spellings rather than depend on one.
//
// ══ WHAT IT DELIBERATELY DOES NOT MERGE ═════════════════════════════════════════════════════════
// Only IMMEDIATELY ADJACENT siblings. mdast emits no node for a blank line, so two blockquotes that
// are adjacent in a `children` array were separated by nothing but whitespace in the source — which
// is exactly the case above. Anything the author put BETWEEN two quotes (a paragraph, a heading, a
// list, a fence) is a real node and keeps them apart, so a deliberate pair of quotations stays two
// bars. That is the whole boundary: the plugin closes gaps the source never had, and never joins
// quotes the author meant to keep separate.

/** The subset of mdast this plugin touches. Structural rather than a type dependency on the
 *  renderer's stack, matching `remarkBeadRefs`' choice for the same reason. */
interface Node {
  type: string;
  children?: Node[];
  /** Present on parsed nodes. Carried through unchanged — see `merge`. */
  position?: { start?: unknown; end?: unknown };
}

/**
 * Collapse runs of adjacent `blockquote` siblings into one, everywhere in `tree`.
 *
 * Runs at any depth, not just at the root: a quotation inside a list item splits on a blank line
 * the same way a top-level one does.
 */
export function remarkMergeQuotes() {
  return (tree: Node): void => {
    walk(tree);
  };
}

function walk(node: Node): void {
  const children = node.children;
  if (children === undefined) return;

  const out: Node[] = [];
  for (const child of children) {
    const prev = out[out.length - 1];
    if (prev !== undefined && prev.type === "blockquote" && child.type === "blockquote") {
      merge(prev, child);
      continue;
    }
    out.push(child);
  }

  // Recurse only AFTER merging this level, so a nested quote is walked once, in its final home,
  // rather than once in each fragment that gets folded into it.
  for (const child of out) walk(child);

  if (out.length !== children.length) node.children = out;
}

/** Fold `next` into `into`, in source order. */
function merge(into: Node, next: Node): void {
  into.children = [...(into.children ?? []), ...(next.children ?? [])];
  // The merged node keeps its own start and takes the absorbed one's END, so the span still covers
  // the text it now renders. Nothing in this app reads it, but a stale range that claims less than
  // it draws is the kind of thing a later source-mapping feature would inherit as a bug.
  if (into.position !== undefined && next.position !== undefined) {
    into.position = { start: into.position.start, end: next.position.end };
  }
}
