// The proactive "you're running out — switch accounts" banner.
//
// Presentational only: all policy (when to warn, where to go) lives in services/headroom, and the
// execution schedule lives in services/accountSwitch. This renders the recommendation and the
// in-progress state, and nothing else.
//
// Once a switch is accepted (or an observed wall triggers an automatic one) it reports progress
// rather than disappearing, because the switch is NOT instantaneous by design — busy agents migrate
// as their turns end, so the notice stays up while that happens.
import { AGENT_STATUS } from "@sparkle/ui";
import { accountSentenceName, type Account, type AccountDisplay } from "../services/accountStore";
import { describeRecommendation, type SwitchRecommendation } from "../services/headroom";
import type { SwitchPlan } from "../services/accountSwitch";

export interface AccountSwitchBannerProps {
  recommendation: SwitchRecommendation | null;
  plan: SwitchPlan | null;
  /** The honest identity of an account (see `accountDisplay`). NOT a `(a) => string` labeller: the
   *  RECOMMENDATION branch moves the user's work between real Anthropic logins, so it must never
   *  name an account by a nickname it cannot verify. */
  display: (a: Account) => AccountDisplay;
  /** The nickname of the account an in-progress auto-switch is moving TO. Resolved by the host from
   *  the plan's real target account, so it is the friendly name the user assigned — shown on the
   *  progress notice at the founder's request. Null when the host cannot resolve it. */
  targetName?: string | null;
  onAccept: () => void;
  onDismiss: () => void;
  /** Open the Accounts settings screen — the "Manage" link on the progress notice. */
  onManage?: () => void;
  /** Hide the in-progress notice. Does NOT cancel the migration (that runs on its own schedule); it
   *  only dismisses the banner, like the warning banners' ✕. */
  onDismissProgress?: () => void;
}

const wrap: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "10px 14px",
  fontSize: 13,
  lineHeight: 1.4,
  borderBottom: "1px solid rgba(255,255,255,0.08)",
};

const btn: React.CSSProperties = {
  padding: "5px 12px",
  fontSize: 12,
  borderRadius: 6,
  border: "1px solid currentColor",
  background: "transparent",
  color: "inherit",
  cursor: "pointer",
  whiteSpace: "nowrap",
};

// The auto-switch progress bar: a solid brand-green bar with black text (founder request). #34c759
// is the constant brand green; black on it clears WCAG AA comfortably (~9:1).
const SWITCH_GREEN = "#34c759";

const progressWrap: React.CSSProperties = {
  ...wrap,
  background: SWITCH_GREEN,
  color: "#000",
  borderBottom: "1px solid rgba(0,0,0,0.15)",
};

// "Manage" — a link, not a button box, in the same black as the text.
const manageLink: React.CSSProperties = {
  background: "transparent",
  border: "none",
  padding: 0,
  margin: 0,
  color: "#000",
  font: "inherit",
  fontWeight: 600,
  textDecoration: "underline",
  cursor: "pointer",
  whiteSpace: "nowrap",
};

// The dismiss ✕, pinned to the far right (mirrors the warning banners).
const dismissX: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "#000",
  fontSize: 15,
  lineHeight: 1,
  cursor: "pointer",
  padding: "0 2px",
};

export function AccountSwitchBanner({
  recommendation,
  plan,
  display,
  targetName,
  onAccept,
  onDismiss,
  onManage,
  onDismissProgress,
}: AccountSwitchBannerProps) {
  if (plan) {
    // n = how many agents this switch is moving. Constant across the migration (agents leave the
    // `pending` list and join `moved`, but the total is what the sentence names).
    const n = plan.pending.length + plan.moved.length;
    return (
      <div role="status" style={progressWrap}>
        {/* Left spacer balances the ✕ column so the centered content sits at true center. */}
        <span aria-hidden="true" style={{ flex: 1 }} />
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8, textAlign: "center" }}>
          <span>
            Session limit reached: Automatically switching {n} {n === 1 ? "agent" : "agents"}
            {targetName ? (
              <>
                {" "}
                to <strong>{targetName}</strong>
              </>
            ) : null}
          </span>
          {onManage ? (
            <button type="button" style={manageLink} onClick={onManage}>
              Manage
            </button>
          ) : null}
        </span>
        <span style={{ flex: 1, display: "flex", justifyContent: "flex-end" }}>
          {onDismissProgress ? (
            <button type="button" aria-label="Dismiss" style={dismissX} onClick={onDismissProgress}>
              ✕
            </button>
          ) : null}
        </span>
      </div>
    );
  }

  if (!recommendation) return null;

  return (
    <div role="alert" style={{ ...wrap, color: AGENT_STATUS.waiting.color }}>
      <span style={{ flex: 1 }}>{describeRecommendation(recommendation, display)}</span>
      <button type="button" style={btn} onClick={onAccept}>
        Switch to {accountSentenceName(display(recommendation.to))}
      </button>
      <button type="button" style={{ ...btn, opacity: 0.7 }} onClick={onDismiss}>
        Not now
      </button>
    </div>
  );
}
