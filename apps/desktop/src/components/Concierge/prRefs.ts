// A PULL REQUEST referenced in concierge text, as a link the renderer turns into a pill. The pure
// half: no React, no stores, no Tauri.
//
// ══ THE FOURTH SIBLING OF `agentRefs.ts` / `beadRefs.ts` / `researchRefs.ts` ════════════════════
// Read `agentRefs.ts`'s header first. Everything it says about why a reference is a MARKDOWN LINK
// rather than a bespoke delimiter, why the id lives behind a conservative trust boundary, and why
// the clipboard flattener parses rather than pattern-matches, applies here unchanged. This module
// mirrors it so a reader who has understood one has understood all four — one shape, four kinds of
// referent (an AGENT, a unit of WORK, a background RESEARCH task, and now a PULL REQUEST).
//
// ══ WHY IT EXISTS ══════════════════════════════════════════════════════════════════════════════
// The founder's complaint is recorded verbatim in `actionReceiptLine.ts`'s header: "You said it's
// up. But I can't actually click on it." That module's rule 3 already says NAME THE SUBJECT AS A
// PILL WHENEVER THERE IS AN ID — and it held for agents and beads while `Merged PR #2164.` went out
// through `plain()`, the explicitly NON-clickable slot. A PR number was the one handle the concierge
// wrote that the reader could not open.
//
// ══ THE REFERENCE IS BOTH WRITTEN AND FOUND, WHICH IS NEW ══════════════════════════════════════
// An agent reference is written; a bead reference is found. A PR reference is BOTH, and the two
// paths know different amounts, which is why the href below has two forms rather than one:
//
//   • QUALIFIED — `sparkle-pr:drodio/sparkle#2164`. What the APP writes, when it knows exactly which
//     repository it acted on. `mergePrTool` returns the very url it merged, so a merge receipt can
//     name the repo instead of inferring it. There is no ambiguity on this path and no lookup.
//   • UNQUALIFIED — `sparkle-pr:2164`. What the LINKIFIER emits (`remarkPrRefs`) when it recovers a
//     bare `#2164` from prose. Parse-time code cannot know which repository the writer meant — it
//     runs inside a `memo`ized renderer keyed on the text alone, and the answer is a fact about the
//     reader's selected project, not about the text. So it declines to guess and `PrPill` resolves
//     it live, exactly as `BeadPill` decides existence live rather than at parse time.
//
// ══ OVER-MATCHING IS *NOT* CHEAP HERE — THE OPPOSITE OF `beadRefs` ═════════════════════════════
// `beadRefs`' prose pattern is deliberately loose because a false candidate costs a `Map.get` that
// misses and renders as the prose it always was. That reasoning does NOT transfer. A PR reference
// resolves against a repository rather than against a board, so a false candidate does not fall back
// to prose — it becomes a live link to a DIFFERENT, REAL page (GitHub happily serves `/pull/3` for
// almost any repo). "step #3 of the plan" turning into a button that opens someone's pull request is
// worse than a missed link, so `findPrRefs` is tuned the other way: two digits minimum, unless the
// words `PR` or `pull request` are sitting right there to say what the number is.

import { fromMarkdown } from "mdast-util-from-markdown";

/** The shape `stripPrRefs` walks. Structural rather than mdast's full union, for the reason
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

/** The scheme that marks a link as a pull-request reference. A constant, not a literal scattered
 *  across the parser, the linkifier and the renderer — those three must agree exactly. */
export const PR_REF_SCHEME = "sparkle-pr:";

/** A resolved reference. `slug` is `owner/repo` when the WRITER knew it, and null when the reference
 *  was recovered from prose — see the header: null means "ask the reader's project", never "guess". */
export interface PrRef {
  number: number;
  slug: string | null;
}

/**
 * What a PR number is allowed to look like — the PARSER's trust boundary.
 *
 * Positive, no leading zero, and bounded at six digits. The bound is not tidiness: the value is
 * interpolated into a URL handed to the OS browser, and an unbounded run of digits is an unbounded
 * string from an untrusted source. Six digits is an order of magnitude beyond any repository this
 * app will ever open (`drodio/sparkle` is in the low thousands), and a number that fails degrades to
 * plain text — the reader loses a click, never the number.
 */
const PR_NUMBER_RE = /^[1-9][0-9]{0,5}$/;

/** One segment of `owner/repo`. GitHub's own class, minus anything that could matter to a consumer
 *  this module cannot see: no slashes, no whitespace, no quotes, no scheme characters. */
const SLUG_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

/**
 * `owner/repo`, or null for anything that is not exactly that.
 *
 * `..` is refused outright for the reason `beadRefs.BEAD_ID_RE` gives: the value reaches a URL and
 * could reach a `gh --repo` argument tomorrow, and no real slug contains it. A leading `.` on either
 * segment is refused for the same reason — an id that can be read as a relative path is a liability
 * whether or not today's call sites take it there.
 */
