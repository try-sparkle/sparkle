// @vitest-environment jsdom
//
// Covers the inline buy-to-use notice shown at a locked (trial / not-yet-bought) AI surface:
//  - renders the caller's label and an "Unlock Sparkle — $99" button
//  - SIGNED IN: Unlock goes straight to Stripe (openPaywallCheckout); on a failed browser launch it
//    surfaces the real hosted URL; if the direct path throws it falls back to the web paywall
//  - SIGNED OUT: Unlock uses the web sign-in→paywall hand-off (openPaywall)
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("../services/sparkleApi", () => ({
  openPaywall: vi.fn(() => Promise.resolve(true)),
  PAYWALL_URL: "https://sparkle.ai/paywall",
}));
vi.mock("../services/creditsMenuApi", () => ({
  openPaywallCheckout: vi.fn(),
  lastCheckoutUrl: vi.fn(() => null),
}));

import { AiLockedNotice } from "./AiLockedNotice";
import { openPaywall, PAYWALL_URL } from "../services/sparkleApi";
import { openPaywallCheckout, lastCheckoutUrl } from "../services/creditsMenuApi";
import { useAuthStore } from "../stores/authStore";

const mockOpenPaywall = vi.mocked(openPaywall);
const mockCheckout = vi.mocked(openPaywallCheckout);
const mockLastUrl = vi.mocked(lastCheckoutUrl);

function setSignedIn(tokenPresent: boolean) {
  useAuthStore.setState({ tokenPresent });
}

const clickUnlock = () =>
  fireEvent.click(screen.getByRole("button", { name: /Unlock Sparkle/i }));

beforeEach(() => {
  vi.clearAllMocks();
  mockOpenPaywall.mockResolvedValue(true);
  mockCheckout.mockResolvedValue(true);
  mockLastUrl.mockReturnValue(null);
  setSignedIn(false);
});
afterEach(() => cleanup());

describe("AiLockedNotice", () => {
  it("renders the given label and the Unlock button", () => {
    render(<AiLockedNotice label="Buy Sparkle to think with AI." />);
    expect(screen.getByText("Buy Sparkle to think with AI.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Unlock Sparkle/i })).toBeTruthy();
  });

  it("falls back to the default message when no label is given", () => {
    render(<AiLockedNotice />);
    expect(screen.getByText("Buy Sparkle to use AI features.")).toBeTruthy();
  });

  it("signed out: uses the web paywall hand-off, not the direct checkout", async () => {
    setSignedIn(false);
    render(<AiLockedNotice />);
    clickUnlock();
    await waitFor(() => expect(mockOpenPaywall).toHaveBeenCalledTimes(1));
    expect(mockCheckout).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("signed in: goes straight to Stripe via openPaywallCheckout (no web paywall)", async () => {
    setSignedIn(true);
    render(<AiLockedNotice />);
    clickUnlock();
    await waitFor(() => expect(mockCheckout).toHaveBeenCalledTimes(1));
    expect(mockOpenPaywall).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("signed in: surfaces the hosted Stripe URL when the browser launch fails", async () => {
    setSignedIn(true);
    mockCheckout.mockResolvedValue(false);
    mockLastUrl.mockReturnValue("https://checkout.stripe.com/c/pay/abc");
    render(<AiLockedNotice />);
    clickUnlock();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("https://checkout.stripe.com/c/pay/abc");
    expect(mockOpenPaywall).not.toHaveBeenCalled();
  });

  it("signed in: falls back to the web paywall when the direct checkout throws", async () => {
    setSignedIn(true);
    mockCheckout.mockRejectedValue(new Error("no bearer"));
    render(<AiLockedNotice />);
    clickUnlock();
    await waitFor(() => expect(mockOpenPaywall).toHaveBeenCalledTimes(1));
  });

  it("signed out: surfaces the paywall URL when the browser launch fails", async () => {
    setSignedIn(false);
    mockOpenPaywall.mockResolvedValue(false);
    render(<AiLockedNotice />);
    clickUnlock();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(PAYWALL_URL);
  });
});
