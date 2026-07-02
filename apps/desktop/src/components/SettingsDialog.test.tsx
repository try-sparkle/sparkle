// @vitest-environment jsdom
//
// The redesigned settings dialog (the ⋯ menu): a left rail of categories driving a single
// right pane. We assert the default pane, that clicking a category swaps the pane, and that
// the close affordance fires onClose. The individual controls have their own tests; here we
// only care about the rail/pane shell.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Controls inside the panes persist to config.toml via these actions; mock so no IPC fires
// when a pane mounts or a control is touched.
vi.mock("../services/configActions", () => ({
  setAiFeature: vi.fn().mockResolvedValue(undefined),
  setAllAiFeatures: vi.fn().mockResolvedValue(undefined),
  setMaxConcurrentWorkers: vi.fn().mockResolvedValue(undefined),
  setAutoApplyUpdates: vi.fn().mockResolvedValue(undefined),
  setNotifyStatus: vi.fn().mockResolvedValue(undefined),
}));

// The Accounts pane's Sparkle-account block calls these (Tauri IPC / system browser); mock
// the two it fires so no IPC or browser launch happens under jsdom.
vi.mock("../services/sparkleApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/sparkleApi")>();
  return {
    ...actual,
    openSignIn: vi.fn().mockResolvedValue(true),
    signOut: vi.fn().mockResolvedValue(undefined),
  };
});

// The Credits pane has its own component tests (CreditsPanel.test.tsx); the shell test only
// cares that deep-open lands on the right category, so keep the pane body inert here.
vi.mock("./CreditsPanel", () => ({ CreditsPanel: () => null }));

import { openSignIn, signOut } from "../services/sparkleApi";
import { useAuthStore } from "../stores/authStore";
import { SettingsDialog } from "./SettingsDialog";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useAuthStore.setState({ me: null, tokenPresent: false, loading: true });
});

const heading = (name: string) => screen.queryByRole("heading", { name });

