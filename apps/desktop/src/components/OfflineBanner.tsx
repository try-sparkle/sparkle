import { FONT_WEIGHT } from "../theme/colors";
import { useConnectionStore } from "../stores/connectionStore";

// A true gold (not the theme's warmer amber) so it reads as the "connection offline" notice the
// user asked for. Dark text keeps it legible on gold in both light and dark themes.
const GOLD = "#D4AF37";
const GOLD_TEXT = "#1a1205";

/** Full-width gold banner shown at the very top of the app whenever connectivity is down.
 *  Renders nothing when online. Sits in the flex column (pushes content down, never overlays). */
export function OfflineBanner() {
  const isOnline = useConnectionStore((s) => s.isOnline);
  if (isOnline) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        flex: "0 0 auto",
        background: GOLD,
        color: GOLD_TEXT,
        textAlign: "center",
        padding: "6px 14px",
        fontSize: 13,
        fontWeight: FONT_WEIGHT.semibold,
        fontFamily: '"IBM Plex Sans", sans-serif',
        letterSpacing: 0.2,
      }}
    >
      Your connection is offline.
    </div>
  );
}
