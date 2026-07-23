// Promo/override code redeemer, extracted verbatim from AuthGate.tsx so the Credits settings
// pane can reuse it (credits-menu spec §1). Behavior unchanged; AuthGate re-exports it so
// existing imports (and AuthGate.promo.test.tsx) keep working.

import { useState, type CSSProperties } from "react";
import { C, ON_BRAND_FILL, DANGER } from "../theme/colors";
import { redeemCoupon, redeemPromo } from "../services/sparkleApi";

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
  // Two message channels: `error` is a genuine failure (red DANGER); `notice` is an informational
  // or success message (neutral teal). A discount code, the refresh hint, and the "credits added"
  // confirmation are NOT failures, so they must not render in the red error slot (roborev).
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Surface-neutral copy: this renders on the paywall AND in the Credits pane, so it must not name
  // a button that only one surface has. Once a code is accepted the grant is real, so a later
  // refresh failure must never be reported as the code failing.
  const REFRESH_HINT = "Redeemed — it may take a moment to appear; try refreshing.";
  // Confirmation shown after a credit_grant when the component stays mounted (Credits pane).
  const CREDITS_ADDED = "Credits added.";
  // An `entitles` coupon cleared the $99 paywall too, not just the balance.
  const UNLOCKED = "Unlocked — Sparkle is yours, and credits were added.";

  const submit = async () => {
    const trimmed = code.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    setError(null);
    setNotice(null);
    let redeemed = false;
    try {
      // Admin-issued codes (`/admin coupons` → coupons table) redeem via /billing/coupon; the
      // single-code PROMO_CODE override (/billing/promo) is the fallback for a code the coupon
      // system doesn't recognize. The button understands both so any valid code the user has works.
      const res = await redeemCoupon(trimmed);
      redeemed = true;
      if (res.type === "discount") {
        // A discount coupon grants nothing here — it's a Stripe promo code applied at checkout.
        setNotice("That's a discount code — enter it at checkout to apply it.");
        return;
      }
      await refresh(); // credits granted → balance/entitlement re-derives (gate may unmount this)
      // On the paywall the gate unmounts on this refresh; in the Credits pane it stays mounted, so
      // confirm the grant instead of leaving the user with only a silently updated balance. An
      // `entitles` coupon did more than top up the balance — say so.
      setNotice(res.entitled ? UNLOCKED : CREDITS_ADDED);
    } catch (e) {
      const msg = String(e);
      if (redeemed) {
        // Coupon was accepted but the follow-up refresh threw — never claim the code failed.
        setNotice(REFRESH_HINT);
      } else if (msg === "already_redeemed") {
        // Exact match, not substring: the Rust commands surface the server's `error` code verbatim
        // (server_error / desktop_redeem_promo), so unrelated error text can't be misclassified.
        setError("You've already redeemed this code.");
      } else {
        // The coupon system didn't accept it — an unknown code OR a transient coupon-endpoint error
        // (network/5xx). Either way, try the legacy single-code override before giving up, so an
        // override-code holder isn't blocked by a momentary /billing/coupon hiccup (roborev).
        try {
          await redeemPromo(trimmed);
          redeemed = true;
          await refresh();
          setNotice(CREDITS_ADDED);
        } catch (e2) {
          if (redeemed) setNotice(REFRESH_HINT);
          else if (String(e2) === "invalid_code") setError("That code didn't work.");
          else setError("Couldn't redeem — try again.");
        }
      }
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
      {notice && <p style={{ color: C.teal, fontSize: 12, margin: 0 }}>{notice}</p>}
    </div>
  );
}
