// Board column header for the Definable Done & Delivered feature (Unit 5). Backlog / In Progress
// stay inert plain titles; the Done / Delivered titles become a keyboard-accessible button that
// opens the Define/Edit modal, and — once the stage is defined — carry a small live status chip
// (esp. Delivered, which reflects the delivery monitor). The undefined-state Define CTA that sits
// in the column BODY also lives here so the two affordances stay visually in sync.
// Spec: docs/superpowers/specs/2026-07-02-definable-done-delivered-design.md  (UX → Board)
import { type CSSProperties } from "react";
import { FiCheck, FiAlertTriangle } from "react-icons/fi";
import { C, FONT_WEIGHT, ROW_ACTIVE_BUBBLE, ON_BRAND_FILL } from "../theme/colors";
import type { BoardColumn } from "../services/beads";
import type { StageKey } from "../services/stageDefs";

/** Only these two columns are definable; the map both gates the affordance and names the stage. */
export function definableStageKey(columnKey: BoardColumn): StageKey | null {
  if (columnKey === "done") return "done";
  if (columnKey === "delivered") return "delivered";
  return null;
}

/** The live delivery-monitor readout for the Delivered header chip: an honest "watching" vs the
 *  "can't detect — manual" state. `detectable` drives BOTH the icon and the wording. */
export interface DeliveryChip {
  detectable: boolean;
  /** The monitor's human status string (its leading ⚠/✓ glyph is stripped; we render our own icon). */
  label: string;
}

export function StageColumnHeader({
  columnKey,
  label,
  count,
  defined,
  deliveryChip,
  onDefine,
}: {
  columnKey: BoardColumn;
  label: string;
  count: number;
  /** Whether THIS column's stage is defined (drives the header status chip). */
  defined: boolean;
  /** Delivered-only: the live monitor chip. Ignored for other columns. */
  deliveryChip?: DeliveryChip;
  /** Open the Define/Edit modal for a definable stage. Absent → the column is inert. */
  onDefine?: (key: StageKey) => void;
}) {
  const stageKey = definableStageKey(columnKey);
  const clickable = !!stageKey && !!onDefine;

  const titleNode = clickable ? (
    <button
      type="button"
      onClick={() => onDefine?.(stageKey!)}
      title={`Define what “${label}” means for this project`}
      style={titleButton}
    >
      {label}
    </button>
  ) : (
    <span>{label}</span>
  );

  return (
    <div style={headerRow}>
      {titleNode}
      <span style={{ color: C.muted, opacity: 0.7 }}>{count}</span>
      {/* Live status chip: Delivered reflects the monitor; Done shows a plain "defined" tick. */}
      {defined && stageKey === "delivered" && deliveryChip && (
        <span
          style={{
            ...statusChip,
            color: deliveryChip.detectable ? C.successInk : C.amber,
            borderColor: deliveryChip.detectable ? C.successInk : C.amber,
          }}
          title={deliveryChip.label}
        >
          {deliveryChip.detectable ? (
            <FiCheck size={11} aria-hidden />
          ) : (
            <FiAlertTriangle size={11} aria-hidden />
          )}
          <span style={chipText}>{deliveryChip.label}</span>
        </span>
      )}
      {defined && stageKey === "done" && (
        <span style={{ ...statusChip, color: C.successInk, borderColor: C.successInk }} title="Done is defined">
          <FiCheck size={11} aria-hidden />
          <span style={chipText}>defined</span>
        </span>
      )}
    </div>
  );
}

/** The undefined-state empty CTA that sits at the top of a Done/Delivered column body: a centered
 *  blue button that opens the Define modal. Shown even when the column already has (legacy) cards,
 *  so the Define affordance is never hidden. */
export function DefineStageCta({
  stageKey,
  label,
  onDefine,
}: {
  stageKey: StageKey;
  label: string;
  onDefine: (key: StageKey) => void;
}) {
  return (
    <div style={ctaWrap}>
      <button type="button" style={ctaButton} onClick={() => onDefine(stageKey)}>
        Define “{label}”
      </button>
      <div style={ctaHint}>Tell Sparkle what “{label}” means for this project.</div>
    </div>
  );
}

// ── styles ───────────────────────────────────────────────────────────────────────────────────
const headerRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "10px 12px",
  fontSize: 12,
  textTransform: "uppercase",
  letterSpacing: 1,
  fontWeight: FONT_WEIGHT.semibold,
  color: C.muted,
};

const titleButton: CSSProperties = {
  background: "transparent",
  border: "none",
  padding: 0,
  margin: 0,
  cursor: "pointer",
  color: C.muted,
  font: "inherit",
  letterSpacing: "inherit",
  textTransform: "inherit",
  textDecoration: "underline dotted",
  textUnderlineOffset: 3,
};

const statusChip: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  marginLeft: "auto",
  border: "1px solid",
  borderRadius: 6,
  padding: "1px 6px",
  fontSize: 9.5,
  letterSpacing: 0.3,
  textTransform: "none",
  maxWidth: 160,
};

const chipText: CSSProperties = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };

const ctaWrap: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 6,
  padding: "14px 8px",
  textAlign: "center",
};

const ctaButton: CSSProperties = {
  background: ROW_ACTIVE_BUBBLE,
  color: ON_BRAND_FILL,
  border: "none",
  borderRadius: 8,
  padding: "8px 16px",
  fontSize: 13,
  fontWeight: FONT_WEIGHT.semibold,
  cursor: "pointer",
  fontFamily: '"IBM Plex Sans", sans-serif',
};

const ctaHint: CSSProperties = { color: C.muted, opacity: 0.7, fontSize: 11, lineHeight: 1.4, maxWidth: 200 };
