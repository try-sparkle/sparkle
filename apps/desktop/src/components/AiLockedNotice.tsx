// Inline "you can see it, buy the app to use it" notice for the trial/no-credits path. Shown at a
// user-initiated AI surface (Think submit, the composer overlay, voice dictation) when the feature
// is VISIBLE but LOCKED — the settings flag is on but the user has no credits (see aiGate's
// visible/usable/locked split). The typed prompt is NEVER cleared by the caller, so the user can
// submit for real right after buying.
//
// Reuses AuthGate's "Pay $99" rails: when signed in, create the Stripe checkout session directly
// and land on checkout.stripe.com in one click (the proven top-up path); fall back to the web
// sign-in→paywall hand-off when signed out or if the direct checkout throws. Either way a failed
// browser launch resolves `false` (never rejects), so we show the URL selectable rather than
// leaving the user on a dead button (same recovery as AuthGate / CreditsPanel).
import { useState, type CSSProperties } from "react";
import { FiLock } from "react-icons/fi";
import { C, ON_BRAND_FILL, DANGER } from "../theme/colors";
import { openPaywall, PAYWALL_URL } from "../services/sparkleApi";
import { openPaywallCheckout, lastCheckoutUrl } from "../services/creditsMenuApi";
import { useAuthStore } from "../stores/authStore";

const wrap: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  flexWrap: "wrap",
  background: C.deepForest,
  border: `1px solid ${C.muted}`,
  borderRadius: 6,
  padding: "8px 12px",
  fontSize: 12,
  color: C.cream,
  fontFamily: '"IBM Plex Sans", sans-serif',
};

const message: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  minWidth: 0,
};

const unlockBtn: CSSProperties = {
  background: C.teal,
  color: ON_BRAND_FILL,
  border: "none",
  borderRadius: 4,
  padding: "4px 12px",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
  fontFamily: '"IBM Plex Sans", sans-serif',
  whiteSpace: "nowrap",
};

const failNote: CSSProperties = {
  color: DANGER,
  fontSize: 11,
  flexBasis: "100%",
};

/**
 * A compact inline upsell. `label` overrides the default message so each surface can say what the
 * user was trying to do (e.g. "Buy Sparkle to think with AI", "Buy Sparkle to dictate"). Clicking
 * "Unlock Sparkle — $99" opens the existing $99 paywall in the system browser.
 */
export function AiLockedNotice({
  label = "Buy Sparkle to use AI features.",
  style,
}: {
  label?: string;
  style?: CSSProperties;
}) {
  const tokenPresent = useAuthStore((s) => s.tokenPresent);
  const [busy, setBusy] = useState(false);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);

  const unlock = async () => {
    if (busy) return; // double-clicks must not open multiple checkout tabs
    setBusy(true);
    setFailedUrl(null);
    try {
      // Signed in → one-click straight to Stripe. If the session was created but the browser
      // wouldn't open, offer the real hosted URL; if the direct path throws (server refused,
      // e.g. no bearer), fall through to the web hand-off so the pre-auth path never regresses.
      if (tokenPresent) {
        try {
          if (await openPaywallCheckout()) return;
          const url = lastCheckoutUrl();
          if (url) {
            setFailedUrl(url);
            return;
          }
        } catch (e) {
          console.warn("Direct paywall checkout failed; falling back to the web paywall flow:", e);
        }
      }
      // Signed out (or direct checkout unavailable): the web page handles sign-in → paywall.
      const ok = await openPaywall();
      if (!ok) setFailedUrl(PAYWALL_URL);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ ...wrap, ...style }} role="note">
      <span style={message}>
        <FiLock size={13} style={{ flex: "none" }} aria-hidden />
        {label}
      </span>
      <button
        type="button"
        style={{ ...unlockBtn, opacity: busy ? 0.6 : 1 }}
        disabled={busy}
        onClick={() => void unlock()}
      >
        Unlock Sparkle — $99
      </button>
      {failedUrl && (
        <span style={failNote} role="alert">
          Couldn&apos;t open your browser —{" "}
          <span style={{ color: C.cream, userSelect: "text", wordBreak: "break-all" }}>
            {failedUrl}
          </span>
        </span>
      )}
    </div>
  );
}
