// The modal behind a collapsed-text pill — one modal for every surface that draws one (see TextPill
// for which surfaces those are today, and how to check).
//
// Three things, all of them the founder's ask: the full text, a button that expands it back into
// regular text where the pill was, and a copy icon.
//
// THE COPY BUTTON COPIES `block.text`, THE VERBATIM PASTE — not the rendered `<pre>`'s text, and not
// the pill's label. It is the escape hatch for the one thing collapsing could take away: if you can
// always get the exact bytes back out, the pill is a display decision rather than a lossy one.
import { useEffect, useRef, useState } from "react";
import { C, FONT_WEIGHT, ON_BRAND_FILL } from "../../theme/colors";
import { FONT_MONO, FONT_UI, RADIUS } from "../../theme/scale";
import { ModalOverlay } from "./ModalOverlay";
import { pillSizeLabel } from "./TextPill";
import type { TextBlock } from "./attachments";
import { copyToClipboard } from "../../clipboard";
import { FiCheck, FiCopy, FiX } from "react-icons/fi";

/** How long the copy button shows its tick before returning to the icon. */
const COPIED_MS = 1400;

/** Modal for a collapsed text pill: shows the full pasted text read-only, with a copy icon and a
 *  button to expand it back into regular text (which removes the pill). */
export function TextPillModal({
  block,
  onClose,
  onShowAsText,
}: {
  block: TextBlock;
  onClose: () => void;
  onShowAsText: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);
  // Unmount-safe: "Show as regular text" closes this modal, and the user can hit it inside the
  // confirmation window.
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
    };
  }, []);

  const copy = async () => {
    const ok = await copyToClipboard(block.text);
    if (!ok || !alive.current) return;
    setCopied(true);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (alive.current) setCopied(false);
    }, COPIED_MS);
  };

  return (
    <ModalOverlay onClose={onClose}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          padding: "12px 16px",
          borderBottom: `1px solid ${C.hairline}`,
          flex: "0 0 auto",
        }}
      >
        <span
          style={{
            color: C.cream,
            fontFamily: FONT_UI,
            fontWeight: FONT_WEIGHT.semibold,
            fontSize: 13,
          }}
        >
          Pasted text · {pillSizeLabel(block)}
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: 2, flex: "none" }}>
          <button
            type="button"
            onClick={() => void copy()}
            title="Copy the full text"
            aria-label={copied ? "Copied" : "Copy the full text"}
            data-testid="text-pill-copy"
            style={{
              background: "transparent",
              border: "none",
              color: copied ? C.teal : C.muted,
              cursor: "pointer",
              lineHeight: 1,
              padding: 4,
            }}
          >
            {copied ? <FiCheck size={15} aria-hidden /> : <FiCopy size={15} aria-hidden />}
          </button>
          <button
            type="button"
            onClick={onClose}
            title="Close"
            aria-label="Close"
            style={{
              background: "transparent",
              border: "none",
              color: C.muted,
              cursor: "pointer",
              fontSize: 17,
              lineHeight: 1,
              padding: 4,
            }}
          >
            <FiX size={15} aria-hidden />
          </button>
        </div>
      </div>

      <pre
        data-testid="text-pill-full-text"
        style={{
          margin: 0,
          padding: 16,
          overflow: "auto",
          flex: 1,
          minHeight: 0,
          color: C.cream,
          background: C.deepForest,
          fontFamily: FONT_MONO,
          fontSize: 13,
          lineHeight: 1.5,
          whiteSpace: "pre-wrap",
          overflowWrap: "break-word",
        }}
      >
        {block.text}
      </pre>

      <div
        style={{
          display: "flex",
          justifyContent: "flex-end",
          gap: 10,
          padding: "12px 16px",
          borderTop: `1px solid ${C.hairline}`,
          flex: "0 0 auto",
        }}
      >
        <button
          type="button"
          onClick={onShowAsText}
          data-testid="text-pill-show-as-text"
          style={{
            background: C.teal,
            color: ON_BRAND_FILL,
            border: "none",
            borderRadius: RADIUS.input,
            padding: "9px 16px",
            fontFamily: FONT_UI,
            fontWeight: FONT_WEIGHT.semibold,
            fontSize: 13,
            cursor: "pointer",
          }}
        >
          Show as regular text
        </button>
      </div>
    </ModalOverlay>
  );
}
