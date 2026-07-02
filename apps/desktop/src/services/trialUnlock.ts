// Single source of truth for the paywall / sign-in hand-off primitives, shared by EVERY place a
// "convert" button appears — AuthGate's "$99" button + welcome sign-in + exhausted upsell, and the
// in-bar TopBar TrialIndicator. Keeping the primitives here (rather than re-implementing the
// checkout-else-sign-in rule in AuthGate AND here) guarantees the buttons behave identically
// wherever they render and can't drift (e.g. the sign-in fallback URL below).
//
// onFailedUrl(url) is invoked with a copy/paste URL when a browser hand-off couldn't launch (so the
// caller can surface it), and with null at the START of each attempt to clear any prior failure.
import { openPaywallCheckout, lastCheckoutUrl } from "./creditsMenuApi";
import { openPaywall, openSignIn, lastSignInUrl, PAYWALL_URL, SIGN_IN_URL } from "./sparkleApi";

type OnFailedUrl = (url: string | null) => void;

/** One-click Stripe for a SIGNED-IN user: create the checkout session and land on
 *  checkout.stripe.com; if the session was created but the browser wouldn't open, surface the real
 *  hosted Stripe URL; on any other failure (server refused / no session) fall back to the generic
 *  web paywall hand-off. */
export async function checkoutOrWebPaywall(onFailedUrl: OnFailedUrl): Promise<void> {
  onFailedUrl(null);
  try {
    if (await openPaywallCheckout()) return;
    // Session created but the browser wouldn't open — offer the real hosted Stripe URL.
    const url = lastCheckoutUrl();
    if (url) {
      onFailedUrl(url);
      return;
    }
  } catch (e) {
    console.warn("Direct paywall checkout failed; falling back to the web paywall flow:", e);
  }
  await webPaywallHandoff(onFailedUrl);
}

/** The generic web paywall page hand-off — used for a token-less "$99" click (no bearer to create a
 *  checkout session) and as the checkout fallback above. */
export async function webPaywallHandoff(onFailedUrl: OnFailedUrl): Promise<void> {
  onFailedUrl(null);
  const ok = await openPaywall();
  if (!ok) onFailedUrl(PAYWALL_URL);
}

/** Web sign-in hand-off. On a launch failure surface the ACTUAL per-attempt URL just built
 *  (lastSignInUrl) — the bare SIGN_IN_URL is an unbound link the server can't tie to a sign-in —
 *  falling back to SIGN_IN_URL only if nothing was built yet (sparkle-kqg0). */
export async function signInHandoff(onFailedUrl: OnFailedUrl): Promise<void> {
  onFailedUrl(null);
  const ok = await openSignIn();
  if (!ok) onFailedUrl(lastSignInUrl() ?? SIGN_IN_URL);
}

/** The trial → paid "Unlock" action, used by BOTH the in-bar TrialIndicator (TopBar) and the
 *  full-screen exhausted upsell (AuthGate). A signed-in (token-present) user converts via one-click
 *  Stripe checkout; a signed-out user gets the sign-in hand-off first. It must NEVER route a
 *  signed-in user through bare sign-in. */
export async function performTrialUnlock(
  tokenPresent: boolean,
  onFailedUrl: OnFailedUrl,
): Promise<void> {
  return tokenPresent ? checkoutOrWebPaywall(onFailedUrl) : signInHandoff(onFailedUrl);
}
