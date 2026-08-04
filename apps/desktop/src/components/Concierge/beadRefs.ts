// A BEAD referenced in concierge text, as a link the renderer turns into a pill. The pure half:
// no React, no stores, no Tauri.
//
// ══ THE SIBLING OF `agentRefs.ts`, AND THE ONE PLACE IT DIVERGES ════════════════════════════════
// Read that module's header first. Everything it says about why a reference is a MARKDOWN LINK
// rather than a bespoke delimiter, and why the destination is read from the same grammar the thread
// renders through, applies here unchanged. This module mirrors it deliberately: one shape, two
// kinds of referent, so a reader who has understood one has understood both.
//
// The divergence is where the reference COMES FROM, and it is the whole reason this feature exists.
//
//   • An AGENT reference is WRITTEN. The persona is instructed to emit `[@Name](sparkle-agent:<id>)`
//     and `conciergeLine.ts` composes the app-authored ones. Text that does not contain the scheme
//     contains no agent pill, by construction.
//   • A BEAD reference is FOUND. The concierge has been writing bare ids into prose for months —
//     "settled and recorded on sparkle-17hm1 so no agent re-litigates it" — under a standing
//     communication guideline that made it cite the bead whenever it assigns work. Every one of
//     those is dead text, and all of them are already in the thread's history. A feature that only
//     linkified ids the model wrapped in a link would fire on none of them.
//
// So the ids are recovered from the TEXT (see `remarkBeadRefs.ts`, which uses `findBeadIds` below)
// and converted into the same `link` nodes an explicit reference would have produced. From that
// point on the two systems are identical — one renderer branch, one clipboard flattener, one pill
// vocabulary — which is what keeps this from being a second linkifier bolted onto the first.
//
// ══ SYNTAX IS DECIDED HERE; EXISTENCE IS DECIDED LIVE ═══════════════════════════════════════════
// The bead asks that an id which does not exist NOT be linkified, "since a link that opens nothing
// is worse than plain text". That test is deliberately NOT made in this module, and the reason is
// the bead's fourth requirement rather than convenience.
//
// This module runs at PARSE time, inside a `memo`ized renderer keyed on the text alone. Anything it
// decides is frozen for as long as that text is on screen. Existence is not a property of the text;
// it is a property of the board five seconds from now. A bead filed after the message was rendered
// would stay dead text forever, and — worse in the other direction — the check would have to be fed
// a roster, which is exactly the prop that would defeat the memo (`AgentPill.tsx`'s header).
//
// So this module answers "could this be an id?" and `BeadPill` answers "is it one, right now?" —
// re-asked on every render against the live store. An unresolved candidate renders as ORDINARY
// TEXT, so the bead's requirement is met at the only place it can be met honestly: in the output.
//
// The consequence to keep in mind when reading `findBeadIds`: over-matching is CHEAP (a candidate
// that resolves to nothing is the plain prose it always was) and under-matching is EXPENSIVE (a
// real id stays dead). The pattern is tuned in that direction on purpose.

import { fromMarkdown } from "mdast-util-from-markdown";

/** The shape `stripBeadRefs` walks. Structural rather than mdast's full union, for the reason
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

/** The scheme that marks a link as a bead reference. A constant, not a literal scattered across the
 *  parser, the linkifier and the renderer — those three must agree exactly. */
export const BEAD_REF_SCHEME = "sparkle-bead:";

/**
 * What a bead id is allowed to look like — the PARSER's trust boundary.
 *
 * ══ THIS IS NOT `AGENT_ID_RE`, AND THE DIFFERENCE IS LOAD-BEARING ═══════════════════════════════
 * `agentRefs.AGENT_ID_RE` is `/^[A-Za-z0-9_-]{1,128}$/`, which REJECTS a dot — correctly, for
 * uuid-shaped agent ids. Bead ids are not uuid-shaped and a child bead's id carries one:
 * `sparkle-hiju.4` and `bd-a3f8.2` are both real. Reusing the agent class verbatim would have made
 * every child bead permanently unlinkable, which is the bug this comment exists to prevent someone
 * from reintroducing in the name of sharing a constant.
 *
 * The dot is admitted; everything a dot could be ABUSED for is not:
 *
 *   • `..` is refused outright. This id is handed to a store lookup today, but `services/beads.ts`
 *     also exposes `beadShow(projectPath, id)`, which reaches a `bd show <id>` shell-out. An id from
 *     model-authored text that can climb a path is a liability whether or not today's call sites
 *     take it there, and the refusal costs nothing: no real bead id contains `..`.
 *   • A LEADING `.` or `-` is refused, so an id can never be read as a relative path or as an
 *     option flag by a consumer this module cannot see.
 *   • Whitespace, quotes, slashes, angle brackets and every other scheme character are outside the
 *     class, as they are for agents.
 *
 * Bounded length for the same reason as agents: an unbounded id is an unbounded string from an
 * untrusted source. Refusing is SAFE here in exactly the way it is there — a rejected id yields a
 * null, the pill is never constructed, and the reader sees the plain text. Nothing is lost but a
 * click.
 */
