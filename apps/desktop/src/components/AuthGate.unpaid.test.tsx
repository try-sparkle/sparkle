// @vitest-environment jsdom
//
// Covers the two unlock-screen UX improvements:
//  A) "Pay $99" goes straight to Stripe in one click when signed in (openPaywallCheckout), and
//     falls back to the web sign-in→paywall hand-off when signed out or when that direct path fails.
//  B) The "stay on the free trial" escape hatch dismisses the unlock screen back to the trial
//     workspace when the user still has trial prompts left (and is hidden when none remain).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(null) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("../services/sparkleApi", () => ({
  exchangeCode: vi.fn(),
  openPaywall: vi.fn(() => Promise.resolve(true)),
  openSignIn: vi.fn(() => Promise.resolve(true)),
  lastSignInUrl: vi.fn(() => "y"),
  PAYWALL_URL: "x",
  redeemPromo: vi.fn(),
  SIGN_IN_URL: "y",
}));
vi.mock("../services/creditsMenuApi", () => ({
  openPaywallCheckout: vi.fn(),
  lastCheckoutUrl: vi.fn(() => null),
}));

import { AuthGate } from "./AuthGate";
import { performTrialUnlock } from "../services/trialUnlock";
import { openPaywall, openSignIn } from "../services/sparkleApi";
import { openPaywallCheckout, lastCheckoutUrl } from "../services/creditsMenuApi";
import { useAuthStore } from "../stores/authStore";
import { useTrialStore } from "../stores/trialStore";

const mockCheckout = vi.mocked(openPaywallCheckout);
const mockOpenPaywall = vi.mocked(openPaywall);
const mockOpenSignIn = vi.mocked(openSignIn);
const mockLastCheckoutUrl = vi.mocked(lastCheckoutUrl);

// Signed in but not yet entitled → deriveAuthView returns "unpaid" (the unlock screen).
function signedInUnpaid(promptsUsed: number) {
  useAuthStore.setState({
    me: { clerkUserId: "u1", entitled: false, balanceCents: 0, tokenVersion: 1 },
    tokenPresent: true,
    loading: false,
    refresh: vi.fn(),
  });
  useTrialStore.setState({
    started: true,
    promptsUsed,
    loading: false,
    refresh: vi.fn(),
    start: vi.fn(),
    increment: vi.fn(),
  });
}

beforeEach(() => {
  mockCheckout.mockReset();
  mockOpenPaywall.mockReset().mockResolvedValue(true);
  mockOpenSignIn.mockReset().mockResolvedValue(true);
  mockLastCheckoutUrl.mockReset().mockReturnValue(null);
});
afterEach(() => {
  cleanup();
  // Zustand stores are module singletons — reset so state can't leak across tests/files.
  useAuthStore.setState({ me: null, tokenPresent: false, loading: true, refresh: vi.fn() });
  useTrialStore.setState({ started: false, promptsUsed: 0, loading: true });
});

describe("AuthGate — unlock screen (one-click Stripe)", () => {
  it("signed in: Pay $99 goes straight to Stripe and never touches the web fallback", async () => {
    mockCheckout.mockResolvedValue(true);
    signedInUnpaid(0);
    render(<AuthGate><div>WORKSPACE</div></AuthGate>);
    fireEvent.click(screen.getByRole("button", { name: /Pay \$99/ }));
    await waitFor(() => expect(mockCheckout).toHaveBeenCalledTimes(1));
    expect(mockOpenPaywall).not.toHaveBeenCalled();
  });

  it("falls back to the web paywall hand-off when the direct checkout throws", async () => {
    mockCheckout.mockRejectedValue(new Error("no_token"));
    signedInUnpaid(0);
    render(<AuthGate><div>WORKSPACE</div></AuthGate>);
    fireEvent.click(screen.getByRole("button", { name: /Pay \$99/ }));
    await waitFor(() => expect(mockOpenPaywall).toHaveBeenCalledTimes(1));
  });

  it("surfaces the real Stripe URL (not the web paywall) when the session opened but the browser launch failed", async () => {
    mockCheckout.mockResolvedValue(false); // session created, launch failed
    mockLastCheckoutUrl.mockReturnValue("https://checkout.stripe.com/c/pay/abc");
    signedInUnpaid(0);
    render(<AuthGate><div>WORKSPACE</div></AuthGate>);
    fireEvent.click(screen.getByRole("button", { name: /Pay \$99/ }));
    expect(await screen.findByText("https://checkout.stripe.com/c/pay/abc")).toBeTruthy();
    expect(mockOpenPaywall).not.toHaveBeenCalled(); // did NOT bounce to the generic web page
  });
});

