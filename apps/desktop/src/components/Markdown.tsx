// Reusable GitHub-flavored-markdown renderer for chat bubbles (Claude Code / Chief /
// expert-voice replies). Assistant text arrives as markdown; rendering it as raw
// pre-wrapped text mangled lists, code, and tables — so this component owns a compact,
// theme-styled GFM render. Styling lives in inline `components={{...}}` overrides (no
// global CSS) so the component is self-contained and the DOM stays lean.
import {
  Children,
  createContext,
  memo,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type CSSProperties,
  type ReactNode,
} from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { FiCheck, FiCopy } from "react-icons/fi";
import { openUrl } from "@tauri-apps/plugin-opener";
import { copyToClipboard } from "../clipboard";
import { C } from "../theme/colors";
import { FONT_MONO, FONT_UI } from "../theme/scale";
import { TERM_BODY_BASE_SIZE, TERM_BODY_FONT } from "./terminalChrome";
import { MD_CODE_FACE, MD_CODE_FACE_VAR } from "./mdCodeFace";
import { parseAgentRefHref } from "./Concierge/agentRefs";
import { AgentPill } from "./Concierge/AgentPill";
import { parseBeadRefHref } from "./Concierge/beadRefs";
import { parseResearchRefHref } from "./Concierge/researchRefs";
import { ResearchPill } from "./Concierge/ResearchPill";
import { remarkBeadRefs } from "./Concierge/remarkBeadRefs";
import { remarkPrRefs } from "./Concierge/remarkPrRefs";
import { PrPill } from "./Concierge/PrPill";
import { parsePrRefHref } from "./Concierge/prRefs";
import { remarkMergeQuotes } from "./Concierge/remarkMergeQuotes";
import { LEADING_QUOTE_ATTR, remarkLeadingQuote } from "./Concierge/remarkLeadingQuote";
import { BeadPill } from "./Concierge/BeadPill";

/**
 * THE FACE CODE SPANS WEAR — the custom property this component's ROOT publishes, not a literal.
 *
 * A hardcoded `FONT_MONO` here survives `face="terminal"`, and that is not a cosmetic leftover: the
 * root's face reaches ordinary prose by INHERITANCE, but every `code` element re-declares its own
 * family, so a terminal-faced surface would render its paragraphs in the terminal's mono and its
 * code — the thing an agent writes most of — in a DIFFERENT one. Same defect as the `FONT_UI` root
 * this `face` prop exists to fix, hiding for the same reason: both faces are monospace.
 *
 * A custom property rather than threading `face` into `components`: the map is hoisted so
 * ReactMarkdown receives a STABLE reference across renders (see `REMARK_PLUGINS`' note on why that
 * matters), and rebuilding it per face would defeat exactly that. The var is inherited, so one
 * declaration on the root reaches every monospace descendant at any depth — including `BeadPill`,
 * which this file renders inline and which therefore reads the same constant. See `mdCodeFace.ts`.
 */
const MONO = MD_CODE_FACE;

/** The testid the code block's own copy control answers to. */
export const CODE_COPY_TESTID = "markdown-copy-code";

/**
 * A fenced code block, with its own copy control.
 *
 * WHY IT EXISTS: a `<pre>` is the single worst thing in the transcript to select by hand. It is its
 * own horizontal scroller (`overflowX: auto`, below), so a drag that strays sideways SCROLLS the
 * block instead of extending the highlight — and the reader is left having to start again. It is
 * also the content most likely to be wanted whole and verbatim, where a partial selection is not
 * merely inconvenient but wrong: half a command runs.
 *
 * So the common case stops needing a drag at all. The button copies the block's own text via the
 * DOM (`textContent` of the `<pre>`), not a re-serialisation of the markdown AST — what the reader
 * sees is exactly what lands on the clipboard, including the block's own line breaks.
 *
 * IT MUST NOT JOIN THE SELECTION. `user-select: none` and `aria-hidden` keep the control out of a
 * drag that sweeps across the block on its way somewhere else — without them, every copied
 * multi-message selection would carry a stray glyph per code block. Reachability for keyboard and
 * screen-reader users is not lost by that: the whole-answer button above copies the same fence as
 * part of the answer's markdown source, which is the path those users already have.
 */
