// The linkifier: bare bead ids in prose become the same `link` nodes an explicit reference would
// have produced, so a single renderer branch serves both.
//
// ══ WHY THIS IS A REMARK PLUGIN AND NOT A STRING PASS ═══════════════════════════════════════════
// The obvious cheap version is a `String.replace` over the message text before it reaches
// `<Markdown>`. It is wrong three ways, and each one is reachable from text the concierge actually
// writes:
//
//   • IT WOULD REWRITE CODE. A fenced block or an inline span quoting a command — `bd show
//     sparkle-t6wje` — renders verbatim on purpose, and a pill inside it is the button silently
//     editing the thing the reader is about to copy. This is `stripAgentRefs`'s over-stripping bug
//     (roborev 55092) in the other direction, and a string pass has no way to know it is inside a
//     fence. This plugin never sees those nodes: it visits `text` only, and a code span's value
//     lives on an `inlineCode`/`code` node.
//   • IT WOULD NEST A LINK IN A LINK. `[the retry work](https://…sparkle-17hm1…)` is ordinary
//     markdown, and injecting a reference into its label produces an anchor inside an anchor —
//     invalid HTML the browser reparents, which is the class of bug `AgentPill`'s "inline elements
//     only" note exists for. The walk below carries an `inLink` flag for exactly this.
//   • IT WOULD CORRUPT THE SOURCE. `CopyAnswerButton` copies `m.text` verbatim, so a pre-render
//     rewrite would put `[sparkle-17hm1](sparkle-bead:sparkle-17hm1)` on the clipboard for text the
//     model never wrote that way. Transforming the TREE leaves the source byte-for-byte intact,
//     which is why `stripBeadRefs` has nothing to do for an auto-linkified id.
//
// ══ WHY IT RUNS AFTER `remarkGfm` ═══════════════════════════════════════════════════════════════
// GFM's autolink-literal extension turns a bare URL into a `link` node. Ordering this plugin after
// it means those links already exist by the time the walk runs, so their text is protected by the
// same `inLink` flag as a hand-written one. The reverse order would linkify inside a URL that had
// not become a link yet.

import { fromMarkdown } from "mdast-util-from-markdown";

import { findBeadIds, type BeadIdSpan } from "./beadRefs";
import { beadRefHref } from "./beadRefs";

/** The subset of mdast this plugin touches. Structural, matching `beadRefs.ts`'s choice not to take
 *  a type dependency on the renderer's stack. */
interface Node {
  type: string;
  value?: string;
  url?: string;
  children?: Node[];
  /** Present on parsed nodes; deliberately NOT set on the nodes this plugin creates — see below. */
  position?: unknown;
}

/**
 * Split every bead id out of the text nodes of `tree` into `sparkle-bead:` links.
 *
 * ══ THE CREATED NODES CARRY NO `position`, DELIBERATELY ═════════════════════════════════════════
 * A synthesized node's source span is a lie: there is no `[…](…)` in the source to point at, and a
 * consumer that trusted it — `stripBeadRefs` splices by offset — would cut the wrong bytes out of
 * text it was asked to pass through verbatim. Omitting the field makes that consumer's existing
 * "no offsets, leave it literal" branch do the right thing without knowing this plugin exists.
 */
export function remarkBeadRefs() {
  return (tree: Node): void => {
    walk(tree, false, (value) => split(value));
  };
}

/**
 * Every bead-id candidate this plugin WOULD linkify in `text`, in document order.
 *
 * ══ WHY THIS LIVES HERE RATHER THAN BESIDE ITS CALLER ═══════════════════════════════════════════
 * Its caller — `autoExpandedBeadIds` in `BeadPill.tsx`, which decides how many cards a reply opens
 * — needs to know which ids will actually become PILLS, and that is this module's rule, not its
 * own. It first asked `findBeadIds(text)` directly, over the raw markdown SOURCE, and the two
 * answers are not the same set: `findBeadIds` knows nothing about fences, code spans or links,
 * because the plugin's job has always been to keep it away from those nodes. So an id inside
 * `bd show sparkle-x` was counted, drew no pill, and silently consumed one of the founder's cap
 * slots (roborev 65335) — worst at a small cap, where a reply that opens with a quoted command
 * could expand NOTHING while the config plainly said the feature was on.
 *
 * It shares ONE traversal with the linkifier above rather than restating the rule, which is the
 * whole point: a `walk` that skipped a new node type here and not there would put the drift back.
 *
 * ══ WHAT IT DOES NOT CLOSE ══════════════════════════════════════════════════════════════════════
 * `fromMarkdown` here is plain CommonMark, while the renderer runs `remarkGfm` first (see the
 * ordering note above). The one difference that reaches this rule is GFM's AUTOLINK LITERAL: a bare
 * `https://…/sparkle-x` is a `link` in the renderer's tree and protected by `inLink`, but stays
 * ordinary text here — so such an id can still consume a slot without drawing a pill. Deliberately
 * not chased: closing it means adding `micromark-extension-gfm` + `mdast-util-gfm` as direct
 * dependencies (today they are only transitive through `remark-gfm`), and the residual is one rare
 * shape against the three common ones — inline code, fences, and written links — that this closes.
 * `stripBeadRefs` parses the same way for the same reason.
 */
export function linkifiableBeadIds(text: string): BeadIdSpan[] {
  const out: BeadIdSpan[] = [];
  walk(fromMarkdown(text) as Node, false, (value) => {
    out.push(...findBeadIds(value));
    return null; // collect only — nothing is rewritten
  });
  return out;
}

/**
 * THE ONE TRAVERSAL, shared by the linkifier and by `linkifiableBeadIds` above.
 *
 * `onText` is called for every text node the linkifier would split, in document order. Returning
 * nodes replaces that node (what the plugin does); returning `null` leaves it alone (what the
 * collector does). Two callers, one statement of "which nodes are eligible" — see the note on
 * `linkifiableBeadIds` for the drift this shape exists to prevent.
 */
function walk(node: Node, inLink: boolean, onText: (value: string) => Node[] | null): void {
  const children = node.children;
  if (children === undefined) return;
  // A link's SUBTREE is off limits, not merely its immediate children: `[**sparkle-17hm1**](…)`
  // puts the text one level down inside a `strong`, and emphasis inside a link is ordinary markdown
  // a model emits unprompted (the reasoning `Markdown.tsx`'s `linkText` had to learn the hard way).
  const nested = inLink || node.type === "link" || node.type === "linkReference";
  const out: Node[] = [];
  let changed = false;
  for (const child of children) {
    if (child.type !== "text" || nested || typeof child.value !== "string") {
      walk(child, nested, onText);
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

/** The nodes `value` becomes, or null when it holds no ids and the original should be kept (which
 *  keeps its `position` intact for every node this plugin does not touch). */
function split(value: string): Node[] | null {
  const spans = findBeadIds(value);
  if (spans.length === 0) return null;
  const out: Node[] = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.start > cursor) out.push({ type: "text", value: value.slice(cursor, span.start) });
    out.push({
      type: "link",
      url: beadRefHref(span.id),
      children: [{ type: "text", value: span.id }],
    });
    cursor = span.end;
  }
  if (cursor < value.length) out.push({ type: "text", value: value.slice(cursor) });
  return out;
}
