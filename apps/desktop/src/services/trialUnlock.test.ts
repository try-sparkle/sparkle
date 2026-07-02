// @vitest-environment jsdom
//
// The shared trial → paid Unlock handler used by BOTH the in-bar TrialIndicator (TopBar) and the
// full-screen exhausted upsell (AuthGate). Improvement A's hard requirement: a signed-in user
// converts via one-click Stripe checkout and is NEVER bounced through bare sign-in.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/sparkleApi", () => ({
  openPaywall: vi.fn(() => Promise.resolve(true)),
  openSignIn: vi.fn(() => Promise.resolve(true)),
  lastSignInUrl: vi.fn(() => null),
  PAYWALL_URL: "paywall-url",
  SIGN_IN_URL: "sign-in-url",
}));
vi.mock("../services/creditsMenuApi", () => ({
  openPaywallCheckout: vi.fn(),
  lastCheckoutUrl: vi.fn(() => null),
}));

import { performTrialUnlock } from "./trialUnlock";
import { openPaywall, openSignIn, lastSignInUrl } from "../services/sparkleApi";
import { openPaywallCheckout, lastCheckoutUrl } from "../services/creditsMenuApi";

const mockCheckout = vi.mocked(openPaywallCheckout);
const mockOpenPaywall = vi.mocked(openPaywall);
const mockOpenSignIn = vi.mocked(openSignIn);
const mockLastCheckoutUrl = vi.mocked(lastCheckoutUrl);
const mockLastSignInUrl = vi.mocked(lastSignInUrl);

beforeEach(() => {
  mockCheckout.mockReset();
  mockOpenPaywall.mockReset().mockResolvedValue(true);
  mockOpenSignIn.mockReset().mockResolvedValue(true);
  mockLastCheckoutUrl.mockReset().mockReturnValue(null);
  mockLastSignInUrl.mockReset().mockReturnValue(null);
});
afterEach(() => vi.clearAllMocks());

describe("performTrialUnlock", () => {
  it("signed in: goes straight to Stripe checkout and never touches sign-in or the web paywall", async () => {
    mockCheckout.mockResolvedValue(true);
    const onFailedUrl = vi.fn();
    await performTrialUnlock(true, onFailedUrl);
    expect(mockCheckout).toHaveBeenCalledTimes(1);
    expect(mockOpenSignIn).not.toHaveBeenCalled();
    expect(mockOpenPaywall).not.toHaveBeenCalled();
    expect(onFailedUrl).toHaveBeenCalledWith(null); // cleared any prior failure, none set
  });

  it("signed in: falls back to the web paywall when the direct checkout throws — still not sign-in", async () => {
    mockCheckout.mockRejectedValue(new Error("no_token"));
    const onFailedUrl = vi.fn();
    await performTrialUnlock(true, onFailedUrl);
    expect(mockOpenPaywall).toHaveBeenCalledTimes(1);
    expect(mockOpenSignIn).not.toHaveBeenCalled();
  });

  it("signed in: surfaces the real Stripe URL when the session opened but the browser launch failed", async () => {
    mockCheckout.mockResolvedValue(false);
    mockLastCheckoutUrl.mockReturnValue("https://checkout.stripe.com/c/pay/abc");
    const onFailedUrl = vi.fn();
    await performTrialUnlock(true, onFailedUrl);
    expect(onFailedUrl).toHaveBeenLastCalledWith("https://checkout.stripe.com/c/pay/abc");
    expect(mockOpenPaywall).not.toHaveBeenCalled(); // did NOT bounce to the generic web page
  });

  it("signed out: uses the sign-in hand-off first (payment happens after auth)", async () => {
    const onFailedUrl = vi.fn();
    await performTrialUnlock(false, onFailedUrl);
    expect(mockOpenSignIn).toHaveBeenCalledTimes(1);
    expect(mockCheckout).not.toHaveBeenCalled();
  });

  it("signed out: reports the ACTUAL bound sign-in URL (lastSignInUrl) as the fallback, not the bare one", async () => {
    // The bug this unification fixes: the bare SIGN_IN_URL is an unbound link the server can't tie
    // to a sign-in. When one was built, surface THAT (matching AuthGate's handleSignIn).
    mockOpenSignIn.mockResolvedValue(false);
    mockLastSignInUrl.mockReturnValue("https://sparkle.ai/desktop/callback?state=abc&code_challenge=xyz");
    const onFailedUrl = vi.fn();
    await performTrialUnlock(false, onFailedUrl);
    expect(onFailedUrl).toHaveBeenLastCalledWith(
      "https://sparkle.ai/desktop/callback?state=abc&code_challenge=xyz",
    );
  });

  it("signed out: falls back to the bare SIGN_IN_URL only when nothing was built yet", async () => {
    mockOpenSignIn.mockResolvedValue(false);
    mockLastSignInUrl.mockReturnValue(null);
    const onFailedUrl = vi.fn();
    await performTrialUnlock(false, onFailedUrl);
    expect(onFailedUrl).toHaveBeenLastCalledWith("sign-in-url");
  });
});
