// MARK THE REPLY'S OPENING BLOCKQUOTE, so the renderer can tell it apart from every other one.
//
// The blue bar over a concierge answer is two different things wearing one style. The FIRST block of
// a reply is the founder's own message quoted back at him — the thing `replyWithoutQuote` forces to
// exist and `./replyQuoteCoverage` measures. Every other blockquote in that same reply is the
// concierge quoting something else: agent scrollback, a file, a line of its own from earlier. Only
// the first one may become a jump back to his message; making the others clickable would offer to
// scroll to a message they are not quoting.
//
// ══ WHY A TREE PASS AND NOT A POSITION CHECK AT RENDER TIME ════════════════════════════════════
// `components.blockquote` is called once per quote with no index and no siblings, so the renderer
// cannot tell "first" from "fourth" on its own. The alternatives are worse in the usual way: reading
// `node.position.start.offset` and comparing it against a scan of the source re-derives the parse
// outside the parser, and counting renders in a module-level variable breaks the moment two bubbles
// stream at once. Stamping the node is the same move `remarkBeadRefs` and `remarkMergeQuotes` make —
// decide it where the tree is, carry the answer in the tree.
//
// ══ ROOT LEVEL ONLY, AND THAT IS THE DEFINITION ════════════════════════════════════════════════
// `tree.children[0]`, nothing nested. A quote inside a list item or inside another quote is not an
// OPENING however early it appears — which is the same boundary `leadingQuoteCorpus` draws when it
// walks only the root's leading children, so the two agree by construction about which node this is.
//
// ══ ORDER ══════════════════════════════════════════════════════════════════════════════════════
// MUST run after `remarkMergeQuotes`. That plugin folds the reply's opening run of quotes into one
// node; marking first would stamp a node that is about to absorb its siblings — same attribute, same
// rendered bar, but the mark would be describing a tree that no longer exists by the time anything
// reads it. `Markdown.tsx` orders them accordingly and a test pins the pairing.

/** The attribute the mark lands on. A `data-` attribute rather than a class or a prop, because it
 *  travels the whole way to the DOM and is therefore greppable and assertable — the same reasoning
 *  `Markdown.tsx` gives for `data-md-face`. */
export const LEADING_QUOTE_ATTR = "data-leading-quote";

/** The subset of mdast this plugin touches. Structural rather than a type dependency on the
 *  renderer's stack, matching `remarkMergeQuotes`' choice for the same reason. */
interface Node {
  type: string;
  children?: Node[];
  /** mdast's own escape hatch onto the rendered element. `hProperties` are copied onto the hast
   *  node by `mdast-util-to-hast`, which is how the attribute reaches `components.blockquote` as a
   *  prop without this plugin knowing anything about React. */
  data?: { hProperties?: Record<string, unknown> };
}

/**
 * Stamp {@link LEADING_QUOTE_ATTR} on the document's first child when it is a blockquote.
 *
 * A no-op for everything else — a reply that opens with prose, an empty document, a tree whose first
 * block is a heading. Nothing is removed and nothing else is touched, so the plugin is safe to leave
 * in a pipeline whose input may be any markdown at all.
 */
export function remarkLeadingQuote() {
  return (tree: Node): void => {
    const first = tree.children?.[0];
    if (first === undefined || first.type !== "blockquote") return;
    // Spread rather than assign: `data` and `hProperties` may already carry something another plugin
    // put there, and clobbering a sibling plugin's channel is the kind of order-dependence this
    // pipeline's comments are at pains to avoid.
    first.data = {
      ...(first.data ?? {}),
      hProperties: { ...(first.data?.hProperties ?? {}), [LEADING_QUOTE_ATTR]: "yes" },
    };
  };
}