function CodeBlock({ children }: { children?: ReactNode }) {
  const preRef = useRef<HTMLPreElement | null>(null);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
    };
  }, []);
  return (
    <div style={{ position: "relative", margin: "0 0 8px" }}>
      <pre
        ref={preRef}
        style={{
          margin: 0,
          padding: "10px 12px",
          background: C.deepForest,
          border: `1px solid ${HAIRLINE}`,
          borderRadius: 6,
          overflowX: "auto",
          maxWidth: "100%",
        }}
      >
        {children}
      </pre>
      <button
        type="button"
        data-testid={CODE_COPY_TESTID}
        data-copied={copied ? "true" : "false"}
        aria-hidden
        tabIndex={-1}
        title={copied ? "Copied" : "Copy code"}
        onClick={() => {
          const text = preRef.current?.textContent ?? "";
          if (!text) return;
          void copyToClipboard(text).then((ok) => {
            // Never claim a copy that did not happen.
            if (!ok || !alive.current) return;
            setCopied(true);
            if (timer.current !== null) clearTimeout(timer.current);
            timer.current = setTimeout(() => {
              timer.current = null;
              if (alive.current) setCopied(false);
            }, 1200);
          });
        }}
        style={{
          position: "absolute",
          top: 6,
          right: 6,
          display: "inline-flex",
          alignItems: "center",
          background: C.deepForest,
          border: `1px solid ${HAIRLINE}`,
          borderRadius: 4,
          padding: 3,
          lineHeight: 0,
          cursor: "pointer",
          color: copied ? C.teal : C.muted,
          // Out of the selection, always — see this component's header.
          userSelect: "none",
          WebkitUserSelect: "none",
        }}
      >
        {copied ? <FiCheck size={12} /> : <FiCopy size={12} />}
      </button>
    </div>
  );
}

// Hoisted so ReactMarkdown receives a STABLE plugin-array reference across renders (a fresh
// `[remarkGfm]` literal each render defeats react-markdown's own memoization of the parse).
//
// ORDER IS LOAD-BEARING: `remarkBeadRefs` runs AFTER `remarkGfm` so that GFM's autolink literals
// are already `link` nodes when the bead linkifier walks the tree, and their text is therefore
// protected by the same in-a-link guard as a hand-written link's. See remarkBeadRefs' header.
//
const REMARK_PLUGINS = [remarkGfm, remarkBeadRefs, remarkPrRefs];

// ── THE QUOTE MERGE IS OPT-IN, AND THAT IS A REAL BOUNDARY, NOT CAUTION ─────────────────────────
//
// `remarkMergeQuotes` folds ADJACENT blockquote siblings into one so the concierge's
// one-quote-per-line spelling draws a single bar (sparkle-3hd6b). But `> a\n\n> b` is also how a
// writer spells TWO deliberately separate quotations in ordinary CommonMark, and the two are
// indistinguishable at the tree — so the merge is a judgement about the AUTHOR, not a fact about
// the markup.
//
// That judgement is only safe for the concierge, whose quoting is generated by a standing
// guideline. This renderer is shared: `MountedAgentThread` shows raw agent/Claude Code output and
// `SupportModal` shows authored help content, and folding two excerpts from different files into
// one quotation there would make the DOM claim one quotation where the author wrote two — the same
// semantic lie the plugin's own header cites as the reason to prefer a tree pass over CSS.
//
// So it is passed explicitly by `ConciergeMessageRow` and nowhere else. Hoisted as its own module
// constant for the same reason as the array above: a fresh literal per render defeats
// react-markdown's memoization of the parse.
//
// `remarkMergeQuotes` is order-INDEPENDENT of the other two — it moves whole `blockquote` blocks
// and never looks inside them, while the linkifiers only ever rewrite inline `text`. It is placed
// last so the merge runs on the final block structure, which is the reading that stays correct if a
// future plugin ever introduces or splits a quote.
const REMARK_PLUGINS_MERGED_QUOTES = [remarkGfm, remarkBeadRefs, remarkPrRefs, remarkMergeQuotes];

// ── …AND THE TWO THAT ALSO MARK THE OPENING QUOTE ──────────────────────────────────────────────
//
// `remarkLeadingQuote` stamps the document's first blockquote so `Blockquote` can offer the jump on
// THAT one and on no other (see its header, and ./Concierge/replyQuoteCoverage for what the jump is
// standing in for). Added only when a caller actually supplies a jump target, so every other surface
// parses through exactly the arrays it did before.
//
// AFTER `remarkMergeQuotes` in the merged variant, which is the one ordering constraint in this
// pipeline that is not free: the merge folds the reply's opening run of quotes into one node, so
// marking first would stamp a node that is about to absorb its siblings.
//
// Four constants rather than a computed array, for the reason the two above give: a fresh literal
// per render defeats react-markdown's memoisation of the parse, which in a streaming column is the
// difference between one parse per token and two.
const REMARK_PLUGINS_LEADING_QUOTE = [remarkGfm, remarkBeadRefs, remarkPrRefs, remarkLeadingQuote];
const REMARK_PLUGINS_MERGED_QUOTES_LEADING = [
  remarkGfm,
  remarkBeadRefs,
  remarkPrRefs,
  remarkMergeQuotes,
  remarkLeadingQuote,
];

/** What the opening quote jumps to, when it has been asked to stand in for a reply-anchor stub.
 *
 *  A CONTEXT and not a prop threaded through `components`, because `components` is a module-level
 *  constant — hoisted precisely so react-markdown's memoisation holds — and rebuilding it per render
 *  to close over a handler would re-parse every bubble on every tick. The consumer is one component,
 *  the provider is one component, and nothing in between has to know. */
