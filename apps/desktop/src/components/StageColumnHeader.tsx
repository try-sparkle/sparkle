// Board column header for the Definable Done & Delivered feature (Unit 5). Backlog / In Progress
// stay inert plain titles; the Done / Delivered titles become a keyboard-accessible button that
// opens the Define/Edit modal, and — once the stage is defined — carry a small live status chip
// (esp. Delivered, which reflects the delivery monitor). The undefined-state Define CTA that sits
// in the column BODY also lives here so the two affordances stay visually in sync.
// Spec: docs/superpowers/specs/2026-07-02-definable-done-delivered-design.md  (UX → Board)
import { type CSSProperties } from "react";
import { FiCheck, FiAlertTriangle } from "react-icons/fi";
import { C, FONT_WEIGHT, ROW_ACTIVE_BUBBLE } from "../theme/colors";
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

  // THE COUNT SITS UNDER THE TITLE, not beside it. Inline, it read as part of the lane name — the
  // eye picks up "BACKLOG 12" as one string and has to parse where the label stops. Stacked, the
  // title is the label and the number is a quiet second line, which is what a count is: a fact
  // about the lane rather than part of its name. It also stops a long label and a three-digit count
  // competing for the same row as the columns narrow.
  return (
    <div style={headerRow}>
      {/* The lane LABEL is addressable by id because it now collides with card text by design:
          the terminal lane is "Shipped" and a card in it carries the stage badge "Shipped" too.
          That agreement is the point — the lane and the ticker speak one vocabulary — but it makes
          a bare getByText("Shipped") ambiguous, so tests target the lane through this. */}
      <span data-testid={`lane-label-${columnKey}`} style={titleStack}>
        {titleNode}
        <span data-testid={`lane-count-${columnKey}`} style={countLine}>
          {count}
        </span>
      </span>
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
  // The chips sit against the TITLE line, not centred against the whole two-line stack, so a lane
  // with a status chip and one without still read as the same header height.
  alignItems: "flex-start",
  gap: 8,
  padding: "10px 12px",
  fontSize: 12,
  textTransform: "uppercase",
  letterSpacing: 1,
  fontWeight: FONT_WEIGHT.semibold,
  color: C.muted,
};

/** Title over count. `min-width: 0` so a long lane label truncates rather than pushing the chips. */
const titleStack: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
  gap: 2,
  minWidth: 0,
};

/** The count line: same muted ink, but out of the uppercase/tracked treatment the label carries —
 *  a number rendered with 1px letter-spacing reads as a code, not a quantity. */
const countLine: CSSProperties = {
  fontSize: 12,
  letterSpacing: 0,
  textTransform: "none",
  fontWeight: FONT_WEIGHT.regular,
  opacity: 0.7,
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
  fontSize: 10,
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
  // C.cream, NOT ON_BRAND_FILL. That constant exists for a fill that is constant across themes (the
  // teal/cyan brand shapes), so it stays light in BOTH — but ROW_ACTIVE_BUBBLE is a THEMED token
  // that goes to a mid blue in light mode, where a light ink on it falls under the floor. The fill
  // is themed, so its ink has to be too; this matches DefineStageModal's primaryBtn, which paints
  // the same token.
  color: C.cream,
  border: "none",
  borderRadius: 6,
  padding: "8px 16px",
  fontSize: 13,
  fontWeight: FONT_WEIGHT.semibold,
  cursor: "pointer",
  fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
};

const ctaHint: CSSProperties = { color: C.muted, opacity: 0.7, fontSize: 12, lineHeight: 1.4, maxWidth: 200 };
