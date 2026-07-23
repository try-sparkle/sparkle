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
    remaining: null,
    cap: null,
    blocked: false,
    syncRemote: vi.fn(),
    consume: vi.fn(),
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
    // `blocked` is the SERVER's affirmative verdict (a 402 / 0-remaining answer) — the count alone
    // no longer raises this wall, so an offline device that drifted to 0 is never falsely walled.
    useTrialStore.setState({ started: true, promptsUsed: 100, remaining: 0, cap: 100, blocked: true });
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

  it("offline drift to 0 does NOT raise the upsell — only the server's verdict does", () => {
    // Fail-open regression guard: an unreachable server debits the local cache, so `remaining` can
    // legitimately reach 0 with `blocked` false. That must keep the user working, not wall them.
    useTrialStore.setState({ started: true, promptsUsed: 100, remaining: 0, cap: 100, blocked: false });
    render(
      <AuthGate>
        <div>WORKSPACE</div>
      </AuthGate>,
    );
    expect(screen.getByText("WORKSPACE")).toBeTruthy();
    expect(screen.queryByText(/used all/)).toBeNull();
  });

  it("a REINSTALL (trial.json gone) whose server counter is spent gets no 'Try it now'", async () => {
    // The revenue invariant, at the UI: `started` is false because the local file was deleted, but
    // the server-authoritative sync says this DEVICE is done. Offering the free box would hand them
    // a button that dead-ends on the first prompt, so it's dropped and the banner says why.
    const syncRemote = vi.fn(async () => {
      useTrialStore.setState({ blocked: true, remaining: 0, cap: 100, promptsUsed: 100 });
    });
    useTrialStore.setState({ started: false, syncRemote });
    render(
      <AuthGate>
        <div>WORKSPACE</div>
      </AuthGate>,
    );
    await screen.findByText(/already used its free trial/);
    expect(screen.queryByRole("button", { name: /Try it now/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Log in \/ Sign up/ })).toBeTruthy();
  });

  it("runs the authoritative sync for a NON-entitled user", async () => {
    const syncRemote = vi.fn().mockResolvedValue(undefined);
    useTrialStore.setState({ syncRemote });
    render(
      <AuthGate>
        <div>WORKSPACE</div>
      </AuthGate>,
    );
    await vi.waitFor(() => expect(syncRemote).toHaveBeenCalled());
  });

  it("an ENTITLED user never touches the trial endpoints", async () => {
    // Requirement: paid users skip the trial gate entirely — no sync, no device-token mint.
    const syncRemote = vi.fn().mockResolvedValue(undefined);
    useTrialStore.setState({ syncRemote });
    useAuthStore.setState({
      me: { clerkUserId: "u1", entitled: true, balanceCents: 500, tokenVersion: 1 },
      tokenPresent: true,
      loading: false,
      refresh: vi.fn(),
    });
    render(
      <AuthGate>
        <div>WORKSPACE</div>
      </AuthGate>,
    );
    expect(screen.getByText("WORKSPACE")).toBeTruthy();
    // Give the effect a tick to (not) fire.
    await Promise.resolve();
    expect(syncRemote).not.toHaveBeenCalled();
  });
});
