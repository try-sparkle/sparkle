// The reply's PLAIN PROSE, with source offsets — the one surface every text check reads.
//
// ══ IT PARSES, IT DOES NOT PATTERN-MATCH ════════════════════════════════════════════════════════
// `Concierge/agentRefs.ts:136-155` records why, and it is the same lesson with the same grammar:
// that module ran on a hand-rolled link regex first, and roborev 55092 found the regex disagreeing
// with remark in BOTH directions on exactly the model-authored text the feature exists for — it
// OVER-stripped inside code spans (remark never parses a link there) and UNDER-stripped CommonMark
// link titles and angle-bracketed destinations. This module reuses `mdast-util-from-markdown`, the
// same parser the thread renders through, rather than inventing a second grammar with a second set
// of answers.
//
// For the linter the stakes point the same way. An agent name, a `#123`, a `should`, or a
// `src/foo.ts:12` inside a fenced code block is QUOTED MATERIAL, not the concierge's prose, and
// flagging it is the single largest false-positive class in the design. A false positive on a
// linter that can `block` is not a cosmetic problem: it costs the user a revision turn on a reply
// that was already correct. So the exclusions are structural — they follow from what the parser
// says a node IS, never from a rule someone remembered to add.
//
// EXCLUDED, all by node type:
//   • `inlineCode` — `` `should` `` is a token being discussed, not a hedge.
//   • `code` — a fenced block is verbatim material; nothing inside it is the reply's own voice.
//   • link DESTINATIONS — a `link` node's `url` is not a text node, so it never appears in the
//     output; the link's visible LABEL does, because a reader reads it as prose.
//   • `html` / `image` alt — neither is prose the reader sees as the concierge's sentence.
//   • `blockquote`, OPT-IN via `excludeBlockquote` — see the flag's own note.
//   • BARE URL RUNS inside a text node — not a node type, and the one place this module has to
//     reach past the parser. See the next section for why that is a correction, not a second
//     grammar.
//
// ══ THE GFM GAP, STATED RATHER THAN PAPERED OVER ════════════════════════════════════════════════
// The renderer is `Markdown.tsx`, which runs remark WITH `remark-gfm`. This module runs
// `mdast-util-from-markdown` with NO extensions, so the two grammars are not identical, and pnpm's
// isolated `node_modules` means the gfm micromark/mdast extensions cannot be imported here without
// making them direct dependencies of this package — a shared-file change this module deliberately
// does not make. So the gap is documented and each construct that differs is accounted for:
//
//   • AUTOLINK LITERALS — `https://host/path/retry.ts:88` parses here as plain text, handing every
//     check the inside of a URL: a `naked-file-ref` on the path, a hedge word on a slug like
//     `/should-we-merge`. {@link autolinkRuns} finds those runs and this module drops them.
//
//     BE PRECISE ABOUT WHY, because the obvious sentence is FALSE. GFM does not remove an autolink
//     from prose the way a `[label](url)` does: it synthesizes a `link` whose single child is a
//     text node holding THE URL ITSELF, and this module deliberately keeps a link's visible label
//     (see the link bullet above). So the renderer shows the reader those characters, and dropping
//     them is a POLICY of this module — an address is not the concierge's sentence — not a
//     correction toward the renderer.
//
//     What the renderer does decide is the EXTENT. So the pattern is pinned to GFM's own autolink
//     shape — `http(s)://` or `www.` only, only at a line start or after whitespace/`*_~(`, and
//     with GFM's trailing punctuation and unmatched `)` trimmed back off. Anything outside that
//     shape is prose the reader reads as a sentence and every check keeps reading it: a
//     `file:///Users/x/should-we-merge.md` is NOT autolinked by GFM, so `hedge-words` still sees
//     the `should` in it.
//   • TABLES — a GFM table parses here as one paragraph rather than rows and cells. `hedge-words`
//     is unaffected (a cell's text is still the concierge's prose). `naked-file-ref` needs the row
//     structure and reconstructs it from the source line itself, without the parser — see that
//     check's header.
//   • STRIKETHROUGH / TASK LISTS — the delimiters survive as text rather than becoming nodes.
//     Nothing here matches on `~` or `[ ]`, so no check changes its answer.
//
// A future check that cares about table structure needs the extensions, and at that point they
// become a real dependency. Until then this is the honest position, not an oversight.
//
// This is consumer #3 of concierge text in the sense `agentRefs.ts`'s header warns about, but it is
// a READER, not a rewriter: nothing here strips or transforms the reply, so the per-consumer cost
// that header charges (re-running `stripAgentRefs`) does not apply.

