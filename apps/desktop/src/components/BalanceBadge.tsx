import { useEffect, type CSSProperties } from "react";
import { C } from "../theme/colors";
import { useAuthStore } from "../stores/authStore";
import { formatBalance } from "../services/creditPricing";

// Shows the user's remaining AI-credit balance in the TopBar (design spec §7.3). Reads the
// entitlement that AuthGate already loaded; refreshes on mount so it's current after a top-up.
const badge: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  padding: "3px 9px",
  borderRadius: 999,
  border: `1px solid ${C.muted}`,
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
      ⚡ {formatBalance(me.balanceCents)}
    </span>
  );
}
