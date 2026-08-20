// The linkifier: bare PR numbers in prose become the same `link` nodes an explicit reference would
// have produced, so a single renderer branch serves both.
//
// ══ WHY THIS EXISTS AT ALL ═════════════════════════════════════════════════════════════════════
// The founder's standing instruction, relayed through the concierge: a PR must never appear as a
// bare number — it has to be clickable. A pill on the app-written merge receipt and bare digits in
// an agent's retro or a "blocked behind #2100" line would reproduce exactly the complaint
// `actionReceiptLine.ts` records ("You said it's up. But I can't actually click on it"), just one
// surface over. So the rule is applied ONCE, in the shared `<Markdown>` pipeline, and every surface
// that renders concierge text inherits it.
//
// ══ WHY A REMARK PLUGIN AND NOT A STRING PASS ══════════════════════════════════════════════════
// Read `remarkBeadRefs`' header — all three of its reasons apply here unchanged (a string pass would
// rewrite inside code, nest a link in a link, and corrupt the clipboard's source). This plugin
// differs from it in exactly one respect, and it is a fact about the REFERENT rather than about the
// tree: a bead candidate that resolves to nothing renders as the prose it always was, whereas a PR
// number resolves against a repository and a false positive would open a real, wrong page. That
// asymmetry is answered in `findPrRefs` (a two-digit floor), not here.
//
// ══ WHY IT RUNS AFTER `remarkGfm` AND AFTER `remarkBeadRefs` ═══════════════════════════════════
// After `remarkGfm` for the reason `remarkBeadRefs` gives: GFM's autolink-literal extension turns a
// bare URL into a `link` node, and running after it means a `#2164` inside
// `https://github.com/o/r/pull/2164` is already protected by the shared walk's in-a-link guard.
// After `remarkBeadRefs` for symmetry rather than necessity — the two patterns cannot both match one
// token (a bead id has no `#`) — so the order is one less thing to reason about, not a constraint.

import { findPrRefs, prRefHref } from "./prRefs";
import { splitOnSpans, walkTextNodes, type MdastWalkNode as Node } from "./mdastTextWalk";

/**
 * Split every PR number out of the text nodes of `tree` into `sparkle-pr:` links.
 *
 * THE REFERENCES IT WRITES ARE UNQUALIFIED — `sparkle-pr:2164`, never `owner/repo#2164`. This runs
 * at PARSE time inside a `memo`ized renderer keyed on the text alone, so anything it decides is
 * frozen for as long as that text is on screen; which repository a bare number belongs to is a fact
 * about the reader's selected project, which can change five seconds from now. `PrPill` resolves it
 * live, exactly as `BeadPill` decides a bead's existence live. See `prRefs.ts`'s header.
 */
export function remarkPrRefs() {
  return (tree: Node): void => {
    walkTextNodes(tree, false, (value) => split(value));
  };
}

/** The nodes `value` becomes, or null when it holds no PR numbers and the original should be kept
 *  (which keeps its `position` intact for every node this plugin does not touch). */
function split(value: string): Node[] | null {
  return splitOnSpans(value, findPrRefs(value), (span, text) => ({
    type: "link",
    url: prRefHref({ number: span.number }),
    children: [{ type: "text", value: text }],
  }));
}
