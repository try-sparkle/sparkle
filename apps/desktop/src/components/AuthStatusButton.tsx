import { type CSSProperties } from "react";
import { FiUser } from "react-icons/fi";
import { C, ON_BRAND_FILL, FONT_WEIGHT } from "../theme/colors";
import { useAuthStore } from "../stores/authStore";
import { useTrialStore } from "../stores/trialStore";
import { useUiStore } from "../stores/uiStore";
import { deriveAuthControl, avatarLetter, authIdentity } from "../services/entitlement";

// A small circular profile avatar (a letter in a disc), sized to sit inline with the TopBar's
// pill buttons. Teal brand fill so it reads as THE user's own icon, cream ink on top (constant
// in both themes, like the "New" button's fill).
const AVATAR_SIZE = 28;
const avatar: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: AVATAR_SIZE,
  height: AVATAR_SIZE,
  borderRadius: "50%",
  background: C.teal,
  color: ON_BRAND_FILL,
  fontSize: 13,
  fontWeight: FONT_WEIGHT.semibold,
  fontFamily: '"IBM Plex Sans", sans-serif',
  lineHeight: 1,
};

// Matches TopBar's `btn` pill (same border/radius/padding/type) so the signed-out Log in / Sign
// up control lines up with Recent / Open.
const pill: CSSProperties = {
  background: "transparent",
  color: C.cream,
  border: `1px solid ${C.muted}`,
  borderRadius: 8,
  padding: "6px 12px",
  cursor: "pointer",
  fontSize: 13,
  fontFamily: '"IBM Plex Sans", sans-serif',
  whiteSpace: "nowrap",
};

/**
 * Profile / auth-status control that lives immediately to the RIGHT of the ⋯ menu. One slot, three
 * states — all routing into the ⋯ menu's Accounts pane via `uiStore.openSettings("accounts")`, the
 * same deep-open seam BalanceBadge uses for Credits (TopBar watches `settingsRequest`, opens the
 * SettingsDialog, and passes the category as `initialCategory`):
 *   - signed in  → a circular avatar showing the first letter of the user's identity
 *   - returning  → "Log in"  (token-less but the app has seen this person — trial started)
 *   - brand-new  → "Sign up" (the first-run "welcome" condition: no token, no trial ever)
 * Reactive: subscribes to the auth + trial stores, so it flips the instant sign-in state changes
 * without a manual refresh.
 */
export function AuthStatusButton() {
  const me = useAuthStore((s) => s.me);
  const tokenPresent = useAuthStore((s) => s.tokenPresent);
  const authLoading = useAuthStore((s) => s.loading);
  const trialStarted = useTrialStore((s) => s.started);
  const trialLoading = useTrialStore((s) => s.loading);

  const state = deriveAuthControl({
    loading: authLoading,
    hasToken: tokenPresent,
    me,
    trialStarted,
    trialLoading,
  });

  // All three variants land on the Accounts pane. There's a single auth action there today
  // (openSignIn → the web Clerk callback handles both sign in and sign up), so we don't split the
  // sub-flow — we only change this control's label/appearance per state.
  const openAccounts = () => useUiStore.getState().openSettings("accounts");

  // Nothing to show until we know the state (avoids a flash of the wrong control on boot).
  if (state === "loading") return null;

  if (state === "signedIn") {
    // Both derive from the SAME authIdentity source, so the letter and the label always agree.
    const letter = avatarLetter(me);
    const who = authIdentity(me);
    const label = who ? `Account: ${who}` : "Account";
    return (
      <button
        type="button"
        aria-label={label}
        title={label}
        onClick={openAccounts}
        style={{
          display: "inline-flex",
          background: "transparent",
          border: "none",
          padding: 0,
          cursor: "pointer",
        }}
      >
        {/* The letter is decorative once aria-label carries the identity; when we have no letter
            we render a neutral person glyph (never an emoji) so the circle is never empty. */}
        <span style={avatar} aria-hidden>
          {letter || <FiUser size={15} />}
        </span>
      </button>
    );
  }

  const label = state === "new" ? "Sign up" : "Log in";
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={openAccounts}
      style={
        state === "new"
          ? { ...pill, borderColor: C.teal, background: C.teal, color: ON_BRAND_FILL }
          : pill
      }
    >
      {label}
    </button>
  );
}
