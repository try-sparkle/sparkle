// The app-level "$0 credit balance" warning.
//
// Credits — not the one-time $99 — are what keep the AI enhancements alive (see services/aiGate.ts).
// When the balance reaches zero every one of them goes dark at once, and until now the only tells
// were feature-local: the mic refused to arm, autoRename simply stopped happening. This is the one
// place that names the cause and offers the fix.
//
// Two surfaces, ONE component, so the copy can never drift:
//   • the full-width bar at the top of the workspace (default) — dismissible, with Refill;
//   • an inline strip at the top of Settings → Credits (`inline`) — informational only, since a
//     Refill affordance and the balance are already on that pane.
import { type CSSProperties } from "react";
import { FiAlertTriangle, FiX } from "react-icons/fi";
import { C, ON_BRAND_FILL_DARK } from "../theme/colors";
import { FONT_WEIGHT } from "@sparkle/ui";
import { useAuthStore } from "../stores/authStore";
import { useUiStore } from "../stores/uiStore";
import { shouldShowZeroCreditBanner } from "../services/zeroCreditBanner";
import { RefillLink } from "./OutOfCreditsNotice";
import { FONT_UI } from "../theme/scale";

/** The exact sentence, verbatim in both variants. "$0" is a literal, not a formatted balance: the
 *  banner exists only in the balance ≤ 0 case, so the figure is always zero, and a negative ledger
 *  must never render as "-$0.42 remaining". */
const WARNING = "Your Sparkle credit balance is $0. AI Enhanced features will no longer work";

// Brand amber is the caution fill (tokens.ts) and is theme-CONSTANT, so it needs an ink that is
// legible on it in both themes — the constant brand navy, not the themed `C.cream` (which flips to
// navy in light and would be fine, but flips to near-white in dark and would wash out).
const INK = ON_BRAND_FILL_DARK;

/** The full-width bar's hook, so a real-layout test can measure the element the user sees. */
export const ZERO_CREDIT_BAR_TESTID = "zero-credit-bar";

/** See BANNER_BAR_TOP_ANCHOR in ProviderUnavailableBanner — the three bars share this shape, so a
 *  fix that left this one centred would be half a fix. It matters MORE here: the ✕ and the Refill
 *  link eat the width the sentence would otherwise wrap into, so this bar overflows first. */
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
  // WRAPPING THE LINE, and only this bar of the three needs it. `min-width: 0` frees the SENTENCE
  // to wrap, but `RefillLink` is an in-flow flex item that cannot shrink — so once the line's
  // unshrinkable content exceeds the bar, `justify-content: center` pushes it off BOTH ends and
  // the sentence loses its head and its tail. Measured: at 100px this bar rendered 15.3px left of
  // its own padding edge with everything else already fixed. Letting the line wrap drops Refill to
  // a second row instead. No effect at any width where the content fits, so the common case is
  // byte-identical. The sibling bars carry no such item (icon + sentence, and an out-of-flow ✕
  // that is positioned rather than laid out), and both measure clean without it. (roborev 58696)
  flexWrap: "wrap",
  // Positioning context for the ✕. It is pinned out of flow rather than pushed right with
  // `marginLeft: auto`, which absorbed ALL the free space and left `justifyContent: center` with
  // nothing to distribute — the sentence silently went flush-left. (roborev 48271/48284)
  position: "relative",
  gap: 8,
  background: C.amber,
  color: INK,
  // Wide SYMMETRIC padding: it reserves a lane for the out-of-flow ✕ (which no longer pushes
  // content, so the centered sentence + Refill could otherwise run underneath it on a narrow
  // window) while keeping the content box centred on the bar's true middle — asymmetric padding
  // would reserve the lane but shift the copy off-centre. (roborev 52646/52647/53024)
  padding: "6px 32px",
  fontSize: 13,
  fontWeight: FONT_WEIGHT.semibold,
  fontFamily: FONT_UI,
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
  // Pin the ✕ to the bar's right edge — where people hit-scan for a dismiss control — instead of
  // letting it float alongside the centered sentence and drift as the copy wraps. Out of flow, so
  // the sentence stays centered in the FULL bar rather than in the space the ✕ leaves over.
  position: "absolute",
  right: 8,
  top: "50%",
  transform: "translateY(-50%)",
};

/**
 * @param inline Render the compact Settings → Credits variant instead of the full-width top bar.
 */
export function ZeroCreditBanner({ inline = false }: { inline?: boolean } = {}) {
  const me = useAuthStore((s) => s.me);
  const dismissed = useUiStore((s) => s.zeroCreditBannerDismissed);

  // Purely presentational: the zero-CROSSING reset that re-arms a dismissed banner lives in
  // authStore's `syncZeroCreditBanner` (rule in services/zeroCreditBanner), where the balance
  // actually changes. Doing it here as a render effect would only work while this component happened
  // to be mounted — a refill observed during a paywall/gate render would latch the dismissal for the
  // rest of the session.

  // The in-pane variant deliberately ignores the dismissal: the user is LOOKING at their credits,
  // so re-stating why the AI extras are off is context, not nagging. The `!me` clause is redundant
  // with the rule (which returns false for a null `me`) — it is here to NARROW, so the ✕ below can
  // pass a required owner id rather than degrading to null. (roborev 51700/51712)
  if (!me || !shouldShowZeroCreditBanner(me, inline ? false : dismissed)) return null;

  if (inline) {
    return (
      <p style={inlineStrip} role="status">
        <FiAlertTriangle size={14} style={{ flex: "none", marginTop: 2 }} aria-hidden />
        <span>{WARNING}.</span>
      </p>
    );
  }

  return (
    <div style={bar} data-testid={ZERO_CREDIT_BAR_TESTID}>
      {/* `marginTop: 1` restores the 1px that `align-items: center` used to supply on a
          single-line bar; see the icon note in ProviderUnavailableBanner. */}
      <FiAlertTriangle size={14} style={{ flex: "none", marginTop: 1 }} aria-hidden />
      {/* The live region wraps ONLY the sentence. With the buttons inside it, some screen readers
          re-announce the whole warning on focus/state changes of Refill or ✕. */}
      <span role="status" aria-live="polite" style={sentence}>
        {WARNING}.
      </span>
      <RefillLink color={INK} />
      <button
        type="button"
        // BOTH, deliberately: `title` is accname's last-resort name source — absent on touch, not
        // reliably announced, invisible to keyboard users — so a button whose only child is
        // aria-hidden must not depend on it for its name. (A description identical to the computed
        // name is suppressed by ATs, so the pairing costs nothing; the em-dash case differs because
        // there the title sits on an ANCESTOR.) The aria-label matches TerminalDropPill's dismiss
        // control, which carries no tooltip. (roborev 53024/53047)
        aria-label="Dismiss"
        title="Dismiss"
        style={dismissBtn}
        // Dismissals are per-USER: recording whose it is lets a different account signing in at $0
        // get its own warning, without a transient `me` blip resurrecting this one's.
        onClick={() => useUiStore.getState().dismissZeroCreditBanner(me.clerkUserId)}
      >
        <FiX size={14} aria-hidden />
      </button>
    </div>
  );
}
