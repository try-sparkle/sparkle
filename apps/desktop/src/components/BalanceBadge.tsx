import { useEffect, type CSSProperties } from "react";
import { C } from "../theme/colors";
import { useAuthStore } from "../stores/authStore";
import { formatBalance } from "../services/creditPricing";

// Shows the user's remaining AI-credit balance in the sidebar header — top-right of the left
// column, beside the Sparkle.ai wordmark (design spec §7.3). Reads the entitlement that
// AuthGate already loaded; refreshes on mount so it's current after a top-up.
// No outline and no ⚡ icon — just the dollar amount in a filled pill whose corner radius
// matches the "Open" pill in the TopBar (8px, not a fully-rounded 999 capsule).
const badge: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  padding: "3px 9px",
  borderRadius: 8,
  background: C.forest,
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
  return (
    <span style={badge} title="Remaining AI credits" aria-label="Remaining AI credits">
      {formatBalance(me.balanceCents)}
    </span>
  );
}
