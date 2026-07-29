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
// of service failures (never a lone blip).
//
// HOW IT RETIRES — and this is NOT simply "the instant any call succeeds", which is what this
// comment used to claim. Only the UNCACHED `chatOnce` may report a success: judge, naming and
// attention run `cacheable: true`, and a cache hit never touches the CLI, so a success from one
// would prove nothing (see anthropic.ts's contract block). `chatOnce`'s only caller is the
// learned-suggestions tier, which the user can switch off — so the banner also retires on a
// TIME-BASED expiry (SERVICE_DEGRADED_MAX_AGE_MS), re-evaluated on the ticker below. That expiry
// retires the DISPLAY only; the dismissal below lives with the failure RUN, not with this claim.
//
// Copy rules, learned from the sibling banners:
//   • name no PII and no raw error — the store only ever holds a coarse reason;
//   • don't blame the user's network (OfflineBanner's job) or balance (ZeroCreditBanner's);
//   • say the feature is affected, plainly — a silent degrade is what made the outage invisible.
// Unlike ProviderUnavailableBanner it IS dismissible: the user cannot fix this, but the retry path
// keeps working underneath, so a ✕ that hides the nag for the episode is reasonable. A later,
// DISTINCT outage re-arms it. What ends an episode is stated once, as a table, on `AiServiceHealth`
// in the store — read it there rather than trusting a summary here; four commits running, every
// prose restatement of that table has dropped a row. The one thing worth repeating at this call
// site: the claim expiry above does NOT end the episode. Clearing the dismissal on it made the bar
// un-dismissable, because a continuing run is already past the threshold and `degraded` came
// straight back on the same failure.
import { useEffect, useState, type CSSProperties } from "react";
import { FiAlertTriangle, FiX } from "react-icons/fi";
import { C, ON_BRAND_FILL_DARK } from "../theme/colors";
import { FONT_WEIGHT } from "@sparkle/ui";
import { FONT_UI } from "../theme/scale";
import {
  isServiceDegraded,
  useAiServiceHealthStore,
  type AiServiceReason,
} from "../stores/aiServiceHealthStore";

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
  const health = useAiServiceHealthStore((s) => s);
  // Re-evaluate on a ticker, exactly as ProviderUnavailableBanner does — and for the same reason,
  // which bites harder here. `Date.now()` inside the selector only recomputes when the store
  // notifies or something else re-renders us; in precisely the scenario the expiry exists for (the
  // CLI is fixed, so no failures are recorded and no success is reported) the store never changes
  // again, so the banner would assert a stale degradation until an unrelated render happened to
  // run — which on an idle screen can mean forever. A minute is far finer than the 10-minute
  // expiry. Unconditional, so the hook order never changes.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  const degraded = isServiceDegraded(health, now);
  const dismissed = health.dismissed;
  const reason = health.reason;

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
