import { C, FONT_WEIGHT, ON_BRAND_FILL } from "../../theme/colors";
import type { TextBlock } from "./attachments";

/** Collapsed pasted-text block. Click the body to open the full-text modal; × removes it. */
export function TextPill({
  block,
  onOpen,
  onRemove,
}: {
  block: TextBlock;
  onOpen: () => void;
  onRemove: () => void;
}) {
  return (
    <div style={{ position: "relative", lineHeight: 0 }}>
      <button
        onClick={onOpen}
        title="Click to view the full pasted text"
        style={{
          height: 46,
          display: "flex",
          alignItems: "center",
          gap: 7,
          padding: "0 12px",
          borderRadius: 6,
          border: `1px dashed ${C.muted}`,
          background: C.deepForest,
          color: C.cream,
          cursor: "pointer",
          fontFamily: '"IBM Plex Sans", sans-serif',
        }}
      >
        <span style={{ fontSize: 16, lineHeight: 1 }}>📄</span>
        <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-start" }}>
          <span style={{ fontSize: 12, fontWeight: FONT_WEIGHT.semibold, lineHeight: 1.3 }}>
            Pasted text
          </span>
          <span style={{ fontSize: 11, color: C.muted, lineHeight: 1.3 }}>
            {block.lineCount} lines
          </span>
        </span>
      </button>
      <button
        onClick={onRemove}
        title="Remove"
        style={{
          position: "absolute",
          top: -6,
          right: -6,
          width: 18,
          height: 18,
          borderRadius: 9,
          background: C.sienna,
          color: ON_BRAND_FILL,
          border: "none",
          cursor: "pointer",
          fontSize: 12,
          lineHeight: "18px",
          padding: 0,
        }}
      >
        ×
      </button>
    </div>
  );
}
