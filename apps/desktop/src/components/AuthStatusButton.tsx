import { type CSSProperties } from "react";
import { C, ON_BRAND_FILL } from "../theme/colors";
import { useAuthStore } from "../stores/authStore";
import { useTrialStore } from "../stores/trialStore";
import { useUiStore } from "../stores/uiStore";
import { useSocialStore } from "../stores/socialStore";
import { availabilityFromWire } from "../engine/social";
import { deriveAuthControl, authIdentity } from "../services/entitlement";
import { availabilityLabel } from "./AvailabilityDot";
import { PersonAvatar } from "./PersonAvatar";
import { FONT_UI } from "../theme/scale";

// The user's own avatar disc, sized to sit inline with the header's pill buttons.
//
// THE DISC AND ITS DOT ARE `PersonAvatar`, NOT A HAND-PLACED PAIR. Design §10 fixes the overlap
// ratio inside that component precisely so a chat row at 18 and this button at 28 can never
// disagree about where the dot sits: the correct offset is a function of BOTH diameters
// (`availabilityDotOffset`), so a literal copied from the row would be silently wrong here. We pass
// `size` and let it do the geometry. It also keeps the teal fill and cream ink this button had.
const AVATAR_SIZE = 28;

// Matches TopBar's `btn` pill (same border/radius/padding/type) so the signed-out Log in / Sign
// up control lines up with Recent / Open.
const pill: CSSProperties = {
  background: "transparent",
  color: C.cream,
  border: `1px solid ${C.muted}`,
  borderRadius: 6,
  padding: "6px 12px",
  cursor: "pointer",
  fontSize: 13,
  fontFamily: FONT_UI,
  whiteSpace: "nowrap",
};

/**
 * Profile / auth-status control that lives immediately to the RIGHT of the ⋯ menu. One slot, three
 * states, all routing into the ⋯ menu via `uiStore.openSettings(...)`, the same deep-open seam
 * BalanceBadge uses for Credits (KebabMenu watches `settingsRequest`, opens the SettingsDialog, and
 * passes the category as `initialCategory`):
 *   - signed in  → a circular avatar showing the first letter of the user's identity, carrying
 *                  their own availability dot, opening **Chat** settings
 *   - returning  → "Log in"  (token-less but the app has seen this person — trial started)
 *   - brand-new  → "Sign up" (the first-run "welcome" condition: no token, no trial ever)
 * Reactive: subscribes to the auth + trial + social stores, so it flips the instant sign-in state
 * or availability changes, without a manual refresh.
 *
 * ══ THE SIGNED-IN CLICK GOES TO CHAT, NOT ACCOUNTS ═════════════════════════════════════════════
 * The founder's words (design §1): *"When I click on my avatar circle, it takes me to my settings
 * page, where it lets me set my status."* The dot is on this button, so the control that changes it
 * has to be one click away from the dot — landing on Accounts would mean seeing your own status and
 * then hunting the rail for where to change it. Accounts is unchanged for the two SIGNED-OUT
 * variants (their one action is sign-in) and is still one rail click away here.
 *
 * ══ THE AVAILABILITY IS IN THE ACCESSIBLE NAME, NOT ONLY IN THE DOT ════════════════════════════
 * `PersonAvatar` names the availability in its own `aria-label`, and that name is INERT here: this
 * is a `button` with an `aria-label` of its own, and a button's accessible name comes from its
 * label rather than its contents. So the word has to be repeated onto the button or a screen-reader
 * user gets colour and nothing else — the exact WCAG 1.4.1 failure `AvailabilityDot`'s header is
 * about. Hence "Account: Ada — Available".
 *
 * ══ THE DOT IS ONLY AS GOOD AS `socialStore.me`, WHICH NOTHING HYDRATES YET ════════════════════
 * `socialStore` is deliberately not persisted, and `socialApi` has no read of the signed-in user's
 * OWN profile — no `/me`. (It has other reads; `getUser` is a lookup of ANOTHER handle by name, and
 * the user's own handle is precisely what is unknown, so it cannot serve as one.) So `me.visibility`
 * starts at `unavailable` on every launch and this dot reads **Offline** — including for someone the
 * server holds as `public` — and **the only thing that moves it is the user choosing an availability
 * in the Chat pane.** Merely opening that pane hydrates nothing; do not read this comment as "it
 * self-corrects once you navigate there".
 *
 * It is the fail-CLOSED direction, and it is the same default `socialStore` uses everywhere, so
 * nothing here claims a reachability that is not there; but it IS a stale reading until U1's
 * `services/socialSync` hydrates `me` from `/me` on connect. Do not paper over it with a second
 * fetch from this button: one hydration path, in the file that owns it (roborev 60396, 60415).
 */
export function AuthStatusButton() {
  const me = useAuthStore((s) => s.me);
  const tokenPresent = useAuthStore((s) => s.tokenPresent);
  const authLoading = useAuthStore((s) => s.loading);
  const trialStarted = useTrialStore((s) => s.started);
  const trialLoading = useTrialStore((s) => s.loading);
  const visibility = useSocialStore((s) => s.me.visibility);

  const state = deriveAuthControl({
    loading: authLoading,
    hasToken: tokenPresent,
    me,
    trialStarted,
    trialLoading,
  });

  // The two signed-OUT variants still land on Accounts: there is a single auth action there today
  // (openSignIn → the web Clerk callback handles both sign in and sign up).
  const openAccounts = () => useUiStore.getState().openSettings("accounts");
  // The signed-in avatar lands on Chat — the same deep-open seam, a different category. Calling
  // `openSettings` directly rather than dispatching `sparkle:open-social-settings`: this file
  // already holds the seam, and the event exists for producers that must not depend on the dialog.
  const openChatSettings = () => useUiStore.getState().openSettings("chat");

  // Nothing to show until we know the state (avoids a flash of the wrong control on boot).
  if (state === "loading") return null;

  if (state === "signedIn") {
    const who = authIdentity(me);
    // `online: true` is not a guess about a socket — the app is open in front of the person whose
    // avatar this is, so for the SELF view the only variable left is their own durable intent,
    // which is the thing this button navigates to. Reusing `availabilityFromWire` rather than
    // re-deriving the rule keeps the self dot and a peer's dot agreeing on what `unavailable`
    // looks like.
    const availability = availabilityFromWire({ visibility, online: true });
    const label = `${who ? `Account: ${who}` : "Account"} — ${availabilityLabel(availability)}`;
    return (
      <button
        type="button"
        aria-label={label}
        title={label}
        onClick={openChatSettings}
        style={{
          display: "inline-flex",
          background: "transparent",
          border: "none",
          padding: 0,
          cursor: "pointer",
        }}
      >
        {/* An empty name is passed through deliberately: `PersonAvatar` renders the neutral person
            glyph (never an emoji) rather than a placeholder letter, so a user whose /me degraded
            gets a clean circle instead of an initial that belongs to nobody. */}
        <PersonAvatar
          name={who ?? ""}
          availability={availability}
          size={AVATAR_SIZE}
          ringColor={C.conciergeSurface}
        />
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
