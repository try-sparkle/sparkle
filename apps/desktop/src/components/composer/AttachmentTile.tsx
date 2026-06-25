import { useState, type MouseEvent } from "react";
import { C, CHAT_USER_BUBBLE, FONT_WEIGHT } from "../../theme/colors";
import { FileIcon } from "./icons";
import type { Attachment } from "./attachments";

const TILE_H = 46;

/** One attachment in the composer row: an image thumbnail or a file glyph + name.
 *  Plain click opens the lightbox; the checkbox (and Cmd/Shift-click on the body)
 *  drives multi-select; the × removes it. */
export function AttachmentTile({
  att,
  selected,
  anySelected,
  onBodyClick,
  onToggleSelect,
  onRemove,
}: {
  att: Attachment;
  selected: boolean;
  anySelected: boolean;
  onBodyClick: (e: MouseEvent) => void;
  onToggleSelect: (e: MouseEvent) => void;
  onRemove: () => void;
}) {
  const [hover, setHover] = useState(false);
  const showCheckbox = hover || anySelected;

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ position: "relative", lineHeight: 0 }}
    >
      <div
        onClick={onBodyClick}
        title={att.path}
        style={{
          height: TILE_H,
          maxWidth: 120,
          minWidth: att.kind === "image" ? undefined : 84,
          display: "flex",
          alignItems: "center",
          gap: 6,
          borderRadius: 6,
          border: `${selected ? 2 : 1}px solid ${selected ? C.teal : CHAT_USER_BUBBLE}`,
          background: att.kind === "image" ? "transparent" : C.deepForest,
          cursor: "pointer",
          overflow: "hidden",
          boxSizing: "border-box",
        }}
      >
        {att.kind === "image" && att.dataUrl ? (
          <img
            src={att.dataUrl}
            alt={att.name}
            style={{ height: "100%", maxWidth: 118, objectFit: "cover", display: "block" }}
          />
        ) : (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "0 8px",
              color: C.cream,
            }}
          >
            <FileIcon />
            <span
              style={{
                fontFamily: '"IBM Plex Sans", sans-serif',
                fontSize: 11,
                fontWeight: FONT_WEIGHT.semibold,
                lineHeight: 1.2,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                maxWidth: 64,
              }}
            >
              {att.name}
            </span>
          </div>
        )}
      </div>

      {/* Selection checkbox — appears on hover or whenever any tile is selected. */}
      {showCheckbox && (
        <button
          onClick={onToggleSelect}
          title={selected ? "Deselect" : "Select"}
          style={{
            position: "absolute",
            top: -6,
            left: -6,
            width: 18,
            height: 18,
            borderRadius: 4,
            background: selected ? C.teal : C.forest,
            color: C.cream,
            border: `1px solid ${selected ? C.teal : C.muted}`,
            cursor: "pointer",
            fontSize: 12,
            lineHeight: "16px",
            padding: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {selected ? "✓" : ""}
        </button>
      )}

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
          color: C.cream,
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