interface QuoteJump {
  /** The `you` message id to scroll to. Never empty — {@link Markdown} withholds the whole context
   *  when there is nothing to jump to, so `Blockquote` never has to re-check it. */
  id: string;
  /** The accessible name, already phrased by the caller. Kept out of this file for the same reason
   *  `RoutingReceipt.receiptText` and `lintCheckSentence` live away from their components: the
   *  wording is a correctness concern that deserves a unit test, not a JSX detail. */
  label: string;
  onJump: (id: string) => void;
}
const QuoteJumpContext = createContext<QuoteJump | null>(null);

/** The testid on an opening quote that has become the jump control. Absent on every other quote,
 *  which is what makes "only the opening one is clickable" assertable rather than assumed. */
export const QUOTE_JUMP_TESTID = "quote-jump";

/**
 * react-markdown sanitizes every href BEFORE our `components.a` override ever sees it, blanking any
 * scheme outside its own allowlist. That is a security control and it stays on for everything —
 * this adds ONE narrow exception, for the agent references the concierge emits.
 *
 * WHY IT IS SAFE TO WIDEN HERE, specifically:
 *   • The exception is gated on `parseAgentRefHref`, which accepts only `sparkle-agent:` followed
 *     by a conservative id class (alphanumeric, `-`, `_`, bounded length). No path, no quotes, no
 *     second scheme, nothing that survives to become a URL.
 *   • A surviving reference is never rendered as an anchor. `ExternalLink` intercepts it and
 *     returns a `<button>` (or inert text); no `href` is ever placed in the DOM for it, so there is
 *     nothing for a webview, a middle-click or a screen reader to navigate to.
 *   • Everything else — `javascript:`, `file:`, `vscode:`, and any scheme added tomorrow — still
 *     goes through `defaultUrlTransform` untouched.
 *
 * The tests in Concierge/AgentPill.test.tsx pin both halves: the pill resolves, and the dangerous
 * schemes stay inert. Do not replace this with `urlTransform={(u) => u}`, which is the "simpler"
 * version of this line and disables the sanitizer for every link in the app.
 *
 * `sparkle-bead:` is the SECOND exception, on identical terms and for the same reason — it is gated
 * on `parseBeadRefHref`'s conservative id class, and `ExternalLink` returns a `<button>` for it so
 * no `href` ever reaches the DOM. It has to be here even though most bead references are synthesized
 * by `remarkBeadRefs` rather than written: `urlTransform` runs on every link the renderer sees,
 * whatever produced it, so without this line the linkifier's own output would be blanked.
 */
function urlTransform(url: string): string {
  if (parseAgentRefHref(url) !== null) return url;
  if (parseBeadRefHref(url) !== null) return url;
  // `sparkle-research:` is the THIRD exception, on identical terms: gated on `parseResearchRefHref`'s
  // conservative id class, and `ExternalLink` returns a `<button>` (or inert text) for it so no
  // `href` ever reaches the DOM. Without this line the sanitizer would blank the reference before
  // `ExternalLink` ever saw it.
  if (parseResearchRefHref(url) !== null) return url;
  // `sparkle-pr:` is the FOURTH exception, on identical terms: gated on `parsePrRefHref`'s
  // conservative number/slug classes, and `ExternalLink` returns a `<button>` (or inert text) for it
  // so no `href` ever reaches the DOM. It has to be here even though MOST pr references are
  // synthesized by `remarkPrRefs` rather than written — `urlTransform` runs on every link the
  // renderer sees, whatever produced it, so without this line the linkifier's own output would be
  // blanked and every PR number in the thread would go back to being prose.
  if (parsePrRefHref(url) !== null) return url;
  return defaultUrlTransform(url);
}

// Subtle tint for inline code / blockquote / table chrome, derived from the accent so it
// reads on both the dark and light themed surfaces without a second themed token.
const SUBTLE = "rgba(52, 224, 240, 0.10)";
const HAIRLINE = "rgba(138, 160, 196, 0.30)"; // muted, low-alpha — borders/rules

const prose: CSSProperties = {
  fontFamily: FONT_UI,
  fontSize: 13,
  lineHeight: 1.55,
  color: C.cream,
  // Long unbroken tokens (URLs, hashes) must wrap instead of widening the bubble.
  overflowWrap: "anywhere",
  wordBreak: "break-word",
};

const heading = (size: number, top: number): CSSProperties => ({
  // INHERITED, so a heading follows whatever face the root set (see the `face` prop). Identical to
  // the old hardcoded `FONT_UI` for every default caller, because the root's own `prose` sets exactly
  // that — but it means a terminal-faced block does not sprout sans-serif headings mid-render.
  fontFamily: "inherit",
  fontWeight: 600,
  fontSize: size,
  lineHeight: 1.3,
  color: C.cream,
  margin: `${top}px 0 6px`,
});

