// ProviderUnavailableBanner — names WHY AI enhancement is unavailable, so a total outage is never
// silent again.
//
// It reads aiProviderStore, which since the Claude Code migration holds reasons about the USER'S own
// CLI (missing, not signed in, at its usage limit) rather than Sparkle's retired vendor account. The
// consequence for copy is the whole point: every reason now has an action attached, where the old
// ones could only say "this is ours to fix". See the WARNING map below.
import { useEffect, useState, type CSSProperties } from "react";
import { FiAlertTriangle } from "react-icons/fi";
import { C, ON_BRAND_FILL_DARK } from "../theme/colors";
import { FONT_WEIGHT } from "@sparkle/ui";
import { FONT_UI } from "../theme/scale";
import {
  isOutageActive,
  useAiProviderStore,
  type AiProviderOutageReason,
} from "../stores/aiProviderStore";

/**
 * The sentence for each reason.
 *
 * REWRITTEN with the transport. These used to say "this is ours to fix" and told the user to do
 * nothing, because the cause was Sparkle's own unfunded vendor account. AI enhancement now runs on
 * the USER'S Claude Code subscription, so every remaining cause is one they CAN fix — and the copy
 * has to say how. Each line names the cause and the next action, and none of them mentions Sparkle
 * credits, which are no longer involved in these features at all.
 *
 * Deliberately NOT dismissible, unlike ZeroCreditBanner. It clears itself the moment any AI call
 * succeeds (aiProviderStore.noteHealthy), so a ✕ would only re-hide the kind of outage that went
 * unnoticed for 12 hours in the first place.
 */
const WARNING: Record<AiProviderOutageReason, string> = {
  cli_missing:
    "Sparkle's AI features need the Claude Code CLI, and it isn't installed. Install it and they'll turn back on",
  cli_not_authenticated:
    "Claude Code isn't signed in, so Sparkle's AI features are paused. Run `claude` in a terminal and sign in",
  usage_limit:
    "Your Claude usage limit has been reached, so Sparkle's AI features are paused. They'll resume when it resets",
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
  fontFamily: FONT_UI,
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
