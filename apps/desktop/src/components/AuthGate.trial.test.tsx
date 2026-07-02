// @vitest-environment jsdom
//
// AuthGate's trial branch. NOTE: after Improvement A the small "N prompts left" counter + Unlock
// live INSIDE the TopBar (TrialIndicator), NOT as an overlay AuthGate renders — so those are
// covered by TrialIndicator.test.tsx / TopBar.trial.test.tsx, not here. AuthGate still owns the
// token-less welcome screen and the full-screen EXHAUSTED upsell, which is what this file asserts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

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
import { openSignIn } from "../services/sparkleApi";
import { useAuthStore } from "../stores/authStore";
import { useTrialStore } from "../stores/trialStore";

beforeEach(() => {
  useAuthStore.setState({ me: null, tokenPresent: false, loading: false, refresh: vi.fn() });
  useTrialStore.setState({
    started: false,
    promptsUsed: 0,
    loading: false,
    refresh: vi.fn(),
    start: vi.fn(),
    increment: vi.fn(),
  });
});
afterEach(() => cleanup());

describe("AuthGate — trial flow", () => {
  it("shows the Welcome two-box screen when token-less and trial not started", () => {
    render(
      <AuthGate>
        <div>WORKSPACE</div>
      </AuthGate>,
    );
    expect(screen.getByRole("button", { name: /Try it now/ })).toBeTruthy();
    expect(screen.queryByText("WORKSPACE")).toBeNull();
  });
  it("renders the workspace (in free mode) once the trial has started", () => {
    useTrialStore.setState({ started: true, promptsUsed: 3 });
    render(
      <AuthGate>
        <div>WORKSPACE</div>
      </AuthGate>,
    );
    // The Workspace mounts in free mode. The counter itself now lives in the TopBar (TrialIndicator),
    // which isn't part of this fake child — so AuthGate must NOT render its own covering pill here.
    expect(screen.getByText("WORKSPACE")).toBeTruthy();
    expect(screen.queryByText(/prompts left/)).toBeNull();
  });
  it("at the limit: keeps the Workspace mounted, shows the upsell, drops 'Try it now'", () => {
    useTrialStore.setState({ started: true, promptsUsed: 100 });
    render(
      <AuthGate>
        <div>WORKSPACE</div>
      </AuthGate>,
    );
    expect(screen.getByText(/used all 100 free prompts/)).toBeTruthy();
    // Workspace stays mounted underneath so running workers survive until conversion.
    expect(screen.getByText("WORKSPACE")).toBeTruthy();
    // The only action is to convert — no dead "Try it now" beside the exhausted banner.
    expect(screen.queryByRole("button", { name: /Try it now/ })).toBeNull();
    // Token-less → the upsell's convert button routes to the sign-in hand-off (same as main).
    fireEvent.click(screen.getByRole("button", { name: /Log in \/ Sign up/ }));
    expect(openSignIn).toHaveBeenCalled();
  });
});
