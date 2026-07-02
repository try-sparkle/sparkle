// @vitest-environment jsdom
//
// The TopBar profile / auth-status control (right of the ⋯ menu). Verifies the three states
// (signed-in avatar letter, "Log in", "Sign up"), that all three deep-open the ⋯ menu's Accounts
// pane, and that it reacts to a live sign-in without a re-mount.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AuthStatusButton } from "./AuthStatusButton";
import { useAuthStore } from "../stores/authStore";
import { useTrialStore } from "../stores/trialStore";
import { useUiStore } from "../stores/uiStore";
import type { Me } from "../services/entitlement";

const signedOut = () => {
  useAuthStore.setState({ me: null, tokenPresent: false, loading: false });
  useTrialStore.setState({ started: false, promptsUsed: 0, loading: false });
  useUiStore.setState({ settingsRequest: null });
};

beforeEach(signedOut);
afterEach(cleanup);

describe("AuthStatusButton", () => {
  it("shows nothing while auth/trial state is still loading", () => {
    useAuthStore.setState({ loading: true });
    const { container } = render(<AuthStatusButton />);
    expect(container.firstChild).toBeNull();
  });

  it("brand-new user (no token, no trial) shows Sign up", () => {
    render(<AuthStatusButton />);
    expect(screen.getByRole("button", { name: "Sign up" })).toBeTruthy();
  });

  it("returning user (trial started, no token) shows Log in", () => {
    useTrialStore.setState({ started: true });
    render(<AuthStatusButton />);
    expect(screen.getByRole("button", { name: "Log in" })).toBeTruthy();
  });

  it("signed in shows an avatar with the uppercased first letter of the identity", () => {
    const me: Me = {
      clerkUserId: "user_1",
      entitled: true,
      balanceCents: 0,
      tokenVersion: 1,
      name: "ada lovelace",
      email: "ada@example.com",
    };
    useAuthStore.setState({ me, tokenPresent: true });
    render(<AuthStatusButton />);
    // Name wins over email → "A".
    const btn = screen.getByRole("button", { name: "Account: ada lovelace" });
    expect(btn.textContent).toBe("A");
  });

  it("falls back email → clerkUserId for the avatar letter", () => {
    const me: Me = {
      clerkUserId: "zeta_123",
      entitled: false,
      balanceCents: 0,
      tokenVersion: 1,
      email: "bob@example.com",
    };
    useAuthStore.setState({ me, tokenPresent: true });
    render(<AuthStatusButton />);
    expect(screen.getByRole("button", { name: "Account: bob@example.com" }).textContent).toBe("B");
  });

  it("signed in with no resolvable identity renders the neutral fallback (no letter, 'Account' label)", () => {
    const me: Me = {
      clerkUserId: "",
      entitled: true,
      balanceCents: 0,
      tokenVersion: 1,
      name: "",
      email: "",
    };
    useAuthStore.setState({ me, tokenPresent: true });
    render(<AuthStatusButton />);
    const btn = screen.getByRole("button", { name: "Account" });
    // No letter text — the FiUser glyph (an <svg>) stands in instead.
    expect(btn.textContent).toBe("");
    expect(btn.querySelector("svg")).toBeTruthy();
  });

  it("all three states deep-open the ⋯ menu's Accounts pane", () => {
    // Sign up
    render(<AuthStatusButton />);
    fireEvent.click(screen.getByRole("button", { name: "Sign up" }));
    expect(useUiStore.getState().settingsRequest).toBe("accounts");

    // Log in
    useUiStore.setState({ settingsRequest: null });
    useTrialStore.setState({ started: true });
    cleanup();
    render(<AuthStatusButton />);
    fireEvent.click(screen.getByRole("button", { name: "Log in" }));
    expect(useUiStore.getState().settingsRequest).toBe("accounts");

    // Signed in
    useUiStore.setState({ settingsRequest: null });
    useAuthStore.setState({
      me: { clerkUserId: "u", entitled: true, balanceCents: 0, tokenVersion: 1, name: "Carol" },
      tokenPresent: true,
    });
    cleanup();
    render(<AuthStatusButton />);
    fireEvent.click(screen.getByRole("button", { name: "Account: Carol" }));
    expect(useUiStore.getState().settingsRequest).toBe("accounts");
  });

  it("reacts to a live sign-in (Sign up → avatar) without a re-mount", () => {
    render(<AuthStatusButton />);
    expect(screen.getByRole("button", { name: "Sign up" })).toBeTruthy();
    act(() => {
      useAuthStore.setState({
        me: { clerkUserId: "u", entitled: true, balanceCents: 0, tokenVersion: 1, name: "Dana" },
        tokenPresent: true,
      });
    });
    expect(screen.queryByRole("button", { name: "Sign up" })).toBeNull();
    expect(screen.getByRole("button", { name: "Account: Dana" }).textContent).toBe("D");
  });
});
