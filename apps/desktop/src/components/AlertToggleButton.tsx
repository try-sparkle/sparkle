// The "Dismiss Alert" / "Re-enable Alert" toggle shown to the right of the agent name on a sidebar
// row's expanded card (spec: docs/superpowers/specs/2026-07-09-dismiss-alert-design.md). Kept as a
// tiny pure presentational component so the interactive wiring — which label to show, which handler
// to fire, and stopPropagation so acknowledging an alert doesn't also select/collapse the card — is
// unit-testable without mounting the whole AgentRow/store tree.
import { FONT_WEIGHT } from "../theme/colors";

export function AlertToggleButton({
  kind,
  statusColor,
  onDismiss,
  onReenable,
}: {
  /** "dismiss" on a truly-red row, "reenable" on a red-underneath-but-dismissed row. */
  kind: "dismiss" | "reenable";
  /** The row's status ink — red while "Dismiss Alert" shows, muted gray once dismissed — so the
   *  button stays legible in both light and dark themes without hardcoding a color. */
  statusColor: string;
  onDismiss: () => void;
  onReenable: () => void;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        // Never let acknowledging an alert bubble up to the row's select/collapse handler.
        e.stopPropagation();
        if (kind === "dismiss") onDismiss();
        else onReenable();
      }}
      title={
        kind === "dismiss"
          ? "Acknowledge this alert — recolor it and move it out of the red zone"
          : "Bring this alert back to red"
      }
      style={{
        flexShrink: 0,
        cursor: "pointer",
        fontSize: 11,
        fontWeight: FONT_WEIGHT.semibold,
        lineHeight: 1,
        padding: "3px 8px",
        borderRadius: 6,
        whiteSpace: "nowrap",
        border: `1px solid ${statusColor}`,
        color: statusColor,
        background: "transparent",
      }}
    >
      {kind === "dismiss" ? "Dismiss Alert" : "Re-enable Alert"}
    </button>
  );
}
