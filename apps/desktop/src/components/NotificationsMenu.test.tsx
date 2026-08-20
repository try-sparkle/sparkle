// @vitest-environment jsdom
//
// Wiring test for the Notifications menu: each row reflects the stored pref and toggling it
// writes back to settingsStore. The pure edge/copy logic is covered in engine/attention.test.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

import { NotificationsMenu } from "./NotificationsMenu";
import { useSettingsStore, DEFAULT_NOTIFY_STATUSES } from "../stores/settingsStore";

beforeEach(() => {
  useSettingsStore.setState({ notifyStatuses: { ...DEFAULT_NOTIFY_STATUSES } });
});
afterEach(() => cleanup());

describe("NotificationsMenu", () => {
  it("renders a checkbox per notifiable status reflecting the stored prefs", () => {
    render(<NotificationsMenu />);
    // errored + done default ON; all rendered rows are real checkboxes.
    expect(screen.getByRole("checkbox", { name: "Errored or crashed" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("checkbox", { name: "Done / completed" }).getAttribute("aria-checked")).toBe("true");
  });

  it("toggling a row writes the new value into settingsStore", () => {
    render(<NotificationsMenu />);
    const errored = screen.getByRole("checkbox", { name: "Errored or crashed" });
    fireEvent.click(errored);
    expect(useSettingsStore.getState().notifyStatuses.errored).toBe(false);
    fireEvent.click(errored);
    expect(useSettingsStore.getState().notifyStatuses.errored).toBe(true);
  });

  it("reflects a programmatic store change (checkbox is driven by the store, not local state)", () => {
    render(<NotificationsMenu />);
    const name = "Needs your answer (a question)";
    expect(screen.getByRole("checkbox", { name }).getAttribute("aria-checked")).toBe("true");
    act(() => useSettingsStore.getState().setNotifyStatus("waiting", false));
    expect(screen.getByRole("checkbox", { name }).getAttribute("aria-checked")).toBe("false");
  });

  it("does not offer the noisy/low-signal statuses (working/stopped)", () => {
    render(<NotificationsMenu />);
    expect(screen.queryByRole("checkbox", { name: /working/i })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /stopped/i })).toBeNull();
  });

  it("DOES offer `blocked` — but leaves it OFF, so listing it cannot start a storm", () => {
    // ⚠️ REVERSES THE ASSERTION ABOVE FOR ONE STATUS (founder, 2026-08-18). `blocked` was hidden as
    // "passive", which described statusEngine's quiet-settle timer and stopped being true when
    // `stallEscalation.OUTSTANDING` narrowed to "the founder is the only actor who can clear it" —
    // its members now include `blocked-on-human`, an agent that was ASKED and said a person is
    // blocking it. Hiding the toggle for that is the same text/colour mismatch he reported on the
    // dot, one layer up.
    render(<NotificationsMenu />);
    const box = screen.getByRole("checkbox", { name: /blocked/i });
    // BOTH HALVES MATTER, and the second is the one that keeps this safe: the notification pipeline
    // keys on STATUS, not on stall cause, so this single toggle covers the whole red tier. Shipping
    // it ON would page for every OUTSTANDING cause — the storm `attention.ATTENTION` exists to
    // avoid. Discoverable, not default.
    expect(box).not.toBeNull();
    expect(box.getAttribute("aria-checked")).toBe("false");
    expect(useSettingsStore.getState().notifyStatuses.blocked).toBe(false);
  });
});
