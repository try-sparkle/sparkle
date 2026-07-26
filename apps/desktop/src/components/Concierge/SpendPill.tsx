// The spend pill — today's cross-project spend, top-right of the concierge header. Green
// (calm money, not an alert); the amount arrives pre-formatted from the view-model.
import { C, FONT_WEIGHT } from "../../theme/colors";

export function SpendPill({ amountText }: { amountText: string }) {
  return (
    <div
      title="Spend today across your projects"
      style={{
        position: "absolute",
        top: 12,
        right: 12,
        zIndex: 3,
        fontSize: 10,
        fontWeight: FONT_WEIGHT.bold,
        color: C.successInk,
        background: `color-mix(in srgb, ${C.success} 10%, transparent)`,
        border: `1px solid color-mix(in srgb, ${C.success} 35%, transparent)`,
        borderRadius: 999,
        padding: "3px 9px",
        cursor: "default",
      }}
    >
      {amountText}
    </div>
  );
}
