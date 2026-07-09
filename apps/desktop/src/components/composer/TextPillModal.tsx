import { C, FONT_WEIGHT, ON_BRAND_FILL } from "../../theme/colors";
import { ModalOverlay } from "./ModalOverlay";
import type { TextBlock } from "./attachments";

/** Modal for a collapsed text pill: shows the full pasted text read-only, with a button
 *  to expand it back into the composer as regular text (which removes the pill). */
export function TextPillModal({
  block,
  onClose,
  onShowAsText,
}: {
  block: TextBlock;
  onClose: () => void;
  onShowAsText: () => void;
}) {
  return (
    <ModalOverlay onClose={onClose}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          padding: "12px 16px",
          borderBottom: `1px solid ${C.deepForest}`,
          flex: "0 0 auto",
        }}
      >
        <span
          style={{
            color: C.cream,
            fontFamily: '"IBM Plex Sans", sans-serif',
            fontWeight: FONT_WEIGHT.semibold,
            fontSize: 14,
          }}
        >
          Pasted text · {block.lineCount} lines
        </span>
        <button
          onClick={onClose}
          title="Close"
          style={{
            background: "transparent",
            border: "none",
            color: C.muted,
            cursor: "pointer",
            fontSize: 20,
            lineHeight: 1,
            padding: 4,
          }}
        >
          ×
        </button>
      </div>

      <pre
        style={{
          margin: 0,
          padding: 16,
          overflow: "auto",
          flex: 1,
          minHeight: 0,
          color: C.cream,
          background: C.deepForest,
          fontFamily: '"IBM Plex Mono", ui-monospace, monospace',
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
          borderTop: `1px solid ${C.deepForest}`,
          flex: "0 0 auto",
        }}
      >
        <button
          onClick={onShowAsText}
          style={{
            background: C.teal,
            color: ON_BRAND_FILL,
            border: "none",
            borderRadius: 8,
            padding: "9px 16px",
            fontFamily: '"IBM Plex Sans", sans-serif',
            fontWeight: FONT_WEIGHT.semibold,
            fontSize: 14,
            cursor: "pointer",
          }}
        >
          Show as regular text
        </button>
      </div>
    </ModalOverlay>
  );
}
