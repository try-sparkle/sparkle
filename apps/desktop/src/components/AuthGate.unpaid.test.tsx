// @vitest-environment jsdom
//
// Covers the two unlock-screen UX improvements:
//  A) "Pay $99" goes straight to Stripe in one click when signed in (openPaywallCheckout), and
//     falls back to the web sign-in→paywall hand-off when signed out or when that direct path fails.
//  B) The "stay on the free trial" escape hatch dismisses the unlock screen back to the trial
//     workspace when the user still has trial prompts left (and is hidden when none remain).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(null) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("../services/sparkleApi", () => ({
  exchangeCode: vi.fn(),
  openPaywall: vi.fn(() => Promise.resolve(true)),
  openSignIn: vi.fn(() => Promise.resolve(true)),
  PAYWALL_URL: "x",
  redeemPromo: vi.fn(),
  SIGN_IN_URL: "y",
}));
vi.mock("../services/creditsMenuApi", () => ({
  openPaywallCheckout: vi.fn(),
  lastCheckoutUrl: vi.fn(() => null),
}));

import { AuthGate } from "./AuthGate";
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
    // Dismissed → trial render path: Workspace mounts, the trial pill appears.
    expect(screen.getByText("WORKSPACE")).toBeTruthy();
    expect(screen.getByText(/60 prompts left/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Pay \$99/ })).toBeNull();
  });

  it("hides the link when no trial prompts remain", () => {
    signedInUnpaid(100); // 0 left
    render(<AuthGate><div>WORKSPACE</div></AuthGate>);
    expect(screen.getByRole("button", { name: /Pay \$99/ })).toBeTruthy();
    expect(screen.queryByText(/stay on the free trial/)).toBeNull();
  });

  it("after dismissing, a signed-in user's Unlock converts via one-click checkout (not web sign-in)", async () => {
    mockCheckout.mockResolvedValue(true);
    signedInUnpaid(40);
    render(<AuthGate><div>WORKSPACE</div></AuthGate>);
    fireEvent.click(screen.getByRole("button", { name: /stay on the free trial/ }));
    fireEvent.click(screen.getByRole("button", { name: /Unlock/ }));
    await waitFor(() => expect(mockCheckout).toHaveBeenCalledTimes(1));
    expect(mockOpenSignIn).not.toHaveBeenCalled();
  });

  it("dismissed-trial Unlock falls back to the web paywall when checkout fails with no URL", async () => {
    mockCheckout.mockResolvedValue(false); // launch failed, no session URL available
    mockLastCheckoutUrl.mockReturnValue(null);
    signedInUnpaid(40);
    render(<AuthGate><div>WORKSPACE</div></AuthGate>);
    fireEvent.click(screen.getByRole("button", { name: /stay on the free trial/ }));
    fireEvent.click(screen.getByRole("button", { name: /Unlock/ }));
    await waitFor(() => expect(mockOpenPaywall).toHaveBeenCalledTimes(1));
    expect(mockOpenSignIn).not.toHaveBeenCalled(); // still routed through checkout, not sign-in
  });
});