// Scheme allowlists for attacker-influenced markdown (assistant / tool output is untrusted).
// react-markdown strips `javascript:` but NOT `file:`, `vscode:`, `smb:`, or other custom OS URI
// handlers — so a `[x](vscode://…)` / `[x](file:///…)` link would otherwise hand `openUrl` an
// arbitrary protocol and invoke a native handler. Only http(s) and mailto reach the opener; a
// disallowed href renders as inert (non-navigating) text. Trim + case-insensitive so leading
// whitespace / mixed case (` VSCODE:`) can't slip past.
export const SAFE_LINK_SCHEME_RE = /^(https?|mailto):/i;
// Images are fetched on render, so a remote `<img src>` is an outbound request / IP-leak beacon.
// Constrain to `https:` (no plaintext http, no scheme-relative) and inline `data:` (no network).
export const SAFE_IMG_SCHEME_RE = /^(https|data):/i;

export function isSafeLinkHref(href: string | undefined): href is string {
  return typeof href === "string" && SAFE_LINK_SCHEME_RE.test(href.trim());
}
export function isSafeImgSrc(src: string | undefined): src is string {
  return typeof src === "string" && SAFE_IMG_SCHEME_RE.test(src.trim());
}

// Open links externally (Tauri shell) rather than navigating the webview; keep the href +
// target on the anchor so it degrades gracefully and stays inspectable/testable. Only an
// allowlisted scheme opens — a disallowed one is inert (no href, click does nothing).
/**
 * A link's visible text, flattened to a string — INCLUDING text nested inside elements.
 *
 * Used as the fallback name on an agent pill whose id no longer resolves. This used to keep only
 * direct string children, on the reasoning that a non-plain link text (`[**@Kraken Auth**](…)`) was
 * "a case the model does not produce" — which is an assumption about an LLM's formatting, and the
 * two files this feature is built on reject exactly that reasoning ("an instruction to a language
 * model is a request, not a schema", which is why `stripMentionSigil` exists at all). Emphasis
 * inside a link is ordinary markdown a model emits unprompted (roborev 54894).
 *
 * The consequence was not cosmetic: the fallback became `""`, so an unresolvable
 * `[**@Kraken Auth**](sparkle-agent:…)` rendered as a bare `@` mid-sentence — "Ask @ about it." —
 * defeating the whole degradation contract, which is that the reader still sees the name and the
 * sentence still reads.
 */
function linkText(children: ReactNode): string {
  const out: string[] = [];
  const walk = (node: ReactNode): void => {
    Children.forEach(node, (c) => {
      if (typeof c === "string" || typeof c === "number") {
        out.push(String(c));
        return;
      }
      // A rendered element: recurse into its children. Guarded structurally rather than by
      // `isValidElement` alone so a props-less node cannot throw on an untrusted tree.
      const kids = (c as { props?: { children?: ReactNode } } | null)?.props?.children;
      if (kids !== undefined) walk(kids);
    });
  };
  walk(children);
  return out.join("");
}

/** Marks a subtree that is its OWN interactive UI rather than part of the surrounding prose.
 *
 *  A pill is not just a `<button>` — it renders an expandable card (`BeadPill` → `ConciergeBeadCard`,
 *  `AgentPill` → its notice) as an IN-TREE SIBLING inside the same wrapper, with no portal and no
 *  `stopPropagation`. So the card's body, padding and status labels are plain `<div>`s that a
 *  `closest("a,button,…")` walk goes straight past. Inside the leading quote that means an opened
 *  card is a large click target that scrolls the reader away mid-read — the same defect the control
 *  guard was written to remove, on more surface. Marking the whole subtree is what makes the guard
 *  about the UI rather than about the one node that happens to be interactive.
 *
 *  `display: contents` so this participates in no layout: the pills' own boxes are unchanged. */
const NESTED_UI_ATTR = "data-nested-ui";
function NestedUi({ children }: { children?: ReactNode }) {
  return (
    <span {...{ [NESTED_UI_ATTR]: "yes" }} style={{ display: "contents" }}>
      {children}
    </span>
  );
}

