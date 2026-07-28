// The concierge column's AI-ENHANCEMENTS LOCKED STATE: what stands where the thread and the
// compose box would be when the paid half of the column isn't running.
//
// The approved design keeps the FREE half and locks only the paid one. Everything above this panel
// — the scope line, the needs-you counts, the per-project segments — is derived from local app
// state, costs nothing to run, and stays live (ConciergeColumn deliberately does NOT gate it). So
// the upsell sits directly beside live proof of its own value: three agents are waiting on you
// right there, and this is the thing that would answer them.
//
// The ACTION is the part that has to be right. Which of the three reasons we're in decides it (see
// ./conciergeAiLock): a switched-off setting is fixed in settings, not at a checkout; an unbought
// app is the existing $99 AiLockedNotice; an empty balance on a bought app is the existing Refill
// seam and must NEVER show a buy-the-app upsell. We reuse both of those components rather than
// growing private copies of them here.
import type { CSSProperties } from "react";

import { C, FONT_WEIGHT, ON_BRAND_FILL } from "../../theme/colors";
import { useUiStore } from "../../stores/uiStore";
import { AiEnhancementsBadge } from "../AiEnhancementsBadge";
import { AiLockedNotice } from "../AiLockedNotice";
import { RefillLink } from "../OutOfCreditsNotice";
import type { ConciergeAiLockReason } from "./conciergeAiLock";

/** The pitch, in the founder's words. Exported so tests (and any future surface that says the same
 *  thing) assert against the one string rather than a copy of it. */
export const CONCIERGE_AI_PITCH =
  "Your concierge can read these terminals, answer them, and drive the app for you.";

const wrap: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: "auto",
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
  gap: 12,
  padding: "16px 16px 20px",
  // The mock's rule between the live status readout above and the locked half below. `hairline` is
  // the token held to a visible floor on every plane in both themes (see theme/colors).
  borderTop: `1px solid ${C.hairline}`,
};

const pitch: CSSProperties = {
  margin: 0,
  color: C.cream,
  fontSize: 13,
  lineHeight: 1.5,
};

const settingsBtn: CSSProperties = {
  background: C.teal,
  color: ON_BRAND_FILL,
  border: "none",
  borderRadius: 4,
  padding: "8px 14px",
  fontSize: 12,
  fontWeight: FONT_WEIGHT.semibold,
  cursor: "pointer",
  fontFamily: '"IBM Plex Sans", sans-serif',
  whiteSpace: "nowrap",
};

const refillLine: CSSProperties = {
  margin: 0,
  color: C.muted,
  fontSize: 12,
  lineHeight: 1.5,
};

export function ConciergeAiLocked({ reason }: { reason: ConciergeAiLockReason }) {
  return (
    <div
      data-testid="concierge-ai-locked"
      role="region"
      aria-label="Sparkle AI enhancements"
      style={wrap}
    >
      <AiEnhancementsBadge />
      <p style={pitch}>{CONCIERGE_AI_PITCH}</p>
      {reason === "flag_off" && (
        // A SETTING, not a sale. Deep-opens the ⋯ Settings dialog on its AI-features pane — the
        // same `uiStore.openSettings` seam BalanceBadge and RefillLink use.
        <button
          type="button"
          style={settingsBtn}
          onClick={() => useUiStore.getState().openSettings("ai")}
        >
          Turn on AI enhancements
        </button>
      )}
      {reason === "not_entitled" && (
        <AiLockedNotice
          label="Buy Sparkle to talk to your concierge."
          style={{ alignSelf: "stretch" }}
        />
      )}
      {reason === "no_credits" && (
        // Bought, but empty. The credit flow, and deliberately no $99 anywhere on this branch.
        <p style={refillLine}>
          You are out of AI credits. <RefillLink /> to bring your concierge back.
        </p>
      )}
    </div>
  );
}
