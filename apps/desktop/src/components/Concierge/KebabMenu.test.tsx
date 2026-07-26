// @vitest-environment jsdom
//
// The top-right kebab (CM-U6): menu open/close semantics (click, Escape peel, outside
// pointerdown, arrow-key roving focus), and each entry invoking the RIGHT reused surface —
// version popover (check for updates / logs / changelog), SupportModal, SettingsDialog
// (including the uiStore deep-open seam + Manage-accounts hand-off), AuthStatusButton.
// The reused surfaces are mocked at their module seams; this suite pins the wiring.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const openUrlMock = vi.fn<(url: string) => Promise<void>>(() => Promise.resolve());
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: (url: string) => openUrlMock(url),
}));

const revealLogsMock = vi.fn<() => Promise<void>>(() => Promise.resolve());
vi.mock("../../logger", () => ({
  getAppVersion: () => Promise.resolve("9.9.9"),
  getLogDir: () => Promise.resolve("/tmp/sparkle-logs"),
  revealLogs: () => revealLogsMock(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const checkForUpdatesMock = vi.fn<() => Promise<string>>(() => Promise.resolve("up-to-date"));
vi.mock("../../services/updaterService", () => ({
  checkForUpdates: () => checkForUpdatesMock(),
}));

vi.mock("../SupportModal", () => ({
  SupportModal: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="support-modal">
      <button onClick={onClose}>close support</button>
    </div>
  ),
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

import { CHANGELOG_URL, checkLabel, ConciergeTopRight, KebabMenu } from "./KebabMenu";
import { useUiStore } from "../../stores/uiStore";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  act(() => useUiStore.getState().clearSettingsRequest());
});

const trigger = () => screen.getByRole("button", { name: "Sparkle menu" });

/** Open the menu and wait for the version to resolve (the Version entry needs it). */
async function openMenu() {
  fireEvent.click(trigger());
  await screen.findByText("Version v9.9.9");
}

async function openVersionPopover() {
  await openMenu();
  fireEvent.click(screen.getByRole("menuitem", { name: /Version v9\.9\.9/ }));
  return screen.getByRole("menu", { name: "Version" });
}

describe("checkLabel (pure)", () => {
  it("pins the manual-check strings", () => {
    expect(checkLabel("idle")).toBe("Check for updates");
    expect(checkLabel("checking")).toBe("Checking for updates…");
    expect(checkLabel("uptodate")).toBe("You're up to date");
    expect(checkLabel("error")).toBe("Check failed — retry");
  });
});

describe("KebabMenu — open/close", () => {
  it("is closed by default; the trigger carries menu-button semantics", () => {
    render(<KebabMenu />);
    const btn = trigger();
    expect(btn.getAttribute("aria-haspopup")).toBe("menu");
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("click opens a menu with Version / Support / Settings items and focuses the first", async () => {
    render(<KebabMenu />);
    await openMenu();
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    const menu = screen.getByRole("menu", { name: "Sparkle menu" });
    expect(menu).toBeTruthy();
    const items = screen.getAllByRole("menuitem");
    expect(items.map((el) => el.textContent)).toEqual([
      "Version v9.9.9",
      "Support",
      "Settings",
    ]);
    expect(document.activeElement).toBe(items[0]);
  });

  it("Escape closes the menu and returns focus to the trigger", async () => {
    render(<KebabMenu />);
    await openMenu();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("Escape peels the version popover FIRST, back to the Version item", async () => {
    render(<KebabMenu />);
    await openVersionPopover();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "Version" })).toBeNull();
    expect(screen.getByRole("menu", { name: "Sparkle menu" })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: /Version/ }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("outside pointerdown closes everything", async () => {
    render(<KebabMenu />);
    await openVersionPopover();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("arrow keys rove focus through the menu items and wrap", async () => {
    render(<KebabMenu />);
    await openMenu();
    const [first, second, third] = screen.getAllByRole("menuitem");
    if (!first || !second || !third) throw new Error("expected three menu items");
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(document.activeElement).toBe(second);
    fireEvent.keyDown(second, { key: "ArrowDown" });
    expect(document.activeElement).toBe(third);
    fireEvent.keyDown(third, { key: "ArrowDown" });
    expect(document.activeElement).toBe(first); // wraps
    fireEvent.keyDown(first, { key: "ArrowUp" });
    expect(document.activeElement).toBe(third); // wraps back
    fireEvent.keyDown(third, { key: "Home" });
    expect(document.activeElement).toBe(first);
  });

  it("ArrowDown on the closed trigger opens the menu", async () => {
    render(<KebabMenu />);
    fireEvent.keyDown(trigger(), { key: "ArrowDown" });
    expect(await screen.findByRole("menu", { name: "Sparkle menu" })).toBeTruthy();
  });
});

describe("KebabMenu — version popover", () => {
  it("opens with Check for updates / Open logs / Changelog and focuses its first item", async () => {
    render(<KebabMenu />);
    const popover = await openVersionPopover();
    const labels = Array.from(popover.querySelectorAll('[role="menuitem"]')).map(
      (el) => el.textContent,
    );
    expect(labels).toEqual(["Check for updates", "Open logs in Finder →", "Changelog"]);
    expect(document.activeElement?.textContent).toBe("Check for updates");
  });

  it("Changelog opens the changelog URL and closes the menu", async () => {
    render(<KebabMenu />);
    await openVersionPopover();
    fireEvent.click(screen.getByRole("menuitem", { name: "Changelog" }));
    expect(openUrlMock).toHaveBeenCalledWith(CHANGELOG_URL);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("Open logs reveals the log folder and closes the menu", async () => {
    render(<KebabMenu />);
    await openVersionPopover();
    fireEvent.click(screen.getByRole("menuitem", { name: /Open logs in Finder/ }));
    expect(revealLogsMock).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("Check for updates → up-to-date shows the inline confirmation", async () => {
    checkForUpdatesMock.mockResolvedValueOnce("up-to-date");
    render(<KebabMenu />);
    await openVersionPopover();
    fireEvent.click(screen.getByRole("menuitem", { name: "Check for updates" }));
    expect(await screen.findByText("You're up to date")).toBeTruthy();
    expect(checkForUpdatesMock).toHaveBeenCalledOnce();
  });

  it("Check for updates → error shows the retry affordance", async () => {
    checkForUpdatesMock.mockResolvedValueOnce("error");
    render(<KebabMenu />);
    await openVersionPopover();
    fireEvent.click(screen.getByRole("menuitem", { name: "Check for updates" }));
    expect(await screen.findByText("Check failed — retry")).toBeTruthy();
  });

  it("Check for updates → update-available closes the menu (the banner takes over)", async () => {
    checkForUpdatesMock.mockResolvedValueOnce("update-available");
    render(<KebabMenu />);
    await openVersionPopover();
    fireEvent.click(screen.getByRole("menuitem", { name: "Check for updates" }));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });
});

describe("KebabMenu — reused surfaces", () => {
  it("Support opens the reused SupportModal (menu closes); its onClose unmounts it", async () => {
    render(<KebabMenu />);
    await openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Support" }));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByTestId("support-modal")).toBeTruthy();
    fireEvent.click(screen.getByText("close support"));
    expect(screen.queryByTestId("support-modal")).toBeNull();
  });

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