function ExternalLink({ href, children }: { href?: string; children?: ReactNode }) {
  // An agent reference is not a link at all — it is a pill. Checked BEFORE the scheme allowlist
  // because `sparkle-agent:` is deliberately not on it: if this component is ever rendered outside
  // a provider (SupportModal, an agent's own reply), the reference falls through to the inert-text
  // path below and reads as `@Name`, which is exactly the intended degradation.
  const agentId = parseAgentRefHref(href);
  if (agentId !== null) {
    return <NestedUi><AgentPill agentId={agentId} fallbackName={linkText(children)} /></NestedUi>;
  }
  // A bead reference is not a link either. Checked BEFORE the scheme allowlist for the same reason:
  // `sparkle-bead:` is deliberately not on it, so outside a provider (SupportModal, an agent's own
  // reply) the reference falls through to the inert-text path below and reads as the bare id —
  // which is exactly the intended degradation, since the id is what the pill would have shown.
  //
  // NO `fallbackName` COUNTERPART. `AgentPill` needs the written label because an agent's readable
  // handle is its NAME; a bead's readable handle is the id itself, which is already in the href. See
  // BeadPill's docstring for why the label is discarded rather than preferred.
  const beadId = parseBeadRefHref(href);
  if (beadId !== null) {
    return <NestedUi><BeadPill beadId={beadId} /></NestedUi>;
  }
  // A research reference is not a link either. Checked BEFORE the scheme allowlist for the same
  // reason: `sparkle-research:` is deliberately not on it, so outside the app (an agent's own reply,
  // a support modal) it falls through to the inert-text path below and reads as the written question
  // — which is exactly the intended degradation, since that is the label the pill would have shown.
  // `linkText` (not the bare href) supplies the fallback so a non-plain link text still flattens.
  const researchTaskId = parseResearchRefHref(href);
  if (researchTaskId !== null) {
    return <NestedUi><ResearchPill taskId={researchTaskId} fallbackLabel={linkText(children)} /></NestedUi>;
  }
  // A pull-request reference is not a link either — it is a chiclet. Checked BEFORE the scheme
  // allowlist for the same reason as the three above: `sparkle-pr:` is deliberately not on it, so
  // outside the app (an agent's own reply, a support modal) it falls through to the inert-text path
  // below and reads as `#2164` — exactly the label the pill would have shown.
  //
  // NO `fallbackName` COUNTERPART, for `BeadPill`'s reason rather than `AgentPill`'s: a pull
  // request's readable handle is its NUMBER, which is already in the href. The written label is
  // discarded so a model that wrote `[the retry work](sparkle-pr:2164)` still draws `#2164` — the
  // pill must never be able to say something the href does not.
  const prRef = parsePrRefHref(href);
  if (prRef !== null) {
    return <NestedUi><PrPill number={prRef.number} slug={prRef.slug} /></NestedUi>;
  }
  const safe = isSafeLinkHref(href);
  return (
    <a
      // Drop the href entirely for a disallowed scheme so the webview can't navigate to it even
      // via keyboard / middle-click; the text still renders, just inert.
      href={safe ? href : undefined}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => {
        // Always suppress the default navigation; only an allowlisted href reaches the opener.
        e.preventDefault();
        if (safe) void openUrl(href).catch(() => {});
      }}
      style={{ color: C.accentInk, textDecoration: "underline" }}
    >
      {children}
    </a>
  );
}

// react-markdown v9 wraps fenced blocks in <pre><code class="language-x">; inline code is a
// bare <code>. Distinguish on the language- class so blocks get the scrollable slab and
// inline spans get the subtle pill.
/** The quote's own chrome, shared by the inert and the clickable form so a jumpable opening quote is
 *  the same object plus an affordance — not a differently-styled one. Every declaration here is
 *  unchanged from before the jump existed; the founder approved this surface twice. */
const quoteStyle: CSSProperties = {
  margin: "0 0 8px",
  padding: "2px 12px",
  // ── IT MUST NOT SLIDE UNDER A FLOAT (founder screenshot, 2026-08-12) ──────────────────
  //
  // He sent a picture of a concierge answer whose COPY GLYPH was painted on top of this blue
  // rule, with the quoted text starting straight after it. It reads as a rendering collision
  // and it is one, from a CSS rule that catches everybody once: **a float shortens the LINE
  // BOXES beside it, never a following BLOCK's box.** `ConciergeMessageRow` floats the copy
  // glyph left; a `<blockquote>` is a block, so its border box — and therefore this rule —
  // was laid at the container's left edge UNDERNEATH the glyph, while its inline text was
  // pushed clear. The two never disagreed about anything except which of them the rule
  // belonged under.
  //
  // `flow-root` makes this a block formatting context, and a BFC's border box may not overlap
  // a float in the same context — so the whole quote, rule included, is placed to the RIGHT
  // of the glyph. One declaration, no arithmetic, and nothing content-conditional: it is
  // correct for a quote that leads an answer (the reported case) and inert for one that does
  // not, because a block that clears the float vertically has nothing to avoid.
  //
  // WHAT THIS DELIBERATELY DOES NOT DO is move the GLYPH into the quote's indent, i.e. the
  // literal left-to-right order "rule, icon, text". That would revoke the founder's own
  // 2026-07…08-05 placement decision — *"For the content that the concierge sends I would
  // rather have it be at the beginning of the row"* — for quote-leading answers only, so the
  // glyph would jump position depending on what the answer happened to open with. This keeps
  // the glyph at the row's leading edge and gives the rule, the icon and the text each their
  // own space, which is the outcome he asked for. Easy to invert if he wants the other order.
  //
  // NOT `overflow: hidden`, which is the older way to get a BFC: it would clip a wide table
  // or a fenced code block quoted inside, and those own their horizontal scroll.
  // `quote-surface-probe.mjs` measures the two boxes in Chrome, in both themes.
  display: "flow-root",
  // THE ACCENT, not chrome. This was `HAIRLINE` — the same gray as an `<hr>` — and the
  // founder asked for "a SOLID vertical line … the same blue as the 'Hold ⌘ to talk' line".
  // `C.tealInk` IS that line's colour (components/LogoWaveform paints the push-to-talk
  // affordance with it) and resolves to `BLUEPRINT.{light,dark}.primary`, blueprintSpec's
  // "one accent" — so this is the same blue by construction in both themes rather than by
  // eye. A literal hex here would read in one theme and vanish in the other.
  // Stroke width and the muted body ink are unchanged; he approved both.
  borderLeft: `3px solid ${C.tealInk}`,
  color: C.muted,
};

