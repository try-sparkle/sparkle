// The proactive "you're running out — switch accounts" banner.
//
// Presentational only: all policy (when to warn, where to go) lives in services/headroom, and the
// execution schedule lives in services/accountSwitch. This renders the recommendation and the
// in-progress state, and nothing else.
//
// Once a switch is accepted it reports progress rather than disappearing, because the switch is NOT
// instantaneous by design — busy agents migrate as their turns end, so "3 of 7 moved" is the honest
// thing to show while that happens.
import { AGENT_STATUS } from "@sparkle/ui";
import type { Account } from "../services/accountStore";
import { describeRecommendation, type SwitchRecommendation } from "../services/headroom";
import type { SwitchPlan } from "../services/accountSwitch";

export interface AccountSwitchBannerProps {
  recommendation: SwitchRecommendation | null;
  plan: SwitchPlan | null;
  /** Display name for an account — the real logged-in email where known (see `accountLabel`). */
  label: (a: Account) => string;
  onAccept: () => void;
  onDismiss: () => void;
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

export function AccountSwitchBanner({
  recommendation,
  plan,
  label,
  onAccept,
  onDismiss,
}: AccountSwitchBannerProps) {
  if (plan) {
    const total = plan.pending.length + plan.moved.length;
    return (
      <div role="status" style={{ ...wrap, color: AGENT_STATUS.working.color }}>
        <span style={{ flex: 1 }}>
          Switching accounts — {plan.moved.length} of {total} agents moved.{" "}
          {plan.pending.length > 0
            ? "The rest will switch as they finish their current turn, so no work is lost."
            : "Done."}
        </span>
      </div>
    );
  }

  if (!recommendation) return null;

  return (
    <div role="alert" style={{ ...wrap, color: AGENT_STATUS.waiting.color }}>
      <span style={{ flex: 1 }}>{describeRecommendation(recommendation, label)}</span>
      <button type="button" style={btn} onClick={onAccept}>
        Switch to {label(recommendation.to)}
      </button>
      <button type="button" style={{ ...btn, opacity: 0.7 }} onClick={onDismiss}>
        Not now
      </button>
    </div>
  );
}
