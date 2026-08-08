// @vitest-environment jsdom
//
// The profile / auth-status control (right of the ⋯ menu). Verifies the three states (signed-in
// avatar letter, "Log in", "Sign up"), where each of them deep-opens, that the signed-in avatar
// carries the user's OWN availability dot, and that it reacts to a live sign-in without a re-mount.
//
// TWO THINGS CHANGED HERE WITH SOCIAL CODING (design §1, §10), and both are why the expected
// strings below name an availability:
//   • The signed-in avatar now opens the **Chat** pane, not Accounts — the founder's words are
//     "when I click on my avatar circle, it takes me to my settings page, where it lets me set my
//     status", and the status is the dot ON this button. The two signed-OUT variants still open
//     Accounts, whose one action is signing in.
//   • The availability word is repeated onto the BUTTON's aria-label. `PersonAvatar` names it in
//     its own aria-label, but a button takes its accessible name from its label rather than its
//     contents, so without this the dot would be colour and nothing else (WCAG 1.4.1).
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AuthStatusButton } from "./AuthStatusButton";
import { useAuthStore } from "../stores/authStore";
import { useTrialStore } from "../stores/trialStore";
import { useUiStore } from "../stores/uiStore";
import { useSocialStore, EMPTY_PROFILE } from "../stores/socialStore";
import type { Me } from "../services/entitlement";

const signedOut = () => {
  useAuthStore.setState({ me: null, tokenPresent: false, loading: false });
  useTrialStore.setState({ started: false, promptsUsed: 0, loading: false });
  useUiStore.setState({ settingsRequest: null });
  // The store default is `unavailable` → the dot reads Offline, which is what the labels below say.
  useSocialStore.setState({ me: EMPTY_PROFILE });
};

/** The availability the rendered dot is actually painting. */
const paintedDot = () =>
  screen.getByTestId("availability-dot-slot").firstElementChild?.getAttribute("data-availability");

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
    const btn = screen.getByRole("button", { name: "Account: ada lovelace — Offline" });
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
    expect(
      screen.getByRole("button", { name: "Account: bob@example.com — Offline" }).textContent,
    ).toBe("B");
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
    const btn = screen.getByRole("button", { name: "Account — Offline" });
    // No letter text — the FiUser glyph (an <svg>) stands in instead.
    expect(btn.textContent).toBe("");
    expect(btn.querySelector("svg")).toBeTruthy();
  });

  it("the two signed-OUT states deep-open the ⋯ menu's Accounts pane", () => {
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
  });

  // The founder's ask, and the reason the dot lives on this button at all: the control that CHANGES
  // your status has to be one click from the mark that SHOWS it. Landing on Accounts would mean
  // seeing your own dot and then hunting the rail for where to change it.
  it("the signed-in avatar deep-opens the CHAT pane, where the status is set", () => {
    useAuthStore.setState({
      me: { clerkUserId: "u", entitled: true, balanceCents: 0, tokenVersion: 1, name: "Carol" },
      tokenPresent: true,
    });
    render(<AuthStatusButton />);
    fireEvent.click(screen.getByRole("button", { name: "Account: Carol — Offline" }));
    expect(useUiStore.getState().settingsRequest).toBe("chat");
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
    expect(screen.getByRole("button", { name: "Account: Dana — Offline" }).textContent).toBe("D");
  });
});

// ── THE SELF AVAILABILITY DOT ─────────────────────────────────────────────────────────────────
//
// The founder: "if I want to be seen as being online and discoverable then it would have a little
// green dot… on the top right corner of the circle". The dot is a rendering of the user's own
// durable VISIBILITY intent — the app being open is what supplies the liveness half — so these
// drive `socialStore.me.visibility` and read what got painted.
describe("AuthStatusButton — the self availability dot", () => {
  const signedIn = () =>
    useAuthStore.setState({
      me: { clerkUserId: "u", entitled: true, balanceCents: 0, tokenVersion: 1, name: "Ada" },
      tokenPresent: true,
    });

  it("paints AVAILABLE while the user is discoverable, and names it in the accessible name", () => {
    signedIn();
    useSocialStore.setState({ me: { ...EMPTY_PROFILE, visibility: "public" } });
    render(<AuthStatusButton />);
    expect(paintedDot()).toBe("available");
    expect(screen.getByRole("button", { name: "Account: Ada — Available" })).toBeTruthy();
  });

  it("paints AVAILABLE for connections-only too — that visibility is not invisibility", () => {
    signedIn();
    useSocialStore.setState({ me: { ...EMPTY_PROFILE, visibility: "connections" } });
    render(<AuthStatusButton />);
    expect(paintedDot()).toBe("available");
  });

  it("paints OFFLINE while the user is Unavailable", () => {
    signedIn();
    useSocialStore.setState({ me: { ...EMPTY_PROFILE, visibility: "unavailable" } });
    render(<AuthStatusButton />);
    expect(paintedDot()).toBe("offline");
    expect(screen.getByRole("button", { name: "Account: Ada — Offline" })).toBeTruthy();
  });

  it("follows a live visibility change without a re-mount", () => {
    signedIn();
    render(<AuthStatusButton />);
    expect(paintedDot()).toBe("offline");
    act(() => {
      useSocialStore.setState({ me: { ...EMPTY_PROFILE, visibility: "public" } });
    });
    expect(paintedDot()).toBe("available");
  });

  // The geometry is `PersonAvatar`'s, at the size this button already used. Asserting the OFFSET
  // here would be a second copy of a formula that file owns and tests; asserting the SIZE is what
  // this file is responsible for — a hand-placed dot, or a size passed as the row's 18, would put
  // the mark somewhere the design does not put it.
  it("hands PersonAvatar this button's own 28px size and lets it do the geometry", () => {
    signedIn();
    render(<AuthStatusButton />);
    const avatar = screen.getByTestId("person-avatar") as HTMLElement;
    expect(avatar.style.width).toBe("28px");
    expect(avatar.style.height).toBe("28px");
  });
});
