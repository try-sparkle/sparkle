// @vitest-environment jsdom
//
// The top-right kebab (CM-U6): menu open/close semantics (click, Escape, outside pointerdown,
// arrow-key roving focus), and its entry invoking the RIGHT reused surface — SettingsDialog
// (including the uiStore deep-open seam + Manage-accounts hand-off) and AuthStatusButton.
// Version / Support / Changelog moved OUT of this menu into the bottom-right StatusStrip
// (see ../StatusStrip.test.tsx); this suite pins what the kebab still owns.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../SettingsDialog", () => ({
  SettingsDialog: ({
    onClose,
    onManageAccounts,
    initialCategory,
  }: {
    onClose: () => void;
    onManageAccounts: () => void;
    initialCategory?: string;
  }) => (
    <div data-testid="settings-dialog" data-category={initialCategory ?? ""}>
      <button onClick={onClose}>close settings</button>
      <button onClick={onManageAccounts}>manage accounts</button>
    </div>
  ),
}));

vi.mock("../AuthStatusButton", () => ({
  AuthStatusButton: () => <button data-testid="auth-status">avatar</button>,
}));

vi.mock("../ModalShell", () => ({
  ModalShell: ({ children, onCancel }: { children: React.ReactNode; onCancel: () => void }) => (
    <div data-testid="modal-shell">
      {children}
      <button onClick={onCancel}>cancel shell</button>
    </div>
  ),
}));

vi.mock("../AccountsScreen", () => ({
  AccountsScreen: ({ onLogin }: { onLogin: (a: { id: string }) => void }) => (
    <div data-testid="accounts-screen">
      <button onClick={() => onLogin({ id: "acct-1" })}>login acct-1</button>
    </div>
  ),
}));

vi.mock("../AccountLoginModal", () => ({
  AccountLoginModal: ({
    account,
    onClose,
  }: {
    account: { id: string };
    onClose: () => void;
  }) => (
    <div data-testid="login-modal" data-account={account.id}>
      <button onClick={onClose}>close login</button>
    </div>
  ),
}));

const invalidateAccountStateMock = vi.fn();
vi.mock("../../services/accountSelection", () => ({
  invalidateAccountState: () => invalidateAccountStateMock(),
}));

import { ConciergeTopRight, KebabMenu } from "./KebabMenu";
import { useUiStore } from "../../stores/uiStore";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  act(() => useUiStore.getState().clearSettingsRequest());
});

const trigger = () => screen.getByRole("button", { name: "Sparkle menu" });

/** Open the menu (synchronous now that nothing in it waits on an async version). */
async function openMenu() {
  fireEvent.click(trigger());
  await screen.findByRole("menu", { name: "Sparkle menu" });
}

describe("KebabMenu — open/close", () => {
  it("is closed by default; the trigger carries menu-button semantics", () => {
    render(<KebabMenu />);
    const btn = trigger();
    expect(btn.getAttribute("aria-haspopup")).toBe("menu");
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("click opens a menu whose ONLY item is Settings, and focuses it", async () => {
    render(<KebabMenu />);
    await openMenu();
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    const items = screen.getAllByRole("menuitem");
    // Version / Support / Changelog live in the bottom-right StatusStrip now — not here.
    expect(items.map((el) => el.textContent)).toEqual(["Settings"]);
    expect(document.activeElement).toBe(items[0]);
  });

  it("no longer carries Version / Support / Changelog (they moved to the StatusStrip)", async () => {
    render(<KebabMenu />);
    await openMenu();
    expect(screen.queryByRole("menuitem", { name: /Version/ })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Support" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Changelog" })).toBeNull();
  });

  it("Escape closes the menu and returns focus to the trigger", async () => {
    render(<KebabMenu />);
    await openMenu();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("outside pointerdown closes the menu", async () => {
    render(<KebabMenu />);
    await openMenu();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("arrow keys keep focus on the single item (roving still wraps onto itself)", async () => {
    render(<KebabMenu />);
    await openMenu();
    const [only] = screen.getAllByRole("menuitem");
    if (!only) throw new Error("expected one menu item");
    fireEvent.keyDown(only, { key: "ArrowDown" });
    expect(document.activeElement).toBe(only);
    fireEvent.keyDown(only, { key: "ArrowUp" });
    expect(document.activeElement).toBe(only);
    fireEvent.keyDown(only, { key: "End" });
    expect(document.activeElement).toBe(only);
  });

  it("ArrowDown on the closed trigger opens the menu", async () => {
    render(<KebabMenu />);
    fireEvent.keyDown(trigger(), { key: "ArrowDown" });
    expect(await screen.findByRole("menu", { name: "Sparkle menu" })).toBeTruthy();
  });
});

describe("KebabMenu — reused surfaces", () => {
  it("Settings opens the reused SettingsDialog (menu closes); its onClose unmounts it", async () => {
    render(<KebabMenu />);
    await openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Settings" }));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByTestId("settings-dialog")).toBeTruthy();
    fireEvent.click(screen.getByText("close settings"));
    expect(screen.queryByTestId("settings-dialog")).toBeNull();
  });

  it("Escape dismisses the settings dialog", async () => {
    render(<KebabMenu />);
    await openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Settings" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("settings-dialog")).toBeNull();
  });

  it("honors the uiStore deep-open seam (AuthStatusButton → accounts pane)", async () => {
    render(<KebabMenu />);
    act(() => useUiStore.getState().openSettings("accounts"));
    const dialog = await screen.findByTestId("settings-dialog");
    expect(dialog.getAttribute("data-category")).toBe("accounts");
    // Closing clears the request so the SAME category re-triggers later.
    fireEvent.click(screen.getByText("close settings"));
    expect(useUiStore.getState().settingsRequest).toBeNull();
    act(() => useUiStore.getState().openSettings("accounts"));
    expect(await screen.findByTestId("settings-dialog")).toBeTruthy();
  });

  it("Manage accounts hands off to AccountsScreen, then onLogin to AccountLoginModal", async () => {
    render(<KebabMenu />);
    await openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Settings" }));
    fireEvent.click(screen.getByText("manage accounts"));
    expect(screen.queryByTestId("settings-dialog")).toBeNull();
    expect(screen.getByTestId("accounts-screen")).toBeTruthy();
    fireEvent.click(screen.getByText("login acct-1"));
    expect(screen.queryByTestId("accounts-screen")).toBeNull();
    const login = screen.getByTestId("login-modal");
    expect(login.getAttribute("data-account")).toBe("acct-1");
    // Closing the login modal invalidates the account-selection cache (badge refresh).
    fireEvent.click(screen.getByText("close login"));
    expect(screen.queryByTestId("login-modal")).toBeNull();
    expect(invalidateAccountStateMock).toHaveBeenCalledOnce();
  });
});

describe("ConciergeTopRight — mount-ready cluster", () => {
  it("renders the kebab with the adjacent reused AuthStatusButton avatar", () => {
    render(<ConciergeTopRight />);
    expect(trigger()).toBeTruthy();
    expect(screen.getByTestId("auth-status")).toBeTruthy();
  });
});
