// The app-shell "AI service is sustaining failures" banner.
//
// This is the banner the 2026-07-28 incident should have shown. For 12+ hours the proxy returned
// bare HTTP 502s (Sparkle's vendor account had a billing problem) and every AI Enhanced feature
// failed SILENTLY — the outage was found by reading server logs by hand. ProviderUnavailableBanner
// covers the case where the server NAMES the cause (`ai_unconfigured` → provider_unfunded/…); this
// covers the case it does not — a sustained run of gateway/transport errors — which is exactly what
// went unsurfaced.
//
// It is driven by aiServiceHealthStore, whose detector only flips to `degraded` after a SUSTAINED run
// of service failures (never a lone blip), and which clears the instant any proxied call succeeds.
// So this banner is honest by construction: it appears only while the service is really failing and
// retires itself on recovery.
//
// Copy rules, learned from the sibling banners:
//   • name no PII and no raw error — the store only ever holds a coarse reason;
//   • don't blame the user's network (OfflineBanner's job) or balance (ZeroCreditBanner's);
//   • say the feature is affected, plainly — a silent degrade is what made the outage invisible.
// Unlike ProviderUnavailableBanner it IS dismissible: the user cannot fix this, but the retry path
// keeps working underneath, so a ✕ that hides the nag for the episode is reasonable. A later, DISTINCT
// outage re-arms it (a success clears the dismissal — see the store).
import { type CSSProperties } from "react";
import { FiAlertTriangle, FiX } from "react-icons/fi";
import { C, ON_BRAND_FILL_DARK } from "../theme/colors";
import { FONT_WEIGHT } from "@sparkle/ui";
import { FONT_UI } from "../theme/scale";
import { useAiServiceHealthStore, type AiServiceReason } from "../stores/aiServiceHealthStore";

/** One sentence per coarse reason. Both open with the same plain statement that the features are
 *  affected, then add the coarse cause without a raw status or any PII. */
const WARNING: Record<AiServiceReason, string> = {
  unreachable:
    "AI-Enhanced features are temporarily unavailable — the AI service is unreachable right now. We keep retrying automatically",
  rate_limited:
    "AI-Enhanced features are temporarily unavailable — the AI service is rate-limited right now. We keep retrying automatically",
};

// Brand amber is the theme-CONSTANT caution fill, so its ink is the constant brand navy (matching
// ZeroCreditBanner / ProviderUnavailableBanner) rather than the themed cream.
const INK = ON_BRAND_FILL_DARK;

const bar: CSSProperties = {
  flex: "0 0 auto",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  // Positioning context for the out-of-flow ✕ (see ZeroCreditBanner for why it is pinned, not
  // pushed with marginLeft:auto).
  position: "relative",
  gap: 8,
  background: C.amber,
  color: INK,
  padding: "6px 32px",
  fontSize: 13,
  fontWeight: FONT_WEIGHT.semibold,
  fontFamily: FONT_UI,
};

const dismissBtn: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  background: "transparent",
  border: "none",
  padding: 2,
  margin: 0,
  cursor: "pointer",
  color: INK,
  lineHeight: 0,
  position: "absolute",
  right: 8,
  top: "50%",
  transform: "translateY(-50%)",
};

export function AiServiceBanner() {
  const degraded = useAiServiceHealthStore((s) => s.degraded);
  const dismissed = useAiServiceHealthStore((s) => s.dismissed);
  const reason = useAiServiceHealthStore((s) => s.reason);

  // Show only while a SUSTAINED outage is recorded and the user hasn't dismissed THIS episode. `reason`
  // is always set once `degraded` is true, but guard anyway so a partial state can never throw.
  if (!degraded || dismissed || reason === null) return null;

  return (
    <div style={bar}>
      <FiAlertTriangle size={14} style={{ flex: "none" }} aria-hidden />
      {/* The live region wraps ONLY the sentence — with the ✕ inside it some screen readers
          re-announce the whole warning on the button's focus/state changes. */}
      <span role="status" aria-live="polite">
        {WARNING[reason]}.
      </span>
      <button
        type="button"
        aria-label="Dismiss"
        title="Dismiss"
        style={dismissBtn}
        onClick={() => useAiServiceHealthStore.getState().dismiss()}
      >
        <FiX size={14} aria-hidden />
      </button>
    </div>
  );
}
