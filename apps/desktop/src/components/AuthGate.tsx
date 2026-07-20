// Gates the whole app behind a Clerk account + the $99 paywall (design spec §8). Wraps
// <Workspace/>. State comes from authStore; the view is derived by the pure deriveAuthView.
//
// Flow: button opens the system browser to the web sign-in → Clerk → the web app deep-links
// back as sparkle://auth?code=… → Rust forwards it as a "deep-link" event → we redeem the
// one-time code (bearer is stored in the Rust keychain) → re-fetch entitlement.

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { C, ON_BRAND_FILL, DANGER } from "../theme/colors";
import { useAuthStore } from "../stores/authStore";
import { useTrialStore, TRIAL_LIMIT } from "../stores/trialStore";
import { WelcomeScreen } from "./WelcomeScreen";
import { TrialChrome } from "./TrialChrome";
import {
  deriveAuthView,
  isNoPendingSignIn,
  parseAuthCode,
  parseAuthState,
} from "../services/entitlement";
import { safeUnlisten } from "../services/safeUnlisten";
import { exchangeCode } from "../services/sparkleApi";
import {
  checkoutOrWebPaywall,
  webPaywallHandoff,
  signInHandoff,
  performTrialUnlock,
} from "../services/trialUnlock";
import { PromoRedeem } from "./PromoRedeem";

// Extracted to its own file for reuse in the Credits settings pane; re-exported so existing
// imports (incl. AuthGate.promo.test.tsx) keep resolving from here.
export { PromoRedeem } from "./PromoRedeem";

const screen: CSSProperties = {
  position: "fixed",
  inset: 0,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 16,
  background: C.forest,
  color: C.cream,
  padding: 32,
  textAlign: "center",
  zIndex: 9999,
};

const primaryBtn: CSSProperties = {
  background: C.teal,
  color: ON_BRAND_FILL,
  border: "none",
  borderRadius: 8,
  padding: "12px 22px",
  fontSize: 16,
  fontWeight: 600,
  cursor: "pointer",
  fontFamily: '"IBM Plex Sans", sans-serif',
};

const linkBtn: CSSProperties = {
  background: "transparent",
  color: C.muted,
  border: "none",
  cursor: "pointer",
  fontSize: 13,
  textDecoration: "underline",
};

function Screen({ children }: { children: ReactNode }) {
  return <div style={screen}>{children}</div>;
}

/** Shown when the system-browser hand-off couldn't launch: tells the user what happened and gives
 *  them the URL to open manually (selectable so they can copy it) so they're never fully stuck. */
function LaunchFallback({ url }: { url: string }) {
  return (
    <p style={{ color: DANGER, fontSize: 13, margin: 0, maxWidth: 420 }} role="alert">
      Couldn&apos;t open your browser. Open this link manually:{" "}
      <span style={{ color: C.cream, userSelect: "text", wordBreak: "break-all" }}>{url}</span>
    </p>
  );
}