const BEAD_ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

/** True when `id` is a well-formed bead id. Exported so the WRITER's boundary in `conciergeLine.ts`
 *  can be the same test as the parser's rather than a second spelling of it. */
export function isWellFormedBeadId(id: string): boolean {
  return BEAD_ID_RE.test(id) && !id.includes("..");
}

/**
 * The bead id in `href`, or null when it is not a well-formed bead reference.
 *
 * Null means "not ours" and "ours but malformed" alike, for the reason `parseAgentRefHref` gives:
 * both must fall through to the ordinary link path, and a caller that could tell them apart would
 * be tempted to render the second as a visible error in the middle of a sentence.
 */
export function parseBeadRefHref(href: string | undefined): string | null {
  if (typeof href !== "string") return null;
  // Trim before the scheme test for the same reason `isSafeLinkHref` does: markdown can carry
  // leading whitespace into an href, and ` sparkle-bead:x` is the same link to a reader.
  const trimmed = href.trim();
  if (!trimmed.toLowerCase().startsWith(BEAD_REF_SCHEME)) return null;
  const id = trimmed.slice(BEAD_REF_SCHEME.length);
  return isWellFormedBeadId(id) ? id : null;
}

/** The href for a bead id — the one place the scheme and the id are joined. Exported so the tests,
 *  the linkifier and anything that ever composes a reference cannot spell it differently. */
export function beadRefHref(beadId: string): string {
  return `${BEAD_REF_SCHEME}${beadId}`;
}

/**
 * The shape of a bead id as it appears in PROSE — `<prefix>-<suffix>`, optionally `.<n>` for a
 * child. `sparkle-76h9`, `sparkle-1sp7r`, `sparkle-vyghy`, `sparkle-17hm1` and `sparkle-hiju.4` are
 * all real, and the suffix length VARIES, which rules out any fixed-width match.
 *
 * DELIBERATELY LOOSE, per this module's header: a false candidate costs a `Map.get` that misses and
 * renders as the prose it already was, while a missed real id is a dead reference the reader cannot
 * click. So the pattern buys recall and lets the live store buy precision.
 *
 * It IS lowercase-only, which is not a stylistic choice — every bead id `bd` mints is lowercase, and
 * the restriction is what stops ordinary hyphenated Title Case ("Claude-Code", "React-DOM") from
 * becoming a candidate at all. Ordinary lowercase hyphenated English ("auto-heal", "one-shot") still
 * matches, and is meant to: filtering it here would need a dictionary, and filtering it live needs
 * a `Map.get`.
 */
const BEAD_ID_IN_PROSE_RE = /[a-z][a-z0-9_]{1,30}-[a-z0-9]{3,16}(?:\.[0-9]{1,3})*/g;

/** Characters that make a match a FRAGMENT of a longer token rather than a token of its own. */
const ID_ADJACENT_RE = /[A-Za-z0-9_.-]/;

/** The same question on the CLOSING side, where a `.` is ambiguous and must not be treated as the
 *  opening side treats it.
 *
 *  A DOT AFTER AN ID IS USUALLY A FULL STOP. "settled and recorded on sparkle-17hm1." is the
 *  founder's own example, and an earlier version of this rejected the match outright because `.` was
 *  simply in the adjacency set — which killed the single most common shape a bead id appears in.
 *  The tests caught it; the reasoning that produced it was "a remaining dot always means this is
 *  part of something else", which is true only when something FOLLOWS the dot.
 *
 *  So the dot is disqualifying only when what comes after it continues the token — `sparkle-t6wje.md`
 *  is a filename, `sparkle-17hm1.` is a sentence. (A legitimate child suffix like `.4` never reaches
 *  here: the pattern's own `(?:\.[0-9]{1,3})*` tail has already consumed it.) */
