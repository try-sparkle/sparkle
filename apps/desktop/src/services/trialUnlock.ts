// Shared trial → paid "Unlock" routing, used by BOTH places the Unlock button appears:
//   • the in-bar TrialIndicator (TopBar) shown while prompts remain, and
//   • the full-screen exhausted upsell (TrialChrome, via AuthGate) once they're spent.
// Keeping it in one function guarantees the button behaves identically wherever it's rendered and
// matches main's $99 paywall flow: a signed-in (token-present) user converts via one-click Stripe
// checkout (openPaywallCheckout), falling back to the web paywall hand-off; a signed-out user gets
// the sign-in hand-off first. It must NEVER route a signed-in user through bare sign-in.
//
// onFailedUrl(url) is invoked with a copy/paste URL when a browser hand-off couldn't launch (so the
// caller can surface it), and with null at the start of each attempt to clear any prior failure.
import { openPaywallCheckout, lastCheckoutUrl } from "./creditsMenuApi";
import { openPaywall, openSignIn, PAYWALL_URL, SIGN_IN_URL } from "./sparkleApi";

export async function performTrialUnlock(
  tokenPresent: boolean,
  onFailedUrl: (url: string | null) => void,
): Promise<void> {
  onFailedUrl(null);
  if (tokenPresent) {
    // One-click Stripe: create the checkout session directly and land on checkout.stripe.com.
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
    // Fall back to the web paywall hand-off (server refused / no session URL).
    const ok = await openPaywall();
    if (!ok) onFailedUrl(PAYWALL_URL);
    return;
  }
  // Token-less trial user: sign-in hand-off first (payment happens after auth on the web side).
  const ok = await openSignIn();
  if (!ok) onFailedUrl(SIGN_IN_URL);
}
