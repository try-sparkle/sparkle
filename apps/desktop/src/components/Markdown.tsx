// Reusable GitHub-flavored-markdown renderer for chat bubbles (Claude Code / Chief /
// expert-voice replies). Assistant text arrives as markdown; rendering it as raw
// pre-wrapped text mangled lists, code, and tables — so this component owns a compact,
// theme-styled GFM render. Styling lives in inline `components={{...}}` overrides (no
// global CSS) so the component is self-contained and the DOM stays lean.
import {
  Children,
  memo,
  useEffect,
  useRef,
  useState,
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
import { parseAgentRefHref } from "./Concierge/agentRefs";
import { AgentPill } from "./Concierge/AgentPill";

const MONO = FONT_MONO;

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
const REMARK_PLUGINS = [remarkGfm];

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
 */
function urlTransform(url: string): string {
  return parseAgentRefHref(url) !== null ? url : defaultUrlTransform(url);
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
  fontFamily: FONT_UI,
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

function ExternalLink({ href, children }: { href?: string; children?: ReactNode }) {
  // An agent reference is not a link at all — it is a pill. Checked BEFORE the scheme allowlist
  // because `sparkle-agent:` is deliberately not on it: if this component is ever rendered outside
  // a provider (SupportModal, an agent's own reply), the reference falls through to the inert-text
  // path below and reads as `@Name`, which is exactly the intended degradation.
  const agentId = parseAgentRefHref(href);
  if (agentId !== null) {
    return <AgentPill agentId={agentId} fallbackName={linkText(children)} />;
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
  blockquote: ({ children }) => (
    <blockquote
      style={{
        margin: "0 0 8px",
        padding: "2px 12px",
        borderLeft: `3px solid ${HAIRLINE}`,
        color: C.muted,
      }}
    >
      {children}
    </blockquote>
  ),
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
 *  unchanged bubbles would re-parse their full text on every token. `text` is the only prop, so a
 *  shallow-equal memo skips the re-parse whenever the text hasn't changed. */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div style={prose}>
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        components={components}
        urlTransform={urlTransform}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
