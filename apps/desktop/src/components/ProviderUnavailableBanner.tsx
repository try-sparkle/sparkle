// The app-level "Sparkle's AI provider is down" warning — the sibling of ZeroCreditBanner for the
// failure that is OURS, not the user's.
//
// ZeroCreditBanner exists because when the USER's balance hits zero every AI enhancement goes dark
// at once and the only tells were feature-local. This is the same argument for the other way the
// same lights go out: the provider account behind the server-side proxy runs out of credit, or its
// key is rejected. On 2026-07-28 that happened for 12+ hours — 7,164 failed calls, suggestions dead
// throughout — and nothing anywhere said so. The cause was found by reading server logs by hand.
//
// The copy's job is to be HONEST about whose problem it is. Three things it must never do:
//   • offer a Refill link — the user's balance is fine, and taking their money would fix nothing;
//   • blame their network — that is OfflineBanner's job and a different condition entirely;
//   • imply the feature is working. A silent degrade is what made the outage invisible.
import { useEffect, useState, type CSSProperties } from "react";
import { FiAlertTriangle } from "react-icons/fi";
import { C, ON_BRAND_FILL_DARK } from "../theme/colors";
import { FONT_WEIGHT } from "@sparkle/ui";
import {
  isOutageActive,
  useAiProviderStore,
  type AiProviderOutageReason,
} from "../stores/aiProviderStore";

/**
 * The sentence for each reason. Both name Sparkle as the owner of the problem ("Sparkle's AI
 * provider", "we") so nobody reads it as something they misconfigured or can pay to fix.
 *
 * Deliberately NOT dismissible, unlike ZeroCreditBanner. That one is dismissible because the user
 * can act on it and may reasonably not want to right now; this one they cannot act on at all, and it
 * clears itself the moment a proxied call succeeds (aiProviderStore.noteHealthy). A ✕ here would
 * just re-hide the outage that went unnoticed for 12 hours in the first place.
 */
const WARNING: Record<AiProviderOutageReason, string> = {
  provider_unfunded:
    "Sparkle's AI provider account is out of credit, so AI Enhanced features are unavailable. This is ours to fix — your credits and network are fine",
  provider_key_rejected:
    "Sparkle's AI provider rejected our credentials, so AI Enhanced features are unavailable. This is ours to fix — your credits and network are fine",
};

// Brand amber is the caution fill and is theme-CONSTANT, so it needs an ink legible on it in both
// themes — the constant brand navy, not the themed `C.cream`. Matches ZeroCreditBanner exactly.
const INK = ON_BRAND_FILL_DARK;

const bar: CSSProperties = {
  flex: "0 0 auto",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 8,
  background: C.amber,
  color: INK,
  // Symmetric, and narrower than ZeroCreditBanner's because there is no out-of-flow ✕ to reserve a
  // lane for (see the non-dismissible note above).
  padding: "6px 16px",
  fontSize: 13,
  fontWeight: FONT_WEIGHT.semibold,
  fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
  letterSpacing: 0.2,
};

const inlineStrip: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 6,
  color: C.amber,
  fontSize: 12,
  margin: 0,
  maxWidth: 420,
};

/**
 * @param inline Render the compact Settings → Credits variant instead of the full-width top bar.
 *               It belongs on that pane for the same reason ZeroCreditBanner's inline variant does:
 *               someone staring at a healthy balance while every AI feature is dark needs to be told
 *               their balance is not the reason.
 */
export function ProviderUnavailableBanner({ inline = false }: { inline?: boolean } = {}) {
  const outage = useAiProviderStore((s) => s.outage);
  // Re-evaluate periodically so an EXPIRING observation retires on its own. Without this the banner
  // would keep asserting a stale outage until some unrelated render happened to run — and since it
  // has no dismiss control by design, "until the next render" can mean "forever" on an idle screen.
  // A minute is far finer than the 10-minute expiry, so the retirement looks prompt without polling
  // hard. The interval is unconditional (not gated on `outage`) so the hook order never changes.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  if (!isOutageActive(outage, now)) return null;
  const warning = WARNING[outage.reason];

  if (inline) {
    return (
      <p style={inlineStrip} role="status">
        <FiAlertTriangle size={14} style={{ flex: "none", marginTop: 2 }} aria-hidden />
        <span>{warning}.</span>
      </p>
    );
  }

  return (
    <div style={bar}>
      <FiAlertTriangle size={14} style={{ flex: "none" }} aria-hidden />
      <span role="status" aria-live="polite">
        {warning}.
      </span>
    </div>
  );
}
