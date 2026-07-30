// THE collapsed-text pill. One component, three surfaces — all three of which import this file
// today, which is the only form of that claim worth writing down (an earlier draft asserted the
// sharing before the wiring existed, and a reader reasonably concluded the concierge was handled):
//
//   1. THE BUILD-AGENT COMPOSER — `AttachmentRow`, above the textarea, where a big paste lands.
//   2. THE CONCIERGE COMPOSER — `Concierge/ComposeBox`, the same gesture in the other compose box.
//   3. THE CONCIERGE TRANSCRIPT — `Concierge/ConciergeThread`, where a relayed brief was echoed
//      inline and pushed the whole conversation off screen.
//
// ONE component rather than three, for the reason the mention pill is one component: two pills that
// look alike but are built twice drift, and nothing fails when they do. It matters more here than
// for a shade of teal, because this pill makes a PROMISE — that the full text is still there and is
// what gets sent — and a second implementation is where that promise quietly stops being kept.
//
// THE FACE CARRIES THE PASTE'S FIRST WORDS (see `pillPreview`). A pill reading only "Pasted text"
// is worse than the three rows it replaced: with two of them on screen the user has to open both to
// find the one they meant.
import type { CSSProperties } from "react";
import { C, FONT_WEIGHT, ON_BRAND_FILL } from "../../theme/colors";
import { pillPreview, type TextBlock } from "./attachments";
import { FONT_UI, RADIUS } from "../../theme/scale";
import { FiFileText, FiX } from "react-icons/fi";

/**
 * Where this pill is drawn.
 *
 * `tile` — a compose row's 46px dashed tile, sitting beside attachment tiles.
 * `inline` — one compact row inside prose, for the transcript. Tinted rather than dashed: it is a
 *   record of something that rode along with a message, which is the vocabulary the attachment chip
 *   and the mention pill already use in this column, and a dashed box in running text reads as an
 *   empty drop target instead.
 */
export type TextPillVariant = "tile" | "inline";

/** How wide a pill's face may get before the preview ellipsizes. The tile sits in a wrapping row
 *  beside other tiles; the inline one sits in a bubble that is already narrow. */
const FACE_MAX_WIDTH: Record<TextPillVariant, number> = { tile: 260, inline: 320 };

const clip: CSSProperties = {
  overflow: "hidden",
  whiteSpace: "nowrap",
  textOverflow: "ellipsis",
};

/** "41 lines · 3.2k characters" — the pill's subtitle, and the modal header's too. Characters as
 *  well as lines because the two thresholds are independent: an enormous ONE-line paste (a base64
 *  blob) collapses on chars alone, and a pill reading "1 line" with no size on it looks like a
 *  mistake. */
export function pillSizeLabel(block: TextBlock): string {
  const lines = `${block.lineCount} ${block.lineCount === 1 ? "line" : "lines"}`;
  const n = block.text.length;
  const chars = n >= 1000 ? `${(n / 1000).toFixed(1)}k characters` : `${n} characters`;
  return `${lines} · ${chars}`;
}

/**
 * Collapsed text, as a pill.
 *
 * Click the body to open the full-text modal; `onRemove` adds a × that drops the block. Removal is
 * OPTIONAL and absent in the transcript on purpose: a sent message is a record, and offering to
 * delete part of one implies an edit the app cannot make.
 */
export function TextPill({
  block,
  variant = "tile",
  onOpen,
  onRemove,
}: {
  block: TextBlock;
  variant?: TextPillVariant;
  onOpen: () => void;
  /** Omitted where the block is a historical record rather than a staged one — see above. */
  onRemove?: () => void;
}) {
  const preview = pillPreview(block.text);
  const size = pillSizeLabel(block);
  // The full identifying text for a pointer hover AND for the accessible name, so the pill is
  // identifiable without opening it by either route. `pillPreview` is already elided for the face;
  // the title is the un-elided first line plus the size.
  const label = preview ? `${preview} — ${size}` : `Pasted text — ${size}`;
  const inline = variant === "inline";

  return (
    <div style={{ position: "relative", lineHeight: 0, display: "inline-block", maxWidth: "100%" }}>
      <button
        type="button"
        onClick={onOpen}
        title={`${label}. Click to view the full text.`}
        aria-label={`Show full pasted text: ${label}`}
        data-testid="composer-text-pill"
        data-pill-variant={variant}
        // The line count rides on the element so a test — and a human with the inspector — can tell
        // WHICH block a pill stands for, not merely that a pill is there.
        data-line-count={block.lineCount}
        style={{
          maxWidth: FACE_MAX_WIDTH[variant],
          display: "flex",
          alignItems: "center",
          gap: 7,
          cursor: "pointer",
          fontFamily: FONT_UI,
          color: C.cream,
          textAlign: "left",
          ...(inline
            ? {
                padding: "3px 9px",
                // The scale's workhorse, not a hand-picked 5 — ALLOWED_RADIUS has no 5 in it and
                // theme/scale.test.ts ratchets off-scale literals. It is also what the mention pill
                // uses, which is the right answer anyway: two small inline pills in the same column
                // should not be rounded differently.
                borderRadius: RADIUS.input,
                border: "none",
                background: `color-mix(in srgb, ${C.teal} 16%, transparent)`,
              }
            : {
                height: 46,
                padding: "0 12px",
                borderRadius: 6,
                border: `1px dashed ${C.muted}`,
                background: C.deepForest,
              }),
        }}
      >
        <FiFileText size={inline ? 13 : 17} aria-hidden style={{ flex: "none" }} />
        {inline ? (
          // One row: the paste's own words, then the size, so a bubble keeps its height.
          <span style={{ ...clip, fontSize: 12, lineHeight: 1.5, minWidth: 0 }}>
            {preview || "Pasted text"}
            <span style={{ color: C.muted }}> · {size}</span>
          </span>
        ) : (
          <span
            style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", minWidth: 0 }}
          >
            <span
              style={{ ...clip, maxWidth: "100%", fontSize: 12, fontWeight: FONT_WEIGHT.semibold, lineHeight: 1.3 }}
            >
              {preview || "Pasted text"}
            </span>
            <span style={{ ...clip, maxWidth: "100%", fontSize: 12, color: C.muted, lineHeight: 1.3 }}>
              {size}
            </span>
          </span>
        )}
      </button>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          title="Remove"
          aria-label="Remove pasted text"
          style={{
            position: "absolute",
            top: -6,
            right: -6,
            width: 18,
            height: 18,
            borderRadius: 6,
            background: C.sienna,
            color: ON_BRAND_FILL,
            border: "none",
            cursor: "pointer",
            fontSize: 12,
            lineHeight: "18px",
            padding: 0,
          }}
        >
          <FiX size={12} aria-hidden />
        </button>
      )}
    </div>
  );
}
