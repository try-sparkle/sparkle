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
// comment once claimed. A success must come from a REAL `claude` spawn: judge, naming and attention
// run `cacheable: true`, and a cache hit never touches the CLI, so a success inferred from one
// would prove nothing (see anthropic.ts's contract block). Rust makes that distinction and emits
// `ai://spawn-ok` only for a real child, so all four callers can retire this banner — not just the
// uncached `chatOnce`. The banner ALSO retires on a TIME-BASED expiry
// (SERVICE_DEGRADED_MAX_AGE_MS), re-evaluated on the ticker below, which covers a session that
// simply stops calling the CLI at all. That expiry retires the DISPLAY only; the dismissal below
// lives with the failure RUN, not with this claim.
//
// Copy rules, learned from the sibling banners:
//   • name no PII and no raw error — the store only ever holds a coarse reason;
//   • don't blame the user's network (OfflineBanner's job) or balance (ZeroCreditBanner's);
//   • say the feature is affected, plainly — a silent degrade is what made the outage invisible;
//   • DO NOT SAY "the AI service". That phrase is a leftover from the proxy era and it is now
//     false: since the Claude Code migration these calls run on the USER'S OWN `claude` CLI, and
//     there is no Sparkle-hosted AI service in this path to be down. On 2026-08-02 a user whose own
//     Claude allowance was spent read "the AI service is rate-limited" as "Sparkle is broken" and
//     filed a P0 against a backend that was answering 200 on every probe for the whole window.
//     Name the thing that is actually failing — Claude Code, on their machine, on their account.
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
import { selectAiEnhancedBlocked, useBlockedSubsystemsStore } from "../stores/blockedSubsystemsStore";

/** One sentence per coarse reason. Both open with the same plain statement that the features are
 *  affected, then add the coarse cause without a raw status or any PII — and both attribute it to
 *  Claude Code rather than to a Sparkle service, per the attribution rule in the header. */
const WARNING: Record<AiServiceReason, string> = {
  unreachable:
    "AI-Enhanced features are paused — Sparkle isn't getting a reply from Claude Code right now. We keep retrying automatically",
  rate_limited:
    "AI-Enhanced features are paused — Claude is rate-limiting Sparkle's requests right now. We keep retrying automatically",
};

// Brand amber is the theme-CONSTANT caution fill, so its ink is the constant brand navy (matching
// ZeroCreditBanner / ProviderUnavailableBanner) rather than the themed cream.
const INK = ON_BRAND_FILL_DARK;

/** The full-width bar's hook, so a real-layout test can measure the element the user sees. */
export const AI_SERVICE_BAR_TESTID = "ai-service-bar";

/** See BANNER_BAR_TOP_ANCHOR in ProviderUnavailableBanner — the three bars share this shape, so a
 *  fix that left this one centred would be half a fix. This bar carries the LONGEST sentence of the
 *  three, so it is the first to wrap and the one with the most lines to lose off the top. */
const sentence: CSSProperties = {
  minWidth: 0,
  overflowWrap: "break-word",
};

const bar: CSSProperties = {
  flex: "0 0 auto",
  display: "flex",
  // TOP-ANCHORED, not centred — see BANNER_BAR_TOP_ANCHOR in ProviderUnavailableBanner.
  alignItems: "flex-start",
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

  // WORST-CONDITION PRECEDENCE, narrowed to this bar's SUBJECT. This bar is about AI-Enhanced
  // features (on the default account). When AI-Enhanced is COMPLETELY BLOCKED (a session/usage limit
  // exhausted), BlockedAgentsBanner shows the red "Blocked due to session limits …" bar naming it,
  // which is strictly worse than this amber "paused, we keep retrying" one about the very same thing
  // — so the amber bar steps aside (the founder's complaint was a total block read as a soft
  // degrade). It is keyed on AI-Enhanced specifically, NOT on "anything blocked": a build agent
  // benched on an unrelated pool account must not hide a genuine, separate AI-Enhanced outage on the
  // default account. The store is empty unless BlockedAgentsBanner is mounted and polling, so this
  // changes nothing on a surface that renders this bar alone.
  const aiEnhancedBlocked = useBlockedSubsystemsStore(selectAiEnhancedBlocked);

  // Show only while a SUSTAINED outage is recorded, AI-Enhanced is not already shown as blocked, and
  // the user hasn't dismissed THIS episode. `reason` is always set once `degraded` is true, but guard
  // anyway so a partial state can never throw.
  if (aiEnhancedBlocked || !degraded || dismissed || reason === null) return null;

  return (
    <div style={bar} data-testid={AI_SERVICE_BAR_TESTID}>
      {/* `marginTop: 1` restores the 1px that `align-items: center` used to supply on a
          single-line bar; see the icon note in ProviderUnavailableBanner. */}
      <FiAlertTriangle size={14} style={{ flex: "none", marginTop: 1 }} aria-hidden />
      {/* The live region wraps ONLY the sentence — with the ✕ inside it some screen readers
          re-announce the whole warning on the button's focus/state changes. */}
      <span role="status" aria-live="polite" style={sentence}>
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
