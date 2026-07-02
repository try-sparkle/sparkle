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
import { deriveAuthView, parseAuthCode, parseAuthState } from "../services/entitlement";
import { safeUnlisten } from "../services/safeUnlisten";
import {
  exchangeCode,
  lastSignInUrl,
  openPaywall,
  openSignIn,
  PAYWALL_URL,
  SIGN_IN_URL,
} from "../services/sparkleApi";
import { openPaywallCheckout, lastCheckoutUrl } from "../services/creditsMenuApi";
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
  const promptsUsed = useTrialStore((s) => s.promptsUsed);
  const refreshTrial = useTrialStore((s) => s.refresh);
  const startTrial = useTrialStore((s) => s.start);
  // De-dupe URLs across the two delivery paths (the live "deep-link" event and the
  // cold-launch pending-drain), so one link is never processed twice.
  const processedUrls = useRef<Set<string>>(new Set());

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
        } catch {
          // expired/used code, or state mismatch — refresh leaves us unauthenticated
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

  // When the system-browser hand-off can't launch (no default browser, opener-scope denial, …),
  // openSignIn/openPaywall resolve false instead of throwing. Remember which URL failed so we can
  // show it as a copy/paste fallback rather than leaving the user on a dead button.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const handOff = async (open: () => Promise<boolean>, url: string) => {
    setFailedUrl(null);
    const ok = await open();
    if (!ok) setFailedUrl(url);
  };

  // Sign-in gets its own handler because the URL is dynamic (it carries the per-attempt state +
  // code_challenge, sparkle-kqg0). On a launch failure we surface the ACTUAL URL just built
  // (lastSignInUrl) — the bare SIGN_IN_URL would be an unbound link the server can't tie to a
  // sign-in — falling back to SIGN_IN_URL only if nothing was built yet.
  const handleSignIn = async () => {
    setFailedUrl(null);
    const ok = await openSignIn();
    if (!ok) setFailedUrl(lastSignInUrl() ?? SIGN_IN_URL);
  };

  // "Pay $99" one-click-to-Stripe. When signed in (a bearer token is present), create the
  // checkout session directly and land on checkout.stripe.com in one click — the same proven path
  // as in-app top-ups. Fall back to the web sign-in→paywall hand-off when signed out, or if the
  // direct checkout throws (server refused, e.g. no bearer) so the pre-auth path never regresses.
  const handlePay = async () => {
    setFailedUrl(null);
    if (tokenPresent) {
      try {
        if (await openPaywallCheckout()) return;
        // The session WAS created but the system browser wouldn't open — offer the real hosted
        // Stripe URL to copy/paste rather than bouncing back to the generic web paywall page.
        const url = lastCheckoutUrl();
        if (url) {
          setFailedUrl(url);
          return;
        }
      } catch (e) {
        console.warn("Direct paywall checkout failed; falling back to the web paywall flow:", e);
      }
    }
    await handOff(openPaywall, PAYWALL_URL);
  };

  // Unlock action for the trial view (also used by the exhausted full-screen upsell). A signed-in
  // (but unpaid) user converts via the one-click Stripe path, NOT bounced back through web sign-in;
  // token-less trial users still need the sign-in hand-off first. AuthGate delegates to its local
  // handlePay/handleSignIn (kept current with the paywall flow); the in-bar TopBar TrialIndicator
  // routes through the shared performTrialUnlock, which mirrors the same checkout-else-sign-in rule.
  const handleTrialUnlock = () => {
    if (tokenPresent) void handlePay();
    else void handleSignIn();
  };

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

  // welcome (token-less, trial not yet started)
  return (
    <WelcomeScreen
      onSignIn={() => void handleSignIn()}
      onTryFree={() => void startTrial()}
      signInFailedUrl={failedUrl}
    />
  );
}
