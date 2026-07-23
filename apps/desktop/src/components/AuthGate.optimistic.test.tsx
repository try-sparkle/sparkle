// @vitest-environment jsdom
//
// AuthGate's cold-launch optimism: a previously-entitled user whose entitlement was cached (by the
// authStore persist layer) renders the workspace on the FIRST frame — never the bare "Loading…"
// screen — while refresh() revalidates in the background. Complements authStore.test.ts (which
// covers the caching/grace decision logic); this asserts the gate's OBSERVABLE render given that
// hydrated state.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

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
}));
vi.mock("../services/creditsMenuApi", () => ({
  openPaywallCheckout: vi.fn(),
  lastCheckoutUrl: vi.fn(() => null),
}));

import { AuthGate } from "./AuthGate";
import { useAuthStore } from "../stores/authStore";
import { useTrialStore } from "../stores/trialStore";

// A trial that is still "loading" would pin deriveAuthView on "loading"; a cold launch resolves the
// device-local trial read synchronously-fast, so model it as already resolved here.
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
});
afterEach(() => {
  cleanup();
  useAuthStore.setState({
    me: null,
    tokenPresent: false,
    loading: true,
    cachedAt: null,
    paywallDismissed: false,
    refresh: vi.fn(),
  });
});

describe("AuthGate — optimistic cold launch (cached-entitled user)", () => {
  it("renders the workspace immediately (no 'Loading…') from a hydrated entitled cache", () => {
    // This is the post-hydration state authStore's `merge` produces for a valid entitled cache:
    // loading already false, tokenPresent assumed, me entitled — all BEFORE refresh() completes.
    useAuthStore.setState({
      me: { clerkUserId: "u1", entitled: true, balanceCents: 20000, tokenVersion: 1 },
      tokenPresent: true,
      loading: false,
      cachedAt: Date.now(),
      // refresh is a no-op here so we assert the FIRST-frame (pre-revalidation) render.
      refresh: vi.fn(),
    });
    render(
      <AuthGate>
        <div>WORKSPACE</div>
      </AuthGate>,
    );
    expect(screen.getByText("WORKSPACE")).toBeTruthy();
    expect(screen.queryByText("Loading…")).toBeNull();
  });

  it("a background revalidation that fails (null /me) does NOT downgrade — workspace stays", async () => {
    // Simulate the real refresh keeping last-known state on a null /me: it leaves me entitled.
    const refresh = vi.fn().mockResolvedValue(undefined);
    useAuthStore.setState({
      me: { clerkUserId: "u1", entitled: true, balanceCents: 20000, tokenVersion: 1 },
      tokenPresent: true,
      loading: false,
      cachedAt: Date.now(),
      refresh,
    });
    render(
      <AuthGate>
        <div>WORKSPACE</div>
      </AuthGate>,
    );
    // refresh was kicked off (revalidation happens), but the workspace is shown throughout.
    expect(refresh).toHaveBeenCalled();
    expect(screen.getByText("WORKSPACE")).toBeTruthy();
    expect(screen.queryByText("Loading…")).toBeNull();
  });
});