function normalizeSlug(raw: string): string | null {
  if (raw.includes("..")) return null;
  const parts = raw.split("/");
  if (parts.length !== 2) return null;
  const [owner, repo] = parts;
  if (!owner || !repo) return null;
  if (!SLUG_SEGMENT_RE.test(owner) || !SLUG_SEGMENT_RE.test(repo)) return null;
  if (owner.startsWith(".") || repo.startsWith(".")) return null;
  return `${owner}/${repo}`;
}

/**
 * The reference in `href`, or null when it is not a well-formed one.
 *
 * Null means "not ours" and "ours but malformed" alike, for the reason `parseAgentRefHref` gives:
 * both must fall through to the ordinary link path, and a caller that could tell them apart would be
 * tempted to render the second as a visible error in the middle of a sentence.
 */
export function parsePrRefHref(href: string | undefined): PrRef | null {
  if (typeof href !== "string") return null;
  // Trim before the scheme test for the same reason `isSafeLinkHref` does: markdown can carry
  // leading whitespace into an href, and ` sparkle-pr:x` is the same link to a reader.
  const trimmed = href.trim();
  if (!trimmed.toLowerCase().startsWith(PR_REF_SCHEME)) return null;
  const rest = trimmed.slice(PR_REF_SCHEME.length);
  const hash = rest.indexOf("#");
  if (hash === -1) {
    return PR_NUMBER_RE.test(rest) ? { number: Number(rest), slug: null } : null;
  }
  const slug = normalizeSlug(rest.slice(0, hash));
  const digits = rest.slice(hash + 1);
  if (slug === null || !PR_NUMBER_RE.test(digits)) return null;
  return { number: Number(digits), slug };
}

/** The href for a reference — the one place the scheme, the slug and the number are joined.
 *  Exported so the tests, the linkifier and the line composer cannot spell it differently.
 *
 *  An unusable slug degrades to the UNQUALIFIED form rather than to no reference at all: the number
 *  is still worth a pill, it just has to be resolved against the reader's project. */
export function prRefHref(ref: { number: number; slug?: string | null }): string {
  const slug = ref.slug ? normalizeSlug(ref.slug) : null;
  return slug === null
    ? `${PR_REF_SCHEME}${ref.number}`
    : `${PR_REF_SCHEME}${slug}#${ref.number}`;
}

/** What a reference READS AS — the label a pill draws and the words a flattener leaves behind. One
 *  spelling, so the thread, the clipboard and the live region cannot disagree about it. */
export function prRefLabel(number: number): string {
  return `#${number}`;
}

/** The pull-request page for a slug and a number. The ONE place the GitHub web URL is composed. */
export function prWebUrl(slug: string, number: number): string {
  return `https://github.com/${slug}/pull/${number}`;
}

/**
 * `owner/repo` for a GitHub pull-request URL, or null for anything else.
 *
 * The inverse of {@link prWebUrl}, and the reason the app-written path can be QUALIFIED at all:
 * `mergePrTool` reports the url it merged, so the receipt recovers the repository from the tool's
 * own answer instead of inferring it from whichever project happens to be selected when the line is
 * eventually read.
 *
 * IT PARSES WITH `URL`, NOT WITH A PREFIX TEST. `https://github.com.evil.example/o/r/pull/1` starts
 * with `https://github.com` and is a different host; only a real parse gets that right.
 */
export function slugFromPrUrl(url: string | null | undefined): string | null {
  if (typeof url !== "string") return null;
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  if (parsed.host.toLowerCase() !== "github.com") return null;
  const [owner, repo, kind, digits] = parsed.pathname.split("/").filter((p) => p !== "");
  if (kind !== "pull" || owner === undefined || repo === undefined) return null;
  if (digits === undefined || !PR_NUMBER_RE.test(digits)) return null;
  return normalizeSlug(`${owner}/${repo}`);
}

/** One PR number found in prose, with the half-open span it occupies. The span covers the `#2164`
 *  token ONLY — never a leading "PR", which stays the prose it is so the sentence still reads. */
export interface PrRefSpan {
  number: number;
  start: number;
  /** Exclusive. */
  end: number;
}

/** `#` followed by digits. Seven are captured so an eight-digit run is REJECTED whole rather than
 *  silently truncated to a plausible six-digit PR that exists. */
const CANDIDATE_RE = /#([0-9]{1,7})/g;

/** The words that license a ONE-DIGIT number. Anchored to the end of the text before the `#`, so it
 *  is the immediately preceding token that must say "pull request" — not one somewhere in the line. */
const PR_WORD_BEFORE_RE = /(?:\bpr|\bpull\s+request)\s*$/i;

/** Characters that make a match a FRAGMENT of a longer token rather than a token of its own. */
const TOKEN_CHAR_RE = /[A-Za-z0-9_]/;

