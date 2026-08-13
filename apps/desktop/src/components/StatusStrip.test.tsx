// @vitest-environment jsdom
//
// The bottom-right status strip: Changelog · Support · v{version}. This is the restoration of the
// deleted StatusBar's chrome, so it inherits that suite's contracts — notably the update-check
// session guard, which must not regress now that the logic is shared (components/appChrome.ts).
//
// What's pinned here:
//   • all three items render, right-aligned, in order
//   • Changelog and Support are announced as LINKS with accessible names (the explicit ask)
//   • Changelog opens the IN-APP What's New panel and does NOT navigate the webview
//   • Support opens the REUSED SupportModal (mocked at its module seam)
//   • the version opens a popover that still reaches revealLogs() — the point of the original
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const openUrlMock = vi.fn<(url: string) => Promise<void>>(() => Promise.resolve());
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: (url: string) => openUrlMock(url),
}));

const revealLogsMock = vi.fn<() => Promise<void>>(() => Promise.resolve());
vi.mock("../logger", () => ({
  getAppVersion: () => Promise.resolve("1.2.3"),
  getLogDir: () => Promise.resolve("/tmp/sparkle-logs"),
  revealLogs: () => revealLogsMock(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const checkForUpdatesMock = vi.fn<() => Promise<string>>(() => Promise.resolve("up-to-date"));
vi.mock("../services/updaterService", () => ({
  checkForUpdates: () => checkForUpdatesMock(),
}));

vi.mock("./SupportModal", () => ({
  SupportModal: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="support-modal">
      <button onClick={onClose}>close support</button>
    </div>
  ),
}));

// The strip mounts the What's New panel (its Changelog link is that panel's entry point), which
// reaches the changelog API through the Tauri HTTP plugin. Stub the network seam; the panel's own
// behaviour is covered in WhatsNewPanel.test.tsx.
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) }),
}));

import { StatusStrip } from "./StatusStrip";
import { CHANGELOG_URL } from "./appChrome";
import { useWhatsNewStore } from "../stores/whatsNewStore";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useWhatsNewStore.setState({ open: false });
});

const versionButton = () => screen.getByRole("button", { name: "v1.2.3" });

/** Render and open the version popover (waits for the version to resolve from Rust). */
async function openVersionPopover() {
  render(<StatusStrip />);
  fireEvent.click(await screen.findByText("v1.2.3"));
  return screen.getByRole("menu", { name: "Version" });
}

describe("StatusStrip — the three items", () => {
  it("renders Changelog, Support and the version, in that order", async () => {
    render(<StatusStrip />);
    const strip = screen.getByTestId("status-strip");
    expect(screen.getByText("Changelog")).toBeTruthy();
    expect(screen.getByText("Support")).toBeTruthy();
    expect(await screen.findByText("v1.2.3")).toBeTruthy();
    const order = Array.from(strip.querySelectorAll("a,button")).map((el) => el.textContent);
    expect(order).toEqual(["Changelog", "Support", "v1.2.3"]);
  });

  it("hugs the RIGHT edge of its row (the 'bottom right' placement)", () => {
    render(<StatusStrip />);
    const strip = screen.getByTestId("status-strip");
    expect(strip.style.justifyContent).toBe("flex-end");
    // A layout row, not an overlay: nothing here is position:fixed/absolute, so it cannot occlude
    // the terminal stage or the composer (and can't be trapped by an ancestor's `filter`).
    expect(strip.style.position).toBe("");
  });

  it("does not render the version-number popover until the version is clicked", async () => {
    render(<StatusStrip />);
    await screen.findByText("v1.2.3");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(versionButton().getAttribute("aria-expanded")).toBe("false");
  });
});