export function AuthGate({ children }: { children: ReactNode }) {
  const { me, tokenPresent, loading, refresh, paywallDismissed, setPaywallDismissed } =
    useAuthStore();
  const trialStarted = useTrialStore((s) => s.started);
  const trialLoading = useTrialStore((s) => s.loading);
  const trialError = useTrialStore((s) => s.error);
  const promptsUsed = useTrialStore((s) => s.promptsUsed);
  const refreshTrial = useTrialStore((s) => s.refresh);
  const startTrial = useTrialStore((s) => s.start);
  // De-dupe URLs across the two delivery paths (the live "deep-link" event and the
  // cold-launch pending-drain), so one link is never processed twice.
  const processedUrls = useRef<Set<string>>(new Set());
  // Set when an auth callback arrived with no in-flight sign-in to bind it to (the user quit
  // mid-sign-in; the relaunching deep link can't complete against a fresh process — Rust returns
  // NO_PENDING_SIGNIN). Rather than swallow it, we surface a "sign-in didn't finish — try again"
  // banner on the Welcome screen; the existing Sign in button re-initiates a fresh flow.
  const [signInInterrupted, setSignInInterrupted] = useState(false);

  // Initial load + listen for the deep-link hand-off and window focus.
  useEffect(() => {
    const seen = processedUrls.current;
    // Process a deep link: redeem its one-time code (if any), then re-read entitlement. The
    // no-code case (sparkle://auth after payment) just needs the refresh.
    const handleUrl = async (url: string) => {
      if (seen.has(url)) return;
      seen.add(url);
      const code = parseAuthCode(url);
      if (code) {
        try {
          // Pass the echoed `state` so Rust can bind this callback to the sign-in this instance
          // started; a planted code (mismatched/absent state) is rejected before the exchange.
          await exchangeCode(code, parseAuthState(url));
          // A fresh success clears any prior "sign-in didn't finish" banner.
          setSignInInterrupted(false);
        } catch (e) {
          // Distinguish the RECOVERABLE quit-mid-sign-in case (no in-flight sign-in to bind this
          // callback to) from a genuine state mismatch / expired code. The former is not the user's
          // fault and is trivially fixable by starting sign-in again — surface a clear banner rather
          // than dead-ending silently. Other failures just leave us unauthenticated (refresh below).
          if (isNoPendingSignIn(e)) setSignInInterrupted(true);
        }
      }
      await refresh();
    };

    void refresh();
    void refreshTrial();
    // Cold-launch: drain any link that arrived before this listener attached.
    void invoke<string | null>("desktop_take_pending_deeplink")
      .then((url) => {
        if (url) void handleUrl(url);
      })
      .catch(() => {});

    const unlistenDeepLink = listen<string>("deep-link", (event) => {
      void handleUrl(event.payload);
    });

    // Refresh on focus only while NOT yet entitled (to catch the sign-in/payment transition).
    // Once entitled, stop — otherwise every app refocus would hit /me indefinitely.
    const onFocus = () => {
      if (!useAuthStore.getState().me?.entitled) void refresh();
    };
    window.addEventListener("focus", onFocus);

    return () => {
      void safeUnlisten(unlistenDeepLink);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh, refreshTrial]);

  // When the system-browser hand-off can't launch (no default browser, opener-scope denial, …), the
  // shared primitives resolve false and report the copy/paste URL through this setter (rendered as a
  // LaunchFallback below) rather than leaving the user on a dead button.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);

  // All three "convert" entry points delegate to the shared primitives in trialUnlock.ts — the SAME
  // ones the in-bar TopBar TrialIndicator uses — so the checkout / sign-in behavior (incl. the
  // fallback URLs) lives in ONE place and the two surfaces can't drift.
  //   • Welcome sign-in. Clears the "sign-in didn't finish" banner up front — the user is starting a
  //     brand-new flow, which mints a fresh pending sign-in in Rust.
  const handleSignIn = () => {
    setSignInInterrupted(false);
    void signInHandoff(setFailedUrl);
  };
  //   • "Pay $99": signed-in → one-click Stripe (falling back to the web paywall); signed-out → the
  //     web paywall directly, since there's no bearer to create a checkout session.
  const handlePay = () =>
    void (tokenPresent ? checkoutOrWebPaywall(setFailedUrl) : webPaywallHandoff(setFailedUrl));
  //   • Trial "Unlock" (exhausted upsell + in-bar): signed-in → checkout, signed-out → sign-in.
  const handleTrialUnlock = () => void performTrialUnlock(tokenPresent, setFailedUrl);

  // Trial prompts still available to fall back to (device-local meter, independent of payment).
  const trialRemaining = Math.max(0, TRIAL_LIMIT - promptsUsed);
  // Escape hatch: a signed-in-but-unpaid user who started the trial and still has prompts can
  // dismiss the unlock screen and return to the trial workspace. The dismissed flag is LATCHED
  // (not the live count) so exhausting the last prompt hands off to TrialChrome's own exhausted
  // upsell instead of snapping back to this screen. It lives in authStore (not local state) so the
  // TopBar's independent deriveAuthView agrees and keeps showing the in-bar trial counter.
  const view = deriveAuthView({
    loading,
    hasToken: tokenPresent,
    me,
    trialStarted,
    trialLoading,
    paywallDismissed,
  });

  if (view === "entitled") return <>{children}</>;

  if (view === "trial") {
    // The Workspace runs in free mode. The small "N prompts left" counter + Unlock now live INSIDE
    // the TopBar (TrialIndicator), so they can't cover the action buttons. TrialChrome here is only
    // the full-screen upsell shown once the 100 prompts are spent (a no-op until then; the Workspace
    // stays mounted underneath so running workers survive until the user converts).
    return (
      <>
        {children}
        <TrialChrome onUnlock={handleTrialUnlock} signInFailedUrl={failedUrl} />
      </>
    );
  }

  if (view === "loading") {
    return (
      <Screen>
        <p style={{ color: C.muted }}>Loading…</p>
      </Screen>
    );
  }

  if (view === "unpaid") {
    return (
      <Screen>
        <h1 style={{ fontSize: 28, margin: 0 }}>Unlock Sparkle</h1>
        <p style={{ color: C.muted, maxWidth: 420 }}>
          One-time <strong style={{ color: C.cream }}>$99</strong> — includes{" "}
          <strong style={{ color: C.cream }}>$200 of AI credits</strong> to power building and
          thinking.
        </p>
        <button style={primaryBtn} onClick={() => void handlePay()}>
          Pay $99 &amp; get $200 in credits
        </button>
        {failedUrl && <LaunchFallback url={failedUrl} />}
        <button style={linkBtn} onClick={() => void refresh()}>
          I already paid — refresh
        </button>
        <PromoRedeem refresh={refresh} />
        {trialStarted && trialRemaining > 0 && (
          <button style={linkBtn} onClick={() => setPaywallDismissed(true)}>
            Nevermind, I want to stay on the free trial and use the {trialRemaining} prompt
            {trialRemaining === 1 ? "" : "s"} I have left.
          </button>
        )}
      </Screen>
    );
  }

  // welcome (token-less, trial not yet started). A recoverable failure gets a banner so the user
  // knows what happened and that the same Sign in / Try again buttons will fix it — interrupted
  // sign-in takes precedence over a trial-read failure (it's the more actionable of the two).
  const welcomeBanner = signInInterrupted
    ? "Your sign-in didn't finish. Please sign in again."
    : trialError
      ? "We couldn't load your free-trial status. Sign in or start a new trial to continue."
      : undefined;
  return (
    <WelcomeScreen
      onSignIn={() => void handleSignIn()}
      onTryFree={() => void startTrial()}
      signInFailedUrl={failedUrl}
      banner={welcomeBanner}
    />
  );
}
