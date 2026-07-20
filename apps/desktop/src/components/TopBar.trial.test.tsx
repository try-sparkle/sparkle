// @vitest-environment jsdom
//
// Improvement A (integration): the trial counter + Unlock now render INSIDE the TopBar row, to the
// LEFT of the Recent/Open/⋯ action cluster, instead of as a floating pill that covered them.
// This mounts the real TopBar in trial mode and asserts (1) the indicator is in the bar, ordered
// before the action buttons, and (2) its Unlock routes through the shared paywall handler.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// Peripheral stores/services TopBar pulls in but that are irrelevant to the trial indicator.
vi.mock("../services/dialog", () => ({
  pickProjectFolder: vi.fn(),
  basename: (p: string) => p.split("/").pop() || p,
}));
vi.mock("../services/projectWindows", () => ({
  openProjectInWindow: vi.fn(),
  defaultDeps: () => ({}),
}));
vi.mock("../windowContext", () => ({
  useCurrentProjectId: () => null, // no project open → skip the dot cluster, keep the harness small
  useReplaceCurrentProject: () => vi.fn(),
  useCurrentWindowLabel: () => "main",
}));
const projectStoreState = { projects: [], addProject: vi.fn(), touchProjectOpened: vi.fn() };
vi.mock("../stores/projectStore", () => ({
  useProjectStore: Object.assign((sel: (s: typeof projectStoreState) => unknown) => sel(projectStoreState), {
    getState: () => projectStoreState,
  }),
}));
vi.mock("../stores/runtimeStore", () => ({
  useRuntimeStore: (sel: (s: { status: Record<string, string>; openAgentIds: string[] }) => unknown) =>
    sel({ status: {}, openAgentIds: [] }),
}));
const uiState = {
  workMode: "build",
  agentOrdering: "attention",
  settingsRequest: null,
  clearSettingsRequest: vi.fn(),
};
vi.mock("../stores/uiStore", () => ({
  useUiStore: Object.assign((sel: (s: typeof uiState) => unknown) => sel(uiState), {
    getState: () => uiState,
  }),
}));
// The always-rendered profile control pulls its own stores — not under test here.
vi.mock("./AuthStatusButton", () => ({ AuthStatusButton: () => null }));
vi.mock("./AccountsScreen", () => ({ AccountsScreen: () => null }));
vi.mock("./AccountLoginModal", () => ({ AccountLoginModal: () => null }));
vi.mock("../services/accountSelection", () => ({ invalidateAccountState: vi.fn() }));

// The paywall hand-offs performTrialUnlock routes through.
vi.mock("../services/creditsMenuApi", () => ({
  openPaywallCheckout: vi.fn(() => Promise.resolve(true)),
  lastCheckoutUrl: vi.fn(() => null),
}));
vi.mock("../services/sparkleApi", () => ({
  openPaywall: vi.fn(() => Promise.resolve(true)),
  openSignIn: vi.fn(() => Promise.resolve(true)),
  PAYWALL_URL: "paywall-url",
  SIGN_IN_URL: "sign-in-url",
}));

import { TopBar } from "./TopBar";
import { openSignIn } from "../services/sparkleApi";
import { openPaywallCheckout } from "../services/creditsMenuApi";
import { useAuthStore } from "../stores/authStore";
import { useTrialStore } from "../stores/trialStore";

const mockOpenSignIn = vi.mocked(openSignIn);
const mockCheckout = vi.mocked(openPaywallCheckout);

// Token-less anonymous trial → deriveAuthView returns "trial" → the indicator shows.
function tokenlessTrial(promptsUsed: number) {
  useAuthStore.setState({ me: null, tokenPresent: false, loading: false, refresh: vi.fn() });
  useTrialStore.setState({ started: true, promptsUsed, loading: false });
}

// Signed-in-but-unpaid who dismissed the $99 wall to stay on the trial. Without the shared
// paywallDismissed flag, TopBar's own deriveAuthView would read this as "unpaid" and hide the
// counter — the edge case this test guards.
function signedInUnpaidDismissed(promptsUsed: number) {
  useAuthStore.setState({
    me: { clerkUserId: "u1", entitled: false, balanceCents: 0, tokenVersion: 1 },
    tokenPresent: true,
    loading: false,
    refresh: vi.fn(),
    paywallDismissed: true,
  });
  useTrialStore.setState({ started: true, promptsUsed, loading: false });
}

beforeEach(() => {
  mockOpenSignIn.mockReset().mockResolvedValue(true);
  mockCheckout.mockReset().mockResolvedValue(true);
});
afterEach(() => {
  cleanup();
  useAuthStore.setState({
    me: null,
    tokenPresent: false,
    loading: true,
    refresh: vi.fn(),
    paywallDismissed: false,
  });
  useTrialStore.setState({ started: false, promptsUsed: 0, loading: true });
});

describe("TopBar — in-bar trial indicator", () => {
  it("renders the counter inside the bar, ordered before the Recent/Open buttons", () => {
    tokenlessTrial(3);
    render(<TopBar onOpenSettings={vi.fn()} />);
    const counter = screen.getByText(/97 prompts left/);
    const recent = screen.getByRole("button", { name: /Recent/ });
    // In-row placement: the indicator sits to the LEFT of the action cluster (earlier in the DOM).
    expect(counter.compareDocumentPosition(recent) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows the counter for a signed-in-unpaid user who dismissed the paywall (the edge case)", () => {
    signedInUnpaidDismissed(3);
    render(<TopBar onOpenSettings={vi.fn()} />);
    // Before the shared paywallDismissed flag, TopBar read this user as "unpaid" and hid this.
    expect(screen.getByText(/97 prompts left/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Unlock/ })).toBeTruthy();
  });

  it("that dismissed-unpaid user's Unlock converts via one-click checkout, not sign-in", async () => {
    signedInUnpaidDismissed(3);
    render(<TopBar onOpenSettings={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Unlock/ }));
    await waitFor(() => expect(mockCheckout).toHaveBeenCalledTimes(1));
    expect(mockOpenSignIn).not.toHaveBeenCalled(); // signed in → Stripe checkout, never sign-in
  });

  it("hides the indicator when not in trial mode", () => {
    useAuthStore.setState({ me: null, tokenPresent: false, loading: false, refresh: vi.fn() });
    useTrialStore.setState({ started: false, promptsUsed: 0, loading: false }); // welcome, not trial
    render(<TopBar onOpenSettings={vi.fn()} />);
    expect(screen.queryByText(/prompts left/)).toBeNull();
  });

  it("Unlock routes through the paywall hand-off (a token-less user gets sign-in, never a dead-end)", async () => {
    tokenlessTrial(3);
    render(<TopBar onOpenSettings={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Unlock/ }));
    await waitFor(() => expect(mockOpenSignIn).toHaveBeenCalledTimes(1));
    // Token-less trial → sign-in hand-off (matches main's handleTrialUnlock for the no-token case).
    expect(mockCheckout).not.toHaveBeenCalled();
  });
});
