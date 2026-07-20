// @vitest-environment jsdom
//
// The one-time roborev consent modal. Covers: it only mounts when roborevConsentOpen is true; the
// LOCKED UX — Enable turns roborev on, "Not now" turns it off, and BOTH record consent_prompted and
// close the modal. configActions is mocked (no IPC); the settingsStore is the real one.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/configActions", () => ({
  markRoborevConsentPrompted: vi.fn().mockResolvedValue(undefined),
  setRoborevEnabled: vi.fn().mockResolvedValue(undefined),
}));

import { markRoborevConsentPrompted, setRoborevEnabled } from "../services/configActions";
import { useSettingsStore } from "../stores/settingsStore";
import { RoborevConsentModal } from "./RoborevConsentModal";

beforeEach(() => {
  useSettingsStore.setState({ roborevConsentOpen: true });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("RoborevConsentModal", () => {
  it("renders nothing when the modal is closed", () => {
    useSettingsStore.setState({ roborevConsentOpen: false });
    render(<RoborevConsentModal />);
    expect(screen.queryByText("Turn on roborev code review?")).toBeNull();
  });

  it("shows the title, body, and both buttons when open", () => {
    render(<RoborevConsentModal />);
    expect(screen.getByText("Turn on roborev code review?")).toBeTruthy();
    expect(screen.getByText(/quick AI review of each commit your BUILD agents make/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Enable" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Not now" })).toBeTruthy();
  });

  it("Enable: records consent, turns roborev ON, and closes", async () => {
    render(<RoborevConsentModal />);
    fireEvent.click(screen.getByRole("button", { name: "Enable" }));
    await waitFor(() => expect(setRoborevEnabled).toHaveBeenCalledWith(true));
    expect(markRoborevConsentPrompted).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(useSettingsStore.getState().roborevConsentOpen).toBe(false));
  });

  it("Not now: records consent, turns roborev OFF, and closes", async () => {
    render(<RoborevConsentModal />);
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    await waitFor(() => expect(setRoborevEnabled).toHaveBeenCalledWith(false));
    expect(markRoborevConsentPrompted).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(useSettingsStore.getState().roborevConsentOpen).toBe(false));
  });
});