import { fromMarkdown } from "mdast-util-from-markdown";

/** The shape this module walks. Structural rather than mdast's full union, matching `agentRefs.ts`:
 *  four fields are enough, and naming them here keeps the linter free of a type dependency on the
 *  renderer's stack. */
interface MdastNode {
  type: string;
  value?: string;
  children?: MdastNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}

/** One run of plain prose, with where it came from in the ORIGINAL source string. */
export interface ProseSpan {
  /** The text a reader sees. Markdown escapes and entity references are already resolved by the
   *  parser, so this can differ in length from `end - start` — see {@link sourceOffsetOf}. */
  value: string;
  /** Offset of this run's first character in the source string. */
  start: number;
  /** Offset one past its last character in the source string. */
  end: number;
}

export interface ProseSpanOptions {
  /**
   * Drop everything inside a `blockquote`.
   *
   * DEFAULT `false`, which is the literal reading of "plain prose": a blockquote is still text the
   * reader sees. But a concierge reply quotes the USER with it — "you asked: > should I ..." — and
   * a check that fires on the user's own words is blaming the concierge for something it did not
   * write. Checks that judge the concierge's VOICE (`hedge-words`, `naked-file-ref`) pass `true`;
   * checks that judge FACTS about the text (an unresolvable pill id is broken wherever it appears)
   * leave it `false`. The flag exists so that choice is made per check and is visible at the call
   * site, rather than being a default one of them silently inherits.
   */
  excludeBlockquote?: boolean;
}

/** Node types whose SUBTREE is never prose. `code` and `inlineCode` carry their text in `value`,
 *  so excluding the node excludes the text; `html` and `image` likewise. */
const NEVER_PROSE = new Set(["code", "inlineCode", "html", "image", "imageReference", "yaml"]);

/**
 * A GFM autolink literal, as GFM actually defines one.
 *
 * Three constraints, each removing a way the previous greedy `\S+` deleted prose the reader reads:
 *   • SCHEME — `http(s)://` or a `www.` host, and nothing else. GFM autolinks no other scheme, so
 *     `file:///Users/x/should-we-merge.md` stays prose and `hedge-words` still sees it.
 *   • LEFT BOUNDARY — start of the run or whitespace / `*_~(`. `a@b://c` is not an autolink.
 *   • RIGHT EDGE — `[^\s<]*` (GFM stops at `<`), then {@link trimAutolinkTail} walks the trailing
 *     punctuation back off, so `Merged https://x.test/pr/864.` keeps its full stop as prose.
 *
 * The left boundary is a capture rather than a lookbehind so the pattern needs no lookbehind
 * support at all; {@link autolinkRuns} adds the prefix's length back to get the real start.
 */
