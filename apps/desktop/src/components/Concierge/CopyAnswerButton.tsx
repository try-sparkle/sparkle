// The copy affordance under a concierge ANSWER (PRD 1 §2) — bottom-left, on the message's own left
// text edge, so it reads as belonging to the paragraph above it rather than floating in the column.
//
// IT COPIES THE MARKDOWN SOURCE, not the rendered text, and that is the whole point of it existing
// alongside copy-on-selection. The brain answers in GitHub-flavored markdown, so an answer's value
// is often in its STRUCTURE: a table is a grid, a code block is a fenced block. Copying the rendered
// `innerText` flattens both — the table becomes a run of cells with no columns and the code loses
// its fence — and what the user wanted was the thing they could paste back into a doc or an editor.
// The selection path copies plain text for the opposite reason: a partial selection has no markdown
// source (see useCopyOnSelection's header).
//
// ALWAYS RENDERED, never hover-mounted. Two reasons, one visual and one mechanical:
//   • An affordance you have to hover to discover is an affordance most people never find.
//   • The thread AUTO-FOLLOWS on a content key (ConciergeThread), and a footer that appears on
//     hover changes the message's height mid-stream — nudging the scroll position under a reader
//     who is doing nothing but moving the mouse. Reserving the height costs one row and cannot.
// So hover/focus change OPACITY only. Nothing about the layout moves.
import { useEffect, useRef, useState } from "react";
import { FiCheck, FiCopy } from "react-icons/fi";
import { C } from "../../theme/colors";
import { copyToClipboard } from "../../clipboard";
import { stripAgentRefs } from "./agentRefs";
import { COPY_TOAST_MS } from "./useCopyOnSelection";

/** Resting opacity — present, findable, and quiet enough not to compete with the answer. */
const RESTING_OPACITY = 0.45;

export function CopyAnswerButton({
  text,
  onCopied,
}: {
  /** The RAW markdown source of the answer (`m.text`), not its rendered form. */
  text: string;
  /** Copied. Announced by the integration layer through the column's ONE live region — this
   *  component adds no `aria-live` node of its own (see ConciergeColumnProps.announcement). */
  onCopied?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  // Hover and keyboard focus are tracked separately on purpose: they can be true at the same time,
  // and folding them into one flag makes a blur turn the button dim while the pointer is still on it.
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);

  // Unmount-safe: the thread is CAPPED (stores/conciergeThreadStore evicts the oldest bubbles), so a
  // message really can disappear inside the confirmation window.
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
    };
  }, []);

  const lit = hover || focus || copied;

  return (
    <div style={{ display: "flex", marginTop: 2 }}>
      <button
        type="button"
        data-testid="concierge-copy-answer"
        data-copied={copied ? "true" : "false"}
        // The label states WHAT is copied. "Copy" alone, repeated once per answer down a thread, is
        // a screen-reader list of identical buttons.
        aria-label={copied ? "Answer copied" : "Copy answer"}
        title={copied ? "Copied" : "Copy answer"}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onFocus={() => setFocus(true)}
        onBlur={() => setFocus(false)}
        onClick={() => {
          // AGENT REFERENCES ARE FLATTENED FIRST, and this is the one place that can be relied on
          // to do it — here rather than at the call sites, so a third `<CopyAnswerButton …>` cannot
          // forget. The source of an answer naming an agent contains
          // `[@Kraken Auth](sparkle-agent:9f3c…)`; copying that verbatim pastes a dead link around
          // an internal uuid into someone's PR or Slack thread. The pill reads `@Kraken Auth` and
          // the selection path already yields `@Kraken Auth`; this is what makes the third path
          // agree. Ordinary markdown — tables, fences, real links — is untouched, which is the
          // reason this button copies source at all (see the header).
          void copyToClipboard(stripAgentRefs(text)).then((ok) => {
            // Never claim a copy that didn't happen — no check mark, no announcement.
            if (!ok || !alive.current) return;
            setCopied(true);
            onCopied?.();
            if (timer.current !== null) clearTimeout(timer.current);
            timer.current = setTimeout(() => {
              timer.current = null;
              if (alive.current) setCopied(false);
            }, COPY_TOAST_MS);
          });
        }}
        style={{
          display: "inline-flex",
          alignItems: "center",
          background: "transparent",
          border: "none",
          // Pulled back by its own padding so the GLYPH — not the button box — lines up with the
          // answer's left text edge.
          padding: 2,
          marginLeft: -2,
          cursor: "pointer",
          color: copied ? C.teal : C.conciergeMuted,
          opacity: lit ? 1 : RESTING_OPACITY,
          // Opacity only. See this file's header: nothing here may change the message's height.
          transition: "opacity 120ms ease",
          lineHeight: 0,
        }}
      >
        {copied ? <FiCheck size={13} aria-hidden /> : <FiCopy size={13} aria-hidden />}
      </button>
    </div>
  );
}
