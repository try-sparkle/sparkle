// Promo/override code redeemer, extracted verbatim from AuthGate.tsx so the Credits settings
// pane can reuse it (credits-menu spec §1). Behavior unchanged; AuthGate re-exports it so
// existing imports (and AuthGate.promo.test.tsx) keep working.

import { useState, type CSSProperties } from "react";
import { C, ON_BRAND_FILL, DANGER } from "../theme/colors";
import { redeemPromo } from "../services/sparkleApi";

// Local copies of AuthGate's button/input styles — the two components render on the same
// forest-green surface, so the values must stay visually in sync with AuthGate's consts.
const primaryBtn: CSSProperties = {
  background: C.teal,
  color: ON_BRAND_FILL,
  border: "none",
  borderRadius: 8,
  padding: "12px 22px",
  fontSize: 16,
  fontWeight: 600,
  cursor: "pointer",
  fontFamily: '"IBM Plex Sans", sans-serif',
};

const promoInput: CSSProperties = {
  // Themed field tokens, NOT cream-on-forest: C.cream flips to navy ink in light mode, which
  // rendered this input as a dark block inside the light Settings pane. deepForest/cream track
  // the theme on both surfaces this component mounts on (paywall gate + Credits pane).
  background: C.deepForest,
  color: C.cream,
  border: `1px solid ${C.muted}`,
  borderRadius: 6,
  padding: "8px 10px",
  fontSize: 14,
  fontFamily: '"IBM Plex Sans", sans-serif',
  width: 160,
};

/** Small "Have a code?" redeemer on the paywall. Forwards the typed code to the server (the code
 *  value never lives in this client); on success it refreshes entitlement so the gate re-derives
 *  to "entitled". Used until real Stripe promo codes land. */
export function PromoRedeem({ refresh }: { refresh: () => Promise<void> }) {
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const trimmed = code.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    setError(null);
    let redeemed = false;
    try {
      await redeemPromo(trimmed);
      redeemed = true;
      await refresh(); // entitled now → the gate re-derives and unmounts this component
    } catch (e) {
      // Keep the redeem failure distinct from a post-redeem refresh failure: once the code is
      // accepted, the grant is real, so never tell the user it "didn't work" — point them at
      // the refresh affordance instead.
      setError(
        redeemed
          ? // Surface-neutral copy: this renders on the paywall AND in the Credits pane, so it
            // must not name a button that only one surface has.
            "Redeemed — it may take a moment to appear; try refreshing."
          : String(e).includes("invalid_code")
            ? "That code didn't work."
            : "Couldn't redeem — try again.",
      );
    } finally {
      // Always re-enable: if refresh resolves without entitlement flipping (stale /me), the
      // control must recover rather than stay stuck on "…".
      setSubmitting(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6, marginTop: 4 }}>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          style={promoInput}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void submit()}
          placeholder="Have a code?"
          aria-label="Promo code"
          disabled={submitting}
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
        />
        <button style={primaryBtn} onClick={() => void submit()} disabled={submitting}>
          {submitting ? "…" : "Redeem"}
        </button>
      </div>
      {error && <p style={{ color: DANGER, fontSize: 12, margin: 0 }}>{error}</p>}
    </div>
  );
}