describe("StatusStrip — Changelog and Support are links", () => {
  it("both are exposed as links with accessible names", () => {
    render(<StatusStrip />);
    const names = screen.getAllByRole("link").map((el) => el.textContent);
    expect(names).toEqual(["Changelog", "Support"]);
  });

  it("Changelog opens the IN-APP What's New panel, not the browser and not the webview", () => {
    // DELIBERATELY CHANGED: this used to assert openUrl(CHANGELOG_URL). The public page was 35
    // releases stale and the repo is private, so "what changed in the build I just restarted into?"
    // could not be answered without leaving the app. The anchor keeps its href — a real destination
    // for the accessible name — but the click now opens the panel.
    render(<StatusStrip />);
    const link = screen.getByRole("link", { name: "Changelog" });
    expect(link.getAttribute("href")).toBe(CHANGELOG_URL);
    expect(useWhatsNewStore.getState().open).toBe(false);
    const evt = new MouseEvent("click", { bubbles: true, cancelable: true });
    // A raw dispatch (rather than fireEvent) so `defaultPrevented` is inspectable below; act() is
    // what flushes the store subscription into a render.
    act(() => {
      link.dispatchEvent(evt);
    });
    expect(useWhatsNewStore.getState().open).toBe(true);
    expect(screen.getByTestId("whats-new-panel")).toBeTruthy();
    expect(openUrlMock).not.toHaveBeenCalled(); // it no longer punts to the system browser
    expect(evt.defaultPrevented).toBe(true); // the webview must never navigate away
  });

  it("Support opens the reused SupportModal; its onClose unmounts it", () => {
    render(<StatusStrip />);
    expect(screen.queryByTestId("support-modal")).toBeNull();
    fireEvent.click(screen.getByRole("link", { name: "Support" }));
    expect(screen.getByTestId("support-modal")).toBeTruthy();
    fireEvent.click(screen.getByText("close support"));
    expect(screen.queryByTestId("support-modal")).toBeNull();
  });

  it("both links are focusable", () => {
    render(<StatusStrip />);
    for (const link of screen.getAllByRole("link")) {
      link.focus();
      expect(document.activeElement).toBe(link);
    }
  });
});

describe("StatusStrip — version popover", () => {
  it("offers Check for updates then Open logs in Finder, and focuses the first", async () => {
    const popover = await openVersionPopover();
    const labels = Array.from(popover.querySelectorAll('[role="menuitem"]')).map(
      (el) => el.textContent,
    );
    expect(labels).toEqual(["Check for updates", "Open logs in Finder →"]);
    expect(document.activeElement?.textContent).toBe("Check for updates");
  });

  it("Open logs in Finder still reaches revealLogs() and closes the popover", async () => {
    await openVersionPopover();
    fireEvent.click(screen.getByRole("menuitem", { name: /Open logs in Finder/ }));
    expect(revealLogsMock).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("Escape closes it and hands focus back to the version button", async () => {
    await openVersionPopover();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(versionButton());
  });

  it("outside pointerdown closes it", async () => {
    await openVersionPopover();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("Check for updates → up-to-date shows the inline confirmation", async () => {
    checkForUpdatesMock.mockResolvedValueOnce("up-to-date");
    await openVersionPopover();
    fireEvent.click(screen.getByRole("menuitem", { name: "Check for updates" }));
    expect(await screen.findByText("You're up to date")).toBeTruthy();
    expect(checkForUpdatesMock).toHaveBeenCalledOnce();
  });

  it("Check for updates → error shows the retry affordance", async () => {
    checkForUpdatesMock.mockResolvedValueOnce("error");
    await openVersionPopover();
    fireEvent.click(screen.getByRole("menuitem", { name: "Check for updates" }));
    expect(await screen.findByText("Check failed — retry")).toBeTruthy();
  });

  it("Check for updates → update-available closes the popover (the banner takes over)", async () => {
    checkForUpdatesMock.mockResolvedValueOnce("update-available");
    await openVersionPopover();
    fireEvent.click(screen.getByRole("menuitem", { name: "Check for updates" }));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("does not leak a stale result across a close+reopen mid-check (the StatusBar guard)", async () => {
    // Session A starts a check, is closed, then session B is opened BEFORE A's check resolves.
    // A's result must not write into the freshly reopened session B.
    let resolveCheck!: (o: string) => void;
    checkForUpdatesMock.mockImplementation(() => new Promise((r) => (resolveCheck = r)));
    await openVersionPopover(); // session A
    fireEvent.click(screen.getByRole("menuitem", { name: "Check for updates" })); // in flight
    expect(screen.getByText("Checking for updates…")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" }); // close A
    fireEvent.click(versionButton()); // reopen → session B
    await act(async () => resolveCheck("up-to-date")); // A resolves into B
    expect(screen.getByText("Check for updates")).toBeTruthy();
    expect(screen.queryByText("You're up to date")).toBeNull();
  });
});