describe("AuthGate — stay-on-trial escape hatch", () => {
  it("shows the link with the remaining count and returns to the trial workspace when clicked", () => {
    signedInUnpaid(40); // 100 - 40 = 60 left
    render(<AuthGate><div>WORKSPACE</div></AuthGate>);
    const link = screen.getByRole("button", { name: /stay on the free trial and use the 60 prompts/ });
    expect(screen.queryByText("WORKSPACE")).toBeNull(); // unlock screen: workspace hidden
    fireEvent.click(link);
    // Dismissed → trial render path: Workspace mounts (in free mode), the $99 wall is gone. The
    // "N prompts left" counter now lives in the TopBar (TrialIndicator), not an AuthGate overlay,
    // so it isn't part of this fake child — its rendering is asserted in TrialIndicator/TopBar tests.
    expect(screen.getByText("WORKSPACE")).toBeTruthy();
    expect(screen.queryByText(/prompts left/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Pay \$99/ })).toBeNull();
  });

  it("hides the link when no trial prompts remain", () => {
    signedInUnpaid(100); // 0 left
    render(<AuthGate><div>WORKSPACE</div></AuthGate>);
    expect(screen.getByRole("button", { name: /Pay \$99/ })).toBeTruthy();
    expect(screen.queryByText(/stay on the free trial/)).toBeNull();
  });

  // The trial Unlock now lives in the TopBar indicator, but AuthGate's own handleTrialUnlock and the
  // TopBar indicator BOTH delegate to the same performTrialUnlock handler — so the paywall ROUTING
  // is asserted here against that shared handler (also covered end-to-end in trialUnlock.test.ts).
  it("after dismissing, a signed-in user's Unlock converts via one-click checkout (not web sign-in)", async () => {
    mockCheckout.mockResolvedValue(true);
    await performTrialUnlock(true, vi.fn());
    expect(mockCheckout).toHaveBeenCalledTimes(1);
    expect(mockOpenSignIn).not.toHaveBeenCalled();
  });

  it("dismissed-trial Unlock falls back to the web paywall when checkout fails with no URL", async () => {
    mockCheckout.mockResolvedValue(false); // launch failed, no session URL available
    mockLastCheckoutUrl.mockReturnValue(null);
    await performTrialUnlock(true, vi.fn());
    expect(mockOpenPaywall).toHaveBeenCalledTimes(1);
    expect(mockOpenSignIn).not.toHaveBeenCalled(); // still routed through checkout, not sign-in
  });

  // Integration guard (roborev #6249/#6253): render-and-click through AuthGate's OWN trial-Unlock
  // (the exhausted full-screen upsell) to prove it routes a signed-in user through one-click
  // checkout, NOT bare sign-in. The direct performTrialUnlock cases above can't catch a regression
  // that repoints handleTrialUnlock at openSignIn; this can.
  it("signed-in exhausted-upsell Unlock (driven through AuthGate) converts via checkout, not sign-in", async () => {
    mockCheckout.mockResolvedValue(true);
    signedInUnpaid(99); // 1 prompt left → the escape hatch is available
    render(<AuthGate><div>WORKSPACE</div></AuthGate>);
    // Dismiss the $99 wall back to the trial workspace, then spend the last prompt so AuthGate hands
    // off to its exhausted full-screen upsell (whose Unlock is wired to handleTrialUnlock).
    fireEvent.click(screen.getByRole("button", { name: /stay on the free trial/ }));
    act(() => useTrialStore.setState({ promptsUsed: 100 }));
    fireEvent.click(await screen.findByRole("button", { name: /log in \/ sign up/i }));
    await waitFor(() => expect(mockCheckout).toHaveBeenCalledTimes(1));
    expect(mockOpenSignIn).not.toHaveBeenCalled();
  });
});
