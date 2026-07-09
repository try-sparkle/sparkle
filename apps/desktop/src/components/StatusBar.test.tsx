// @vitest-environment jsdom
import { act, cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the updater service so we drive the manual-check outcome without the real Tauri plugin.
const checkForUpdates = vi.fn();
vi.mock("../services/updaterService", () => ({
  checkForUpdates: (...a: unknown[]) => checkForUpdates(...a),
}));

// Mock the logger (Tauri invokes) — resolve a version so the popover is openable.
const revealLogs = vi.fn(() => Promise.resolve());
vi.mock("../logger", () => ({
  getAppVersion: () => Promise.resolve("1.2.3"),
  getLogDir: () => Promise.resolve("/logs"),
  revealLogs: () => revealLogs(),
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(() => Promise.resolve()) }));
vi.mock("./SupportModal", () => ({ SupportModal: () => null }));

import { StatusBar } from "./StatusBar";

afterEach(cleanup);
beforeEach(() => {
  checkForUpdates.mockReset();
});

/** Render and open the bottom-left version popover (waits for the version to resolve). */
async function openVersionMenu() {
  render(<StatusBar />);
  fireEvent.click(await screen.findByText("v1.2.3"));
}

describe("StatusBar — Check for updates", () => {
  it("shows 'Check for updates' ABOVE 'Open logs in Finder →' in the popover", async () => {
    await openVersionMenu();
    const check = screen.getByText("Check for updates");
    const logs = screen.getByText("Open logs in Finder →");
    // logs must FOLLOW check in DOM order (i.e. check is rendered above logs).
    expect(check.compareDocumentPosition(logs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("already up to date → inline \"You're up to date\"", async () => {
    checkForUpdates.mockResolvedValue("up-to-date");
    await openVersionMenu();
    fireEvent.click(screen.getByText("Check for updates"));
    expect(await screen.findByText("You're up to date")).toBeTruthy();
    expect(checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it("check fails → inline 'Check failed — retry'", async () => {
    checkForUpdates.mockResolvedValue("error");
    await openVersionMenu();
    fireEvent.click(screen.getByText("Check for updates"));
    expect(await screen.findByText("Check failed — retry")).toBeTruthy();
  });

  it("update found → closes the popover (the banner surfaces it)", async () => {
    checkForUpdates.mockResolvedValue("update-available");
    await openVersionMenu();
    fireEvent.click(screen.getByText("Check for updates"));
    await waitFor(() => expect(screen.queryByText("Open logs in Finder →")).toBeNull());
  });

  it("does not show a stale result if the popover closed mid-check (roborev)", async () => {
    // A check whose promise we resolve manually, AFTER closing the popover.
    let resolveCheck!: (o: string) => void;
    checkForUpdates.mockImplementation(() => new Promise((r) => (resolveCheck = r)));
    render(<StatusBar />);
    fireEvent.click(await screen.findByText("v1.2.3"));
    fireEvent.click(screen.getByText("Check for updates"));
    expect(screen.getByText("Checking for updates…")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" }); // close mid-check
    await act(async () => resolveCheck("up-to-date")); // resolves after close
    fireEvent.click(screen.getByText("v1.2.3")); // reopen
    // Fresh, not the stale "You're up to date".
    expect(screen.getByText("Check for updates")).toBeTruthy();
    expect(screen.queryByText("You're up to date")).toBeNull();
  });

  it("does not leak a stale result across a close+reopen mid-check (roborev)", async () => {
    // Session A starts a check, is closed, then session B is opened BEFORE A's check resolves.
    // A's result must not write into the freshly reopened session B.
    let resolveCheck!: (o: string) => void;
    checkForUpdates.mockImplementation(() => new Promise((r) => (resolveCheck = r)));
    render(<StatusBar />);
    fireEvent.click(await screen.findByText("v1.2.3")); // open A
    fireEvent.click(screen.getByText("Check for updates")); // A's check in flight
    fireEvent.keyDown(document, { key: "Escape" }); // close A
    fireEvent.click(screen.getByText("v1.2.3")); // reopen (session B)
    await act(async () => resolveCheck("up-to-date")); // A resolves into B
    expect(screen.getByText("Check for updates")).toBeTruthy();
    expect(screen.queryByText("You're up to date")).toBeNull();
  });
});
