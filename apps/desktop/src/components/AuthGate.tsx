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
import { useTrialStore } from "../stores/trialStore";
import { WelcomeScreen } from "./WelcomeScreen";
import { TrialChrome } from "./TrialChrome";
import { deriveAuthView, parseAuthCode } from "../services/entitlement";
import { safeUnlisten } from "../services/safeUnlisten";
import {
  exchangeCode,
  openPaywall,
  openSignIn,
  PAYWALL_URL,
  redeemPromo,
  SIGN_IN_URL,
} from "../services/sparkleApi";

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

const promoInput: CSSProperties = {
  background: C.cream,
  color: C.forest,
  border: `1px solid ${C.muted}`,
  borderRadius: 6,
  padding: "8px 10px",
  fontSize: 14,
  fontFamily: '"IBM Plex Sans", sans-serif',
  width: 160,
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

/** Small "Have a code?" redeemer on the paywall. Forwards the typed code to the server (the code
 *  value never lives in this client); on success it refreshes entitlement so the gate re-derives
 *  to "entitled". Used until real Stripe promo codes land. */
export function PromoRedeem({ refresh }: { refresh: () => Promise<void> }) {
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const trimmed = code.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    setError(null);
    let redeemed = false;
    try {
      await redeemPromo(trimmed);
      redeemed = true;
      await refresh(); // entitled now → the gate re-derives and unmounts this component
    } catch (e) {
      // Keep the redeem failure distinct from a post-redeem refresh failure: once the code is
      // accepted, the grant is real, so never tell the user it "didn't work" — point them at
      // the refresh affordance instead.
      setError(
        redeemed
          ? 'Redeemed — tap "I already paid — refresh".'
          : String(e).includes("invalid_code")
            ? "That code didn't work."
            : "Couldn't redeem — try again.",
      );
    } finally {
      // Always re-enable: if refresh resolves without entitlement flipping (stale /me), the
      // control must recover rather than stay stuck on "…".
      setSubmitting(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6, marginTop: 4 }}>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          style={promoInput}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void submit()}
          placeholder="Have a code?"
          aria-label="Promo code"
          disabled={submitting}
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
        />
        <button style={primaryBtn} onClick={() => void submit()} disabled={submitting}>
          {submitting ? "…" : "Redeem"}
        </button>
      </div>
      {error && <p style={{ color: DANGER, fontSize: 12, margin: 0 }}>{error}</p>}
    </div>
  );
}

export function AuthGate({ children }: { children: ReactNode }) {
  const { me, tokenPresent, loading, refresh } = useAuthStore();
  const trialStarted = useTrialStore((s) => s.started);
  const trialLoading = useTrialStore((s) => s.loading);
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
          await exchangeCode(code);
        } catch {
          // expired/used code — refresh leaves us unauthenticated
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

  const view = deriveAuthView({ loading, hasToken: tokenPresent, me, trialStarted, trialLoading });

  if (view === "entitled") return <>{children}</>;

  if (view === "trial") {
    // The Workspace runs in free mode; TrialChrome overlays the counter + Unlock, and the
    // full-screen upsell once the 100 prompts are spent (Workspace stays mounted underneath).
    return (
      <>
        {children}
        <TrialChrome onUnlock={() => void handOff(openSignIn, SIGN_IN_URL)} signInFailedUrl={failedUrl} />
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
        <button style={primaryBtn} onClick={() => void handOff(openPaywall, PAYWALL_URL)}>
          Pay $99 &amp; get $200 in credits
        </button>
        {failedUrl && <LaunchFallback url={failedUrl} />}
        <button style={linkBtn} onClick={() => void refresh()}>
          I already paid — refresh
        </button>
        <PromoRedeem refresh={refresh} />
      </Screen>
    );
  }

  // welcome (token-less, trial not yet started)
  return (
    <WelcomeScreen
      onSignIn={() => void handOff(openSignIn, SIGN_IN_URL)}
      onTryFree={() => void startTrial()}
      signInFailedUrl={failedUrl}
    />
  );
}
