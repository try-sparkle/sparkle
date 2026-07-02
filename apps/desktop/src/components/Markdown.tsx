// Reusable GitHub-flavored-markdown renderer for chat bubbles (Claude Code / Chief /
// expert-voice replies). Assistant text arrives as markdown; rendering it as raw
// pre-wrapped text mangled lists, code, and tables — so this component owns a compact,
// theme-styled GFM render. Styling lives in inline `components={{...}}` overrides (no
// global CSS) so the component is self-contained and the DOM stays lean.
import { memo, type CSSProperties, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { openUrl } from "@tauri-apps/plugin-opener";
import { C, FONT } from "../theme/colors";

const MONO = '"IBM Plex Mono", monospace';

// Hoisted so ReactMarkdown receives a STABLE plugin-array reference across renders (a fresh
// `[remarkGfm]` literal each render defeats react-markdown's own memoization of the parse).
const REMARK_PLUGINS = [remarkGfm];

// Subtle tint for inline code / blockquote / table chrome, derived from the accent so it
// reads on both the dark and light themed surfaces without a second themed token.
const SUBTLE = "rgba(52, 224, 240, 0.10)";
const HAIRLINE = "rgba(138, 160, 196, 0.30)"; // muted, low-alpha — borders/rules

const prose: CSSProperties = {
  fontFamily: FONT.ui,
  fontSize: 14,
  lineHeight: 1.55,
  color: C.cream,
  // Long unbroken tokens (URLs, hashes) must wrap instead of widening the bubble.
  overflowWrap: "anywhere",
  wordBreak: "break-word",
};

const heading = (size: number, top: number): CSSProperties => ({
  fontFamily: FONT.ui,
  fontWeight: 600,
  fontSize: size,
  lineHeight: 1.3,
  color: C.cream,
  margin: `${top}px 0 6px`,
});

// Open links externally (Tauri shell) rather than navigating the webview; keep the href +
// target on the anchor so it degrades gracefully and stays inspectable/testable.
function ExternalLink({ href, children }: { href?: string; children?: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => {
        if (!href) return;
        e.preventDefault();
        void openUrl(href).catch(() => {});
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
        <code style={{ fontFamily: MONO, fontSize: 12.5, color: C.cream, background: "transparent" }}>
          {children}
        </code>
      );
    }
    return (
      <code
        style={{
          fontFamily: MONO,
          fontSize: 12.5,
          background: SUBTLE,
          padding: "1px 5px",
          borderRadius: 4,
        }}
      >
        {children}
      </code>
    );
  },
  pre: ({ children }) => (
    <pre
      style={{
        margin: "0 0 8px",
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
  ),
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
  img: ({ src, alt }) => (
    <img src={src} alt={alt} style={{ maxWidth: "100%", height: "auto", borderRadius: 6 }} />
  ),
};

/** Render `text` as compact, theme-styled GitHub-flavored markdown for a chat bubble.
 *  Memoized: ReactMarkdown re-parses the whole string on every render, so in a streaming chat the
 *  unchanged bubbles would re-parse their full text on every token. `text` is the only prop, so a
 *  shallow-equal memo skips the re-parse whenever the text hasn't changed. */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div style={prose}>
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
