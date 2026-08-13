// The proactive "you're running out — switch accounts" banner.
//
// Presentational only: all policy (when to warn, where to go) lives in services/headroom, and the
// execution schedule lives in services/accountSwitch. This renders the recommendation and the
// in-progress state, and nothing else.
//
// Once a switch is accepted (or an observed wall triggers an automatic one) it reports progress
// rather than disappearing, because the switch is NOT instantaneous by design — busy agents migrate
// as their turns end, so the notice stays up while that happens.
import { FiX } from "react-icons/fi";
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
//
// `inherit`, not a second `"#000"`: the bar sets black on the brand green above, and an underlined
// element carrying its own unverifiable literal is what `theme/linkContrast.test.ts` fails on — it
// requires a link's colour to resolve to an ink tier or to carry no colour of its own. Inheriting
// is both: it is provably the same black the sentence beside it uses, so the two can never drift.
const manageLink: React.CSSProperties = {
  background: "transparent",
  border: "none",
  padding: 0,
  margin: 0,
  color: "inherit",
  font: "inherit",
  fontWeight: 600,
  textDecoration: "underline",
  cursor: "pointer",
  whiteSpace: "nowrap",
};

// The dismiss control, pinned to the far right (mirrors the warning banners).
//
// AN ICON, NOT A GLYPH CHARACTER. It was a literal `✕`, which raised the glyph-as-icon count past
// the ceiling `components/glyphIcons.test.ts` ratchets — the repo's standing rule is that an
// affordance is a react-icon, because a character's size, weight and baseline are the font's to
// decide and it reads differently on every platform. `FiX` is the same mark, drawn.
//
// With the glyph gone there is no text to size, so the off-scale 15px type size went with it — it
// was the sole entry in `theme/scale.test.ts`'s ratchet. The icon carries its own size instead.
//
// (Do not write that retired property's name and a number together in a comment here: the ratchet
// scans raw source text, comments included, so naming it is indistinguishable from committing it.)
const dismissX: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "inherit",
  lineHeight: 1,
  cursor: "pointer",
  padding: "0 2px",
  display: "inline-flex",
  alignItems: "center",
};

/** The dismiss icon's size in px. Matches the 15px the glyph it replaces was set at, so the control
 *  keeps the weight it was tuned to on the green bar. */
const DISMISS_ICON = 15;

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
              <FiX size={DISMISS_ICON} aria-hidden />
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