describe("SettingsDialog", () => {
  it("opens on the AI features pane by default", () => {
    render(<SettingsDialog onClose={vi.fn()} onManageAccounts={vi.fn()} />);
    expect(heading("AI features")).toBeTruthy();
    expect(heading("Notifications")).toBeNull();
  });

  it("opens on the requested pane when initialCategory is given (deep-open)", () => {
    render(
      <SettingsDialog onClose={vi.fn()} onManageAccounts={vi.fn()} initialCategory="credits" />,
    );
    expect(heading("Credits")).toBeTruthy();
    expect(heading("AI features")).toBeNull();
  });

  it("follows an initialCategory change while already open (deep-open into an open dialog)", () => {
    const { rerender } = render(<SettingsDialog onClose={vi.fn()} onManageAccounts={vi.fn()} />);
    expect(heading("AI features")).toBeTruthy();
    rerender(
      <SettingsDialog onClose={vi.fn()} onManageAccounts={vi.fn()} initialCategory="credits" />,
    );
    expect(heading("Credits")).toBeTruthy();
  });

  it("swaps the pane when a rail category is clicked", () => {
    render(<SettingsDialog onClose={vi.fn()} onManageAccounts={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Notifications" }));
    expect(heading("Notifications")).toBeTruthy();
    expect(heading("AI features")).toBeNull();
  });

  it("marks the selected rail item with aria-current", () => {
    render(<SettingsDialog onClose={vi.fn()} onManageAccounts={vi.fn()} />);
    expect(screen.getByRole("button", { name: "AI features" }).getAttribute("aria-current")).toBe(
      "page",
    );
    fireEvent.click(screen.getByRole("button", { name: "Appearance" }));
    expect(screen.getByRole("button", { name: "Appearance" }).getAttribute("aria-current")).toBe(
      "page",
    );
    expect(screen.getByRole("button", { name: "AI features" }).getAttribute("aria-current")).toBe(
      null,
    );
  });

  it("fires onClose from the close button", () => {
    const onClose = vi.fn();
    render(<SettingsDialog onClose={onClose} onManageAccounts={vi.fn()} />);
    fireEvent.click(screen.getByLabelText("Close settings"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("moves focus into the dialog on open", () => {
    render(<SettingsDialog onClose={vi.fn()} onManageAccounts={vi.fn()} />);
    expect(document.activeElement).toBe(screen.getByRole("dialog"));
  });

  it("fires onClose when the backdrop is clicked", () => {
    const onClose = vi.fn();
    render(<SettingsDialog onClose={onClose} onManageAccounts={vi.fn()} />);
    fireEvent.click(screen.getByTestId("settings-backdrop"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("routes the Accounts pane button to onManageAccounts", () => {
    const onManageAccounts = vi.fn();
    render(<SettingsDialog onClose={vi.fn()} onManageAccounts={onManageAccounts} />);
    fireEvent.click(screen.getByRole("button", { name: "Accounts" }));
    fireEvent.click(screen.getByRole("button", { name: /Manage accounts/ }));
    expect(onManageAccounts).toHaveBeenCalledTimes(1);
  });
});

// The Sparkle-account block in the Accounts pane. State is driven by the real zustand auth
// store (set directly per test); the sparkleApi calls it fires are mocked above.
describe("SettingsDialog — Sparkle account", () => {
  const openAccountsPane = () => {
    render(<SettingsDialog onClose={vi.fn()} onManageAccounts={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Accounts" }));
  };
  const me = {
    clerkUserId: "user_123",
    entitled: true,
    balanceCents: 500,
    tokenVersion: 1,
    email: "ada@example.com",
    name: "Ada Lovelace",
  };

  it("shows the signed-in email and signs out via sparkleApi + store reset", async () => {
    useAuthStore.setState({ loading: false, tokenPresent: true, me });
    openAccountsPane();
    expect(screen.getByText("ada@example.com")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(useAuthStore.getState().tokenPresent).toBe(false));
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().me).toBeNull();
    // The pane flips to the signed-out state after the reset.
    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
  });

  it("disables the button and shows progress while sign-out is in flight", async () => {
    let resolveSignOut!: () => void;
    vi.mocked(signOut).mockImplementationOnce(
      () => new Promise<void>((resolve) => (resolveSignOut = resolve)),
    );
    useAuthStore.setState({ loading: false, tokenPresent: true, me });
    openAccountsPane();
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    const inFlight = screen.getByRole("button", { name: "Signing out…" }) as HTMLButtonElement;
    expect(inFlight.disabled).toBe(true);
    resolveSignOut();
    // The pane flips to the signed-out UI, not just the store.
    await waitFor(() => expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy());
    expect(useAuthStore.getState().tokenPresent).toBe(false);
  });

  it("re-enables Sign out (still signed in) when signOut rejects — no wedge, no reset", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      vi.mocked(signOut).mockRejectedValueOnce(new Error("keychain locked"));
      useAuthStore.setState({ loading: false, tokenPresent: true, me });
      openAccountsPane();
      fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
      const btn = await screen.findByRole("button", { name: "Sign out" });
      await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false));
      // The failed sign-out must not pretend to have signed out.
      expect(useAuthStore.getState().tokenPresent).toBe(true);
      // Pin the catch block specifically — React also routes noise through console.error.
      expect(consoleError).toHaveBeenCalledWith("Sign out failed:", expect.any(Error));
    } finally {
      consoleError.mockRestore(); // even on assertion failure, don't mask later tests' errors
    }
  });

  it("falls back to name, then clerkUserId, when email is missing", () => {
    useAuthStore.setState({ loading: false, tokenPresent: true, me: { ...me, email: null } });
    openAccountsPane();
    expect(screen.getByText("Ada Lovelace")).toBeTruthy();
    cleanup();
    useAuthStore.setState({
      loading: false,
      tokenPresent: true,
      me: { ...me, email: null, name: null },
    });
    openAccountsPane();
    expect(screen.getByText("user_123")).toBeTruthy();
  });

  it("still offers Sign out when the token is present but /me failed (offline)", () => {
    useAuthStore.setState({ loading: false, tokenPresent: true, me: null });
    openAccountsPane();
    expect(screen.getByText("Signed in")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
  });

  it("shows the trial line and launches the browser sign-in when signed out", () => {
    useAuthStore.setState({ loading: false, tokenPresent: false, me: null });
    openAccountsPane();
    expect(screen.getByText(/limited free-trial mode/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(openSignIn).toHaveBeenCalledTimes(1);
  });

  it("shows a loading line while the auth store is still resolving", () => {
    useAuthStore.setState({ loading: true, tokenPresent: false, me: null });
    openAccountsPane();
    expect(screen.getByText("Checking sign-in status…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
  });
});
