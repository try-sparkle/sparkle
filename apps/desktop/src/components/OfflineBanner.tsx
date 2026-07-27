import { C, FONT_WEIGHT, ON_GOLD_FILL } from "../theme/colors";
import { useConnectionStore } from "../stores/connectionStore";

// The shell's opaque-gold PAIR — the fill and the ink that sits on it, themed together. This was
// a hardcoded #D4AF37 whose comment explained it needed "a true gold, not the theme's warmer
// amber" — i.e. it was describing a token that didn't exist yet. It does now, so the banner is on
// the same gold as the Send button and the chiclets instead of a fourth one nobody can keep in
// sync. `goldFill`, not the literal BRAND.gold: a full-width band of #f5c26b under near-black ink
// is the prototype's dark shell, but on light mode's near-white chrome it is a smudge.
const GOLD = C.goldFill;
const GOLD_TEXT = ON_GOLD_FILL;

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