const AUTOLINK_RE = /(^|[\s*_~(])((?:https?:\/\/|www\.)[^\s<]*)/g;

/** GFM's trailing-punctuation rule for autolinks. */
const AUTOLINK_TAIL_RE = /[?!.,:;*_~'"]+$/;

/**
 * Every run of plain prose in `text`, in document order, with source offsets.
 *
 * Returns `[]` for a parse that yields nothing usable rather than throwing — this runs on
 * model-authored markdown, and the linter's whole posture is that it must never be able to lose a
 * reply (plan §6, mirroring `services/concierge.ts`: "nothing here throws to callers").
 */
export function proseSpans(text: string, opts: ProseSpanOptions = {}): ProseSpan[] {
  const excludeBlockquote = opts.excludeBlockquote === true;
  const out: ProseSpan[] = [];
  let tree: MdastNode;
  try {
    tree = fromMarkdown(text) as unknown as MdastNode;
  } catch {
    return out;
  }
  const walk = (node: MdastNode): void => {
    if (NEVER_PROSE.has(node.type)) return;
    if (excludeBlockquote && node.type === "blockquote") return;
    if (node.type === "text" && typeof node.value === "string") {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      // A node with no offsets cannot be located in the source, and a check that reported a
      // position it invented would be worse than one that stayed quiet.
      if (start === undefined || end === undefined) return;
      pushTextSpans(out, node.value, start, end);
      return;
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(tree);
  return out;
}

/**
 * Emit one text node as spans, dropping any bare URL runs inside it.
 *
 * A node with NO url emits exactly one span, identical to the node — the common case pays nothing.
 *
 * A node whose parsed `value` is shorter than its source (a markdown escape, an entity) is emitted
 * WHOLE and unsplit: every offset inside it would be a guess, and splitting on guessed offsets
 * would hand callers spans that do not slice their own source back out. That leaves a URL in prose
 * in the rare escape-plus-URL node, which is a false positive rather than a corrupted offset — the
 * right way round.
 */
function pushTextSpans(out: ProseSpan[], value: string, start: number, end: number): void {
  if (end - start !== value.length) {
    out.push({ value, start, end });
    return;
  }
  const push = (from: number, to: number): void => {
    if (to > from) out.push({ value: value.slice(from, to), start: start + from, end: start + to });
  };
  let cursor = 0;
  for (const run of autolinkRuns(value)) {
    push(cursor, run.start);
    cursor = run.end;
  }
  push(cursor, value.length);
}

/** Where each GFM autolink literal starts and ends within `value`, in order. */
function autolinkRuns(value: string): { start: number; end: number }[] {
  const runs: { start: number; end: number }[] = [];
  const re = new RegExp(AUTOLINK_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(value)) !== null) {
    const start = m.index + (m[1] ?? "").length;
    const url = trimAutolinkTail(m[2] ?? "");
    if (url.length === 0) continue;
    runs.push({ start, end: start + url.length });
  }
  return runs;
}

/** Strip the punctuation GFM does not consider part of an autolink: a trailing run of
 *  `?!.,:;*_~'"`, and a trailing `)` that has no `(` to match it. Applied repeatedly, because
 *  `…(a)).` needs both rules more than once. */
function trimAutolinkTail(url: string): string {
  let out = url;
  for (;;) {
    const trimmed = out.replace(AUTOLINK_TAIL_RE, "");
    if (trimmed !== out) {
      out = trimmed;
      continue;
    }
    if (out.endsWith(")") && count(out, ")") > count(out, "(")) {
      out = out.slice(0, -1);
      continue;
    }
    return out;
  }
}

function count(s: string, ch: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s[i] === ch) n++;
  return n;
}

/**
 * The source offset of `indexInValue` within `span`, or `null` when it cannot be known.
 *
 * A markdown escape (`\*`) or an entity (`&amp;`) makes the parsed `value` SHORTER than the source
 * it came from, so `span.start + index` silently points at the wrong character — which for an
 * autofix means splicing over the wrong bytes. Rather than approximate, this returns `null` when
 * the span is not offset-aligned, and callers decline to rewrite (a warn is still correct; a
 * corrupted reply never is). Alignment holds for the overwhelming majority of real spans, so this
 * costs almost nothing and removes a whole class of silent corruption.
 */
export function sourceOffsetOf(span: ProseSpan, indexInValue: number): number | null {
  if (indexInValue < 0 || indexInValue > span.value.length) return null;
  if (span.end - span.start !== span.value.length) return null;
  return span.start + indexInValue;
}

/** The prose of `text` as one string, runs joined by a single space so a pattern cannot match
 *  across a boundary that a reader sees as separate blocks. Convenience for checks that want the
 *  whole prose corpus and not its positions. */
export function proseText(text: string, opts: ProseSpanOptions = {}): string {
  return proseSpans(text, opts)
    .map((s) => s.value)
    .join(" ");
}
