// @vitest-environment jsdom
//
// AuthGate's deep-link auth-recovery path: a `sparkle://auth?code=…` callback that arrives with NO
// in-flight sign-in to bind it to (the user quit mid-sign-in; the relaunch's exchange rejects with
// the Rust NO_PENDING_SIGNIN sentinel). Before the fix this was swallowed and the user dead-ended on
// a plain Welcome screen with no explanation. Now it surfaces a clear "sign-in didn't finish" banner,
// and the same Sign in button re-initiates a fresh flow.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// The cold-launch drain reads the pending deep link via invoke("desktop_take_pending_deeplink").
const PENDING_URL = "sparkle://auth?code=abc123&state=st-xyz";
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string) =>
    Promise.resolve(cmd === "desktop_take_pending_deeplink" ? PENDING_URL : null),
  ),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));

const exchangeCode = vi.fn();
vi.mock("../services/sparkleApi", () => ({
  exchangeCode: (code: string, state: string) => exchangeCode(code, state),
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
import { openSignIn } from "../services/sparkleApi";
import { useAuthStore } from "../stores/authStore";
import { useTrialStore } from "../stores/trialStore";

beforeEach(() => {
  useAuthStore.setState({ me: null, tokenPresent: false, loading: false, refresh: vi.fn() });
  useTrialStore.setState({
    started: false,
    promptsUsed: 0,
    loading: false,
    error: false,
    refresh: vi.fn(),
    start: vi.fn(),
    increment: vi.fn(),
  });
  vi.clearAllMocks();
});
afterEach(() => cleanup());

describe("AuthGate — sign-in recovery", () => {
  it("a callback with no pending sign-in surfaces a recoverable banner (not a silent dead-end)", async () => {
    exchangeCode.mockRejectedValue("no_pending_signin");
    render(
      <AuthGate>
        <div>WORKSPACE</div>
      </AuthGate>,
    );
    // The exchange was attempted with the code + echoed state from the deep link…
    await waitFor(() => expect(exchangeCode).toHaveBeenCalledWith("abc123", "st-xyz"));
    // …and its failure produced a clear "try again" banner rather than a bare Welcome screen.
    expect(await screen.findByText(/sign-in didn't finish/i)).toBeTruthy();
    // The Sign in affordance is still present so the user can cleanly restart.
    expect(screen.getByRole("button", { name: /Log in \/ Sign up/ })).toBeTruthy();
  });

  it("clicking Sign in after the interruption re-initiates the flow", async () => {
    exchangeCode.mockRejectedValue("no_pending_signin");
    render(
      <AuthGate>
        <div>WORKSPACE</div>
      </AuthGate>,
    );
    await screen.findByText(/sign-in didn't finish/i);
    fireEvent.click(screen.getByRole("button", { name: /Log in \/ Sign up/ }));
    expect(openSignIn).toHaveBeenCalled();
  });

  it("a GENUINE failure (state mismatch) does NOT show the recovery banner", async () => {
    exchangeCode.mockRejectedValue("state mismatch");
    render(
      <AuthGate>
        <div>WORKSPACE</div>
      </AuthGate>,
    );
    await waitFor(() => expect(exchangeCode).toHaveBeenCalled());
    // A planted/expired code is not the recoverable quit-mid-sign-in case — no misleading banner.
    expect(screen.queryByText(/sign-in didn't finish/i)).toBeNull();
  });

  it("a trial-read failure (corrupt trial.json) surfaces its own recoverable Welcome banner", async () => {
    // No auth callback here — just the trialStore.error flag set by a thrown refresh (Task 2). The
    // gate must still be usable (Welcome), not stuck on Loading, with an explanatory banner.
    useTrialStore.setState({ error: true });
    render(
      <AuthGate>
        <div>WORKSPACE</div>
      </AuthGate>,
    );
    expect(await screen.findByText(/couldn't load your free-trial status/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Try it now/ })).toBeTruthy();
  });
});
