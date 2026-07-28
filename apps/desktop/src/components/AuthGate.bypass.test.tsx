// @vitest-environment jsdom
//
// AuthGate + the DEV auth bypass (plan 3b): with the flag on, the REAL authStore.refresh()
// short-circuits before the keychain and renders the workspace children — the seam the screenshot /
// E2E harness relies on. hasToken() is stubbed to FALSE (a headless browser has no keychain) to
// prove the bypass never consults it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(null) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("../services/sparkleApi", () => ({
  exchangeCode: vi.fn(),
  openPaywall: vi.fn(),
  openSignIn: vi.fn(() => Promise.resolve(true)),
  lastSignInUrl: vi.fn(() => "y"),
  PAYWALL_URL: "x",
  redeemPromo: vi.fn(),
  SIGN_IN_URL: "y",
  hasToken: vi.fn(() => Promise.resolve(false)),
  fetchMe: vi.fn(() => Promise.resolve(null)),
}));
vi.mock("../services/creditsMenuApi", () => ({
  openPaywallCheckout: vi.fn(),
  lastCheckoutUrl: vi.fn(() => null),
}));
vi.mock("../dev/devBypassAuth", () => ({ devBypassAuthEnabled: vi.fn(() => true) }));

import { AuthGate } from "./AuthGate";
import { useAuthStore } from "../stores/authStore";
import { useTrialStore } from "../stores/trialStore";
import { hasToken } from "../services/sparkleApi";

beforeEach(() => {
  useTrialStore.setState({
    started: false,
    promptsUsed: 0,
    loading: false,
    refresh: vi.fn(),
    start: vi.fn(),
    remaining: null,
    cap: null,
    blocked: false,
    syncRemote: vi.fn(),
    consume: vi.fn(),
  });
  // Pre-bypass state: the normal cold-launch "loading, no identity" the gate starts from. The
  // real refresh (NOT overridden here) runs on mount and applies the bypass.
  useAuthStore.setState({
    me: null,
    tokenPresent: false,
    loading: true,
    cachedAt: null,
    paywallDismissed: false,
    creditFloorCents: 0,
  });
});
afterEach(() => {
  cleanup();
});

describe("AuthGate — DEV auth bypass renders the workspace without a keychain", () => {
  it("renders children (the workspace) even though hasToken() is false", async () => {
    render(
      <AuthGate>
        <div>WORKSPACE</div>
      </AuthGate>,
    );
    // The real refresh runs on mount; the bypass short-circuits to entitled.
    await waitFor(() => expect(screen.getByText("WORKSPACE")).toBeTruthy());
    expect(screen.queryByText(/Loading/)).toBeNull();
    // Paywall copy must never appear.
    expect(screen.queryByText(/Unlock Sparkle/)).toBeNull();
  });

  it("never consults the keychain — the bypass returns before hasToken()", async () => {
    render(
      <AuthGate>
        <div>WORKSPACE</div>
      </AuthGate>,
    );
    await waitFor(() => expect(screen.getByText("WORKSPACE")).toBeTruthy());
    expect(vi.mocked(hasToken)).not.toHaveBeenCalled();
  });
});