function closesToken(text: string, end: number): boolean {
  const after = text[end];
  if (after === undefined) return false;
  if (after !== ".") return ID_ADJACENT_RE.test(after);
  const afterDot = text[end + 1];
  return afterDot !== undefined && /[A-Za-z0-9_]/.test(afterDot);
}

/** One id found in prose, with the half-open span it occupies. */
export interface BeadIdSpan {
  id: string;
  start: number;
  /** Exclusive. */
  end: number;
}

/**
 * Every bead-id-shaped token in `text`, in document order, with its span.
 *
 * The boundary test is done in CODE rather than with lookbehind/lookahead in the pattern. That is a
 * portability choice with a correctness benefit: the app renders in a WebKit webview and the tests
 * run in Node, and a boundary expressed as two character tests behaves identically in both and can
 * be read without holding a regex engine in your head.
 *
 * `concierge-bead-pills` is the case that motivates the CLOSING test: the pattern happily matches
 * `concierge-bead` inside it, and only the "next character is `-`" check rejects it. Without that,
 * every multi-hyphen word in the thread would become a candidate whose id is a truncation of itself.
 */
export function findBeadIds(text: string): BeadIdSpan[] {
  const out: BeadIdSpan[] = [];
  // A fresh regex per call: the module-level literal carries `lastIndex` between calls, and this is
  // invoked once per text node in a document.
  const re = new RegExp(BEAD_ID_IN_PROSE_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    const before = start > 0 ? text[start - 1] : undefined;
    if (before !== undefined && ID_ADJACENT_RE.test(before)) continue;
    if (closesToken(text, end)) continue;
    out.push({ id: m[0], start, end });
  }
  return out;
}

/**
 * Flatten bead references to the words a reader sees, for consumers that are not the renderer.
 *
 * THE CLIPBOARD IS THE CALLER, and this is `agentRefs.ts`'s "third consumer" tax paid a second
 * time — knowingly, exactly as that module's header says it must be. `CopyAnswerButton` copies the
 * markdown SOURCE so that a table stays a grid on paste; the source of an answer that references a
 * bead explicitly contains `[sparkle-17hm1](sparkle-bead:sparkle-17hm1)`, and pasting a dead link
 * into a PR or a Slack thread is not what "copy this answer" means. The rendered pill reads
 * `sparkle-17hm1` and the selection path already yields `sparkle-17hm1`; this makes the source path
 * agree with the other two.
 *
 * The AUTO-LINKIFIED ids need no stripping and get none: they are never in the source at all — the
 * linkifier runs on the parsed tree, so `m.text` still holds the bare id it always held. That is a
 * property worth stating, because it is the reason this function looks under-exercised. It exists
 * for the EXPLICIT form, which is reachable two ways: `conciergeLine.bead(...)` composes it, and
 * model-authored text can contain it verbatim (`Markdown.tsx` renders a `sparkle-bead:` link as a
 * pill by design, so the source can carry one whether or not we asked for it).
 *
 * IT PARSES, IT DOES NOT PATTERN-MATCH, for every reason `stripAgentRefs` gives — a hand-rolled
 * `/\[([^\]]*)\]\(([^)]*)\)/g` disagreed with remark in BOTH directions (roborev 55092): it rewrote
 * references inside code spans that render as literal syntax, and it failed to strip the
 * CommonMark title (`(sparkle-bead:x "…")`) and angle-bracketed (`(<sparkle-bead:x>)`) forms that
 * remark unwraps into real pills. Reading the destination from the same grammar the thread renders
 * through makes all of those follow from one decision instead of from remembered special cases.
 */
export function stripBeadRefs(text: string): string {
  const edits: { start: number; end: number; label: string }[] = [];
  visitLinks(fromMarkdown(text), (node) => {
    const id = parseBeadRefHref(node.url);
    if (id === null) return;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    // A node without offsets cannot be spliced safely; leaving it literal is the same outcome as a
    // malformed reference, which the renderer also declines to turn into a pill.
    if (start === undefined || end === undefined) return;
    // The VISIBLE words, falling back to the id. A pill draws the id rather than the label (see
    // `BeadPill`), so the id is what the reader saw whenever the label was something else — but an
    // author who wrote `[the retry bead](sparkle-bead:…)` gets their own words back, which is what
    // the equivalent agent path does with a name.
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
