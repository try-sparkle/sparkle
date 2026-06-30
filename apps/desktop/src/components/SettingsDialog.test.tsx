// @vitest-environment jsdom
//
// The redesigned settings dialog (the ⋯ menu): a left rail of categories driving a single
// right pane. We assert the default pane, that clicking a category swaps the pane, and that
// the close affordance fires onClose. The individual controls have their own tests; here we
// only care about the rail/pane shell.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

import { SettingsDialog } from "./SettingsDialog";

afterEach(cleanup);

const heading = (name: string) => screen.queryByRole("heading", { name });

describe("SettingsDialog", () => {
  it("opens on the AI features pane by default", () => {
    render(<SettingsDialog onClose={vi.fn()} onManageAccounts={vi.fn()} />);
    expect(heading("AI features")).toBeTruthy();
    expect(heading("Notifications")).toBeNull();
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