/**
 * Every PR-number token in `text`, in document order, with its span.
 *
 * ══ THE TWO-DIGIT FLOOR IS THE WHOLE DESIGN ════════════════════════════════════════════════════
 * See this module's header for why over-matching costs more here than it does for beads. `#1`, `#3`,
 * `#5` are how English numbers a list ("step #3", "my #1 priority"), and every one of them is also a
 * real pull request in every repository on GitHub — so a loose pattern does not degrade to prose, it
 * degrades to a button that opens the wrong page. Two digits is the cheapest rule that keeps ordinary
 * prose out, and `PR #7` is the escape hatch for the rare one-digit reference that is genuinely one.
 *
 * The boundary tests are done in CODE rather than with lookbehind/lookahead, for the reason
 * `findBeadIds` gives: the app renders in a WebKit webview and the tests run in Node, and a boundary
 * expressed as two character tests behaves identically in both and can be read without holding a
 * regex engine in your head.
 */
export function findPrRefs(text: string): PrRefSpan[] {
  const out: PrRefSpan[] = [];
  // A fresh regex per call: the module-level literal carries `lastIndex` between calls, and this is
  // invoked once per text node in a document.
  const re = new RegExp(CANDIDATE_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const digits = m[1];
    if (digits === undefined) continue;
    const start = m.index;
    const end = start + m[0].length;
    if (!PR_NUMBER_RE.test(digits)) continue;

    // ── THE CLOSING SIDE ──────────────────────────────────────────────────────────────────────
    // A trailing word character means this is part of a longer token (`#12ab34`, a hex colour). A
    // dot is ambiguous exactly as it is for bead ids: `#2164.` ends a sentence, `#12.5` is a
    // decimal — so it disqualifies only when a DIGIT continues the number.
    const after = text[end];
    if (after !== undefined) {
      if (TOKEN_CHAR_RE.test(after)) continue;
      const afterDot = text[end + 1];
      if (after === "." && afterDot !== undefined && /[0-9]/.test(afterDot)) continue;
    }

    // ── THE OPENING SIDE, AND THE ONE-DIGIT LICENCE ───────────────────────────────────────────
    // Both questions read the same preceding text, so they are asked together. `PR#7` is why the
    // licence also WAIVES the opening boundary: `R` is a word character, and refusing on it would
    // reject the very spelling the words were meant to admit.
    const before = text.slice(0, start);
    const licensed = PR_WORD_BEFORE_RE.test(before);
    if (digits.length < 2 && !licensed) continue;
    const prev = start > 0 ? text[start - 1] : undefined;
    if (prev !== undefined && TOKEN_CHAR_RE.test(prev) && !licensed) continue;

    out.push({ number: Number(digits), start, end });
  }
  return out;
}

/**
 * Flatten PR references to the words a reader sees, for consumers that are not the renderer.
 *
 * THE CLIPBOARD IS THE CALLER, and this is `agentRefs.ts`'s "third consumer" tax paid a fourth time —
 * knowingly, exactly as that module's header says it must be. `CopyAnswerButton` copies the markdown
 * SOURCE so a table stays a grid on paste; the source of a line naming a PR contains
 * `[#2164](sparkle-pr:drodio/sparkle#2164)`, and pasting a dead link into a PR or a Slack thread is
 * not what "copy this answer" means.
 *
 * The AUTO-LINKIFIED numbers need no stripping and get none: they are never in the source at all —
 * the linkifier runs on the parsed tree, so `m.text` still holds the bare `#2164` it always held.
 *
 * IT PARSES, IT DOES NOT PATTERN-MATCH, for every reason `stripAgentRefs`/`stripBeadRefs` give — a
 * hand-rolled `/\[…\]\(…\)/g` disagreed with remark in both directions (over-stripping inside code
 * spans, under-stripping the CommonMark title and angle-bracketed forms). Reading the destination
 * from the same grammar the thread renders through makes all of those follow from one decision.
 */
export function stripPrRefs(text: string): string {
  const edits: { start: number; end: number; label: string }[] = [];
  visitLinks(fromMarkdown(text), (node) => {
    const ref = parsePrRefHref(node.url);
    if (ref === null) return;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    // A node without offsets cannot be spliced safely; leaving it literal is the same outcome as a
    // malformed reference, which the renderer also declines to turn into a pill.
    if (start === undefined || end === undefined) return;
    // The VISIBLE words, falling back to the canonical label. A pill draws `#2164` rather than the
    // written label (see `PrPill`), so the label is what the reader saw whenever the author wrote
    // something else — but an author who wrote `[the retry PR](sparkle-pr:…)` gets their own words
    // back, which is what the equivalent bead path does with a title.
    const label = nodeText(node).trim();
    edits.push({ start, end, label: label === "" ? prRefLabel(ref.number) : label });
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