/**
 * A blockquote — and, when it is the reply's OPENING one and a caller has offered a jump target, the
 * control that scrolls back to the message being quoted.
 *
 * ══ WHY THE BAR ITSELF, AND NOT A SEPARATE BUTTON ══════════════════════════════════════════════
 * The founder's ask (2026-08-17, bead sparkle-y3ptuf) was that his question appear ONCE, as this
 * blue bar. The gray `ReplyAnchorStubs` line that used to sit above it carried the jump, so removing
 * the duplicate would have quietly removed the affordance with it — the classic shape of a fix that
 * relocates a defect rather than ending it. Adding a second control beside the bar would put a third
 * thing on a row he has just asked to have less on. So the bar absorbs the job it displaced.
 *
 * ══ ROLE, NOT A `<button>` ═════════════════════════════════════════════════════════════════════
 * A real `<button>` cannot legally contain the `<p>` (or list, or fence) a blockquote holds, and
 * wrapping one around this would either invalidate the tree or force the quote's content to inline
 * elements the parser does not produce. `role="button"` + `tabIndex` + a keyboard handler is the
 * sanctioned equivalent for a block-level control, and it keeps the `<blockquote>` element — which
 * is what makes the DOM still SAY "quotation" to a screen reader walking the document (the same
 * semantic-honesty argument `remarkMergeQuotes` makes for merging nodes rather than hiding borders).
 *
 * ══ A DRAG IS NOT A CLICK, AND HERE THAT IS LOAD-BEARING ═══════════════════════════════════════
 * This column has a selection feature aimed squarely at concierge prose: highlight some of it and
 * `QuoteChiclet` offers to carry it into the composer. A quote is a natural thing to highlight, and
 * a plain `onClick` fires on the mouseup that ENDS such a drag — so quoting the bar's words would
 * scroll the reader away from the reply they were answering, having destroyed the selection to do
 * it. The guard reads the live Selection and stands down while one is open. It is deliberately not
 * `mousedown`-based bookkeeping: the DOM already knows, and a second source of truth about the
 * selection is the thing `useQuoteOnSelection` snapshots precisely because it is easy to get wrong.
 */
function Blockquote({
  children,
  ...rest
}: ComponentPropsWithoutRef<"blockquote"> & {
  /** react-markdown hands the mdast/hast node down alongside the element's own props. It must never
   *  reach the DOM, so it is named here to be dropped rather than spread. */
  node?: unknown;
}) {
  const jump = useContext(QuoteJumpContext);
  const ref = useRef<HTMLQuoteElement>(null);
  // `remarkLeadingQuote` stamps ONLY the document's first block. Every other quote in the reply —
  // the concierge quoting agent scrollback, a file, itself — arrives here without it and stays inert,
  // which is the whole reason the mark is a tree pass rather than "is a jump available".
  //
  // Read through a cast because `data-*` attributes are not on React's element prop type: the
  // attribute is put there by `remarkLeadingQuote` via mdast `hProperties` and arrives as an ordinary
  // string prop at runtime. The constant is shared with that module so the two cannot drift.
  const leading = (rest as Record<string, unknown>)[LEADING_QUOTE_ATTR] === "yes";
  if (!leading || jump === null) {
    return (
      <blockquote {...{ [LEADING_QUOTE_ATTR]: leading ? "yes" : undefined }} style={quoteStyle}>
        {children}
      </blockquote>
    );
  }
  // A GESTURE THAT BEGAN IN THE QUOTE'S OWN UI IS NOT A GESTURE ON THE QUOTE. The quoted line is
  // rendered by the same pipeline as any other markdown, so it can contain a `remarkBeadRefs`
  // BeadPill, an AgentPill, a ResearchPill or a plain link — and the founder's messages routinely
  // carry `sparkle-xxxx` ids and URLs, so this is the common case rather than a corner. None of them
  // stops propagation.
  //
  // `[data-nested-ui]` is why this asks about the SUBTREE and not just the node clicked. A pill's
  // expanded card is an in-tree sibling of its `<button>`, so its body and padding are plain `<div>`s
  // that a control-only walk goes straight past — leaving an opened card as a large target that
  // scrolls the reader away mid-read. See {@link NestedUi}.
  //
  // The selection check cannot stand in for any of this: an ordinary click on a child leaves the
  // selection collapsed.
  const FOREIGN = `[${NESTED_UI_ATTR}],a,button,[role='button'],input,select,textarea`;
  /** Did this gesture start on the bar itself rather than in something the bar merely contains?
   *  ONE rule, asked by both the click and the keyboard path — a second wording of it is a seam the
   *  two drift apart along, and only one of them would have carried a test. */
  const isOwnGesture = (from?: EventTarget | null): boolean => {
    const el = from instanceof Element ? from : null;
    return el === null || el.closest(FOREIGN) === ref.current;
  };
  const go = (from?: EventTarget | null) => {
    if (!isOwnGesture(from)) return;
    // See the header: the mouseup that ends a highlight is also a click.
    const sel = typeof window !== "undefined" ? window.getSelection?.() : null;
    if (sel && !sel.isCollapsed && sel.toString().trim().length > 0) return;
    jump.onJump(jump.id);
  };
  return (
    <blockquote
      {...{ [LEADING_QUOTE_ATTR]: "yes" }}
      ref={ref}
      data-testid={QUOTE_JUMP_TESTID}
      data-anchor-id={jump.id}
      role="button"
      tabIndex={0}
      aria-label={jump.label}
      title={jump.label}
      onClick={(e) => go(e.target)}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        // Asked BEFORE preventDefault, and via the same predicate `go` uses: a keypress meant for a
        // control inside the quote must keep its own default behaviour, so this cannot be left to
        // `go` bailing after the fact.
        if (!isOwnGesture(e.target)) return;
        // Space scrolls the thread by default, which is the one gesture this control must not
        // double as — the reader would land somewhere they did not ask for AND lose their place.
        e.preventDefault();
        go(e.target);
      }}
      style={{ ...quoteStyle, cursor: "pointer" }}
    >
      {children}
    </blockquote>
  );
}

