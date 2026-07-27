import { useEffect, type CSSProperties } from "react";
import { C } from "../theme/colors";
import { useAuthStore } from "../stores/authStore";
import { useUiStore } from "../stores/uiStore";
import { formatBalance } from "../services/creditPricing";

// Shows the user's remaining AI-credit balance in the builder sidebar header — top-right of that
// column (design spec §7.3). It no longer sits beside the Sparkle.ai wordmark: the wordmark moved
// to the concierge column, and this badge deliberately did NOT follow it, because that column
// already carries the SpendPill and two money pills in one header read as a question rather than
// as a summary. Reads the entitlement that
// AuthGate already loaded; refreshes on mount so it's current after a top-up.
// No outline and no ⚡ icon — just the dollar amount in a filled pill whose corner radius
// matches the "Open" pill in the TopBar (8px, not a fully-rounded 999 capsule).
const badge: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  padding: "3px 9px",
  borderRadius: 8,
  // pillFill, not forest: this badge is a FILLED chip on the concierge column, and a plane
  // fill on a near-black plane is not a chip. See theme/colors `pillFill`.
  background: C.pillFill,
  color: C.cream,
  fontSize: 12,
  fontVariantNumeric: "tabular-nums",
  fontFamily: '"IBM Plex Sans", sans-serif',
  whiteSpace: "nowrap",
};

export function BalanceBadge() {
  const me = useAuthStore((s) => s.me);
  const refresh = useAuthStore((s) => s.refresh);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!me) return null;
  // The pill is clickable: it deep-opens the settings dialog on the Credits pane (spec §1). The
  // button wrapper is visually inert (no border/padding) so the pill itself looks unchanged.
  return (
    <button
      type="button"
      data-hint="credits"
      aria-label="Open credits"
      title="Remaining AI credits — click to manage"
      onClick={() => useUiStore.getState().openSettings("credits")}
      style={{ background: "transparent", border: "none", padding: 0, cursor: "pointer" }}
    >
      <span style={badge}>{formatBalance(me.balanceCents)}</span>
    </button>
  );
}
