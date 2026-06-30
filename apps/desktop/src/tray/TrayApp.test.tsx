// @vitest-environment jsdom
//
// Smoke test for TrayApp: outside Tauri, getTrayRoster resolves null and listeners are no-ops,
// so TrayApp renders the empty state. Canvas is unavailable in jsdom — paintTrayIcon must not throw.
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onFocusChanged: () => Promise.resolve(() => {}),
    hide: () => Promise.resolve(),
  }),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}));

describe("TrayApp", () => {
  it("renders the empty state with no Tauri backend", async () => {
    const { TrayApp } = await import("./TrayApp");
    render(<TrayApp />);
    await waitFor(() => expect(screen.getByText("No projects running.")).toBeTruthy());
  });
});