const components: Components = {
  p: ({ children }) => <p style={{ margin: "0 0 8px" }}>{children}</p>,
  h1: ({ children }) => <h1 style={heading(19, 12)}>{children}</h1>,
  h2: ({ children }) => <h2 style={heading(17, 12)}>{children}</h2>,
  h3: ({ children }) => <h3 style={heading(15, 10)}>{children}</h3>,
  h4: ({ children }) => <h4 style={heading(14, 10)}>{children}</h4>,
  strong: ({ children }) => <strong style={{ fontWeight: 600 }}>{children}</strong>,
  em: ({ children }) => <em style={{ fontStyle: "italic" }}>{children}</em>,
  a: ExternalLink,
  ul: ({ children }) => (
    <ul style={{ margin: "0 0 8px", paddingLeft: 20 }}>{children}</ul>
  ),
  ol: ({ children }) => (
    <ol style={{ margin: "0 0 8px", paddingLeft: 20 }}>{children}</ol>
  ),
  li: ({ children }) => <li style={{ margin: "2px 0" }}>{children}</li>,
  blockquote: Blockquote,
  hr: () => <hr style={{ border: "none", borderTop: `1px solid ${HAIRLINE}`, margin: "12px 0" }} />,
  code: ({ className, children }) => {
    const isBlock = /language-/.test(className || "");
    if (isBlock) {
      // Inside our <pre> slab; the slab owns the background + scroll.
      return (
        <code style={{ fontFamily: MONO, fontSize: 12, color: C.cream, background: "transparent" }}>
          {children}
        </code>
      );
    }
    return (
      <code
        style={{
          fontFamily: MONO,
          fontSize: 12,
          background: SUBTLE,
          padding: "1px 5px",
          borderRadius: 4,
        }}
      >
        {children}
      </code>
    );
  },
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  table: ({ children }) => (
    <div style={{ overflowX: "auto", maxWidth: "100%", margin: "0 0 8px" }}>
      <table style={{ borderCollapse: "collapse", fontSize: 13 }}>{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th
      style={{
        border: `1px solid ${HAIRLINE}`,
        padding: "4px 8px",
        textAlign: "left",
        fontWeight: 600,
        background: SUBTLE,
      }}
    >
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td style={{ border: `1px solid ${HAIRLINE}`, padding: "4px 8px" }}>{children}</td>
  ),
  img: ({ src, alt }) => {
    // Untrusted markdown: a remote image renders an outbound request (IP-leak beacon). Only allow
    // https + inline data: URIs; anything else (http, scheme-relative, custom) degrades to alt text.
    const safeSrc = isSafeImgSrc(typeof src === "string" ? src : undefined);
    if (!safeSrc) return <span style={{ color: C.muted }}>{alt || ""}</span>;
    // `draggable={false}`: an image is natively `-webkit-user-drag: element`, so a press on one
    // begins a native image drag rather than a text selection — inside a transcript people drag
    // across to copy, that silently costs them the gesture.
    return (
      <img
        src={src as string}
        alt={alt}
        draggable={false}
        style={{ maxWidth: "100%", height: "auto", borderRadius: 6 }}
      />
    );
  },
};

/** Render `text` as compact, theme-styled GitHub-flavored markdown for a chat bubble.
 *  Memoized: ReactMarkdown re-parses the whole string on every render, so in a streaming chat the
 *  unchanged bubbles would re-parse their full text on every token. All props are primitives, so
 *  the default shallow-equal memo skips the re-parse whenever none has changed.
 *
 *  `mergeQuotes` folds adjacent blockquotes into one bar and is OPT-IN — see
 *  `REMARK_PLUGINS_MERGED_QUOTES` for why only the concierge may ask for it.
 *
 *  ══ `face` — AND WHY THIS PROP HAD TO EXIST ═════════════════════════════════════════════════════
 *  `prose` hardcodes `FONT_UI` on the ROOT, which every paragraph and list item then inherits. That
 *  makes this component the last word on typeface no matter what its container says — and it is why
 *  the founder asked three times for the mounted concierge thread to read as the terminal and saw it
 *  fail each time. Three separate changes correctly set `TERM_BODY_FONT` on the thread's scroll
 *  container; all three were silently overridden HERE, two layers below where anyone was looking, and
 *  the guarding test asserted the container (where everything was right) rather than the rendered
 *  prose. See MountedAgentThread's header.
 *
 *  So the face is a PROP rather than something a parent can set by cascade: a caller that needs the
 *  terminal's face asks for it explicitly and gets it, and the default stays exactly as it was.
 *
 *  IT REACHES CODE TOO. Fenced and inline code keep their slab treatment — their own background,
 *  size and border — but NOT their own typeface: the root publishes `--md-code-face` and the code
 *  renderers read it, so a terminal-faced surface is monospace in ONE face rather than two. Leaving
 *  them on `FONT_MONO` would have reproduced this bug one level down, in the content an agent emits
 *  most; see `MD_CODE_FACE_VAR`. */
export const Markdown = memo(function Markdown({
  text,
  mergeQuotes = false,
  face = "ui",
  quoteJumpId,
  quoteJumpLabel,
  onQuoteJump,
}: {
  text: string;
  mergeQuotes?: boolean;
  /** `"terminal"` renders the prose in xterm's own face/size, for surfaces that must read as the
   *  terminal (the mounted concierge thread). Defaults to the UI face — unchanged for every other
   *  caller. */
  face?: "ui" | "terminal";
  /** ══ THE OPENING QUOTE BECOMES A JUMP ═══════════════════════════════════════════════════════
   *
   *  THREE PRIMITIVE PROPS, NOT ONE OBJECT, and that is the memo talking rather than taste. This
   *  component is `memo`'d on a shallow compare because ReactMarkdown re-parses the entire string on
   *  every render — in a streaming column an object literal here would differ on every tick and
   *  re-parse every settled bubble in the transcript. `ConciergeThread` already stabilises its
   *  `onJump` with `useCallback(…, [])` for exactly this reason (see its "Handlers, STABILISED"
   *  block), so all three compare equal between ticks and the memo holds.
   *
   *  ALL THREE OR NONE. The jump is offered only when there is somewhere to go AND something to
   *  call; a partial set renders the inert quote, which is also what a reply whose anchor did not
   *  survive restore gets (`replyQuoteCoverage.quoteJumpTarget` returns nothing there). Undefined on
   *  every surface but the concierge reply — `MountedAgentThread` and `SupportModal` never pass it,
   *  so their quotes are exactly as inert as before. */
  quoteJumpId?: string;
  /** The accessible name AND the hover title, phrased by the caller — see `QuoteJump.label`. */
  quoteJumpLabel?: string;
  onQuoteJump?: (id: string) => void;
}) {
  // ONE declaration site for both channels: the family every text node inherits, and the family the
  // code renderers read out of `--md-code-face`. They move together by construction, so a future
  // face cannot arrive with its prose converted and its code left behind — which is the shape of
  // this bug, twice over now.
  const rootStyle = (
    face === "terminal"
      ? {
          ...prose,
          fontFamily: TERM_BODY_FONT,
          fontSize: TERM_BODY_BASE_SIZE,
          [MD_CODE_FACE_VAR]: TERM_BODY_FONT,
        }
      : { ...prose, [MD_CODE_FACE_VAR]: FONT_MONO }
  ) as CSSProperties;
  // Memoised so the PROVIDER's value is referentially stable across ticks. A fresh object here would
  // re-render every `Blockquote` in a settled bubble on every delta of a streaming sibling — cheap
  // individually, transcript-wide on a column that re-renders several times a second.
  const jump = useMemo<QuoteJump | null>(
    () =>
      quoteJumpId && onQuoteJump ? { id: quoteJumpId, label: quoteJumpLabel ?? "", onJump: onQuoteJump } : null,
    [quoteJumpId, quoteJumpLabel, onQuoteJump],
  );
  const body = (
    // `data-md-face` names the decision in the DOM so a surface's face is assertable and greppable.
    // Without it the only way to test "this prose renders in the terminal's face" is to walk to the
    // root div by position — which is how the previous guard ended up asserting a container instead.
    <div data-md-face={face} style={rootStyle}>
      <ReactMarkdown
        remarkPlugins={
          jump === null
            ? mergeQuotes
              ? REMARK_PLUGINS_MERGED_QUOTES
              : REMARK_PLUGINS
            : mergeQuotes
              ? REMARK_PLUGINS_MERGED_QUOTES_LEADING
              : REMARK_PLUGINS_LEADING_QUOTE
        }
        components={components}
        urlTransform={urlTransform}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
  // No provider when nothing is offered, so the default `null` reaches `Blockquote` on every other
  // surface and the extra element never enters those trees at all.
  return jump === null ? body : <QuoteJumpContext.Provider value={jump}>{body}</QuoteJumpContext.Provider>;
});
