// @vitest-environment jsdom
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
  it("renders the workspace + trial counter once the trial has started", () => {
    useTrialStore.setState({ started: true, promptsUsed: 3 });
    render(
      <AuthGate>
        <div>WORKSPACE</div>
      </AuthGate>,
    );
    expect(screen.getByText("WORKSPACE")).toBeTruthy();
    expect(screen.getByText(/97 prompts left/)).toBeTruthy();
  });
  it("pluralizes the counter for a single remaining prompt", () => {
    useTrialStore.setState({ started: true, promptsUsed: 99 });
    render(
      <AuthGate>
        <div>WORKSPACE</div>
      </AuthGate>,
    );
    expect(screen.getByText(/1 prompt left/)).toBeTruthy();
    expect(screen.queryByText(/1 prompts left/)).toBeNull();
  });
  it("surfaces the manual-link fallback by the pill when the Unlock hand-off can't open the browser", async () => {
    (openSignIn as unknown as { mockResolvedValueOnce: (v: boolean) => void }).mockResolvedValueOnce(false);
    useTrialStore.setState({ started: true, promptsUsed: 3 });
    render(
      <AuthGate>
        <div>WORKSPACE</div>
      </AuthGate>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Unlock/ }));
    // handOff awaits openSignIn (false) → failedUrl set → the pill renders the manual link.
    expect(await screen.findByText(/Couldn.t open your browser/)).toBeTruthy();
    expect(screen.getByText("y")).toBeTruthy(); // SIGN_IN_URL mock value
  });
  it("Unlock starts the sign-in hand-off", () => {
    useTrialStore.setState({ started: true, promptsUsed: 3 });
    render(
      <AuthGate>
        <div>WORKSPACE</div>
      </AuthGate>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Unlock/ }));
    expect(openSignIn).toHaveBeenCalled();
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
    fireEvent.click(screen.getByRole("button", { name: /Log in \/ Sign up/ }));
    expect(openSignIn).toHaveBeenCalled();
  });
});
